import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { onRequest } from './admin/plans/[[path]].js';

const TOKEN = 'test-admin-token';

function memoryDb(seed) {
  const requests = seed.map((row) => ({ ...row }));
  const drafts = [];
  let nextDraft = 1;
  return {
    requests,
    drafts,
    prepare(sql) {
      const text = sql.replace(/\s+/g, ' ').trim();
      let bound = [];
      const api = {
        bind(...args) {
          bound = args;
          return api;
        },
        async all() {
          if (text.includes("status IN ('new', 'review')")) {
            const results = requests
              .filter((row) => row.status === 'new' || row.status === 'review')
              .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
            return { results };
          }
          if (text.includes('FROM plan_drafts WHERE request_id = ? ORDER BY id ASC')) {
            return { results: drafts.filter((row) => row.request_id === bound[0]) };
          }
          throw new Error(`unhandled all: ${text}`);
        },
        async first() {
          if (text.startsWith('SELECT id, created_at') && text.includes('FROM plan_requests WHERE id = ?')) {
            return requests.find((row) => row.id === bound[0]) || null;
          }
          if (text.startsWith('SELECT id FROM plan_drafts')) {
            const rows = drafts.filter((row) => row.request_id === bound[0]);
            return rows.length ? { id: rows[rows.length - 1].id } : null;
          }
          throw new Error(`unhandled first: ${text}`);
        },
        async run() {
          if (text.startsWith('INSERT INTO plan_drafts')) {
            const id = nextDraft++;
            drafts.push({
              id,
              request_id: bound[0],
              created_at: bound[1],
              updated_at: bound[2],
              format: bound[3],
              body: bound[4],
              sources: bound[5],
              access_code: null,
            });
            return { success: true, meta: { last_row_id: id, changes: 1 } };
          }
          if (text.includes('SET status = ?')) {
            const row = requests.find((item) => item.id === bound[1]);
            if (row) row.status = bound[0];
            return { success: true, meta: { changes: row ? 1 : 0 } };
          }
          if (text.includes('SET access_code = NULL')) {
            let changes = 0;
            for (const row of drafts) {
              if (row.request_id === bound[0] && row.access_code != null) {
                row.access_code = null;
                changes += 1;
              }
            }
            return { success: true, meta: { changes } };
          }
          if (text.includes('SET access_code = ?, updated_at = ?')) {
            const row = drafts.find((item) => item.id === bound[2]);
            if (row) {
              row.access_code = bound[0];
              row.updated_at = bound[1];
            }
            return { success: true, meta: { changes: row ? 1 : 0 } };
          }
          throw new Error(`unhandled run: ${text}`);
        },
      };
      return api;
    },
  };
}

function seed() {
  return [
    { id: 1, created_at: '2026-10-15T01:00:00.000Z', name: 'Ada', email: 'ada@example.com', tier: 'Route plan', car: '2024 Ioniq 5', port: 'CCS port, with a NACS adapter', start_place: 'Pasadena, CA', end_place: 'Phoenix, AZ', depart: '2026-11-01', return_date: '', passengers: '', memberships: '', notes: '', status: 'new' },
    { id: 2, created_at: '2026-10-15T02:00:00.000Z', name: 'Bea', email: 'bea@example.com', tier: 'Detailed plan', car: '2023 Model Y', port: 'NACS port (Tesla-style)', start_place: 'Seattle, WA', end_place: 'Portland, OR', depart: '2026-11-02', return_date: '', passengers: '', memberships: '', notes: 'dog', status: 'review' },
    { id: 3, created_at: '2026-10-14T02:00:00.000Z', name: 'Cam', email: 'cam@example.com', tier: 'Route plan', car: '2022 Bolt', port: 'CCS port, no adapter', start_place: 'LA', end_place: 'Vegas', depart: '2026-11-03', return_date: '', passengers: '', memberships: '', notes: '', status: 'approved' },
  ];
}

function call({ method = 'GET', path, body, token = TOKEN, db, admin = TOKEN }) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return onRequest({
    request: new Request(`https://evtripreports.com/api/admin/plans${path}`, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
    }),
    params: { path: path.replace(/^\//, '') },
    env: { ADMIN_TOKEN: admin, DB: db },
  });
}

test('admin routes require the token and the database', async () => {
  const db = memoryDb(seed());
  assert.equal((await call({ path: '', token: '', db })).status, 401);
  assert.equal((await call({ path: '', token: 'nope', db })).status, 401);
  assert.equal((await call({ path: '', db, admin: '' })).status, 503);
  assert.equal((await call({ path: '', db: undefined })).status, 503);
});

test('the queue is only new and review, oldest first', async () => {
  const res = await call({ path: '', db: memoryDb(seed()) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.requests.map((row) => row.id), [1, 2]);
  assert.equal(body.requests.some((row) => row.email === 'cam@example.com'), false);
});

test('fetch one returns the request and parsed draft sources', async () => {
  const db = memoryDb(seed());
  await call({
    method: 'POST',
    path: '/1/draft',
    db,
    body: { format: 'markdown', body: '# Stops', sources: [{ label: 'Tesla Find Us', url: 'https://www.tesla.com/findus' }] },
  });
  const res = await call({ path: '/1', db });
  const body = await res.json();
  assert.equal(body.request.status, 'review');
  assert.equal(body.drafts[0].format, 'markdown');
  assert.equal(body.drafts[0].sources[0].url, 'https://www.tesla.com/findus');
  assert.equal((await call({ path: '/99', db })).status, 404);
});

test('a draft moves new and rejected requests to review', async () => {
  const db = memoryDb(seed());
  const saved = await call({
    method: 'POST',
    path: '/1/draft',
    db,
    body: { format: 'html', body: '<p>Stops</p>', sources: [{ name: 'EVCS', url: 'https://web2.evcs.com/ev-charging-stations' }] },
  });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).draftId, 1);
  assert.equal(db.requests[0].status, 'review');

  db.requests[0].status = 'rejected-for-redo';
  const again = await call({
    method: 'POST',
    path: '/1/draft',
    db,
    body: { format: 'markdown', body: 'Second draft', sources: [{ label: 'DOE', url: 'https://afdc.energy.gov/stations' }] },
  });
  assert.equal(again.status, 200);
  assert.equal(db.requests[0].status, 'review');
  assert.equal((await call({ method: 'POST', path: '/1/draft', db, body: { format: 'pdf', body: 'x', sources: [] } })).status, 400);
  assert.equal((await call({ method: 'POST', path: '/1/draft', db, body: { format: 'markdown', body: '', sources: [] } })).status, 400);
});

test('approve stores an unguessable code and does not call the network', async () => {
  const db = memoryDb(seed());
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    calls.push(String(args[0]));
    throw new Error('network');
  };
  try {
    assert.equal((await call({ method: 'POST', path: '/1/decision', db, body: { status: 'approved' } })).status, 400);
    await call({
      method: 'POST',
      path: '/1/draft',
      db,
      body: { format: 'markdown', body: 'Plan', sources: [{ label: 'Tesla Find Us', url: 'https://www.tesla.com/findus/location/supercharger/18383' }] },
    });
    await call({
      method: 'POST',
      path: '/1/draft',
      db,
      body: { format: 'markdown', body: 'Plan revised', sources: [{ label: 'EVgo', url: 'https://www.evgo.com/find-a-charger/' }] },
    });
    const approved = await call({ method: 'POST', path: '/1/decision', db, body: { status: 'approved' } });
    const body = await approved.json();
    assert.equal(approved.status, 200);
    assert.equal(body.status, 'approved');
    assert.match(body.accessCode, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(db.requests[0].status, 'approved');
    assert.equal(db.drafts[0].access_code, null);
    assert.equal(db.drafts[1].access_code, body.accessCode);
    assert.equal((await call({ method: 'POST', path: '/1/decision', db, body: { status: 'approved' } })).status, 409);
    assert.equal((await call({ method: 'POST', path: '/1/draft', db, body: { format: 'markdown', body: 'nope', sources: [] } })).status, 409);
    assert.equal(calls.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('reject for redo clears any access code and sends nothing', async () => {
  const db = memoryDb(seed());
  await call({
    method: 'POST',
    path: '/2/draft',
    db,
    body: { format: 'markdown', body: 'Draft', sources: [] },
  });
  db.drafts[0].access_code = 'should-clear';
  const res = await call({ method: 'POST', path: '/2/decision', db, body: { status: 'rejected-for-redo' } });
  assert.equal((await res.json()).status, 'rejected-for-redo');
  assert.equal(db.requests[1].status, 'rejected-for-redo');
  assert.equal(db.drafts[0].access_code, null);
  const listed = await (await call({ path: '', db })).json();
  assert.equal(listed.requests.some((row) => row.id === 2), false);
});

test('the header token works and the review code never imports mail', async () => {
  const db = memoryDb(seed());
  const res = await onRequest({
    request: new Request('https://evtripreports.com/api/admin/plans', { headers: { 'x-admin-token': TOKEN } }),
    params: {},
    env: { ADMIN_TOKEN: TOKEN, DB: db },
  });
  assert.equal(res.status, 200);
  const src = readFileSync(new URL('../_lib/plan-review.js', import.meta.url), 'utf8');
  const route = readFileSync(new URL('./admin/plans/[[path]].js', import.meta.url), 'utf8');
  assert.equal(src.includes('sendMail') || src.includes('fastmail'), false);
  assert.equal(route.includes('sendMail') || route.includes('fastmail'), false);
});

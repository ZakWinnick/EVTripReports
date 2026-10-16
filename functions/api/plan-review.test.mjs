import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { onRequest } from './admin/plans/[[path]].js';
import { sha256Hex } from '../_lib/tokens.js';

const TOKEN = 'test-admin-token';

function memoryDb(seed) {
  const requests = seed.map((row) => ({ ...row }));
  const drafts = [];
  const links = [];
  const delivery = [];
  let nextDraft = 1;
  const db = {
    requests,
    drafts,
    links,
    delivery,
    noDeliveryTable: false,
    prepare(sql) {
      const text = sql.replace(/\s+/g, ' ').trim();
      let bound = [];
      const api = {
        bind(...args) {
          bound = args;
          return api;
        },
        async all() {
          if (text.includes('LEFT JOIN plan_delivery')) {
            if (db.noDeliveryTable) throw new Error('no such table: plan_delivery');
            const results = requests
              .filter((row) => row.status === 'approved')
              .map((row) => {
                const mine = links.filter((link) => link.request_id === row.id).map((link) => link.created_at).sort();
                const sent = delivery.find((item) => item.request_id === row.id);
                return { ...row, approved_at: mine.length ? mine[mine.length - 1] : null, delivered_at: sent ? sent.delivered_at : null, delivery_note: sent ? sent.note : null };
              })
              .sort((a, b) => String(a.approved_at).localeCompare(String(b.approved_at)) || a.id - b.id);
            return { results };
          }
          if (text.includes("status IN ('new', 'review', 'rejected-for-redo')")) {
            const results = requests
              .filter((row) => row.status === 'new' || row.status === 'review' || row.status === 'rejected-for-redo')
              .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
            return { results };
          }
          if (text.includes('FROM plan_drafts WHERE request_id = ? ORDER BY id ASC')) {
            return { results: drafts.filter((row) => row.request_id === bound[0]) };
          }
          throw new Error(`unhandled all: ${text}`);
        },
        async first() {
          if (text.startsWith('SELECT delivered_at, note FROM plan_delivery')) return delivery.find((item) => item.request_id === bound[0]) || null;
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
          if (text.startsWith('INSERT OR IGNORE INTO plan_delivery')) {
            if (db.noDeliveryTable) throw new Error('no such table: plan_delivery');
            if (delivery.some((item) => item.request_id === bound[0])) return { success: true, meta: { changes: 0 } };
            delivery.push({ request_id: bound[0], delivered_at: bound[1], note: bound[2] });
            return { success: true, meta: { changes: 1 } };
          }
          if (text.startsWith('INSERT INTO plan_links')) {
            links.push({
              request_id: bound[0],
              draft_id: bound[1],
              token_hash: bound[2],
              created_at: bound[3],
            });
            return { success: true, meta: { last_row_id: links.length, changes: 1 } };
          }
          if (text.startsWith('DELETE FROM plan_links')) {
            let changes = 0;
            for (let i = links.length - 1; i >= 0; i--) {
              if (links[i].request_id === bound[0]) {
                links.splice(i, 1);
                changes += 1;
              }
            }
            return { success: true, meta: { changes } };
          }
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
  return db;
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
    params: { path: path.replace(/^\//, '').split('?')[0] },
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

test('the queue lists new, review, and redo requests, oldest first', async () => {
  const db = memoryDb(seed());
  db.requests.push({
    id: 4,
    created_at: '2026-10-14T01:00:00.000Z',
    name: 'Dee',
    email: 'dee@example.com',
    tier: 'Detailed plan',
    car: '2024 Ioniq 5',
    port: 'CCS',
    start_place: 'LA',
    end_place: 'Vegas',
    depart: '2026-11-04',
    return_date: '',
    passengers: '',
    memberships: '',
    notes: '',
    status: 'rejected-for-redo',
  });
  const res = await call({ path: '', db });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.requests.map((row) => row.id), [4, 1, 2]);
  assert.equal(body.requests[0].status, 'rejected-for-redo');
  assert.equal(body.requests[0].queueLabel, 'Needs redo');
  assert.equal(body.requests[1].queueLabel, undefined);
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
    assert.equal(db.drafts[1].access_code, await sha256Hex(body.accessCode));
    assert.notEqual(db.drafts[1].access_code, body.accessCode);
    assert.equal(db.links.length, 1);
    assert.equal(db.links[0].token_hash, db.drafts[1].access_code);
    assert.equal(db.links[0].draft_id, db.drafts[1].id);
    assert.equal(JSON.stringify(db.drafts).includes(body.accessCode), false);
    assert.equal(JSON.stringify(db.links).includes(body.accessCode), false);
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
  db.links.push({ request_id: 2, draft_id: 1, token_hash: 'abc', created_at: '2026-10-15T00:00:00.000Z' });
  const res = await call({ method: 'POST', path: '/2/decision', db, body: { status: 'rejected-for-redo' } });
  assert.equal((await res.json()).status, 'rejected-for-redo');
  assert.equal(db.requests[1].status, 'rejected-for-redo');
  assert.equal(db.drafts[0].access_code, null);
  assert.equal(db.links.length, 0);
  const listed = await (await call({ path: '', db })).json();
  const redo = listed.requests.find((row) => row.id === 2);
  assert.equal(redo.status, 'rejected-for-redo');
  assert.equal(redo.queueLabel, 'Needs redo');
  assert.equal(listed.requests.some((row) => row.status === 'approved'), false);
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

test('the queue flags orders that need a person before a plan is built', async () => {
  const db = memoryDb(seed());
  const base = { created_at: '2026-10-16T01:00:00.000Z', name: 'Eve', email: 'eve@example.com', tier: 'Detailed plan', car: '2024 Ioniq 5', port: 'CCS port, no adapter', start_place: 'Los Angeles, CA', end_place: 'Las Vegas, NV', depart: '2026-11-04T08:00', return_date: '', passengers: '', memberships: '', notes: '[Start battery: 90%]\nOne dog.', status: 'new' };
  db.requests.push(
    { ...base, id: 10 },
    { ...base, id: 11, port: 'Not sure' },
    { ...base, id: 12, start_place: 'Las Vegas, NV', end_place: 'Los Angeles, CA' },
    { ...base, id: 13, start_place: 'Boise, ID', end_place: 'Reno, NV' },
  );
  const body = await (await call({ path: '', db })).json();
  const by = (id) => body.requests.find((row) => row.id === id);
  assert.equal(by(10).queueLabel, undefined);
  assert.equal(by(10).blocked, undefined);
  assert.equal(by(10).startBattery, 90);
  assert.equal(by(10).notes, 'One dog.');
  assert.equal(by(10).corridor.slug, 'la-to-las-vegas');
  assert.match(by(11).queueLabel, /^Needs customer question/);
  assert.equal(by(11).blocked, true);
  assert.match(by(12).queueLabel, /^Needs manual build: reverse direction/);
  assert.equal(by(12).corridor.status, 'reverse');
  assert.match(by(13).queueLabel, /^Needs manual check/);
  // Redo keeps its label, and the flags stay visible.
  db.requests.find((row) => row.id === 11).status = 'rejected-for-redo';
  const redo = (await (await call({ path: '', db })).json()).requests.find((row) => row.id === 11);
  assert.equal(redo.queueLabel, 'Needs redo');
  assert.equal(redo.flags[0].code, 'port-unknown');
  const one = await (await call({ path: '/12', db })).json();
  assert.equal(one.request.flags[0].code, 'reverse-direction');
});

const HOUR = 60 * 60 * 1000;
const ago = (hours) => new Date(Date.now() - hours * HOUR).toISOString();

function approvedSeed() {
  const db = memoryDb(seed());
  db.requests.push({ ...seed()[0], id: 5, name: 'Fay', email: 'fay@example.com', status: 'approved' }, { ...seed()[0], id: 6, name: 'Gus', email: 'gus@example.com', tier: 'Multi-day or family', status: 'approved' });
  db.links.push(
    { request_id: 3, draft_id: 1, token_hash: 'a', created_at: ago(60) },
    { request_id: 5, draft_id: 2, token_hash: 'b', created_at: ago(50) },
    { request_id: 6, draft_id: 3, token_hash: 'c', created_at: ago(2) },
  );
  return db;
}

test('marking an approved plan delivered records the time once, and the queue shows what is waiting', async () => {
  const db = approvedSeed();
  const before = await (await call({ path: '', db })).json();
  assert.equal(before.awaitingDelivery.count, 3);
  assert.equal(before.awaitingDelivery.overdueCount, 2);
  assert.equal(before.awaitingDelivery.overdueHours, 48);

  const first = await call({ method: 'POST', path: '/3/delivered', body: { note: 'sent by email' }, db });
  assert.equal(first.status, 200);
  const sent = await first.json();
  assert.equal(sent.ok, true);
  assert.equal(sent.alreadyDelivered, false);
  assert.equal(sent.note, 'sent by email');
  assert.equal(db.requests.find((row) => row.id === 3).status, 'approved');

  const again = await (await call({ method: 'POST', path: '/3/delivered', body: { note: 'second try' }, db })).json();
  assert.equal(again.alreadyDelivered, true);
  assert.equal(again.deliveredAt, sent.deliveredAt);
  assert.equal(again.note, 'sent by email');
  assert.equal(db.delivery.length, 1);

  const after = await (await call({ path: '', db })).json();
  assert.equal(after.awaitingDelivery.count, 2);
  assert.deepEqual(after.awaitingDelivery.plans.filter((plan) => plan.overdue).map((plan) => plan.id), [5]);
});

test('delivered needs an approved plan, and a clear message when the table is missing', async () => {
  const db = approvedSeed();
  assert.equal((await call({ method: 'POST', path: '/1/delivered', body: {}, db })).status, 409);
  assert.equal((await call({ method: 'POST', path: '/99/delivered', body: {}, db })).status, 404);
  assert.equal((await call({ method: 'POST', path: '/3/delivered', body: {}, token: '', db })).status, 401);
  db.noDeliveryTable = true;
  const res = await call({ method: 'POST', path: '/3/delivered', body: {}, db });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /schema-delivery\.sql/);
  const queue = await (await call({ path: '', db })).json();
  assert.equal(queue.awaitingDelivery, null);
  assert.equal(queue.requests.length, 2);
  assert.equal((await call({ path: '/approved', db })).status, 503);
});

test('the approved list shows delivery, and pending older than 48 hours is the overdue list', async () => {
  const db = approvedSeed();
  await call({ method: 'POST', path: '/3/delivered', body: {}, db });
  const all = (await (await call({ path: '/approved', db })).json()).approved;
  assert.deepEqual(all.map((item) => [item.id, Boolean(item.deliveredAt), item.overdue]), [[3, true, false], [5, false, true], [6, false, false]]);
  assert.ok(all[1].hoursSinceApproval >= 49 && all[1].hoursSinceApproval <= 51);
  const overdue = (await (await call({ path: '/approved?pending=1&olderThanHours=48', db })).json()).approved;
  assert.deepEqual(overdue.map((item) => item.id), [5]);
  const sooner = (await (await call({ path: '/approved?pending=1&olderThanHours=1', db })).json()).approved;
  assert.deepEqual(sooner.map((item) => item.id), [5, 6]);
});

test('the payment lookup stays under 100 bound parameters for a long queue', async () => {
  const db = memoryDb([]);
  for (let i = 1; i <= 250; i++) db.requests.push({ ...seed()[0], id: i, created_at: `2026-10-15T00:${String(i % 60).padStart(2, '0')}:00.000Z` });
  const widest = [];
  const real = db.prepare.bind(db);
  db.prepare = (sql) => {
    const api = real(sql);
    if (/FROM stripe_payments/.test(sql)) {
      const bind = api.bind.bind(api);
      return { bind(...args) { widest.push(args.length); return { all: async () => ({ results: [] }), ...{} }; }, _bind: bind };
    }
    return api;
  };
  const res = await call({ path: '', db });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.requests.length, 250);
  assert.ok(widest.length >= 3);
  assert.ok(Math.max(...widest) < 100, `widest ${Math.max(...widest)}`);
  assert.ok(body.requests.every((row) => row.payment.state === 'unpaid'));
});

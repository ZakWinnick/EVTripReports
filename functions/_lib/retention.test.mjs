import assert from 'node:assert/strict';
import test from 'node:test';
import { onRequest } from '../api/admin/plans/[[path]].js';
import { purgePlanData, purgePortal, tripDateMs } from './retention.js';

const NOW = new Date('2027-10-16T12:00:00.000Z');

// A fake D1 that understands the statements the purge runs.
function fakeDb(tables, { missing = [] } = {}) {
  const calls = [];
  const predicate = (where, bound) => {
    if (where === 'request_id = ?') return (row) => row.request_id === bound[0];
    if (where === 'id = ?') return (row) => row.id === bound[0];
    if (where === 'expires_at < ?') return (row) => row.expires_at < bound[0];
    if (where === 'created_at < ?') return (row) => row.created_at < bound[0];
    if (where === 'request_id IS NULL AND created_at < ?') return (row) => row.request_id == null && row.created_at < bound[0];
    throw new Error(`unhandled where: ${where}`);
  };
  return {
    tables, calls,
    prepare(sql) {
      const text = sql.replace(/\s+/g, ' ').trim();
      let bound = [];
      const api = {
        bind(...args) { bound = args; return api; },
        async all() {
          calls.push(text);
          if (text === 'SELECT id, depart, return_date, status FROM plan_requests ORDER BY id ASC') return { results: tables.plan_requests.map((r) => ({ ...r })) };
          throw new Error(`unhandled all: ${text}`);
        },
        async first() {
          calls.push(text);
          const m = /^SELECT COUNT\(\*\) AS n FROM (\w+) WHERE (.+)$/.exec(text);
          if (!m) throw new Error(`unhandled first: ${text}`);
          if (missing.includes(m[1])) throw new Error(`no such table: ${m[1]}`);
          return { n: tables[m[1]].filter(predicate(m[2], bound)).length };
        },
        async run() {
          calls.push(text);
          const m = /^DELETE FROM (\w+) WHERE (.+)$/.exec(text);
          if (!m) throw new Error(`unhandled run: ${text}`);
          if (missing.includes(m[1])) throw new Error(`no such table: ${m[1]}`);
          const keep = tables[m[1]].filter((row) => !predicate(m[2], bound)(row));
          const changes = tables[m[1]].length - keep.length;
          tables[m[1]] = keep;
          return { success: true, meta: { changes } };
        },
      };
      return api;
    },
  };
}

function seed() {
  return {
    plan_requests: [
      { id: 1, depart: '2026-10-10', return_date: '', status: 'approved' },
      { id: 2, depart: '2026-10-10', return_date: '2026-10-20', status: 'approved' },
      { id: 3, depart: '2026-10-17', return_date: '', status: 'approved' },
      { id: 4, depart: '2027-01-05', return_date: '', status: 'new' },
      { id: 5, depart: 'sometime in spring', return_date: '', status: 'new' },
      { id: 6, depart: '2025-03-01T08:30', return_date: '', status: 'rejected-for-redo' },
    ],
    plan_links: [{ request_id: 1 }, { request_id: 3 }, { request_id: 6 }],
    plan_drafts: [{ request_id: 1 }, { request_id: 1 }, { request_id: 3 }, { request_id: 6 }],
    plan_delivery: [{ request_id: 1 }],
    stripe_payments: [
      { request_id: 1, created_at: '2026-10-01T00:00:00.000Z' },
      { request_id: 3, created_at: '2026-10-01T00:00:00.000Z' },
      { request_id: null, created_at: '2026-01-01T00:00:00.000Z' },
      { request_id: null, created_at: '2027-09-01T00:00:00.000Z' },
    ],
    portal_signins: [{ expires_at: '2027-10-16T11:00:00.000Z' }, { expires_at: '2027-10-16T13:00:00.000Z' }],
    portal_sessions: [{ expires_at: '2027-10-16T11:59:59.000Z' }, { expires_at: '2027-10-16T12:00:01.000Z' }],
    portal_rate_limits: [{ created_at: '2027-10-16T11:00:00.000Z' }, { created_at: '2027-10-16T11:59:00.000Z' }],
  };
}

test('trip date is the later of depart and return, and unreadable dates are null', () => {
  assert.equal(new Date(tripDateMs({ depart: '2026-10-10', return_date: '2026-10-20' })).toISOString().slice(0, 10), '2026-10-20');
  assert.equal(new Date(tripDateMs({ depart: '2025-03-01T08:30' })).toISOString().slice(0, 10), '2025-03-01');
  assert.equal(tripDateMs({ depart: 'spring', return_date: '' }), null);
  assert.equal(tripDateMs({ depart: '2026-02-31' }), null);
});

test('a dry run lists what is due and changes nothing', async () => {
  const db = fakeDb(seed());
  const out = await purgePlanData(db, NOW);
  assert.equal(out.dryRun, true);
  assert.equal(out.cutoff, '2026-10-16');
  assert.deepEqual(out.candidates.map((c) => c.id), [1, 6]);
  assert.deepEqual(out.skipped, [{ id: 5, reason: 'no readable trip date' }]);
  assert.equal(out.unmatchedPaymentsDue, 1);
  assert.equal(db.calls.some((sql) => sql.startsWith('DELETE')), false);
  assert.equal(db.tables.plan_requests.length, 6);
});

test('a real purge removes a request with its drafts, links, delivery and payments, and only those', async () => {
  const db = fakeDb(seed());
  const out = await purgePlanData(db, NOW, { dryRun: false });
  assert.deepEqual(out.candidates.map((c) => c.id), [1, 6]);
  assert.deepEqual(db.tables.plan_requests.map((r) => r.id), [2, 3, 4, 5]);
  assert.deepEqual(db.tables.plan_links, [{ request_id: 3 }]);
  assert.equal(db.tables.plan_drafts.length, 1);
  assert.equal(db.tables.plan_delivery.length, 0);
  assert.deepEqual(db.tables.stripe_payments.map((p) => p.created_at), ['2026-10-01T00:00:00.000Z', '2027-09-01T00:00:00.000Z']);
  assert.equal(db.tables.stripe_payments.length, 2);
  assert.deepEqual(out.deleted, { plan_links: 2, plan_drafts: 3, stripe_payments: 2, plan_requests: 2 });
  // A second run finds nothing.
  assert.equal((await purgePlanData(db, NOW, { dryRun: false })).due, 0);
});

test('keepIds, the per-run limit, and a round trip that has not finished', async () => {
  const kept = await purgePlanData(fakeDb(seed()), NOW, { keepIds: [1] });
  assert.deepEqual(kept.candidates.map((c) => c.id), [6]);
  assert.ok(kept.skipped.some((s) => s.id === 1 && /kept/.test(s.reason)));
  const limited = fakeDb(seed());
  const out = await purgePlanData(limited, NOW, { dryRun: false, limit: 1 });
  assert.equal(out.due, 2);
  assert.equal(out.thisRun, 1);
  assert.deepEqual(limited.tables.plan_requests.map((r) => r.id), [2, 3, 4, 5, 6]);
  // Request 2 left on 2026-10-10 but came back on 2026-10-20, so it is still inside the year.
  assert.equal(out.candidates.some((c) => c.id === 2), false);
});

test('portal purge removes only expired sign-ins and sessions, and old rate limit rows', async () => {
  const db = fakeDb(seed());
  assert.deepEqual(await purgePortal(db, NOW), { portal_signins: 1, portal_sessions: 1, portal_rate_limits: 1 });
  assert.equal(db.tables.portal_signins.length, 2);
  assert.deepEqual(await purgePortal(db, NOW, { dryRun: false }), { portal_signins: 1, portal_sessions: 1, portal_rate_limits: 1 });
  assert.equal(db.tables.portal_signins.length, 1);
  assert.equal(db.tables.portal_signins[0].expires_at, '2027-10-16T13:00:00.000Z');
  assert.equal(db.tables.portal_sessions[0].expires_at, '2027-10-16T12:00:01.000Z');
  assert.equal(db.tables.portal_rate_limits.length, 1);
});

test('missing optional tables are skipped, not fatal', async () => {
  const db = fakeDb(seed(), { missing: ['plan_delivery', 'stripe_payments', 'portal_sessions'] });
  const portal = await purgePortal(db, NOW, { dryRun: false });
  assert.equal(portal.portal_sessions, null);
  const plans = await purgePlanData(db, NOW, { dryRun: false });
  assert.equal(plans.deleted.plan_requests, 2);
});

function call(body, db, { token = 'tok' } = {}) {
  return onRequest({
    request: new Request('https://evtripreports.com/api/admin/plans/purge', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params: { path: 'purge' },
    env: { ADMIN_TOKEN: 'tok', DB: db },
  });
}

test('the purge endpoint is admin only, dry by default, and a real run needs the confirm word', async () => {
  const tables = seed();
  tables.plan_requests = [{ id: 1, depart: '2019-01-01', return_date: '', status: 'approved' }, { id: 2, depart: '2999-01-01', return_date: '', status: 'new' }];
  const db = fakeDb(tables);
  assert.equal((await call({}, db, { token: 'wrong' })).status, 401);
  const dry = await (await call({}, db)).json();
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.plans.candidates.map((c) => c.id), [1]);
  assert.equal(db.tables.plan_requests.length, 2);
  assert.equal((await call({ dryRun: false }, db)).status, 400);
  assert.equal((await call({ dryRun: false, confirm: 'yes' }, db)).status, 400);
  assert.equal((await call({ scope: 'everything' }, db)).status, 400);
  assert.equal(db.tables.plan_requests.length, 2);
  const real = await (await call({ dryRun: false, confirm: 'purge', scope: 'plans' }, db)).json();
  assert.equal(real.dryRun, false);
  assert.equal(real.portal, undefined);
  assert.deepEqual(db.tables.plan_requests.map((r) => r.id), [2]);
});

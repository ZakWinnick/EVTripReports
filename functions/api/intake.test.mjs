import assert from 'node:assert/strict';
import test from 'node:test';
import { onRequestPost } from './intake.js';

const form = { name: 'Test Driver', email: 'driver@example.invalid', tier: 'Route plan', car: '2024 Ioniq 5', port: 'CCS port, no adapter', start: 'Los Angeles, CA', end: 'Las Vegas, NV', depart: '2026-11-02' };
const db = (lastRowId) => ({ prepare() { return { bind() { return { async run() { return { success: true, meta: { last_row_id: lastRowId } }; } }; } }; } });
const post = (body, env) => onRequestPost({ request: new Request('https://evtripreports.com/api/intake', { method: 'POST', body: JSON.stringify(body) }), env, waitUntil() {} });

test('intake returns the order reference Stripe needs, and no secret', async () => {
  const res = await post(form, { DB: db(42) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, ref: 'etr-42' });
});

test('intake still succeeds when D1 reports no row id', async () => {
  const res = await post(form, { DB: db(undefined) });
  assert.deepEqual(await res.json(), { ok: true });
});

test('intake stays closed without the database', async () => {
  assert.equal((await post(form, {})).status, 503);
});

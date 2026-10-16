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

function capture() {
  const rows = [];
  return {
    rows,
    DB: { prepare() { return { bind(...args) { rows.push(args); return { async run() { return { success: true, meta: { last_row_id: 7 } }; } }; } }; } },
  };
}

test('intake accepts custom trips outside the published guides and preserves endpoints', async () => {
  const seen = capture();
  const res = await post({ ...form, start: 'Chicago, IL', end: 'Milwaukee, WI' }, seen);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, ref: 'etr-7' });
  assert.equal(seen.rows[0][6], 'Chicago, IL');
  assert.equal(seen.rows[0][7], 'Milwaukee, WI');
});

test('intake accepts reverse directions without swapping the requested endpoints', async () => {
  const seen = capture();
  const res = await post({ ...form, start: 'Las Vegas, NV', end: 'Los Angeles, CA' }, seen);
  assert.equal(res.status, 200);
  assert.equal(seen.rows[0][6], 'Las Vegas, NV');
  assert.equal(seen.rows[0][7], 'Los Angeles, CA');
});

test('intake accepts both nearby endpoints and a different Portland without silently changing the trip', async () => {
  assert.equal((await post({ ...form, start: 'Pasadena, CA' }, capture())).status, 200);
  const seen = capture();
  assert.equal((await post({ ...form, start: 'Seattle, WA', end: 'Portland, ME' }, seen)).status, 200);
  assert.equal(seen.rows[0][7], 'Portland, ME');
});

test('intake stores the start battery in the notes and the departure time with the date', async () => {
  const seen = capture();
  const res = await post({ ...form, startBattery: '85', departTime: '07:30', notes: 'One dog.' }, seen);
  assert.equal(res.status, 200);
  const [row] = seen.rows;
  assert.equal(row[8], '2026-11-02T07:30');
  assert.equal(row[12], '[Start battery: 85%]\nOne dog.');
});

test('intake leaves the notes and date alone when battery and time are blank', async () => {
  const seen = capture();
  await post({ ...form, startBattery: '', departTime: '', notes: 'Hi' }, seen);
  assert.equal(seen.rows[0][8], '2026-11-02');
  assert.equal(seen.rows[0][12], 'Hi');
});

test('intake rejects a bad battery or time', async () => {
  for (const bad of [{ startBattery: '0' }, { startBattery: '101' }, { startBattery: 'full' }, { startBattery: '55.5' }, { departTime: '25:00' }, { departTime: '8am' }]) {
    const seen = capture();
    const res = await post({ ...form, ...bad }, seen);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(seen.rows.length, 0);
  }
  assert.equal((await post({ ...form, depart: 'next friday', departTime: '08:00' }, capture())).status, 400);
});

test('the owner email says when the port is not known, and which corridor and battery', async () => {
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes('/session')) {
      return new Response(JSON.stringify({ apiUrl: 'https://api.example.invalid/jmap', primaryAccounts: { 'urn:ietf:params:jmap:submission': 'a1' } }), { status: 200 });
    }
    const payload = JSON.parse(init.body);
    bodies.push(init.body);
    const first = payload.methodCalls[0][0];
    const responses = first === 'Identity/get'
      ? [['Identity/get', { list: [{ id: 'i1', email: 'admin@evtripreports.com' }] }, 'i'], ['Mailbox/query', { ids: ['d1'] }, 'm']]
      : [['Email/set', {}, 'e'], ['EmailSubmission/set', { created: { sub: {} } }, 's']];
    return new Response(JSON.stringify({ methodResponses: responses }), { status: 200 });
  };
  try {
    const pending = [];
    const res = await onRequestPost({
      request: new Request('https://evtripreports.com/api/intake', { method: 'POST', body: JSON.stringify({ ...form, port: 'Not sure', startBattery: '60', departTime: '09:15', return: '2026-11-05' }) }),
      env: { DB: db(9), FASTMAIL_TOKEN: 'x' },
      waitUntil(p) { pending.push(p); },
    });
    assert.equal(res.status, 200);
    await Promise.all(pending);
  } finally {
    globalThis.fetch = realFetch;
  }
  const mail = bodies.join('\n');
  assert.match(mail, /Charge port: NOT SURE/);
  assert.match(mail, /Corridor: LA to Las Vegas/);
  assert.match(mail, /Leaving: 2026-11-02 at 09:15/);
  assert.match(mail, /Start battery: 60%/);
  assert.match(mail, /the way back is built by hand/);
});

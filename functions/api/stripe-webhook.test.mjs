import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { onRequestPost } from './stripe-webhook.js';
import { refFor, requestIdFromRef, verifyStripeSignature } from '../_lib/stripe.js';

const SECRET = 'whsec_test_secret';

function sign(body, { secret = SECRET, ts = Math.floor(Date.now() / 1000) } = {}) {
  const v1 = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return `t=${ts},v1=${v1}`;
}

// A fake D1 that understands only the statements the webhook runs.
function fakeDb({ requests = [], payments = [] } = {}) {
  const calls = [];
  return {
    requests, payments, calls,
    prepare(sql) {
      const text = sql.replace(/\s+/g, ' ').trim();
      let args = [];
      const api = {
        bind(...a) { args = a; return api; },
        async first() {
          calls.push(text);
          if (text.startsWith('SELECT id FROM stripe_payments WHERE session_id')) return payments.find((p) => p.session_id === args[0]) || null;
          if (text.startsWith('SELECT id, tier FROM plan_requests WHERE id = ?')) return requests.find((r) => r.id === args[0]) || null;
          if (text.includes('FROM plan_requests r WHERE lower(r.email) = ?')) {
            return [...requests].reverse().find((r) => r.email.toLowerCase() === args[0] && r.status !== 'test'
              && !payments.some((p) => p.request_id === r.id && p.status === 'paid')) || null;
          }
          throw new Error(`unhandled first: ${text}`);
        },
        async run() {
          calls.push(text);
          if (text.startsWith('INSERT OR IGNORE INTO stripe_payments')) {
            const [session_id, payment_intent, , email, amount_total, currency, , client_reference_id, request_id, match_kind, amount_ok] = args;
            if (!payments.some((p) => p.session_id === session_id)) {
              payments.push({ session_id, payment_intent, email, amount_total, currency, client_reference_id, request_id, match_kind, amount_ok, status: 'paid' });
            }
            return { success: true, meta: { changes: 1 } };
          }
          if (text.startsWith("UPDATE stripe_payments SET status = 'refunded'")) {
            for (const p of payments) if (p.payment_intent === args[0]) p.status = 'refunded';
            return { success: true, meta: { changes: 1 } };
          }
          throw new Error(`unhandled run: ${text}`);
        },
      };
      return api;
    },
  };
}

const session = (extra = {}) => ({
  id: 'cs_live_1', payment_status: 'paid', payment_intent: 'pi_1', amount_total: 3900, currency: 'usd',
  client_reference_id: 'etr-7', customer_details: { email: 'Driver@Example.com' }, ...extra,
});
const event = (type, object) => JSON.stringify({ id: 'evt_1', type, data: { object } });
const post = (body, env, headers = {}) => onRequestPost({
  request: new Request('https://evtripreports.com/api/stripe-webhook', { method: 'POST', body, headers: { 'stripe-signature': sign(body), ...headers } }),
  env, waitUntil() {},
});

test('references round trip and reject anything else', () => {
  assert.equal(refFor(12), 'etr-12');
  assert.equal(requestIdFromRef('etr-12'), 12);
  for (const bad of ['', 'etr-0', 'etr-', 'etr-1a', 'ETR-1', ' etr-1', 'etr-1234567890123456', null, undefined]) assert.equal(requestIdFromRef(bad), null);
});

test('signature: valid, tampered body, wrong secret, stale, malformed', async () => {
  const body = '{"a":1}';
  assert.equal(await verifyStripeSignature(body, sign(body), SECRET), true);
  assert.equal(await verifyStripeSignature(body + ' ', sign(body), SECRET), false);
  assert.equal(await verifyStripeSignature(body, sign(body, { secret: 'other' }), SECRET), false);
  const old = Math.floor(Date.now() / 1000) - 3600;
  assert.equal(await verifyStripeSignature(body, sign(body, { ts: old }), SECRET), false);
  for (const bad of ['', 'garbage', 't=1', 'v1=abcd', 't=abc,v1=00', `t=${Math.floor(Date.now() / 1000)},v1=zz`]) {
    assert.equal(await verifyStripeSignature(body, bad, SECRET), false);
  }
  assert.equal(await verifyStripeSignature(body, sign(body), ''), false);
  // Stripe may send several v1 values while a secret rolls. Any one that matches is enough.
  const ts = Math.floor(Date.now() / 1000);
  const good = createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex');
  assert.equal(await verifyStripeSignature(body, `t=${ts},v1=${'0'.repeat(64)},v1=${good}`, SECRET), true);
});

test('closed without the secret or the database, 400 on a bad signature, nothing written', async () => {
  const db = fakeDb();
  const body = event('checkout.session.completed', session());
  assert.equal((await post(body, { DB: db })).status, 503);
  assert.equal((await post(body, { STRIPE_WEBHOOK_SECRET: SECRET })).status, 503);
  assert.equal((await post(body, { DB: db, STRIPE_WEBHOOK_SECRET: SECRET }, { 'stripe-signature': 't=1,v1=00' })).status, 400);
  assert.equal(db.calls.length, 0);
});

test('a paid session matched by reference is recorded once, and the amount is checked against the tier', async () => {
  const db = fakeDb({ requests: [{ id: 7, email: 'driver@example.com', tier: 'Detailed plan', status: 'new' }] });
  const env = { DB: db, STRIPE_WEBHOOK_SECRET: SECRET };
  const body = event('checkout.session.completed', session());
  assert.equal((await post(body, env)).status, 200);
  assert.equal((await post(body, env)).status, 200);
  assert.equal(db.payments.length, 1);
  assert.deepEqual(
    { id: db.payments[0].request_id, kind: db.payments[0].match_kind, ok: db.payments[0].amount_ok, email: db.payments[0].email },
    { id: 7, kind: 'reference', ok: 1, email: 'driver@example.com' },
  );
  const wrong = fakeDb({ requests: [{ id: 7, email: 'driver@example.com', tier: 'Route plan', status: 'new' }] });
  await post(body, { DB: wrong, STRIPE_WEBHOOK_SECRET: SECRET });
  assert.equal(wrong.payments[0].amount_ok, 0);
});

test('no reference falls back to the newest unpaid request with the same email, then to unmatched', async () => {
  const db = fakeDb({ requests: [
    { id: 1, email: 'driver@example.com', tier: 'Route plan', status: 'test' },
    { id: 2, email: 'driver@example.com', tier: 'Detailed plan', status: 'new' },
    { id: 3, email: 'driver@example.com', tier: 'Detailed plan', status: 'new' },
  ] });
  const env = { DB: db, STRIPE_WEBHOOK_SECRET: SECRET };
  await post(event('checkout.session.completed', session({ id: 'cs_a', client_reference_id: null })), env);
  await post(event('checkout.session.completed', session({ id: 'cs_b', client_reference_id: null })), env);
  await post(event('checkout.session.completed', session({ id: 'cs_c', client_reference_id: null })), env);
  assert.deepEqual(db.payments.map((p) => [p.request_id, p.match_kind]), [[3, 'email'], [2, 'email'], [null, 'none']]);
});

test('unpaid, other event types, and refunds', async () => {
  const db = fakeDb({ requests: [{ id: 7, email: 'driver@example.com', tier: 'Detailed plan', status: 'new' }] });
  const env = { DB: db, STRIPE_WEBHOOK_SECRET: SECRET };
  const unpaid = await post(event('checkout.session.completed', session({ payment_status: 'unpaid' })), env);
  assert.equal(unpaid.status, 200);
  assert.equal(db.payments.length, 0);
  const other = await post(event('customer.created', {}), env);
  assert.equal((await other.json()).ignored, 'customer.created');
  await post(event('checkout.session.completed', session()), env);
  await post(event('charge.refunded', { payment_intent: 'pi_1', refunded: false }), env);
  assert.equal(db.payments[0].status, 'paid');
  await post(event('charge.refunded', { payment_intent: 'pi_1', refunded: true }), env);
  assert.equal(db.payments[0].status, 'refunded');
});

test('a database failure is a 500 so Stripe retries, and nothing is emailed or approved', async () => {
  const db = { prepare() { throw new Error('d1 down'); } };
  const res = await post(event('checkout.session.completed', session()), { DB: db, STRIPE_WEBHOOK_SECRET: SECRET });
  assert.equal(res.status, 500);
});

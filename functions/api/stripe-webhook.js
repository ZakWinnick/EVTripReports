// POST /api/stripe-webhook
// Records paid Stripe Checkout sessions in stripe_payments (schema-payments.sql) and links each one to a plan request.
// It never changes plan_requests, never approves a plan, and never emails a customer.
// Closed (503) until both STRIPE_WEBHOOK_SECRET (a Pages secret, the endpoint's signing secret) and DB are set.
// In Stripe, add an endpoint for https://evtripreports.com/api/stripe-webhook with the events
//   checkout.session.completed, checkout.session.async_payment_succeeded, charge.refunded.
// A signature that does not verify is a 400. A database failure is a 500 so Stripe retries.
import { sendMail } from '../_lib/fastmail.js';
import { TIER_CENTS, requestIdFromRef, verifyStripeSignature } from '../_lib/stripe.js';
import { applySecurityHeaders } from '../../src/lib/security-headers.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: applySecurityHeaders({ 'content-type': 'application/json', 'cache-control': 'no-store' }),
  });

const str = (v) => (v == null ? null : String(v).slice(0, 500));

async function match(db, session) {
  const email = String(session.customer_details?.email || session.customer_email || '').trim().toLowerCase();
  const refId = requestIdFromRef(session.client_reference_id);
  if (refId) {
    const row = await db.prepare(`SELECT id, tier FROM plan_requests WHERE id = ?`).bind(refId).first();
    if (row) return { row, kind: 'reference', email };
  }
  if (email) {
    const row = await db.prepare(
      `SELECT r.id, r.tier FROM plan_requests r
       WHERE lower(r.email) = ? AND r.status != 'test'
         AND NOT EXISTS (SELECT 1 FROM stripe_payments p WHERE p.request_id = r.id AND p.status = 'paid')
       ORDER BY r.id DESC LIMIT 1`
    ).bind(email).first();
    if (row) return { row, kind: 'email', email };
  }
  return { row: null, kind: 'none', email };
}

async function recordPaid(db, session) {
  if (session.payment_status !== 'paid') return { ignored: 'not paid yet' };
  const sessionId = str(session.id);
  if (!sessionId) return { ignored: 'no session id' };
  const seen = await db.prepare(`SELECT id FROM stripe_payments WHERE session_id = ?`).bind(sessionId).first();
  if (seen) return { duplicate: true };

  const { row, kind, email } = await match(db, session);
  const expected = row ? TIER_CENTS.get(String(row.tier).trim().toLowerCase()) : undefined;
  const amountOk = row && expected != null ? (Number(session.amount_total) === expected ? 1 : 0) : null;
  await db.prepare(
    `INSERT OR IGNORE INTO stripe_payments
     (session_id, payment_intent, created_at, email, amount_total, currency, payment_link, client_reference_id, request_id, match_kind, amount_ok, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid')`
  ).bind(
    sessionId, str(session.payment_intent), new Date().toISOString(), email || null,
    Number.isFinite(Number(session.amount_total)) ? Number(session.amount_total) : null, str(session.currency),
    str(session.payment_link), str(session.client_reference_id), row ? row.id : null, kind, amountOk,
  ).run();
  return { requestId: row ? row.id : null, kind, amountOk, email, amount: session.amount_total };
}

export async function onRequestPost({ request, env, waitUntil }) {
  if (!env.STRIPE_WEBHOOK_SECRET || !env.DB) return json({ error: 'Not open yet.' }, 503);
  const raw = await request.text();
  if (!(await verifyStripeSignature(raw, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET))) {
    return json({ error: 'Bad signature.' }, 400);
  }
  let event;
  try { event = JSON.parse(raw); } catch { return json({ error: 'Bad JSON.' }, 400); }
  const object = event?.data?.object || {};

  try {
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const out = await recordPaid(env.DB, object);
      if (out.requestId !== undefined && !out.duplicate && env.FASTMAIL_TOKEN) {
        const to = env.NOTIFY_TO || 'admin@evtripreports.com';
        const lines = [
          out.requestId ? `Payment received for plan request #${out.requestId}.` : 'Payment received, but no plan request matched it.',
          `Amount: $${(Number(out.amount) / 100).toFixed(2)}`,
          `Checkout email: ${out.email || 'not given'}`,
          `Matched by: ${out.kind}`,
          out.amountOk === 0 ? 'WARNING: the amount does not match the tier on the request.' : '',
          out.requestId ? '' : 'The customer may have paid before sending the trip form. Check the Stripe dashboard.',
          'Owner notice only. Nothing was sent to the customer.',
        ].filter(Boolean);
        waitUntil?.(sendMail({
          token: env.FASTMAIL_TOKEN, from: env.NOTIFY_FROM || to, to,
          subject: out.requestId ? `Paid: plan request #${out.requestId}` : 'Paid: no matching plan request',
          text: lines.join('\n'),
        }).catch((e) => console.error('payment notify failed', e.message)));
      }
      return json({ ok: true, ...(out.ignored ? { ignored: out.ignored } : {}) });
    }
    if (event.type === 'charge.refunded') {
      const intent = str(object.payment_intent);
      // charge.refunded also fires for partial refunds. Only a full refund changes the status.
      if (intent && object.refunded === true) await env.DB.prepare(`UPDATE stripe_payments SET status = 'refunded' WHERE payment_intent = ?`).bind(intent).run();
      return json({ ok: true });
    }
    return json({ ok: true, ignored: event.type || 'unknown' });
  } catch (e) {
    console.error('stripe webhook failed', e.message);
    return json({ error: 'Could not record the payment.' }, 500);
  }
}

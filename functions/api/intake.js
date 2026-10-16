// Cloudflare Pages Function: /api/intake
// POST writes a plan request to a D1 database bound as DB (see schema.sql).
// Without that binding, POST returns 503 and the form says requests aren't open yet.
// With the FASTMAIL_TOKEN secret set, the form is emailed to NOTIFY_TO
// (default admin@evtripreports.com). That message goes to the owner only.
// The customer is never a recipient. Nothing here generates a plan or emails one.
//
// Turnstile (optional). Both names are Pages variables, not committed:
//   TURNSTILE_SITE_KEY   public site key. GET returns it so the form can render the widget.
//   TURNSTILE_SECRET      secret key. When set, POST requires a passing siteverify.
//   TURNSTILE_HOSTNAMES   optional comma-separated hostnames. Default: evtripreports.com.
// If TURNSTILE_SECRET is unset, the form still accepts requests (it still needs D1).
// Set both the site key and the secret before expecting the widget to be enforced.
import { sendMail } from '../_lib/fastmail.js';
import { applySecurityHeaders } from '../../src/lib/security-headers.js';
import { verifyTurnstile } from '../_lib/turnstile.js';
import { refFor } from '../_lib/stripe.js';
import { CORRIDORS, UNSUPPORTED_MESSAGE, matchOrder } from '../../src/lib/corridors.js';
import { packNotes, portKnown } from '../../src/lib/order-flags.js';

const REQUIRED = ['name', 'email', 'tier', 'car', 'port', 'start', 'end', 'depart'];
const MAX = 2000;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: applySecurityHeaders({ 'content-type': 'application/json', 'cache-control': 'no-store' }),
  });

export async function onRequestGet({ env }) {
  return json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY || null });
}

export async function onRequestPost({ request, env, waitUntil }) {
  if (!env.DB) return json({ error: 'Plan requests are not open yet.' }, 503);

  let data;
  try { data = await request.json(); } catch { return json({ error: 'The request was not valid JSON.' }, 400); }

  if (data.website) return json({ ok: true }); // honeypot: pretend success

  if (!(await verifyTurnstile(request, env, data['cf-turnstile-response'], 'plan_request'))) {
    return json({ error: 'The security check failed. Refresh the page and try again.' }, 403);
  }

  const missing = REQUIRED.filter((k) => !String(data[k] ?? '').trim());
  if (missing.length) return json({ error: `Missing: ${missing.join(', ')}.` }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(data.email))) return json({ error: 'That email address does not look right.' }, 400);

  const clip = (v) => String(v ?? '').slice(0, MAX);

  // Optional: start battery percent and departure clock time (local to the start place).
  const batteryRaw = String(data.startBattery ?? '').replace('%', '').trim();
  let startBattery = null;
  if (batteryRaw) {
    startBattery = Number(batteryRaw);
    if (!Number.isInteger(startBattery) || startBattery < 1 || startBattery > 100) {
      return json({ error: 'Start battery must be a whole number from 1 to 100.' }, 400);
    }
  }
  let depart = clip(data.depart).trim();
  const timeRaw = String(data.departTime ?? '').trim();
  if (timeRaw) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(timeRaw)) return json({ error: 'Departure time must look like 08:30.' }, 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(depart)) return json({ error: 'Pick a departure date to go with the departure time.' }, 400);
    depart = `${depart}T${timeRaw}`;
  }

  // A buyer must not pay for a trip we cannot plan. Plans run in the direction of the corridor only.
  const corridor = matchOrder({ start: data.start, end: data.end });
  if (corridor.status === 'unmatched') {
    return json({ error: UNSUPPORTED_MESSAGE, corridors: CORRIDORS.map((item) => item.title) }, 422);
  }
  if (corridor.status === 'reverse') {
    return json({
      error: `We plan ${corridor.title} in that direction only, so we cannot plan this trip yet. If you want the drive the other way, write to admin@evtripreports.com before you pay.`,
      corridors: CORRIDORS.map((item) => item.title),
    }, 422);
  }

  const memberships = Array.isArray(data.memberships) ? data.memberships.map(clip).join('; ') : clip(data.memberships);

  const saved = await env.DB.prepare(
    `INSERT INTO plan_requests (created_at, name, email, tier, car, port, start_place, end_place, depart, return_date, passengers, memberships, notes, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')`
  ).bind(
    new Date().toISOString(), clip(data.name), clip(data.email), clip(data.tier), clip(data.car), clip(data.port),
    clip(data.start), clip(data.end), depart, clip(data.return), clip(data.passengers), memberships, packNotes(clip(data.notes), startBattery)
  ).run();
  const requestId = saved?.meta?.last_row_id;

  if (env.FASTMAIL_TOKEN) {
    const to = env.NOTIFY_TO || 'admin@evtripreports.com';
    const lines = [
      `New plan request: ${clip(data.tier)}`,
      'Owner notice only. No plan is sent to the customer from this request.',
      'Payment is not confirmed by this email. The customer is sent to Stripe next. Check Stripe, or wait for the Paid email.',
      '',
      `Name: ${clip(data.name)}`,
      `Email: ${clip(data.email)}`,
      `Car: ${clip(data.car)}`,
      `Port/adapter: ${clip(data.port)}`,
      `Route: ${clip(data.start)} to ${clip(data.end)}`,
      `Corridor: ${corridor.title}${corridor.startMatch === 'near' || corridor.endMatch === 'near' ? ' (start or end is near the end point)' : ''}`,
      `Leaving: ${depart.replace('T', ' at ')}${data.return ? `, back ${clip(data.return)} (the way back is built by hand)` : ''}`,
      `Start battery: ${startBattery == null ? 'not given' : `${startBattery}%`}`,
      ...(portKnown(data.port) ? [] : ['Charge port: NOT SURE. Ask the customer before building.']),
      `Passengers: ${clip(data.passengers) || 'not given'}`,
      `Memberships: ${memberships || 'none listed'}`,
      '',
      'Notes:',
      clip(data.notes) || '(none)',
      '',
      'Reply to this email to reach the driver.',
    ];
    waitUntil(
      sendMail({
        token: env.FASTMAIL_TOKEN,
        from: env.NOTIFY_FROM || to,
        to,
        replyTo: clip(data.email),
        subject: `Plan request: ${clip(data.start)} to ${clip(data.end)} (${clip(data.tier)})`,
        text: lines.join('\n'),
      }).catch((e) => console.error('notify failed', e.message))
    );
  }

  return json(requestId ? { ok: true, ref: refFor(requestId) } : { ok: true });
}

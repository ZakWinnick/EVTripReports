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

const REQUIRED = ['name', 'email', 'tier', 'car', 'port', 'start', 'end', 'depart'];
const MAX = 2000;
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export async function onRequestGet({ env }) {
  return json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY || null });
}

async function verifyTurnstile(request, env, token) {
  if (!env.TURNSTILE_SECRET) return true;
  const value = String(token ?? '');
  if (value.length < 1 || value.length > 2048) return false;

  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: value });
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) body.set('remoteip', ip);

  let res;
  try {
    res = await fetch(SITEVERIFY, { method: 'POST', body });
  } catch {
    return false;
  }
  let out;
  try { out = await res.json(); } catch { return false; }
  if (!res.ok || !out.success || out.action !== 'plan_request') return false;

  const allowed = String(env.TURNSTILE_HOSTNAMES || 'evtripreports.com')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.includes(out.hostname);
}

export async function onRequestPost({ request, env, waitUntil }) {
  if (!env.DB) return json({ error: 'Plan requests are not open yet.' }, 503);

  let data;
  try { data = await request.json(); } catch { return json({ error: 'The request was not valid JSON.' }, 400); }

  if (data.website) return json({ ok: true }); // honeypot: pretend success

  if (!(await verifyTurnstile(request, env, data['cf-turnstile-response']))) {
    return json({ error: 'The security check failed. Refresh the page and try again.' }, 403);
  }

  const missing = REQUIRED.filter((k) => !String(data[k] ?? '').trim());
  if (missing.length) return json({ error: `Missing: ${missing.join(', ')}.` }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(data.email))) return json({ error: 'That email address does not look right.' }, 400);

  const clip = (v) => String(v ?? '').slice(0, MAX);
  const memberships = Array.isArray(data.memberships) ? data.memberships.map(clip).join('; ') : clip(data.memberships);

  await env.DB.prepare(
    `INSERT INTO plan_requests (created_at, name, email, tier, car, port, start_place, end_place, depart, return_date, passengers, memberships, notes, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')`
  ).bind(
    new Date().toISOString(), clip(data.name), clip(data.email), clip(data.tier), clip(data.car), clip(data.port),
    clip(data.start), clip(data.end), clip(data.depart), clip(data.return), clip(data.passengers), memberships, clip(data.notes)
  ).run();

  if (env.FASTMAIL_TOKEN) {
    const to = env.NOTIFY_TO || 'admin@evtripreports.com';
    const lines = [
      `New plan request: ${clip(data.tier)}`,
      'Owner notice only. No plan is sent to the customer from this request.',
      '',
      `Name: ${clip(data.name)}`,
      `Email: ${clip(data.email)}`,
      `Car: ${clip(data.car)}`,
      `Port/adapter: ${clip(data.port)}`,
      `Route: ${clip(data.start)} to ${clip(data.end)}`,
      `Leaving: ${clip(data.depart)}${data.return ? `, back ${clip(data.return)}` : ''}`,
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

  return json({ ok: true });
}

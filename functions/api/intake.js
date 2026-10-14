// Cloudflare Pages Function: POST /api/intake
// Needs a D1 binding named DB (see schema.sql). Without it, returns 503 and the form says requests aren't open yet.
// With the FASTMAIL_TOKEN secret set, each request is also emailed to NOTIFY_TO (default admin@evtripreports.com).
import { sendMail } from '../_lib/fastmail.js';
const REQUIRED = ['name', 'email', 'tier', 'car', 'port', 'start', 'end', 'depart'];
const MAX = 2000;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export async function onRequestPost({ request, env, waitUntil }) {
  if (!env.DB) return json({ error: 'Plan requests are not open yet.' }, 503);

  let data;
  try { data = await request.json(); } catch { return json({ error: 'The request was not valid JSON.' }, 400); }

  if (data.website) return json({ ok: true }); // honeypot: pretend success

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

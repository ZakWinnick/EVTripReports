// Cloudflare Pages Function: POST /api/intake
// Needs a D1 binding named DB (see schema.sql). Without it, returns 503 and the form says requests aren't open yet.
const REQUIRED = ['name', 'email', 'tier', 'car', 'port', 'start', 'end', 'depart'];
const MAX = 2000;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export async function onRequestPost({ request, env }) {
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

  return json({ ok: true });
}

// Cloudflare Pages Function: /api/subscribe
// POST adds one email to Buttondown with the tag site-signup.
// Buttondown sends the confirmation email. This function does not set type,
// so a new subscriber stays on Buttondown's double opt-in.
//
// BUTTONDOWN_API_KEY is a Pages secret. It is never returned to the browser
// and it is not stored in this repo. GET returns open:true only when it is set.
//
// Turnstile matches /api/intake. Both names are Pages variables, not committed:
//   TURNSTILE_SITE_KEY   public site key. GET returns it so the form can render the widget.
//   TURNSTILE_SECRET      secret key. When set, POST requires a passing siteverify.
//   TURNSTILE_HOSTNAMES   optional comma-separated hostnames. Default: evtripreports.com.
// The widget action is newsletter_signup, so a plan-form token cannot be reused here.
// If TURNSTILE_SECRET is unset, signup still works (it still needs the Buttondown key).

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const BUTTONDOWN = 'https://api.buttondown.com/v1/subscribers';
const ACTION = 'newsletter_signup';
const TAG = 'site-signup';
const ALREADY = new Set(['email_already_exists', 'subscriber_already_exists']);

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function signupOpen(env) {
  return Boolean(env.BUTTONDOWN_API_KEY);
}

export async function onRequestGet({ env }) {
  return json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY || null, open: signupOpen(env) });
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
  if (!res.ok || !out.success || out.action !== ACTION) return false;

  const allowed = String(env.TURNSTILE_HOSTNAMES || 'evtripreports.com')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.includes(out.hostname);
}

function alreadySubscribed(body) {
  if (!body || typeof body !== 'object') return false;
  if (ALREADY.has(body.code)) return true;
  return JSON.stringify(body).toLowerCase().includes('already exist');
}

export async function onRequestPost({ request, env }) {
  if (!signupOpen(env)) return json({ error: 'Newsletter signup is not open yet.' }, 503);

  let data;
  try { data = await request.json(); } catch { return json({ error: 'The request was not valid JSON.' }, 400); }

  if (data.website) return json({ ok: true });

  if (!(await verifyTurnstile(request, env, data['cf-turnstile-response']))) {
    return json({ error: 'The security check failed. Refresh the page and try again.' }, 403);
  }

  const email = String(data.email ?? '').trim();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'That email address does not look right.' }, 400);
  }

  const payload = { email_address: email, tags: [TAG] };
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip && ip.length <= 45) payload.ip_address = ip;

  let res;
  try {
    res = await fetch(BUTTONDOWN, {
      method: 'POST',
      headers: {
        Authorization: `Token ${env.BUTTONDOWN_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error('buttondown subscribe failed', e.message);
    return json({ error: 'Signup did not go through. Try again in a minute.' }, 502);
  }

  let body = null;
  try { body = await res.json(); } catch { body = null; }

  if (res.ok) return json({ ok: true });
  if ((res.status === 400 || res.status === 409) && alreadySubscribed(body)) return json({ ok: true, already: true });

  console.error('buttondown subscribe failed', res.status, body && body.code ? body.code : '');
  if (body && (body.code === 'email_invalid' || body.code === 'email_empty')) {
    return json({ error: 'That email address does not look right.' }, 400);
  }
  if (body && (body.code === 'email_blocked' || body.code === 'subscriber_blocked' || body.code === 'subscriber_suppressed')) {
    return json({ error: "That email can't be added." }, 400);
  }
  return json({ error: 'Signup did not go through. Try again in a minute.' }, 502);
}

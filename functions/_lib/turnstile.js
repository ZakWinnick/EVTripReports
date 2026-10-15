// Cloudflare Turnstile siteverify. Used by plan intake and Find my plans.
// TURNSTILE_SECRET unset means the check is off and the caller still needs D1.
// TURNSTILE_HOSTNAMES is an optional comma-separated allow list. Default: evtripreports.com.
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyTurnstile(request, env, token, action) {
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
  if (!res.ok || !out.success || out.action !== action) return false;

  const allowed = String(env.TURNSTILE_HOSTNAMES || 'evtripreports.com')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.includes(out.hostname);
}

// Stripe webhook helpers: signature check and the order reference.
// Stripe signs `${timestamp}.${rawBody}` with HMAC-SHA256 and sends `t=<ts>,v1=<hex>[,v1=<hex>]`.
export const TOLERANCE_SECONDS = 300;
export const REF_PREFIX = 'etr-';

// Plan prices in cents, by the tier names the form sends. Used only to flag a mismatch.
export const TIER_CENTS = new Map([
  ['route plan', 1900],
  ['detailed plan', 3900],
  ['multi-day or family', 7900],
]);

export function refFor(requestId) {
  return `${REF_PREFIX}${requestId}`;
}

export function requestIdFromRef(ref) {
  const m = /^etr-([1-9]\d{0,14})$/.exec(String(ref ?? ''));
  return m ? Number(m[1]) : null;
}

function hexToBytes(hex) {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyStripeSignature(rawBody, header, secret, { now = Date.now(), tolerance = TOLERANCE_SECONDS } = {}) {
  if (!secret || !header) return false;
  let timestamp = '';
  const signatures = [];
  for (const part of String(header).split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key === 't') timestamp = value;
    else if (key === 'v1') signatures.push(value);
  }
  if (!/^\d{1,12}$/.test(timestamp) || !signatures.length) return false;
  if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) > tolerance) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${rawBody}`)));
  return signatures.some((sig) => {
    const bytes = hexToBytes(sig);
    return bytes && sameBytes(bytes, expected);
  });
}

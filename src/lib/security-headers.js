// One CSP for static _headers and every Pages Function that returns HTML or JSON.
// public/_headers repeats this string. scripts/csp.test.mjs fails if they drift.
export const CSP =
  "default-src 'self'; script-src 'self' https://tinylytics.app https://static.cloudflareinsights.com https://challenges.cloudflare.com; connect-src 'self' https://tinylytics.app https://cloudflareinsights.com https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; img-src 'self' data: https://tinylytics.app; style-src 'self' 'unsafe-inline'; font-src 'self'; form-action 'self' https://buy.stripe.com https://checkout.stripe.com; frame-ancestors 'none'; base-uri 'self'; object-src 'none'; upgrade-insecure-requests";

export const PERMISSIONS_POLICY =
  'geolocation=(), camera=(), microphone=(), payment=(), usb=(), interest-cohort=()';

export const REFERRER_POLICY = 'strict-origin-when-cross-origin';

export function applySecurityHeaders(init, { referrer = REFERRER_POLICY } = {}) {
  const headers = new Headers(init instanceof Headers ? init : init || {});
  headers.set('x-frame-options', 'DENY');
  headers.set('permissions-policy', PERMISSIONS_POLICY);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', referrer);
  headers.set('content-security-policy', CSP);
  headers.delete('access-control-allow-origin');
  return headers;
}

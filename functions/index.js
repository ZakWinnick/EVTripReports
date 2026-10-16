// The homepage is a built service overview, with one illustrative sample plan.
import { applySecurityHeaders } from '../src/lib/security-headers.js';

export async function onRequestGet(context) {
  const res = await context.next();
  if (!(res.headers.get('content-type') || '').includes('text/html')) return res;
  return new Response(res.body, { status: res.status, headers: applySecurityHeaders(res.headers) });
}

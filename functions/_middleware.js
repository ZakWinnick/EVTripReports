// Canonical host only: evtripreports.com and www. Everything else, including the
// official evtripreports.pages.dev production host and unique pages.dev aliases,
// is redirected (GET/HEAD) or rejected (other methods) so APIs and sign-in
// pages are not served on a second origin.
const CANONICAL = 'https://evtripreports.com';
const ALLOWED = new Set(['evtripreports.com', 'www.evtripreports.com']);

function hostOf(request) {
  const raw = request.headers.get('Host') || new URL(request.url).hostname;
  return raw.split(':')[0].toLowerCase();
}

export async function onRequest(context) {
  const host = hostOf(context.request);
  if (ALLOWED.has(host)) return context.next();

  const url = new URL(context.request.url);
  const method = context.request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') {
    return new Response(null, {
      status: 301,
      headers: {
        Location: `${CANONICAL}${url.pathname}${url.search}`,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-store',
      },
    });
  }
  return new Response('Forbidden', {
    status: 403,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    },
  });
}

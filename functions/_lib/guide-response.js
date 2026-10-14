// Decides whether /guides/<slug> is a real guide. Used by functions/guides/[[path]].js.
// A D1 miss must not fall through to the homepage: Pages will serve index.html with status 200
// when no 404.html matches inside a catch-all Function.

export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function guideSlug(params) {
  const raw = params?.path;
  const parts = Array.isArray(raw) ? raw.filter(Boolean) : raw ? [raw] : [];
  if (parts.length !== 1) return null;
  return SLUG.test(parts[0]) ? parts[0] : null;
}

// `head` is the start of the HTML body. The x-etr-guide header is set on built guide files.
// A homepage or 404 fallback will not carry that header or this slug's canonical path.
export function isBuiltGuide(slug, response, head = '') {
  if (!response || response.status !== 200) return false;
  const type = response.headers?.get?.('content-type') || '';
  if (type && !type.includes('text/html')) return false;
  if (response.headers?.get?.('x-etr-guide') === '1') return true;
  return String(head).includes(`/guides/${slug}/`);
}

// Decides whether /guides/<slug> is a real guide. Used by functions/guides/[[path]].js.
// A D1 miss must not fall through to the homepage: Pages will serve index.html with status 200
// when no 404.html matches inside a catch-all Function.

export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function pathParts(params) {
  const raw = params?.path;
  const parts = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return parts.map((part) => String(part || '').replace(/^\/+|\/+$/g, '')).filter(Boolean);
}

// /guides and /guides/<slug> are the same pages as the trailing-slash URLs.
// Send the slashless form to the slash form, which is the canonical URL.
// /guides/index.html is not redirected: the guide function reads that asset path.
export function guideSlashRedirect(request) {
  let url;
  try {
    url = new URL(request?.url || '');
  } catch {
    return null;
  }
  const path = url.pathname;
  if (!path || path.endsWith('/')) return null;
  if (path === '/guides') {
    url.pathname = '/guides/';
  } else {
    const match = path.match(/^\/guides\/([a-z0-9]+(?:-[a-z0-9]+)*)$/);
    if (!match || !SLUG.test(match[1])) return null;
    url.pathname = `/guides/${match[1]}/`;
  }
  return Response.redirect(url.toString(), 308);
}

export function guideSlug(params) {
  const parts = pathParts(params);
  if (parts.length !== 1) return null;
  return SLUG.test(parts[0]) ? parts[0] : null;
}

// /guides, /guides/, and /guides/index.html are the index. A real slug is not.
// Empty params alone are not enough: this file also runs for /guides/<slug>.
export function isGuidesIndex(params, request) {
  const parts = pathParts(params);
  if (parts.length > 1) return false;
  if (parts.length === 1 && parts[0] !== 'index.html') return false;
  if (parts[0] === 'index.html') return true;
  let pathname = '';
  try {
    pathname = new URL(request?.url || '').pathname.replace(/\/+$/, '') || '/';
  } catch {
    pathname = '';
  }
  if (!pathname) return true;
  return pathname === '/guides' || pathname === '/guides/index.html';
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

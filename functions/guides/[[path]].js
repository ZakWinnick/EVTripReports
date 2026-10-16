// The retired /guides/ directory redirects to the sample plan.
// Individual guide URLs remain available for existing references and source detail.
// Otherwise serves the page built from src/data/routes, if that file exists.
// Anything else is a 404. context.next() is not used: a miss was returning the
// homepage with status 200.
import { isBuiltGuide, isGuidesIndex, guideSlug, guideSlashRedirect } from '../_lib/guide-response.js';
import { html, getRoute } from '../_lib/routes.js';
import { esc, guideJsonLd, guideMain, guideMeta } from '../../src/lib/render-guide.js';
import { applySecurityHeaders } from '../../src/lib/security-headers.js';

function notFoundHeaders(init) {
  const headers = applySecurityHeaders(init);
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.set('x-robots-tag', 'noindex');
  return headers;
}

async function notFound(env, request) {
  try {
    const page = await env.ASSETS.fetch(new Request(new URL('/404.html', request.url)));
    if (page && page.ok) {
      return new Response(page.body, { status: 404, headers: notFoundHeaders(page.headers) });
    }
  } catch (e) {
    console.error('404 page missing', e.message);
  }
  return new Response('Page not found', { status: 404, headers: notFoundHeaders() });
}

function renderFromD1(shell, route, request) {
  const meta = guideMeta(route);
  const canonical = new URL(`/guides/${route.slug}/`, request.url).toString();
  const out = new HTMLRewriter()
    .on('title', { element: (e) => e.setInnerContent(meta.title) })
    .on('meta[name="description"]', { element: (e) => e.setAttribute('content', meta.description) })
    .on('meta[property="og:title"]', { element: (e) => e.setAttribute('content', meta.title) })
    .on('meta[property="og:description"]', { element: (e) => e.setAttribute('content', meta.description) })
    .on('meta[name="robots"]', { element: (e) => e.remove() })
    .on('head', {
      element: (e) => {
        e.append(`<link rel="canonical" href="${esc(canonical)}">`, { html: true });
        e.append(`<meta property="og:url" content="${esc(canonical)}">`, { html: true });
        e.append(guideJsonLd(route, canonical), { html: true });
      },
    })
    .on('main#main', { element: (e) => e.setInnerContent(guideMain(route), { html: true }) })
    .transform(shell);
  // The /guide-shell/* _headers rule sends X-Robots-Tag: noindex for the bare shell.
  // A rendered, published guide is indexable, so drop the inherited header.
  const headers = html(shell);
  headers.delete('x-robots-tag');
  return new Response(out.body, { status: 200, headers });
}

export async function onRequestGet(context) {
  const { request, env, params } = context;
  if (isGuidesIndex(params, request)) {
    const target = new URL('/sample-plan/', request.url);
    target.search = new URL(request.url).search;
    return new Response(null, { status: 308, headers: applySecurityHeaders({ location: target.toString() }) });
  }
  const slash = guideSlashRedirect(request);
  if (slash) return slash;
  const slug = guideSlug(params);
  if (!slug) return notFound(env, request);

  const route = await getRoute(env, slug);
  if (route) {
    const shell = await env.ASSETS.fetch(new Request(new URL('/guide-shell/index.html', request.url)));
    if (!shell.ok) return notFound(env, request);
    return renderFromD1(shell, route, request);
  }

  const built = await env.ASSETS.fetch(new Request(new URL(`/guides/${slug}/index.html`, request.url)));
  const marked = built.headers?.get?.('x-etr-guide') === '1';
  const head = built.ok && !marked ? (await built.clone().text()).slice(0, 12000) : '';
  if (isBuiltGuide(slug, built, head)) {
    return new Response(built.body, { status: 200, headers: html(built) });
  }
  return notFound(env, request);
}

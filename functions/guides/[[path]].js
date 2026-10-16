// Serves /guides/ as the index, and /guides/<slug>/ from D1 when that guide is
// live there. Slashless /guides and /guides/<slug> 308 to those URLs first.
// Otherwise serves the page built from src/data/routes, if that file exists.
// Anything else is a 404. context.next() is not used: a miss was returning the
// homepage with status 200.
import builtGuideIndex from '../_lib/built-guide-index.js';
import { isBuiltGuide, isGuidesIndex, guideSlug, guideSlashRedirect } from '../_lib/guide-response.js';
import { html, getRoute, listLiveGuideIndex } from '../_lib/routes.js';
import { guideIndexList, mergeGuideIndex } from '../../src/lib/guide-index.js';
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
  return new Response(out.body, { status: 200, headers: html(shell) });
}

function indexHeaders(page) {
  const headers = html(page);
  headers.delete('x-etr-guide');
  return headers;
}

async function fetchGuideIndex(env, request) {
  for (const path of ['/guides/index.html', '/guides/', '/guides']) {
    try {
      const page = await env.ASSETS.fetch(new Request(new URL(path, request.url)));
      if (!page?.ok) continue;
      const type = page.headers?.get?.('content-type') || '';
      if (type && !type.includes('text/html')) continue;
      const head = (await page.clone().text()).slice(0, 12000);
      if (!head.includes('id="guides-index"')) continue;
      return page;
    } catch (e) {
      console.error('guides index read failed', e.message);
    }
  }
  return null;
}

async function guideIndex(context) {
  const { request, env } = context;
  const page = await fetchGuideIndex(env, request);
  if (!page) return notFound(env, request);
  const d1 = await listLiveGuideIndex(env);
  if (!d1.length) return new Response(page.body, { status: 200, headers: indexHeaders(page) });
  const list = guideIndexList(mergeGuideIndex(builtGuideIndex, d1));
  const rewritten = new HTMLRewriter()
    .on('ul#guides-index', { element: (e) => e.setInnerContent(list, { html: true }) })
    .transform(page);
  return new Response(rewritten.body, { status: 200, headers: indexHeaders(page) });
}

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const slash = guideSlashRedirect(request);
  if (slash) return slash;
  if (isGuidesIndex(params, request)) return guideIndex(context);
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

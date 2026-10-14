// Serves /guides/<slug>/ from D1 when that guide is live there.
// Otherwise serves the page built from src/data/routes, if that file exists.
// Anything else is a 404. context.next() is not used: a miss was returning the homepage with status 200.
import { getRoute, html } from '../_lib/routes.js';
import { guideSlug, isBuiltGuide } from '../_lib/guide-response.js';
import { guideMain, guideMeta } from '../../src/lib/render-guide.js';

async function notFound(env, request) {
  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex',
  });
  try {
    const page = await env.ASSETS.fetch(new Request(new URL('/404.html', request.url)));
    if (page && page.ok) {
      const h = new Headers(page.headers);
      h.set('content-type', 'text/html; charset=utf-8');
      h.set('cache-control', 'no-store');
      h.set('x-robots-tag', 'noindex');
      return new Response(page.body, { status: 404, headers: h });
    }
  } catch (e) {
    console.error('404 page missing', e.message);
  }
  return new Response('Page not found', { status: 404, headers });
}

function renderFromD1(shell, route, request) {
  const meta = guideMeta(route);
  const canonical = new URL(`/guides/${route.slug}/`, request.url).toString();
  const out = new HTMLRewriter()
    .on('title', { element: (e) => e.setInnerContent(meta.title) })
    .on('meta[name="description"]', { element: (e) => e.setAttribute('content', meta.description) })
    .on('meta[property="og:title"]', { element: (e) => e.setAttribute('content', meta.title) })
    .on('meta[property="og:description"]', { element: (e) => e.setAttribute('content', meta.description) })
    .on('meta[property="og:url"]', { element: (e) => e.setAttribute('content', canonical) })
    .on('link[rel="canonical"]', { element: (e) => e.setAttribute('href', canonical) })
    .on('meta[name="robots"]', { element: (e) => e.remove() })
    .on('main#main', { element: (e) => e.setInnerContent(guideMain(route), { html: true }) })
    .transform(shell);
  return new Response(out.body, { status: 200, headers: html(shell) });
}

export async function onRequestGet(context) {
  const { request, env, params } = context;
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

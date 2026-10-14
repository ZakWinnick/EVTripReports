// Serves /guides/<slug>/ from D1 when the guide is published there; otherwise falls through to the built page.
import { getRoute, html } from '../_lib/routes.js';
import { guideMain, guideMeta, esc } from '../../src/lib/render-guide.js';

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const parts = Array.isArray(params.path) ? params.path : [params.path].filter(Boolean);
  if (parts.length !== 1) return context.next();
  const route = await getRoute(env, parts[0]);
  if (!route) return context.next();

  const shell = await env.ASSETS.fetch(new URL('/guide-shell/', request.url));
  if (!shell.ok) return context.next();
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

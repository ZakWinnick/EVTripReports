// Home page: guide cards and the featured route come from D1 when published there.
import { getRoute, listRoutes, html } from './_lib/routes.js';
import { guideCards, routeLine, statStrip } from '../src/lib/render-guide.js';

const FEATURED = 'la-to-las-vegas';

export async function onRequestGet(context) {
  const res = await context.next();
  if (!res.ok || !(res.headers.get('content-type') || '').includes('text/html')) return res;
  const [routes, featured] = await Promise.all([listRoutes(context.env), getRoute(context.env, FEATURED)]);
  if (!routes && !featured) return res;
  let rw = new HTMLRewriter();
  if (routes && routes.length) rw = rw.on('ul#guides-list', { element: (e) => e.setInnerContent(guideCards(routes), { html: true }) });
  if (featured) {
    rw = rw
      .on('#featured-route', { element: (e) => e.setInnerContent(routeLine(featured, `/guides/${FEATURED}`), { html: true }) })
      .on('#featured-stats', { element: (e) => e.setInnerContent(statStrip(featured.stats), { html: true }) });
  }
  return new Response(rw.transform(res).body, { status: res.status, headers: html(res) });
}

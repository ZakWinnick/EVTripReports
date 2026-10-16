// Serves /sitemap.xml from the built guide list plus live D1 routes.
// Locs use https://evtripreports.com and a trailing slash so they match each page's canonical tag.
import { applySecurityHeaders } from '../src/lib/security-headers.js';
import builtGuides from './_lib/built-guides.js';
import { buildSitemapXml, guidesForSitemap, loadD1Guides } from './_lib/sitemap.js';

export async function onRequestGet(context) {
  const d1 = await loadD1Guides(context.env);
  const xml = buildSitemapXml(guidesForSitemap(builtGuides, d1));
  return new Response(xml, {
    headers: applySecurityHeaders({
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=0, s-maxage=300',
    }),
  });
}

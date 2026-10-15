// /sitemap.xml lists the public canonical URLs. Built guides come from the
// generated list; a live D1 row is what the site serves, including guides
// that were never in the Astro build.
import { SLUG } from './guide-response.js';
import { lastmodDate } from '../../src/lib/lastmod-date.js';

export const ORIGIN = 'https://evtripreports.com';

// These match the canonical tags on the built pages (directory URLs, trailing slash).
export const STATIC_LOCS = [
  `${ORIGIN}/`,
  `${ORIGIN}/plans/`,
  `${ORIGIN}/about/`,
  `${ORIGIN}/faq/`,
  `${ORIGIN}/methodology/`,
  `${ORIGIN}/privacy/`,
  `${ORIGIN}/terms/`,
  `${ORIGIN}/find-my-plans/`,
];

function guideEntries(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const slug = typeof item?.slug === 'string' ? item.slug : '';
    if (!SLUG.test(slug)) continue;
    out.push({ slug, lastmod: lastmodDate(item.lastmod) });
  }
  return out;
}

// D1 wins for a slug it publishes: that row is the page visitors get.
// A built guide stays listed when D1 has no live row.
export function guidesForSitemap(built, d1) {
  const map = new Map();
  for (const guide of guideEntries(built)) map.set(guide.slug, guide);
  for (const guide of guideEntries(d1)) map.set(guide.slug, guide);
  return [...map.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

export function sitemapEntries(guides) {
  return [
    ...STATIC_LOCS.map((loc) => ({ loc, lastmod: null })),
    ...guides.map((guide) => ({
      loc: `${ORIGIN}/guides/${guide.slug}/`,
      lastmod: guide.lastmod || null,
    })),
  ];
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function buildSitemapXml(guides) {
  const urls = sitemapEntries(guides)
    .map((entry) => {
      const lastmod = entry.lastmod ? `\n    <lastmod>${xmlEscape(entry.lastmod)}</lastmod>` : '';
      return `  <url>\n    <loc>${xmlEscape(entry.loc)}</loc>${lastmod}\n  </url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export async function loadD1Guides(env) {
  if (!env?.DB) return [];
  try {
    const result = await env.DB.prepare(
      "SELECT slug, json FROM routes WHERE status = 'live' AND json IS NOT NULL",
    ).all();
    const guides = [];
    for (const row of result?.results || []) {
      if (!row || !SLUG.test(row.slug || '')) continue;
      let parsed;
      try {
        parsed = JSON.parse(row.json);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const guide = { slug: row.slug };
      const lastmod = lastmodDate(parsed.checked);
      if (lastmod) guide.lastmod = lastmod;
      guides.push(guide);
    }
    return guides;
  } catch (e) {
    console.error('sitemap routes read failed', e.message);
    return [];
  }
}

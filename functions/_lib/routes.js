// Guide content stored in D1 (table `routes`). Publishing a guide or an update is a row write;
// the site picks it up on the next request. Without the DB binding or a row, the built version is served.
import { guideIndexRecord } from '../../src/lib/guide-index.js';
import { SLUG } from './guide-response.js';

export async function getRoute(env, slug) {
  if (!env.DB || !slug) return null;
  try {
    const row = await env.DB.prepare("SELECT json FROM routes WHERE slug = ? AND status = 'live' AND json IS NOT NULL").bind(slug).first();
    return row ? JSON.parse(row.json) : null;
  } catch (e) {
    console.error('routes read failed', e.message);
    return null;
  }
}

export async function listRoutes(env) {
  if (!env.DB) return null;
  try {
    const r = await env.DB.prepare('SELECT slug, title, highway, status, json, sort FROM routes ORDER BY sort, title').all();
    return (r.results || []).filter((x) => x.status === 'live').map((x) => {
      const j = x.json ? JSON.parse(x.json) : null;
      return { slug: x.slug, title: x.title, highway: x.highway, status: x.status, miles: j ? j.stats[0].value : null, stops: j ? j.stops.length : null };
    });
  } catch (e) {
    console.error('routes list failed', e.message);
    return null;
  }
}

// Live D1 rows for /guides/. Same status filter as the sitemap. The homepage
// listRoutes() call is the other reader; this one keeps start, end, and miles
// from the stored route JSON so the index can show them.
export async function listLiveGuideIndex(env) {
  if (!env?.DB) return [];
  try {
    const result = await env.DB.prepare(
      "SELECT slug, title, highway, status, json FROM routes WHERE status = 'live' AND json IS NOT NULL ORDER BY sort, title",
    ).all();
    const guides = [];
    for (const row of result?.results || []) {
      if (!row || row.status !== 'live' || !SLUG.test(row.slug || '')) continue;
      let parsed = row.json;
      if (typeof parsed === 'string') {
        try {
          parsed = JSON.parse(parsed);
        } catch {
          continue;
        }
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const record = guideIndexRecord({
        ...parsed,
        slug: row.slug,
        title: parsed.title || row.title,
        highway: parsed.highway || row.highway,
      });
      if (!record.title) continue;
      guides.push(record);
    }
    return guides;
  } catch (e) {
    console.error('guide index read failed', e.message);
    return [];
  }
}

export const html = (res) => {
  const h = new Headers(res.headers);
  h.set('content-type', 'text/html; charset=utf-8');
  h.set('cache-control', 'public, max-age=0, s-maxage=300');
  return h;
};

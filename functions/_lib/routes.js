// Guide content stored in D1 (table `routes`). Publishing a guide or an update is a row write;
// the site picks it up on the next request. Without the DB binding or a row, the built version is served.
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
    return (r.results || []).map((x) => {
      const j = x.json ? JSON.parse(x.json) : null;
      return { slug: x.slug, title: x.title, highway: x.highway, status: x.status, miles: j ? j.stats[0].value : null, stops: j ? j.stops.length : null };
    });
  } catch (e) {
    console.error('routes list failed', e.message);
    return null;
  }
}

export const html = (res) => {
  const h = new Headers(res.headers);
  h.set('content-type', 'text/html; charset=utf-8');
  h.set('cache-control', 'public, max-age=0, s-maxage=300');
  return h;
};

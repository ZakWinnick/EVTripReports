// /data/<slug>.json: the D1 version of a guide when published there, else the built file.
import { getRoute } from '../_lib/routes.js';

export async function onRequestGet(context) {
  const name = String(context.params.file || '');
  if (!name.endsWith('.json')) return context.next();
  const route = await getRoute(context.env, name.slice(0, -5));
  if (!route) return context.next();
  return new Response(JSON.stringify(route), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=0, s-maxage=60' } });
}

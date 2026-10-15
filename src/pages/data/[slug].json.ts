// Publishes each route's data at /data/<slug>.json so the station-check Worker can diff against it.
import { exportStatus } from '../../lib/publish-status.js';

export async function getStaticPaths() {
  const list = (await import('../../data/routes.json')).default as { slug: string; status: string }[];
  const listed = new Map(list.map((r) => [r.slug, r.status]));
  const files = import.meta.glob('../../data/routes/*.json', { eager: true });
  return Object.values(files).flatMap((m: any) => {
    const route = m.default ?? m;
    if (exportStatus(listed.get(route.slug), route) !== 'live') return [];
    return [{ params: { slug: route.slug }, props: { route } }];
  });
}

export function GET({ props }: { props: { route: unknown } }) {
  return new Response(JSON.stringify(props.route), { headers: { 'content-type': 'application/json' } });
}

// Publishes each route's data at /data/<slug>.json so the station-check Worker can diff against it.
export async function getStaticPaths() {
  const files = import.meta.glob('../../data/routes/*.json', { eager: true });
  return Object.values(files).map((m: any) => {
    const route = m.default ?? m;
    return { params: { slug: route.slug }, props: { route } };
  });
}

export function GET({ props }: { props: { route: unknown } }) {
  return new Response(JSON.stringify(props.route), { headers: { 'content-type': 'application/json' } });
}

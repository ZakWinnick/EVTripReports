// Whether a route may be published.
// Every primary's stalls, power, and access must be verified.
// A disclosed conflict on a backup or other site does not block that.
// Unverified, unpublished, or conflicting stalls, power, or access on a primary does.
// Price is often unpublished by the network and is not part of this gate.

const PRIMARY_FACTS = ['stalls', 'power', 'access'];

export function primaryPublishBlock(route) {
  const stops = Array.isArray(route?.stops) ? route.stops : [];
  if (!stops.length) return 'no stops';
  for (const stop of stops) {
    const name = stop?.name || stop?.id || 'stop';
    const primary = stop?.primary;
    if (!primary) return `${name} has no primary`;
    for (const key of PRIMARY_FACTS) {
      const status = primary[key]?.status;
      if (status !== 'verified') return `${name}: primary ${key} is ${status || 'missing'}`;
    }
  }
  return null;
}

// routes.json `live` is the owner's approval. `live-ready` is the same approval
// under the older label. Either one is written as live when the primaries pass.
// Anything else, including a listed live route with a blocked primary, stays verifying.
export function exportStatus(listedStatus, route) {
  const approved = listedStatus === 'live' || listedStatus === 'live-ready';
  if (!approved) return 'verifying';
  if (primaryPublishBlock(route)) return 'verifying';
  return 'live';
}

// Homepage cards. A route is listed only when routes.json approves it and the
// primary gate passes. Verifying routes stay off the homepage.
export function visibleHomeRoutes(list, routeBySlug) {
  return (Array.isArray(list) ? list : [])
    .map((item) => {
      const route = routeBySlug?.[item?.slug];
      return {
        ...item,
        status: exportStatus(item?.status, route),
        stops: Array.isArray(route?.stops) ? route.stops.length : item?.stops,
      };
    })
    .filter((item) => item.status === 'live');
}

import { buildPlan } from '../../scripts/build-plan.mjs';

// A fictional traveler using the same builder as customer drafts. No order is saved.
// The example starts at the documented corridor boundary, not an unmeasured home address.
export function samplePlan(route) {
  return buildPlan({
    slug: route.slug,
    vehicle: '2024 Hyundai Ioniq 5',
    adapter: 'CCS port, with a NACS adapter',
    memberships: ['Electrify America Pass+'],
    startBattery: 80,
    depart: '2026-11-02T08:00',
    tier: '$39',
    passengers: '2 adults, 1 dog',
    notes: 'One dog. Prefer a stop with a restroom when the guide lists one.',
  }, route);
}

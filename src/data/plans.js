// Paid checkout is off. Founding plans are free.
// When checkout opens: set foundingFree to false, set each tier's price to the
// string to show (for example "$19"), and set stripeUrl to that tier's Stripe Payment Link.
export const foundingFree = true;

export const tiers = [
  {
    id: 'route',
    name: 'Route plan',
    blurb: 'Charging stops and backups for one drive.',
    delivery: 'Within 48 hours',
    price: null,
    stripeUrl: null,
  },
  {
    id: 'detailed',
    name: 'Detailed plan',
    blurb: 'The route plan, plus food, restrooms, and hotels with chargers.',
    delivery: 'Within 48 hours',
    price: null,
    stripeUrl: null,
  },
  {
    id: 'multiday',
    name: 'Multi-day or family',
    blurb: 'Several days, overnight charging, and stops timed for kids.',
    delivery: 'Within 3 business days',
    price: null,
    stripeUrl: null,
  },
];

export function checkoutOpen(tier) {
  return foundingFree === false && Boolean(tier.stripeUrl);
}

export function priceLabel(tier) {
  if (!checkoutOpen(tier)) return 'Free';
  return tier.price || 'Paid';
}

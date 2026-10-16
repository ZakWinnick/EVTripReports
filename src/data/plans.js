// Stripe Payment Links. Each link is set in the Stripe dashboard to return
// to https://evtripreports.com/plans?paid=1 after payment.
export const tiers = [
  {
    id: 'route',
    name: 'Route plan',
    blurb: 'Charging options, available backups, and compatibility for one drive.',
    delivery: 'Within 48 hours',
    price: '$19',
    stripeUrl: 'https://buy.stripe.com/dRmeVd3ui5XF9r06iq5sA00',
  },
  {
    id: 'detailed',
    name: 'Detailed plan',
    blurb: 'Adds estimated battery targets and sourced food, restroom, and lodging notes where available.',
    delivery: 'Within 48 hours',
    price: '$39',
    stripeUrl: 'https://buy.stripe.com/aFa8wP2qeadVeLk36e5sA01',
  },
  {
    id: 'multiday',
    name: 'Multi-day or family',
    blurb: 'Several days, overnight charging research, and contingency notes for your travel needs.',
    delivery: 'Within 3 business days',
    price: '$79',
    stripeUrl: 'https://buy.stripe.com/28E14naWKeub9r05em5sA02',
  },
];

export function priceLabel(tier) {
  return tier.price;
}

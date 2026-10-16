// The corridors we can plan a paid trip for, and the check that maps an order's
// start and end to one of them. Pure: no clock, no network, no files.
//
// A plan is built from one corridor file, in the direction the file runs
// (`from` to `to`). An order that runs the other way, or that does not match a
// corridor, is never auto-built. scripts/order-to-route.mjs and the admin queue
// use this file, and /plans/ lists CORRIDORS. src/data/routes.json decides which
// corridors are live. A test keeps the two in step, so a hidden route is never offered.

const STATES = {
  al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california', co: 'colorado', ct: 'connecticut',
  de: 'delaware', fl: 'florida', ga: 'georgia', hi: 'hawaii', id: 'idaho', il: 'illinois', in: 'indiana', ia: 'iowa',
  ks: 'kansas', ky: 'kentucky', la: 'louisiana', me: 'maine', md: 'maryland', ma: 'massachusetts', mi: 'michigan',
  mn: 'minnesota', ms: 'mississippi', mo: 'missouri', mt: 'montana', ne: 'nebraska', nv: 'nevada', nh: 'new hampshire',
  nj: 'new jersey', nm: 'new mexico', ny: 'new york', nc: 'north carolina', nd: 'north dakota', oh: 'ohio', ok: 'oklahoma',
  or: 'oregon', pa: 'pennsylvania', ri: 'rhode island', sc: 'south carolina', sd: 'south dakota', tn: 'tennessee',
  tx: 'texas', ut: 'utah', vt: 'vermont', va: 'virginia', wa: 'washington', wv: 'west virginia', wi: 'wisconsin',
  wy: 'wyoming', dc: 'district of columbia',
};
const STATE_BY_NAME = new Map(Object.entries(STATES).map(([abbr, name]) => [name, abbr]));
const STATE_ABBRS = new Set(Object.keys(STATES));

// names: the city and its common short forms. near: places inside the same metro area,
// within about 35 miles of the corridor's end point. A near match is accepted and noted.
const LA = {
  label: 'Los Angeles', state: 'ca',
  names: ['los angeles', 'la', 'lax', 'downtown la', 'downtown los angeles', 'east la', 'east los angeles'],
  near: ['pasadena', 'santa monica', 'burbank', 'glendale', 'long beach', 'hollywood', 'west hollywood', 'beverly hills', 'culver city', 'inglewood', 'torrance', 'anaheim', 'santa ana', 'el monte', 'van nuys', 'north hollywood', 'venice'],
};
const LAS_VEGAS = { label: 'Las Vegas', state: 'nv', names: ['las vegas', 'vegas', 'lv'], near: ['henderson', 'north las vegas'] };
const SAN_FRANCISCO = { label: 'San Francisco', state: 'ca', names: ['san francisco', 'sf', 'sfo'], near: [] };
const NYC = { label: 'New York City', state: 'ny', names: ['new york', 'new york city', 'nyc', 'manhattan'], near: ['brooklyn', 'queens', 'bronx'] };

export const CORRIDORS = [
  { slug: 'la-to-las-vegas', title: 'LA to Las Vegas', highway: 'I-15', from: LA, to: LAS_VEGAS },
  { slug: 'la-to-sf', title: 'LA to San Francisco', highway: 'I-5', from: LA, to: SAN_FRANCISCO },
  { slug: 'sf-to-tahoe', title: 'SF to Lake Tahoe', highway: 'I-80', from: SAN_FRANCISCO, to: { label: 'Lake Tahoe', state: 'ca', names: ['lake tahoe', 'tahoe', 'truckee'], near: [] } },
  { slug: 'la-to-phoenix', title: 'LA to Phoenix', highway: 'I-10', from: LA, to: { label: 'Phoenix', state: 'az', names: ['phoenix'], near: ['scottsdale', 'tempe', 'mesa'] } },
  { slug: 'seattle-to-portland', title: 'Seattle to Portland', highway: 'I-5', from: { label: 'Seattle', state: 'wa', names: ['seattle'], near: [] }, to: { label: 'Portland', state: 'or', names: ['portland'], near: [] } },
  { slug: 'nyc-to-boston', title: 'NYC to Boston', highway: 'I-95', from: NYC, to: { label: 'Boston', state: 'ma', names: ['boston'], near: [] } },
  { slug: 'dc-to-nyc', title: 'Washington, DC to NYC', highway: 'I-95', from: { label: 'Washington, DC', state: 'dc', names: ['washington dc', 'washington', 'dc', 'district of columbia'], near: [] }, to: NYC },
  { slug: 'las-vegas-to-salt-lake-city', title: 'Las Vegas to Salt Lake City', highway: 'I-15', from: LAS_VEGAS, to: { label: 'Salt Lake City', state: 'ut', names: ['salt lake city', 'salt lake', 'slc'], near: [] } },
  { slug: 'la-to-san-diego', title: 'LA to San Diego', highway: 'I-5', from: LA, to: { label: 'San Diego', state: 'ca', names: ['san diego', 'sd'], near: [] } },
  { slug: 'dallas-to-austin', title: 'Dallas to Austin', highway: 'I-35', from: { label: 'Dallas', state: 'tx', names: ['dallas'], near: [] }, to: { label: 'Austin', state: 'tx', names: ['austin'], near: [] } },
];

function squash(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[^a-z0-9\s,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stateOf(text) {
  const t = squash(text);
  if (STATE_ABBRS.has(t)) return t;
  return STATE_BY_NAME.get(t) || '';
}

// "Las Vegas, NV" -> { city: "las vegas", state: "nv" }. "Washington, DC" -> { city: "washington", state: "dc" }.
// A trailing state with no comma ("Las Vegas NV", "Portland Oregon") is split off. "Washington DC" is kept as a city.
export function parsePlace(text) {
  const clean = squash(text);
  if (!clean) return { city: '', state: '' };
  const parts = clean.split(',').map((part) => part.trim()).filter(Boolean);
  let city = parts[0] || '';
  let state = '';
  for (const extra of parts.slice(1)) {
    const found = stateOf(extra);
    if (found) { state = found; break; }
  }
  if (!state) {
    const words = city.split(' ');
    for (const size of [2, 1]) {
      if (words.length <= size) continue;
      const tail = words.slice(-size).join(' ');
      const found = stateOf(tail);
      if (found) {
        state = found;
        city = words.slice(0, -size).join(' ');
        break;
      }
    }
  }
  return { city, state };
}

// 'exact', 'near', or '' for one end of a corridor.
export function matchEnd(text, end) {
  const place = parsePlace(text);
  if (!place.city) return '';
  if (place.state && place.state !== end.state) return '';
  if (end.names.includes(place.city)) return 'exact';
  if (end.near.includes(place.city)) return 'near';
  return '';
}

export function matchOrder({ start, end } = {}) {
  const hits = [];
  for (const corridor of CORRIDORS) {
    const forward = [matchEnd(start, corridor.from), matchEnd(end, corridor.to)];
    if (forward[0] && forward[1]) hits.push({ corridor, direction: 'forward', startMatch: forward[0], endMatch: forward[1] });
    const reverse = [matchEnd(start, corridor.to), matchEnd(end, corridor.from)];
    if (reverse[0] && reverse[1]) hits.push({ corridor, direction: 'reverse', startMatch: reverse[0], endMatch: reverse[1] });
  }
  const pick = hits.find((hit) => hit.direction === 'forward') || hits[0];
  if (!pick) return { status: 'unmatched', slug: '', title: '', direction: '', matches: [] };
  return {
    status: pick.direction,
    slug: pick.corridor.slug,
    title: pick.corridor.title,
    startMatch: pick.startMatch,
    endMatch: pick.endMatch,
    direction: pick.direction,
    matches: hits.map((hit) => ({ slug: hit.corridor.slug, direction: hit.direction })),
  };
}

export function corridorBySlug(slug) {
  return CORRIDORS.find((corridor) => corridor.slug === slug) || null;
}

// What the buyer sees. Direction matters: a plan runs from `from` to `to` only.
export function plannableList() {
  return CORRIDORS.map((corridor) => ({
    slug: corridor.slug,
    title: corridor.title,
    highway: corridor.highway,
    from: corridor.from.label,
    to: corridor.to.label,
  }));
}

export const UNSUPPORTED_MESSAGE = 'We cannot plan that trip yet. We plan the corridors listed on the plans page, in the direction shown. If yours is close to one, write to admin@evtripreports.com before you pay.';

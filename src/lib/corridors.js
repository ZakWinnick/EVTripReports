// Matches requests to existing guide data as a research shortcut.
// Custom trips are not limited to these routes. Unmatched or reverse requests
// need freshly sourced route data before the builder can use them.
// Pure: no clock, network, or files.

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
  near: ['pasadena', 'santa monica', 'burbank', 'glendale', 'long beach', 'hollywood', 'west hollywood', 'beverly hills', 'culver city', 'inglewood', 'torrance', 'anaheim', 'santa ana', 'el monte', 'van nuys', 'north hollywood', 'venice', 'venice beach', 'irvine', 'costa mesa', 'newport beach', 'huntington beach', 'fullerton', 'orange', 'orange county', 'downey', 'whittier', 'pomona', 'alhambra', 'monterey park', 'west covina', 'santa clarita', 'calabasas', 'malibu', 'manhattan beach', 'redondo beach', 'el segundo', 'carson', 'compton', 'sherman oaks', 'encino', 'studio city', 'woodland hills', 'northridge', 'universal city', 'lax airport', 'los angeles international airport', 'disneyland'],
};
const LAS_VEGAS = { label: 'Las Vegas', state: 'nv', names: ['las vegas', 'vegas', 'lv'], near: ['henderson', 'north las vegas', 'summerlin', 'paradise', 'spring valley', 'enterprise', 'boulder city', 'las vegas strip', 'the strip', 'strip'] };
const SAN_FRANCISCO = {
  label: 'San Francisco', state: 'ca',
  names: ['san francisco', 'sf', 'sfo', 'san francisco bay area', 'sf bay area', 'bay area', 'the bay'],
  near: ['oakland', 'berkeley', 'san jose', 'daly city', 'south san francisco', 'san mateo', 'redwood city', 'palo alto', 'mountain view', 'sunnyvale', 'santa clara', 'cupertino', 'menlo park', 'fremont', 'hayward', 'alameda', 'emeryville', 'richmond', 'walnut creek', 'san rafael', 'sausalito', 'mill valley', 'silicon valley', 'oakland airport', 'san jose airport'],
};
const NYC = {
  label: 'New York City', state: 'ny', alsoStates: ['nj'],
  names: ['new york', 'new york city', 'nyc', 'manhattan', 'new york new york'],
  near: ['brooklyn', 'queens', 'bronx', 'the bronx', 'staten island', 'long island city', 'astoria', 'flushing', 'harlem', 'jfk', 'laguardia', 'lga', 'yonkers', 'jersey city', 'hoboken', 'newark', 'fort lee', 'weehawken'],
};

export const CORRIDORS = [
  { slug: 'la-to-las-vegas', title: 'LA to Las Vegas', highway: 'I-15', from: LA, to: LAS_VEGAS },
  { slug: 'la-to-sf', title: 'LA to San Francisco', highway: 'I-5', from: LA, to: SAN_FRANCISCO },
  { slug: 'sf-to-tahoe', title: 'SF to Lake Tahoe', highway: 'I-80', from: SAN_FRANCISCO, to: { label: 'Lake Tahoe', state: 'ca', alsoStates: ['nv'], names: ['lake tahoe', 'tahoe', 'truckee', 'south lake tahoe', 'north lake tahoe'], near: ['tahoe city', 'incline village', 'kings beach', 'stateline', 'crystal bay', 'olympic valley', 'palisades tahoe', 'squaw valley', 'homewood', 'tahoma', 'carnelian bay', 'tahoe vista', 'zephyr cove', 'tahoe keys', 'meeks bay', 'emerald bay'] } },
  { slug: 'la-to-phoenix', title: 'LA to Phoenix', highway: 'I-10', from: LA, to: { label: 'Phoenix', state: 'az', names: ['phoenix'], near: ['scottsdale', 'tempe', 'mesa', 'chandler', 'gilbert', 'glendale', 'peoria', 'surprise', 'goodyear', 'avondale', 'paradise valley', 'fountain hills', 'sky harbor', 'phoenix sky harbor'] } },
  { slug: 'seattle-to-portland', title: 'Seattle to Portland', highway: 'I-5', from: { label: 'Seattle', state: 'wa', names: ['seattle'], near: ['bellevue', 'tacoma', 'redmond', 'kirkland', 'everett', 'renton', 'bothell', 'kent', 'seatac', 'sea tac', 'federal way', 'shoreline', 'lynnwood', 'issaquah', 'mercer island', 'sea tac airport'] }, to: { label: 'Portland', state: 'or', alsoStates: ['wa'], names: ['portland'], near: ['beaverton', 'hillsboro', 'gresham', 'lake oswego', 'tigard', 'milwaukie', 'oregon city', 'tualatin', 'vancouver', 'pdx'], stateOnly: ['vancouver'] } },
  { slug: 'nyc-to-boston', title: 'NYC to Boston', highway: 'I-95', from: NYC, to: { label: 'Boston', state: 'ma', names: ['boston'], near: ['cambridge', 'somerville', 'brookline', 'quincy', 'newton', 'medford', 'waltham', 'watertown', 'revere', 'logan airport'] } },
  { slug: 'dc-to-nyc', title: 'Washington, DC to NYC', highway: 'I-95', from: { label: 'Washington, DC', state: 'dc', alsoStates: ['va', 'md'], names: ['washington dc', 'washington', 'dc', 'district of columbia', 'washington d c'], near: ['arlington', 'alexandria', 'bethesda', 'silver spring', 'rockville', 'college park', 'tysons', 'mclean', 'reston', 'fairfax', 'falls church', 'hyattsville', 'national harbor', 'capitol hill', 'dulles', 'reagan national'] }, to: NYC },
  { slug: 'las-vegas-to-salt-lake-city', title: 'Las Vegas to Salt Lake City', highway: 'I-15', from: LAS_VEGAS, to: { label: 'Salt Lake City', state: 'ut', names: ['salt lake city', 'salt lake', 'slc'], near: ['west valley city', 'sandy', 'murray', 'south jordan', 'west jordan', 'draper', 'midvale', 'millcreek', 'bountiful', 'park city', 'lehi', 'orem', 'provo', 'ogden', 'layton'] } },
  { slug: 'la-to-san-diego', title: 'LA to San Diego', highway: 'I-5', from: LA, to: { label: 'San Diego', state: 'ca', names: ['san diego', 'sd'], near: ['la jolla', 'chula vista', 'national city', 'coronado', 'carlsbad', 'oceanside', 'encinitas', 'del mar', 'la mesa', 'el cajon', 'escondido', 'pacific beach', 'ocean beach', 'poway', 'santee', 'imperial beach'] } },
  { slug: 'dallas-to-austin', title: 'Dallas to Austin', highway: 'I-35', from: { label: 'Dallas', state: 'tx', names: ['dallas', 'dfw', 'dallas fort worth'], near: ['fort worth', 'plano', 'irving', 'arlington', 'frisco', 'mckinney', 'garland', 'richardson', 'denton', 'grand prairie', 'mesquite', 'addison', 'carrollton', 'lewisville', 'allen', 'dallas love field'] }, to: { label: 'Austin', state: 'tx', names: ['austin'], near: ['round rock', 'cedar park', 'pflugerville', 'georgetown', 'san marcos', 'lakeway', 'bee cave', 'leander', 'kyle', 'buda', 'manor'] } },
];

function squash(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b\d{5}(?:-\d{4})?\b/g, ' ')
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

// 'exact', 'near', or '' for one end of a corridor. The first part of the text is the place; later parts
// ("Pasadena" in "123 Main St, Pasadena, CA") are tried too, so a street address or "City, State, USA" still matches.
export function matchEnd(text, end) {
  const clean = squash(text);
  if (!clean) return '';
  const place = parsePlace(text);
  const parts = clean.split(',').map((part) => part.trim()).filter(Boolean);
  const candidates = [place.city, ...parts.slice(1).filter((part) => part && !stateOf(part) && !['usa', 'us', 'united states'].includes(part))];
  // A state that is given must fit: the end's own state for the city names, and also a neighbouring state for near places
  // ("Incline Village, NV" for Tahoe, "Arlington, VA" for DC). A state-only place ("Vancouver") needs its state written.
  const nearStates = [end.state, ...(end.alsoStates || [])];
  let best = '';
  for (const city of candidates) {
    if (!city) continue;
    if (end.names.includes(city) && (!place.state || place.state === end.state)) return 'exact';
    if (end.near.includes(city)) {
      if (place.state && !nearStates.includes(place.state)) continue;
      if (!place.state && (end.stateOnly || []).includes(city)) continue;
      best = 'near';
    }
  }
  return best;
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

// Published-guide examples, with the direction their source data describes.
export function plannableList() {
  return CORRIDORS.map((corridor) => ({
    slug: corridor.slug,
    title: corridor.title,
    highway: corridor.highway,
    from: corridor.from.label,
    to: corridor.to.label,
  }));
}

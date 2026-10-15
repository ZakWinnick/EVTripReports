// Builds the JSON stored in plan_drafts.body and rendered at /plan/<token>.
// Pure and deterministic: no clock, no network, no database.
//
//   node scripts/build-plan.mjs --order order.json --route src/data/routes/<slug>.json --out plan.json
//
// The file this writes is the draft body. Save it with the admin API as format
// "markdown" (the column does not allow "json"). See draftRecord().

import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const UNKNOWN = 'Not yet verified';
export const MPH = 65;
export const MILES_PER_PERCENT = 2.5;
export const RESERVE_PERCENT = 10;

export const ASSUMPTIONS = [
  `Drive time is an estimate at ${MPH} mph from the guide mile marks. It does not include time plugged in.`,
  `Battery percent is an estimate at ${MILES_PER_PERCENT} miles per percent of charge, ${MILES_PER_PERCENT * 100} miles from 100% to 0%. It is not a tested range for this vehicle.`,
  'The battery estimate subtracts miles from the stated start percent. It does not add energy from charging stops.',
  'Clock times add the drive estimate to the departure clock. No time zone is applied.',
  `Hills, wind, temperature, cargo, and any speed other than ${MPH} mph are not in the estimate.`,
];

const TIERS = {
  basic: { id: 'basic', price: '$19', label: 'Route plan' },
  detailed: { id: 'detailed', price: '$39', label: 'Detailed plan' },
  full: { id: 'full', price: '$79', label: 'Multi-day or family' },
};

const TIER_ALIASES = new Map([
  ['19', 'basic'],
  ['$19', 'basic'],
  ['route', 'basic'],
  ['route plan', 'basic'],
  ['39', 'detailed'],
  ['$39', 'detailed'],
  ['detailed', 'detailed'],
  ['detailed plan', 'detailed'],
  ['79', 'full'],
  ['$79', 'full'],
  ['multiday', 'full'],
  ['multi-day', 'full'],
  ['multi-day or family', 'full'],
]);

const BANNED = /\b(fast|slow)\b/i;
const FOOD_RE = /\bfood\b|\brestaurants?\b|\bdining\b|\bmeals?\b|food court|\barby'?s?\b/i;
const RESTROOM_RE = /\brestrooms?\b|\bbathrooms?\b/i;
const OVERNIGHT_RE = /\bovernight\b|\bhotels?\b|\blodging\b|\bmotels?\b/i;
const MAX_NOTES = 3;

export function tierOf(value) {
  const key = String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const id = TIER_ALIASES.get(key);
  if (!id) throw new Error(`Unknown tier "${value}". Use $19, $39, or $79.`);
  return TIERS[id];
}

export function buildPlan(order, route) {
  const input = order && typeof order === 'object' && !Array.isArray(order) ? order : null;
  if (!input) throw new Error('Order must be an object.');
  if (!route || typeof route !== 'object' || Array.isArray(route)) throw new Error('Route data must be an object.');
  if (!Array.isArray(route.stops)) throw new Error('Route data has no stops.');

  const vehicle = cleanCopy(input.vehicle ?? input.car ?? '');
  if (!vehicle) throw new Error('Order needs a vehicle.');
  const slug = String(input.slug ?? input.routeSlug ?? input.route ?? '').trim();
  if (!slug) throw new Error('Order needs a route slug.');
  if (route.slug && route.slug !== slug) throw new Error(`Order slug ${slug} does not match route ${route.slug}.`);

  const tier = tierOf(input.tier ?? input.price);
  const profile = vehicleProfile(input);
  const depart = departValue(input);
  const startBattery = startPercent(input);
  const used = new Set();
  const level = tier.id;

  const chosen = [];
  const skipped = [];
  if (profile.hasPlug) {
    for (const stop of route.stops) {
      const pick = pickStop(stop, route, profile);
      if (!pick) {
        skipped.push({ id: stop?.id || '', name: stop?.name || stop?.id || 'Stop', reason: skipReason(stop, profile) });
        continue;
      }
      chosen.push({ stop, ...pick });
    }
  }

  const milesTotal = routeMiles(route);
  const stops = chosen.map((entry, index) => {
    const next = chosen[index + 1];
    const stop = renderStop(entry, route, {
      level,
      depart,
      startBattery,
      milesTotal,
      nextMile: next ? Number(next.stop.mile) : null,
      used,
    });
    return stop;
  });

  const summary = buildSummary({
    vehicle,
    profile,
    tier,
    route,
    stops,
    depart,
    startBattery,
    order: input,
    milesTotal,
  });

  const tips = [];
  const notes = cleanCopy(input.notes ?? '');
  if (notes) tips.push({ text: `Order note: ${notes}` });
  if (!profile.hasPlug) {
    tips.push({ text: `Port or adapter: ${UNKNOWN}. No charging stops were chosen.` });
  }
  for (const skip of skipped) tips.push({ text: `Skipped ${skip.name}: ${cleanCopy(skip.reason)}` });

  if (level === 'detailed' || level === 'full') {
    for (const line of ASSUMPTIONS) tips.push({ text: `Assumption: ${line}` });
  }
  if (level === 'full') {
    for (const entry of chosen) {
      const primary = entry.primary.primary.name;
      const backup = entry.backup;
      if (backup?.status === 'verified') {
        const tip = {
          text: cleanCopy(`If ${primary} is full or offline, use ${backup.name}.`),
        };
        if (backup.source) tip.source = backup.source;
        if (backup.url) tip.url = backup.url;
        if (backup.checkedOn) tip.checkedOn = backup.checkedOn;
        tips.push(tip);
      } else {
        tips.push({ text: `No verified backup at ${entry.stop.name}. ${UNKNOWN}.` });
      }
      for (const skippedTesla of entry.teslaOnly || []) {
        const tip = { text: cleanCopy(`Skip ${skippedTesla.name} at ${entry.stop.name}: Tesla only.`) };
        if (skippedTesla.source) tip.source = skippedTesla.source;
        if (skippedTesla.url) tip.url = skippedTesla.url;
        if (skippedTesla.checkedOn) tip.checkedOn = skippedTesla.checkedOn;
        if (tip.source) used.add(tip.source);
        tips.push(tip);
      }
    }
    for (const tip of route.tips || []) {
      const text = cleanCopy(tip?.text || '');
      if (!text || BANNED.test(text)) continue;
      const source = tip.source || '';
      const url = httpUrl(tip.url) || httpUrl(route.sources?.[source]?.url);
      const checkedOn = day(tip.checkedOn) || day(route.checked);
      if (!url || !checkedOn) continue;
      if (source) used.add(source);
      tips.push({ text, source, url, checkedOn });
    }
  }

  const stats = planStats(route, used);
  const sources = sourceMap(route, used);
  const plan = {
    title: route.title || slug,
    summary,
    tier: `${tier.label} (${tier.price})`,
    car: vehicle,
    port: profile.port || UNKNOWN,
    stops,
    sources,
  };
  if (route.highway) plan.highway = route.highway;
  const checked = day(route.checked);
  if (checked) plan.checked = checked;
  if (depart) plan.depart = depart;
  const back = cleanCopy(input.returnDate ?? input.return ?? '');
  if (back) plan.returnDate = back;
  if (route.startLabel) plan.startLabel = route.startLabel;
  if (route.endLabel) plan.endLabel = route.endLabel;
  const startNote = cleanCopy(route.startNote || '');
  if (startNote && !BANNED.test(startNote)) plan.startNote = startNote;
  if (stats.length) plan.stats = stats;
  if (level === 'detailed' || level === 'full') plan.assumptions = ASSUMPTIONS.slice();
  if (tips.length) plan.tips = tips;
  if (skipped.length) plan.skipped = skipped;
  return plan;
}

export function draftRecord(plan) {
  const sources = Object.entries(plan?.sources || {}).map(([id, source]) => ({
    label: source.name || id,
    url: source.url,
  }));
  return {
    format: 'markdown',
    body: JSON.stringify(plan),
    sources,
  };
}

export function planSummary(plan) {
  const lines = [plan.tier, plan.summary, `Stops: ${plan.stops.length}`];
  plan.stops.forEach((stop, index) => {
    const backup = stop.backups?.[0];
    const backupText = backup ? ` Backup: ${backup.name}.` : '';
    lines.push(`${index + 1}. ${stop.name}, mile ${stop.mile}. Primary: ${stop.primary?.name}.${backupText}`);
  });
  if (plan.assumptions?.length) lines.push(`Assumptions: ${plan.assumptions.length}`);
  return lines.join('\n');
}

function buildSummary({ vehicle, profile, tier, route, stops, depart, startBattery, order, milesTotal }) {
  const from = cleanCopy(order.start ?? order.startPlace ?? '');
  const to = cleanCopy(order.end ?? order.endPlace ?? '');
  const battery = startBattery == null ? UNKNOWN : `${startBattery}%`;
  const parts = [
    `${tier.label} (${tier.price}) for a ${vehicle}.`,
    route.title ? `${route.title}.` : '',
    `Port: ${profile.port || UNKNOWN}.`,
    `Memberships: ${membershipText(order.memberships)}.`,
    `Start battery: ${battery}.`,
    departSentence(depart),
  ].filter(Boolean);
  if (from && to) parts.push(`${from} to ${to}.`);
  const passengers = cleanCopy(order.passengers ?? '');
  if (passengers) parts.push(`Passengers: ${passengers}.`);
  const where = route.highway ? ` on ${route.highway}` : '';
  const distance = milesTotal == null ? '' : `, ${milesTotal} miles`;
  parts.push(`${stops.length} verified stops${where}${distance}.`);
  return cleanCopy(parts.join(' '));
}

function renderStop(entry, route, ctx) {
  const { stop, primary, backup, alternatives, guidePrimaryUsed, amenityStations } = entry;
  const sheet = primary.primary;
  commitSources(sheet, ctx.used);
  if (backup?.source) ctx.used.add(backup.source);
  const out = {
    id: stop.id,
    name: stop.name,
    mile: Number(stop.mile),
    why: whyFor(stop, sheet, guidePrimaryUsed),
    primary: sheet,
    backups: [backup || unverifiedBackup()],
  };
  if (stop.towns) out.towns = stop.towns;
  if (stop.milepostNote) out.milepostNote = stop.milepostNote;

  if (ctx.level === 'detailed' || ctx.level === 'full') {
    const timing = timingFacts(out.mile, ctx);
    out.primary = { ...sheet, target: timing.leave, facts: [...(sheet.facts || []), timing.arrival, timing.drive] };
    const notes = amenityNotes(stop, amenityStations, route);
    const food = take(notes, 'food');
    const hotels = take(notes, 'overnight');
    const restrooms = take(notes, 'restroom');
    if (food.length) out.food = food.map((note) => noteItem('Food', note, route, ctx.used));
    if (hotels.length) out.hotels = hotels.map((note) => noteItem('Overnight', note, route, ctx.used));
    if (restrooms.length) {
      out.primary.facts = [...(out.primary.facts || []), ...restrooms.map((note) => restroomFact(note, route, ctx.used))];
    }
  }

  if (ctx.level === 'full' && alternatives.length) {
    out.other = alternatives;
    for (const site of alternatives) if (site.source) ctx.used.add(site.source);
  }
  return out;
}

function pickStop(stop, route, profile) {
  if (!stop || !Number.isFinite(Number(stop.mile))) return null;
  const pool = [];
  if (stop.primary) pool.push({ station: stop.primary, role: 'guide' });
  for (const station of stop.backups || []) pool.push({ station, role: 'listed' });
  for (const station of stop.other || []) pool.push({ station, role: 'listed' });

  const ready = [];
  const teslaOnly = [];
  for (const item of pool) {
    const built = item.role === 'guide' ? tryGuidePrimary(item.station, route, profile) : tryListed(item.station, route, profile);
    if (built) {
      ready.push({ ...built, station: item.station, role: item.role });
      continue;
    }
    const skippedTesla = teslaOnlyNote(item.station, route, profile);
    if (skippedTesla) teslaOnly.push(skippedTesla);
  }
  if (!ready.length) return null;
  const [first, second, ...rest] = ready;
  return {
    primary: first,
    backup: second ? second.backup : null,
    alternatives: rest.map((item) => item.backup),
    guidePrimaryUsed: first.role === 'guide',
    amenityStations: [first.station, ...(second ? [second.station] : [])],
    teslaOnly,
  };
}

function tryGuidePrimary(station, route, profile) {
  if (!station || typeof station !== 'object') return null;
  if (!usable(station, profile)) return null;
  const stalls = presentFact(station.stalls, station, route);
  const power = presentFact(station.power, station, route);
  const access = presentFact(station.access, station, route);
  if (!measuredOk(stalls) || !measuredOk(power) || !measuredOk(access)) return null;
  const primary = toPrimary(station, route, { stalls, power, access });
  return { primary, backup: toBackup(station, primary) };
}

function tryListed(station, route, profile) {
  if (!station || station.status !== 'verified') return null;
  if (!usable(station, profile)) return null;
  if (station.stalls && station.power && station.access) {
    return tryGuidePrimary(station, route, profile);
  }
  const parsed = structuredFromFacts(station.facts);
  const url = httpUrl(station.url) || httpUrl(route.sources?.[station.source]?.url);
  const checkedOn = day(station.checkedOn) || day(route.checked);
  const accessValue = accessSentence(station);
  if (!parsed || !url || !checkedOn || !accessValue) return null;
  const flag = teslaFlag(station);
  if (isTeslaSite(station) && !flag) return null;
  const source = station.source || '';
  const stalls = { value: parsed.stalls, status: 'verified', url, checkedOn };
  const power = { value: parsed.power, status: 'verified', url, checkedOn };
  const access = { value: accessValue, status: 'verified', url, checkedOn };
  if (source) {
    stalls.source = source;
    power.source = source;
    if (accessValue) access.source = source;
  }
  const primary = toPrimary(station, route, { stalls, power, access, listedFacts: String(station.facts).trim() });
  return { primary, backup: toBackup(station, primary) };
}

function toPrimary(station, route, parts) {
  const primary = {
    name: station.name || 'Stop',
    network: sourcedText(station.network, station, route, parts.stalls),
    address: sourcedText(station.address, station, route, parts.stalls),
    exit: sourcedText(station.exit, station, route, parts.stalls),
    stalls: parts.stalls,
    power: parts.power,
    access: parts.access,
    price: presentFact(station.price, station, route),
  };
  const flag = teslaFlag(station);
  if (flag) primary.teslaAccess = flag;
  const checkedOn = day(station.checkedOn) || parts.stalls.checkedOn;
  if (checkedOn) primary.checkedOn = checkedOn;
  for (const key of ['hours', 'connectors', 'plugs']) {
    if (station[key] == null || station[key] === '') continue;
    primary[key] = typeof station[key] === 'object' ? presentFact(station[key], station, route) : String(station[key]);
  }
  if (parts.listedFacts) {
    primary.facts = [{
      label: 'Locator facts',
      value: parts.listedFacts,
      status: 'verified',
      url: parts.stalls.url,
      checkedOn: parts.stalls.checkedOn,
      ...(parts.stalls.source ? { source: parts.stalls.source } : {}),
    }];
  }
  return primary;
}

function toBackup(station, primary) {
  const backup = {
    name: station.name || primary.name,
    facts: factsLine(station, primary),
    status: 'verified',
  };
  const network = typeof station.network === 'string' ? station.network : primary.network?.value;
  const address = typeof station.address === 'string' ? station.address : primary.address?.value;
  if (network && network !== UNKNOWN) backup.network = network;
  if (address && address !== UNKNOWN) backup.address = address;
  const access = primary.access?.value;
  if (access && access !== UNKNOWN) backup.access = access;
  if (primary.teslaAccess) backup.teslaAccess = primary.teslaAccess;
  if (primary.stalls?.url) backup.url = primary.stalls.url;
  if (primary.stalls?.source) backup.source = primary.stalls.source;
  if (primary.stalls?.checkedOn) backup.checkedOn = primary.stalls.checkedOn;
  return backup;
}

function unverifiedBackup() {
  return { name: 'Backup', facts: UNKNOWN, status: 'unverified' };
}

function factsLine(station, primary) {
  if (typeof station.facts === 'string' && station.facts.trim() && !BANNED.test(station.facts)) return station.facts.trim();
  const stalls = primary.stalls?.value;
  const power = primary.power?.value;
  if (stalls && stalls !== UNKNOWN && power && power !== UNKNOWN) {
    const left = /\bstalls?\b|\bchargers?\b/i.test(stalls) ? stalls : `${stalls} stalls`;
    return `${left}. ${String(power).replace(/\.$/, '')}.`;
  }
  return UNKNOWN;
}

function whyFor(stop, primary, guidePrimaryUsed) {
  if (guidePrimaryUsed) {
    const kept = cleanCopy(stop.why || '');
    if (kept && !BANNED.test(kept)) return kept;
  } else if (stop.primary?.name) {
    const flag = teslaFlag(stop.primary);
    if (flag === 'tesla-only') return cleanCopy(`Guide primary ${stop.primary.name} is Tesla only. This plan uses ${primary.name}.`);
    if (flag === 'open') return cleanCopy(`Guide primary ${stop.primary.name} needs a NACS adapter this order does not list. This plan uses ${primary.name}.`);
    return cleanCopy(`Guide primary ${stop.primary.name} is not verified for this car. This plan uses ${primary.name}.`);
  }
  const stalls = primary.stalls?.value;
  const power = primary.power?.value;
  const left = stalls && /\bstalls?\b|\bchargers?\b/i.test(String(stalls)) ? stalls : `${stalls} stalls`;
  return cleanCopy(`${primary.name}: ${left}, ${String(power).replace(/\.$/, '')}.`);
}

function timingFacts(mile, ctx) {
  const drive = driveEstimate(mile, ctx.depart);
  const arrival = arrivalEstimate(mile, ctx.startBattery);
  const gap = ctx.nextMile == null ? (ctx.milesTotal == null ? null : ctx.milesTotal - mile) : ctx.nextMile - mile;
  const leaveValue = leaveEstimate(gap, ctx.startBattery != null);
  return {
    leave: { value: leaveValue, note: 'Estimate. Assumptions are listed on this plan.' },
    arrival: { label: 'Arrival battery', value: arrival, note: 'Estimate. Assumptions are listed on this plan.' },
    drive: { label: 'Drive time', value: drive, note: 'Estimate. Assumptions are listed on this plan.' },
  };
}

function driveEstimate(mile, depart) {
  const minutes = Math.round((mile / MPH) * 60);
  const clock = depart ? addClock(depart, minutes) : null;
  if (clock) return `Estimate: ${minutes} minutes from the start at ${MPH} mph, arriving about ${clock}.`;
  if (!depart) return `Estimate: ${minutes} minutes from the start at ${MPH} mph. Departure clock time: ${UNKNOWN}.`;
  if (!/T\d{2}:\d{2}|\s\d{2}:\d{2}/.test(depart)) {
    return `Estimate: ${minutes} minutes from the start at ${MPH} mph. Departure clock time: ${UNKNOWN}.`;
  }
  return `Estimate: ${minutes} minutes from the start at ${MPH} mph.`;
}

function arrivalEstimate(mile, startBattery) {
  if (startBattery == null) return UNKNOWN;
  const left = startBattery - mile / MILES_PER_PERCENT;
  if (left < 0) return `Estimate: the assumed range runs out before this stop, ${Math.round(mile)} miles from the start.`;
  return `Estimate: about ${Math.round(left)}% on arrival, before charging.`;
}

function leaveEstimate(gap, startKnown) {
  if (!startKnown || gap == null || !Number.isFinite(gap) || gap < 0) return UNKNOWN;
  const pct = Math.ceil(gap / MILES_PER_PERCENT + RESERVE_PERCENT);
  if (pct > 100) {
    return `Estimate: the next ${Math.round(gap)} miles is past the assumed range even from 100%, plus a ${RESERVE_PERCENT}% buffer.`;
  }
  return `Estimate: leave with at least ${pct}% for the next ${Math.round(gap)} miles, plus a ${RESERVE_PERCENT}% buffer.`;
}

function addClock(depart, minutes) {
  const match = String(depart).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!match) return null;
  const start = Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5]);
  const end = new Date(start + minutes * 60 * 1000);
  const hh = String(end.getUTCHours()).padStart(2, '0');
  const mm = String(end.getUTCMinutes()).padStart(2, '0');
  const startDay = Date.UTC(+match[1], +match[2] - 1, +match[3]);
  const endDay = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  return `${hh}:${mm}${endDay === startDay ? '' : ' the next day'}`;
}

function amenityNotes(stop, stations, route) {
  const notes = [];
  const seen = new Set();
  const push = (text, url, source, checkedOn, kind) => {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!clean || BANNED.test(clean)) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    const link = httpUrl(url) || httpUrl(route.sources?.[source]?.url);
    const date = day(checkedOn) || day(route.checked);
    if (!link || !date) return;
    const category = noteCategory(clean);
    if (!category) return;
    seen.add(key);
    notes.push({ text: clean, url: link, source: source || '', checkedOn: date, kind, category });
  };
  for (const item of stop.around || []) push(item?.text || item?.value, item?.url, item?.source, item?.checkedOn || item?.date, 'route');
  for (const item of stop.reports || []) push(item?.text, item?.url, item?.source, item?.date, 'route');
  for (const station of stations || []) {
    for (const item of station?.driverReports || []) push(item?.summary, item?.url, item?.source, item?.date, 'driver');
  }
  return notes;
}

function noteCategory(text) {
  if (OVERNIGHT_RE.test(text)) return 'overnight';
  if (FOOD_RE.test(text)) return 'food';
  if (RESTROOM_RE.test(text)) return 'restroom';
  return '';
}

function take(notes, category) {
  return notes.filter((note) => note.category === category).slice(0, MAX_NOTES);
}

function noteItem(name, note, route, used) {
  if (note.source) used.add(note.source);
  const item = {
    name,
    text: note.text,
    url: note.url,
    checkedOn: note.checkedOn,
    note: note.kind === 'driver' ? 'Driver report. Not a network fact.' : 'Route note. Not a network fact.',
  };
  if (note.source) item.source = note.source;
  const label = route.sources?.[note.source]?.name;
  if (label) item.sourceName = label;
  return item;
}

function restroomFact(note, route, used) {
  const item = noteItem('Restroom', note, route, used);
  return {
    label: 'Restroom',
    value: item.text,
    url: item.url,
    checkedOn: item.checkedOn,
    note: item.note,
    ...(item.source ? { source: item.source } : {}),
    ...(item.sourceName ? { sourceName: item.sourceName } : {}),
  };
}

function presentFact(fact, station, route) {
  if (!fact || typeof fact !== 'object' || Array.isArray(fact)) return { value: UNKNOWN, status: 'unverified' };
  const value = String(fact.value ?? '').trim();
  const status = fact.status || '';
  if (!value || !status) return { value: UNKNOWN, status: 'unverified' };
  const source = String(fact.source || station.source || '').trim();
  const checkedOn = day(fact.checkedOn) || day(station.checkedOn) || day(route.checked);
  const url = httpUrl(fact.url) || siblingUrl(station, source) || httpUrl(route.sources?.[source]?.url) || '';
  if (!url || !checkedOn) return { value: UNKNOWN, status: 'unverified' };
  const out = { value, status, url, checkedOn };
  if (source) out.source = source;
  if (fact.note) out.note = cleanCopy(fact.note);
  const also = copyAlso(fact);
  if (also) out.also = also;
  return out;
}

function sourcedText(value, station, route, stalls) {
  const shown = String(value ?? '').trim();
  if (!shown || shown === UNKNOWN) return UNKNOWN;
  const source = station.source || stalls?.source || station.stalls?.source || '';
  const url = httpUrl(station.url) || httpUrl(stalls?.url) || httpUrl(station.stalls?.url) || httpUrl(route.sources?.[source]?.url) || '';
  const checkedOn = day(station.checkedOn) || stalls?.checkedOn || day(route.checked);
  if (!url || !checkedOn) return UNKNOWN;
  const out = { value: shown, status: 'verified', url, checkedOn };
  if (source) out.source = source;
  return out;
}

function siblingUrl(station, source) {
  if (!source) return '';
  for (const key of ['stalls', 'power', 'access', 'price']) {
    const fact = station?.[key];
    if (fact?.source === source) {
      const url = httpUrl(fact.url);
      if (url) return url;
    }
  }
  if (station?.source === source) return httpUrl(station.url);
  return '';
}

function measuredOk(fact) {
  return Boolean(fact && fact.status === 'verified' && fact.value !== UNKNOWN && fact.url && fact.checkedOn);
}

function accessSentence(station) {
  if (typeof station.access === 'string' && station.access.trim() && station.access.trim() !== UNKNOWN) {
    return station.access.trim();
  }
  if (station.access && typeof station.access === 'object') {
    const value = String(station.access.value || '').trim();
    if (value && value !== UNKNOWN) return value;
  }
  const parts = String(station.facts || '').split(/(?<=\.)\s+/);
  const hit = parts.find((part) => /tesla only|open to|does not say other evs/i.test(part));
  return hit ? hit.replace(/\.$/, '').trim() : '';
}

function structuredFromFacts(facts) {
  const text = String(facts ?? '');
  if (!text.trim() || BANNED.test(text)) return null;
  const stalls = text.match(/(\d+)\s+stalls?\b/i) || text.match(/(\d+)\s+chargers?\b/i);
  const upTo = text.match(/up to\s+(\d+)\s*kW/i);
  const kw = text.match(/(\d+)\s*kW/i);
  if (!stalls || !kw) return null;
  return { stalls: stalls[1], power: upTo ? `Up to ${upTo[1]} kW` : `${kw[1]} kW` };
}

function commitSources(primary, used) {
  for (const key of ['network', 'address', 'exit', 'stalls', 'power', 'access', 'price', 'hours', 'connectors', 'plugs']) {
    const fact = primary?.[key];
    if (fact && typeof fact === 'object' && fact.source) used.add(fact.source);
  }
  for (const fact of primary?.facts || []) if (fact?.source) used.add(fact.source);
}

function planStats(route, used) {
  const stats = [];
  for (const stat of route.stats || []) {
    if (!stat || typeof stat !== 'object') continue;
    const label = String(stat.label ?? '');
    const value = String(stat.value ?? '');
    const note = stat.note ? String(stat.note) : '';
    if (BANNED.test(label) || BANNED.test(value) || BANNED.test(note)) continue;
    const source = stat.source || '';
    const url = httpUrl(stat.url) || httpUrl(route.sources?.[source]?.url);
    const checkedOn = day(stat.checkedOn) || day(route.checked);
    if (!url || !checkedOn || !source) continue;
    if (!Number.isFinite(Number(value.replace(/,/g, '')))) continue;
    const out = { label, value, source, url, checkedOn };
    if (stat.unit) out.unit = String(stat.unit);
    if (note) out.note = note;
    used.add(source);
    stats.push(out);
  }
  return stats;
}

function sourceMap(route, used) {
  const out = {};
  for (const [id, source] of Object.entries(route.sources || {})) {
    if (!used.has(id)) continue;
    const url = httpUrl(source?.url);
    if (!url) continue;
    out[id] = { name: source.name || id, url };
  }
  return out;
}

function vehicleProfile(order) {
  const port = cleanCopy(order.adapter ?? order.port ?? '');
  const car = cleanCopy(order.vehicle ?? order.car ?? '');
  const portNorm = port.toLowerCase();
  const carNorm = car.toLowerCase();
  const unsure = portNorm === 'not sure' || portNorm === 'unsure' || portNorm === 'unknown';
  const nativeNacs = !unsure && (/\bnacs port\b/.test(portNorm) || /tesla-style/.test(portNorm) || portNorm === 'nacs' || /\btesla\b/.test(carNorm) || /\bmodel [3ysx]\b/.test(carNorm));
  const nativeCcs = !unsure && /\bccs\b/.test(portNorm);
  const noAdapter = /\bno adapter\b/.test(portNorm) || /\bwithout an adapter\b/.test(portNorm) || /\bno nacs adapter\b/.test(portNorm);
  const nacsAdapter = !unsure && !noAdapter && /\bnacs adapter\b/.test(portNorm);
  const ccsAdapter = !unsure && !noAdapter && /\bccs adapter\b/.test(portNorm);
  const hasPlug = Boolean(nativeNacs || nativeCcs || nacsAdapter || ccsAdapter);
  return { port: unsure ? '' : port, car, nativeNacs, nativeCcs, nacsAdapter, ccsAdapter, hasPlug };
}

function usable(station, profile) {
  if (!profile.hasPlug) return false;
  const flag = teslaFlag(station);
  if (flag === 'tesla-only') return profile.nativeNacs;
  if (flag === 'open') return profile.nativeNacs || profile.nacsAdapter;
  if (isTeslaSite(station)) return false;
  const text = stationText(station);
  const needsNacs = /nacs adapter/i.test(text);
  const mentionsCcs = /\bccs\b|j1772/i.test(text);
  const openAll = /open to all\b|open to non-/i.test(text);
  if (needsNacs && !mentionsCcs) return profile.nativeNacs || profile.nacsAdapter;
  if (mentionsCcs) return profile.nativeCcs || profile.ccsAdapter;
  if (openAll) return profile.nativeCcs || profile.nativeNacs || profile.ccsAdapter || profile.nacsAdapter;
  return false;
}

function teslaOnlyNote(station, route, profile) {
  if (teslaFlag(station) !== 'tesla-only') return null;
  if (profile.nativeNacs) return null;
  const url = httpUrl(station.url) || httpUrl(station.stalls?.url) || httpUrl(route.sources?.[station.source || station.stalls?.source]?.url);
  const checkedOn = day(station.checkedOn) || day(station.stalls?.checkedOn) || day(route.checked);
  if (!station.name || !url || !checkedOn) return null;
  return {
    name: station.name,
    source: station.source || station.stalls?.source || '',
    url,
    checkedOn,
  };
}

function teslaFlag(station) {
  if (station?.teslaAccess === 'tesla-only' || station?.teslaAccess === 'open') return station.teslaAccess;
  if (!isTeslaSite(station)) return null;
  const text = stationText(station);
  const open = /open to all evs|open to non-tesla|open to other evs|open to all\b/i.test(text);
  const only = /tesla only|does not say other evs/i.test(text);
  if (only && !open) return 'tesla-only';
  if (open) return 'open';
  return null;
}

function isTeslaSite(station) {
  return /tesla|supercharger/i.test(stationText(station));
}

function stationText(station) {
  return [station?.network, station?.name, station?.access?.value || station?.access, station?.facts]
    .filter((part) => typeof part === 'string')
    .join(' ');
}

function skipReason(stop, profile) {
  const primary = stop?.primary;
  if (!primary) return 'No primary in the route data.';
  const flag = teslaFlag(primary);
  if (flag === 'tesla-only' && !profile.nativeNacs) return `Guide primary ${primary.name} is Tesla only.`;
  if (flag === 'open' && !(profile.nativeNacs || profile.nacsAdapter)) {
    return `Guide primary ${primary.name} is open to other EVs with a NACS adapter. This order does not list one.`;
  }
  if (isTeslaSite(primary) && !flag) return `Guide primary ${primary.name} has no Tesla only or open to all EVs flag.`;
  if (primary.stalls?.status !== 'verified') return `Guide primary ${primary.name} stalls are ${primary.stalls?.status || 'missing'}.`;
  if (primary.power?.status !== 'verified') return `Guide primary ${primary.name} power is ${primary.power?.status || 'missing'}.`;
  if (primary.access?.status !== 'verified') return `Guide primary ${primary.name} access is ${primary.access?.status || 'missing'}.`;
  return 'No verified station this car can use.';
}

function membershipText(value) {
  if (value == null) return UNKNOWN;
  const raw = Array.isArray(value) ? value : String(value).split(/[;,]/);
  const items = raw.map((item) => cleanCopy(item)).filter((item) => item && !/^none( listed)?$/i.test(item));
  if (!items.length) return 'none listed';
  return items.join(', ');
}

function startPercent(order) {
  const raw = order.startBattery ?? order.start_battery ?? order.battery;
  if (raw == null || raw === '') return null;
  const n = Number(String(raw).replace('%', '').trim());
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error('Start battery must be a percent from 0 to 100.');
  return Math.round(n);
}

function departValue(order) {
  return cleanCopy(order.depart ?? order.departure ?? order.departureTime ?? '');
}

function departSentence(depart) {
  if (!depart) return `Departure: ${UNKNOWN}.`;
  const match = depart.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/);
  if (!match) return `Departure: ${depart}.`;
  if (match[2]) return `Leaving ${match[1]} at ${match[2]}.`;
  return `Leaving ${match[1]}. Departure clock time: ${UNKNOWN}.`;
}

function routeMiles(route) {
  const stats = Array.isArray(route.stats) ? route.stats : [];
  const hit = stats.find((stat) => String(stat?.unit || '').toLowerCase() === 'mi' && Number.isFinite(Number(stat.value)));
  return hit ? Number(hit.value) : null;
}

function copyAlso(fact) {
  if (!Array.isArray(fact.also)) return null;
  const also = [];
  for (const extra of fact.also) {
    const url = httpUrl(extra?.url);
    if (!url) continue;
    also.push({ url, name: extra.name || extra.sourceName || 'Source', ...(extra.source ? { source: extra.source } : {}) });
  }
  return also.length ? also : null;
}

function day(value) {
  const match = String(value ?? '').trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}

function httpUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString();
  } catch {
    return '';
  }
}

function cleanCopy(value) {
  return String(value ?? '')
    .replace(/\u2014/g, ', ')
    .replace(/\u2013/g, ', ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+,/g, ',')
    .replace(/,{2,}/g, ',')
    .trim();
}

function parseArgs(argv) {
  const out = { order: '', route: '', out: '', help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--order') out.order = argv[++i] || '';
    else if (arg === '--route') out.route = argv[++i] || '';
    else if (arg === '--out') out.out = argv[++i] || '';
    else if (arg === '--help' || arg === '-h') out.help = true;
    else positional.push(arg);
  }
  if (!out.order && positional[0]) out.order = positional[0];
  if (!out.route && positional[1]) out.route = positional[1];
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.order || !args.route) {
    console.error('Usage: node scripts/build-plan.mjs --order order.json --route src/data/routes/<slug>.json [--out plan.json]');
    process.exit(args.help ? 0 : 1);
  }
  const order = JSON.parse(await readFile(args.order, 'utf8'));
  const route = JSON.parse(await readFile(args.route, 'utf8'));
  const json = `${JSON.stringify(buildPlan(order, route), null, 2)}\n`;
  if (args.out) {
    await mkdir(path.dirname(path.resolve(args.out)), { recursive: true });
    await writeFile(args.out, json);
    return;
  }
  process.stdout.write(json);
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exit(1);
  });
}

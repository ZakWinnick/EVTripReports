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
export const RANGE_MILES = MILES_PER_PERCENT * 100;
export const RESERVE_PERCENT = 10;
export const TARGET_ARRIVAL = 15;
export const CHARGE_LIMIT = 90;
export const PACK_KWH = 75;
export const CURVE_TO_80 = 0.7;
export const CURVE_ABOVE_80 = 0.35;
export const TAPER_AT = 80;
const ESTIMATE_NOTE = 'Estimate. Assumptions are listed on this plan.';

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

const HOST_NAMES = {
  'x.com': 'X',
  'twitter.com': 'X',
  'tesla.com': 'Tesla',
  'electrifyamerica.com': 'Electrify America',
  'evgo.com': 'EVgo',
  'wikipedia.org': 'Wikipedia',
  'plugshare.com': 'PlugShare',
  'rivian.com': 'Rivian',
  'leasehackr.com': 'Leasehackr',
  'f150lightningforum.com': 'F150 Lightning Forum',
  'cybertruckownersclub.com': 'Cybertruck Owners Club',
  'afdc.energy.gov': 'DOE Alternative Fuels Data Center',
  'router.project-osrm.org': 'OpenStreetMap OSRM',
};

const BANNED = /\b(fast|slow)\b/i;
const FOOD_RE = /\bfood\b|\brestaurants?\b|\bdining\b|\bmeals?\b|food court|\barby'?s?\b/i;
const RESTROOM_RE = /\brestrooms?\b|\bbathrooms?\b/i;
const OVERNIGHT_RE = /\bovernight\b|\bhotels?\b|\blodging\b|\bmotels?\b/i;
const PET_RE = /\b(dogs?|pets?)\b/i;
const CAUTION_RE = /\b(throttl\w*|offline|broken|out of service|queued|heat|warning|fault|derat\w*)\b|\bpoor restrooms?\b|\bhad been offline\b|\bnon-teslas?\b/i;
const SECTION_TITLES = new Set(['food', 'restroom', 'restrooms', 'overnight', 'lodging', 'cautions', 'caution', 'notes', 'note', 'backup', 'backups']);
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
  const zone = resolveTimeZone(input, route);
  const depart = normalizeDepart(departValue(input), zone);
  const startBattery = startPercent(input);
  const energy = vehicleEnergy(input);
  const chargeLimit = chargeLimitOf(input);
  const origin = originLeg(input, route);
  const milesTotal = routeMiles(route);
  const level = tier.id;
  const ctx = {
    used: new Set(),
    urls: new Map(),
    route,
    level,
    depart,
    startBattery,
    energy,
    chargeLimit,
    chargeLimitIsDefault: chargeLimitIsDefault(input),
    origin,
    milesTotal,
    zone,
    profile,
    order: input,
  };
  if (origin?.source) {
    ctx.used.add(origin.source);
    if (origin.url) ctx.urls.set(origin.source, origin.url);
  }

  const chosen = [];
  const skipped = [];
  if (profile.hasPlug) {
    for (const stop of route.stops) {
      const pick = pickStop(stop, route, profile);
      if (!pick) {
        skipped.push({ id: stop?.id || '', name: cleanCopy(stop?.name || stop?.id || 'Stop'), reason: skipReason(stop, profile) });
        continue;
      }
      chosen.push(pick);
    }
  }

  const prepared = chosen.map((entry) => prepareStop(entry, ctx));

  const tips = [];
  const notes = cleanCopy(input.notes ?? '');
  if (notes) tips.push({ text: `Order note: ${notes}` });
  if (chosen.length) tips.push({ text: amenityHonesty(chosen, route, input) });
  if (level === 'basic') tips.push({ text: estimatedLine(mileageAssumption(input, route, origin)) });
  if (!profile.hasPlug) tips.push({ text: `Port or adapter: ${UNKNOWN}. No charging stops were chosen.` });
  for (const skip of skipped) tips.push({ text: `Skipped ${skip.name}: ${cleanCopy(skip.reason)}` });
  const teslaSkips = [];
  for (const entry of chosen) {
    for (const skippedTesla of entry.teslaOnly || []) teslaSkips.push(skippedTesla);
  }
  const teslaTip = teslaOnlyTip(teslaSkips, route, ctx);
  if (teslaTip) tips.push(teslaTip);
  const direction = tripDirection(input, route);
  if (level === 'full') {
    for (const tip of route.tips || []) {
      let text = cleanCopy(tip?.text || '');
      if (!text || BANNED.test(text) || isBlanketClaim(text)) continue;
      if (/tesla-only sites/i.test(text) && teslaSkips.length) continue;
      text = applyDirection(text, direction);
      const source = tip.source || '';
      const url = httpUrl(tip.url) || httpUrl(route.sources?.[source]?.url);
      const checkedOn = day(tip.checkedOn) || day(route.checked);
      if (!url || !checkedOn) continue;
      if (source) {
        ctx.used.add(source);
        ctx.urls.set(source, url);
      }
      tips.push({ text, source, url, checkedOn });
    }
    const counted = eaProblemTip(route, ctx);
    if (counted) tips.push(counted);
  }

  const strategy = level === 'basic' ? null : buildStrategy(prepared, ctx);
  ctx.prepared = prepared;
  const stops = prepared.map((entry) => renderStop(entry, strategy, ctx));
  const contingency = level === 'full' ? buildContingency(stops, strategy, ctx) : null;
  const assumptions = level === 'basic' ? null : buildAssumptions(input, route, origin, energy, zone, ctx);
  const stats = planStats(route, ctx);
  const sources = sourceMap(route, ctx);

  const plan = {
    title: cleanCopy(route.title || slug),
    summary: '',
    tier: `${tier.label} (${tier.price})`,
    car: vehicle,
    port: profile.port || UNKNOWN,
    stops,
    sources,
  };
  if (route.highway) plan.highway = cleanCopy(route.highway);
  const checked = day(route.checked);
  if (checked) plan.checked = checked;
  if (depart.iso) plan.depart = depart.iso;
  if (zone) plan.timeZone = zone;
  const back = cleanCopy(input.returnDate ?? input.return ?? '');
  if (back) plan.returnDate = back;
  if (route.startLabel) plan.startLabel = cleanCopy(route.startLabel);
  if (route.endLabel) plan.endLabel = cleanCopy(route.endLabel);
  const startNote = cleanCopy(route.startNote || '');
  if (startNote && !BANNED.test(startNote)) plan.startNote = startNote;
  if (origin) {
    plan.originLeg = {
      miles: origin.miles,
      from: origin.from,
      to: origin.to,
      url: origin.url,
      checkedOn: origin.checkedOn,
      ...(origin.estimate ? { estimate: true } : { status: 'verified' }),
      ...(origin.source ? { source: origin.source } : {}),
      ...(origin.note ? { note: origin.note } : {}),
    };
  }
  if (stats.length) plan.stats = stats;
  if (assumptions) plan.assumptions = assumptions;
  if (strategy) plan.strategy = strategy.public;
  if (contingency?.length) plan.contingency = contingency;
  if (tips.length) plan.tips = tips;
  if (skipped.length) plan.skipped = skipped;

  stampSources(plan, sources);
  const range = dateRange(plan);
  if (range) plan.dataChecked = range;
  plan.summary = buildSummary({
    vehicle,
    profile,
    tier,
    route,
    stops,
    depart,
    startBattery,
    order: input,
    milesTotal,
    origin,
    strategy,
    dataChecked: range,
  });
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
  if (plan.dataChecked) lines.push(`Data checked: ${plan.dataChecked}`);
  if (plan.timeZone) lines.push(`Time zone: ${plan.timeZone}`);
  plan.stops.forEach((stop, index) => {
    const backup = stop.backups?.[0];
    const role = stop.charging === true ? ' Charge here.' : stop.charging === false ? ' Optional.' : '';
    const backupText = backup ? ` Backup: ${backup.name}.` : stop.note ? ` ${stop.note}` : '';
    lines.push(`${index + 1}. ${stop.name}, mile ${stop.mile}.${role} Primary: ${stop.primary?.name}.${backupText}`);
  });
  if (plan.assumptions?.length) lines.push(`Assumptions: ${plan.assumptions.length}`);
  if (plan.contingency?.length) lines.push(`Contingency: ${plan.contingency.map((item) => item.title).join(', ')}`);
  return lines.join('\n');
}

export function planMarkdown(plan) {
  const lines = [`# ${plan.title || 'Plan'}`, '', plan.summary || '', ''];
  if (plan.strategy?.text && !(plan.summary || '').includes(plan.strategy.text)) lines.push(plan.strategy.text, '');
  if (plan.dataChecked) lines.push(`Data checked: ${plan.dataChecked}`, '');
  if (plan.assumptions?.length) {
    lines.push('## Estimate assumptions');
    for (const line of plan.assumptions) lines.push(`- ${line}`);
    lines.push('');
  }
  for (const stop of plan.stops || []) {
    const role = stop.charging === true ? ', charge here' : stop.charging === false ? ', optional' : '';
    lines.push(`## ${stop.name} (mile ${stop.mile}${role})`);
    if (stop.headline === false) lines.push('Flagged: not a fully verified headline stop.');
    if (stop.why) lines.push(stop.why);
    const primary = stop.primary || {};
    lines.push(`Primary: ${primary.name || ''}${primary.teslaAccess ? ` (Tesla flag: ${primary.teslaAccess})` : ''}`);
    lines.push(...primaryFieldLines(primary));
    if (primary.target?.value) lines.push(`- target: ${primary.target.value}`);
    for (const fact of primary.facts || []) lines.push(`- ${fact.label}: ${fact.value}${/^Driver report/.test(fact.note || '') ? ' (Driver report, not a network fact.)' : ''}`);
    if (stop.backups?.length) {
      lines.push('Backups:');
      for (const backup of stop.backups) lines.push(`- ${backup.name}: ${backup.facts || ''}`);
    } else if (stop.note) lines.push(stop.note);
    const cautionGroups = [
      ['Cautions, primary', stop.primaryCautions],
      ['Cautions, backup', stop.backupCautions],
      ['Cautions, other', stop.otherCautions],
    ];
    if (cautionGroups.some(([, items]) => items?.length)) {
      for (const [label, items] of cautionGroups) {
        if (!items?.length) continue;
        lines.push(`${label}:`);
        for (const item of items) lines.push(`- ${item.name}: ${item.text}`);
      }
    } else if (stop.cautions?.length) {
      lines.push('Cautions:');
      for (const item of stop.cautions) lines.push(`- ${item.name}: ${item.text}`);
    }
    if (stop.food?.length) {
      lines.push('Food:');
      for (const item of stop.food) lines.push(`- ${item.name}: ${item.text}`);
    }
    if (stop.hotels?.length) {
      lines.push('Lodging:');
      for (const item of stop.hotels) lines.push(`- ${item.name}: ${item.text}`);
    }
    if (stop.other?.length) {
      lines.push('Alternatives:');
      for (const item of stop.other) lines.push(`- ${item.name}`);
    }
    lines.push('');
  }
  if (plan.contingency?.length) {
    lines.push('## Contingency');
    for (const item of plan.contingency) lines.push(`- ${item.title}: ${item.text}`);
    lines.push('');
  }
  if (plan.tips?.length) {
    lines.push('## Notes');
    for (const tip of plan.tips) lines.push(`- ${tip.text}`);
    lines.push('');
  }
  if (plan.sources) {
    lines.push('## Sources');
    for (const source of Object.values(plan.sources)) lines.push(`- ${source.name}: ${source.url}`);
  }
  return lines.join('\n');
}

function fieldText(field) {
  if (field == null) return '';
  if (typeof field === 'string') return field;
  return field.value || '';
}

function joinLabels(names) {
  const shown = names.map((name, index) => (index === 0 ? name.charAt(0).toUpperCase() + name.slice(1) : name));
  if (shown.length <= 1) return shown[0] || '';
  if (shown.length === 2) return `${shown[0]} and ${shown[1]}`;
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

function primaryFieldLines(primary) {
  const keys = ['network', 'address', 'exit', 'stalls', 'power', 'access', 'price'];
  const rows = keys.map((key) => ({ key, text: fieldText(primary[key]) })).filter((row) => row.text);
  const unknown = rows.filter((row) => row.text === UNKNOWN);
  if (unknown.length < 2) return rows.map((row) => `- ${row.key}: ${row.text}`);
  const lines = [];
  let used = false;
  for (const row of rows) {
    if (row.text === UNKNOWN) {
      if (!used) {
        lines.push(`- ${joinLabels(unknown.map((item) => item.key))}: ${UNKNOWN}`);
        used = true;
      }
      continue;
    }
    lines.push(`- ${row.key}: ${row.text}`);
  }
  return lines;
}

function buildSummary({ vehicle, profile, tier, route, stops, depart, startBattery, order, milesTotal, origin, strategy, dataChecked }) {
  const from = cleanCopy(order.start ?? order.startPlace ?? '');
  const to = cleanCopy(order.end ?? order.endPlace ?? '');
  const battery = startBattery == null ? UNKNOWN : `${startBattery}%`;
  const parts = [
    `${tier.label} (${tier.price}) for a ${vehicle}.`,
    route.title ? `${cleanCopy(route.title)}.` : '',
    `Port: ${profile.port || UNKNOWN}.`,
    `Memberships: ${membershipText(order.memberships)}.`,
    `Start battery: ${battery}.`,
    departSentence(depart),
  ].filter(Boolean);
  if (from && to && !sameTrip(route.title, from, to)) parts.push(`${from} to ${to}.`);
  const passengers = cleanCopy(order.passengers ?? '');
  if (passengers) parts.push(`Passengers: ${passengers}.`);
  parts.push(stopsSentence(stops, route.highway));
  const mileage = mileageSentence(order, route, origin, milesTotal);
  if (mileage) parts.push(mileage);
  const optimistic = !origin && placesDiffer(from, route.startLabel || '');
  if (strategy?.text && !optimistic) parts.push(strategy.text);
  else if (!strategy && tier.id !== 'basic' && (startBattery == null || milesTotal == null)) parts.push(`Charging strategy: ${UNKNOWN}.`);
  if (dataChecked) parts.push(`Data checked ${dataChecked}.`);
  return cleanCopy(parts.join(' '));
}

function stopsSentence(stops, highway) {
  const where = highway ? ` on ${cleanCopy(highway)}` : '';
  const n = stops.length;
  const backups = stops.filter((stop) => stop.backups?.some((backup) => backup.status === 'verified')).length;
  const allVerified = n > 0 && stops.every((stop) => stop.headline === true);
  if (allVerified) return `${n} verified stops${where}.`;
  return `${n} stops${where}, ${backups} with a verified backup.`;
}

function mileageSentence(order, route, origin, milesTotal) {
  const startLabel = cleanCopy(route.startLabel || 'the route start');
  const orderStart = cleanCopy(order.start ?? order.startPlace ?? '');
  const miles = milesTotal == null ? '' : `${trimNum(milesTotal)} miles`;
  if (origin) {
    const kind = origin.estimate ? 'an estimated ' : '';
    const leg = `${kind}${trimNum(origin.miles)} miles from ${origin.from || orderStart || 'the start'} to ${origin.to || startLabel}`;
    return miles ? `Mileage includes ${leg}, then ${miles} on the route.` : `Mileage includes ${leg}.`;
  }
  if (orderStart && placesDiffer(orderStart, startLabel)) {
    const counted = miles ? `Mileage starts at ${startLabel}, the route's first point, ${miles}.` : `Mileage starts at ${startLabel}, the route's first point.`;
    return `${counted} The distance from ${orderStart} is not in this plan, so the first-stop numbers are optimistic.`;
  }
  return miles ? `${miles}.` : '';
}

function mileageAssumption(order, route, origin) {
  const startLabel = cleanCopy(route.startLabel || 'the route start');
  const orderStart = cleanCopy(order.start ?? order.startPlace ?? '');
  if (origin) {
    const kind = origin.estimate ? 'an estimated ' : '';
    const cite = origin.estimate
      ? ` ${origin.note || 'Estimate.'} Source checked ${origin.checkedOn}.`
      : '';
    return `Mileage includes ${kind}${trimNum(origin.miles)} miles from ${origin.from || orderStart || 'the start'} to ${origin.to || startLabel}, before the route mile marks.${cite} Starting battery at the route start is reduced for that leg. Clock times include that drive.`;
  }
  if (orderStart && placesDiffer(orderStart, startLabel)) {
    return `Mileage starts at ${startLabel}, the route's first point. The distance from ${orderStart} is not in this plan, so the first-stop numbers are optimistic.`;
  }
  return '';
}

function placesDiffer(orderStart, routeStart) {
  const a = placeKey(orderStart);
  const b = placeKey(routeStart);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return false;
  return true;
}

function buildAssumptions(order, route, origin, energy, zone, ctx) {
  const lines = [];
  const mileage = mileageAssumption(order, route, origin);
  if (mileage) lines.push(mileage);
  lines.push(energy.rangeAssumed
    ? `Battery percent is an estimate at ${trimNum(energy.rangeMiles / 100)} miles per percent of charge, ${trimNum(energy.rangeMiles)} miles from 100% to 0%. It is not a tested range for this vehicle.`
    : `Battery percent uses the order's stated range of ${trimNum(energy.rangeMiles)} miles from 100% to 0%.`);
  lines.push(`A reserve of ${RESERVE_PERCENT}% is the hard floor. The plan targets at least ${TARGET_ARRIVAL}% on arrival at each stop and at the end. An arrival under the reserve, or a ${TARGET_ARRIVAL}% target that cannot be met, is flagged.`);
  lines.push(ctx?.chargeLimitIsDefault
    ? `The charge limit for this plan is ${ctx.chargeLimit}%. A daily-use plan stops there unless the order sets a charge limit.`
    : `The order sets a charge limit of ${ctx.chargeLimit}%.`);
  lines.push(energy.packAssumed
    ? `Charge time uses the stop's verified kW. Average power is assumed at ${Math.round(CURVE_TO_80 * 100)}% of that kW up to ${TAPER_AT}% state of charge, and ${Math.round(CURVE_ABOVE_80 * 100)}% of that kW above ${TAPER_AT}%, on a ${trimNum(energy.packKwh)} kWh pack. The pack size is not on the order. This is not a measured charge curve.`
    : `Charge time uses the stop's verified kW and the order's stated pack of ${trimNum(energy.packKwh)} kWh. Average power is assumed at ${Math.round(CURVE_TO_80 * 100)}% of that kW up to ${TAPER_AT}% state of charge, and ${Math.round(CURVE_ABOVE_80 * 100)}% of that kW above ${TAPER_AT}%. This is not a measured charge curve.`);
  lines.push(`Drive time is an estimate at ${MPH} mph. Clock times add drive time and charging time.`);
  lines.push(zone
    ? `Clock times use ${zone}.`
    : `Clock time zone: ${UNKNOWN}. Times are added on the departure clock as written.`);
  lines.push(`Hills, wind, temperature, cargo, and any speed other than ${MPH} mph are not in the estimate.`);
  return lines;
}

function estimatedLine(mileageNote) {
  const tail = 'This tier does not estimate arrival battery, charge time, or clock times.';
  return mileageNote ? `What's estimated: ${mileageNote} ${tail}` : `What's estimated: ${tail}`;
}

function prepareStop(entry, ctx) {
  const { stop, primary: built, backup, alternatives, guidePrimaryUsed, teslaOnly } = entry;
  const sheet = built.primary;
  commitSources(sheet, ctx);
  if (backup?.source) {
    ctx.used.add(backup.source);
    if (backup.url) ctx.urls.set(backup.source, backup.url);
  }
  const member = memberPriceFact(sheet, ctx.profile.memberships);
  if (member) sheet.facts = [...(sheet.facts || []), member];
  if (backup?.status === 'verified') {
    const backupMembership = membershipMatch(backup.network, ctx.profile.memberships);
    if (backupMembership && !memberClause(backup.facts)) {
      backup.memberPrice = { label: backupMembership, value: 'Price not published', status: 'unpublished' };
      backup.facts = cleanCopy(`${backup.facts} ${backupMembership}: Price not published.`);
    }
  }
  const exitOk = sheet.exit?.status === 'verified';
  const backupOk = backup?.status === 'verified';
  const name = cleanCopy(stop.name || stop.id || 'Stop');
  const note = backupOk ? '' : `No verified backup at ${name} yet.`;
  return {
    entry,
    stop,
    sheet,
    backup: backupOk ? backup : null,
    alternatives,
    guidePrimaryUsed,
    teslaOnly,
    name,
    mile: Number(stop.mile),
    kw: kilowatts(sheet.power?.value),
    member: Boolean(membershipMatch(sheet.network?.value, ctx.profile.memberships)),
    flagged: !exitOk || !backupOk,
    exitOk,
    note,
    headline: exitOk && backupOk,
  };
}

function renderStop(prepared, strategy, ctx) {
  const { stop, sheet, backup, alternatives, guidePrimaryUsed, name, headline } = prepared;
  const sim = strategy?.byId?.[stop.id] || null;
  const note = backupAdvice(prepared, strategy, ctx);
  const whyBits = [whyFor(stop, sheet, guidePrimaryUsed)];
  if (!prepared.exitOk) whyBits.push('Exit not yet verified.');
  const out = {
    id: stop.id,
    name,
    mile: Number(stop.mile),
    why: cleanCopy(whyBits.filter(Boolean).join(' ')),
    primary: sheet,
    backups: backup ? [backup] : [],
    headline,
  };
  if (note) out.note = note;
  if (stop.towns) out.towns = cleanCopy(stop.towns);
  if (stop.milepostNote) out.milepostNote = cleanCopy(stop.milepostNote);

  if (ctx.level === 'detailed' || ctx.level === 'full') {
    const facts = [...(sheet.facts || [])];
    if (sim) {
      out.charging = sim.charging;
      if (sim.belowReserve) out.belowReserve = true;
      if (sim.belowTarget) out.belowTarget = true;
      if (sim.charging) {
        sheet.target = { value: `Estimate: charge to ${sim.departPct}%.`, note: ESTIMATE_NOTE };
        facts.push(
          { label: 'Arrival battery', value: arrivalText(sim), note: ESTIMATE_NOTE },
          { label: 'Departure battery', value: `Estimate: ${sim.departPct}%.`, note: ESTIMATE_NOTE },
          { label: 'Charge time', value: chargeTimeText(sim), note: ESTIMATE_NOTE },
          { label: 'Drive time', value: driveText(sim, true), note: ESTIMATE_NOTE },
        );
      } else {
        facts.push(
          { label: 'Charging', value: 'Optional. This plan does not charge here.' },
          { label: 'Arrival battery', value: arrivalText(sim), note: ESTIMATE_NOTE },
          { label: 'Drive time', value: driveText(sim, false), note: ESTIMATE_NOTE },
        );
      }
    } else if (ctx.startBattery == null) {
      facts.push(
        { label: 'Arrival battery', value: UNKNOWN },
        { label: 'Drive time', value: driveUnknown(prepared, ctx), note: ESTIMATE_NOTE },
      );
    }
    const amenities = amenityBlocks(stop, sheet, ctx);
    if (amenities.restroom) facts.push(amenities.restroom);
    sheet.facts = facts.length ? facts : undefined;
    out.primary = sheet;
    if (amenities.food.length) out.food = amenities.food;
    if (amenities.hotels.length) out.hotels = amenities.hotels;
    if (amenities.cautions.length) out.cautions = amenities.cautions;
    if (amenities.primaryCautions.length) out.primaryCautions = amenities.primaryCautions;
    if (amenities.backupCautions.length) out.backupCautions = amenities.backupCautions;
    if (amenities.otherCautions.length) out.otherCautions = amenities.otherCautions;
  }

  if (ctx.level === 'full' && sim?.charging && alternatives.length) {
    out.other = alternatives;
    for (const site of alternatives) {
      if (site.source) {
        ctx.used.add(site.source);
        if (site.url) ctx.urls.set(site.source, site.url);
      }
    }
  }
  return out;
}

function backupAdvice(prepared, strategy, ctx) {
  const base = prepared.note;
  if (!base || ctx.level === 'basic' || !strategy?.byId) return base;
  const ordered = [...(ctx.prepared || [])].sort((a, b) => a.mile - b.mile);
  const index = ordered.findIndex((item) => item.stop.id === prepared.stop.id);
  const prev = index > 0 ? ordered[index - 1] : null;
  if (prev && strategy.byId[prev.stop.id]?.charging) {
    return `${base} Charge to a higher level at the previous stop.`;
  }
  return base;
}

function buildStrategy(prepared, ctx) {
  if (ctx.startBattery == null || ctx.milesTotal == null) return null;
  const soc0 = ctx.origin
    ? ctx.startBattery - (ctx.origin.miles / ctx.energy.rangeMiles) * 100
    : ctx.startBattery;
  const ordered = prepared.map((item, index) => ({ ...item, index })).sort((a, b) => a.mile - b.mile || a.index - b.index);
  const picked = chooseCharges(ordered, soc0, ctx.energy.rangeMiles, ctx.milesTotal, ctx.chargeLimit);
  const chargeIds = new Set(picked.map((item) => item.stop.id));
  const byId = {};
  let prevMile = 0;
  let prevMin = 0;
  let prevName = ctx.origin
    ? (ctx.origin.from || cleanCopy(ctx.route.startLabel || 'the start'))
    : cleanCopy(ctx.route.startLabel || 'the route start');
  let soc = soc0;
  const originMiles = ctx.origin?.miles || 0;
  for (const item of ordered) {
    const legMiles = item.mile - prevMile + (prevMile === 0 ? originMiles : 0);
    const driveMinutes = Math.round((legMiles / MPH) * 60);
    const arriveMin = prevMin + driveMinutes;
    const arrival = soc - ((item.mile - prevMile) / ctx.energy.rangeMiles) * 100;
    const charging = chargeIds.has(item.stop.id);
    const nextMile = nextChargeMile(ordered, item, chargeIds, ctx.milesTotal);
    const arrivePct = arrival < 0 ? null : Math.round(arrival);
    const belowReserve = arrival < RESERVE_PERCENT - 1e-6;
    const ranOut = arrival < 0;
    const belowTarget = arrivePct != null && arrivePct < TARGET_ARRIVAL && !belowReserve && !ranOut;
    let departPct = null;
    let chargeMinutes = 0;
    if (charging && !ranOut) {
      const from = arrivePct == null ? 0 : arrivePct;
      const needed = ceilPct(TARGET_ARRIVAL + ((nextMile - item.mile) / ctx.energy.rangeMiles) * 100);
      const capped = Math.min(ctx.chargeLimit, needed);
      if (from >= capped) departPct = from;
      else {
        departPct = capped;
        chargeMinutes = chargeMinutesBetween(from, departPct, item.kw, ctx.energy.packKwh);
      }
    }
    const arriveClock = clockLabel(ctx.depart, arriveMin);
    const departClock = charging ? clockLabel(ctx.depart, arriveMin + chargeMinutes) : null;
    byId[item.stop.id] = {
      charging,
      arrivePct,
      departPct: charging ? departPct : null,
      chargeMinutes,
      arriveClock,
      departClock,
      belowReserve,
      belowTarget,
      ranOut,
      driveMinutes,
      fromName: prevName,
      kw: item.kw,
      chargeLimit: ctx.chargeLimit,
    };
    prevMile = item.mile;
    prevMin = arriveMin + (charging ? chargeMinutes : 0);
    prevName = item.name;
    soc = charging && !ranOut ? departPct : arrival;
  }
  const destLeg = ctx.milesTotal - prevMile;
  const destMinutes = Math.round((Math.max(0, destLeg) / MPH) * 60);
  const destArrival = soc - (Math.max(0, destLeg) / ctx.energy.rangeMiles) * 100;
  const destPct = destArrival < 0 ? null : Math.round(destArrival);
  const destBelowReserve = destArrival < RESERVE_PERCENT - 1e-6;
  const destRanOut = destArrival < 0;
  const destination = {
    mile: ctx.milesTotal,
    arrivePercent: destPct,
    arriveClock: clockLabel(ctx.depart, prevMin + destMinutes),
    belowReserve: destBelowReserve,
    belowTarget: destPct != null && destPct < TARGET_ARRIVAL && !destBelowReserve && !destRanOut,
    ranOut: destRanOut,
    chargeLimit: ctx.chargeLimit,
  };
  const text = strategyText(prepared, byId, destination, ctx);
  return {
    byId,
    public: {
      text,
      reservePercent: RESERVE_PERCENT,
      targetPercent: TARGET_ARRIVAL,
      chargeLimit: ctx.chargeLimit,
      stops: prepared.filter((item) => byId[item.stop.id]?.charging).map((item) => ({
        stopId: item.stop.id,
        name: item.sheet.name,
        mile: item.mile,
        arrivePercent: byId[item.stop.id].arrivePct,
        departPercent: byId[item.stop.id].departPct,
        chargeMinutes: byId[item.stop.id].chargeMinutes,
        arriveClock: byId[item.stop.id].arriveClock,
        departClock: byId[item.stop.id].departClock,
        belowReserve: byId[item.stop.id].belowReserve,
        belowTarget: byId[item.stop.id].belowTarget,
      })),
      destination,
    },
    text,
  };
}

function nextChargeMile(ordered, item, chargeIds, dest) {
  const later = ordered.find((other) => other.mile > item.mile && chargeIds.has(other.stop.id));
  return later ? later.mile : dest;
}

function chooseCharges(ordered, soc0, range, dest, maxSoc) {
  const strict = searchCharges(ordered, soc0, range, dest, TARGET_ARRIVAL, maxSoc);
  if (strict) return strict;
  const reserve = searchCharges(ordered, soc0, range, dest, RESERVE_PERCENT, maxSoc);
  if (reserve) return reserve;
  return fallbackCharges(ordered, soc0, range, RESERVE_PERCENT, maxSoc);
}

function chargeSearch(ordered, soc0, range, floor, maxSoc) {
  const n = ordered.length;
  const startReach = maxLeg(soc0, range, floor);
  const fullReach = maxLeg(maxSoc, range, floor);
  const best = Array(n).fill(null);
  const scoreOf = (list) => {
    let member = 0;
    let kw = 0;
    let flags = 0;
    let miles = 0;
    for (const index of list) {
      if (ordered[index].member) member += 1;
      kw += ordered[index].kw;
      if (ordered[index].flagged) flags += 1;
      miles += ordered[index].mile;
    }
    return { list, member, kw, flags, miles, count: list.length };
  };
  const better = (a, b) => {
    if (!b) return true;
    if (a.count !== b.count) return a.count < b.count;
    if (a.kw !== b.kw) return a.kw > b.kw;
    if (a.member !== b.member) return a.member > b.member;
    if (a.flags !== b.flags) return a.flags < b.flags;
    if (a.miles !== b.miles) return a.miles > b.miles;
    return false;
  };
  for (let i = 0; i < n; i += 1) {
    if (ordered[i].mile <= startReach + 1e-6) best[i] = scoreOf([i]);
    for (let j = 0; j < i; j += 1) {
      if (!best[j]) continue;
      if (ordered[i].mile - ordered[j].mile <= fullReach + 1e-6) {
        const next = scoreOf([...best[j].list, i]);
        if (better(next, best[i])) best[i] = next;
      }
    }
  }
  return { best, startReach, fullReach, better, scoreOf };
}

function searchCharges(ordered, soc0, range, dest, floor, maxSoc) {
  const { best, startReach, fullReach, better, scoreOf } = chargeSearch(ordered, soc0, range, floor, maxSoc);
  let win = dest <= startReach + 1e-6 ? scoreOf([]) : null;
  for (let i = 0; i < ordered.length; i += 1) {
    if (!best[i]) continue;
    if (dest - ordered[i].mile <= fullReach + 1e-6 && better(best[i], win)) win = best[i];
  }
  if (!win) return null;
  return win.list.map((index) => ordered[index]);
}

function fallbackCharges(ordered, soc0, range, floor, maxSoc) {
  const { best, better } = chargeSearch(ordered, soc0, range, floor, maxSoc);
  let far = null;
  for (let i = 0; i < ordered.length; i += 1) {
    if (!best[i]) continue;
    const last = ordered[best[i].list[best[i].list.length - 1]];
    const farLast = far ? ordered[far.list[far.list.length - 1]] : null;
    if (!far || last.mile > farLast.mile || (last.mile === farLast.mile && better(best[i], far))) far = best[i];
  }
  if (far) return far.list.map((index) => ordered[index]);
  return ordered.length ? [ordered[0]] : [];
}

function maxLeg(soc, range, floor) {
  return Math.max(0, ((soc - floor) / 100) * range);
}

function strategyText(prepared, byId, destination) {
  const charging = prepared.filter((item) => byId[item.stop.id]?.charging);
  const end = destinationPhrase(destination);
  if (!charging.length) return `No charging stop. ${end}`;
  const bits = charging.map((item) => {
    const sim = byId[item.stop.id];
    const flag = sim.belowReserve
      ? `, below the ${RESERVE_PERCENT}% reserve`
      : (sim.belowTarget ? `, short of the ${TARGET_ARRIVAL}% arrival target` : '');
    return `${item.sheet.name} to ${sim.departPct}%${flag}`;
  });
  const where = bits.length === 1 ? `Charge at ${bits[0]}.` : `Charge at ${bits.join(', then ')}.`;
  return `${where} ${end}`;
}

function destinationPhrase(destination) {
  const clock = destination.arriveClock ? ` around ${destination.arriveClock}` : '';
  if (destination.ranOut) return `Estimated arrival at the end${clock}: the assumed range runs out, below the ${RESERVE_PERCENT}% reserve. The ${TARGET_ARRIVAL}% arrival target cannot be met.`;
  if (destination.belowReserve) return `Estimated arrival at the end is ${destination.arrivePercent}%${clock}, below the ${RESERVE_PERCENT}% reserve. The ${TARGET_ARRIVAL}% arrival target cannot be met.`;
  if (destination.belowTarget) return `Estimated arrival at the end is ${destination.arrivePercent}%${clock}, above the ${RESERVE_PERCENT}% reserve. The ${TARGET_ARRIVAL}% arrival target cannot be met within the ${destination.chargeLimit}% charge limit.`;
  return `Estimated arrival at the end is ${destination.arrivePercent}%${clock}, at or above the ${TARGET_ARRIVAL}% arrival target.`;
}

function arrivalText(sim) {
  if (sim.ranOut) return `Estimate: the assumed range runs out before this stop, below the ${RESERVE_PERCENT}% reserve. The ${TARGET_ARRIVAL}% arrival target cannot be met.`;
  if (sim.belowReserve) return `Estimate: about ${sim.arrivePct}% on arrival, below the ${RESERVE_PERCENT}% reserve. The ${TARGET_ARRIVAL}% arrival target cannot be met.`;
  if (sim.belowTarget) return `Estimate: about ${sim.arrivePct}% on arrival, above the ${RESERVE_PERCENT}% reserve. The ${TARGET_ARRIVAL}% arrival target cannot be met within the ${sim.chargeLimit}% charge limit.`;
  return `Estimate: about ${sim.arrivePct}% on arrival.`;
}

function chargeTimeText(sim) {
  if (!sim.kw) return `Estimate: ${UNKNOWN}. Verified kW: ${UNKNOWN}.`;
  if (!sim.chargeMinutes) return 'Estimate: under 1 minute.';
  return `Estimate: ${sim.chargeMinutes} minutes at the verified ${trimNum(sim.kw)} kW.`;
}

function driveText(sim, charging) {
  const clock = sim.arriveClock
    ? (charging
      ? `, arriving about ${sim.arriveClock}${sim.departClock ? `. Leave about ${sim.departClock}` : ''}`
      : `, passing about ${sim.arriveClock}`)
    : `. Departure clock time: ${UNKNOWN}`;
  return `Estimate: ${sim.driveMinutes} minutes from ${sim.fromName} at ${MPH} mph${clock}.`;
}

function driveUnknown(prepared, ctx) {
  const fromName = cleanCopy(ctx.route.startLabel || 'the route start');
  const minutes = Math.round((prepared.mile / MPH) * 60);
  const clock = clockLabel(ctx.depart, minutes);
  if (!clock) return `Estimate: ${minutes} minutes from ${fromName} at ${MPH} mph. Departure clock time: ${UNKNOWN}.`;
  return `Estimate: ${minutes} minutes from ${fromName} at ${MPH} mph, passing about ${clock}.`;
}

function chargeMinutesBetween(fromPct, toPct, kw, pack) {
  if (!kw || toPct <= fromPct) return 0;
  let minutes = 0;
  if (fromPct < TAPER_AT) {
    const end = Math.min(toPct, TAPER_AT);
    const part = ((end - fromPct) / 100) * pack;
    minutes += (part / (kw * CURVE_TO_80)) * 60;
  }
  if (toPct > TAPER_AT) {
    const start = Math.max(fromPct, TAPER_AT);
    const part = ((toPct - start) / 100) * pack;
    minutes += (part / (kw * CURVE_ABOVE_80)) * 60;
  }
  if (minutes <= 0) return 0;
  return Math.max(1, Math.round(minutes));
}

function buildContingency(stops, strategy, ctx) {
  const items = [];
  const charging = stops.filter((stop) => stop.charging);
  const subjects = charging.length ? charging : stops.slice(0, 1);
  const nowhere = [];
  if (!charging.length) {
    const only = subjects[0];
    if (!only) {
      items.push({ title: 'Stall full or offline', text: 'No charging stop is planned, and this route has no verified station to name.' });
    } else {
      const line = stallSentence(only, stops, true);
      if (line.none) {
        items.push({ title: 'Stall full or offline', text: `No alternative verified station for ${only.name}.` });
      } else {
        items.push(sourcedItem('Stall full or offline', line.text, line.source));
      }
    }
  } else {
    for (const stop of charging) {
      const line = stallSentence(stop, stops, false);
      if (line.none) nowhere.push(stop.name);
      else items.push(sourcedItem('Stall full or offline', line.text, line.source));
    }
    if (nowhere.length) {
      items.push({
        title: 'Stall full or offline',
        text: `No alternative verified station for ${joinAnd(nowhere)}.`,
      });
    }
  }

  const seenCaution = new Set();
  for (const stop of stops) {
    const pool = [
      ...(stop.primaryCautions || []),
      ...(stop.backupCautions || []),
      ...(stop.otherCautions || []),
    ];
    for (const caution of pool) {
      if (!/\b(heat|throttl\w*|queue|queued)\b/i.test(caution.text || '')) continue;
      if (!caution.url || !caution.checkedOn) continue;
      const key = `${caution.name}:${caution.text}`.toLowerCase();
      if (seenCaution.has(key)) continue;
      seenCaution.add(key);
      items.push(sourcedItem('Caution', `${caution.name}: ${caution.text}`, caution));
    }
  }

  items.push(lowBatteryItem(stops, strategy));
  for (const item of items) {
    if (item?.source) {
      ctx.used.add(item.source);
      if (item.url) ctx.urls.set(item.source, item.url);
    }
  }
  return items.filter(Boolean);
}

function stallSentence(stop, stops, noCharge) {
  const backup = stop.backups?.find((item) => item.status === 'verified') || null;
  const { behind, ahead } = routeNeighbors(stops, stop.mile);
  if (!backup && !behind && !ahead) return { none: true, text: '', source: null };
  const lead = noCharge
    ? `No charging stop is planned. If ${stop.primary.name} at ${stop.name} (mile ${stop.mile}) is full or offline`
    : `If ${stop.primary.name} at ${stop.name} (mile ${stop.mile}) is full or offline`;
  const onSite = backup
    ? `the verified backup at this stop is ${backup.name}`
    : 'there is no verified backup at this stop';
  const aheadText = ahead
    ? `The next verified station ahead is ${ahead.primary.name} at ${ahead.name}, ${trimNum(ahead.mile - stop.mile)} miles ahead on the route.`
    : `No verified station is ahead of ${stop.name} on this route.`;
  const behindText = behind
    ? `The next verified station behind is ${behind.primary.name} at ${behind.name}, ${trimNum(stop.mile - behind.mile)} miles back on the route.`
    : `No verified station is behind ${stop.name} on this route.`;
  return {
    none: false,
    text: `${lead}, ${onSite}. ${aheadText} ${behindText}`,
    source: backup || ahead?.primary?.stalls || behind?.primary?.stalls || null,
  };
}

function lowBatteryItem(stops, strategy) {
  let anchorMile = strategy?.public?.destination?.mile;
  let anchorLabel = 'the end';
  let lowest = strategy?.public?.destination?.arrivePercent;
  if (lowest == null) lowest = 101;
  for (const stop of stops) {
    const pct = strategy?.byId?.[stop.id]?.arrivePct;
    if (pct != null && pct < lowest) {
      lowest = pct;
      anchorMile = stop.mile;
      anchorLabel = `${stop.primary.name} at ${stop.name}`;
    }
  }
  if (anchorMile == null) {
    return { title: 'Low battery fallback', text: 'No verified stop is on this plan to use as a low battery fallback.' };
  }
  const { behind, ahead } = routeNeighbors(stops, anchorMile);
  if (!behind && !ahead) {
    return {
      title: 'Low battery fallback',
      text: `No other verified station on this route for a low battery near ${anchorLabel}.`,
    };
  }
  const bits = [`Low battery near ${anchorLabel}.`];
  if (behind) bits.push(`The nearest verified stop behind is ${behind.primary.name} at ${behind.name}, ${trimNum(anchorMile - behind.mile)} miles back on the route.`);
  else bits.push('No verified stop is behind that point.');
  if (ahead) bits.push(`The nearest verified stop ahead is ${ahead.primary.name} at ${ahead.name}, ${trimNum(ahead.mile - anchorMile)} miles ahead on the route.`);
  else bits.push('No verified stop is ahead of that point.');
  const source = behind?.primary?.stalls || ahead?.primary?.stalls || null;
  return sourcedItem('Low battery fallback', bits.join(' '), source);
}

function routeNeighbors(stops, mile) {
  const behind = [...stops].filter((stop) => stop.mile < mile).sort((a, b) => b.mile - a.mile)[0] || null;
  const ahead = [...stops].filter((stop) => stop.mile > mile).sort((a, b) => a.mile - b.mile)[0] || null;
  return { behind, ahead };
}

function sourcedItem(title, text, from) {
  const item = { title, text: cleanCopy(text) };
  if (from?.source) item.source = from.source;
  if (from?.url) item.url = from.url;
  if (from?.checkedOn) item.checkedOn = from.checkedOn;
  return item;
}

// Driver and crowd-sourced evidence (PlugShare, Reddit, X, forums) never counts as a sourced
// restroom note. It stays in the plan as a labeled driver report; only host or network pages
// (an around-the-stop note or a route note from a non-driver source) make a restroom "sourced".
const DRIVER_SOURCE_RE = /^(plugshare|reddit|x|forum)(?:\b|[-_])/i;
const DRIVER_HOST_RE = /(^|\.)(plugshare\.com|reddit\.com|x\.com|twitter\.com)$/i;
const RESTROOM_UNSURE_RE = /\bnot yet verified\b|\bnot (?:confirmed|listed|shown|stated)\b|\b(?:has|have|had|did|does|do)(?: not|n't) (?:confirm|list|mention|show|say)\b|\bwhether\b|\bunknown\b|\bneither\b|\bno (?:public )?restrooms?\b|\bwithout (?:a )?restrooms?\b/i;

export function isDriverEvidence(source, url) {
  if (DRIVER_SOURCE_RE.test(String(source || ''))) return true;
  try {
    return DRIVER_HOST_RE.test(new URL(String(url || '')).hostname);
  } catch {
    return false;
  }
}

function sentencesOf(text) {
  return cleanCopy(text).split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
}

function amenityHonesty(chosen, route, order) {
  const restrooms = [];
  const driverRestrooms = [];
  const pets = [];
  const seenR = new Set();
  const seenD = new Set();
  const seenP = new Set();
  const add = (list, seen, name) => {
    const clean = cleanCopy(name);
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) return;
    if (list.some((item) => namesMatch(item, clean) || namesMatch(clean, item))) return;
    seen.add(key);
    list.push(clean);
  };
  const usable = (text, url, date, source) => {
    if (!text || BANNED.test(text)) return false;
    const link = httpUrl(url) || httpUrl(route.sources?.[source]?.url);
    return Boolean(link && day(date));
  };
  const restroomSentence = (text) =>
    sentencesOf(text).some(
      (part) => RESTROOM_RE.test(part) && !RESTROOM_UNSURE_RE.test(part) && !CAUTION_RE.test(part) && !isChargerReview(part)
    );
  const considerDriver = (text, url, date, source, place, stopName) => {
    if (!usable(text, url, date, source)) return;
    if (CAUTION_RE.test(text) || isChargerReview(text)) return;
    if (RESTROOM_RE.test(text)) add(driverRestrooms, seenD, place);
    if (PET_RE.test(text)) add(pets, seenP, stopName || place);
  };
  const atPrimary = new Set();
  const considerHost = (text, url, date, source, place, stopName, { pets: countPets = true, primaryName = '' } = {}) => {
    if (!usable(text, url, date, source)) return;
    const link = httpUrl(url) || httpUrl(route.sources?.[source]?.url);
    if (isDriverEvidence(source, link)) {
      if (countPets) considerDriver(text, url, date, source, place, stopName);
      else if (!CAUTION_RE.test(text) && !isChargerReview(text) && RESTROOM_RE.test(text)) add(driverRestrooms, seenD, place);
      return;
    }
    if (restroomSentence(text)) {
      add(restrooms, seenR, place);
      if (primaryName && cleanCopy(place) === cleanCopy(primaryName)) atPrimary.add(cleanCopy(primaryName));
    }
    if (countPets && !CAUTION_RE.test(text) && !isChargerReview(text) && PET_RE.test(text)) add(pets, seenP, stopName || place);
  };
  for (const entry of chosen) {
    const stations = [entry.stop.primary, ...(entry.stop.backups || []), ...(entry.stop.other || [])].filter(Boolean);
    for (const station of stations) {
      for (const report of station.driverReports || []) {
        considerDriver(report.summary, report.url, report.date, report.source, station.name, entry.stop.name);
      }
    }
    const primaryName = entry.stop.primary?.name || entry.stop.name;
    for (const report of entry.stop.reports || []) {
      const match = bestStation(report.site, stations);
      considerHost(report.text, report.url, report.date || report.checkedOn, report.source, match?.name || report.site || entry.stop.name, entry.stop.name, { primaryName });
    }
    for (const item of entry.stop.around || []) {
      const text = item.text || item.value;
      const match = bestStation(text, stations) || bestStation(item.site, stations);
      considerHost(text, item.url, item.checkedOn || item.date || route.checked, item.source, match?.name || item.site || primaryName, entry.stop.name, { pets: false, primaryName });
    }
  }
  // A primary counts as covered only when a host or network note is about that exact site,
  // not a backup or another site in the same town.
  const missing = [];
  for (const entry of chosen) {
    const primary = cleanCopy(entry.stop.primary?.name || entry.stop.name);
    if (!atPrimary.has(primary)) missing.push(primary);
  }
  const have = restrooms.length ? `Sourced restroom notes: ${restrooms.join(', ')}.` : 'No sourced restroom note at any stop.';
  const lack = restrooms.length && missing.length ? ` No sourced restroom note at ${joinList(missing)}.` : '';
  const driverOnly = driverRestrooms.filter((name) => !restrooms.some((item) => namesMatch(item, name) || namesMatch(name, item)));
  const driver = driverOnly.length
    ? ` Driver reports or PlugShare listings mention restrooms at ${joinAnd(driverOnly)}. Those are driver reports, not host or network facts.`
    : '';
  const pet = orderHasPet(order)
    ? (pets.length ? ` Sourced pet notes: ${pets.join(', ')}.` : ' No sourced pet info at any stop.')
    : '';
  return cleanCopy(`${have}${lack}${driver}${pet}`);
}

function joinList(items) {
  if (items.length <= 1) return items[0] || '';
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1]}`;
}

function amenityBlocks(stop, sheet, ctx) {
  const stations = [stop.primary, ...(stop.backups || []), ...(stop.other || [])].filter(Boolean);
  const food = [];
  const hotels = [];
  const cautions = [];
  let restroom = null;
  let restroomNote = null;
  const seen = new Set();
  const push = (bucket, note, section) => {
    if (bucket.length >= MAX_NOTES) return;
    const key = `${section}:${note.text.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    const item = noteItem(placeName(note.place, section), note, ctx);
    if (note.role) item.role = note.role;
    bucket.push(item);
  };
  const take = (item, text, url, source, checkedOn, place, kind) => {
    const clean = cleanCopy(text);
    if (!clean || BANNED.test(clean)) return;
    const link = httpUrl(url) || httpUrl(ctx.route.sources?.[source]?.url);
    const date = day(checkedOn) || day(ctx.route.checked);
    if (!link || !date) return;
    const category = categoryOf(item, clean);
    if (!category || category === 'pet') return;
    const shown = (category === 'food' || category === 'restroom') ? stripPlacePrefix(clean, place) : clean;
    if (!shown) return;
    const aboutPrimary = namesMatch(place, sheet.name);
    // PlugShare, Reddit, X and forum material is a driver report wherever it sits in the route data.
    const noteKind = kind === 'driver' || isDriverEvidence(source, link) ? 'driver' : kind;
    const note = { text: shown, url: link, source: source || '', checkedOn: date, kind: noteKind, place, role: cautionRole(place, sheet, stop) };
    if (category === 'caution') {
      push(cautions, note, 'Cautions');
      return;
    }
    if (!aboutPrimary && place) {
      if (category === 'food') push(food, note, 'Food');
      if (category === 'overnight') push(hotels, note, 'Lodging');
      return;
    }
    if (category === 'restroom' && aboutPrimary && (!restroom || (restroomNote.kind === 'driver' && noteKind !== 'driver'))) {
      // A host or network note takes the Restroom line over a driver report. The displaced
      // driver report stays in the plan as a labeled driver note.
      if (restroom) push(food, restroomNote, 'Food');
      restroomNote = note;
      const item = noteItem('Restroom', note, ctx);
      restroom = {
        label: 'Restroom',
        value: item.text,
        url: item.url,
        checkedOn: item.checkedOn,
        note: item.note,
        ...(item.source ? { source: item.source } : {}),
        ...(item.sourceName ? { sourceName: item.sourceName } : {}),
      };
      return;
    }
    if (category === 'food') push(food, note, 'Food');
    if (category === 'overnight') push(hotels, note, 'Lodging');
  };
  for (const report of stop.primary?.driverReports || []) {
    take(report, report.summary, report.url, report.source, report.date, sheet.name, 'driver');
  }
  for (const station of stations) {
    if (station === stop.primary) continue;
    for (const report of station.driverReports || []) {
      take(report, report.summary, report.url, report.source, report.date, station.name, 'driver');
    }
  }
  for (const report of stop.reports || []) {
    const match = bestStation(report.site, stations);
    take(report, report.text, report.url, report.source, report.date, match?.name || report.site || sheet.name, 'route');
  }
  for (const item of stop.around || []) {
    const match = bestStation(item.text, stations) || bestStation(item.site, stations);
    take(item, item.text || item.value, item.url, item.source, item.checkedOn || item.date, match?.name || '', 'route');
  }
  const withoutRole = (item) => {
    const copy = { ...item };
    delete copy.role;
    return copy;
  };
  const primaryCautions = cautions.filter((item) => item.role === 'primary').map(withoutRole);
  const backupCautions = cautions.filter((item) => item.role === 'backup').map(withoutRole);
  const otherCautions = cautions.filter((item) => item.role !== 'primary' && item.role !== 'backup').map(withoutRole);
  return {
    food,
    hotels,
    cautions: [...primaryCautions, ...backupCautions, ...otherCautions],
    primaryCautions,
    backupCautions,
    otherCautions,
    restroom,
  };
}

function cautionRole(place, sheet, stop) {
  if (namesMatch(place, sheet.name)) return 'primary';
  if ((stop.backups || []).some((backup) => namesMatch(place, backup.name))) return 'backup';
  return 'other';
}

function stripPlacePrefix(text, place) {
  let out = cleanCopy(text);
  if (place) {
    const escaped = cleanCopy(place).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`^${escaped}(?:\\s+tesla\\s+site)?\\s*:\\s*`, 'i'), '');
  }
  out = out.replace(/^[A-Za-z0-9][^:]{0,80}?\bTesla site:\s*/i, '');
  return cleanCopy(out);
}

function categoryOf(item, text) {
  const declared = String(item?.category || item?.type || '').trim().toLowerCase();
  const inferred = inferCategory(text);
  if (inferred === 'caution') return 'caution';
  const category = ['food', 'restroom', 'overnight', 'caution', 'pet'].includes(declared) ? declared : inferred;
  if ((category === 'food' || category === 'restroom') && isChargerReview(text)) return 'caution';
  return category;
}

function isChargerReview(text) {
  return /\b(kW|kilowatts?|charg(?:e|ing|ers?)|pedestal|dispenser|session|superchargers?|plugs?|charging options)\b/i.test(text);
}

function inferCategory(text) {
  if (CAUTION_RE.test(text)) return 'caution';
  if (OVERNIGHT_RE.test(text)) return 'overnight';
  if (PET_RE.test(text) && !FOOD_RE.test(text) && !RESTROOM_RE.test(text)) return 'pet';
  if (FOOD_RE.test(text)) return 'food';
  if (RESTROOM_RE.test(text)) return 'restroom';
  if (PET_RE.test(text)) return 'pet';
  return '';
}

function placeName(name, section) {
  const clean = cleanCopy(name);
  if (!clean || SECTION_TITLES.has(clean.toLowerCase())) return 'This stop';
  if (clean.toLowerCase() === section.toLowerCase()) return 'This stop';
  return clean;
}

function namesMatch(site, stationName) {
  return matchScore(site, stationName) > 0;
}

function matchScore(site, stationName) {
  const stopWords = new Set(['the', 'and', 'site', 'road', 'street', 'avenue', 'blvd', 'drive', 'with', 'for', 'from']);
  const tokens = (value) => cleanCopy(value).toLowerCase().split(/[^a-z0-9]+/).filter((part) => part.length > 2 && !stopWords.has(part));
  const a = tokens(site);
  const b = new Set(tokens(stationName));
  if (!a.length || !b.size) return 0;
  const hits = a.filter((part) => b.has(part));
  if (!hits.length) return 0;
  if (hits.length >= 2 || a.length === 1) return hits.length;
  return 0;
}

function bestStation(site, stations) {
  let best = null;
  let bestScore = 0;
  let ties = 0;
  for (const station of stations) {
    const score = matchScore(site, station?.name);
    if (score > bestScore) {
      best = station;
      bestScore = score;
      ties = 1;
    } else if (score === bestScore && score > 0) ties += 1;
  }
  if (!best || ties > 1) return null;
  return best;
}

function noteItem(name, note, ctx) {
  if (note.source) {
    ctx.used.add(note.source);
    if (note.url) ctx.urls.set(note.source, note.url);
  }
  const item = {
    name,
    text: note.text,
    url: note.url,
    checkedOn: note.checkedOn,
    note: note.kind === 'driver' ? 'Driver report. Not a network fact.' : 'Route note. Not a network fact.',
  };
  if (note.source) item.source = note.source;
  const label = ctx.route.sources?.[note.source]?.name;
  if (label) item.sourceName = cleanCopy(label);
  return item;
}

function memberPriceFact(sheet, memberships) {
  const membership = membershipMatch(sheet.network?.value, memberships);
  if (!membership) return null;
  const price = sheet.price;
  const clause = price?.status === 'verified' ? memberClause(price.value) : '';
  if (clause && price?.url && price?.checkedOn) {
    return {
      label: membership,
      value: clause,
      status: 'verified',
      url: price.url,
      checkedOn: price.checkedOn,
      ...(price.source ? { source: price.source } : {}),
    };
  }
  return { label: membership, value: 'Price not published', status: 'unpublished' };
}

function memberClause(text) {
  const parts = String(text || '').split(/(?<=\.)\s+/);
  for (const part of parts) {
    if (!/\b(members?|membership|pass\+)\b/i.test(part)) continue;
    if (/non-tesla/i.test(part) && !/\bmembers?\b|\bpass\+/i.test(part.split(/non-tesla/i)[1] || '')) continue;
    const money = part.match(/\$\d+(?:\.\d+)?(?:\s*\/\s*kWh)?/i);
    if (!money) continue;
    return cleanCopy(part);
  }
  return '';
}

function membershipMatch(network, memberships) {
  const net = String(network || '');
  for (const membership of memberships || []) {
    if (/electrify america/i.test(membership) && /electrify america/i.test(net)) return membership;
    if (/\bevgo\b/i.test(membership) && /\bevgo\b/i.test(net)) return membership;
    if (/tesla supercharging/i.test(membership) && /tesla|supercharger/i.test(net)) return membership;
    if (/rivian/i.test(membership) && /rivian/i.test(net)) return membership;
    if (/chargepoint/i.test(membership) && /chargepoint/i.test(net)) return membership;
  }
  return '';
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
    stop,
    primary: first,
    backup: second ? second.backup : null,
    alternatives: rest.map((item) => item.backup),
    guidePrimaryUsed: first.role === 'guide',
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
  if (station.stalls && station.power && station.access) return tryGuidePrimary(station, route, profile);
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
    access.source = source;
  }
  const primary = toPrimary(station, route, { stalls, power, access, listedFacts: cleanCopy(station.facts) });
  return { primary, backup: toBackup(station, primary) };
}

function toPrimary(station, route, parts) {
  const primary = {
    name: cleanCopy(station.name) || 'Stop',
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
    primary[key] = typeof station[key] === 'object' && !Array.isArray(station[key])
      ? presentFact(station[key], station, route)
      : sourcedText(station[key], station, route, parts.stalls);
  }
  if (parts.listedFacts && !BANNED.test(parts.listedFacts)) {
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
    name: cleanCopy(station.name || primary.name) || 'Stop',
    facts: factsLine(station, primary),
    status: 'verified',
  };
  const network = typeof station.network === 'string' ? cleanCopy(station.network) : primary.network?.value;
  const address = typeof station.address === 'string' ? cleanCopy(station.address) : primary.address?.value;
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

function factsLine(station, primary) {
  if (typeof station.facts === 'string' && station.facts.trim() && !BANNED.test(station.facts)) return cleanCopy(station.facts);
  const stalls = primary.stalls?.value;
  const power = primary.power?.value;
  if (stalls && stalls !== UNKNOWN && power && power !== UNKNOWN) {
    const left = /\bstalls?\b|\bchargers?\b/i.test(stalls) ? stalls : `${stalls} stalls`;
    return cleanCopy(`${left}. ${String(power).replace(/\.$/, '')}.`);
  }
  return UNKNOWN;
}

function whyFor(stop, primary, guidePrimaryUsed) {
  if (guidePrimaryUsed) {
    const kept = cleanCopy(stop.why || '');
    if (kept && !BANNED.test(kept)) return kept;
  } else if (stop.primary?.name) {
    const flag = teslaFlag(stop.primary);
    const guideName = cleanCopy(stop.primary.name);
    if (flag === 'tesla-only') return cleanCopy(`Guide primary ${guideName} is Tesla only. This plan uses ${primary.name}.`);
    if (flag === 'open') return cleanCopy(`Guide primary ${guideName} needs a NACS adapter this order does not list. This plan uses ${primary.name}.`);
    return cleanCopy(`Guide primary ${guideName} is not verified for this car. This plan uses ${primary.name}.`);
  }
  const stalls = primary.stalls?.value;
  const power = primary.power?.value;
  const left = stalls && /\bstalls?\b|\bchargers?\b/i.test(String(stalls)) ? stalls : `${stalls} stalls`;
  return cleanCopy(`${primary.name}: ${left}, ${String(power).replace(/\.$/, '')}.`);
}

function presentFact(fact, station, route) {
  if (!fact || typeof fact !== 'object' || Array.isArray(fact)) return { value: UNKNOWN, status: 'unverified' };
  const value = cleanCopy(fact.value ?? '');
  const status = fact.status || '';
  if (!value || !status || value === UNKNOWN) return { value: UNKNOWN, status: 'unverified' };
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
  if (value && typeof value === 'object' && !Array.isArray(value)) return presentFact(value, station, route);
  const shown = cleanCopy(value ?? '');
  if (!shown || shown === UNKNOWN) return { value: UNKNOWN, status: 'unverified' };
  const source = station.source || stalls?.source || station.stalls?.source || '';
  const url = httpUrl(station.url) || httpUrl(stalls?.url) || httpUrl(station.stalls?.url) || httpUrl(route.sources?.[source]?.url) || '';
  const checkedOn = day(station.checkedOn) || stalls?.checkedOn || day(route.checked);
  if (!url || !checkedOn) return { value: UNKNOWN, status: 'unverified' };
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
  if (typeof station.access === 'string' && station.access.trim() && cleanCopy(station.access) !== UNKNOWN) {
    return cleanCopy(station.access);
  }
  if (station.access && typeof station.access === 'object') {
    const value = cleanCopy(station.access.value || '');
    if (value && value !== UNKNOWN) return value;
  }
  const parts = String(station.facts || '').split(/(?<=\.)\s+/);
  const hit = parts.find((part) => /tesla only|open to|does not say other evs/i.test(part));
  return hit ? cleanCopy(hit.replace(/\.$/, '')) : '';
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

function commitSources(primary, ctx) {
  for (const key of ['network', 'address', 'exit', 'stalls', 'power', 'access', 'price', 'hours', 'connectors', 'plugs']) {
    const fact = primary?.[key];
    if (fact && typeof fact === 'object' && fact.source) {
      ctx.used.add(fact.source);
      if (fact.url) ctx.urls.set(fact.source, fact.url);
    }
  }
  for (const fact of primary?.facts || []) {
    if (fact?.source) {
      ctx.used.add(fact.source);
      if (fact.url) ctx.urls.set(fact.source, fact.url);
    }
  }
}

function planStats(route, ctx) {
  const stats = [];
  for (const stat of route.stats || []) {
    if (!stat || typeof stat !== 'object') continue;
    const label = cleanCopy(stat.label ?? '');
    const value = cleanCopy(stat.value ?? '');
    const note = stat.note ? cleanCopy(stat.note) : '';
    if (BANNED.test(label) || BANNED.test(value) || BANNED.test(note)) continue;
    const source = stat.source || '';
    const url = httpUrl(stat.url) || httpUrl(route.sources?.[source]?.url);
    const checkedOn = day(stat.checkedOn) || day(route.checked);
    if (!url || !checkedOn || !source) continue;
    if (!Number.isFinite(Number(String(value).replace(/,/g, '')))) continue;
    const out = { label, value, source, url, checkedOn };
    if (stat.unit) out.unit = cleanCopy(stat.unit);
    if (note) out.note = note;
    ctx.used.add(source);
    ctx.urls.set(source, url);
    stats.push(out);
  }
  return stats;
}

function sourceMap(route, ctx) {
  const out = {};
  for (const id of ctx.used) {
    const source = route.sources?.[id];
    const url = httpUrl(source?.url) || httpUrl(ctx.urls.get(id)) || '';
    if (!url) continue;
    const name = cleanCopy(source?.name) || nameFromUrl(url) || nameFromId(id);
    out[id] = { name, url };
  }
  return out;
}

function stampSources(node, sources) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((item) => stampSources(item, sources));
    return;
  }
  if (typeof node.source === 'string' && sources[node.source] && !node.sourceName) {
    node.sourceName = sources[node.source].name;
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') stampSources(value, sources);
  }
}

function dateRange(plan) {
  const dates = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if ((key === 'checkedOn' || key === 'checked') && typeof value === 'string') {
        const found = day(value);
        if (found) dates.push(found);
      } else if (value && typeof value === 'object') walk(value);
    }
  };
  walk(plan);
  if (!dates.length) return '';
  dates.sort();
  return dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} to ${dates[dates.length - 1]}`;
}

function nameFromUrl(url) {
  let host = '';
  try {
    host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
  if (HOST_NAMES[host]) return HOST_NAMES[host];
  const label = host.split('.')[0];
  if (!label) return '';
  if (label === 'x') return 'X';
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function nameFromId(id) {
  if (id === 'x') return 'X';
  return id;
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
  return {
    port: unsure ? '' : port,
    car,
    nativeNacs,
    nativeCcs,
    nacsAdapter,
    ccsAdapter,
    hasPlug,
    memberships: membershipList(order.memberships),
  };
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
    name: cleanCopy(station.name),
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

function membershipList(value) {
  if (value == null) return [];
  const raw = Array.isArray(value) ? value : String(value).split(/[;,]/);
  return raw.map((item) => cleanCopy(item)).filter((item) => item && !/^none( listed)?$/i.test(item));
}

function membershipText(value) {
  const items = membershipList(value);
  if (value == null) return UNKNOWN;
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

function vehicleEnergy(order) {
  const range = positiveNumber(order.rangeMiles ?? order.range);
  const pack = positiveNumber(order.batteryKwh ?? order.packKwh ?? order.usableKwh);
  const eff = positiveNumber(order.efficiency ?? order.milesPerKwh);
  let rangeMiles = range;
  let packKwh = pack;
  if (rangeMiles == null && packKwh != null && eff != null) rangeMiles = packKwh * eff;
  const rangeAssumed = rangeMiles == null;
  const packAssumed = packKwh == null && eff == null;
  if (rangeMiles == null) rangeMiles = RANGE_MILES;
  if (packKwh == null && eff != null) packKwh = rangeMiles / eff;
  if (packKwh == null) packKwh = PACK_KWH;
  return { rangeMiles, packKwh, rangeAssumed, packAssumed };
}

function positiveNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function departValue(order) {
  return cleanCopy(order.depart ?? order.departure ?? order.departureTime ?? '');
}

function departSentence(depart) {
  if (!depart?.date && !depart?.raw) return `Departure: ${UNKNOWN}.`;
  if (!depart.date) return `Departure: ${depart.raw}.`;
  if (!depart.time) return `Leaving ${depart.date}. Departure clock time: ${UNKNOWN}.`;
  const zone = depart.timeZone ? ` ${depart.timeZone}` : '';
  return `Leaving ${depart.date} at ${depart.time}${zone}.`;
}

function normalizeDepart(raw, timeZone) {
  const text = cleanCopy(raw);
  if (!text) return { raw: '', date: '', time: '', iso: '', timeZone: timeZone || '' };
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!match) return { raw: text, date: '', time: '', iso: text, timeZone: timeZone || '' };
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  const time = match[4] ? `${match[4]}:${match[5]}` : '';
  if (!time) return { raw: text, date, time: '', iso: date, timeZone: timeZone || '' };
  if (!timeZone) return { raw: text, date, time, iso: `${date}T${time}`, timeZone: '' };
  const offset = offsetFor(date, time, timeZone);
  return { raw: text, date, time, iso: `${date}T${time}:00${offset}`, timeZone };
}

function resolveTimeZone(order, route) {
  const explicit = cleanCopy(order.timeZone || order.timezone || order.tz || '');
  if (explicit) return explicit;
  const routeZone = cleanCopy(route.timeZone || '');
  if (routeZone) return routeZone;
  const slug = String(route.slug || '');
  if (/^(la|sf)-/.test(slug)) return 'America/Los_Angeles';
  const blob = `${slug} ${route.startLabel || ''} ${route.title || ''} ${order.start || ''}`.toLowerCase();
  if (/\b(california|los angeles|san francisco)\b/.test(blob)) return 'America/Los_Angeles';
  return '';
}

function originLeg(order, route) {
  const orderStart = cleanCopy(order.start ?? order.startPlace ?? '');
  const routeStart = cleanCopy(route.startLabel || '');
  const candidates = [];
  if (Array.isArray(route.originLegs)) {
    for (const leg of route.originLegs) {
      const startName = leg?.start || leg?.from || '';
      if (orderStart && legMatches(orderStart, startName)) candidates.push(leg);
    }
  }
  for (const key of ['originLeg', 'approach']) {
    if (route[key] && typeof route[key] === 'object' && !Array.isArray(route[key])) candidates.push(route[key]);
  }
  for (const stat of route.stats || []) {
    const label = String(stat?.label || '');
    if (String(stat?.unit || '').toLowerCase() !== 'mi') continue;
    if (orderStart && routeStart && placeKey(label).includes(placeKey(orderStart)) && placeKey(label).includes(placeKey(routeStart))) {
      candidates.push({ miles: Number(stat.value), source: stat.source, url: stat.url, checkedOn: stat.checkedOn, from: orderStart, to: routeStart });
    }
  }
  for (const leg of candidates) {
    const miles = Number(leg.miles ?? leg.value);
    const source = leg.source || '';
    const url = httpUrl(leg.url) || httpUrl(route.sources?.[source]?.url);
    const checkedOn = day(leg.checkedOn) || day(route.checked);
    if (!Number.isFinite(miles) || miles < 0 || !url || !checkedOn) continue;
    const note = cleanCopy(leg.note || '');
    return {
      miles,
      url,
      checkedOn,
      source,
      estimate: leg.estimate === true,
      from: cleanCopy(leg.from || leg.start || orderStart),
      to: cleanCopy(leg.to || routeStart),
      ...(note ? { note } : {}),
    };
  }
  return null;
}

function legMatches(orderStart, legStart) {
  const a = placeKey(orderStart);
  const b = placeKey(legStart);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

const PLACE_ALIASES = new Map([
  ['la', 'los angeles'],
  ['los angeles', 'los angeles'],
  ['sf', 'san francisco'],
  ['san francisco', 'san francisco'],
  ['nyc', 'new york'],
  ['new york', 'new york'],
  ['new york city', 'new york'],
]);

function placeKey(value) {
  let text = cleanCopy(value).toLowerCase().replace(/\./g, '');
  text = text.replace(/,/g, ' ').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  text = text.replace(/\s+(ca|az|nv|ny|wa|or|ma|ct|ri|tx|fl|il|pa|nj|va|md|co|ut|id|nm|ok|california|nevada|arizona|washington|oregon|new york)$/, '');
  text = text.trim();
  return PLACE_ALIASES.get(text) || text;
}

function sameTrip(title, from, to) {
  const match = cleanCopy(title).match(/^(.+?)\s+to\s+(.+)$/i);
  if (!match || !from || !to) return false;
  return placeKey(match[1]) === placeKey(from) && placeKey(match[2]) === placeKey(to);
}

const FLIP_DIRECTION = {
  northbound: 'southbound',
  southbound: 'northbound',
  eastbound: 'westbound',
  westbound: 'eastbound',
  northeast: 'southwest',
  northwest: 'southeast',
  southeast: 'northwest',
  southwest: 'northeast',
};

function tripDirection(order, route) {
  const stored = cleanCopy(route.direction || '').toLowerCase();
  if (!FLIP_DIRECTION[stored]) return '';
  return tripIsReverse(order, route) ? FLIP_DIRECTION[stored] : stored;
}

function tripIsReverse(order, route) {
  const start = placeKey(order.start ?? order.startPlace ?? '');
  const end = placeKey(order.end ?? order.endPlace ?? '');
  const match = cleanCopy(route.title || '').match(/^(.+?)\s+to\s+(.+)$/i);
  if (!start || !end || !match) return false;
  return start === placeKey(match[2]) && end === placeKey(match[1]);
}

function applyDirection(text, direction) {
  if (!direction) return text;
  const label = direction.charAt(0).toUpperCase() + direction.slice(1);
  return text.replace(/^(Northbound|Southbound|Eastbound|Westbound|Northeast|Northwest|Southeast|Southwest)\b/, label);
}

function isBlanketClaim(text) {
  return /\bevery\b.+\b(site|charger|stall)/i.test(text) || /at least one charger down/i.test(text);
}

function teslaOnlyTip(skips, route, ctx) {
  if (!skips.length) return null;
  const tip = { text: `Tesla-only sites this car cannot use: ${joinAnd(skips.map((item) => item.name))}.` };
  const first = skips.find((item) => item.url && item.checkedOn) || skips[0];
  if (first.source) tip.source = first.source;
  if (first.url) tip.url = first.url;
  if (first.checkedOn) tip.checkedOn = first.checkedOn;
  const also = [];
  const seen = new Set([first.url].filter(Boolean));
  for (const item of skips) {
    if (item.source) {
      ctx.used.add(item.source);
      if (item.url) ctx.urls.set(item.source, item.url);
    }
    if (!item.url || seen.has(item.url)) continue;
    seen.add(item.url);
    also.push({
      url: item.url,
      name: cleanCopy(route.sources?.[item.source]?.name || 'Source'),
      ...(item.source ? { source: item.source } : {}),
    });
  }
  if (also.length) tip.also = also;
  return tip;
}

function eaProblemTip(route, ctx) {
  const downRe = /\b(out of service|offline|broken|charger down|chargers down)\b/i;
  const eaRe = /electrify america|\bEA\b/;
  const bySite = new Map();
  const add = (site, text, url, date, source) => {
    const cleanSite = cleanCopy(site || '');
    const cleanText = cleanCopy(text || '');
    if (!cleanSite || !cleanText || !downRe.test(cleanText) || !eaRe.test(`${cleanSite} ${cleanText}`)) return;
    const link = httpUrl(url) || httpUrl(route.sources?.[source]?.url);
    const checkedOn = day(date);
    if (!link || !checkedOn) return;
    const key = cleanSite.toLowerCase();
    const row = bySite.get(key) || { name: cleanSite, dates: [], url: link, source: source || '', checkedOn };
    row.dates.push(checkedOn);
    bySite.set(key, row);
  };
  for (const stop of route.stops || []) {
    for (const report of stop.reports || []) {
      add(report.site, report.text, report.url, report.date || report.checkedOn, report.source);
    }
    for (const station of [stop.primary, ...(stop.backups || []), ...(stop.other || [])]) {
      if (!station) continue;
      const network = typeof station.network === 'string' ? station.network : '';
      if (!eaRe.test(network)) continue;
      for (const report of station.driverReports || []) {
        add(station.name, `${network}. ${report.summary || ''}`, report.url, report.date, report.source);
      }
    }
  }
  if (!bySite.size) return null;
  const rows = [...bySite.values()];
  const dates = rows.flatMap((row) => row.dates).sort();
  const range = dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} to ${dates[dates.length - 1]}`;
  const noun = rows.length === 1 ? 'site' : 'sites';
  const first = rows[0];
  const tip = {
    text: `Driver reports (${range}) mention a charger out of service, offline, or broken at ${rows.length} Electrify America ${noun} on this route: ${joinAnd(rows.map((row) => row.name))}. This is a count of those reports, not a live check of every stall.`,
    url: first.url,
    checkedOn: first.checkedOn,
  };
  if (first.source) tip.source = first.source;
  const also = [];
  const seen = new Set([first.url]);
  for (const row of rows) {
    if (row.source) {
      ctx.used.add(row.source);
      if (row.url) ctx.urls.set(row.source, row.url);
    }
    if (!row.url || seen.has(row.url)) continue;
    seen.add(row.url);
    also.push({ url: row.url, name: cleanCopy(route.sources?.[row.source]?.name || 'Source'), ...(row.source ? { source: row.source } : {}) });
  }
  if (also.length) tip.also = also;
  if (tip.source) {
    ctx.used.add(tip.source);
    if (tip.url) ctx.urls.set(tip.source, tip.url);
  }
  return tip;
}

function joinAnd(items) {
  if (items.length <= 1) return items[0] || '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function orderHasPet(order) {
  const blob = `${order?.notes || ''} ${order?.passengers || ''} ${order?.pets || ''}`;
  return PET_RE.test(blob);
}

function chargeLimitOf(order) {
  const raw = order.chargeLimit ?? order.maxCharge ?? order.maxSoc;
  if (raw == null || raw === '') return CHARGE_LIMIT;
  const n = Number(String(raw).replace('%', '').trim());
  if (!Number.isFinite(n) || n < TARGET_ARRIVAL || n > 100) return CHARGE_LIMIT;
  return Math.round(n);
}

function chargeLimitIsDefault(order) {
  const raw = order.chargeLimit ?? order.maxCharge ?? order.maxSoc;
  if (raw == null || raw === '') return true;
  const n = Number(String(raw).replace('%', '').trim());
  return !Number.isFinite(n) || n < TARGET_ARRIVAL || n > 100;
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
    also.push({ url, name: cleanCopy(extra.name || extra.sourceName || 'Source'), ...(extra.source ? { source: extra.source } : {}) });
  }
  return also.length ? also : null;
}

function clockLabel(depart, minutes) {
  if (!depart?.time) return null;
  const [year, month, dayOf] = depart.date.split('-').map(Number);
  const [hour, minute] = depart.time.split(':').map(Number);
  const utc = depart.timeZone
    ? wallToUtc(year, month, dayOf, hour, minute, depart.timeZone)
    : Date.UTC(year, month - 1, dayOf, hour, minute);
  return formatClock(new Date(utc + minutes * 60 * 1000), depart.timeZone || 'UTC', depart.date);
}

function wallToUtc(year, month, dayOf, hour, minute, timeZone) {
  let utc = Date.UTC(year, month - 1, dayOf, hour, minute);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  for (let i = 0; i < 4; i += 1) {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(utc)).map((part) => [part.type, part.value]));
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour === 24 ? 0 : +parts.hour, +parts.minute);
    const wanted = Date.UTC(year, month - 1, dayOf, hour, minute);
    const diff = wanted - asUtc;
    if (diff === 0) return utc;
    utc += diff;
  }
  return utc;
}

function offsetFor(date, time, timeZone) {
  const [year, month, dayOf] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const utc = wallToUtc(year, month, dayOf, hour, minute, timeZone);
  const wallAsUtc = Date.UTC(year, month - 1, dayOf, hour, minute);
  const offMin = Math.round((wallAsUtc - utc) / 60000);
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

function formatClock(date, timeZone, startDate) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((part) => [part.type, part.value]));
  const hour = parts.hour === '24' ? '00' : parts.hour;
  const dayText = `${parts.year}-${parts.month}-${parts.day}`;
  return `${hour}:${parts.minute}${dayText === startDate ? '' : ' the next day'}`;
}

function kilowatts(value) {
  const text = String(value || '');
  const upTo = text.match(/up to\s+(\d+(?:\.\d+)?)\s*kW/i);
  const kw = text.match(/(\d+(?:\.\d+)?)\s*kW/i);
  const n = Number((upTo || kw)?.[1]);
  return Number.isFinite(n) ? n : 0;
}

function ceilPct(value) {
  return Math.min(100, Math.max(0, Math.ceil(value - 1e-9)));
}

function trimNum(value) {
  const n = Math.round(Number(value) * 10) / 10;
  return Number.isInteger(n) ? String(n) : String(n);
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

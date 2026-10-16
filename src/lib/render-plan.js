// Renders an approved plan from the JSON stored in plan_drafts.body.
// Same spec-sheet classes as the guides. A fact shows a source link and a
// checked-on date only when that fact (or its source id) provides them.
import { esc, fmtDate, tag, routeLine } from './render-guide.js';

const LEAVE_FIELDS = ['target', 'leaveWith', 'targetCharge'];

export function parsePlan(body) {
  if (typeof body !== 'string' || !body.trim()) return null;
  let data;
  try { data = JSON.parse(body); } catch { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.plan && typeof data.plan === 'object' && !Array.isArray(data.plan)) return data.plan;
  return data;
}

export function unavailablePlan() {
  return `<section class="band band--tight"><div class="wrap"><h1 class="h1">This plan can't be shown yet.</h1><p class="lede" style="margin-top:18px">The link works, but this plan is not ready to view here. Reply to the email your plan came in if you need another copy.</p></div></section>`;
}

export function safeUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString();
  } catch {
    return '';
  }
}

function prettyDay(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const day = raw.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return fmtDate(day);
  return raw.length > 48 ? raw.slice(0, 48) : raw;
}

function checkedLabel(fact) {
  if (!fact || typeof fact !== 'object') return '';
  const raw = fact.checkedOn || fact.checked_on || (typeof fact.checked === 'string' ? fact.checked : '');
  const pretty = prettyDay(raw);
  return pretty ? `Checked ${pretty}` : '';
}

function addSource(map, key, name, url) {
  const safe = safeUrl(url);
  if (!safe) return;
  const label = String(name || key || 'Source');
  if (key) map[String(key)] = { name: label, url: safe };
  if (label) map[label] = { name: label, url: safe };
}

export function sourceMap(plan, draftSources) {
  const map = {};
  const raw = plan?.sources;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw)) addSource(map, key, value?.name || value?.label, value?.url);
  } else if (Array.isArray(raw)) {
    raw.forEach((source, i) => addSource(map, source?.label || source?.name || String(i), source?.label || source?.name, source?.url));
  }
  if (Array.isArray(draftSources)) {
    draftSources.forEach((source, i) => addSource(map, source?.label || source?.name || String(i), source?.label || source?.name, source?.url));
  }
  return map;
}

function resolveSource(source, sources) {
  if (!source) return null;
  if (typeof source === 'object') {
    const url = safeUrl(source.url);
    if (!url) return null;
    return { url, name: source.name || source.label || 'Source' };
  }
  const key = String(source);
  const direct = safeUrl(key);
  if (direct) return { url: direct, name: 'Source' };
  const hit = sources?.[key];
  if (!hit?.url) return null;
  return { url: hit.url, name: hit.name || 'Source' };
}

function sourceLinks(fact, sources) {
  if (!fact || typeof fact !== 'object') return [];
  const links = [];
  const seen = new Set();
  const push = (url, name) => {
    const safe = safeUrl(url);
    if (!safe || seen.has(safe)) return;
    seen.add(safe);
    links.push({ url: safe, name: name || 'Source' });
  };
  push(fact.url || fact.sourceUrl || fact.source_url, fact.sourceName || fact.source_name || fact.sourceLabel || 'Source');
  const resolved = resolveSource(fact.source, sources);
  if (resolved) push(resolved.url, fact.sourceName || fact.source_name || resolved.name);
  for (const extra of fact.also || []) {
    const extraResolved = resolveSource(extra?.source, sources);
    push(extra?.url || extraResolved?.url, extra?.name || extra?.sourceName || extraResolved?.name || 'Source');
  }
  return links;
}

function ext(url, text) {
  return `<a class="src" href="${esc(url)}" rel="nofollow noopener noreferrer" target="_blank">${esc(text)}</a>`;
}

function factBits(fact, sources) {
  if (!fact || typeof fact !== 'object') return '';
  const bits = [];
  const repeatsUnknown = fact.status === 'unverified' && fieldValue(fact).trim() === 'Not yet verified';
  if (fact.status && fact.status !== 'verified' && !repeatsUnknown) bits.push(tag(fact.status));
  if (fact.note) bits.push(`<span class="sheet__note small muted">${esc(fact.note)}</span>`);
  for (const link of sourceLinks(fact, sources)) bits.push(ext(link.url, link.name));
  const checked = checkedLabel(fact);
  if (checked) bits.push(`<span class="small muted">${esc(checked)}</span>`);
  return bits.join('');
}

function sheetRow(label, value, fact, sources, extra = '') {
  const shown = value == null ? '' : String(value);
  if (!shown.trim()) return '';
  return `<div class="sheet__row"><dt>${esc(label)}</dt><dd><span>${esc(shown)}</span>${extra}${factBits(fact, sources)}</dd></div>`;
}

function fieldRow(label, field, sources) {
  if (field == null || field === '') return '';
  if (typeof field === 'object') return sheetRow(label, field.value, field, sources);
  return sheetRow(label, field, null, sources);
}

function factRows(facts, sources) {
  if (!Array.isArray(facts)) return '';
  return facts.map((fact) => sheetRow(fact?.label || fact?.name || 'Fact', fact?.value, fact, sources)).join('');
}

const SPEC_FIELDS = [
  ['network', 'Network', 'network'],
  ['address', 'Address', 'address'],
  ['exit', 'Exit', 'exit'],
  ['stalls', 'Stalls', 'stalls'],
  ['power', 'Max power', 'power'],
  ['access', 'Access', 'access'],
  ['price', 'Price', 'price'],
  ['hours', 'Hours', 'hours'],
  ['connectors', 'Connectors', 'connectors'],
  ['plugs', 'Plugs', 'plugs'],
];

function fieldValue(field) {
  if (field == null || field === '') return '';
  if (typeof field === 'object') return field.value == null ? '' : String(field.value);
  return String(field);
}

function joinLabels(names) {
  const shown = names.map((name, index) => (index === 0 ? name.charAt(0).toUpperCase() + name.slice(1) : name));
  if (shown.length <= 1) return shown[0] || '';
  if (shown.length === 2) return `${shown[0]} and ${shown[1]}`;
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

function stationRows(station, sources) {
  if (!station || typeof station !== 'object') return '';
  const specs = [];
  for (const [key, label, short] of SPEC_FIELDS) {
    const value = fieldValue(station[key]).trim();
    if (!value) continue;
    specs.push({ label, short, field: station[key], value });
  }
  const unknown = specs.filter((item) => item.value === 'Not yet verified');
  const collapse = unknown.length >= 2;
  const rows = [];
  let collapsed = false;
  for (const item of specs) {
    if (collapse && item.value === 'Not yet verified') {
      if (!collapsed) {
        rows.push(sheetRow(joinLabels(unknown.map((entry) => entry.short)), 'Not yet verified', null, sources));
        collapsed = true;
      }
      continue;
    }
    rows.push(fieldRow(item.label, item.field, sources));
  }
  let leave = '';
  for (const key of LEAVE_FIELDS) {
    leave = fieldRow('Leave with', station[key], sources);
    if (leave) break;
  }
  if (leave) rows.push(leave);
  rows.push(factRows(station.facts, sources));
  return rows.join('');
}

function stationSheet(station, sources) {
  const rows = stationRows(station, sources);
  return rows ? `<dl class="sheet">${rows}</dl>` : '';
}

function tagDate(value) {
  const match = String(value ?? '').trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : undefined;
}

function stationChecked(station, plan) {
  return tagDate(station?.checkedOn || station?.checked || plan?.checked || plan?.checkedOn || '');
}

function rollup(station) {
  const states = ['stalls', 'power', 'access'].map((key) => station?.[key]?.status).filter(Boolean);
  if (!states.length) return '';
  if (states.some((status) => status === 'conflict')) return 'conflict';
  if (states.every((status) => status === 'verified')) return 'verified';
  return 'unverified';
}

function canDrawRoute(plan) {
  if (!plan?.startLabel || !plan?.endLabel || !Array.isArray(plan.stops) || !plan.stops.length) return false;
  const total = Number(plan.stats?.[0]?.value);
  if (!Number.isFinite(total) || total <= 0) return false;
  return plan.stops.every((stop) => stop && stop.id && stop.name != null && Number.isFinite(Number(stop.mile)));
}

function planStats(stats, sources) {
  if (!Array.isArray(stats) || !stats.length) return '';
  return `<dl class="specs">${stats
    .map((stat) => {
      const extra = [sourceLinks(stat, sources).map((link) => ext(link.url, link.name)).join(' '), checkedLabel(stat)]
        .filter(Boolean)
        .join(' ');
      return `<div class="spec"><dt class="spec__l">${esc(stat.label || '')}${
        extra ? `<span class="spec__src">${extra}</span>` : ''
      }</dt><dd class="spec__v">${esc(stat.value)}${stat.unit ? `<span class="spec__u">${esc(stat.unit)}</span>` : ''}</dd></div>`;
    })
    .join('')}</dl>`;
}

function backupList(items, sources, plan) {
  if (!Array.isArray(items) || !items.length) return '';
  return `<ul class="list">${items
    .map((item) => {
      const status = item.status ? tag(item.status, item.status === 'verified' || item.status === 'conflict' ? tagDate(item.checkedOn || item.checked) : undefined) : '';
      const text = typeof item.facts === 'string' ? item.facts : '';
      const meta = [item.network, item.address].filter((part) => typeof part === 'string' && part).join('. ');
      return `<li class="item"><div class="item__top"><strong>${esc(item.name || 'Backup')}</strong><span class="btnrow">${
        item.teslaAccess ? tag(item.teslaAccess) : ''
      }${status}</span></div>${meta ? `<p class="small muted item__meta">${esc(meta)}</p>` : ''}${
        text ? `<p class="item__facts">${esc(text)}</p>` : ''
      }${stationSheet({ ...item, facts: Array.isArray(item.facts) ? item.facts : [] }, sources)}<p class="small item__meta">${factBits(item, sources)}</p></li>`;
    })
    .join('')}</ul>`;
}

function placeSection(title, items, sources) {
  if (!Array.isArray(items) || !items.length) return '';
  return `<h3 class="h3 sub">${esc(title)}</h3><ul class="list">${items
    .map((item) => {
      const name = item?.name || item?.title || title;
      const meta = [item?.address, item?.area].filter((part) => typeof part === 'string' && part).join('. ');
      const text = item?.text || item?.note || (typeof item?.facts === 'string' ? item.facts : '');
      const charger = item?.charger || item?.charging;
      const rows = `${fieldRow('Charging', charger, sources)}${factRows(item?.facts, sources)}`;
      return `<li class="item"><div class="item__top"><strong>${esc(name)}</strong></div>${
        meta ? `<p class="small muted item__meta">${esc(meta)}</p>` : ''
      }${text ? `<p class="item__facts">${esc(text)}</p>` : ''}${rows ? `<dl class="sheet">${rows}</dl>` : ''}<p class="small item__meta">${factBits(item, sources)}</p></li>`;
    })
    .join('')}</ul>`;
}

function stopSection(stop, index, sources, plan) {
  const primary = stop.primary && typeof stop.primary === 'object' ? stop.primary : null;
  const checked = primary ? stationChecked(primary, plan) : stationChecked(stop, plan);
  const status = primary ? rollup(primary) : '';
  const sheet = stationSheet(primary || stop, sources);
  const backups = backupList(stop.backups, sources, plan);
  const places = [
    placeSection('Food', stop.food || stop.meals, sources),
    placeSection('Lodging', stop.hotels || stop.lodging, sources),
    placeSection('Driver notes', stop.driverNotes, sources),
    cautionSections(stop, sources),
  ].join('');
  const others = Array.isArray(stop.other) && stop.other.length
    ? `<details class="other"><summary>Other sites nearby (${stop.other.length})</summary>${backupList(stop.other, sources, plan)}</details>`
    : '';
  const around = Array.isArray(stop.around) && stop.around.length
    ? `<h3 class="h3 sub">Around the stop</h3><ul class="plain">${stop.around
        .map((item) => `<li>${esc(item?.text || item?.value || (typeof item === 'string' ? item : ''))}</li>`)
        .join('')}</ul>`
    : '';
  const id = stop.id || `stop-${index + 1}`;
  return `<section id="stop-${esc(id)}" class="band band--tight stop${index % 2 ? ' band--mist' : ''}"><div class="wrap">
<header class="stop__head"><span class="stop__num">${index + 1}</span><div><h2 class="h2">${esc(stop.name || 'Stop')}</h2>${
    stop.towns ? `<p class="muted" style="margin:6px 0 0">${esc(stop.towns)}</p>` : ''
  }</div>${
    stop.mile != null
      ? `<div class="stop__mile"><span class="num">mile ${esc(stop.mile)}</span>${
          stop.milepostNote ? `<span class="small muted">${esc(stop.milepostNote)}</span>` : ''
        }</div>`
      : ''
  }</header>
${stop.why ? `<p class="stop__why">${esc(stop.why)}</p>` : ''}${stop.note && !(stop.why || '').includes(stop.note) ? `\n<p class="stop__why">${esc(stop.note)}</p>` : ''}
${stop.charging === true ? `<p class="small muted" style="margin-top:8px">Charge at this stop.</p>` : ''}
${stop.charging === false ? `<p class="small muted" style="margin-top:8px">Optional stop. This plan does not charge here.</p>` : ''}
${
  primary
    ? `<div class="panel primary"><div class="primary__top"><div><p class="small muted" style="margin:0 0 4px">Primary charger</p><h3 class="h3">${esc(
        primary.name || 'Primary'
      )}</h3></div><div class="btnrow">${primary.teslaAccess ? tag(primary.teslaAccess) : ''}${
        status ? tag(status, status === 'verified' || status === 'conflict' ? tagDate(checked) : undefined) : ''
      }</div></div>${sheet}</div>`
    : sheet
      ? `<div class="panel primary">${sheet}</div>`
      : ''
}
${
  backups || places || others || around
    ? `<div class="cols"><div>${backups ? `<h3 class="h3 sub">Backups</h3>${backups}` : ''}${others}</div><div>${places}${around}</div></div>`
    : ''
}
</div></section>`;
}

function stopsHtml(stops, sources, plan) {
  if (!Array.isArray(stops) || !stops.length) return '';
  return stops.map((stop, index) => stopSection(stop || {}, index, sources, plan)).join('\n');
}

function cautionSections(stop, sources) {
  if (stop?.primaryCautions || stop?.backupCautions || stop?.otherCautions) {
    return [
      placeSection('Primary cautions', stop.primaryCautions, sources),
      placeSection('Backup cautions', stop.backupCautions, sources),
      placeSection('Other cautions', stop.otherCautions, sources),
    ].join('');
  }
  return placeSection('Cautions', stop?.cautions, sources);
}

function originHtml(plan, sources) {
  const leg = plan?.originLeg;
  if (!leg || typeof leg !== 'object') return '';
  const miles = leg.miles == null ? '' : `${leg.miles} miles`;
  const from = leg.from || 'the start';
  const to = leg.to || plan.startLabel || 'the route start';
  const lead = leg.estimate ? `Estimate: ${miles} from ${from} to ${to}, before the route mile marks.` : `${miles} from ${from} to ${to}, before the route mile marks.`;
  return `\n<p class="small muted" style="margin-top:8px">${esc(lead)} ${factBits(leg, sources)}</p>`;
}

function contingencyHtml(items, sources) {
  if (!Array.isArray(items) || !items.length) return '';
  const groups = [];
  for (const item of items) {
    const title = item?.title || 'Contingency';
    let group = groups.find((entry) => entry.title === title);
    if (!group) {
      group = { title, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  const body = groups.map((group) => `<h3 class="h3">${esc(group.title)}</h3><ul class="tips">${group.items.map((item) => {
    const text = item?.text || '';
    return `<li>${esc(text)} ${factBits(item, sources)}</li>`;
  }).join('')}</ul>`).join('');
  return `<section class="band band--tight"><div class="wrap"><h2 class="h2">Contingency</h2>${body}</div></section>`;
}

function tipsHtml(tips, sources) {
  if (!Array.isArray(tips) || !tips.length) return '';
  return `<section class="band band--tight"><div class="wrap"><h2 class="h2">Notes for this trip</h2><ol class="tips">${tips
    .map((tip) => {
      const text = typeof tip === 'string' ? tip : tip?.text || tip?.value || '';
      return `<li>${esc(text)} ${factBits(typeof tip === 'object' ? tip : null, sources)}</li>`;
    })
    .join('')}</ol></div></section>`;
}

function sourcesFooter(map) {
  const seen = new Set();
  const items = [];
  for (const source of Object.values(map)) {
    if (!source?.url || seen.has(source.url)) continue;
    seen.add(source.url);
    items.push(source);
  }
  if (!items.length) return '';
  return `<section class="band band--tight band--mist"><div class="wrap"><h2 class="h2">Sources</h2><ul class="plain small">${items
    .map((source) => `<li>${ext(source.url, source.name)}</li>`)
    .join('')}</ul></div></section>`;
}

function percentOf(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function showsStrategy(plan, ctx) {
  const label = `${plan?.tier || ''} ${ctx?.tier || ''}`.toLowerCase();
  return /\$39\b|\$79\b/.test(label) || /\bdetailed plan\b|\bmulti-day\b|\bfamily\b/.test(label);
}

function strategyCopy(plan) {
  const strategy = plan?.strategy;
  if (!strategy || typeof strategy !== 'object' || Array.isArray(strategy)) return 'Charging strategy: Not yet verified.';
  const parts = [];
  const stops = Array.isArray(strategy.stops) ? strategy.stops.filter((stop) => stop && stop.name) : [];
  if (stops.length) {
    const bits = stops.map((stop) => (percentOf(stop.departPercent) == null ? stop.name : `${stop.name} to ${percentOf(stop.departPercent)}%`));
    parts.push(stops.length === 1 ? `Charge at ${bits[0]}.` : `Charge at ${bits.join(', then ')}.`);
  } else if (typeof strategy.text === 'string' && strategy.text.trim()) {
    const first = strategy.text.trim().split(/(?<=\.)\s+/)[0];
    parts.push(first.endsWith('.') ? first : `${first}.`);
  }
  const target = percentOf(strategy.targetPercent);
  const reserve = percentOf(strategy.reservePercent);
  if (target != null) parts.push(`Arrival target is ${target}%.`);
  if (reserve != null) parts.push(`Reserve floor is ${reserve}%.`);
  const dest = strategy.destination;
  if (dest && typeof dest === 'object') {
    const arrive = percentOf(dest.arrivePercent);
    const clock = dest.arriveClock ? ` around ${dest.arriveClock}` : '';
    if (dest.ranOut) parts.push(`Estimated arrival at the end${clock}: the assumed range runs out, below the reserve.`);
    else if (arrive != null && dest.belowReserve) parts.push(`Estimated arrival at the end is ${arrive}%${clock}, below the reserve.`);
    else if (arrive != null && dest.belowTarget) parts.push(`Estimated arrival at the end is ${arrive}%${clock}, short of the arrival target.`);
    else if (arrive != null) parts.push(`Estimated arrival at the end is ${arrive}%${clock}.`);
    if ((dest.ranOut || dest.belowReserve || dest.belowTarget) && target != null) parts.push('The arrival target cannot be met.');
  }
  return parts.length ? parts.join(' ') : 'Charging strategy: Not yet verified.';
}

function strategyHtml(plan, ctx) {
  if (!showsStrategy(plan, ctx)) return '';
  return `<section class="band band--tight"><div class="wrap"><h2 class="h2">Charging strategy</h2><p style="margin-top:18px">${esc(strategyCopy(plan))}</p></div></section>`;
}

function metaLine(plan, ctx) {
  const depart = prettyDay(plan.depart || ctx.depart);
  const back = prettyDay(plan.returnDate || plan.return || ctx.returnDate);
  const when = depart && back ? `Leaving ${depart}, back ${back}` : depart ? `Leaving ${depart}` : back ? `Back ${back}` : '';
  return [plan.tier || ctx.tier, plan.car || ctx.car, plan.port || ctx.port, when].filter(Boolean).join('. ');
}

export function renderPlan(plan, ctx = {}) {
  const sources = sourceMap(plan, ctx.draftSources);
  const title = plan.title || (ctx.start && ctx.end ? `${ctx.start} to ${ctx.end}` : 'Your plan');
  const checked = prettyDay(plan.checked || plan.checkedOn);
  const bits = metaLine(plan, ctx);
  const route = canDrawRoute(plan)
    ? `<section class="band band--tight band--mist"><div class="wrap"><div class="panel" style="padding: clamp(18px, 3vw, 32px)">${routeLine(plan)}</div>${
        plan.startNote ? `<p class="small muted" style="margin-top:12px">${esc(plan.startNote)}</p>` : ''
      }</div></section>`
    : '';
  const topFacts = factRows(plan.facts, sources);
  const days = Array.isArray(plan.days)
    ? plan.days
        .map((day) => {
          const label = day?.title || day?.name || 'Day';
          const when = prettyDay(day?.date || day?.depart);
          return `<section class="band band--tight"><div class="wrap"><h2 class="h2">${esc(label)}</h2>${
            when ? `<p class="muted" style="margin-top:8px">${esc(when)}</p>` : ''
          }</div></section>${stopsHtml(day?.stops, sources, plan)}`;
        })
        .join('\n')
    : '';
  return `<section class="band band--tight"><div class="wrap">
<p class="muted" style="margin-bottom:14px">Custom plan${plan.highway ? ` <span aria-hidden="true">/</span> ${esc(plan.highway)}` : ''}</p>
<h1 class="h1">${esc(title)}</h1>
${plan.summary ? `<p class="lede" style="margin-top:18px">${esc(plan.summary)}</p>` : ''}
${bits ? `<p class="small muted" style="margin-top:14px">${esc(bits)}</p>` : ''}
${checked ? `<p class="small muted" style="margin-top:8px">Station facts checked ${esc(checked)}. Each fact below links its source and shows the date that fact was checked.</p>` : ''}
${plan.dataChecked ? `<p class="small muted" style="margin-top:8px">Data checked ${esc(plan.dataChecked)}.</p>` : ''}${originHtml(plan, sources)}
${topFacts ? `<div class="panel primary" style="margin-top:28px">${`<dl class="sheet">${topFacts}</dl>`}</div>` : ''}
<div style="margin-top:40px">${planStats(plan.stats, sources)}</div>
</div></section>
${strategyHtml(plan, ctx)}
${route}
${stopsHtml(plan.stops, sources, plan)}
${days}
${placeSection('Food', plan.food || plan.meals, sources) ? `<section class="band band--tight"><div class="wrap">${placeSection('Food', plan.food || plan.meals, sources)}${placeSection('Lodging', plan.hotels || plan.lodging, sources)}</div></section>` : placeSection('Lodging', plan.hotels || plan.lodging, sources) ? `<section class="band band--tight"><div class="wrap">${placeSection('Lodging', plan.hotels || plan.lodging, sources)}</div></section>` : ''}
${contingencyHtml(plan.contingency, sources)}
${tipsHtml(plan.tips || plan.notes, sources)}
${sourcesFooter(sources)}`;
}

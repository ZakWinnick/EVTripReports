// Renders guide HTML from route data.
// Used at build time by the Astro pages and at request time by the Pages Functions,
// so a guide published to D1 looks exactly like one built into the site.
import { newsletterForm } from './newsletter.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

// Network and DOE names use an en dash between the town and the site.
// Swap that for the ASCII hyphen those names already use elsewhere.
// Driver-report quotes stay verbatim.
const SPACED_DASH = / [\u2013\u2014] /g;

export function normalizeDisplayDashes(value) {
  return String(value ?? '').replace(SPACED_DASH, ' - ');
}

function isDriverQuote(node, key) {
  if (!node || typeof node !== 'object') return false;
  if (key === 'summary' && typeof node.url === 'string' && typeof node.source === 'string' && typeof node.date === 'string') return true;
  if (key === 'text' && typeof node.who === 'string' && typeof node.date === 'string') return true;
  return false;
}

function normalizeDisplayNode(node) {
  if (Array.isArray(node)) {
    for (const item of node) normalizeDisplayNode(item);
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string') {
      if (!isDriverQuote(node, key)) node[key] = normalizeDisplayDashes(value);
    } else if (value && typeof value === 'object') {
      normalizeDisplayNode(value);
    }
  }
}

function forDisplay(value) {
  const copy = structuredClone(value);
  normalizeDisplayNode(copy);
  return copy;
}

function slashLinkBase(linkBase) {
  const base = String(linkBase ?? '');
  if (!base || base.endsWith('/') || base.startsWith('#')) return base;
  return `${base}/`;
}

export const fmtDate = (d) =>
  d ? new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '';

const TAG = {
  verified: (c) => (c ? `Verified ${fmtDate(c)}` : 'Verified'),
  conflict: (c) => (c ? `Sources conflict, checked ${fmtDate(c)}` : 'Sources conflict'),
  unverified: () => 'Not yet verified',
  unpublished: () => 'Not published by network',
  'tesla-only': () => 'Tesla only',
  open: () => 'Open to all EVs',
};
export const tag = (status, checked) =>
  `<span class="tag tag--${esc(status)}">${esc(TAG[status] ? TAG[status](checked) : status)}</span>`;

const ext = (url, text, cls = '') =>
  `<a${cls ? ` class="${cls}"` : ''} href="${esc(url)}" rel="nofollow noopener" target="_blank">${esc(text)}</a>`;

const REPORT_LABEL = { plugshare: 'PlugShare', x: 'X', reddit: 'Reddit', forum: 'Forum' };

// Kept notes say what happened. Under 30 characters, or a question that does not
// report an outcome, is dropped at render time.
export const MIN_DRIVER_REPORT_CHARS = 30;

const QUESTION_START =
  /^(do|does|did|is|are|was|were|can|could|would|will|has|have|had|anyone|any|what|when|where|why|how|which)\b/i;
const THANKS = /^(thanks?(?:\s+you)?|thank you|ty)[.!\s]*$/i;
const UPDATE_ASK =
  /\b(would love an update|any update|please update|let me know|just wondering|just curious|traveling through|passing through)\b/i;
const LEAD_FACT =
  /\b(slow|fast|down|broken|fail(?:ed)?|error|offline|derat\w*|wait(?:ed|ing)?|queue|full|packed|busy|iced|blocked|stalls?|chargers?|dispensers?|connectors?|\d+\s*kW|\$\s*\d)\b/i;

export function isBareDriverQuestion(summary) {
  const text = String(summary ?? '').replace(/\s+/g, ' ').trim();
  if (!text.includes('?')) return false;
  const parts = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 && parts.every(isNonReportSentence);
}

function isNonReportSentence(sentence) {
  const s = sentence.trim();
  if (THANKS.test(s)) return true;
  if (QUESTION_START.test(s)) return true;
  if (/\?\s*$/.test(s)) {
    const comma = s.indexOf(',');
    const lead = comma === -1 ? '' : s.slice(0, comma).trim();
    if (lead.length >= 8 && LEAD_FACT.test(lead) && !QUESTION_START.test(lead)) return false;
    return true;
  }
  if (UPDATE_ASK.test(s) && !/\d/.test(s)) return true;
  return false;
}

export function driverReportSummaryOk(summary) {
  const text = String(summary ?? '').trim();
  return text.length >= MIN_DRIVER_REPORT_CHARS && !isBareDriverQuestion(text);
}

// A report dated on this day is exactly 3 years old, so it still shows.
export function driverReportCutoff(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear() - 3, now.getUTCMonth(), now.getUTCDate())).toISOString().slice(0, 10);
}

function recentReportDate(date, cutoff) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= cutoff;
}

function stationDriverReports(station) {
  if (!station || !Array.isArray(station.driverReports)) return [];
  return station.driverReports.filter(
    (r) => r && r.url && r.date && REPORT_LABEL[r.source] && driverReportSummaryOk(r.summary)
  );
}

function collectDriverReports(stop, cutoff) {
  const out = [];
  const take = (station) => {
    for (const r of stationDriverReports(station)) {
      if (!recentReportDate(r.date, cutoff)) continue;
      out.push({ ...r, about: station.name || '' });
    }
  };
  take(stop.primary);
  (stop.backups || []).forEach(take);
  (stop.other || []).forEach(take);
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const seen = new Set();
  return out.filter((r) => {
    const key = `${r.url}\n${r.date}\n${r.summary}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function legacyDriverReports(stop, cutoff) {
  return (stop.reports || []).filter((r) => r && r.text && recentReportDate(r.date, cutoff));
}

function driverReportItem(r) {
  return `<li class="report"><p class="report__text">${esc(r.summary)}</p><p class="small muted" style="margin:0">Driver report, <time datetime="${esc(r.date)}">${esc(
    fmtDate(r.date)
  )}</time>, ${ext(r.url, REPORT_LABEL[r.source])}. About: ${esc(r.about)}</p></li>`;
}

function legacyReportItem(r, src) {
  return `<li class="report"><p class="report__text">${esc(r.text)}</p><p class="small muted" style="margin:0">Driver report, <time datetime="${esc(r.date)}">${esc(
    fmtDate(r.date)
  )}</time>, ${esc(r.who)} on ${ext(src(r.source).url, r.where)}. About: ${esc(r.site)}</p></li>`;
}

function reportEntries(driverReports, legacyReports, src) {
  const items = [
    ...driverReports.map((r) => ({ date: r.date, html: driverReportItem(r) })),
    ...legacyReports.map((r) => ({ date: r.date, html: legacyReportItem(r, src) })),
  ];
  items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return items.map((item) => item.html).join('');
}

export function statStrip(stats) {
  return `<dl class="specs">${stats
    .map(
      (s) =>
        `<div class="spec"><dt class="spec__l">${esc(s.label)}</dt><dd class="spec__v">${esc(s.value)}${
          s.unit ? `<span class="spec__u">${esc(s.unit)}</span>` : ''
        }</dd></div>`
    )
    .join('')}</dl>`;
}

export function routeTotal(route) {
  return Number(route.stats[0].value);
}

export function routeLine(route, linkBase = '') {
  route = forDisplay(route);
  const stops = route.stops;
  const total = routeTotal(route);
  const W = 1000, X0 = 36, X1 = 964, Y = 96;
  const x = (m) => X0 + (m / total) * (X1 - X0);
  const href = (id) => esc(`${slashLinkBase(linkBase)}#stop-${id}`);

  const placed = stops.map((s, i) => {
    const prev = stops[i - 1];
    return { ...s, n: i + 1, cx: x(s.mile), above: prev ? x(s.mile) - x(prev.mile) < 70 : false };
  });
  const points = [{ mile: 0 }, ...stops, { mile: total }];
  const segments = points
    .slice(1)
    .map((p, i) => ({ mid: x((points[i].mile + p.mile) / 2), d: Math.round(p.mile - points[i].mile) }))
    .filter((s) => s.d >= 28);
  const ticks = [];
  for (let m = 25; m < total; m += 25) ticks.push(m);

  const t = (xx, y, size, fill, anchor, text, weight) =>
    `<text x="${xx}" y="${y}" font-size="${size}"${weight ? ` font-weight="${weight}"` : ''} fill="${fill}" text-anchor="${anchor}">${esc(text)}</text>`;

  const svg = [
    `<svg class="route__h" viewBox="0 0 ${W} 180" aria-hidden="true">`,
    ...ticks.map((m) => `<line x1="${x(m)}" x2="${x(m)}" y1="${Y - 5}" y2="${Y + 5}" stroke="#b9bfbb" stroke-width="1"/>`),
    `<line x1="${X0}" x2="${X1}" y1="${Y}" y2="${Y}" stroke="#15191a" stroke-width="3" stroke-linecap="round"/>`,
    `<circle cx="${X0}" cy="${Y}" r="6" fill="#ffffff" stroke="#15191a" stroke-width="3"/>`,
    `<rect x="${X1 - 7}" y="${Y - 7}" width="14" height="14" fill="#15191a"/>`,
    t(X0 - 6, Y - 52, 13, '#4e5653', 'start', route.startLabel),
    t(X0 - 6, Y - 34, 13, '#686f6c', 'start', 'mile 0'),
    t(X1 + 6, Y - 52, 13, '#4e5653', 'end', route.endLabel),
    t(X1 + 6, Y - 34, 13, '#686f6c', 'end', `mile ${total}`),
    ...segments.map((s) => t(s.mid, Y - 14, 12, '#686f6c', 'middle', `${s.d} mi`)),
    ...placed.map(
      (s) =>
        `<a href="${href(s.id)}" tabindex="-1"><g class="route__stop"><circle cx="${s.cx}" cy="${Y}" r="15" fill="#1e5a3c"/>` +
        t(s.cx, Y + 5, 14, '#ffffff', 'middle', s.n, 700) +
        (s.above
          ? t(s.cx, Y - 52, 15, '#15191a', 'middle', s.name, 700) + t(s.cx, Y - 34, 13, '#4e5653', 'middle', `mile ${s.mile}`)
          : t(s.cx, Y + 40, 15, '#15191a', 'middle', s.name, 700) + t(s.cx, Y + 58, 13, '#4e5653', 'middle', `mile ${s.mile}`)) +
        `</g></a>`
    ),
    `</svg>`,
  ].join('');

  const lastGap = Math.round(total - stops[stops.length - 1].mile);
  const pad = (gap) => Math.max(18, Math.min(gap * 0.9, 110));
  const vertical = [
    `<ol class="route__v">`,
    `<li class="route__end"><span class="route__dot route__dot--start"></span><span><strong>${esc(route.startLabel)}</strong><span class="muted small">mile 0</span></span></li>`,
    ...placed.map((s, i) => {
      const gap = s.mile - (i === 0 ? 0 : stops[i - 1].mile);
      const p = pad(gap);
      return (
        `<li style="--pad:${p}px">` +
        (p >= 28 ? `<span class="route__gap small">${Math.round(gap)} mi</span>` : '') +
        `<a href="${href(s.id)}" class="route__row"><span class="route__num">${s.n}</span><span><strong>${esc(s.name)}</strong><span class="muted small">mile ${esc(s.mile)}</span></span></a></li>`
      );
    }),
    `<li class="route__end" style="--pad:${pad(lastGap)}px"><span class="route__gap small">${lastGap} mi</span><span class="route__dot route__dot--end"></span><span><strong>${esc(route.endLabel)}</strong><span class="muted small">mile ${total}</span></span></li>`,
    `</ol>`,
  ].join('');

  return `<figure class="route" aria-label="${esc(
    `Route line from ${route.startLabel} to ${route.endLabel}, ${total} miles, with ${stops.length} charging areas`
  )}">${svg}${vertical}</figure>`;
}

export function guideMeta(route) {
  return {
    title: `${route.title} EV charging guide (${route.highway}) | EV Trip Reports`,
    description: `Stop-by-stop EV charging guide for ${route.title} on ${route.highway}. Stall counts, kW, access and prices checked against each network on ${fmtDate(route.checked)}.`,
  };
}

export function guideStructuredData(route, pageUrl) {
  const url = String(pageUrl);
  const meta = guideMeta(route);
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://evtripreports.com/' },
          { '@type': 'ListItem', position: 2, name: route.highway, item: url },
        ],
      },
      {
        '@type': 'Article',
        headline: route.title,
        dateModified: route.checked,
        description: meta.description,
        mainEntityOfPage: url,
        author: {
          '@type': 'Organization',
          name: 'EV Trip Reports',
          url: 'https://evtripreports.com/',
        },
      },
    ],
  };
}

export function guideJsonLd(route, pageUrl) {
  const json = JSON.stringify(guideStructuredData(route, pageUrl)).replace(/</g, '\\u003c');
  return `<script type="application/ld+json">${json}</script>`;
}

function primaryRollup(p) {
  const states = ['stalls', 'power', 'access'].map((k) => p[k]?.status);
  if (states.some((st) => st === 'conflict')) return 'conflict';
  if (states.every((st) => st === 'verified')) return 'verified';
  return 'unverified';
}

function stationChecked(station, route) {
  return station?.checkedOn || route.checked;
}

function addFactSources(ids, fact) {
  if (!fact) return;
  if (fact.source) ids.add(fact.source);
  for (const extra of fact.also || []) if (extra?.source) ids.add(extra.source);
}

function factBits(fact) {
  if (!fact) return '';
  const bits = [];
  if (fact.status && fact.status !== 'verified') bits.push(tag(fact.status));
  if (fact.note) bits.push(`<span class="sheet__note small muted">${esc(fact.note)}</span>`);
  if (fact.url) bits.push(ext(fact.url, 'Source', 'src'));
  for (const extra of fact.also || []) {
    if (extra?.url) bits.push(ext(extra.url, extra.name || 'Source', 'src'));
  }
  return bits.join('');
}

function stopSection(route, s, i) {
  const S = route.sources;
  const src = (id) => S[id] || { name: id, url: '' };
  const p = s.primary;
  const checked = stationChecked(p, route);
  const longMileNote = String(s.milepostNote || '').length > 140;
  const rollup = primaryRollup(p);
  const rows = [
    { k: 'Network', v: p.network },
    { k: 'Address', v: p.address },
    { k: 'Exit', v: p.exit, status: p.exit === 'Not yet verified' ? 'unverified' : undefined },
    { k: 'Stalls', v: p.stalls.value, f: p.stalls },
    { k: 'Max power', v: p.power.value, f: p.power },
    { k: 'Access', v: p.access.value, f: p.access },
    { k: 'Price', v: p.price.value, f: p.price },
  ];
  const ids = new Set();
  ['stalls', 'power', 'access', 'price'].forEach((k) => addFactSources(ids, p[k]));
  s.backups.forEach((b) => b.source && ids.add(b.source));
  if (s.other.length) ids.add('afdc');
  const cutoff = driverReportCutoff();
  const driverReports = collectDriverReports(s, cutoff);
  const legacyReports = legacyDriverReports(s, cutoff);
  legacyReports.forEach((r) => r.source && ids.add(r.source));
  s.around.forEach((a) => ids.add(a.source));
  // One line per URL in "Sources for this stop": a named source (for example a PlugShare
  // location cited by an around-the-stop note) wins over a driver report with the same link.
  const seenSourceUrls = new Set();
  const sources = [];
  for (const x of [...ids].map((id) => S[id]).filter(Boolean)) {
    if (x.url && seenSourceUrls.has(x.url)) continue;
    if (x.url) seenSourceUrls.add(x.url);
    sources.push(x);
  }
  const reportSources = [];
  for (const r of driverReports) {
    if (seenSourceUrls.has(r.url)) continue;
    seenSourceUrls.add(r.url);
    reportSources.push({ name: `Driver report, ${REPORT_LABEL[r.source]}: ${r.about}`, url: r.url });
  }
  const backupItems = s.backups.map(
    (b) =>
      `<li class="item"><div class="item__top"><strong>${esc(b.name)}</strong><span class="btnrow">${b.teslaAccess ? tag(b.teslaAccess) : ''}${tag(
        b.status,
        b.status === 'verified' || b.status === 'conflict' ? stationChecked(b, route) : undefined
      )}</span></div>
<p class="small muted item__meta">${esc(b.network)}. ${esc(b.address)}</p><p class="item__facts">${esc(b.facts)}</p>
<p class="small item__meta">${esc(String(b.access).replace(/\.$/, ''))}. ${
        b.url ? ext(b.url, `Source: ${src(b.source).name}`) : `<span class="muted">Source: ${esc(src(b.source).name)}</span>`
      }</p></li>`
  );
  const firstBackup = backupItems[0] || '<li class="small muted">No backup confirmed on a network locator for this stop yet.</li>';
  const directions = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${p.name}, ${p.address || s.towns || ''}`)}`;
  const correction = `mailto:admin@evtripreports.com?subject=${encodeURIComponent(`Guide correction: ${route.title} / ${s.name}`)}`;
  const reportsCount = driverReports.length + legacyReports.length;
  return `<section id="stop-${esc(s.id)}" class="band band--tight stop"><div class="wrap">
<header class="stop__head"><span class="stop__num">${i + 1}</span><div><h2 class="h2">${esc(s.name)}</h2><p class="muted" style="margin:6px 0 0">${esc(s.towns)}</p></div>
<div class="stop__mile"><span class="num">mile ${esc(s.mile)}</span><span class="small muted">${longMileNote ? 'Exit and mile-marker notes below' : esc(s.milepostNote)}</span></div></header>
<p class="stop__why">${esc(s.why)}</p>
<div class="stop-grid"><div class="panel primary"><div class="primary__top"><div><p class="small muted" style="margin:0 0 5px">Primary charger</p><h3 class="h3">${esc(p.name)}</h3></div>
<div class="btnrow">${p.teslaAccess ? tag(p.teslaAccess) : ''}${tag(rollup, rollup === 'verified' || rollup === 'conflict' ? checked : undefined)}</div></div>
<dl class="sheet">${rows.map((r) => `<div class="sheet__row"><dt>${esc(r.k)}</dt><dd><span>${esc(r.v)}</span>${factBits(r.f)}${r.status ? tag(r.status) : ''}</dd></div>`).join('')}</dl>
<div class="primary-actions">${ext(directions, 'Open in maps ↗', 'pill')}${p.stalls?.url ? ext(p.stalls.url, 'Check with the network', 'text-link') : ''}</div></div>
<aside class="stop-sidebar" aria-label="Backup and local notes for ${esc(s.name)}"><h3 class="eyebrow">Backup to consider</h3><p class="small muted">Check its access requirements for your car.</p><ul class="list">${firstBackup}</ul>
${s.around.length ? `<div class="around-compact"><h3>Around the stop</h3><ul>${s.around.map((x) => `<li>${esc(x.text)}</li>`).join('')}</ul></div>` : '<p class="small muted" style="margin-top:20px">Food and restroom details have not been confirmed for this stop.</p>'}</aside></div>
<div class="stop-evidence">
${longMileNote ? `<details><summary>Mile marker and exit notes</summary><p class="small">${esc(s.milepostNote)}</p></details>` : ''}
${backupItems.length > 1 ? `<details><summary>More backups (${backupItems.length - 1})</summary><ul class="list">${backupItems.slice(1).join('')}</ul></details>` : ''}
${s.other.length ? `<details><summary>Other DC sites nearby (${s.other.length})</summary><p class="report-note">Check the status labels: these sites may include unverified details or conflicting sources.</p><ul class="list">${s.other.map((o) => `<li class="item"><div class="item__top"><strong>${esc(o.name)}</strong><span class="btnrow">${o.teslaAccess ? tag(o.teslaAccess) : ''}${tag(o.status, o.status === 'verified' || o.status === 'conflict' ? stationChecked(o, route) : undefined)}</span></div><p class="item__facts small">${esc(o.facts)}${o.url ? ` ${ext(o.url, 'Source', 'src')}` : ''}</p></li>`).join('')}</ul></details>` : ''}
<details><summary>Driver reports (${reportsCount})</summary><p class="report-note">Dated experiences from individual drivers, not live availability. Read the date and station name before relying on a report.</p>${reportsCount ? `<ul class="list">${reportEntries(driverReports, legacyReports, src)}</ul>` : '<p class="small muted">No recent driver reports found for this stop yet.</p>'}</details>
<details><summary>Sources for this stop</summary><ul class="plain small">${[...sources.map((x) => `<li>${ext(x.url, x.name)}</li>`), ...reportSources.map((x) => `<li>${ext(x.url, x.name)}</li>`)].join('')}</ul></details></div>
<p class="stop-footer">Something changed? <a href="${esc(correction)}">Report an issue with this stop</a>.</p>
</div></section>`;
}

function arrivalNote(route) {
  return String(route.arrival || 'Check charging at your destination before you leave.').trim();
}

export function guideMain(route) {
  route = forDisplay(route);
  const S = route.sources;
  return `<section class="guide-hero"><div class="wrap">
<div class="guide-hero__top"><p class="eyebrow"><a href="/">EV Trip Reports</a> / ${esc(route.highway)}</p><div class="guide-tools"><button type="button" data-print>Print guide ↗</button></div></div>
<h1 class="h1">${esc(route.title)}</h1><p class="lede" style="margin-top:20px">${esc(route.summary)}</p>
<div class="guide-boundary"><span><strong>Coverage:</strong> ${esc(route.startLabel)} → ${esc(route.endLabel)}</span><span class="boundary-distance">${esc(route.stats[0].value)} corridor miles · ${route.stops.length} charging areas</span></div>
<p class="checked-note">Station facts checked ${esc(fmtDate(route.checked))}. Checked specifications are not live availability. <a href="/methodology/">How we check</a></p></div></section>
<section class="route-overview" aria-label="Route overview"><div class="wrap">${routeLine(route)}
<p class="note">${esc(route.startNote)} The areas below are options, not a requirement to charge at every stop. Choose stops for your car, adapter, and battery level.</p><details class="guide-route-facts"><summary>Route facts and sources</summary>${statStrip(route.stats)}</details></div></section>
<nav class="stop-nav" aria-label="Jump to a charging area"><div class="wrap"><span class="eyebrow">Along the way</span>${route.stops.map((stop, i) => `<a href="#stop-${esc(stop.id)}"><span>${i + 1}</span>${esc(stop.name)}</a>`).join('')}<a href="#route-notes">Trip notes</a></div></nav>
${route.stops.map((stop, i) => stopSection(route, stop, i)).join('\n')}
<section id="route-notes" class="band"><div class="wrap guide-bottom"><div><p class="eyebrow">Before you go</p><h2 class="h2">Trip notes</h2><ol class="tips">${route.tips.map((tip) => `<li>${esc(tip.text)} ${S[tip.source] ? ext(S[tip.source].url, 'Source', 'small') : ''}</li>`).join('')}</ol></div><div><p class="eyebrow">At the other end</p><h2 class="h2">At your destination</h2><p class="note">${esc(arrivalNote(route))}</p><p class="small muted" style="margin-top:20px">This guide covers the endpoints shown above. Allow for the drive to the corridor and onward to your destination.</p></div></div></section>
<section class="band band--tight"><div class="wrap"><div class="plan-cta"><div><p class="eyebrow">Custom planning</p><h2 class="h2">Want a plan for this trip?</h2><p class="lede" style="margin-top:18px">Get a plan for your vehicle, adapter, and dates, with checked charging options and any gaps clearly flagged. Reviewed by a person before delivery.</p></div><div class="btnrow"><a class="pill pill--lg" href="/plans/?route=${esc(route.slug)}#request">Plan this trip</a><a class="text-link" href="/sample-plan/">See a sample</a></div></div></div></section>
<section class="band band--tight newsletter-band" hidden><div class="wrap"><p class="eyebrow">Keep in the loop</p><h2 class="h2">Guide updates</h2>${newsletterForm('newsletter-guide')}</div></section>`;
}

export function guideRegion(slug = '') {
  if (/nyc|boston|^dc-/.test(slug)) return 'Northeast';
  if (/dallas|austin/.test(slug)) return 'Texas';
  if (/chicago|milwaukee/.test(slug)) return 'Midwest';
  return 'West';
}

export function guideSearch(slug = '') {
  return `${slug.replaceAll('-', ' ')} ${/^la-/.test(slug) ? 'Los Angeles' : ''} ${/sf|francisco/.test(slug) ? 'San Francisco Bay Area' : ''} ${/nyc/.test(slug) ? 'New York City' : ''} ${/dc-/.test(slug) ? 'Washington DC' : ''}`;
}

// Home page guide cards. `routes` is a list of { slug, title, highway, status, miles, stops }.
export function guideCards(routes) {
  return forDisplay(routes).map((r) => r.status === 'live'
    ? `<li data-region="${esc(guideRegion(r.slug))}" data-search="${esc(guideSearch(r.slug))}"><a class="guide guide--live" href="/guides/${esc(r.slug)}/"><span class="guide__hw">${esc(r.highway)}</span><div class="guide__body"><span class="guide__t">${esc(r.title)}</span>${r.start && r.end ? `<span class="guide__boundary">${esc(r.start)} → ${esc(r.end)}</span>` : '<span class="guide__boundary">See guide for covered endpoints.</span>'}</div><span class="guide__distance">${esc(r.miles)}<span>corridor miles</span></span><span class="guide__go" aria-hidden="true">→</span></a></li>`
    : '').join('');
}

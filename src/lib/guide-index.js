// Guide index rows for /guides/. Used by the Astro page and by
// functions/guides/[[path]].js when a live D1 row is merged in.
import { esc } from './render-guide.js';

function clean(value) {
  if (value == null) return '';
  const text = String(value).trim();
  if (!text || text === 'null' || text === 'undefined') return '';
  return text;
}

function isDistanceStat(stat) {
  const unit = clean(stat.unit).toLowerCase();
  if (unit === 'mi' || unit === 'mile' || unit === 'miles') return true;
  return /\bmiles?\b/i.test(clean(stat.label));
}

// Route length, when the route file actually has one. A stall count or an
// elevation stat is not a distance.
export function routeDistance(route) {
  if (!route || typeof route !== 'object') return null;
  const stats = Array.isArray(route.stats) ? route.stats : [];
  for (const stat of stats) {
    if (!stat || typeof stat !== 'object' || !isDistanceStat(stat)) continue;
    const value = clean(stat.value);
    if (value) return value;
  }
  for (const key of ['miles', 'distance']) {
    const value = clean(route[key]);
    if (value) return value;
  }
  return null;
}

export function formatDistance(miles) {
  const text = clean(miles);
  if (!text) return '';
  if (/\b(mi|mile|miles)\b/i.test(text)) return text;
  return `${text} mi`;
}

export function guideIndexRecord(route) {
  return {
    slug: clean(route?.slug),
    title: clean(route?.title),
    highway: clean(route?.highway),
    start: clean(route?.startLabel),
    end: clean(route?.endLabel),
    miles: routeDistance(route),
  };
}

function prefer(next, prev) {
  return clean(next) ? next : prev;
}

// Built guides stay in their published order. A live D1 row updates that
// slug, and a slug that was never built is appended in D1 order.
export function mergeGuideIndex(built, d1) {
  const map = new Map();
  const order = [];
  const add = (guide, overwrite) => {
    if (!guide?.slug || !guide.title) return;
    if (!map.has(guide.slug)) {
      map.set(guide.slug, guide);
      order.push(guide.slug);
      return;
    }
    if (!overwrite) return;
    const prev = map.get(guide.slug);
    map.set(guide.slug, {
      slug: guide.slug,
      title: prefer(guide.title, prev.title),
      highway: prefer(guide.highway, prev.highway),
      start: prefer(guide.start, prev.start),
      end: prefer(guide.end, prev.end),
      miles: prefer(guide.miles, prev.miles),
    });
  };
  for (const guide of built || []) add(guide, false);
  for (const guide of d1 || []) add(guide, true);
  return order.map((slug) => map.get(slug));
}

function sheetRow(label, value) {
  if (!value) return '';
  return `<div class="sheet__row"><dt>${esc(label)}</dt><dd><span>${esc(value)}</span></dd></div>`;
}

export function guideIndexList(guides) {
  return (guides || [])
    .filter((guide) => guide?.slug && guide.title)
    .map((guide) => {
      const highway = guide.highway ? `<span class="guide__hw">${esc(guide.highway)}</span>` : '';
      const rows = [
        sheetRow('Start', guide.start),
        sheetRow('End', guide.end),
        sheetRow('Distance', formatDistance(guide.miles)),
      ].filter(Boolean);
      const sheet = rows.length ? `<dl class="sheet">${rows.join('')}</dl>` : '';
      return `<li><a class="panel index-row" href="/guides/${esc(guide.slug)}/"><div class="index-row__head"><h2 class="guide__t">${esc(guide.title)}</h2>${highway}</div>${sheet}<span class="guide__go">Read the guide</span></a></li>`;
    })
    .join('');
}

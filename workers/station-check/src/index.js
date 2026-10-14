// EV Trip Reports station check.
// Weekly: pulls DOE (NLR) DC fast station data for every stop town on each route,
// compares it with the guide and with last week's snapshot, stores a change list in D1,
// and emails it if email is configured. It never edits the site: a person reviews the list.
import { sendMail } from './fastmail.js';

const API = 'https://developer.nlr.gov/api/alt-fuel-stations/v1';
const FIELDS = ['station_name', 'street_address', 'city', 'state', 'status_code', 'access_code', 'ev_network', 'ev_dc_fast_num', 'ev_connector_types', 'date_last_confirmed', 'updated_at', 'facility_type'];
const STATUS = { E: 'open', P: 'planned', T: 'temporarily unavailable' };

const pick = (s) => Object.fromEntries(FIELDS.map((k) => [k, s[k] ?? null]));
const label = (s) => `${s.station_name}, ${s.street_address}, ${s.city} (DOE ${s.id})`;

async function getJSON(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} from ${url.replace(/api_key=[^&]+/, 'api_key=***')}`);
  return res.json();
}

function knownStations(route) {
  const known = new Map();
  for (const stop of route.stops) {
    const add = (ids, name, role) => (ids || []).forEach((id) => known.set(id, { stop: stop.name, name, role }));
    add(stop.primary.afdcIds, stop.primary.name, 'primary');
    stop.backups.forEach((b) => add(b.afdcIds, b.name, 'backup'));
    stop.other.forEach((o) => add(o.afdcIds, o.name, 'other (DOE only)'));
  }
  return known;
}

async function checkRoute(env, slug) {
  const route = await getJSON(`${env.SITE_URL}/data/${slug}.json`);
  const known = knownStations(route);
  const seen = new Map(); // id -> { station, stop }
  const errors = [];

  for (const stop of route.stops) {
    for (const s of stop.searches || []) {
      // DOE dropped the 'location' parameter in 2025; searches use coordinates.
      const qs = new URLSearchParams({
        api_key: env.NLR_API_KEY, latitude: String(s.lat), longitude: String(s.lng), radius: String(s.radius),
        fuel_type: 'ELEC', ev_charging_level: 'dc_fast', status: 'E,P,T', access: 'public', limit: '200',
      });
      try {
        const data = await getJSON(`${API}/nearest.json?${qs}`);
        for (const st of data.fuel_stations || []) if (!seen.has(st.id)) seen.set(st.id, { st, stop: stop.name });
      } catch (e) {
        errors.push(`Search ${s.name}: ${e.message}`);
      }
    }
  }

  // Known stations the searches didn't return: look them up directly.
  for (const id of known.keys()) {
    if (seen.has(id)) continue;
    try {
      const data = await getJSON(`${API}/${id}.json?api_key=${env.NLR_API_KEY}`);
      if (data.alt_fuel_station) seen.set(id, { st: data.alt_fuel_station, stop: known.get(id).stop, direct: true });
    } catch (e) {
      errors.push(`Station ${id} (${known.get(id).name}): ${e.message}`);
    }
  }

  const prev = new Map();
  const rows = await env.DB.prepare('SELECT afdc_id, data FROM station_snapshots WHERE route = ?').bind(slug).all();
  for (const r of rows.results || []) prev.set(r.afdc_id, JSON.parse(r.data));

  const changes = [];
  const add = (kind, stop, text) => changes.push({ kind, stop, text });

  for (const [id, { st, stop }] of seen) {
    const now = pick(st);
    const k = known.get(id);
    if (!k) {
      if (st.status_code === 'E') add('Not in guide', stop, `${label(st)}: ${now.ev_dc_fast_num ?? '?'} DC ports, ${now.ev_network || 'no network listed'}. Verify with the network, then add or exclude.`);
      else if (st.status_code === 'P') add('Coming', stop, `${label(st)} is planned in DOE.`);
      else add('Unavailable, not in guide', stop, `${label(st)} is ${STATUS[st.status_code] || st.status_code} in DOE.`);
      continue;
    }
    if (st.status_code !== 'E') add('Status', k.stop, `${k.name} (${k.role}) shows ${STATUS[st.status_code] || st.status_code} in DOE. Check the network before the next update.`);
    if (st.access_code && st.access_code !== 'public') add('Access', k.stop, `${k.name} (${k.role}) shows access "${st.access_code}" in DOE.`);
    const p = prev.get(id);
    if (p) {
      for (const f of ['ev_dc_fast_num', 'ev_network', 'ev_connector_types', 'status_code', 'access_code', 'street_address']) {
        const a = JSON.stringify(p[f]), b = JSON.stringify(now[f]);
        if (a !== b) add('Changed', k.stop, `${k.name} (${k.role}): ${f} ${a} -> ${b}.`);
      }
    }
  }
  for (const [id, k] of known) {
    if (!seen.has(id)) add('Missing', k.stop, `${k.name} (${k.role}, DOE ${id}) was not returned by DOE. It may be closed or delisted.`);
  }

  const at = new Date().toISOString();
  const stmts = [...seen].map(([id, { st, stop }]) =>
    env.DB.prepare('INSERT INTO station_snapshots (afdc_id, route, stop, data, fetched_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(afdc_id) DO UPDATE SET route = excluded.route, stop = excluded.stop, data = excluded.data, fetched_at = excluded.fetched_at')
      .bind(id, slug, stop, JSON.stringify(pick(st)), at));
  if (stmts.length) await env.DB.batch(stmts);

  const firstRun = prev.size === 0;
  const summary = `${route.title}: ${changes.length} item(s) to review${firstRun ? ' (first run, baseline saved)' : ''}${errors.length ? `, ${errors.length} error(s)` : ''}.`;
  await env.DB.prepare('INSERT INTO check_runs (run_at, route, items, summary, details) VALUES (?, ?, ?, ?, ?)')
    .bind(at, slug, changes.length, summary, JSON.stringify({ changes, errors, guideChecked: route.checked })).run();

  return { slug, title: route.title, guideChecked: route.checked, summary, changes, errors };
}

function render(results) {
  const lines = ['EV Trip Reports station check', `Run: ${new Date().toISOString()}`, ''];
  for (const r of results) {
    lines.push(r.summary, `Guide last checked: ${r.guideChecked}`, '');
    const byKind = {};
    r.changes.forEach((c) => (byKind[c.kind] ||= []).push(c));
    for (const [kind, list] of Object.entries(byKind)) {
      lines.push(`${kind} (${list.length})`);
      list.forEach((c) => lines.push(`  - ${c.stop}: ${c.text}`));
      lines.push('');
    }
    if (r.errors.length) { lines.push('Errors'); r.errors.forEach((e) => lines.push(`  - ${e}`)); lines.push(''); }
  }
  lines.push('DOE data finds sites and flags changes. Stall counts, kW, access and price still need a check on each network\'s own locator before the guide changes.');
  return lines.join('\n');
}

async function notify(env, body) {
  if (!env.FASTMAIL_TOKEN || !env.NOTIFY_TO) return false;
  await sendMail({
    token: env.FASTMAIL_TOKEN,
    from: env.NOTIFY_FROM || env.NOTIFY_TO,
    to: env.NOTIFY_TO,
    subject: `Station check: ${new Date().toISOString().slice(0, 10)}`,
    text: body,
  });
  return true;
}

async function run(env, routes) {
  const results = [];
  for (const slug of routes) {
    try { results.push(await checkRoute(env, slug)); }
    catch (e) { results.push({ slug, title: slug, guideChecked: '?', summary: `${slug}: check failed.`, changes: [], errors: [e.message] }); }
  }
  const body = render(results);
  let emailed = false;
  try { emailed = await notify(env, body); } catch (e) { console.error('email failed', e); }
  return { body, emailed };
}

const list = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean);

export default {
  async scheduled(event, env, ctx) {
    const weekly = list(env.ROUTES_WEEKLY);
    const monthly = new Date().getUTCDate() <= 7 ? list(env.ROUTES_MONTHLY) : [];
    ctx.waitUntil(run(env, [...weekly, ...monthly]));
  },

  // Manual run and latest report, both behind RUN_TOKEN: /run?token=... and /latest?token=...
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!env.RUN_TOKEN || url.searchParams.get('token') !== env.RUN_TOKEN) return new Response('Not found', { status: 404 });
    if (url.pathname === '/run') {
      const { body, emailed } = await run(env, [...list(env.ROUTES_WEEKLY), ...list(env.ROUTES_MONTHLY)]);
      return new Response(`${body}\n\nEmailed: ${emailed}`, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    if (url.pathname === '/latest') {
      const r = await env.DB.prepare('SELECT run_at, route, items, summary, details FROM check_runs ORDER BY id DESC LIMIT 10').all();
      return Response.json(r.results);
    }
    return new Response('Not found', { status: 404 });
  },
};

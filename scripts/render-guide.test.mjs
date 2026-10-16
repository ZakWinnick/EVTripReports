import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import {
  driverReportCutoff,
  driverReportSummaryOk,
  esc,
  guideMain,
  isBareDriverQuestion,
  MIN_DRIVER_REPORT_CHARS,
} from '../src/lib/render-guide.js';

function addDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function fixture(primaryReports, otherReports = [], legacy = []) {
  return {
    title: 'Test route',
    highway: 'I-1',
    checked: '2026-10-14',
    startLabel: 'Start',
    endLabel: 'End',
    summary: 'A test route.',
    startNote: 'Starts here.',
    arrival: '',
    stats: [{ label: 'Miles', value: '10' }],
    sources: { 'ea-locator': { name: 'Electrify America locator', url: 'https://example.com/ea' } },
    tips: [],
    stops: [
      {
        id: 'stop',
        name: 'Stop',
        towns: 'Town',
        mile: 5,
        milepostNote: 'exit 5',
        why: 'Because.',
        primary: {
          name: 'Primary charger',
          network: 'Electrify America',
          address: '1 Main',
          exit: 'Exit 1',
          stalls: { value: '2', status: 'verified', source: 'ea-locator' },
          power: { value: '50 kW', status: 'verified', source: 'ea-locator' },
          access: { value: 'CCS', status: 'verified', source: 'ea-locator' },
          price: { value: 'In the app', status: 'unpublished', source: 'ea-locator' },
          driverReports: primaryReports,
        },
        backups: [],
        other: otherReports,
        reports: legacy,
        around: [],
      },
    ],
  };
}

function reportsBlock(html) {
  const start = html.indexOf('<h3 class="h3 sub">Driver reports</h3>');
  const end = html.indexOf('<h3 class="h3 sub">Sources for this stop</h3>');
  return html.slice(start, end);
}

test('driver reports show a link and date, newest first, and drop entries older than 3 years', () => {
  const cutoff = driverReportCutoff();
  const edge = cutoff;
  const older = addDays(cutoff, -1);
  const mid = addDays(cutoff, 40);
  const newest = addDays(cutoff, 400);
  const html = guideMain(
    fixture(
      [
        { source: 'reddit', url: 'https://example.com/old', date: older, summary: 'Too old to show after the three year cutoff.' },
        { source: 'reddit', url: 'https://example.com/edge', date: edge, summary: 'Exactly three years and still listed here.' },
        { source: 'forum', url: 'https://example.com/mid', date: mid, summary: 'Middle report from the middle check-in.' },
        { source: 'reddit', url: 'https://example.com/new', date: newest, summary: 'Newest report from the latest check-in.' },
      ],
      [],
      [{ date: addDays(cutoff, 80), who: 'Pat', where: 'Forum', source: 'ea-locator', site: 'Primary charger', text: 'Legacy report.' }]
    )
  );
  const block = reportsBlock(html);
  assert.match(block, /<h3 class="h3 sub">Driver reports<\/h3>/);
  assert.doesNotMatch(block, /Too old to show/);
  assert.match(block, /Exactly three years/);
  assert.match(block, /Newest report/);
  assert.match(block, /Middle report/);
  assert.match(block, /Legacy report/);
  assert.ok(block.indexOf('Newest report') < block.indexOf('Legacy report'));
  assert.ok(block.indexOf('Legacy report') < block.indexOf('Middle report'));
  assert.ok(block.indexOf('Middle report') < block.indexOf('Exactly three years'));
  assert.match(block, new RegExp(`<time datetime="${newest}">`));
  assert.match(block, /href="https:\/\/example\.com\/new"/);
  assert.match(block, /Driver report,/);
  assert.doesNotMatch(block, /tag--verified|Verified |network verification|Not yet verified/);
  const sources = html.slice(html.indexOf('Sources for this stop'));
  assert.match(sources, /Driver report, Reddit: Primary charger/);
  assert.match(sources, /Electrify America locator/);
});

test('identical reports on two stations at one stop render once', () => {
  const cutoff = driverReportCutoff();
  const shared = {
    source: 'forum',
    url: 'https://example.com/shared',
    date: addDays(cutoff, 20),
    summary: 'Shared Denny report for both nearby stalls.',
  };
  const html = guideMain(
    fixture(
      [{ source: 'plugshare', url: 'https://example.com/plug', date: addDays(cutoff, 30), summary: 'First check-in found both stalls working.' }, { source: 'plugshare', url: 'https://example.com/plug', date: addDays(cutoff, 10), summary: 'Second check-in found one stall still in use.' }],
      [
        { name: 'Denny DC1', facts: 'ChargePoint', status: 'unverified', driverReports: [shared] },
        { name: 'Denny DC2', facts: 'ChargePoint', status: 'unverified', driverReports: [{ ...shared }] },
      ]
    )
  );
  const block = reportsBlock(html);
  assert.equal(block.split('Shared Denny report for both nearby stalls.').length - 1, 1);
  assert.equal(block.split('https://example.com/shared').length - 1, 1);
  assert.match(block, /First check-in/);
  assert.match(block, /Second check-in/);
  assert.ok(block.indexOf('First check-in') < block.indexOf('Second check-in'));
  const sources = html.slice(html.indexOf('Sources for this stop'));
  assert.equal(sources.split('https://example.com/shared').length - 1, 1);
});

test('corridor guides keep stored reports and hide ones older than 3 years', async () => {
  const cutoff = driverReportCutoff();
  const phoenix = JSON.parse(await readFile(new URL('../src/data/routes/la-to-phoenix.json', import.meta.url), 'utf8'));
  const html = guideMain(phoenix);
  assert.doesNotMatch(html, /—/);
  const blythe = html.split('id="stop-blythe"')[1].split('id="stop-quartzsite"')[0];
  const blytheReports = reportsBlock(blythe);
  const shared = 'https://lucidowners.com/threads/arizona.795/page-51';
  assert.equal(blytheReports.split(shared).length - 1, 1);
  assert.equal(blytheReports.split('shared between 2 stations').length - 1, 1);
  assert.doesNotMatch(blytheReports, /Labor Day weekend 2022/);
  assert.match(blytheReports, /Even though you tap start charge/);
  assert.doesNotMatch(blytheReports, /Could not activate/);
  assert.doesNotMatch(blytheReports, /Does this station work/);
  assert.doesNotMatch(blytheReports, /tag--verified|Verified |network verification/);

  const sections = html.split('<h3 class="h3 sub">Driver reports</h3>').slice(1);
  for (const section of sections) {
    const block = section.split('<h3 class="h3 sub">')[0];
    const dates = [...block.matchAll(/<time datetime="(\d{4}-\d{2}-\d{2})">/g)].map((m) => m[1]);
    for (const date of dates) assert.ok(date >= cutoff, date);
    assert.deepEqual(dates, [...dates].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)));
  }

  const tahoe = JSON.parse(await readFile(new URL('../src/data/routes/sf-to-tahoe.json', import.meta.url), 'utf8'));
  const tahoeHtml = guideMain(tahoe);
  assert.match(tahoeHtml, /Save Mart EA site has only 4 chargers/);
  assert.doesNotMatch(tahoeHtml, /prefers the Davis EA over the Vacaville EA/);
  const davis = tahoe.stops.find((s) => s.id === 'davis');
  assert.ok(davis.primary.driverReports.some((r) => r.summary.includes('prefers the Davis EA')));
});

test('driver report guard rejects short summaries and bare questions', () => {
  assert.equal(MIN_DRIVER_REPORT_CHARS, 30);
  assert.equal(driverReportSummaryOk('Could not activate'), false);
  assert.equal(driverReportSummaryOk('x'.repeat(29)), false);
  assert.equal(driverReportSummaryOk(`  ${'x'.repeat(29)}  `), false);
  assert.equal(driverReportSummaryOk('x'.repeat(30)), true);
  assert.equal(isBareDriverQuestion('Does this station work?'), true);
  assert.equal(
    driverReportSummaryOk('Does this station work? Traveling through the area, and would love an update. Thank you!'),
    false
  );
  assert.equal(driverReportSummaryOk('Anyone know if charger 4 is back online yet?'), false);
  assert.equal(driverReportSummaryOk("Painfully slow, maybe CA limits power when it's hot out?"), true);
  assert.equal(driverReportSummaryOk('Charger 4 is still offline, is anyone else seeing that?'), true);
  assert.equal(driverReportSummaryOk('Stall 3 was derated to 50 kW on this visit.'), true);
  assert.equal(driverReportSummaryOk('App payment failed, but card tap worked.'), true);

  const cutoff = driverReportCutoff();
  const keptDate = addDays(cutoff, 8);
  const html = guideMain(
    fixture([
      { source: 'plugshare', url: 'https://example.com/short', date: addDays(cutoff, 5), summary: 'Could not activate' },
      {
        source: 'plugshare',
        url: 'https://example.com/ask',
        date: addDays(cutoff, 6),
        summary: 'Does this station work? Traveling through the area, and would love an update. Thank you!',
      },
      {
        source: 'plugshare',
        url: 'https://example.com/slow',
        date: addDays(cutoff, 7),
        summary: "Painfully slow, maybe CA limits power when it's hot out?",
      },
      { source: 'plugshare', url: 'https://example.com/derate', date: keptDate, summary: 'Stall 3 was derated to 50 kW on this visit.' },
      { source: 'plugshare', url: 'https://example.com/pay', date: addDays(cutoff, 9), summary: 'App payment failed, but card tap worked.' },
    ])
  );
  const block = reportsBlock(html);
  assert.doesNotMatch(block, /Could not activate/);
  assert.doesNotMatch(block, /Does this station work/);
  assert.doesNotMatch(html, /example\.com\/short/);
  assert.doesNotMatch(html, /example\.com\/ask/);
  assert.match(block, /Painfully slow, maybe CA limits power/);
  assert.match(block, /Stall 3 was derated to 50 kW/);
  assert.match(block, /App payment failed, but card tap worked/);
  assert.match(block, /href="https:\/\/example\.com\/derate"/);
  assert.match(block, new RegExp(`<time datetime="${keptDate}">`));
  assert.match(html, /Driver report, PlugShare: Primary charger/);
});

test('every stored driver report is specific enough to keep', async () => {
  const dir = new URL('../src/data/routes/', import.meta.url);
  const files = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  const bad = [];
  const summaries = [];
  const walk = (node, file) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.driverReports)) {
      for (const report of node.driverReports) {
        summaries.push(report?.summary);
        if (!report?.url || !report?.date || !report?.source || !driverReportSummaryOk(report?.summary)) {
          bad.push(`${file} ${node.name || ''}: ${report?.summary}`);
        }
      }
    }
    if (Array.isArray(node)) node.forEach((child) => walk(child, file));
    else Object.values(node).forEach((value) => {
      if (value && typeof value === 'object') walk(value, file);
    });
  };
  for (const file of files) walk(JSON.parse(await readFile(new URL(file, dir), 'utf8')), file);
  assert.deepEqual(bad, []);
  assert.equal(summaries.includes('Could not activate'), false);
  assert.equal(
    summaries.includes('Does this station work? Traveling through the area, and would love an update. Thank you!'),
    false
  );
  assert.ok(summaries.some((summary) => summary.includes('Charged on stall 7B')));
  assert.ok(summaries.some((summary) => summary.includes('Derated to 180')));
  assert.ok(summaries.some((summary) => summary.includes('Charger 4 is out of order')));
});

// A verified access statement in the fact text. "Not yet verified" leaves the site unflagged
// even when the same sentence also names Tesla only or an adapter.
function teslaAccessFromFacts(facts) {
  const text = String(facts || '');
  if (/Not yet verified/i.test(text)) return null;
  const teslaOnly = /\bTesla only\b/.test(text);
  const openToOthers = /Open to non-Tesla EVs|Open to all EVs/i.test(text);
  const nacsAdapter = /NACS adapter/i.test(text);
  const adapterIncluded = /adapter is included|Adapter Included/i.test(text);
  if (teslaOnly && !openToOthers && !nacsAdapter && !adapterIncluded) return 'tesla-only';
  if (openToOthers && (nacsAdapter || adapterIncluded)) return 'open';
  return null;
}

function teslaSites(route) {
  const sites = [];
  for (const stop of route.stops) {
    for (const role of ['primary', 'backups', 'other']) {
      const items = role === 'primary' ? [stop.primary] : stop[role] || [];
      for (const item of items) {
        if (item && /tesla/i.test(item.name || '')) sites.push(item);
      }
    }
  }
  return sites;
}

function buttonRow(html, name) {
  const escaped = esc(name);
  const strong = `<strong>${escaped}</strong>`;
  const heading = `<h3 class="h3">${escaped}</h3>`;
  const strongAt = html.indexOf(strong);
  const headingAt = html.indexOf(heading);
  assert.equal(strongAt === -1 && headingAt === -1, false, `missing ${name}`);
  assert.equal(strongAt !== -1 && headingAt !== -1, false, `name in two roles ${name}`);
  const at = strongAt === -1 ? headingAt : strongAt;
  const marker = strongAt === -1 ? heading : strong;
  assert.equal(html.indexOf(marker, at + marker.length), -1, `duplicate ${name}`);
  const rest = html.slice(at, at + 900);
  const spanAt = rest.indexOf('<span class="btnrow">');
  const divAt = rest.indexOf('<div class="btnrow">');
  const useSpan = spanAt !== -1 && (divAt === -1 || spanAt < divAt);
  const start = useSpan ? spanAt : divAt;
  assert.ok(start !== -1, `no button row ${name}`);
  const open = useSpan ? '<span class="btnrow">' : '<div class="btnrow">';
  const close = useSpan ? '</span></div>' : '</div></div>';
  const end = rest.indexOf(close, start);
  assert.ok(end !== -1, `no button row end ${name}`);
  return rest.slice(start + open.length, end);
}

test('verified Tesla access statements render the matching tag', async () => {
  const expectedCounts = {
    'dc-to-nyc': { open: 49, 'tesla-only': 14, none: 6 },
    'las-vegas-to-salt-lake-city': { open: 11, 'tesla-only': 5, none: 13 },
  };
  const tags = {
    open: '<span class="tag tag--open">Open to all EVs</span>',
    'tesla-only': '<span class="tag tag--tesla-only">Tesla only</span>',
  };

  for (const [slug, counts] of Object.entries(expectedCounts)) {
    const route = JSON.parse(await readFile(new URL(`../src/data/routes/${slug}.json`, import.meta.url), 'utf8'));
    const html = guideMain(route);
    const seen = { open: 0, 'tesla-only': 0, none: 0 };
    for (const site of teslaSites(route)) {
      const expected = teslaAccessFromFacts(site.facts);
      if (!expected && !/Not yet verified/i.test(site.facts || '')) {
        assert.fail(`${slug} ${site.name} has no verified access statement`);
      }
      seen[expected || 'none'] += 1;
      if (expected) assert.equal(site.teslaAccess, expected, site.name);
      else assert.equal(site.teslaAccess, undefined, site.name);

      const row = buttonRow(html, site.name);
      if (expected) {
        assert.equal(row.startsWith(tags[expected]), true, `${slug} ${site.name}`);
        assert.equal(row.includes(expected === 'open' ? 'tag--tesla-only' : 'tag--open'), false, site.name);
      } else {
        assert.equal(row.includes('tag--open'), false, site.name);
        assert.equal(row.includes('tag--tesla-only'), false, site.name);
        assert.equal(row.includes('>Open to all EVs<'), false, site.name);
        assert.equal(row.includes('>Tesla only<'), false, site.name);
      }
    }
    assert.deepEqual(seen, counts, slug);
  }
});

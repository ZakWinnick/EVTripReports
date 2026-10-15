import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { driverReportCutoff, guideMain } from '../src/lib/render-guide.js';

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
        { source: 'reddit', url: 'https://example.com/old', date: older, summary: 'Too old to show.' },
        { source: 'reddit', url: 'https://example.com/edge', date: edge, summary: 'Exactly three years.' },
        { source: 'forum', url: 'https://example.com/mid', date: mid, summary: 'Middle report.' },
        { source: 'reddit', url: 'https://example.com/new', date: newest, summary: 'Newest report.' },
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
    summary: 'Shared Denny report.',
  };
  const html = guideMain(
    fixture(
      [{ source: 'plugshare', url: 'https://example.com/plug', date: addDays(cutoff, 30), summary: 'First check-in.' }, { source: 'plugshare', url: 'https://example.com/plug', date: addDays(cutoff, 10), summary: 'Second check-in.' }],
      [
        { name: 'Denny DC1', facts: 'ChargePoint', status: 'unverified', driverReports: [shared] },
        { name: 'Denny DC2', facts: 'ChargePoint', status: 'unverified', driverReports: [{ ...shared }] },
      ]
    )
  );
  const block = reportsBlock(html);
  assert.equal(block.split('Shared Denny report.').length - 1, 1);
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
  assert.match(blytheReports, /Could not activate/);
  assert.match(blytheReports, /Does this station work/);
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

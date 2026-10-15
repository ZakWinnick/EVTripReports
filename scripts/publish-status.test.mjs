import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { exportStatus, primaryPublishBlock } from '../src/lib/publish-status.js';
import { guideCards, guideMain } from '../src/lib/render-guide.js';

function route(primaryStatus, otherStatus) {
  return {
    stops: [
      {
        id: 'a',
        name: 'Town',
        primary: {
          stalls: { status: primaryStatus.stalls, value: '2' },
          power: { status: primaryStatus.power, value: '50 kW' },
          access: { status: primaryStatus.access, value: 'CCS' },
          price: { status: 'unpublished', value: 'In the app' },
        },
        backups: [],
        other: otherStatus ? [{ name: 'Side site', status: otherStatus, facts: 'Noted difference' }] : [],
      },
    ],
  };
}

const ok = { stalls: 'verified', power: 'verified', access: 'verified' };

test('verified primaries with a disclosed non-primary conflict can be live', () => {
  const data = route(ok, 'conflict');
  assert.equal(primaryPublishBlock(data), null);
  assert.equal(exportStatus('live', data), 'live');
  assert.equal(exportStatus('live-ready', data), 'live');
});

test('unverified, unpublished, or conflicting primary facts stay verifying', () => {
  for (const status of ['unverified', 'unpublished', 'conflict']) {
    for (const key of ['stalls', 'power', 'access']) {
      const primary = { ...ok, [key]: status };
      const data = route(primary, 'verified');
      assert.match(primaryPublishBlock(data), new RegExp(key));
      assert.equal(exportStatus('live', data), 'verifying');
    }
  }
});

test('an unapproved route stays verifying even when primaries pass', () => {
  assert.equal(exportStatus('verifying', route(ok, 'conflict')), 'verifying');
});

test('LA to Phoenix primaries pass and the three noted differences stay conflicts', async () => {
  const routeData = JSON.parse(await readFile(new URL('../src/data/routes/la-to-phoenix.json', import.meta.url), 'utf8'));
  const list = JSON.parse(await readFile(new URL('../src/data/routes.json', import.meta.url), 'utf8'));
  const meta = list.find((r) => r.slug === 'la-to-phoenix');
  assert.equal(routeData.checked, '2026-10-14');
  assert.equal(meta.status, 'live');
  assert.equal(primaryPublishBlock(routeData), null);
  assert.equal(exportStatus(meta.status, routeData), 'live');

  const blythe = routeData.stops.find((s) => s.id === 'blythe');
  assert.equal(blythe.primary.stalls.status, 'verified');
  assert.equal(blythe.primary.stalls.value, '2 stalls, each with CCS and CHAdeMO, up to 50 kW (EVCS)');
  assert.equal(blythe.primary.stalls.url, 'https://web2.evcs.com/ev-charging-stations/ca/blythe/us-bank-blythe');
  assert.match(blythe.why, /2 stalls/);
  assert.doesNotMatch(blythe.why, /still conflicts|not live-ready/i);
  assert.doesNotMatch(routeData.summary, /still conflicts/i);

  const others = routeData.stops.flatMap((s) => s.other || []);
  const conflicts = others.filter((o) => o.status === 'conflict').map((o) => o.name);
  assert.deepEqual(conflicts, [
    'La Quinta Centre - Tesla Supercharger, 79251 CA-111, La Quinta',
    'Rancho Mirage, CA - Tesla Supercharger, 71800 CA-111, Rancho Mirage',
    'Rancho Las Palmas Shopping Center, 42370 Bob Hope Dr, Rancho Mirage',
  ]);
  for (const o of others.filter((x) => x.status === 'conflict')) {
    assert.match(o.facts, /Noted difference/);
    assert.match(o.facts, /October 14, 2026|June 18, 2026/);
    assert.match(o.facts, /Tesla Find Us|EVgo/);
    assert.match(o.facts, /DOE lists/);
  }

  const html = guideMain(routeData);
  assert.match(html, /2 stalls, each with CCS and CHAdeMO, up to 50 kW \(EVCS\)/);
  assert.match(html, /https:\/\/web2\.evcs\.com\/ev-charging-stations\/ca\/blythe\/us-bank-blythe/);
  assert.match(html, /https:\/\/static-prod\.noodoe\.com\/charger-photo\/s1vd-img-1\.jpg/);
  assert.match(html, /https:\/\/developer\.nlr\.gov\/api\/alt-fuel-stations\/v1\/348909\.json/);
  assert.match(html, /likely only one connector per stall/);
  assert.doesNotMatch(html, /still conflicts|not live-ready|October 15, 2026|—/);

  const cards = guideCards([{ slug: 'la-to-phoenix', title: 'LA to Phoenix', highway: 'I-10', status: exportStatus(meta.status, routeData), miles: 344, stops: routeData.stops.length }]);
  assert.match(cards, /href="\/guides\/la-to-phoenix"/);
  assert.doesNotMatch(cards, /Coming soon/);
});

test('routes already marked live still pass the primary gate', async () => {
  const list = JSON.parse(await readFile(new URL('../src/data/routes.json', import.meta.url), 'utf8'));
  const files = await readdir(new URL('../src/data/routes/', import.meta.url));
  for (const file of files.filter((f) => f.endsWith('.json'))) {
    const data = JSON.parse(await readFile(new URL(`../src/data/routes/${file}`, import.meta.url), 'utf8'));
    const meta = list.find((r) => r.slug === data.slug);
    if (meta?.status !== 'live') continue;
    assert.equal(primaryPublishBlock(data), null, data.slug);
    assert.equal(exportStatus(meta.status, data), 'live', data.slug);
  }
});

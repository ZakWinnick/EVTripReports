import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { exportStatus, primaryPublishBlock, visibleHomeRoutes } from '../src/lib/publish-status.js';
import { guideCards, guideMain } from '../src/lib/render-guide.js';
import { liveBuiltGuideIndex, liveBuiltGuides } from '../src/lib/live-guides.js';
import { buildSitemapXml, guidesForSitemap } from '../functions/_lib/sitemap.js';

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
  assert.match(html, /https:\/\/afdc\.energy\.gov\/stations\/#\/station\/348909/);
  assert.equal(html.includes('developer.nlr.gov'), false);
  assert.match(html, /likely only one connector per stall/);
  assert.doesNotMatch(html, /still conflicts|not live-ready|October 15, 2026|—/);

  const cards = guideCards([{ slug: 'la-to-phoenix', title: 'LA to Phoenix', highway: 'I-10', status: exportStatus(meta.status, routeData), miles: 344, stops: routeData.stops.length }]);
  assert.match(cards, /href="\/guides\/la-to-phoenix\/"/);
  assert.doesNotMatch(cards, /Coming soon/);
});

test('DC to NYC passes the primary gate and is on the public lists', async () => {
  const routeData = JSON.parse(await readFile(new URL('../src/data/routes/dc-to-nyc.json', import.meta.url), 'utf8'));
  const raw = await readFile(new URL('../src/data/routes/dc-to-nyc.json', import.meta.url), 'utf8');
  const list = JSON.parse(await readFile(new URL('../src/data/routes.json', import.meta.url), 'utf8'));
  const meta = list.find((r) => r.slug === 'dc-to-nyc');
  assert.equal(routeData.slug, 'dc-to-nyc');
  assert.equal(routeData.title, 'Washington, DC to NYC');
  assert.equal(routeData.highway, 'I-95');
  assert.equal(routeData.checked, '2026-10-15');
  assert.equal(meta.status, 'live');
  assert.equal(meta.title, 'Washington, DC to NYC');
  assert.equal(meta.highway, 'I-95');
  assert.equal(meta.miles, 223);
  assert.equal(primaryPublishBlock(routeData), null);
  assert.equal(exportStatus('live', routeData), 'live');
  assert.equal(exportStatus(meta.status, routeData), 'live');

  assert.equal(routeData.stops.length, 5);
  for (const stop of routeData.stops) {
    assert.ok(stop.id);
    assert.ok(Array.isArray(stop.backups));
    assert.ok(Array.isArray(stop.other));
    assert.ok(Array.isArray(stop.around));
    assert.ok(Array.isArray(stop.searches));
    for (const key of ['stalls', 'power', 'access']) {
      assert.equal(stop.primary[key].status, 'verified', `${stop.id} ${key}`);
    }
  }
  assert.ok(Array.isArray(routeData.tips));
  assert.equal(typeof routeData.arrival, 'string');

  const guides = await liveBuiltGuides();
  const index = await liveBuiltGuideIndex();
  assert.equal(guides.some((guide) => guide.slug === 'dc-to-nyc'), true);
  assert.equal(index.some((guide) => guide.slug === 'dc-to-nyc'), true);
  const xml = buildSitemapXml(guidesForSitemap(guides, []));
  assert.equal(xml.includes('dc-to-nyc'), true);

  const files = await readdir(new URL('../src/data/routes/', import.meta.url));
  const routeBySlug = {};
  for (const file of files.filter((name) => name.endsWith('.json'))) {
    const data = JSON.parse(await readFile(new URL(`../src/data/routes/${file}`, import.meta.url), 'utf8'));
    routeBySlug[data.slug] = data;
  }
  const home = visibleHomeRoutes(list, routeBySlug);
  assert.equal(home.some((route) => route.slug === 'dc-to-nyc'), true);
  assert.equal(home.every((route) => route.status === 'live'), true);

  const html = guideMain(routeData);
  assert.match(html, /id="stop-abingdon"/);
  assert.match(html, /id="stop-elizabeth"/);
  assert.equal(html.includes('\u2014'), false);
  assert.equal(html.includes('Rangeway'), false);
  assert.equal(raw.includes('\u2014'), false);
  assert.equal(raw.includes('Rangeway'), false);
});

async function assertRouteJsonHasNoDashes(slug) {
  const raw = await readFile(new URL(`../src/data/routes/${slug}.json`, import.meta.url), 'utf8');
  const route = JSON.parse(raw);
  const dash = /[\u2013\u2014]|\\u201[34]/i;
  assert.equal(dash.test(raw), false, slug);

  const visit = (value, where) => {
    if (typeof value === 'string') {
      assert.equal(dash.test(value), false, where);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${where}[${index}]`));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        assert.equal(dash.test(key), false, `${where} key`);
        visit(child, `${where}.${key}`);
      }
    }
  };
  visit(route, slug);
}

test('dc-to-nyc route JSON contains no em dash or en dash in any string', async () => {
  await assertRouteJsonHasNoDashes('dc-to-nyc');
});

test('Las Vegas to Salt Lake City passes the primary gate and is on the public lists', async () => {
  const routeData = JSON.parse(await readFile(new URL('../src/data/routes/las-vegas-to-salt-lake-city.json', import.meta.url), 'utf8'));
  const raw = await readFile(new URL('../src/data/routes/las-vegas-to-salt-lake-city.json', import.meta.url), 'utf8');
  const list = JSON.parse(await readFile(new URL('../src/data/routes.json', import.meta.url), 'utf8'));
  const meta = list.find((r) => r.slug === 'las-vegas-to-salt-lake-city');
  assert.equal(routeData.slug, 'las-vegas-to-salt-lake-city');
  assert.equal(routeData.title, 'Las Vegas to Salt Lake City');
  assert.equal(routeData.highway, 'I-15');
  assert.equal(routeData.checked, '2026-10-15');
  assert.deepEqual(meta, {
    slug: 'las-vegas-to-salt-lake-city',
    title: 'Las Vegas to Salt Lake City',
    highway: 'I-15',
    miles: 423,
    status: 'live',
  });
  assert.equal(primaryPublishBlock(routeData), null);
  assert.equal(exportStatus('live', routeData), 'live');
  assert.equal(exportStatus(meta.status, routeData), 'live');

  assert.equal(routeData.stops.length, 7);
  for (const stop of routeData.stops) {
    assert.ok(stop.id);
    assert.ok(Array.isArray(stop.backups));
    assert.ok(Array.isArray(stop.other));
    assert.ok(Array.isArray(stop.around));
    assert.ok(Array.isArray(stop.searches));
    for (const key of ['stalls', 'power', 'access']) {
      assert.equal(stop.primary[key].status, 'verified', `${stop.id} ${key}`);
    }
  }
  assert.ok(Array.isArray(routeData.tips));
  assert.equal(typeof routeData.arrival, 'string');

  const guides = await liveBuiltGuides();
  const index = await liveBuiltGuideIndex();
  assert.equal(guides.some((guide) => guide.slug === 'las-vegas-to-salt-lake-city'), true);
  assert.equal(index.some((guide) => guide.slug === 'las-vegas-to-salt-lake-city'), true);
  const xml = buildSitemapXml(guidesForSitemap(guides, []));
  assert.equal(xml.includes('las-vegas-to-salt-lake-city'), true);

  const files = await readdir(new URL('../src/data/routes/', import.meta.url));
  const routeBySlug = {};
  for (const file of files.filter((name) => name.endsWith('.json'))) {
    const data = JSON.parse(await readFile(new URL(`../src/data/routes/${file}`, import.meta.url), 'utf8'));
    routeBySlug[data.slug] = data;
  }
  const home = visibleHomeRoutes(list, routeBySlug);
  assert.equal(home.some((route) => route.slug === 'las-vegas-to-salt-lake-city'), true);
  assert.equal(home.every((route) => route.status === 'live'), true);

  const html = guideMain(routeData);
  assert.match(html, /id="stop-mesquite"/);
  assert.match(html, /id="stop-salt-lake-city"/);
  assert.equal(html.includes('\u2014'), false);
  assert.equal(html.includes('\u2013'), false);
  assert.equal(html.includes('Rangeway'), false);
  assert.equal(raw.includes('\u2014'), false);
  assert.equal(raw.includes('\u2013'), false);
  assert.equal(raw.includes('Rangeway'), false);
});

test('las-vegas-to-salt-lake-city route JSON contains no em dash or en dash in any string', async () => {
  await assertRouteJsonHasNoDashes('las-vegas-to-salt-lake-city');
});

test('LA to San Diego passes the primary gate and is on the public lists', async () => {
  const raw = await readFile(new URL('../src/data/routes/la-to-san-diego.json', import.meta.url), 'utf8');
  const routeData = JSON.parse(raw);
  const list = JSON.parse(await readFile(new URL('../src/data/routes.json', import.meta.url), 'utf8'));
  const meta = list.find((r) => r.slug === 'la-to-san-diego');
  assert.equal(routeData.slug, 'la-to-san-diego');
  assert.equal(routeData.title, 'LA to San Diego');
  assert.equal(routeData.highway, 'I-5');
  assert.equal(routeData.checked, '2026-10-16');
  assert.deepEqual(meta, {
    slug: 'la-to-san-diego',
    title: 'LA to San Diego',
    highway: 'I-5',
    miles: 116,
    status: 'live',
  });
  assert.equal(primaryPublishBlock(routeData), null);
  assert.equal(exportStatus('live', routeData), 'live');
  assert.equal(exportStatus(meta.status, routeData), 'live');

  assert.equal(routeData.stops.length, 5);
  for (const stop of routeData.stops) {
    assert.ok(stop.backups.some((backup) => backup.status === 'verified'), `${stop.id} verified backup`);
    for (const key of ['stalls', 'power', 'access']) {
      assert.equal(stop.primary[key].status, 'verified', `${stop.id} ${key}`);
    }
  }

  const guides = await liveBuiltGuides();
  const index = await liveBuiltGuideIndex();
  assert.equal(guides.some((guide) => guide.slug === 'la-to-san-diego'), true);
  assert.equal(index.some((guide) => guide.slug === 'la-to-san-diego'), true);
  const xml = buildSitemapXml(guidesForSitemap(guides, []));
  assert.equal(xml.includes('la-to-san-diego'), true);

  const files = await readdir(new URL('../src/data/routes/', import.meta.url));
  const routeBySlug = {};
  for (const file of files.filter((name) => name.endsWith('.json'))) {
    const data = JSON.parse(await readFile(new URL(`../src/data/routes/${file}`, import.meta.url), 'utf8'));
    routeBySlug[data.slug] = data;
  }
  const home = visibleHomeRoutes(list, routeBySlug);
  assert.equal(home.some((route) => route.slug === 'la-to-san-diego'), true);

  const html = guideMain(routeData);
  assert.match(html, /id="stop-anaheim"/);
  assert.match(html, /id="stop-san-diego"/);
  assert.equal(/rangeway|ampiq/i.test(raw), false);
  assert.equal(/rangeway|ampiq/i.test(html), false);
});

test('Dallas to Austin passes the primary gate and stays off the public lists', async () => {
  const raw = await readFile(new URL('../src/data/routes/dallas-to-austin.json', import.meta.url), 'utf8');
  const routeData = JSON.parse(raw);
  const list = JSON.parse(await readFile(new URL('../src/data/routes.json', import.meta.url), 'utf8'));
  const meta = list.find((r) => r.slug === 'dallas-to-austin');
  assert.equal(routeData.slug, 'dallas-to-austin');
  assert.equal(routeData.title, 'Dallas to Austin');
  assert.equal(routeData.highway, 'I-35');
  assert.equal(routeData.checked, '2026-10-16');
  assert.deepEqual(meta, {
    slug: 'dallas-to-austin',
    title: 'Dallas to Austin',
    highway: 'I-35',
    miles: 192,
    status: 'verifying',
  });
  assert.equal(primaryPublishBlock(routeData), null);
  assert.equal(exportStatus('live', routeData), 'live');
  assert.equal(exportStatus(meta.status, routeData), 'verifying');

  assert.equal(routeData.stops.length, 6);
  for (const stop of routeData.stops) {
    assert.ok(stop.backups.some((backup) => backup.status === 'verified'), `${stop.id} verified backup`);
    for (const key of ['stalls', 'power', 'access']) {
      assert.equal(stop.primary[key].status, 'verified', `${stop.id} ${key}`);
    }
  }

  const guides = await liveBuiltGuides();
  const index = await liveBuiltGuideIndex();
  assert.equal(guides.some((guide) => guide.slug === 'dallas-to-austin'), false);
  assert.equal(index.some((guide) => guide.slug === 'dallas-to-austin'), false);
  const xml = buildSitemapXml(guidesForSitemap(guides, []));
  assert.equal(xml.includes('dallas-to-austin'), false);

  const files = await readdir(new URL('../src/data/routes/', import.meta.url));
  const routeBySlug = {};
  for (const file of files.filter((name) => name.endsWith('.json'))) {
    const data = JSON.parse(await readFile(new URL(`../src/data/routes/${file}`, import.meta.url), 'utf8'));
    routeBySlug[data.slug] = data;
  }
  const home = visibleHomeRoutes(list, routeBySlug);
  assert.equal(home.some((route) => route.slug === 'dallas-to-austin'), false);

  const html = guideMain(routeData);
  assert.match(html, /id="stop-dallas"/);
  assert.match(html, /id="stop-austin"/);
  assert.equal(/rangeway|ampiq/i.test(raw), false);
  assert.equal(/rangeway|ampiq/i.test(html), false);
});

test('dallas-to-austin route JSON contains no em dash or en dash in any string', async () => {
  await assertRouteJsonHasNoDashes('dallas-to-austin');
});

test('la-to-san-diego route JSON contains no em dash or en dash in any string', async () => {
  await assertRouteJsonHasNoDashes('la-to-san-diego');
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

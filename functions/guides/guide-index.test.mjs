import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import builtGuideIndex from '../_lib/built-guide-index.js';
import { guideSlashRedirect, isGuidesIndex } from '../_lib/guide-response.js';
import { listLiveGuideIndex, listRoutes } from '../_lib/routes.js';
import { liveBuiltGuideIndex, liveBuiltGuides } from '../../src/lib/live-guides.js';
import {
  formatDistance,
  guideIndexList,
  guideIndexRecord,
  mergeGuideIndex,
  routeDistance,
} from '../../src/lib/guide-index.js';

function db(rows, { fail = false } = {}) {
  const state = { sql: '' };
  return {
    prepare(statement) {
      state.sql = statement;
      let bound = [];
      return {
        bind(...args) {
          bound = args;
          return this;
        },
        async all() {
          if (fail) throw new Error('db down');
          return { results: rows };
        },
        async first() {
          if (fail) throw new Error('db down');
          const slug = bound[0];
          const row = rows.find((item) => item.slug === slug && item.status === 'live' && item.json);
          return row ? { json: row.json } : null;
        },
      };
    },
    sql: () => state.sql,
  };
}

function card(html, slug) {
  const href = `href="/guides/${slug}/"`;
  const start = html.indexOf(href);
  assert.notEqual(start, -1, slug);
  const open = html.lastIndexOf('<li ', start);
  const close = html.indexOf('</li>', start);
  return html.slice(open, close);
}

test('route distance uses a miles stat and skips counts and elevation', () => {
  assert.equal(routeDistance({ stats: [{ label: 'High point', value: '4730', unit: 'ft' }, { label: 'DC fast sites listed', value: '37', unit: '' }] }), null);
  assert.equal(routeDistance({ stats: [{ label: 'I-10 junction to Tropicana Ave', value: '224', unit: 'mi' }] }), '224');
  assert.equal(routeDistance({ miles: 186 }), '186');
  assert.equal(routeDistance({ distance: '99' }), '99');
  assert.equal(routeDistance({}), null);
  assert.equal(formatDistance('224'), '224 mi');
  assert.equal(formatDistance('224 mi'), '224 mi');
  assert.equal(formatDistance(null), '');
});

test('index rows show title, ends, distance, and a link', () => {
  const html = guideIndexList([
    guideIndexRecord({
      slug: 'la-to-las-vegas',
      title: 'LA to Las Vegas',
      highway: 'I-15',
      startLabel: 'I-10 junction, Ontario',
      endLabel: 'Tropicana Ave, Las Vegas',
      stats: [{ label: 'Miles', value: '224', unit: 'mi' }],
    }),
    guideIndexRecord({
      slug: 'no-miles',
      title: 'Denver to Albuquerque',
      startLabel: 'Denver',
      endLabel: 'Albuquerque',
      stats: [{ label: 'DC fast sites listed', value: '12', unit: '' }],
    }),
    guideIndexRecord({ slug: 'bad', title: 'A <b>title</b>', startLabel: 'A & B', endLabel: 'C' }),
  ]);
  const vegas = card(html, 'la-to-las-vegas');
  assert.match(vegas, /LA to Las Vegas/);
  assert.match(vegas, /I-15/);
  assert.match(vegas, /<dt>Start<\/dt><dd><span>I-10 junction, Ontario<\/span>/);
  assert.match(vegas, /<dt>End<\/dt><dd><span>Tropicana Ave, Las Vegas<\/span>/);
  assert.match(vegas, /<dt>Corridor miles<\/dt><dd><span>224 mi<\/span>/);
  assert.match(vegas, /Read the guide/);
  const bare = card(html, 'no-miles');
  assert.match(bare, /Denver to Albuquerque/);
  assert.match(bare, /<dt>Start<\/dt><dd><span>Denver<\/span>/);
  assert.match(bare, /<dt>End<\/dt><dd><span>Albuquerque<\/span>/);
  assert.equal(bare.includes('Distance'), false);
  assert.doesNotMatch(bare, /<dd><span>[^<]* mi<\/span>/);
  assert.match(card(html, 'bad'), /A &lt;b&gt;title&lt;\/b&gt;/);
  assert.match(card(html, 'bad'), /A &amp; B/);
  assert.equal(html.includes('—'), false);
  assert.equal(html.includes('Rangeway'), false);
});

test('merge keeps built guides and lets a live D1 row win', () => {
  const built = [
    { slug: 'la-to-las-vegas', title: 'LA to Las Vegas', highway: 'I-15', start: 'Ontario', end: 'Las Vegas', miles: '224' },
    { slug: 'la-to-sf', title: 'LA to San Francisco', highway: 'I-5', start: 'LA', end: 'SF', miles: '317' },
  ];
  const merged = mergeGuideIndex(built, [
    { slug: 'la-to-las-vegas', title: 'Los Angeles to Las Vegas', highway: '', start: '', end: 'Tropicana', miles: '230' },
    { slug: 'denver-to-albuquerque', title: 'Denver to Albuquerque', highway: 'I-25', start: 'Denver', end: 'Albuquerque', miles: null },
    { slug: '', title: 'Missing slug' },
    { slug: 'no-title', title: '' },
  ]);
  assert.deepEqual(merged.map((guide) => guide.slug), ['la-to-las-vegas', 'la-to-sf', 'denver-to-albuquerque']);
  assert.equal(merged[0].title, 'Los Angeles to Las Vegas');
  assert.equal(merged[0].highway, 'I-15');
  assert.equal(merged[0].start, 'Ontario');
  assert.equal(merged[0].end, 'Tropicana');
  assert.equal(merged[0].miles, '230');
  assert.equal(merged[2].miles, null);
});

test('built guide index matches the publish gate', async () => {
  const index = await liveBuiltGuideIndex();
  const guides = await liveBuiltGuides();
  assert.deepEqual(builtGuideIndex, index);
  assert.deepEqual(
    index.map((guide) => guide.slug).sort(),
    guides.map((guide) => guide.slug),
  );
  assert.deepEqual(
    index.map((guide) => guide.slug),
    ['la-to-las-vegas', 'la-to-sf', 'sf-to-tahoe', 'la-to-phoenix', 'seattle-to-portland', 'nyc-to-boston', 'dc-to-nyc', 'las-vegas-to-salt-lake-city', 'la-to-san-diego', 'dallas-to-austin'],
  );
  const vegas = index.find((guide) => guide.slug === 'la-to-las-vegas');
  assert.equal(vegas.title, 'LA to Las Vegas');
  assert.equal(vegas.highway, 'I-15');
  assert.equal(vegas.start, 'I-10 junction, Ontario');
  assert.equal(vegas.end, 'Tropicana Ave, Las Vegas');
  assert.equal(vegas.miles, '224');
  for (const guide of index) assert.ok(guide.title);
});

test('slashless guide paths redirect to the canonical slash URL', () => {
  const index = guideSlashRedirect(new Request('https://evtripreports.com/guides?utm=1'));
  assert.equal(index.status, 308);
  assert.equal(index.headers.get('location'), 'https://evtripreports.com/guides/?utm=1');
  const guide = guideSlashRedirect(new Request('https://evtripreports.com/guides/la-to-sf'));
  assert.equal(guide.status, 308);
  assert.equal(guide.headers.get('location'), 'https://evtripreports.com/guides/la-to-sf/');
  assert.equal(guideSlashRedirect(new Request('https://evtripreports.com/guides/')), null);
  assert.equal(guideSlashRedirect(new Request('https://evtripreports.com/guides/la-to-sf/')), null);
  assert.equal(guideSlashRedirect(new Request('https://evtripreports.com/guides/index.html')), null);
  assert.equal(guideSlashRedirect(new Request('https://evtripreports.com/guides/la-to-sf/stalls')), null);
});

test('guides index is /guides and /guides/, not a slug', () => {
  assert.equal(isGuidesIndex({}, { url: 'https://evtripreports.com/guides' }), true);
  assert.equal(isGuidesIndex({ path: [] }, { url: 'https://evtripreports.com/guides/' }), true);
  assert.equal(isGuidesIndex({ path: '' }, { url: 'https://evtripreports.com/guides/' }), true);
  assert.equal(isGuidesIndex({ path: 'index.html' }, { url: 'https://evtripreports.com/guides/index.html' }), true);
  assert.equal(isGuidesIndex({ path: ['index.html'] }, { url: 'https://evtripreports.com/guides/' }), true);
  assert.equal(isGuidesIndex({ path: ['la-to-sf'] }, { url: 'https://evtripreports.com/guides/la-to-sf/' }), false);
  assert.equal(isGuidesIndex({ path: ['la-to-sf'] }, { url: 'https://evtripreports.com/guides' }), false);
  assert.equal(isGuidesIndex({}, { url: 'https://evtripreports.com/guides/la-to-sf/' }), false);
  assert.equal(isGuidesIndex({ path: ['la-to-sf', 'stalls'] }, { url: 'https://evtripreports.com/guides/' }), false);
});

test('the site offers the sample plan instead of a guide directory', async () => {
  const page = await readFile(new URL('../../src/pages/guides/index.astro', import.meta.url), 'utf8');
  assert.match(page, /Astro.redirect\('\/sample-plan\/', 308\)/);
  for (const path of ['src/layouts/Base.astro', 'src/pages/index.astro', 'src/pages/plans.astro', 'src/pages/404.astro']) {
    const source = await readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /href[=:][^\n]*['"]\/guides\//, path);
    assert.doesNotMatch(source, /id="(?:guides-list|guides-index|corridors)"/, path);
  }
  const layout = await readFile(new URL('../../src/layouts/Base.astro', import.meta.url), 'utf8');
  assert.match(layout, /href: '\/sample-plan\/', label: 'Sample plan'/);
});

test('retired directory URLs redirect to the sample without reading route data', async () => {
  const { onRequestGet } = await import('./[[path]].js');
  for (const [path, params] of [
    ['/guides', {}],
    ['/guides/', { path: [] }],
    ['/guides/index.html', { path: 'index.html' }],
  ]) {
    const res = await onRequestGet({
      request: new Request(`https://evtripreports.com${path}?utm=example`),
      params,
      env: {
        DB: { prepare() { throw new Error('Directory must not read D1'); } },
        ASSETS: { fetch() { throw new Error('Directory must not fetch an index'); } },
      },
    });
    assert.equal(res.status, 308, path);
    assert.equal(res.headers.get('location'), 'https://evtripreports.com/sample-plan/?utm=example', path);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  }
});

test('the homepage route list keeps live rows and drops verifying rows', async () => {
  const rows = await listRoutes({
    DB: {
      prepare() {
        return {
          async all() {
            return {
              results: [
                {
                  slug: 'dc-to-nyc',
                  title: 'Washington, DC to NYC',
                  highway: 'I-95',
                  status: 'verifying',
                  json: JSON.stringify({ stats: [{ value: '223' }], stops: [{}, {}, {}, {}, {}] }),
                  sort: 70,
                },
                {
                  slug: 'la-to-sf',
                  title: 'LA to San Francisco',
                  highway: 'I-5',
                  status: 'live',
                  json: JSON.stringify({ stats: [{ value: '317' }], stops: [{}, {}] }),
                  sort: 20,
                },
              ],
            };
          },
        };
      },
    },
  });
  assert.deepEqual(rows.map((route) => route.slug), ['la-to-sf']);
});

test('a D1 miss still leaves the built index list', async () => {
  assert.deepEqual(await listLiveGuideIndex({}), []);
  assert.deepEqual(await listLiveGuideIndex({ DB: db([], { fail: true }) }), []);
});

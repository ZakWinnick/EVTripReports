import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import builtGuides from './_lib/built-guides.js';
import { liveBuiltGuides } from '../src/lib/live-guides.js';
import { lastmodDate } from '../src/lib/live-guides.js';
import {
  buildSitemapXml,
  guidesForSitemap,
  loadD1Guides,
  sitemapEntries,
} from './_lib/sitemap.js';

const BUILT_SLUGS = [
  'dc-to-nyc',
  'la-to-las-vegas',
  'la-to-phoenix',
  'la-to-san-diego',
  'la-to-sf',
  'las-vegas-to-salt-lake-city',
  'nyc-to-boston',
  'seattle-to-portland',
  'sf-to-tahoe',
];

function urls(xml) {
  return [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((match) => {
    const loc = match[1].match(/<loc>([^<]+)<\/loc>/);
    const lastmod = match[1].match(/<lastmod>([^<]*)<\/lastmod>/);
    return { loc: loc[1], lastmod: lastmod ? lastmod[1] : null };
  });
}

function db(rows, { fail = false } = {}) {
  const state = { sql: '' };
  return {
    prepare(statement) {
      state.sql = statement;
      return {
        async all() {
          if (fail) throw new Error('db down');
          return { results: rows };
        },
      };
    },
    sql: () => state.sql,
  };
}

test('lastmodDate keeps real calendar dates only', () => {
  assert.equal(lastmodDate('2026-10-14'), '2026-10-14');
  assert.equal(lastmodDate('2026-02-31'), null);
  assert.equal(lastmodDate('2026-10-14T12:00:00Z'), null);
  assert.equal(lastmodDate('checked October 14'), null);
  assert.equal(lastmodDate(''), null);
  assert.equal(lastmodDate(null), null);
});

test('built guide list matches the publish gate', async () => {
  const guides = await liveBuiltGuides();
  assert.deepEqual(builtGuides, guides);
  assert.deepEqual(
    guides.map((guide) => guide.slug),
    BUILT_SLUGS,
  );
  assert.equal(guides.some((guide) => guide.slug === 'dc-to-nyc'), true);
  assert.equal(guides.some((guide) => guide.slug === 'las-vegas-to-salt-lake-city'), true);
  assert.equal(guides.some((guide) => guide.slug === 'la-to-san-diego'), true);
  assert.equal(guides.some((guide) => guide.slug === 'dallas-to-austin'), false);
  assert.equal(guides.some((guide) => guide.slug === 'chicago-to-milwaukee'), false);
  assert.deepEqual(
    guides.map((guide) => guide.lastmod),
    ['2026-10-15', '2026-10-14', '2026-10-14', '2026-10-16', '2026-10-15', '2026-10-15', '2026-10-15', '2026-10-15', '2026-10-15'],
  );
});

test('sitemap lists public canonical URLs and guide checked dates', () => {
  const xml = buildSitemapXml(guidesForSitemap(builtGuides, []));
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">/);
  const entries = urls(xml);
  assert.deepEqual(
    entries.map((entry) => entry.loc),
    [
      'https://evtripreports.com/',
      'https://evtripreports.com/guides/',
      'https://evtripreports.com/plans/',
      'https://evtripreports.com/about/',
      'https://evtripreports.com/faq/',
      'https://evtripreports.com/methodology/',
      'https://evtripreports.com/privacy/',
      'https://evtripreports.com/terms/',
      'https://evtripreports.com/find-my-plans/',
      ...BUILT_SLUGS.map((slug) => `https://evtripreports.com/guides/${slug}/`),
    ],
  );
  for (const entry of entries.slice(0, 9)) assert.equal(entry.lastmod, null);
  assert.equal(entries.find((entry) => entry.loc.endsWith('/guides/la-to-las-vegas/')).lastmod, '2026-10-14');
  assert.equal(entries.find((entry) => entry.loc.endsWith('/guides/la-to-sf/')).lastmod, '2026-10-15');
  const body = xml;
  for (const blocked of ['/plan/', '/find-my-plans/open/', '/find-my-plans/list', '/404', '/guide-shell', '/portal-shell', '/api/']) {
    assert.equal(body.includes(blocked), false, blocked);
  }
});

test('a live D1 guide is added and its checked date replaces the built one', async () => {
  const database = db([
    { slug: 'la-to-sf', json: JSON.stringify({ slug: 'la-to-sf', checked: '2026-09-01' }) },
    { slug: 'denver-to-albuquerque', json: JSON.stringify({ slug: 'denver-to-albuquerque', checked: '2026-10-02' }) },
    { slug: 'not a slug', json: JSON.stringify({ checked: '2026-10-02' }) },
    { slug: 'bad-json', json: '{oops' },
    { slug: 'la-to-phoenix', json: '{oops' },
    { slug: 'no-date', json: JSON.stringify({ slug: 'no-date' }) },
  ]);
  const d1 = await loadD1Guides({ DB: database });
  assert.match(database.sql(), /status = 'live'/);
  assert.match(database.sql(), /json IS NOT NULL/);
  const guides = guidesForSitemap(builtGuides, d1);
  const entries = sitemapEntries(guides);
  const sf = entries.find((entry) => entry.loc.endsWith('/guides/la-to-sf/'));
  assert.equal(sf.lastmod, '2026-09-01');
  const added = entries.find((entry) => entry.loc.endsWith('/guides/denver-to-albuquerque/'));
  assert.equal(added.lastmod, '2026-10-02');
  assert.equal(entries.some((entry) => entry.loc.includes('not a slug')), false);
  assert.equal(entries.some((entry) => entry.loc.endsWith('/guides/bad-json/')), false);
  assert.equal(entries.find((entry) => entry.loc.endsWith('/guides/la-to-phoenix/')).lastmod, '2026-10-14');
  assert.equal(entries.find((entry) => entry.loc.endsWith('/guides/no-date/')).lastmod, null);
  assert.equal(entries.filter((entry) => entry.loc.endsWith('/guides/la-to-sf/')).length, 1);
});

test('a D1 miss still serves the built guide list', async () => {
  assert.deepEqual(await loadD1Guides({}), []);
  assert.deepEqual(await loadD1Guides({ DB: db([], { fail: true }) }), []);
  const xml = buildSitemapXml(guidesForSitemap(builtGuides, []));
  assert.equal(urls(xml).some((entry) => entry.loc.endsWith('/guides/nyc-to-boston/')), true);
});

test('sitemap response is XML', async () => {
  const { onRequestGet } = await import('./sitemap.xml.js');
  const res = await onRequestGet({ env: {} });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/xml; charset=utf-8');
  const entries = urls(await res.text());
  assert.equal(entries.length, 9 + BUILT_SLUGS.length);
});

test('D1 checked date is what the handler publishes', async () => {
  const { onRequestGet } = await import('./sitemap.xml.js');
  const res = await onRequestGet({
    env: {
      DB: db([{ slug: 'austin-to-dallas', json: JSON.stringify({ checked: '2026-08-20' }) }]),
    },
  });
  const entries = urls(await res.text());
  assert.equal(
    entries.find((entry) => entry.loc === 'https://evtripreports.com/guides/austin-to-dallas/').lastmod,
    '2026-08-20',
  );
});

test('robots.txt points at the sitemap', async () => {
  const robots = await readFile(new URL('../public/robots.txt', import.meta.url), 'utf8');
  assert.match(robots, /^Sitemap: https:\/\/evtripreports\.com\/sitemap\.xml$/m);
  assert.match(robots, /Disallow: \/plan\//);
  assert.match(robots, /Disallow: \/find-my-plans\/open\//);
  assert.match(robots, /Disallow: \/find-my-plans\/list/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { guideSlug, isBuiltGuide } from '../_lib/guide-response.js';

class FakeRewriter {
  on() {
    return this;
  }
  transform(response) {
    return new Response('rendered-from-d1', { status: 200, headers: { 'content-type': 'text/html' } });
  }
}

const route = {
  slug: 'la-to-sf',
  title: 'LA to San Francisco',
  highway: 'I-5',
  checked: '2026-10-14',
  summary: 'Test summary.',
  startNote: 'Start in LA.',
  startLabel: 'Los Angeles',
  endLabel: 'San Francisco',
  stats: [{ label: 'Miles', value: '317' }],
  sources: { afdc: { name: 'DOE', url: 'https://example.com/doe' } },
  tips: [],
  arrival: 'City charging is not in this guide.',
  stops: [
    {
      id: 'castaic',
      name: 'Castaic',
      towns: 'Castaic, CA',
      mile: 40,
      milepostNote: 'Exit 1',
      why: 'First stop.',
      primary: {
        name: 'EA',
        network: 'Electrify America',
        address: '1 Main',
        exit: 'Exit 1',
        stalls: { value: '8', status: 'verified' },
        power: { value: '350 kW', status: 'verified' },
        access: { value: 'Open', status: 'verified' },
        price: { value: 'In the app', status: 'unpublished' },
      },
      backups: [],
      other: [],
      reports: [],
      around: [],
    },
  ],
};

function assets(map) {
  return {
    async fetch(input) {
      const url = new URL(typeof input === 'string' ? input : input.url);
      const hit = map[url.pathname];
      if (!hit) return new Response('missing', { status: 404, headers: { 'content-type': 'text/html' } });
      return new Response(hit.body, { status: hit.status || 200, headers: hit.headers || { 'content-type': 'text/html; charset=utf-8' } });
    },
  };
}

function context({ path, db, map }) {
  return {
    request: new Request('https://evtripreports.com/guides/la-to-sf/'),
    params: { path },
    env: {
      DB: db
        ? {
            prepare() {
              return {
                bind() {
                  return this;
                },
                async first() {
                  return { json: JSON.stringify(route) };
                },
              };
            },
          }
        : undefined,
      ASSETS: assets(map),
    },
  };
}

test('guideSlug accepts one published-style segment', () => {
  assert.equal(guideSlug({ path: ['la-to-sf'] }), 'la-to-sf');
  assert.equal(guideSlug({ path: 'nyc-to-boston' }), 'nyc-to-boston');
  assert.equal(guideSlug({ path: ['la-to-sf', 'index.html'] }), null);
  assert.equal(guideSlug({ path: ['../admin'] }), null);
  assert.equal(guideSlug({ path: [] }), null);
});

test('isBuiltGuide rejects the homepage fallback', () => {
  const home = new Response('<html><link rel="canonical" href="https://evtripreports.com/"></html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });
  assert.equal(isBuiltGuide('not-a-route', home, '<html><link rel="canonical" href="https://evtripreports.com/"></html>'), false);
  const guide = new Response('ok', { status: 200, headers: { 'content-type': 'text/html', 'x-etr-guide': '1' } });
  assert.equal(isBuiltGuide('la-to-sf', guide, ''), true);
});

test('guides catch-all', async () => {
  globalThis.HTMLRewriter = FakeRewriter;
  const { onRequestGet } = await import('./[[path]].js');
  const notFoundPage = { body: '<html>No stop here.</html>' };
  const shell = { body: '<html><main id="main"></main></html>' };

  const missing = await onRequestGet(context({
    path: ['not-a-route'],
    map: {
      '/guides/not-a-route/index.html': { body: '<html><link rel="canonical" href="https://evtripreports.com/"></html>' },
      '/404.html': notFoundPage,
    },
  }));
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /No stop here/);

  const built = await onRequestGet(context({
    path: ['la-to-sf'],
    map: {
      '/guides/la-to-sf/index.html': { body: '<html><link rel="canonical" href="https://evtripreports.com/guides/la-to-sf/"></html>' },
      '/404.html': notFoundPage,
    },
  }));
  assert.equal(built.status, 200);
  assert.match(await built.text(), /guides\/la-to-sf/);

  const marked = await onRequestGet(context({
    path: ['la-to-sf'],
    map: {
      '/guides/la-to-sf/index.html': {
        body: '<html>built guide</html>',
        headers: { 'content-type': 'text/html', 'x-etr-guide': '1' },
      },
      '/404.html': notFoundPage,
    },
  }));
  assert.equal(marked.status, 200);
  assert.match(await marked.text(), /built guide/);

  const extra = await onRequestGet(context({
    path: ['la-to-sf', 'stalls'],
    map: { '/404.html': notFoundPage },
  }));
  assert.equal(extra.status, 404);

  const fromD1 = await onRequestGet(context({
    path: ['la-to-sf'],
    db: true,
    map: { '/guide-shell/index.html': shell, '/404.html': notFoundPage },
  }));
  assert.equal(fromD1.status, 200);
  assert.equal(await fromD1.text(), 'rendered-from-d1');

  const slashless = await onRequestGet({
    ...context({
      path: ['la-to-sf'],
      db: true,
      map: { '/guide-shell/index.html': shell, '/404.html': notFoundPage },
    }),
    request: new Request('https://evtripreports.com/guides/la-to-sf?x=1'),
  });
  assert.equal(slashless.status, 308);
  assert.equal(slashless.headers.get('location'), 'https://evtripreports.com/guides/la-to-sf/?x=1');
  assert.equal((await slashless.text()).includes('rendered-from-d1'), false);

  class JsonLdRewriter {
    constructor() {
      this.handlers = [];
    }
    on(selector, handler) {
      this.handlers.push({ selector, handler });
      return this;
    }
    transform() {
      let extra = '';
      for (const { selector, handler } of this.handlers) {
        handler.element({
          setInnerContent() {},
          setAttribute() {},
          remove() {},
          append(content) {
            if (selector === 'head') extra += content;
          },
        });
      }
      return new Response(extra, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
  }
  globalThis.HTMLRewriter = JsonLdRewriter;
  const withLd = await onRequestGet(context({
    path: ['la-to-sf'],
    db: true,
    map: { '/guide-shell/index.html': shell, '/404.html': notFoundPage },
  }));
  const ld = await withLd.text();
  assert.match(ld, /<script type="application\/ld\+json">/);
  assert.match(ld, /BreadcrumbList/);
  assert.match(ld, /"@type":"Article"/);
  assert.match(ld, /LA to San Francisco/);
  assert.match(ld, /"dateModified":"2026-10-14"/);
  assert.match(ld, /"name":"I-5"/);
  assert.match(ld, /EV Trip Reports/);
  assert.equal(ld.includes('Rangeway'), false);
  assert.equal(ld.includes('WebSite'), false);
});

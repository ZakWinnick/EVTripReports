import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { routeLine } from '../src/lib/render-guide.js';

const ROOT = new URL('..', import.meta.url);
const FILE = /\.[a-z0-9]{1,8}$/i;

function slashlessPage(value) {
  let path = String(value ?? '').trim();
  if (!path || path.startsWith('#') || path.startsWith('mailto:') || path.startsWith('tel:')) return null;
  if (path.includes('${')) {
    if (!path.startsWith('/')) return null;
    if (path.startsWith('/api/') || path.startsWith('/data/') || path.startsWith('/_astro/')) return null;
    const hash = path.search(/[?#]/);
    const pathname = hash === -1 ? path : path.slice(0, hash);
    if (pathname === '/' || pathname.endsWith('/')) return null;
    if (FILE.test(pathname.replace(/\$\{[^}]+\}/g, 'x'))) return null;
    return path;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    let url;
    try { url = new URL(path); } catch { return null; }
    if (url.hostname !== 'evtripreports.com' && url.hostname !== 'www.evtripreports.com') return null;
    path = `${url.pathname}${url.search}${url.hash}`;
  }
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  const cut = path.search(/[?#]/);
  const pathname = cut === -1 ? path : path.slice(0, cut);
  if (pathname === '/' || pathname.endsWith('/')) return null;
  if (pathname.startsWith('/_astro/') || pathname.startsWith('/api/') || pathname.startsWith('/data/')) return null;
  if (FILE.test(pathname)) return null;
  return path;
}

function hrefsIn(source) {
  const found = [];
  const patterns = [
    /href\s*=\s*"([^"]*)"/g,
    /href\s*=\s*'([^']*)'/g,
    /href\s*=\s*\{`([^`]*)`\}/g,
    /href\s*:\s*'([^']*)'/g,
    /href\s*:\s*"([^"]*)"/g,
    /href\s*:\s*`([^`]*)`/g,
    /routeLine\(\s*[^,]+,\s*'([^']*)'/g,
    /routeLine\(\s*[^,]+,\s*"([^"]*)"/g,
    /routeLine\(\s*[^,]+,\s*`([^`]*)`/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.push(match[1]);
  }
  return found;
}

async function filesUnder(dir, acc = []) {
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return acc; }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.astro') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await filesUnder(path, acc);
    else if (/\.(astro|js|mjs|html)$/.test(entry.name) && !entry.name.endsWith('.test.mjs')) acc.push(path);
  }
  return acc;
}

async function read(path) {
  return readFile(new URL(path, ROOT), 'utf8');
}

test('source hrefs for internal pages use a trailing slash', async () => {
  const paths = [
    ...(await filesUnder(join(ROOT.pathname, 'src'))),
    ...(await filesUnder(join(ROOT.pathname, 'functions'))),
  ];
  const bad = [];
  for (const path of paths) {
    const text = await readFile(path, 'utf8');
    for (const href of hrefsIn(text)) {
      const hit = slashlessPage(href);
      if (hit) bad.push(`${path}: ${hit}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('built html has no slashless internal page links, and noindex pages omit canonical', async () => {
  const dist = join(ROOT.pathname, 'dist');
  const pages = (await filesUnder(dist)).filter((path) => path.endsWith('.html'));
  assert.ok(pages.length > 5, 'run npm run build before this test');
  const bad = [];
  for (const path of pages) {
    const html = await readFile(path, 'utf8');
    for (const href of hrefsIn(html)) {
      const hit = slashlessPage(href);
      if (hit) bad.push(`${path}: ${hit}`);
    }
  }
  assert.deepEqual(bad, []);

  const missing = pages.find((path) => path.endsWith('/404.html'));
  assert.ok(missing, pages.filter((path) => path.includes('404')).join(', '));
  const notFound = await readFile(missing, 'utf8');
  assert.match(notFound, /noindex/);
  assert.equal(notFound.includes('rel="canonical"'), false);
  assert.equal(notFound.includes('property="og:url"'), false);

  const about = pages.find((path) => path.endsWith('/about/index.html'));
  assert.ok(about);
  const aboutHtml = await readFile(about, 'utf8');
  assert.match(aboutHtml, /rel="canonical" href="https:\/\/evtripreports\.com\/about\/"/);
  assert.match(aboutHtml, /property="og:url" content="https:\/\/evtripreports\.com\/about\/"/);
  assert.match(aboutHtml, /href="\/about\/" aria-current="page"/);
  assert.match(aboutHtml, /href="\/guides\/"/);
  assert.equal(aboutHtml.includes('fonts.googleapis.com'), false);
});

test('a featured guide link keeps the slash before the stop anchor', () => {
  const html = routeLine(
    {
      stats: [{ value: '10' }],
      startLabel: 'Start',
      endLabel: 'End',
      stops: [{ id: 'barstow', name: 'Barstow', mile: 5 }],
    },
    '/guides/la-to-las-vegas',
  );
  assert.match(html, /href="\/guides\/la-to-las-vegas\/#stop-barstow"/);
  assert.equal(html.includes('/guides/la-to-las-vegas#'), false);
});

test('nav current matches a slash or slashless page value against the slash href', async () => {
  const layout = await read('src/layouts/Base.astro');
  assert.match(layout, /href: '\/guides\/'/);
  assert.match(layout, /href: '\/plans\/'/);
  assert.match(layout, /href: '\/find-my-plans\/'/);
  assert.match(layout, /const current = String\(currentProp \|\| Astro\.url\.pathname\)/);
  assert.match(layout, /href\.replace\(\/\\\/\+\$\/, ''\)/);
  assert.match(layout, /href="\/plans\/"/);
  assert.match(layout, /\{!noindex && <link rel="canonical"/);
  assert.match(layout, /\{!noindex && <meta property="og:url"/);
});

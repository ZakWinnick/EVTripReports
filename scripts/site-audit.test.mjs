import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const HOME_DESCRIPTION =
  'A travel agent for EV road trips. Stops that work for your car, a backup for each, and a place to eat or sleep while you charge.';
const PLANS_DESCRIPTION =
  'A plan for your car, adapter, memberships, and dates. Stops that work for your car, a backup at each stop, and a place to eat or sleep while you charge.';

function lin(channel) {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function contrast(hex, background) {
  const lum = (value) => {
    const n = Number.parseInt(value.slice(1), 16);
    return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  };
  const [hi, lo] = [lum(hex), lum(background)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

async function source(path) {
  return readFile(new URL(path, import.meta.url), 'utf8');
}

test('home title, descriptions, and home structured data', async () => {
  const home = await source('../src/pages/index.astro');
  const plans = await source('../src/pages/plans.astro');
  const layout = await source('../src/layouts/Base.astro');
  assert.match(home, /title="A travel agent for EVs"/);
  assert.match(home, new RegExp(`description="${HOME_DESCRIPTION.replace(/[.]/g, '\\.')}"`));
  assert.ok(HOME_DESCRIPTION.length <= 160, HOME_DESCRIPTION.length);
  assert.match(plans, new RegExp(`description="${PLANS_DESCRIPTION.replace(/[.]/g, '\\.')}"`));
  assert.ok(PLANS_DESCRIPTION.length >= 150 && PLANS_DESCRIPTION.length <= 160, String(PLANS_DESCRIPTION.length));
  assert.equal(layout.includes("title === 'EV Trip Reports'"), false);
  assert.match(layout, /const fullTitle = `\$\{title\} \| EV Trip Reports`;/);
  assert.match(home, /'@type': 'WebSite'/);
  assert.match(home, /'@type': 'Organization'/);
  assert.match(home, /A travel agent for EVs\./);
  assert.equal(home.includes('Rangeway'), false);
  assert.equal(HOME_DESCRIPTION.includes('\u2014') || HOME_DESCRIPTION.includes('\u2013'), false);
  assert.equal(PLANS_DESCRIPTION.includes('\u2014') || PLANS_DESCRIPTION.includes('\u2013'), false);
});

test('social image tags and the 1200 by 630 card', async () => {
  const layout = await source('../src/layouts/Base.astro');
  assert.match(layout, /property="og:image"/);
  assert.match(layout, /property="og:site_name" content="EV Trip Reports"/);
  assert.match(layout, /name="twitter:card" content="summary_large_image"/);
  assert.match(layout, /\/og\.png/);
  const png = await readFile(new URL('../public/og.png', import.meta.url));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
});

test('mobile menu, skip link, and form autocomplete', async () => {
  const layout = await source('../src/layouts/Base.astro');
  const css = await source('../src/styles/global.css');
  const plans = await source('../src/pages/plans.astro');
  const find = await source('../src/pages/find-my-plans.astro');
  const body = layout.slice(layout.indexOf('<body>'));
  assert.match(body, /<body>\s*<a class="skip" href="#main">Skip to content<\/a>/);
  assert.match(layout, /<details class="menu">\s*<summary>Menu<\/summary>/);
  assert.match(layout, /href: '\/find-my-plans\/', label: 'Find my plans'/);
  assert.match(layout, /<nav class="nav__links" aria-label="Main">/);
  assert.match(css, /@media \(max-width: 760px\) \{[\s\S]*\.nav__links \{ display: none; \}[\s\S]*\.menu \{ display: block;/);
  assert.match(css, /^\.menu \{ display: none;/m);
  assert.match(plans, /autocomplete="name"/);
  assert.match(plans, /autocomplete="email"/);
  assert.match(find, /autocomplete="email"/);
});

test('compare-table pay buttons open the intake form, and checkout still follows a saved form', async () => {
  const plans = await source('../src/pages/plans.astro');
  const prices = await source('../src/data/plans.js');
  assert.match(plans, /href="#request" data-tier=\{t\.name\}/);
  assert.equal(plans.includes('href={t.stripeUrl}'), false);
  assert.match(plans, /a\.pay-link/);
  assert.match(plans, /select\.value = name/);
  assert.match(plans, /if \(!paid && tier\?\.stripeUrl\)/);
  assert.match(plans, /window\.location\.href = next\.toString\(\)/);
  assert.match(plans, /Save details and pay/);
  assert.match(plans, /role="img" aria-label="Included"/);
  assert.match(plans, /role="img" aria-label="Not included"/);
  assert.match(prices, /https:\/\/buy\.stripe\.com\/dRmeVd3ui5XF9r06iq5sA00/);
  assert.match(prices, /https:\/\/buy\.stripe\.com\/aFa8wP2qeadVeLk36e5sA01/);
  assert.match(prices, /https:\/\/buy\.stripe\.com\/28E14naWKeub9r05em5sA02/);
});

test('ink and control colors meet the contrast floors', async () => {
  const css = await source('../src/styles/global.css');
  const plans = await source('../src/pages/plans.astro');
  const find = await source('../src/pages/find-my-plans.astro');
  const ink = css.match(/--ink-3:\s*(#[0-9a-f]{6})/)[1];
  const control = css.match(/--control:\s*(#[0-9a-f]{6})/)[1];
  assert.ok(contrast(ink, '#ffffff') >= 4.5, contrast(ink, '#ffffff'));
  assert.ok(contrast(ink, '#f3f4f2') >= 4.5, contrast(ink, '#f3f4f2'));
  assert.ok(contrast(control, '#ffffff') >= 3, contrast(control, '#ffffff'));
  assert.ok(contrast(control, '#f3f4f2') >= 3, contrast(control, '#f3f4f2'));
  assert.match(css, /\.pill--ghost \{[^}]*var\(--control\)/);
  assert.match(css, /\.newsletter__row input\[type="email"\] \{[^}]*var\(--control\)/);
  assert.match(plans, /\.form input, \.form select, \.form textarea \{[^}]*var\(--control\)/);
  assert.match(find, /\.form input \{[^}]*var\(--control\)/);
});

test('the dc-to-nyc guide does not cite the Marlton EA station page that returns 404', async () => {
  const text = await readFile(new URL('../src/data/routes/dc-to-nyc.json', import.meta.url), 'utf8');
  assert.equal(text.includes('/locate-charger/nj/marlton/307-rte-70-w/240408/'), false);
  assert.match(text, /search 307 Rte 70 W, Marlton, NJ \(EA station 240408\)/);
  assert.equal(text.includes('\u2014') || text.includes('\u2013'), false);
});

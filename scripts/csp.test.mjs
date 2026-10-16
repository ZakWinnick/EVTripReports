import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CSP, PERMISSIONS_POLICY, applySecurityHeaders } from '../src/lib/security-headers.js';
import { privateHeaders } from '../functions/_lib/private-page.js';
import { html } from '../functions/_lib/routes.js';

const ROOT = new URL('..', import.meta.url);
const DATA_TYPES = new Set(['application/ld+json', 'application/json']);

function parseCsp(csp) {
  const directives = new Map();
  for (const part of csp.split(';')) {
    const bits = part.trim().split(/\s+/).filter(Boolean);
    if (!bits.length) continue;
    directives.set(bits[0], new Set(bits.slice(1)));
  }
  return directives;
}

function allows(directives, name, token) {
  const list = directives.has(name) ? directives.get(name) : directives.get('default-src');
  if (!list) return false;
  if (list.has(token) || list.has('*') || list.has('https:')) return true;
  if (token === 'self') return list.has("'self'");
  if (token === 'data:') return list.has('data:');
  return false;
}

function resource(tag, attrs) {
  const rel = (attrs.rel || '').toLowerCase();
  const as = (attrs.as || '').toLowerCase();
  const href = attrs.href || '';
  const src = attrs.src || attrs.data || '';
  if (tag === 'script' && src) return { directive: 'script-src', url: src };
  if (tag === 'img' && src) return { directive: 'img-src', url: src };
  if (tag === 'iframe' && src) return { directive: 'frame-src', url: src };
  if ((tag === 'audio' || tag === 'video' || tag === 'source') && src) return { directive: 'media-src', url: src };
  if ((tag === 'object' || tag === 'embed') && (src || attrs.data)) return { directive: 'object-src', url: src || attrs.data };
  if (tag === 'form' && attrs.action) return { directive: 'form-action', url: attrs.action };
  if (tag !== 'link' || !href) return null;
  if (rel.includes('stylesheet') || (rel.includes('preload') && as === 'style')) return { directive: 'style-src', url: href };
  if (rel.includes('preload') && as === 'font') return { directive: 'font-src', url: href };
  if ((rel.includes('preload') && as === 'script') || rel.includes('modulepreload')) return { directive: 'script-src', url: href };
  if (rel.includes('preconnect') || rel.includes('dns-prefetch')) return { directive: 'connect-src', url: href };
  if (rel.includes('icon')) return { directive: 'img-src', url: href };
  return null;
}

function hostToken(url) {
  if (!url || url.startsWith('#') || url.startsWith('mailto:') || url.startsWith('tel:')) return null;
  if (url.startsWith('data:')) return 'data:';
  if (url.startsWith('/') && !url.startsWith('//')) return 'self';
  try {
    const parsed = new URL(url, 'https://evtripreports.com');
    if (parsed.hostname === 'evtripreports.com' || parsed.hostname === 'www.evtripreports.com') return 'self';
    return parsed.origin;
  } catch {
    return null;
  }
}

function attrsOf(raw) {
  const attrs = {};
  for (const match of raw.matchAll(/([^\s=\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g) ) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attrs;
}

function executableInline(html) {
  const scripts = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = attrsOf(match[1]);
    if (attrs.src) continue;
    const type = (attrs.type || '').trim().toLowerCase();
    if (DATA_TYPES.has(type)) continue;
    const body = match[2];
    if (!body.trim()) continue;
    if (type && type !== 'module' && !type.includes('javascript') && !type.includes('ecmascript')) continue;
    scripts.push(body);
  }
  return scripts;
}

async function htmlFiles(dir, acc = []) {
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return acc; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await htmlFiles(path, acc);
    else if (entry.name.endsWith('.html')) acc.push(path);
  }
  return acc;
}

function headerValue(text, name) {
  const match = text.match(new RegExp(`^\\s*${name}:\\s*(.+)$`, 'im'));
  return match ? match[1].trim() : '';
}

test('the function helper and _headers carry the same CSP', async () => {
  const file = await readFile(new URL('../public/_headers', import.meta.url), 'utf8');
  assert.equal(headerValue(file, 'Content-Security-Policy'), CSP);
  assert.equal(headerValue(file, 'X-Frame-Options'), 'DENY');
  assert.equal(headerValue(file, 'Permissions-Policy'), PERMISSIONS_POLICY);
  assert.equal(headerValue(file, 'X-Content-Type-Options'), 'nosniff');
  assert.equal(headerValue(file, 'Referrer-Policy'), 'strict-origin-when-cross-origin');
  assert.match(file, /^\/\*\n[\s\S]*! Access-Control-Allow-Origin/m);
  assert.match(file, /\/_astro\/\*\n {2}Cache-Control: public, max-age=31536000, immutable/);
  assert.match(file, /\/fonts\/\*\n {2}Cache-Control: public, max-age=31536000, immutable/);
  assert.match(file, /\/portal-shell\/\*\n {2}X-Robots-Tag: noindex, nofollow/);
  assert.match(file, /\/guide-shell\/\*\n {2}X-Robots-Tag: noindex, nofollow/);
  assert.match(file, /\/404\.html\n {2}X-Robots-Tag: noindex, nofollow/);
  assert.match(file, /\/404\n {2}X-Robots-Tag: noindex, nofollow/);
  assert.match(file, /\/404\/\*\n {2}X-Robots-Tag: noindex, nofollow/);
  assert.match(file, /\/data\/\*\n {2}X-Robots-Tag: noindex/);
  assert.match(file, /\/api\/\*\n {2}X-Robots-Tag: noindex, nofollow/);
  assert.equal(file.toLowerCase().includes('strict-transport-security'), false);

  const shared = applySecurityHeaders({ 'content-type': 'text/html' });
  assert.equal(shared.get('content-security-policy'), CSP);
  assert.equal(shared.get('x-frame-options'), 'DENY');
  assert.equal(shared.get('permissions-policy'), PERMISSIONS_POLICY);
  assert.equal(shared.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(shared.get('access-control-allow-origin'), null);

  const stripped = applySecurityHeaders({ 'access-control-allow-origin': '*' });
  assert.equal(stripped.get('access-control-allow-origin'), null);

  const page = html(new Response('ok', { headers: { 'x-etr-guide': '1', 'access-control-allow-origin': '*' } }));
  assert.equal(page.get('content-security-policy'), CSP);
  assert.equal(page.get('x-etr-guide'), '1');
  assert.equal(page.get('access-control-allow-origin'), null);

  const priv = privateHeaders();
  assert.equal(priv.get('content-security-policy'), CSP);
  assert.equal(priv.get('referrer-policy'), 'no-referrer');
  assert.equal(priv.get('x-frame-options'), 'DENY');

  const directives = parseCsp(CSP);
  assert.equal(directives.get('script-src').has("'unsafe-inline'"), false);
  assert.equal(directives.get('style-src').has("'unsafe-inline'"), true);
  for (const origin of [
    'https://tinylytics.app',
    'https://static.cloudflareinsights.com',
    'https://challenges.cloudflare.com',
  ]) {
    assert.equal(allows(directives, 'script-src', origin), true, origin);
  }
  assert.equal(allows(directives, 'connect-src', 'https://tinylytics.app'), true);
  assert.equal(allows(directives, 'connect-src', 'https://cloudflareinsights.com'), true);
  assert.equal(allows(directives, 'connect-src', 'https://challenges.cloudflare.com'), true);
  assert.equal(allows(directives, 'frame-src', 'https://challenges.cloudflare.com'), true);
  assert.equal(allows(directives, 'form-action', 'https://buy.stripe.com'), true);
  assert.equal(allows(directives, 'form-action', 'https://checkout.stripe.com'), true);
});

test('built pages and the Turnstile and Tinylytics hosts fit the CSP', async () => {
  const directives = parseCsp(CSP);
  const turnstile = await readFile(new URL('../src/lib/turnstile-client.js', import.meta.url), 'utf8');
  const turnstileHosts = [...turnstile.matchAll(/https:\/\/[a-z0-9.-]+/gi)].map((match) => new URL(match[0]).origin);
  assert.ok(turnstileHosts.includes('https://challenges.cloudflare.com'));
  for (const origin of turnstileHosts) {
    assert.equal(allows(directives, 'script-src', origin), true, `script ${origin}`);
    assert.equal(allows(directives, 'frame-src', origin), true, `frame ${origin}`);
    assert.equal(allows(directives, 'connect-src', origin), true, `connect ${origin}`);
  }
  assert.equal(allows(directives, 'connect-src', 'https://tinylytics.app'), true);

  const dist = join(ROOT.pathname, 'dist');
  const pages = await htmlFiles(dist);
  assert.ok(pages.length > 5, 'run npm run build before this test');
  let sawInlineStyle = false;
  for (const path of pages) {
    const html = await readFile(path, 'utf8');
    if (/\sstyle\s*=/.test(html) || /<style\b/i.test(html)) sawInlineStyle = true;
    for (const match of html.matchAll(/<(script|img|iframe|link|form|source|audio|video|embed|object)\b([^>]*)>/gi)) {
      const loaded = resource(match[1].toLowerCase(), attrsOf(match[2]));
      if (!loaded) continue;
      const token = hostToken(loaded.url);
      if (!token) continue;
      assert.equal(allows(directives, loaded.directive, token), true, `${path} ${loaded.directive} ${loaded.url}`);
    }
    for (const body of executableInline(html)) {
      const hash = `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`;
      assert.equal(directives.get('script-src').has(hash), true, `${path} inline script missing ${hash}`);
    }
  }
  assert.equal(sawInlineStyle, true);
});

test('function responses that are not static assets send the shared CSP', async () => {
  const { onRequestGet: dataGet } = await import('../functions/data/[file].js');
  const data = await dataGet({
    params: { file: 'la-to-sf.json' },
    env: {
      DB: {
        prepare() {
          return { bind() { return { async first() { return { json: '{"slug":"la-to-sf"}' }; } }; } };
        },
      },
    },
  });
  assert.equal(data.headers.get('content-security-policy'), CSP);
  assert.equal(data.headers.get('x-robots-tag'), 'noindex');
  assert.equal(data.headers.get('x-frame-options'), 'DENY');

  const { onRequestGet: intakeGet } = await import('../functions/api/intake.js');
  const intake = await intakeGet({ env: {} });
  assert.equal(intake.headers.get('content-security-policy'), CSP);
  assert.match(intake.headers.get('content-type'), /application\/json/);

  const { onRequestGet: sitemapGet } = await import('../functions/sitemap.xml.js');
  const sitemap = await sitemapGet({ env: {} });
  assert.equal(sitemap.headers.get('content-security-policy'), CSP);
  assert.match(sitemap.headers.get('content-type'), /application\/xml/);

  const { onRequest } = await import('../functions/_lib/plan-review.js');
  const admin = await onRequest({
    request: new Request('https://evtripreports.com/api/admin/plans'),
    env: {},
    params: {},
  });
  assert.equal(admin.headers.get('content-security-policy'), CSP);
  assert.match(admin.headers.get('content-type'), /application\/json/);
});

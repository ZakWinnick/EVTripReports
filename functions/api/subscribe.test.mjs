import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { newsletterForm } from '../../src/lib/newsletter.js';
import { onRequestGet, onRequestPost } from './subscribe.js';

const KEY = 'test-buttondown-key';
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const BUTTONDOWN = 'https://api.buttondown.com/v1/subscribers';

function request(body, headers = {}) {
  return new Request('https://evtripreports.com/api/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.8', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function read(res) {
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text), type: res.headers.get('content-type') };
}

function installFetch(handler) {
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = previous;
    },
  };
}

test('GET returns the public Turnstile site key and whether signup is open', async () => {
  const res = await read(await onRequestGet({ env: { TURNSTILE_SITE_KEY: 'site-key', TURNSTILE_SECRET: 'secret', BUTTONDOWN_API_KEY: KEY } }));
  assert.deepEqual(res.body, { turnstileSiteKey: 'site-key', open: true });
  assert.equal(res.status, 200);
  assert.equal(res.text.includes(KEY), false);
  assert.equal(res.text.includes('secret'), false);
  assert.equal(res.text.includes('BUTTONDOWN'), false);
  assert.deepEqual(Object.keys(res.body).sort(), ['open', 'turnstileSiteKey']);
});

test('GET without a site key returns null and closed when the Buttondown key is unset', async () => {
  const res = await read(await onRequestGet({ env: {} }));
  assert.deepEqual(res.body, { turnstileSiteKey: null, open: false });
});

test('GET open is true only when the Buttondown key is set', async () => {
  const closed = [
    {},
    { BUTTONDOWN_API_KEY: '' },
    { TURNSTILE_SITE_KEY: 'site-key', TURNSTILE_SECRET: 'secret' },
  ];
  for (const env of closed) {
    const res = await read(await onRequestGet({ env }));
    assert.equal(res.status, 200);
    assert.equal(res.body.open, false);
    assert.equal(res.text.includes('BUTTONDOWN'), false);
    assert.equal(res.text.includes('secret'), false);
  }

  const open = await read(await onRequestGet({ env: { BUTTONDOWN_API_KEY: KEY } }));
  assert.deepEqual(open.body, { turnstileSiteKey: null, open: true });
  assert.equal(open.text.includes(KEY), false);
});

test('missing Buttondown key does not call the API', async () => {
  const net = installFetch(() => {
    throw new Error('fetch should not run');
  });
  try {
    const res = await read(await onRequestPost({ request: request({ email: 'a@b.co' }), env: {} }));
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'Newsletter signup is not open yet.');
    assert.equal(net.calls.length, 0);
  } finally {
    net.restore();
  }
});

test('rejects a bad email before calling Buttondown', async () => {
  const net = installFetch(() => {
    throw new Error('fetch should not run');
  });
  try {
    const res = await read(await onRequestPost({ request: request({ email: 'not-an-email' }), env: { BUTTONDOWN_API_KEY: KEY } }));
    assert.equal(res.status, 400);
    assert.equal(net.calls.length, 0);
    assert.equal(res.text.includes(KEY), false);
  } finally {
    net.restore();
  }
});

test('honeypot skips Buttondown', async () => {
  const net = installFetch(() => {
    throw new Error('fetch should not run');
  });
  try {
    const res = await read(await onRequestPost({
      request: request({ email: 'a@b.co', website: 'https://spam.example' }),
      env: { BUTTONDOWN_API_KEY: KEY },
    }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
    assert.equal(net.calls.length, 0);
  } finally {
    net.restore();
  }
});

test('creates a subscriber with the site-signup tag and does not leak the key', async () => {
  const net = installFetch((url) => {
    assert.equal(url, BUTTONDOWN);
    return new Response(JSON.stringify({ id: 'sub_1', email_address: 'ada@example.com' }), { status: 201 });
  });
  try {
    const res = await read(await onRequestPost({
      request: request({ email: '  ada@example.com  ' }),
      env: { BUTTONDOWN_API_KEY: KEY },
    }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
    assert.equal(res.text.includes(KEY), false);
    assert.equal(net.calls.length, 1);
    const headers = net.calls[0].init.headers;
    assert.equal(headers.Authorization, `Token ${KEY}`);
    assert.deepEqual(JSON.parse(net.calls[0].init.body), {
      email_address: 'ada@example.com',
      tags: ['site-signup'],
      ip_address: '203.0.113.8',
    });
    assert.equal(JSON.parse(net.calls[0].init.body).type, undefined);
  } finally {
    net.restore();
  }
});

test('already subscribed is a success', async () => {
  for (const code of ['email_already_exists', 'subscriber_already_exists']) {
    const net = installFetch(() => new Response(JSON.stringify({ code, detail: 'That subscriber already exists.' }), { status: 400 }));
    try {
      const res = await read(await onRequestPost({
        request: request({ email: 'ada@example.com' }),
        env: { BUTTONDOWN_API_KEY: KEY },
      }));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true, already: true });
      assert.equal(res.text.includes('already exists'), false);
    } finally {
      net.restore();
    }
  }
});

test('Turnstile failure never reaches Buttondown', async () => {
  const net = installFetch((url) => {
    assert.equal(url, SITEVERIFY);
    return new Response(JSON.stringify({ success: false }), { status: 200 });
  });
  try {
    const res = await read(await onRequestPost({
      request: request({ email: 'ada@example.com', 'cf-turnstile-response': 'token' }),
      env: { BUTTONDOWN_API_KEY: KEY, TURNSTILE_SECRET: 'turnstile-secret' },
    }));
    assert.equal(res.status, 403);
    assert.equal(net.calls.length, 1);
    assert.equal(net.calls[0].init.body.get('secret'), 'turnstile-secret');
    assert.equal(res.text.includes('turnstile-secret'), false);
    assert.equal(res.text.includes(KEY), false);
  } finally {
    net.restore();
  }
});

test('Turnstile requires the newsletter action and hostname', async () => {
  const net = installFetch(() => new Response(JSON.stringify({
    success: true,
    action: 'plan_request',
    hostname: 'evtripreports.com',
  }), { status: 200 }));
  try {
    const res = await read(await onRequestPost({
      request: request({ email: 'ada@example.com', 'cf-turnstile-response': 'token' }),
      env: { BUTTONDOWN_API_KEY: KEY, TURNSTILE_SECRET: 'turnstile-secret' },
    }));
    assert.equal(res.status, 403);
    assert.equal(net.calls.length, 1);
  } finally {
    net.restore();
  }
});

test('passing Turnstile posts the subscriber', async () => {
  const net = installFetch((url) => {
    if (url === SITEVERIFY) {
      return new Response(JSON.stringify({ success: true, action: 'newsletter_signup', hostname: 'evtripreports.com' }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: 'sub_2' }), { status: 201 });
  });
  try {
    const res = await read(await onRequestPost({
      request: request({ email: 'ada@example.com', 'cf-turnstile-response': 'token' }),
      env: { BUTTONDOWN_API_KEY: KEY, TURNSTILE_SECRET: 'turnstile-secret' },
    }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
    assert.equal(net.calls[1].url, BUTTONDOWN);
  } finally {
    net.restore();
  }
});

test('upstream failure stays JSON and hides the key', async () => {
  const net = installFetch(() => new Response('nope', { status: 500 }));
  try {
    const res = await read(await onRequestPost({
      request: request({ email: 'ada@example.com' }),
      env: { BUTTONDOWN_API_KEY: KEY },
    }));
    assert.equal(res.status, 502);
    assert.equal(res.type.includes('application/json'), true);
    assert.equal(res.text.includes(KEY), false);
    assert.equal(res.body.error, 'Signup did not go through. Try again in a minute.');
  } finally {
    net.restore();
  }
});

test('footer and guide pages both render the signup', () => {
  const layout = readFileSync(new URL('../../src/layouts/Base.astro', import.meta.url), 'utf8');
  const guide = readFileSync(new URL('../../src/lib/render-guide.js', import.meta.url), 'utf8');
  assert.match(layout, /newsletterForm\('newsletter-footer'\)/);
  assert.match(guide, /newsletterForm\('newsletter-guide'\)/);
  assert.match(layout, /action: 'newsletter_signup'/);
});

test('newsletter forms and the route updates band stay hidden unless signup is open', () => {
  const layout = readFileSync(new URL('../../src/layouts/Base.astro', import.meta.url), 'utf8');
  const guide = readFileSync(new URL('../../src/lib/render-guide.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../../src/styles/global.css', import.meta.url), 'utf8');

  assert.match(layout, /class="wrap foot__signup newsletter-band" hidden/);
  assert.match(guide, /<section class="band band--tight newsletter-band" hidden><div class="wrap"><h2 class="h2">Route updates<\/h2>/);
  assert.match(layout, /function setOpen\(open\)/);
  assert.match(layout, /form\.closest\('\.newsletter-band'\)/);
  assert.match(layout, /form\.hidden = !open/);
  assert.match(layout, /band\.hidden = !open/);
  assert.match(layout, /setOpen\(false\)/);
  assert.match(layout, /if \(!body \|\| body\.open !== true\) return;\s*setOpen\(true\);/);
  assert.match(css, /\.newsletter-band\[hidden\],\s*form\.newsletter\[hidden\] \{ display: none !important; \}/);
  assert.doesNotMatch(layout, /BUTTONDOWN/);
  assert.match(layout, /slot\.hidden = false/);
  assert.match(layout, /action: 'newsletter_signup'/);
});

function newsletterScript() {
  const layout = readFileSync(new URL('../../src/layouts/Base.astro', import.meta.url), 'utf8');
  const match = layout.match(/<script is:inline>([\s\S]*?)<\/script>/);
  assert.ok(match);
  return match[1];
}

function classesOf(node) {
  return String(node.className || '').split(/\s+/).filter(Boolean);
}

function matches(node, selector) {
  const classes = classesOf(node);
  if (selector === 'form.newsletter') return node.tag === 'form' && classes.includes('newsletter');
  if (selector.startsWith('.')) return classes.includes(selector.slice(1));
  if (selector.includes('challenges.cloudflare.com/turnstile')) {
    return node.tag === 'script' && String(node.src || '').includes('challenges.cloudflare.com/turnstile');
  }
  return false;
}

function walk(root, selector) {
  const found = [];
  const visit = (el) => {
    for (const child of el.children) {
      if (matches(child, selector)) found.push(child);
      visit(child);
    }
  };
  visit(root);
  return found;
}

function makeElement(tag, className = '') {
  const node = {
    tag,
    className,
    hidden: false,
    src: '',
    async: false,
    onload: null,
    onerror: null,
    textContent: '',
    children: [],
    parent: null,
    listeners: {},
    closest(selector) {
      const cls = selector.startsWith('.') ? selector.slice(1) : '';
      let cur = node;
      while (cur) {
        if (cls && classesOf(cur).includes(cls)) return cur;
        cur = cur.parent;
      }
      return null;
    },
    querySelector(selector) {
      return walk(node, selector)[0] || null;
    },
    addEventListener(type, fn) {
      (node.listeners[type] ||= []).push(fn);
    },
    appendChild(child) {
      child.parent = node;
      node.children.push(child);
      return child;
    },
  };
  return node;
}

function mountNewsletterDom() {
  const guideSlot = makeElement('div', 'newsletter__slot');
  guideSlot.hidden = true;
  const guideForm = makeElement('form', 'newsletter');
  guideForm.appendChild(guideSlot);
  const heading = makeElement('h2', 'h2');
  heading.textContent = 'Route updates';
  const guideBand = makeElement('section', 'band band--tight newsletter-band');
  guideBand.appendChild(heading);
  guideBand.appendChild(guideForm);

  const footerSlot = makeElement('div', 'newsletter__slot');
  footerSlot.hidden = true;
  const footerForm = makeElement('form', 'newsletter');
  footerForm.appendChild(footerSlot);
  const footerBand = makeElement('div', 'wrap foot__signup newsletter-band');
  footerBand.appendChild(footerForm);

  const body = makeElement('body');
  body.appendChild(guideBand);
  body.appendChild(footerBand);
  const head = makeElement('head');
  return {
    guideBand,
    footerBand,
    guideForm,
    footerForm,
    guideSlot,
    footerSlot,
    heading,
    document: {
      head,
      body,
      createElement(tag) { return makeElement(tag); },
      querySelector(selector) { return walk(head, selector).concat(walk(body, selector))[0] || null; },
      querySelectorAll(selector) { return walk(head, selector).concat(walk(body, selector)); },
    },
  };
}

async function flush() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

async function runNewsletterScript(fetchImpl, fn) {
  const previous = {
    fetch: globalThis.fetch,
    document: globalThis.document,
    window: globalThis.window,
    turnstile: globalThis.turnstile,
  };
  const page = mountNewsletterDom();
  const renders = [];
  const urls = [];
  globalThis.window = globalThis;
  delete globalThis.turnstile;
  globalThis.document = page.document;
  globalThis.fetch = (url, init) => {
    urls.push({ url: String(url), init });
    return fetchImpl(url, init);
  };
  try {
    new Function(newsletterScript())();
    await fn({ ...page, renders, urls });
  } finally {
    globalThis.fetch = previous.fetch;
    if (previous.document === undefined) delete globalThis.document;
    else globalThis.document = previous.document;
    if (previous.window === undefined) delete globalThis.window;
    else globalThis.window = previous.window;
    if (previous.turnstile === undefined) delete globalThis.turnstile;
    else globalThis.turnstile = previous.turnstile;
  }
}

test('the form script hides every signup, including Route updates, unless open is true', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  await runNewsletterScript(() => pending.then(() => Response.json({
    open: false,
    turnstileSiteKey: 'site-key',
    BUTTONDOWN_API_KEY: KEY,
  })), async (closed) => {
    assert.equal(closed.urls[0].url, '/api/subscribe');
    assert.equal(closed.urls[0].init, undefined);
    assert.equal(closed.guideBand.hidden, true);
    assert.equal(closed.footerBand.hidden, true);
    assert.equal(closed.guideForm.hidden, true);
    assert.equal(closed.footerForm.hidden, true);
    assert.equal(closed.heading.parent, closed.guideBand);
    assert.equal(closed.heading.textContent, 'Route updates');
    release();
    await flush();
    assert.equal(closed.guideBand.hidden, true);
    assert.equal(closed.footerBand.hidden, true);
    assert.equal(closed.guideSlot.hidden, true);
    assert.equal(closed.footerSlot.hidden, true);
    assert.equal(closed.document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]'), null);
    assert.equal(closed.heading.parent.hidden, true);
  });

  await runNewsletterScript(async () => Response.json({ open: true, turnstileSiteKey: null }), async (opened) => {
    await flush();
    assert.equal(opened.guideBand.hidden, false);
    assert.equal(opened.footerBand.hidden, false);
    assert.equal(opened.guideForm.hidden, false);
    assert.equal(opened.footerForm.hidden, false);
    assert.equal(opened.guideSlot.hidden, true);
    assert.equal(opened.heading.parent, opened.guideBand);
    assert.equal(opened.heading.parent.hidden, false);
  });

  for (const body of [{ open: 'true' }, { open: 1 }, {}, { turnstileSiteKey: 'site-key' }]) {
    await runNewsletterScript(async () => Response.json(body), async (page) => {
      await flush();
      assert.equal(page.guideBand.hidden, true);
      assert.equal(page.footerBand.hidden, true);
      assert.equal(page.document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]'), null);
    });
  }

  await runNewsletterScript(async () => new Response('nope', { status: 503 }), async (failed) => {
    await flush();
    assert.equal(failed.guideBand.hidden, true);
    assert.equal(failed.footerBand.hidden, true);
  });

  await runNewsletterScript(() => Promise.reject(new Error('offline')), async (dropped) => {
    await flush();
    assert.equal(dropped.guideBand.hidden, true);
    assert.equal(dropped.footerBand.hidden, true);
  });
});

test('Turnstile still renders only after signup is open', async () => {
  await runNewsletterScript(async () => Response.json({ open: true, turnstileSiteKey: 'site-key' }), async (page) => {
    await flush();
    assert.equal(page.guideBand.hidden, false);
    assert.equal(page.footerBand.hidden, false);
    const script = page.document.querySelector('script[src*="challenges.cloudflare.com/turnstile/v0/api.js"]');
    assert.ok(script);
    assert.equal(script.src, 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
    assert.equal(page.guideSlot.hidden, true);
    globalThis.turnstile = {
      render(slot, opts) {
        page.renders.push({ slot, opts });
        return 'widget';
      },
    };
    script.onload();
    await flush();
    assert.equal(page.renders.length, 2);
    assert.deepEqual(page.renders.map((call) => call.opts), [
      { sitekey: 'site-key', action: 'newsletter_signup' },
      { sitekey: 'site-key', action: 'newsletter_signup' },
    ]);
    assert.equal(page.guideSlot.hidden, false);
    assert.equal(page.footerSlot.hidden, false);
  });
});

test('form markup states the offer and the Buttondown note', () => {
  const html = newsletterForm('newsletter-footer');
  assert.match(html, /New corridor guides and charger changes on the routes we cover\. No spam\./);
  assert.match(html, /Emails go to Buttondown, which sends these updates\./);
  assert.match(html, /action="\/api\/subscribe"/);
  assert.match(html, /name="email"/);
  assert.doesNotMatch(html, /BUTTONDOWN|Rangeway|—/);
  assert.throws(() => newsletterForm('bad id'));
});

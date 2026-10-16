import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  SECURITY_RETRY,
  TURNSTILE_SRC,
  loadTurnstile,
  mountNewsletterForms,
  renderWidget,
} from './turnstile-client.js';

function classesOf(node) {
  return String(node.className || '').split(/\s+/).filter(Boolean);
}

function matches(node, selector) {
  const classes = classesOf(node);
  if (selector === 'form.newsletter') return node.tag === 'form' && classes.includes('newsletter');
  if (selector === 'button[type="submit"]') return node.tag === 'button';
  if (selector === ':invalid') return node.invalid === true;
  if (selector.startsWith('.')) return classes.includes(selector.slice(1));
  const named = selector.match(/^\[name="(.+)"\]$/);
  if (named) return node.name === named[1];
  const inputNamed = selector.match(/^input\[name="(.+)"\]$/);
  if (inputNamed) return node.tag === 'input' && node.name === inputNamed[1];
  if (selector.includes('challenges.cloudflare.com/turnstile')) {
    return node.tag === 'script' && String(node.src || '').includes('challenges.cloudflare.com/turnstile');
  }
  return false;
}

function walk(root, selector) {
  const found = [];
  const visit = (el) => {
    for (const child of el.children || []) {
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
    name: '',
    value: '',
    disabled: false,
    textContent: '',
    invalid: false,
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
    classList: {
      add(...names) {
        const set = new Set(classesOf(node));
        for (const name of names) set.add(name);
        node.className = [...set].join(' ');
      },
      remove(...names) {
        const drop = new Set(names);
        node.className = classesOf(node).filter((name) => !drop.has(name)).join(' ');
      },
      contains(name) {
        return classesOf(node).includes(name);
      },
    },
    addEventListener(type, fn) {
      (node.listeners[type] ||= []).push(fn);
    },
    appendChild(child) {
      child.parent = node;
      node.children.push(child);
      return child;
    },
    reset() { node.resetCount = (node.resetCount || 0) + 1; },
  };
  return node;
}

function page() {
  const head = makeElement('head');
  const body = makeElement('body');
  return {
    head,
    body,
    createElement(tag) { return makeElement(tag); },
    querySelector(selector) { return walk(head, selector).concat(walk(body, selector))[0] || null; },
    querySelectorAll(selector) { return walk(head, selector).concat(walk(body, selector)); },
  };
}

function browser() {
  const doc = page();
  const win = { document: doc, fetch: () => { throw new Error('unexpected fetch'); } };
  delete win.turnstile;
  delete win.__etrTurnstile;
  return { doc, win };
}

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('one api.js tag is shared by every widget on the page', async () => {
  const { doc, win } = browser();
  const first = loadTurnstile(doc, win);
  const second = loadTurnstile(doc, win);
  const scripts = walk(doc.head, 'script[src*="challenges.cloudflare.com/turnstile"]');
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].src, TURNSTILE_SRC);
  assert.equal(first, second);
  win.turnstile = { render() { return 'id'; } };
  scripts[0].onload();
  assert.equal(await first, win.turnstile);
  assert.equal(await second, win.turnstile);
  delete win.__etrTurnstile;
  const again = loadTurnstile(doc, win);
  assert.equal(walk(doc.head, 'script[src*="challenges.cloudflare.com/turnstile"]').length, 1);
  assert.equal(await again, win.turnstile);
});

test('a script already on the page is not loaded a second time', async () => {
  const { doc, win } = browser();
  const existing = makeElement('script');
  existing.src = TURNSTILE_SRC;
  doc.head.appendChild(existing);
  const pending = loadTurnstile(doc, win);
  assert.equal(doc.head.children.length, 1);
  win.turnstile = { render() { return 'id'; } };
  existing.onload();
  assert.equal(await pending, win.turnstile);
});

test('render keeps a visible widget and does not drop a stored token', () => {
  const slot = makeElement('div', 'turnstile-slot');
  slot.hidden = true;
  const input = makeElement('input');
  input.name = 'cf-turnstile-response';
  input.value = 'from-input';
  slot.appendChild(input);
  const resets = [];
  const win = {
    turnstile: {
      render(el, opts) {
        assert.equal(el.hidden, false);
        assert.equal(opts.appearance, 'always');
        assert.equal(opts.action, 'find_plans');
        assert.equal(opts['response-field-name'], 'cf-turnstile-response');
        opts.callback('from-callback');
        return 0;
      },
      getResponse() { return undefined; },
      reset(id) { resets.push(id); },
    },
  };
  const widget = renderWidget(slot, { sitekey: 'site-key', action: 'find_plans' }, win);
  assert.equal(widget.id, 0);
  assert.equal(widget.getToken(), 'from-callback');
  widget.reset();
  assert.deepEqual(resets, [0]);
  assert.equal(widget.getToken(), 'from-input');
});

test('getResponse returning undefined does not erase the hidden input token', () => {
  const slot = makeElement('div');
  const input = makeElement('input');
  input.name = 'cf-turnstile-response';
  input.value = 'from-input';
  slot.appendChild(input);
  const win = {
    turnstile: {
      render() { return 'cf-chl-widget-1'; },
      getResponse() { return undefined; },
    },
  };
  const widget = renderWidget(slot, { sitekey: 'site-key', action: 'plan_request' }, win);
  assert.equal(widget.getToken(), 'from-input');
});

function newsletterDom() {
  const doc = page();
  const slot = makeElement('div', 'newsletter__slot');
  slot.hidden = true;
  const email = makeElement('input');
  email.name = 'email';
  email.value = 'ada@example.com';
  const msg = makeElement('p', 'newsletter__msg');
  const btn = makeElement('button');
  btn.textContent = 'Sign up';
  const form = makeElement('form', 'newsletter');
  form.checkValidity = () => !form.invalid;
  form.appendChild(email);
  form.appendChild(slot);
  form.appendChild(btn);
  form.appendChild(msg);
  const band = makeElement('div', 'wrap foot__signup newsletter-band');
  band.appendChild(form);
  doc.body.appendChild(band);
  return { doc, form, slot, msg, btn, email };
}

test('newsletter widgets render only after signup is open, one per form', async () => {
  const { doc, slot } = newsletterDom();
  const renders = [];
  const win = {
    document: doc,
    fetch: async () => Response.json({ open: true, turnstileSiteKey: 'site-key' }),
  };
  mountNewsletterForms(doc, win);
  await flush();
  const script = doc.querySelector('script[src*="challenges.cloudflare.com/turnstile"]');
  assert.ok(script);
  assert.equal(slot.hidden, true);
  win.turnstile = {
    render(el, opts) {
      renders.push({ el, opts });
      return 'widget-1';
    },
  };
  script.onload();
  await flush();
  assert.equal(renders.length, 1);
  assert.equal(renders[0].opts.action, 'newsletter_signup');
  assert.equal(renders[0].opts.appearance, 'always');
  assert.equal(slot.hidden, false);
  assert.equal(doc.querySelectorAll('script[src*="challenges.cloudflare.com/turnstile"]').length, 1);
});

test('a failed newsletter check resets the widget and asks for another try', async () => {
  const { doc, form, msg, btn } = newsletterDom();
  const posts = [];
  const resets = [];
  const win = {
    document: doc,
    fetch: async (url, init) => {
      if (init) {
        posts.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ error: 'The security check failed. Refresh the page and try again.' }), { status: 403 });
      }
      return Response.json({ open: true, turnstileSiteKey: 'site-key' });
    },
  };
  mountNewsletterForms(doc, win);
  await flush();
  win.turnstile = {
    render(el, opts) {
      opts.callback('issued-token');
      return 'widget-1';
    },
    reset(id) { resets.push(id); },
    getResponse() { return undefined; },
  };
  doc.querySelector('script[src*="challenges.cloudflare.com/turnstile"]').onload();
  await flush();
  form.listeners.submit[0]({ preventDefault() {} });
  await flush();
  assert.equal(posts[0]['cf-turnstile-response'], 'issued-token');
  assert.equal(posts[0].email, 'ada@example.com');
  assert.equal(msg.textContent, SECURITY_RETRY);
  assert.equal(msg.className.includes('is-err'), true);
  assert.equal(btn.disabled, false);
  assert.deepEqual(resets, ['widget-1']);
});

test('submitting before the challenge finishes does not send an empty token', async () => {
  const { doc, form, msg } = newsletterDom();
  let posted = false;
  const win = {
    document: doc,
    fetch: async (url, init) => {
      if (init) { posted = true; return Response.json({ ok: true }); }
      return Response.json({ open: true, turnstileSiteKey: 'site-key' });
    },
  };
  mountNewsletterForms(doc, win);
  await flush();
  win.turnstile = {
    render() { return 'widget-1'; },
    getResponse() { return undefined; },
    reset() {},
  };
  doc.querySelector('script[src*="challenges.cloudflare.com/turnstile"]').onload();
  await flush();
  form.listeners.submit[0]({ preventDefault() {} });
  await flush();
  assert.equal(posted, false);
  assert.equal(msg.textContent, SECURITY_RETRY);
});

test('plan and find pages use the shared widget with their own actions', () => {
  const plans = readFileSync(new URL('../pages/plans.astro', import.meta.url), 'utf8');
  const find = readFileSync(new URL('../pages/find-my-plans.astro', import.meta.url), 'utf8');
  const layout = readFileSync(new URL('../layouts/Base.astro', import.meta.url), 'utf8');
  const client = readFileSync(new URL('./turnstile-client.js', import.meta.url), 'utf8');
  for (const src of [plans, find, layout]) assert.match(src, /turnstile-client\.js/);
  assert.match(plans, /action: 'plan_request'/);
  assert.match(find, /action: 'find_plans'/);
  assert.match(client, /action: 'newsletter_signup'/);
  assert.match(client, /appearance: 'always'/);
  assert.match(client, /cf-turnstile-response/);
  assert.match(plans, /SECURITY_RETRY/);
  assert.match(find, /SECURITY_RETRY/);
});

test('the widget is compact on screens under 360px and normal otherwise', () => {
  for (const [width, size] of [[320, 'compact'], [359, 'compact'], [360, 'normal'], [1280, 'normal'], [undefined, 'normal']]) {
    let seen = '';
    const win = { innerWidth: width, turnstile: { render(_slot, opts) { seen = opts.size; return 1; } } };
    renderWidget(makeElement('div'), { sitekey: 'k', action: 'plan_request' }, win);
    assert.equal(seen, size);
  }
});

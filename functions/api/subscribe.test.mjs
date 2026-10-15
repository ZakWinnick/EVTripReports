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

test('GET returns only the public Turnstile site key', async () => {
  const res = await read(await onRequestGet({ env: { TURNSTILE_SITE_KEY: 'site-key', TURNSTILE_SECRET: 'secret', BUTTONDOWN_API_KEY: KEY } }));
  assert.deepEqual(res.body, { turnstileSiteKey: 'site-key' });
  assert.equal(res.text.includes(KEY), false);
  assert.equal(res.text.includes('secret'), false);
  assert.equal(res.body.turnstileSiteKey !== undefined && Object.keys(res.body).length === 1, true);
});

test('GET without a site key returns null', async () => {
  const res = await read(await onRequestGet({ env: {} }));
  assert.deepEqual(res.body, { turnstileSiteKey: null });
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

test('form markup states the offer and the Buttondown note', () => {
  const html = newsletterForm('newsletter-footer');
  assert.match(html, /New corridor guides and charger changes on the routes we cover\. No spam\./);
  assert.match(html, /Emails go to Buttondown, which sends these updates\./);
  assert.match(html, /action="\/api\/subscribe"/);
  assert.match(html, /name="email"/);
  assert.doesNotMatch(html, /BUTTONDOWN|Rangeway|—/);
  assert.throws(() => newsletterForm('bad id'));
});

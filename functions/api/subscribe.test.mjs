import assert from 'node:assert/strict';
import test from 'node:test';
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

function rateDb(n = 0) {
  return {
    prepare(sql) {
      return {
        bind() {
          return {
            async first() { return { n }; },
            async run() { return { success: true }; },
          };
        },
      };
    },
  };
}

test('subscribe rate-limits an IP when D1 is bound', async () => {
  const net = installFetch(() => { throw new Error('fetch should not run'); });
  try {
    const res = await read(await onRequestPost({
      request: request({ email: 'a@b.co' }),
      env: { BUTTONDOWN_API_KEY: KEY, DB: rateDb(10) },
    }));
    assert.equal(res.status, 429);
    assert.equal(res.body.error, 'Too many requests. Wait a few minutes and try again.');
    assert.equal(net.calls.length, 0);
  } finally {
    net.restore();
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyTurnstile } from './turnstile.js';

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

function request(ip = '203.0.113.9') {
  const headers = ip ? { 'CF-Connecting-IP': ip } : {};
  return new Request('https://evtripreports.com/api/intake', { headers });
}

function installFetch(handler) {
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return {
    calls,
    restore() { globalThis.fetch = previous; },
  };
}

test('a missing secret skips siteverify', async () => {
  const net = installFetch(() => { throw new Error('fetch should not run'); });
  try {
    assert.equal(await verifyTurnstile(request(), {}, '', 'find_plans'), true);
    assert.equal(net.calls.length, 0);
  } finally {
    net.restore();
  }
});

test('an empty or oversized token fails before siteverify', async () => {
  const net = installFetch(() => { throw new Error('fetch should not run'); });
  try {
    const env = { TURNSTILE_SECRET: 'secret' };
    assert.equal(await verifyTurnstile(request(), env, '', 'find_plans'), false);
    assert.equal(await verifyTurnstile(request(), env, undefined, 'newsletter_signup'), false);
    assert.equal(await verifyTurnstile(request(), env, 'x'.repeat(2049), 'plan_request'), false);
    assert.equal(net.calls.length, 0);
  } finally {
    net.restore();
  }
});

test('siteverify is called with the secret and the client IP', async () => {
  const net = installFetch(() => Response.json({ success: true, action: 'find_plans', hostname: 'evtripreports.com' }));
  try {
    const ok = await verifyTurnstile(request('203.0.113.8'), { TURNSTILE_SECRET: 'secret' }, 'token', 'find_plans');
    assert.equal(ok, true);
    assert.equal(net.calls[0].url, SITEVERIFY);
    assert.equal(net.calls[0].init.body.get('secret'), 'secret');
    assert.equal(net.calls[0].init.body.get('response'), 'token');
    assert.equal(net.calls[0].init.body.get('remoteip'), '203.0.113.8');
  } finally {
    net.restore();
  }
});

test('the action must match the form that rendered the widget', async () => {
  const net = installFetch(() => Response.json({ success: true, action: 'plan_request', hostname: 'evtripreports.com' }));
  try {
    const env = { TURNSTILE_SECRET: 'secret' };
    assert.equal(await verifyTurnstile(request(), env, 'token', 'find_plans'), false);
    assert.equal(await verifyTurnstile(request(), env, 'token', 'newsletter_signup'), false);
    assert.equal(await verifyTurnstile(request(), env, 'token', 'plan_request'), true);
  } finally {
    net.restore();
  }
});

test('the hostname must be in TURNSTILE_HOSTNAMES', async () => {
  const cases = [
    [{ success: true, action: 'find_plans', hostname: 'evtripreports.com' }, {}, true],
    [{ success: true, action: 'find_plans', hostname: 'www.evtripreports.com' }, {}, false],
    [{ success: true, action: 'find_plans', hostname: 'www.evtripreports.com' }, { TURNSTILE_HOSTNAMES: 'evtripreports.com, www.evtripreports.com' }, true],
    [{ success: true, action: 'find_plans', hostname: 'preview.example' }, { TURNSTILE_HOSTNAMES: 'evtripreports.com, www.evtripreports.com' }, false],
    [{ success: true, action: 'newsletter_signup', hostname: 'evtripreports.com' }, { TURNSTILE_HOSTNAMES: ' evtripreports.com , www.evtripreports.com ' }, true],
  ];
  for (const [payload, extra, expected] of cases) {
    const net = installFetch(() => Response.json(payload));
    try {
      const ok = await verifyTurnstile(request(), { TURNSTILE_SECRET: 'secret', ...extra }, 'token', payload.action);
      assert.equal(ok, expected, JSON.stringify(payload));
    } finally {
      net.restore();
    }
  }
});

test('siteverify failures fail closed', async () => {
  const env = { TURNSTILE_SECRET: 'secret' };
  const failures = [
    () => { throw new Error('offline'); },
    () => new Response('nope', { status: 500 }),
    () => new Response('not-json', { status: 200 }),
    () => Response.json({ success: false, action: 'find_plans', hostname: 'evtripreports.com' }),
    () => Response.json({ success: true, hostname: 'evtripreports.com' }),
  ];
  for (const handler of failures) {
    const net = installFetch(handler);
    try {
      assert.equal(await verifyTurnstile(request(), env, 'token', 'find_plans'), false);
    } finally {
      net.restore();
    }
  }
});

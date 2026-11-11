import assert from 'node:assert/strict';
import test from 'node:test';
import { onRequest } from './_middleware.js';

const next = () => new Response('ok', { status: 200 });

function call(url, method = 'GET', host) {
  const headers = {};
  if (host) headers.Host = host;
  return onRequest({ request: new Request(url, { method, headers }), next });
}

test('canonical hosts are passed through', async () => {
  assert.equal((await call('https://evtripreports.com/api/intake')).status, 200);
  assert.equal((await call('https://www.evtripreports.com/find-my-plans')).status, 200);
});

test('official pages.dev production host is redirected on GET and HEAD', async () => {
  const get = await call('https://evtripreports.pages.dev/guides/la-to-vegas?x=1');
  assert.equal(get.status, 301);
  assert.equal(get.headers.get('Location'), 'https://evtripreports.com/guides/la-to-vegas?x=1');
  const head = await call('https://evtripreports.pages.dev/', 'HEAD');
  assert.equal(head.status, 301);
  assert.equal(head.headers.get('Location'), 'https://evtripreports.com/');
});

test('non-canonical hosts reject non-GET methods', async () => {
  const post = await call('https://evtripreports.pages.dev/api/intake', 'POST');
  assert.equal(post.status, 403);
  const unique = await call('https://6f97aa21.evtripreports.pages.dev/api/subscribe', 'POST');
  assert.equal(unique.status, 403);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { onApi, onList, onOpen, onPlan, NEUTRAL_MESSAGE, SIGNIN_TTL_MS } from '../_lib/portal.js';
import { renderPlan } from '../../src/lib/render-plan.js';
import { sha256Hex } from '../_lib/tokens.js';

const PLAN = {
  title: 'Pasadena to Phoenix',
  summary: 'Route plan for a 2024 Ioniq 5 with a NACS adapter.',
  highway: 'I-10',
  checked: '2026-10-14',
  car: '2024 Ioniq 5',
  startLabel: 'Pasadena',
  endLabel: 'Phoenix',
  stats: [
    { label: 'Distance', value: '370', unit: 'mi', url: 'https://example.com/miles', sourceName: 'Caltrans', checkedOn: '2026-10-14' },
  ],
  sources: { tesla: { name: 'Tesla Find Us', url: 'https://www.tesla.com/findus' } },
  stops: [
    {
      id: 'barstow',
      name: 'Barstow',
      towns: 'Barstow, CA',
      mile: 120,
      why: 'Desert stop.',
      primary: {
        name: 'Tesla 1503 East Main Street',
        network: 'Tesla',
        address: '1503 East Main Street, Barstow, CA',
        stalls: {
          value: '120',
          status: 'verified',
          url: 'https://www.tesla.com/findus/location/supercharger/18383',
          sourceName: 'Tesla Find Us',
          checkedOn: '2026-10-14',
        },
        power: { value: '325 kW', status: 'verified', source: 'tesla', checkedOn: '2026-10-13' },
        access: { value: 'Open with a NACS adapter', status: 'verified', source: 'tesla' },
        price: { value: '$0.64/kWh', status: 'verified', url: 'https://www.tesla.com/findus/location/supercharger/18383', checkedOn: '2026-10-14' },
      },
      backups: [
        {
          name: 'Electrify America Walmart',
          network: 'Electrify America',
          address: '100 Walmart Way',
          facts: '7 stalls at 350 kW',
          status: 'verified',
          url: 'https://www.electrifyamerica.com/locate-charger/',
          sourceName: 'Electrify America',
          checkedOn: '2026-10-12',
        },
      ],
    },
  ],
  hotels: [
    {
      name: 'Holiday Inn Barstow',
      address: '1984 E Main St',
      charger: { value: '1 Tesla wall connector', url: 'https://www.tesla.com/findus', sourceName: 'Tesla Find Us', checkedOn: '2026-10-11' },
    },
  ],
  tips: [{ text: 'Leave Pasadena above 80 percent.', url: 'https://example.com/tip', sourceName: 'Driver note', checkedOn: '2026-10-14' }],
  facts: [{ label: 'Note', value: '<script>alert(1)</script>', url: 'javascript:alert(1)', checkedOn: '2026-10-14' }],
};

const LEGACY_TOKEN = 'L'.repeat(43);
const HASH_TOKEN = 'H'.repeat(43);
const HIDDEN_TOKEN = 'B'.repeat(43);

function memoryDb() {
  const requests = [
    { id: 1, email: 'Ada@Example.com', status: 'approved', tier: 'Route plan', car: '2024 Ioniq 5', port: 'CCS port, with a NACS adapter', start_place: 'Pasadena, CA', end_place: 'Phoenix, AZ', depart: '2026-11-01', return_date: '' },
    { id: 2, email: 'bea@example.com', status: 'review', tier: 'Detailed plan', car: 'Model Y', port: 'NACS', start_place: 'Seattle, WA', end_place: 'Portland, OR', depart: '2026-11-02', return_date: '' },
    { id: 3, email: 'legacy@example.com', status: 'approved', tier: 'Route plan', car: 'Bolt', port: 'CCS', start_place: 'LA', end_place: 'Vegas', depart: '2026-11-03', return_date: '' },
    { id: 4, email: 'hash@example.com', status: 'approved', tier: 'Route plan', car: 'Rivian R1S', port: 'CCS', start_place: 'SF', end_place: 'Tahoe', depart: '2026-11-04', return_date: '' },
    { id: 5, email: 'cam@example.com', status: 'approved', tier: 'Route plan', car: 'Bolt', port: 'CCS', start_place: 'NYC', end_place: 'Boston', depart: '2026-11-05', return_date: '' },
  ];
  const drafts = [
    { id: 10, request_id: 1, format: 'markdown', body: JSON.stringify(PLAN), sources: '[]', access_code: 'a'.repeat(64) },
    { id: 11, request_id: 2, format: 'html', body: '<p>secret draft</p>', sources: '[]', access_code: HIDDEN_TOKEN },
    { id: 12, request_id: 3, format: 'markdown', body: JSON.stringify({ title: 'Legacy plan', summary: 'Kept for an older code.' }), sources: '[]', access_code: LEGACY_TOKEN },
    { id: 13, request_id: 4, format: 'markdown', body: JSON.stringify({ title: 'Hashed plan', summary: 'Looked up by digest.' }), sources: '[]', access_code: null },
    { id: 14, request_id: 5, format: 'html', body: '<img src=x onerror=alert(1)>', sources: '[]', access_code: 'c'.repeat(64) },
  ];
  const links = [];
  const signins = [];
  const sessions = [];
  const rates = [];
  let signinId = 1;
  const planRow = (draft, request) => ({
    id: draft.id,
    body: draft.body,
    sources: draft.sources,
    format: draft.format,
    access_code: draft.access_code,
    request_id: draft.request_id,
    status: request.status,
    tier: request.tier,
    car: request.car,
    port: request.port,
    start_place: request.start_place,
    end_place: request.end_place,
    depart: request.depart,
    return_date: request.return_date,
  });
  return {
    requests,
    drafts,
    links,
    signins,
    sessions,
    rates,
    prepare(sql) {
      const text = sql.replace(/\s+/g, ' ').trim();
      let bound = [];
      const api = {
        bind(...args) {
          bound = args;
          return api;
        },
        async all() {
          if (text.includes('AS request_id') && text.includes("r.status = 'approved'")) {
            const results = [];
            for (const request of requests) {
              if (request.email.toLowerCase() !== bound[0] || request.status !== 'approved') continue;
              for (const draft of drafts) {
                if (draft.request_id === request.id && draft.access_code != null) {
                  results.push({
                    request_id: request.id,
                    tier: request.tier,
                    car: request.car,
                    start_place: request.start_place,
                    end_place: request.end_place,
                    depart: request.depart,
                    return_date: request.return_date,
                    draft_id: draft.id,
                  });
                }
              }
            }
            results.sort((a, b) => a.request_id - b.request_id);
            return { results };
          }
          throw new Error(`unhandled all: ${text}`);
        },
        async first() {
          if (text.includes('COUNT(*) AS n FROM portal_rate_limits')) {
            const n = rates.filter((row) => row.scope === bound[0] && row.key_hash === bound[1] && row.created_at > bound[2]).length;
            return { n };
          }
          if (text.startsWith('SELECT l.draft_id')) {
            const link = links.find((row) => row.token_hash === bound[0]);
            if (!link) return null;
            const draft = drafts.find((row) => row.id === link.draft_id && row.access_code != null);
            const request = requests.find((row) => row.id === link.request_id && row.email.toLowerCase() === bound[1] && row.status === 'approved');
            if (!draft || !request) return null;
            return { draft_id: link.draft_id };
          }
          if (text.includes('FROM portal_signins WHERE token_hash = ?')) {
            const row = signins.find((item) => item.token_hash === bound[0]);
            return row ? { id: row.id, email: row.email, expires_at: row.expires_at, used_at: row.used_at } : null;
          }
          if (text.includes('FROM portal_sessions WHERE token_hash = ?')) {
            const row = sessions.find((item) => item.token_hash === bound[0]);
            return row ? { email: row.email, expires_at: row.expires_at } : null;
          }
          if (text.includes('FROM plan_links l') && text.includes('SELECT d.id, d.body')) {
            const link = links.find((row) => row.token_hash === bound[0]);
            if (!link) return null;
            const draft = drafts.find((row) => row.id === link.draft_id);
            const request = requests.find((row) => row.id === link.request_id);
            if (!draft || !request) return null;
            return planRow(draft, request);
          }
          if (text.includes('WHERE d.access_code = ?')) {
            const draft = drafts.find((row) => row.access_code === bound[0]);
            if (!draft) return null;
            const request = requests.find((row) => row.id === draft.request_id);
            return request ? planRow(draft, request) : null;
          }
          throw new Error(`unhandled first: ${text}`);
        },
        async run() {
          if (text.startsWith('DELETE FROM portal_rate_limits')) {
            for (let i = rates.length - 1; i >= 0; i--) if (rates[i].created_at < bound[0]) rates.splice(i, 1);
            return { success: true, meta: { changes: 1 } };
          }
          if (text.startsWith('INSERT INTO portal_rate_limits')) {
            rates.push({ scope: bound[0], key_hash: bound[1], created_at: bound[2] });
            return { success: true, meta: { changes: 1 } };
          }
          if (text.startsWith('INSERT INTO portal_signins')) {
            signins.push({ id: signinId++, email: bound[0], token_hash: bound[1], created_at: bound[2], expires_at: bound[3], used_at: null });
            return { success: true, meta: { changes: 1 } };
          }
          if (text.startsWith('UPDATE portal_signins SET used_at')) {
            const row = signins.find((item) => item.token_hash === bound[1] && item.used_at == null && item.expires_at > bound[2]);
            if (row) row.used_at = bound[0];
            return { success: true, meta: { changes: row ? 1 : 0 } };
          }
          if (text.startsWith('INSERT INTO portal_sessions')) {
            sessions.push({ email: bound[0], token_hash: bound[1], created_at: bound[2], expires_at: bound[3] });
            return { success: true, meta: { changes: 1 } };
          }
          if (text.startsWith('INSERT INTO plan_links')) {
            links.push({ request_id: bound[0], draft_id: bound[1], token_hash: bound[2], created_at: bound[3] });
            return { success: true, meta: { changes: 1 } };
          }
          throw new Error(`unhandled run: ${text}`);
        },
      };
      return api;
    },
  };
}

function installFetch(log, { failSend = false, hold = null } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const body = opts.body ? String(opts.body) : '';
    log.push({ url: String(url), body });
    if (String(url).includes('siteverify')) {
      const response = new URLSearchParams(body).get('response');
      if (response === 'pass') return Response.json({ success: true, action: 'find_plans', hostname: 'evtripreports.com' });
      if (response === 'wrong-action') return Response.json({ success: true, action: 'plan_request', hostname: 'evtripreports.com' });
      return Response.json({ success: false });
    }
    if (hold) await hold;
    if (failSend) throw new Error('network down');
    if (String(url).includes('/jmap/session')) {
      return Response.json({ apiUrl: 'https://api.fastmail.com/jmap/', primaryAccounts: { 'urn:ietf:params:jmap:submission': 'acc' } });
    }
    const payload = JSON.parse(body);
    const names = payload.methodCalls.map((call) => call[0]);
    if (names.includes('Identity/get')) {
      return Response.json({
        methodResponses: [
          ['Identity/get', { list: [{ id: 'id1', email: 'admin@evtripreports.com' }] }, 'i'],
          ['Mailbox/query', { ids: ['drafts'] }, 'm'],
        ],
      });
    }
    return Response.json({
      methodResponses: [
        ['Email/set', { created: { msg: { id: 'm1' } } }, 'e'],
        ['EmailSubmission/set', { created: { sub: { id: 's1' } } }, 's'],
      ],
    });
  };
  return () => { globalThis.fetch = original; };
}

function sentMails(log) {
  return log
    .filter((entry) => entry.body.includes('Email/set'))
    .map((entry) => JSON.parse(entry.body).methodCalls[0][1].create.msg);
}

function postPortal(db, { email = 'ada@example.com', ip = '203.0.113.5', extra = {}, env = {} } = {}) {
  const pending = [];
  const response = onApi({
    request: new Request('https://evtripreports.com/api/portal', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip },
      body: JSON.stringify({ email, ...extra }),
    }),
    env: { DB: db, FASTMAIL_TOKEN: 'fastmail-token', ...env },
    waitUntil(promise) { pending.push(promise); },
  });
  return response.then(async (res) => {
    await Promise.all(pending);
    return res;
  });
}

test('a plan renders source links, checked dates, and escaped facts', () => {
  const html = renderPlan(PLAN, { tier: 'Route plan', draftSources: [{ label: 'DOE', url: 'https://afdc.energy.gov/stations' }] });
  assert.match(html, /class="sheet"/);
  assert.match(html, /class="spec"/);
  assert.match(html, /https:\/\/www\.tesla\.com\/findus\/location\/supercharger\/18383/);
  assert.match(html, /Tesla Find Us/);
  assert.match(html, /Checked Oct 14, 2026/);
  assert.match(html, /Checked Oct 13, 2026/);
  assert.match(html, /https:\/\/www\.tesla\.com\/findus/);
  assert.match(html, /Electrify America/);
  assert.match(html, /Checked Oct 12, 2026/);
  assert.match(html, /Holiday Inn Barstow/);
  assert.match(html, /Checked Oct 11, 2026/);
  assert.match(html, /rel="nofollow noopener noreferrer"/);
  assert.match(html, /DOE/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(html.includes('<script>alert'), false);
  assert.equal(html.includes('javascript:'), false);
  assert.equal(html.includes('\u2014'), false);
});

test('the portal answers the same way when the email has no plan', async () => {
  const db = memoryDb();
  const log = [];
  const restore = installFetch(log);
  try {
    const known = await postPortal(db, { email: 'Ada@Example.com' });
    const unknown = await postPortal(db, { email: 'nobody@example.com', ip: '203.0.113.6' });
    assert.equal(known.status, 200);
    assert.equal(unknown.status, 200);
    assert.deepEqual(await known.json(), { ok: true, message: NEUTRAL_MESSAGE });
    assert.deepEqual(await unknown.json(), { ok: true, message: NEUTRAL_MESSAGE });
    const mails = sentMails(log);
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to[0].email, 'ada@example.com');
    assert.equal(mails[0].from[0].email, 'admin@evtripreports.com');
    assert.equal(mails[0].subject, 'Your EV Trip Reports sign-in link');
    const text = mails[0].bodyValues.body.value;
    assert.match(text, /https:\/\/evtripreports\.com\/find-my-plans\/open\/[A-Za-z0-9_-]{43}/);
    assert.equal(text.includes('\u2014'), false);
    assert.equal(text.includes('/plan/'), false);
    const token = text.match(/open\/([A-Za-z0-9_-]{43})/)[1];
    assert.equal(db.signins.length, 1);
    assert.equal(db.signins[0].email, 'ada@example.com');
    assert.equal(db.signins[0].token_hash, await sha256Hex(token));
    assert.notEqual(db.signins[0].token_hash, token);
    assert.equal(Date.parse(db.signins[0].expires_at) - Date.parse(db.signins[0].created_at), SIGNIN_TTL_MS);
    assert.equal(JSON.stringify(db.signins).includes(token), false);
  } finally {
    restore();
  }
});

test('a review-only email is treated like an unknown email', async () => {
  const db = memoryDb();
  const log = [];
  const restore = installFetch(log);
  try {
    const res = await postPortal(db, { email: 'bea@example.com' });
    assert.deepEqual(await res.json(), { ok: true, message: NEUTRAL_MESSAGE });
    assert.equal(sentMails(log).length, 0);
    assert.equal(db.signins.length, 0);
  } finally {
    restore();
  }
});

test('rate limits are per email and per IP and do not reveal a plan', async () => {
  const db = memoryDb();
  const log = [];
  const restore = installFetch(log);
  try {
    for (let i = 0; i < 3; i++) assert.equal((await postPortal(db, { email: 'nobody@example.com', ip: '203.0.113.10' })).status, 200);
    const limited = await postPortal(db, { email: 'nobody@example.com', ip: '203.0.113.10' });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error, 'Too many requests. Wait a few minutes and try again.');
    const other = await postPortal(db, { email: 'Ada@Example.com', ip: '203.0.113.10' });
    assert.equal(other.status, 200);
    assert.equal(sentMails(log).length, 1);

    for (let i = 0; i < 10; i++) {
      assert.equal((await postPortal(db, { email: `n${i}@example.com`, ip: '203.0.113.20' })).status, 200);
    }
    const blocked = await postPortal(db, { email: 'Ada@Example.com', ip: '203.0.113.20' });
    assert.equal(blocked.status, 429);
    assert.equal(sentMails(log).length, 1);
  } finally {
    restore();
  }
});

test('turnstile, honeypot, and a missing mail token stay neutral', async () => {
  const db = memoryDb();
  const log = [];
  const restore = installFetch(log);
  try {
    const closed = await onApi({
      request: new Request('https://evtripreports.com/api/portal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'ada@example.com' }),
      }),
      env: { DB: { prepare() { throw new Error('should not query'); } } },
    });
    assert.equal(closed.status, 503);

    const honey = await postPortal(db, { extra: { website: 'spam', email: 'ada@example.com' } });
    assert.deepEqual(await honey.json(), { ok: true, message: NEUTRAL_MESSAGE });
    assert.equal(db.signins.length, 0);

    const bad = await postPortal(db, { email: 'not-an-email' });
    assert.equal(bad.status, 400);

    const blocked = await postPortal(db, {
      extra: { email: 'ada@example.com', 'cf-turnstile-response': 'nope' },
      env: { TURNSTILE_SECRET: 'secret' },
    });
    assert.equal(blocked.status, 403);
    const wrong = await postPortal(db, {
      extra: { email: 'ada@example.com', 'cf-turnstile-response': 'wrong-action' },
      env: { TURNSTILE_SECRET: 'secret' },
    });
    assert.equal(wrong.status, 403);

    const passed = await postPortal(db, {
      extra: { email: 'ada@example.com', 'cf-turnstile-response': 'pass' },
      env: { TURNSTILE_SECRET: 'secret', TURNSTILE_SITE_KEY: 'site' },
    });
    assert.equal(passed.status, 200);
    assert.equal(sentMails(log).length, 1);
    assert.equal(db.signins.length, 1);
  } finally {
    restore();
  }
});

test('the response is not held for mail, with or without plans', async () => {
  const db = memoryDb();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const log = [];
  const restore = installFetch(log, { hold: gate });
  const pending = [];
  const call = (email, ip) => onApi({
    request: new Request('https://evtripreports.com/api/portal', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip },
      body: JSON.stringify({ email }),
    }),
    env: { DB: db, FASTMAIL_TOKEN: 'fastmail-token' },
    waitUntil(promise) { pending.push(promise); },
  });
  const within = (promise) => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('response waited on mail')), 500);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  };
  try {
    const known = await within(call('ada@example.com', '203.0.113.30'));
    const unknown = await within(call('nobody@example.com', '203.0.113.31'));
    assert.equal(known.status, 200);
    assert.equal(unknown.status, 200);
    assert.deepEqual(await known.json(), { ok: true, message: NEUTRAL_MESSAGE });
    assert.deepEqual(await unknown.json(), { ok: true, message: NEUTRAL_MESSAGE });
    assert.equal(sentMails(log).length, 0);
    release();
    await Promise.all(pending);
    assert.equal(sentMails(log).length, 1);
  } finally {
    release();
    restore();
  }
});

test('a failed send still returns the neutral message', async () => {
  const db = memoryDb();
  const log = [];
  const restore = installFetch(log, { failSend: true });
  try {
    const res = await postPortal(db, { email: 'ada@example.com' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, message: NEUTRAL_MESSAGE });
  } finally {
    restore();
  }
});

test('the sign-in link is single use and lists only approved plans', async () => {
  const db = memoryDb();
  db.drafts.find((row) => row.id === 13).access_code = await sha256Hex(HASH_TOKEN);
  const log = [];
  const restore = installFetch(log);
  try {
    assert.equal((await postPortal(db, { email: 'ada@example.com' })).status, 200);
    const token = sentMails(log)[0].bodyValues.body.value.match(/open\/([A-Za-z0-9_-]{43})/)[1];
    const opened = await onOpen({
      request: new Request(`https://evtripreports.com/find-my-plans/open/${token}`),
      params: { token },
      env: { DB: db },
    });
    assert.equal(opened.status, 200);
    assert.match(await opened.text(), /Show my plans/);
    assert.equal(opened.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal(opened.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(db.signins[0].used_at, null);

    const used = await onOpen({
      request: new Request(`https://evtripreports.com/find-my-plans/open/${token}`, { method: 'POST' }),
      params: { token },
      env: { DB: db },
    });
    assert.equal(used.status, 303);
    assert.equal(used.headers.get('location'), '/find-my-plans/list');
    const session = used.headers.get('set-cookie').match(/etr_portal=([^;]+)/)[1];
    assert.equal(db.signins[0].used_at == null, false);
    assert.notEqual(db.sessions[0].token_hash, session);

    const again = await onOpen({
      request: new Request(`https://evtripreports.com/find-my-plans/open/${token}`, { method: 'POST' }),
      params: { token },
      env: { DB: db },
    });
    assert.equal(again.status, 400);
    assert.match(await again.text(), /already used/);

    const list = await onList({
      request: new Request('https://evtripreports.com/find-my-plans/list', { headers: { cookie: `etr_portal=${session}` } }),
      env: { DB: db },
    });
    assert.equal(list.status, 200);
    const listHtml = await list.text();
    assert.match(listHtml, /Pasadena, CA to Phoenix, AZ/);
    assert.equal(listHtml.includes('Seattle'), false);
    assert.equal(listHtml.includes('secret draft'), false);
    assert.equal(listHtml.includes('ada@example.com'), false);
    const planToken = listHtml.match(/\/plan\/([A-Za-z0-9_-]{43})/)[1];
    const planHash = await sha256Hex(planToken);
    assert.equal(db.links.some((row) => row.token_hash === planToken), false);
    assert.equal(db.links.some((row) => row.token_hash === planHash), true);
    const plansCookie = list.headers.get('set-cookie').match(/etr_plans=([^;]+)/)[1];

    const againList = await onList({
      request: new Request('https://evtripreports.com/find-my-plans/list', {
        headers: { cookie: `etr_portal=${session}; etr_plans=${plansCookie}` },
      }),
      env: { DB: db },
    });
    assert.equal(db.links.length, 1);
    assert.match(await againList.text(), new RegExp(`/plan/${planToken}`));

    const page = await onPlan({
      request: new Request(`https://evtripreports.com/plan/${planToken}`),
      params: { token: planToken },
      env: { DB: db },
    });
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(page.headers.get('cache-control'), 'private, no-store');
    const html = await page.text();
    assert.match(html, /https:\/\/www\.tesla\.com\/findus\/location\/supercharger\/18383/);
    assert.match(html, /Checked Oct 14, 2026/);
    assert.match(html, /class="sheet"/);
    assert.equal(html.includes('ada@example.com'), false);
    assert.equal(html.includes('<script>alert'), false);

    const hidden = await onPlan({
      request: new Request(`https://evtripreports.com/plan/${HIDDEN_TOKEN}`),
      params: { token: HIDDEN_TOKEN },
      env: { DB: db },
    });
    const missing = await onPlan({
      request: new Request(`https://evtripreports.com/plan/${'q'.repeat(43)}`),
      params: { token: 'q'.repeat(43) },
      env: { DB: db },
    });
    assert.equal(hidden.status, 404);
    assert.equal(missing.status, 404);
    assert.equal(await hidden.text(), await missing.text());
    assert.equal(hidden.headers.get('x-robots-tag'), 'noindex, nofollow');

    const legacy = await onPlan({
      request: new Request(`https://evtripreports.com/plan/${LEGACY_TOKEN}`),
      params: { token: LEGACY_TOKEN },
      env: { DB: db },
    });
    assert.equal(legacy.status, 404);
    assert.equal((await legacy.text()).includes('Legacy plan'), false);
    const hashed = await onPlan({
      request: new Request(`https://evtripreports.com/plan/${HASH_TOKEN}`),
      params: { token: HASH_TOKEN },
      env: { DB: db },
    });
    assert.match(await hashed.text(), /Hashed plan/);
    const digest = db.drafts.find((row) => row.id === 13).access_code;
    const asHash = await onPlan({
      request: new Request(`https://evtripreports.com/plan/${digest}`),
      params: { token: digest },
      env: { DB: db },
    });
    assert.equal(asHash.status, 404);
    assert.equal((await asHash.text()).includes('Hashed plan'), false);

    db.signins[0].expires_at = '2020-01-01T00:00:00.000Z';
    db.signins[0].used_at = null;
    const expired = await onOpen({
      request: new Request(`https://evtripreports.com/find-my-plans/open/${token}`, { method: 'POST' }),
      params: { token },
      env: { DB: db },
    });
    assert.equal(expired.status, 400);
    assert.match(await expired.text(), /expired/);
  } finally {
    restore();
  }
});

test('a non-json draft is not rendered as HTML', async () => {
  const db = memoryDb();
  const log = [];
  const restore = installFetch(log);
  try {
    await postPortal(db, { email: 'cam@example.com' });
    const token = sentMails(log)[0].bodyValues.body.value.match(/open\/([A-Za-z0-9_-]{43})/)[1];
    const used = await onOpen({
      request: new Request(`https://evtripreports.com/find-my-plans/open/${token}`, { method: 'POST' }),
      params: { token },
      env: { DB: db },
    });
    const session = used.headers.get('set-cookie').match(/etr_portal=([^;]+)/)[1];
    const list = await onList({
      request: new Request('https://evtripreports.com/find-my-plans/list', { headers: { cookie: `etr_portal=${session}` } }),
      env: { DB: db },
    });
    const planToken = (await list.text()).match(/\/plan\/([A-Za-z0-9_-]{43})/)[1];
    const page = await onPlan({
      request: new Request(`https://evtripreports.com/plan/${planToken}`),
      params: { token: planToken },
      env: { DB: db },
    });
    const html = await page.text();
    assert.match(html, /can't be shown yet/);
    assert.equal(html.includes('onerror'), false);
    assert.equal(html.includes('<img'), false);
  } finally {
    restore();
  }
});

test('pages and schema mention the portal and do not add a new secret', () => {
  const footer = readFileSync(new URL('../../src/layouts/Base.astro', import.meta.url), 'utf8');
  const plans = readFileSync(new URL('../../src/pages/plans.astro', import.meta.url), 'utf8');
  const schema = readFileSync(new URL('../../schema-portal.sql', import.meta.url), 'utf8');
  const find = readFileSync(new URL('../../src/pages/find-my-plans.astro', import.meta.url), 'utf8');
  assert.match(footer, /href="\/find-my-plans"/);
  assert.match(plans, /id="paid-thanks"[\s\S]*href="\/find-my-plans"/);
  assert.match(find, /action: 'find_plans'/);
  for (const name of ['plan_links', 'portal_signins', 'portal_sessions', 'portal_rate_limits']) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${name}`));
  }
  assert.match(schema, /Do not run it against production/);
  assert.equal(find.includes('Rangeway'), false);
  assert.equal(find.includes('\u2014'), false);
});

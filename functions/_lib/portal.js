// Find my plans, and the private /plan/<token> page.
// No accounts and no passwords. Tokens are stored only as SHA-256 hashes.
// The same JSON message is returned whether or not the email has an approved plan.
import { sendMail } from './fastmail.js';
import { verifyTurnstile } from './turnstile.js';
import { newToken, sha256Hex, TOKEN_RE } from './tokens.js';
import { parsePlan, renderPlan, unavailablePlan } from '../../src/lib/render-plan.js';
import { esc, fmtDate } from '../../src/lib/render-guide.js';
import { privateHeaders, privateNotFound, renderPrivatePage } from './private-page.js';

export const SIGNIN_TTL_MS = 15 * 60 * 1000;
export const SESSION_TTL_MS = 15 * 60 * 1000;
export const RATE_WINDOW_MS = 15 * 60 * 1000;
export const EMAIL_LIMIT = 3;
export const IP_LIMIT = 10;
export const NEUTRAL_MESSAGE = 'If this email has an approved plan, we sent a sign-in link. It expires in 15 minutes and works once.';
export const RATE_MESSAGE = 'Too many requests. Wait a few minutes and try again.';
export const CLOSED_MESSAGE = 'Plan lookup is not open yet.';
const FROM = 'admin@evtripreports.com';
const COOKIE = 'etr_portal';
const PLANS_COOKIE = 'etr_plans';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

function validEmail(email) {
  return email.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function clientIp(request) {
  return (request.headers.get('CF-Connecting-IP') || '').trim() || 'unknown';
}

function siteOrigin(request) {
  const url = new URL(request.url);
  if (url.hostname === 'evtripreports.com' || url.hostname === 'www.evtripreports.com') return 'https://evtripreports.com';
  return url.origin;
}

function readCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

function cookiePair(name, value) {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/find-my-plans; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

function prettyDay(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const day = raw.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return fmtDate(day);
  return '';
}

function parseSources(raw) {
  if (Array.isArray(raw)) return raw;
  try {
    const value = JSON.parse(raw || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

async function overLimit(db, scope, keyHash, limit) {
  const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM portal_rate_limits WHERE scope = ? AND key_hash = ? AND created_at > ?`
  ).bind(scope, keyHash, since).first();
  return Number(row?.n || 0) >= limit;
}

async function recordLimit(db, scope, keyHash) {
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
  await db.prepare(`DELETE FROM portal_rate_limits WHERE created_at < ?`).bind(cutoff).run();
  await db.prepare(
    `INSERT INTO portal_rate_limits (scope, key_hash, created_at) VALUES (?, ?, ?)`
  ).bind(scope, keyHash, now).run();
}

async function approvedPlans(db, email) {
  const rows = await db.prepare(
    `SELECT r.id AS request_id, r.tier, r.car, r.start_place, r.end_place, r.depart, r.return_date, d.id AS draft_id
     FROM plan_requests r
     JOIN plan_drafts d ON d.request_id = r.id AND d.access_code IS NOT NULL
     WHERE lower(r.email) = ? AND r.status = 'approved'
     ORDER BY r.id ASC`
  ).bind(email).all();
  const seen = new Set();
  const plans = [];
  for (const row of rows.results || []) {
    if (seen.has(row.request_id)) continue;
    seen.add(row.request_id);
    plans.push(row);
  }
  return plans;
}

async function mintPlanLink(db, plan) {
  const token = newToken();
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO plan_links (request_id, draft_id, token_hash, created_at) VALUES (?, ?, ?, ?)`
  ).bind(plan.request_id, plan.draft_id, await sha256Hex(token), now).run();
  return token;
}

async function tokensMatchPlans(db, email, tokens, plans) {
  const drafts = new Set(plans.map((plan) => plan.draft_id));
  const byDraft = new Map();
  for (const token of tokens) {
    const row = await db.prepare(
      `SELECT l.draft_id
       FROM plan_links l
       JOIN plan_drafts d ON d.id = l.draft_id AND d.access_code IS NOT NULL
       JOIN plan_requests r ON r.id = l.request_id
       WHERE l.token_hash = ? AND lower(r.email) = ? AND r.status = 'approved'`
    ).bind(await sha256Hex(token), email).first();
    if (!row || !drafts.has(row.draft_id) || byDraft.has(row.draft_id)) return null;
    byDraft.set(row.draft_id, token);
  }
  if (byDraft.size !== drafts.size) return null;
  return byDraft;
}

async function linksFor(db, email, existing) {
  const plans = await approvedPlans(db, email);
  const matched = existing.length ? await tokensMatchPlans(db, email, existing, plans) : null;
  if (matched) return { plans: plans.map((plan) => ({ ...plan, token: matched.get(plan.draft_id) })), fresh: false };
  const minted = [];
  for (const plan of plans) minted.push({ ...plan, token: await mintPlanLink(db, plan) });
  return { plans: minted, fresh: minted.length > 0 };
}

const PLAN_BY_LINK = `SELECT d.id, d.body, d.sources, d.format, d.access_code, d.request_id,
  r.status, r.tier, r.car, r.port, r.start_place, r.end_place, r.depart, r.return_date
  FROM plan_links l
  JOIN plan_drafts d ON d.id = l.draft_id
  JOIN plan_requests r ON r.id = l.request_id
  WHERE l.token_hash = ?`;

const PLAN_BY_CODE = `SELECT d.id, d.body, d.sources, d.format, d.access_code, d.request_id,
  r.status, r.tier, r.car, r.port, r.start_place, r.end_place, r.depart, r.return_date
  FROM plan_drafts d
  JOIN plan_requests r ON r.id = d.request_id
  WHERE d.access_code = ?`;

async function findPlan(db, token) {
  const hash = await sha256Hex(token);
  const linked = await db.prepare(PLAN_BY_LINK).bind(hash).first();
  if (linked) return linked;
  return db.prepare(PLAN_BY_CODE).bind(hash).first();
}

function messagePage(title, text) {
  return `<section class="band band--tight"><div class="wrap"><h1 class="h1">${esc(title)}</h1><p class="lede" style="margin-top:18px">${esc(text)}</p><p style="margin-top:28px"><a class="pill" href="/find-my-plans">Find my plans</a></p></div></section>`;
}

function confirmPage() {
  return `<section class="band band--tight"><div class="wrap"><h1 class="h1">Show my plans.</h1><p class="lede" style="margin-top:18px">This link works once and expires 15 minutes after it was sent. Continue to see your approved plans.</p><form method="post" style="margin-top:28px"><button class="pill pill--lg" type="submit">Show my plans</button></form></div></section>`;
}

function planCards(plans) {
  if (!plans.length) {
    return `<section class="band band--tight"><div class="wrap"><h1 class="h1">Your plans.</h1><p class="lede" style="margin-top:18px">No approved plans are on this email yet.</p></div></section>`;
  }
  const cards = plans.map((plan) => {
    const depart = prettyDay(plan.depart);
    const back = prettyDay(plan.return_date);
    const when = depart && back ? `Leaving ${depart}, back ${back}` : depart ? `Leaving ${depart}` : '';
    const detail = [plan.car, when].filter(Boolean).join('. ');
    return `<div class="panel"><span class="guide__hw">${esc(plan.tier || 'Plan')}</span><span class="guide__t">${esc(plan.start_place)} to ${esc(plan.end_place)}</span>${
      detail ? `<span class="small muted">${esc(detail)}</span>` : ''
    }<a class="pill" href="/plan/${esc(plan.token)}">Open plan</a></div>`;
  }).join('');
  return `<section class="band band--tight"><div class="wrap"><h1 class="h1">Your plans.</h1><p class="lede" style="margin-top:18px">Approved plans for this email. Each link is private.</p><div class="stack">${cards}</div></div></section>`;
}

async function sessionEmail(db, request) {
  const token = readCookie(request, COOKIE);
  if (!TOKEN_RE.test(token)) return '';
  const row = await db.prepare(
    `SELECT email, expires_at FROM portal_sessions WHERE token_hash = ?`
  ).bind(await sha256Hex(token)).first();
  if (!row || row.expires_at <= new Date().toISOString()) return '';
  return row.email;
}

function planTokensFromCookie(request) {
  return readCookie(request, PLANS_COOKIE).split('.').filter((token) => TOKEN_RE.test(token));
}

export async function onApi(context) {
  const { request, env, waitUntil } = context;
  if (request.method === 'GET') return json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY || null });
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, POST' } });
  if (!env.DB || !env.FASTMAIL_TOKEN) return json({ error: CLOSED_MESSAGE }, 503);

  let data;
  try { data = await request.json(); } catch { return json({ error: 'The request was not valid JSON.' }, 400); }
  if (data.website) return json({ ok: true, message: NEUTRAL_MESSAGE });
  if (!(await verifyTurnstile(request, env, data['cf-turnstile-response'], 'find_plans'))) {
    return json({ error: 'The security check failed. Refresh the page and try again.' }, 403);
  }
  const email = normalizeEmail(data.email);
  if (!validEmail(email)) return json({ error: 'That email address does not look right.' }, 400);

  try {
    const emailKey = await sha256Hex(`email\n${email}`);
    const ipKey = await sha256Hex(`ip\n${clientIp(request)}`);
    if (await overLimit(env.DB, 'email', emailKey, EMAIL_LIMIT) || await overLimit(env.DB, 'ip', ipKey, IP_LIMIT)) {
      return json({ error: RATE_MESSAGE }, 429);
    }
    await recordLimit(env.DB, 'email', emailKey);
    await recordLimit(env.DB, 'ip', ipKey);

    const plans = await approvedPlans(env.DB, email);
    let delivery = Promise.resolve();
    if (plans.length) {
      const token = newToken();
      const now = new Date();
      const expires = new Date(now.getTime() + SIGNIN_TTL_MS);
      await env.DB.prepare(
        `INSERT INTO portal_signins (email, token_hash, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, NULL)`
      ).bind(email, await sha256Hex(token), now.toISOString(), expires.toISOString()).run();
      const link = `${siteOrigin(request)}/find-my-plans/open/${token}`;
      delivery = sendMail({
        token: env.FASTMAIL_TOKEN,
        from: FROM,
        to: email,
        subject: 'Your EV Trip Reports sign-in link',
        text: [
          'Use this link to see your approved plans. It works once and expires in 15 minutes.',
          '',
          link,
          '',
          'If you did not ask for this, ignore this email.',
        ].join('\n'),
      }).catch((e) => console.error('portal mail failed', e.message));
    }
    if (typeof waitUntil === 'function') waitUntil(delivery);
    else await delivery;
  } catch (e) {
    console.error('portal failed', e.message);
    return json({ error: 'Something went wrong. Try again in a few minutes.' }, 500);
  }
  return json({ ok: true, message: NEUTRAL_MESSAGE });
}

async function signinState(db, token) {
  if (!TOKEN_RE.test(token)) return { kind: 'invalid' };
  const row = await db.prepare(
    `SELECT id, email, expires_at, used_at FROM portal_signins WHERE token_hash = ?`
  ).bind(await sha256Hex(token)).first();
  if (!row) return { kind: 'invalid' };
  if (row.used_at) return { kind: 'used' };
  if (row.expires_at <= new Date().toISOString()) return { kind: 'expired' };
  return { kind: 'ready', row };
}

function statePage(kind) {
  if (kind === 'used') return messagePage('Link already used.', 'This link was already used. Request a new one.');
  if (kind === 'expired') return messagePage('Link expired.', 'This link has expired. Request a new one.');
  return messagePage('Link not valid.', 'This link is not valid. Request a new one.');
}

export async function onOpen(context) {
  const { request, env, params } = context;
  const token = String(params?.token || '');
  if (!env.DB) {
    return renderPrivatePage(env, request, { title: 'Find my plans', description: 'Private plan sign-in.', main: messagePage('Not open yet.', CLOSED_MESSAGE), status: 503 });
  }
  if (request.method === 'GET' || request.method === 'HEAD') {
    let state;
    try { state = await signinState(env.DB, token); } catch (e) {
      console.error('portal open failed', e.message);
      return renderPrivatePage(env, request, { title: 'Find my plans', description: 'Private plan sign-in.', main: messagePage('Not open yet.', CLOSED_MESSAGE), status: 503 });
    }
    const main = state.kind === 'ready' ? confirmPage() : statePage(state.kind);
    const status = state.kind === 'ready' ? 200 : 400;
    return renderPrivatePage(env, request, { title: 'Show my plans', description: 'Private plan sign-in.', main, status });
  }
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: privateHeaders() });

  let state;
  try { state = await signinState(env.DB, token); } catch (e) {
    console.error('portal open failed', e.message);
    return renderPrivatePage(env, request, { title: 'Find my plans', description: 'Private plan sign-in.', main: messagePage('Not open yet.', CLOSED_MESSAGE), status: 503 });
  }
  if (state.kind !== 'ready') {
    return renderPrivatePage(env, request, { title: 'Show my plans', description: 'Private plan sign-in.', main: statePage(state.kind), status: 400 });
  }

  const now = new Date();
  const nowIso = now.toISOString();
  let consumed;
  try {
    consumed = await env.DB.prepare(
      `UPDATE portal_signins SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`
    ).bind(nowIso, await sha256Hex(token), nowIso).run();
  } catch (e) {
    console.error('portal open failed', e.message);
    return renderPrivatePage(env, request, { title: 'Find my plans', description: 'Private plan sign-in.', main: messagePage('Not open yet.', CLOSED_MESSAGE), status: 503 });
  }
  if (!consumed?.meta?.changes) {
    return renderPrivatePage(env, request, { title: 'Show my plans', description: 'Private plan sign-in.', main: statePage('used'), status: 400 });
  }

  const session = newToken();
  const expires = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO portal_sessions (email, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)`
    ).bind(state.row.email, await sha256Hex(session), nowIso, expires).run();
  } catch (e) {
    console.error('portal session failed', e.message);
    return renderPrivatePage(env, request, { title: 'Find my plans', description: 'Private plan sign-in.', main: messagePage('Not open yet.', CLOSED_MESSAGE), status: 503 });
  }

  const headers = privateHeaders();
  headers.set('location', '/find-my-plans/list');
  headers.append('set-cookie', cookiePair(COOKIE, session));
  return new Response(null, { status: 303, headers });
}

export async function onList(context) {
  const { request, env } = context;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: privateHeaders() });
  }
  if (!env.DB) {
    return renderPrivatePage(env, request, { title: 'Your plans', description: 'Your approved plans.', main: messagePage('Not open yet.', CLOSED_MESSAGE), status: 503 });
  }
  let email = '';
  try { email = await sessionEmail(env.DB, request); } catch (e) {
    console.error('portal list failed', e.message);
    return renderPrivatePage(env, request, { title: 'Your plans', description: 'Your approved plans.', main: messagePage('Not open yet.', CLOSED_MESSAGE), status: 503 });
  }
  if (!email) {
    return renderPrivatePage(env, request, {
      title: 'Your plans',
      description: 'Your approved plans.',
      main: messagePage('Sign-in expired.', 'This sign-in has expired. Request a new link.'),
    });
  }

  let linked;
  try {
    linked = await linksFor(env.DB, email, planTokensFromCookie(request));
  } catch (e) {
    console.error('portal list failed', e.message);
    return renderPrivatePage(env, request, { title: 'Your plans', description: 'Your approved plans.', main: messagePage('Not open yet.', CLOSED_MESSAGE), status: 503 });
  }
  const page = await renderPrivatePage(env, request, {
    title: 'Your plans',
    description: 'Your approved plans.',
    main: planCards(linked.plans),
  });
  if (linked.fresh) {
    const headers = new Headers(page.headers);
    headers.append('set-cookie', cookiePair(PLANS_COOKIE, linked.plans.map((plan) => plan.token).join('.')));
    return new Response(page.body, { status: page.status, headers });
  }
  return page;
}

export async function onPlan(context) {
  const { request, env, params } = context;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: privateHeaders() });
  }
  const token = String(params?.token || '');
  if (!TOKEN_RE.test(token)) return privateNotFound(env, request);
  if (!env.DB) return new Response('Plans are not open yet.', { status: 503, headers: privateHeaders() });

  let row;
  try { row = await findPlan(env.DB, token); } catch (e) {
    console.error('plan read failed', e.message);
    return new Response('Plans are not open yet.', { status: 503, headers: privateHeaders() });
  }
  if (!row || row.status !== 'approved' || !row.access_code) return privateNotFound(env, request);

  const plan = parsePlan(row.body);
  const main = plan
    ? renderPlan(plan, {
        tier: row.tier,
        car: row.car,
        port: row.port,
        start: row.start_place,
        end: row.end_place,
        depart: row.depart,
        returnDate: row.return_date,
        draftSources: parseSources(row.sources),
      })
    : unavailablePlan();
  const title = plan?.title || (row.start_place && row.end_place ? `${row.start_place} to ${row.end_place}` : 'Your plan');
  return renderPrivatePage(env, request, { title, description: 'A private trip plan.', main });
}

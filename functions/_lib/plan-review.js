// Admin review of plan requests. Nothing in this file emails a customer.
// ADMIN_TOKEN is a Pages secret. The customer is never a recipient.
// Approval returns a 32-byte access code once. Only its SHA-256 hash is stored.
import { applySecurityHeaders } from '../../src/lib/security-headers.js';
import { newToken, sha256Hex } from './tokens.js';

const QUEUE = new Set(['new', 'review']);
const DECISIONS = new Set(['approved', 'rejected-for-redo']);
const FORMATS = new Set(['markdown', 'html']);
const MAX_BODY = 100000;
const MAX_SOURCES = 40;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: applySecurityHeaders({ 'content-type': 'application/json', 'cache-control': 'no-store' }),
  });

function safeEqual(a, b) {
  const enc = new TextEncoder();
  const aa = enc.encode(String(a));
  const bb = enc.encode(String(b));
  const len = Math.max(aa.length, bb.length);
  let diff = aa.length ^ bb.length;
  for (let i = 0; i < len; i++) diff |= (aa[i] || 0) ^ (bb[i] || 0);
  return diff === 0;
}

export function newAccessCode() {
  return newToken();
}

function tokenFrom(request) {
  const auth = request.headers.get('authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return (request.headers.get('x-admin-token') || '').trim();
}

function authorized(request, env) {
  if (!env.ADMIN_TOKEN) return json({ error: 'Plan review is not open yet.' }, 503);
  const given = tokenFrom(request);
  if (!given || !safeEqual(given, env.ADMIN_TOKEN)) return json({ error: 'Unauthorized.' }, 401);
  if (!env.DB) return json({ error: 'Plan review is not open yet.' }, 503);
  return null;
}

function segments(path) {
  if (path == null || path === '') return [];
  return Array.isArray(path) ? path : String(path).split('/').filter(Boolean);
}

function requestId(seg) {
  if (!/^[1-9]\d*$/.test(seg || '')) return null;
  const id = Number(seg);
  return Number.isSafeInteger(id) ? id : null;
}

const REQUEST_COLS = `id, created_at, name, email, tier, car, port, start_place, end_place, depart, return_date, passengers, memberships, notes, status`;

async function getRequest(db, id) {
  return db.prepare(`SELECT ${REQUEST_COLS} FROM plan_requests WHERE id = ?`).bind(id).first();
}

function parseSources(raw) {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

async function draftsFor(db, id) {
  const rows = await db.prepare(
    `SELECT id, request_id, created_at, updated_at, format, body, sources, access_code
     FROM plan_drafts WHERE request_id = ? ORDER BY id ASC`
  ).bind(id).all();
  return (rows.results || []).map((row) => ({ ...row, sources: parseSources(row.sources) }));
}

function checkSources(sources) {
  if (!Array.isArray(sources)) return 'Sources must be a list.';
  if (sources.length > MAX_SOURCES) return 'Too many sources.';
  for (const source of sources) {
    const label = String(source?.label ?? source?.name ?? '').trim();
    const url = String(source?.url ?? '').trim();
    if (!label || label.length > 200) return 'Each source needs a label.';
    let parsed;
    try { parsed = new URL(url); } catch { return 'Each source needs an http or https URL.'; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'Each source needs an http or https URL.';
  }
  return null;
}

// Payment state comes from stripe_payments (schema-payments.sql), written by the Stripe webhook.
// 'paid', 'refunded', or 'unpaid' when the table exists; null when it does not, so the review API still works without it.
async function paymentsFor(db, ids) {
  const map = new Map();
  if (!ids.length) return map;
  try {
    const rows = await db.prepare(
      `SELECT request_id, amount_total, amount_ok, match_kind, status FROM stripe_payments
       WHERE request_id IN (${ids.map(() => '?').join(',')}) ORDER BY id ASC`
    ).bind(...ids).all();
    for (const id of ids) map.set(id, { state: 'unpaid' });
    for (const row of rows.results || []) {
      map.set(row.request_id, {
        state: row.status,
        amountCents: row.amount_total,
        amountMatchesTier: row.amount_ok == null ? null : row.amount_ok === 1,
        matchedBy: row.match_kind,
      });
    }
  } catch {
    for (const id of ids) map.set(id, null);
  }
  return map;
}

async function listQueue(db) {
  const rows = await db.prepare(
    `SELECT ${REQUEST_COLS} FROM plan_requests WHERE status IN ('new', 'review', 'rejected-for-redo') ORDER BY created_at ASC, id ASC`
  ).all();
  const list = rows.results || [];
  const payments = await paymentsFor(db, list.map((row) => row.id));
  const requests = list.map((row) => {
    const base = { ...row, payment: payments.get(row.id) ?? null };
    return row.status === 'rejected-for-redo' ? { ...base, queueLabel: 'Needs redo' } : base;
  });
  return json({ requests });
}

async function saveDraft(db, id, data) {
  const row = await getRequest(db, id);
  if (!row) return json({ error: 'No plan request with that id.' }, 404);
  if (!QUEUE.has(row.status) && row.status !== 'rejected-for-redo') {
    return json({ error: 'This request is already approved.' }, 409);
  }
  const format = String(data.format ?? '');
  if (!FORMATS.has(format)) return json({ error: 'Format must be markdown or html.' }, 400);
  const body = String(data.body ?? '');
  if (!body.trim()) return json({ error: 'The draft is empty.' }, 400);
  if (body.length > MAX_BODY) return json({ error: 'The draft is too long.' }, 400);
  const sourceError = checkSources(data.sources);
  if (sourceError) return json({ error: sourceError }, 400);
  const sources = data.sources.map((source) => ({
    label: String(source.label ?? source.name).trim(),
    url: String(source.url).trim(),
  }));
  const now = new Date().toISOString();
  const saved = await db.prepare(
    `INSERT INTO plan_drafts (request_id, created_at, updated_at, format, body, sources, access_code)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`
  ).bind(id, now, now, format, body, JSON.stringify(sources)).run();
  await db.prepare(`UPDATE plan_requests SET status = ? WHERE id = ?`).bind('review', id).run();
  return json({ ok: true, draftId: saved.meta?.last_row_id ?? null, status: 'review' });
}

async function decide(db, id, data) {
  const status = String(data.status ?? '');
  if (!DECISIONS.has(status)) return json({ error: 'Status must be approved or rejected-for-redo.' }, 400);
  const row = await getRequest(db, id);
  if (!row) return json({ error: 'No plan request with that id.' }, 404);
  if (!QUEUE.has(row.status)) return json({ error: 'This request is not waiting for review.' }, 409);

  if (status === 'rejected-for-redo') {
    try {
      await db.prepare(`DELETE FROM plan_links WHERE request_id = ?`).bind(id).run();
    } catch (e) {
      console.error('plan_links clear failed', e.message);
      return json({ error: 'Plan links are not set up yet. Apply schema-portal.sql, then try again.' }, 503);
    }
    await db.prepare(`UPDATE plan_drafts SET access_code = NULL WHERE request_id = ?`).bind(id).run();
    await db.prepare(`UPDATE plan_requests SET status = ? WHERE id = ?`).bind('rejected-for-redo', id).run();
    return json({ ok: true, status: 'rejected-for-redo' });
  }

  const latest = await db.prepare(
    `SELECT id FROM plan_drafts WHERE request_id = ? ORDER BY id DESC LIMIT 1`
  ).bind(id).first();
  if (!latest) return json({ error: 'Save a draft before approving.' }, 400);

  const accessCode = newAccessCode();
  const tokenHash = await sha256Hex(accessCode);
  const now = new Date().toISOString();
  try {
    await db.prepare(
      `INSERT INTO plan_links (request_id, draft_id, token_hash, created_at) VALUES (?, ?, ?, ?)`
    ).bind(id, latest.id, tokenHash, now).run();
  } catch (e) {
    console.error('plan_links insert failed', e.message);
    return json({ error: 'Plan links are not set up yet. Apply schema-portal.sql, then approve again.' }, 503);
  }
  await db.prepare(`UPDATE plan_drafts SET access_code = NULL WHERE request_id = ?`).bind(id).run();
  await db.prepare(`UPDATE plan_drafts SET access_code = ?, updated_at = ? WHERE id = ?`).bind(tokenHash, now, latest.id).run();
  await db.prepare(`UPDATE plan_requests SET status = ? WHERE id = ?`).bind('approved', id).run();
  const payment = (await paymentsFor(db, [id])).get(id) ?? null;
  return json({ ok: true, status: 'approved', draftId: latest.id, accessCode, payment });
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const denied = authorized(request, env);
  if (denied) return denied;

  const parts = segments(params?.path);
  const method = request.method;
  let data = {};
  if (method === 'POST') {
    try { data = await request.json(); } catch { return json({ error: 'The request was not valid JSON.' }, 400); }
  }

  if (method === 'GET' && parts.length === 0) return listQueue(env.DB);

  const id = requestId(parts[0]);
  if (!id) return json({ error: 'Not found.' }, 404);

  if (method === 'GET' && parts.length === 1) {
    const row = await getRequest(env.DB, id);
    if (!row) return json({ error: 'No plan request with that id.' }, 404);
    const payment = (await paymentsFor(env.DB, [id])).get(id) ?? null;
    return json({ request: row, payment, drafts: await draftsFor(env.DB, id) });
  }

  if (method === 'POST' && parts.length === 2 && parts[1] === 'draft') return saveDraft(env.DB, id, data);
  if (method === 'POST' && parts.length === 2 && parts[1] === 'decision') return decide(env.DB, id, data);

  return json({ error: 'Not found.' }, 404);
}

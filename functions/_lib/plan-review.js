// Admin review of plan requests. Nothing in this file emails a customer.
// ADMIN_TOKEN is a Pages secret. The customer is never a recipient.
// Approval returns a 32-byte access code once. Only its SHA-256 hash is stored.
import { applySecurityHeaders } from '../../src/lib/security-headers.js';
import { newToken, sha256Hex } from './tokens.js';
import { parseNotes, reviewFlags } from '../../src/lib/order-flags.js';
import { purgePlanData, purgePortal } from './retention.js';

const QUEUE = new Set(['new', 'review']);
const DECISIONS = new Set(['approved', 'rejected-for-redo']);
const FORMATS = new Set(['markdown', 'html']);
const MAX_BODY = 100000;
const MAX_SOURCES = 40;
const PAYMENT_CHUNK = 90;
export const OVERDUE_HOURS = 48;
const HOUR_MS = 60 * 60 * 1000;

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
    // D1 allows 100 bound parameters in one statement, so look payments up in chunks of 90.
    for (let i = 0; i < ids.length; i += PAYMENT_CHUNK) {
      const chunk = ids.slice(i, i + PAYMENT_CHUNK);
      const rows = await db.prepare(
        `SELECT request_id, amount_total, amount_ok, match_kind, status FROM stripe_payments
         WHERE request_id IN (${chunk.map(() => '?').join(',')}) ORDER BY id ASC`
      ).bind(...chunk).all();
      for (const id of chunk) map.set(id, { state: 'unpaid' });
      for (const row of rows.results || []) {
        map.set(row.request_id, {
          state: row.status,
          amountCents: row.amount_total,
          amountMatchesTier: row.amount_ok == null ? null : row.amount_ok === 1,
          matchedBy: row.match_kind,
        });
      }
    }
  } catch {
    for (const id of ids) map.set(id, null);
  }
  return map;
}

// Adds the order checks the queue shows: flags, the matched corridor, and the start battery from the form.
// A blocking flag (port unknown, reverse direction, no matching corridor) means no plan is built until a person sorts it out.
// notes comes back without the start-battery tag the intake form adds.
function withChecks(row) {
  const check = reviewFlags(row);
  const out = { ...row, notes: parseNotes(row.notes).notes, startBattery: check.startBattery, flags: check.flags, corridor: check.corridor };
  if (check.blocked) out.blocked = true;
  return out;
}

// Approved plans and whether they have been sent. Needs plan_delivery (schema-delivery.sql).
// A plan counts as waiting from the moment it was approved. Returns null when the table is missing.
async function approvedPlans(db, { pendingOnly = false, olderThanHours = OVERDUE_HOURS, now = Date.now() } = {}) {
  let rows;
  try {
    rows = (await db.prepare(
      `SELECT r.id, r.created_at, r.name, r.email, r.tier, r.start_place, r.end_place, r.depart,
              (SELECT MAX(l.created_at) FROM plan_links l WHERE l.request_id = r.id) AS approved_at,
              d.delivered_at AS delivered_at, d.note AS delivery_note
       FROM plan_requests r LEFT JOIN plan_delivery d ON d.request_id = r.id
       WHERE r.status = 'approved' ORDER BY approved_at ASC, r.id ASC`
    ).all()).results || [];
  } catch (e) {
    console.error('approved plans lookup failed', e.message);
    return null;
  }
  const items = rows.map((row) => {
    const approvedMs = Date.parse(row.approved_at || '');
    const hours = Number.isFinite(approvedMs) ? Math.floor((now - approvedMs) / HOUR_MS) : null;
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      tier: row.tier,
      start: row.start_place,
      end: row.end_place,
      depart: row.depart,
      approvedAt: row.approved_at || null,
      deliveredAt: row.delivered_at || null,
      deliveryNote: row.delivery_note || null,
      hoursSinceApproval: hours,
      overdue: !row.delivered_at && hours != null && hours >= olderThanHours,
    };
  });
  return pendingOnly ? items.filter((item) => !item.deliveredAt && item.hoursSinceApproval != null && item.hoursSinceApproval >= olderThanHours) : items;
}

async function markDelivered(db, id, data) {
  const row = await getRequest(db, id);
  if (!row) return json({ error: 'No plan request with that id.' }, 404);
  if (row.status !== 'approved') return json({ error: 'Only an approved plan can be marked delivered.' }, 409);
  const note = data.note == null ? null : String(data.note).trim().slice(0, 500) || null;
  const now = new Date().toISOString();
  try {
    const written = await db.prepare(`INSERT OR IGNORE INTO plan_delivery (request_id, delivered_at, note) VALUES (?, ?, ?)`).bind(id, now, note).run();
    const saved = await db.prepare(`SELECT delivered_at, note FROM plan_delivery WHERE request_id = ?`).bind(id).first();
    return json({ ok: true, status: 'approved', deliveredAt: saved?.delivered_at ?? now, note: saved?.note ?? note, alreadyDelivered: written?.meta?.changes === 0 });
  } catch (e) {
    console.error('plan_delivery write failed', e.message);
    return json({ error: 'Delivery tracking is not set up yet. Apply schema-delivery.sql, then try again.' }, 503);
  }
}

async function runPurge(db, data) {
  const dryRun = data.dryRun !== false;
  if (!dryRun && data.confirm !== 'purge') return json({ error: 'A real purge needs {"dryRun": false, "confirm": "purge"}.' }, 400);
  const scope = data.scope == null ? 'all' : String(data.scope);
  if (!['all', 'portal', 'plans'].includes(scope)) return json({ error: 'Scope must be all, portal, or plans.' }, 400);
  const keepIds = Array.isArray(data.keepIds) ? data.keepIds.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0) : [];
  const now = new Date();
  try {
    const out = { ok: true, dryRun };
    if (scope === 'all' || scope === 'portal') out.portal = await purgePortal(db, now, { dryRun });
    if (scope === 'all' || scope === 'plans') out.plans = await purgePlanData(db, now, { dryRun, keepIds });
    return json(out);
  } catch (e) {
    console.error('purge failed', e.message);
    return json({ error: 'The purge failed part way. It is safe to run again.' }, 500);
  }
}

async function listQueue(db) {
  const rows = await db.prepare(
    `SELECT ${REQUEST_COLS} FROM plan_requests WHERE status IN ('new', 'review', 'rejected-for-redo') ORDER BY created_at ASC, id ASC`
  ).all();
  const list = rows.results || [];
  const payments = await paymentsFor(db, list.map((row) => row.id));
  const requests = list.map((row) => {
    const base = { ...withChecks(row), payment: payments.get(row.id) ?? null };
    if (row.status === 'rejected-for-redo') return { ...base, queueLabel: 'Needs redo' };
    const blocking = base.flags.find((flag) => flag.blocking);
    return blocking ? { ...base, queueLabel: blocking.label } : base;
  });
  const waiting = await approvedPlans(db, { pendingOnly: false });
  const pending = waiting ? waiting.filter((item) => !item.deliveredAt) : null;
  const awaitingDelivery = pending
    ? { count: pending.length, overdueCount: pending.filter((item) => item.overdue).length, overdueHours: OVERDUE_HOURS, plans: pending.map(({ id, tier, approvedAt, hoursSinceApproval, overdue }) => ({ id, tier, approvedAt, hoursSinceApproval, overdue })) }
    : null;
  return json({ requests, awaitingDelivery });
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
  if (method === 'GET' && parts.length === 1 && parts[0] === 'approved') {
    const q = new URL(request.url).searchParams;
    const hours = Number(q.get('olderThanHours') ?? OVERDUE_HOURS);
    const list = await approvedPlans(env.DB, {
      pendingOnly: q.get('pending') === '1',
      olderThanHours: Number.isFinite(hours) && hours >= 0 ? hours : OVERDUE_HOURS,
    });
    if (!list) return json({ error: 'Delivery tracking is not set up yet. Apply schema-delivery.sql.' }, 503);
    return json({ approved: list });
  }
  if (method === 'POST' && parts.length === 1 && parts[0] === 'purge') return runPurge(env.DB, data);

  const id = requestId(parts[0]);
  if (!id) return json({ error: 'Not found.' }, 404);

  if (method === 'GET' && parts.length === 1) {
    const row = await getRequest(env.DB, id);
    if (!row) return json({ error: 'No plan request with that id.' }, 404);
    const payment = (await paymentsFor(env.DB, [id])).get(id) ?? null;
    return json({ request: withChecks(row), payment, drafts: await draftsFor(env.DB, id) });
  }

  if (method === 'POST' && parts.length === 2 && parts[1] === 'draft') return saveDraft(env.DB, id, data);
  if (method === 'POST' && parts.length === 2 && parts[1] === 'decision') return decide(env.DB, id, data);
  if (method === 'POST' && parts.length === 2 && parts[1] === 'delivered') return markDelivered(env.DB, id, data);

  return json({ error: 'Not found.' }, 404);
}

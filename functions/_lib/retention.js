// Retention for plan data and expired sign-in rows. Nothing here runs by itself:
// it is called from POST /api/admin/plans/purge, which defaults to a dry run.
//
// The privacy page says plan requests are deleted one year after the trip date unless the customer
// asks us to keep them. The trip date is the later of `depart` and `return_date`.
// Deleting a request also deletes its drafts, its private links, and its payment rows.
// Rows with no readable trip date are never deleted. They are listed so a person can look.

export const RETENTION_DAYS = 365;
export const MAX_REQUESTS_PER_RUN = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

function dayOf(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? '').trim());
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(ms);
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null;
  return ms;
}

// The later of depart and return_date, as ms at UTC midnight, or null when neither reads as a date.
export function tripDateMs(row) {
  const dates = [dayOf(row?.depart), dayOf(row?.return_date)].filter((value) => value != null);
  return dates.length ? Math.max(...dates) : null;
}

const isMissingTable = (e) => /no such table/i.test(String(e?.message || e));

async function count(db, sql, bind) {
  const row = await db.prepare(sql).bind(...bind).first();
  return Number(row?.n ?? 0);
}

// Expired portal_signins and portal_sessions. Neither can be used after expires_at, so nothing a customer
// can still use is touched. Also trims portal_rate_limits past its 15 minute window.
export async function purgePortal(db, now = new Date(), { dryRun = true } = {}) {
  const iso = now.toISOString();
  const rateCutoff = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
  const targets = [
    ['portal_signins', 'expires_at < ?', iso],
    ['portal_sessions', 'expires_at < ?', iso],
    ['portal_rate_limits', 'created_at < ?', rateCutoff],
  ];
  const out = {};
  for (const [table, where, value] of targets) {
    try {
      if (dryRun) out[table] = await count(db, `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, [value]);
      else out[table] = Number((await db.prepare(`DELETE FROM ${table} WHERE ${where}`).bind(value).run())?.meta?.changes ?? 0);
    } catch (e) {
      if (!isMissingTable(e)) throw e;
      out[table] = null;
    }
  }
  return out;
}

// Plan data one year after the trip date. keepIds are requests the customer asked us to keep.
export async function purgePlanData(db, now = new Date(), { dryRun = true, retentionDays = RETENTION_DAYS, keepIds = [], limit = MAX_REQUESTS_PER_RUN } = {}) {
  const cutoffMs = now.getTime() - retentionDays * DAY_MS;
  const keep = new Set(keepIds.map(Number));
  const rows = (await db.prepare(`SELECT id, depart, return_date, status FROM plan_requests ORDER BY id ASC`).all()).results || [];
  const due = [];
  const skipped = [];
  for (const row of rows) {
    const trip = tripDateMs(row);
    if (trip == null) { skipped.push({ id: row.id, reason: 'no readable trip date' }); continue; }
    if (trip > cutoffMs) continue;
    if (keep.has(Number(row.id))) { skipped.push({ id: row.id, reason: 'kept at the customer request' }); continue; }
    due.push({ id: row.id, status: row.status, tripDate: new Date(trip).toISOString().slice(0, 10) });
  }
  const batch = due.slice(0, Math.max(0, limit));
  const result = {
    dryRun,
    cutoff: new Date(cutoffMs).toISOString().slice(0, 10),
    due: due.length,
    thisRun: batch.length,
    candidates: batch,
    skipped,
    deleted: { plan_links: 0, plan_drafts: 0, stripe_payments: 0, plan_requests: 0 },
    unmatchedPaymentsDue: null,
  };
  if (dryRun) {
    try {
      result.unmatchedPaymentsDue = await count(db, `SELECT COUNT(*) AS n FROM stripe_payments WHERE request_id IS NULL AND created_at < ?`, [new Date(cutoffMs).toISOString()]);
    } catch (e) {
      if (!isMissingTable(e)) throw e;
    }
    return result;
  }
  const del = async (table, sql, value, optional = false) => {
    try {
      result.deleted[table] += Number((await db.prepare(sql).bind(value).run())?.meta?.changes ?? 0);
    } catch (e) {
      if (!(optional && isMissingTable(e))) throw e;
    }
  };
  // plan_requests goes last, so a failure part way leaves a request that the next run finishes.
  for (const { id } of batch) {
    await del('plan_links', `DELETE FROM plan_links WHERE request_id = ?`, id, true);
    await del('plan_drafts', `DELETE FROM plan_drafts WHERE request_id = ?`, id);
    await del('stripe_payments', `DELETE FROM stripe_payments WHERE request_id = ?`, id, true);
    try { await db.prepare(`DELETE FROM plan_delivery WHERE request_id = ?`).bind(id).run(); } catch (e) { if (!isMissingTable(e)) throw e; }
    await del('plan_requests', `DELETE FROM plan_requests WHERE id = ?`, id);
  }
  // Payments no request could be matched to age out by their own date.
  await del('stripe_payments', `DELETE FROM stripe_payments WHERE request_id IS NULL AND created_at < ?`, new Date(cutoffMs).toISOString(), true);
  return result;
}

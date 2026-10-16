// /api/admin/plans
// Admin only. Pass ADMIN_TOKEN as Authorization: Bearer, or as the x-admin-token header.
// GET  /api/admin/plans                 queue: new, review, or rejected-for-redo (labeled Needs redo)
// GET  /api/admin/plans/:id             one request and its drafts
// POST /api/admin/plans/:id/draft       save markdown or html plus sources
// POST /api/admin/plans/:id/decision    { "status": "approved" } or { "status": "rejected-for-redo" }
// POST /api/admin/plans/:id/delivered   { "note": "optional" } marks an approved plan as sent (needs schema-delivery.sql)
// GET  /api/admin/plans/approved        approved plans with deliveredAt; ?pending=1&olderThanHours=48 lists the ones not yet delivered
// POST /api/admin/plans/purge           retention. Dry run unless { "dryRun": false, "confirm": "purge" }. Optional scope, keepIds.
// Approved plans return a long random access code once. Only its hash is stored.
// This file does not email anyone. Apply schema-portal.sql before approving.
export { onRequest } from '../../../_lib/plan-review.js';

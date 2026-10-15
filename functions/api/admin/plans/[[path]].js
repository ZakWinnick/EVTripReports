// /api/admin/plans
// Admin only. Pass ADMIN_TOKEN as Authorization: Bearer, or as the x-admin-token header.
// GET  /api/admin/plans                 queue: status new or review
// GET  /api/admin/plans/:id             one request and its drafts
// POST /api/admin/plans/:id/draft       save markdown or html plus sources
// POST /api/admin/plans/:id/decision    { "status": "approved" } or { "status": "rejected-for-redo" }
// Approved plans return a long random access code once. Only its hash is stored.
// This file does not email anyone. Apply schema-portal.sql before approving.
export { onRequest } from '../../../_lib/plan-review.js';

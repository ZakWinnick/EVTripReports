// /api/admin/plans
// Admin only. Pass ADMIN_TOKEN as Authorization: Bearer, or as the x-admin-token header.
// GET  /api/admin/plans                 queue: status new or review
// GET  /api/admin/plans/:id             one request and its drafts
// POST /api/admin/plans/:id/draft       save markdown or html plus sources
// POST /api/admin/plans/:id/decision    { "status": "approved" } or { "status": "rejected-for-redo" }
// Approved plans store a long random access code on the latest draft.
// This file does not email anyone.
export { onRequest } from '../../../_lib/plan-review.js';

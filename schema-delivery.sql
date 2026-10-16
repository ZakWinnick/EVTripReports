-- Delivery record for approved plans, written by POST /api/admin/plans/:id/delivered.
-- Apply this in the D1 console for the database bound to Pages as DB.
-- Do not run it against production from a deploy, a script, or CI.
-- It only creates a new table. plan_requests is not changed, and the request status stays 'approved'.
--
-- delivered_at is when the plan was sent to the customer (ISO 8601). note is free text for the owner.
-- One row per request. A second POST does not overwrite it.

CREATE TABLE IF NOT EXISTS plan_delivery (
  request_id INTEGER PRIMARY KEY,
  delivered_at TEXT NOT NULL,
  note TEXT
);

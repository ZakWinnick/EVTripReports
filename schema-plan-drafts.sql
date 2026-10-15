-- Drafts of custom plans, written by the admin review API.
-- Apply this in the D1 console for the database bound to Pages as DB.
-- Do not run it against production from a deploy, a script, or CI.
-- schema.sql (plan_requests) has to exist first.

CREATE TABLE IF NOT EXISTS plan_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('markdown', 'html')),
  body TEXT NOT NULL,
  sources TEXT NOT NULL,
  access_code TEXT UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_plan_drafts_request ON plan_drafts (request_id);

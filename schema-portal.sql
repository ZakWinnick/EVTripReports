-- Customer plan portal.
-- Apply this in the D1 console for the database bound to Pages as DB.
-- Do not run it against production from a deploy, a script, or CI.
-- schema.sql (plan_requests) and schema-plan-drafts.sql (plan_drafts) have to exist first.
--
-- plan_links stores SHA-256 hex digests of /plan/<token> tokens. The raw token is not stored.
-- portal_signins stores SHA-256 hex digests of one-time Find my plans links (15 minutes).
-- portal_sessions stores SHA-256 hex digests of the short cookie set after that link is used.
-- portal_rate_limits counts Find my plans requests. key_hash is a digest, not the email or IP.

CREATE TABLE IF NOT EXISTS plan_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  draft_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plan_links_request ON plan_links (request_id);
CREATE INDEX IF NOT EXISTS idx_plan_links_draft ON plan_links (draft_id);

CREATE TABLE IF NOT EXISTS portal_signins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_portal_signins_email ON portal_signins (email);

CREATE TABLE IF NOT EXISTS portal_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS portal_rate_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL CHECK (scope IN ('email', 'ip')),
  key_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_portal_rate_limits_lookup ON portal_rate_limits (scope, key_hash, created_at);

CREATE INDEX IF NOT EXISTS idx_plan_requests_email ON plan_requests (email);

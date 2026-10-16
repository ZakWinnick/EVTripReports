-- Stripe payments, written by POST /api/stripe-webhook.
-- Apply this in the D1 console for the database bound to Pages as DB.
-- Do not run it against production from a deploy, a script, or CI.
-- It only creates a new table. plan_requests is not changed.
--
-- request_id is the plan_requests row the payment belongs to, or NULL when no row could be matched.
-- match_kind is 'reference' (Stripe client_reference_id etr-<id>), 'email' (same checkout email, newest unpaid request), or 'none'.
-- amount_ok is 1 when amount_total equals the price of the matched request's tier, 0 when it differs, NULL when unmatched.
-- status is 'paid' or 'refunded'.

CREATE TABLE IF NOT EXISTS stripe_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL UNIQUE,
  payment_intent TEXT,
  created_at TEXT NOT NULL,
  email TEXT,
  amount_total INTEGER,
  currency TEXT,
  payment_link TEXT,
  client_reference_id TEXT,
  request_id INTEGER,
  match_kind TEXT NOT NULL,
  amount_ok INTEGER,
  status TEXT NOT NULL DEFAULT 'paid'
);

CREATE INDEX IF NOT EXISTS idx_stripe_payments_request ON stripe_payments (request_id);
CREATE INDEX IF NOT EXISTS idx_stripe_payments_intent ON stripe_payments (payment_intent);

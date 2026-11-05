-- paynp schema v2, merchant operations (platform/SPEC-v2.md section 2).
-- Additions beyond the spec, all internal:
--   doctor_findings.gateway       '' (never NULL) for project-wide findings, so the primary key upsert matches
--   refund_cases_dup              at most one duplicate case per payment (the ingest insert is INSERT OR IGNORE)
--   payments_fulfilled            partial index for "did this project ever report fulfilment" (paid_not_fulfilled)
--   the *_by_attempt / *_by_project indexes below

ALTER TABLE projects ADD COLUMN salt TEXT;
ALTER TABLE payments ADD COLUMN customer_hash TEXT;
ALTER TABLE payments ADD COLUMN customer_mask TEXT;
ALTER TABLE payments ADD COLUMN customer_name TEXT;
ALTER TABLE payments ADD COLUMN refunded_paisa INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN gw_env TEXT;
ALTER TABLE payments ADD COLUMN fulfilled_at INTEGER;
CREATE INDEX payments_by_customer ON payments (project_id, env, customer_hash, started_at DESC);
CREATE INDEX payments_by_amount ON payments (project_id, env, amount_paisa, started_at DESC);
CREATE INDEX payments_fulfilled ON payments (project_id, env, fulfilled_at) WHERE fulfilled_at IS NOT NULL;

CREATE TABLE payment_refs (project_id TEXT NOT NULL, env TEXT NOT NULL, ref TEXT NOT NULL, attempt_id TEXT NOT NULL,
  kind TEXT NOT NULL, PRIMARY KEY (project_id, env, ref, attempt_id));
CREATE INDEX payment_refs_by_attempt ON payment_refs (project_id, env, attempt_id);

CREATE TABLE refund_cases (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, env TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  related_attempt_id TEXT,
  gateway TEXT NOT NULL, amount_paisa INTEGER NOT NULL,
  reason TEXT, checklist TEXT,
  refund_ref TEXT, action_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, resolved_at INTEGER, resolved_by TEXT, note TEXT
);
CREATE INDEX refund_cases_by_status ON refund_cases (project_id, env, status, created_at DESC);
CREATE INDEX refund_cases_by_attempt ON refund_cases (project_id, env, attempt_id);
CREATE UNIQUE INDEX refund_cases_dup ON refund_cases (project_id, env, attempt_id) WHERE kind = 'duplicate';

CREATE TABLE action_endpoints (project_id TEXT NOT NULL, env TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_ok_at INTEGER, last_error TEXT, PRIMARY KEY (project_id, env));
CREATE TABLE actions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, env TEXT NOT NULL, kind TEXT NOT NULL,
  attempt_id TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
  response TEXT, created_at INTEGER NOT NULL, finished_at INTEGER, requested_by TEXT);
CREATE INDEX actions_by_project ON actions (project_id, env, created_at DESC);

CREATE TABLE status_links (token_hash TEXT PRIMARY KEY, project_id TEXT NOT NULL, env TEXT NOT NULL,
  attempt_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, created_by TEXT);
CREATE INDEX status_links_by_expiry ON status_links (expires_at);

CREATE TABLE doctor_findings (project_id TEXT NOT NULL, env TEXT NOT NULL, code TEXT NOT NULL, severity TEXT NOT NULL,
  gateway TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, count INTEGER NOT NULL, example_attempt TEXT,
  resolved_at INTEGER, PRIMARY KEY (project_id, env, code, gateway));

-- paynp schema v1 (platform/SPEC.md section 4).
-- Additions beyond the spec, all internal:
--   users.digest_opt_out        per-user opt-out for the daily digest
--   payments.status_at          ts of the event that set the current status (makes the rollup order independent)
--   payments.reason_at          ts of the event that set last_reason / last_message
--   events.order_id, events.amount_paisa, events.sdk  so the raw event JSON in the timeline is complete
--   alert_incidents.clear_evals consecutive clear cron evaluations (resolve at 2)
--   alert_incidents.attempt_id  the payment of a per-payment incident
--   alert_incidents.env         env of the rule when the incident opened
--   alert_incidents.pending     1 while a per-payment incident waits for its batched notification
--   notify_slots                table, see below

CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, created_at INTEGER NOT NULL, digest_opt_out INTEGER NOT NULL DEFAULT 0);
CREATE TABLE orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE members (org_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (org_id, user_id));
CREATE INDEX members_by_user ON members (user_id);
CREATE TABLE invites (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL, token_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX invites_by_org ON invites (org_id);
CREATE UNIQUE INDEX invites_by_token ON invites (token_hash);
CREATE TABLE projects (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (org_id, slug));
CREATE TABLE api_keys (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, env TEXT NOT NULL, prefix TEXT NOT NULL, key_hash TEXT UNIQUE NOT NULL, name TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER);
CREATE INDEX api_keys_by_project ON api_keys (project_id, created_at DESC);
CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, user_agent TEXT, ip TEXT, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE INDEX sessions_by_user ON sessions (user_id, last_seen_at DESC);
CREATE TABLE login_tokens (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE TABLE device_codes (device_code_hash TEXT PRIMARY KEY, user_code TEXT UNIQUE NOT NULL, user_id TEXT, expires_at INTEGER NOT NULL, approved_at INTEGER);
CREATE TABLE pats (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, name TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER);
CREATE INDEX pats_by_user ON pats (user_id, created_at DESC);

CREATE TABLE payments (
  project_id TEXT NOT NULL, env TEXT NOT NULL, attempt_id TEXT NOT NULL,
  order_id TEXT, gateway TEXT NOT NULL, amount_paisa INTEGER, status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  provider_ref TEXT, last_reason TEXT, last_message TEXT,
  event_count INTEGER NOT NULL, error_count INTEGER NOT NULL DEFAULT 0, fulfil_count INTEGER NOT NULL DEFAULT 0,
  status_at INTEGER NOT NULL DEFAULT 0, reason_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, env, attempt_id)
);
CREATE INDEX payments_by_time ON payments (project_id, env, started_at DESC);
CREATE INDEX payments_by_status ON payments (project_id, env, status, started_at DESC);
CREATE INDEX payments_by_order ON payments (project_id, env, order_id);
CREATE INDEX payments_by_ref ON payments (project_id, env, provider_ref);

CREATE TABLE events (
  project_id TEXT NOT NULL, env TEXT NOT NULL, id TEXT NOT NULL, attempt_id TEXT NOT NULL,
  type TEXT NOT NULL, ts INTEGER NOT NULL, received_at INTEGER NOT NULL, gateway TEXT NOT NULL,
  status TEXT, duration_ms INTEGER, data TEXT,
  order_id TEXT, amount_paisa INTEGER, sdk TEXT,
  PRIMARY KEY (project_id, env, id)
);
CREATE INDEX events_by_attempt ON events (project_id, env, attempt_id, ts);
CREATE INDEX events_by_time ON events (project_id, env, ts DESC);
CREATE INDEX events_by_received ON events (received_at);

CREATE TABLE minute_stats (
  project_id TEXT NOT NULL, env TEXT NOT NULL, gateway TEXT NOT NULL, minute INTEGER NOT NULL,
  started INTEGER NOT NULL DEFAULT 0, paid INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
  paid_amount_paisa INTEGER NOT NULL DEFAULT 0, gw_requests INTEGER NOT NULL DEFAULT 0, gw_errors INTEGER NOT NULL DEFAULT 0,
  gw_ms_total INTEGER NOT NULL DEFAULT 0, gw_ms_max INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, env, gateway, minute)
);
CREATE INDEX minute_stats_by_minute ON minute_stats (minute);

CREATE TABLE alert_channels (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL, config TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX alert_channels_by_project ON alert_channels (project_id);
CREATE TABLE alert_rules (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, env TEXT NOT NULL, type TEXT NOT NULL, params TEXT NOT NULL,
  channel_ids TEXT NOT NULL, cooldown_min INTEGER NOT NULL DEFAULT 30, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE INDEX alert_rules_by_project ON alert_rules (project_id, env);
CREATE TABLE alert_incidents (id TEXT PRIMARY KEY, rule_id TEXT NOT NULL, project_id TEXT NOT NULL, state TEXT NOT NULL,
  opened_at INTEGER NOT NULL, resolved_at INTEGER, last_notified_at INTEGER NOT NULL, summary TEXT NOT NULL, context TEXT,
  clear_evals INTEGER NOT NULL DEFAULT 0, attempt_id TEXT, env TEXT, pending INTEGER NOT NULL DEFAULT 0);
CREATE INDEX alert_incidents_by_project ON alert_incidents (project_id, opened_at DESC);
CREATE INDEX alert_incidents_by_rule ON alert_incidents (rule_id, state);
CREATE INDEX alert_incidents_pending ON alert_incidents (pending) WHERE pending = 1;
CREATE TABLE notifications (id TEXT PRIMARY KEY, incident_id TEXT, channel_id TEXT NOT NULL, sent_at INTEGER NOT NULL, ok INTEGER NOT NULL, error TEXT);
CREATE INDEX notifications_by_channel ON notifications (channel_id, sent_at DESC);
-- Internal: one batched per-payment message per channel per minute (the insert is the atomic throttle).
CREATE TABLE notify_slots (channel_id TEXT NOT NULL, minute INTEGER NOT NULL, PRIMARY KEY (channel_id, minute));
CREATE TABLE audit_log (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT, action TEXT NOT NULL, target TEXT, at INTEGER NOT NULL, meta TEXT);
CREATE INDEX audit_log_by_org ON audit_log (org_id, at DESC);

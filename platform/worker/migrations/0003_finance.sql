-- paynp schema v2, finance (platform/SPEC-v2.md sections 2, 4.5, 4.6 and 4.7).
-- Additions beyond the spec, all internal:
--   statements.mapping_source, statements.unverified    how the column mapping was chosen
--   statement_rows.kind, paynp_amount_paisa, mismatch, error   row type, the paynp amount it was compared with
--   status_minutes.samples, ms_max, h0 to h8            latency histogram (bounds in status/buckets.ts), so p95
--                                                       merges across projects and batches
--   status_days                                         daily rollup for the 90-day bars and peak hours (daily cron)
--   status_incidents                                    incidents found by the daily cron
--   credit_notes                                        refunds numbered CN-YYYYMM-#### once, so exports stay stable

CREATE TABLE statements (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, env TEXT NOT NULL, gateway TEXT NOT NULL,
  filename TEXT NOT NULL, period_from INTEGER, period_to INTEGER, row_count INTEGER NOT NULL, mapping TEXT NOT NULL,
  uploaded_at INTEGER NOT NULL, uploaded_by TEXT,
  mapping_source TEXT NOT NULL DEFAULT 'request', unverified INTEGER NOT NULL DEFAULT 0);
CREATE INDEX statements_by_project ON statements (project_id, env, uploaded_at DESC);

CREATE TABLE statement_rows (statement_id TEXT NOT NULL, row INTEGER NOT NULL, txn_at INTEGER, ref TEXT, amount_paisa INTEGER,
  fee_paisa INTEGER, net_paisa INTEGER, status TEXT, settled_at INTEGER, raw TEXT NOT NULL,
  match_attempt_id TEXT, match_kind TEXT,
  kind TEXT NOT NULL DEFAULT 'payment', paynp_amount_paisa INTEGER, mismatch INTEGER NOT NULL DEFAULT 0, error TEXT,
  PRIMARY KEY (statement_id, row));
CREATE INDEX statement_rows_by_match ON statement_rows (match_attempt_id) WHERE match_attempt_id IS NOT NULL;

CREATE TABLE statement_mappings (project_id TEXT NOT NULL, gateway TEXT NOT NULL, mapping TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, gateway));

CREATE TABLE gateway_fees (project_id TEXT NOT NULL, gateway TEXT NOT NULL, pct_bp INTEGER NOT NULL, fixed_paisa INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, gateway));

CREATE TABLE status_minutes (gateway TEXT NOT NULL, minute INTEGER NOT NULL, projects INTEGER NOT NULL, requests INTEGER NOT NULL,
  errors INTEGER NOT NULL, ms_total INTEGER NOT NULL, ms_p95 INTEGER,
  samples INTEGER NOT NULL DEFAULT 0, ms_max INTEGER NOT NULL DEFAULT 0,
  h0 INTEGER NOT NULL DEFAULT 0, h1 INTEGER NOT NULL DEFAULT 0, h2 INTEGER NOT NULL DEFAULT 0, h3 INTEGER NOT NULL DEFAULT 0,
  h4 INTEGER NOT NULL DEFAULT 0, h5 INTEGER NOT NULL DEFAULT 0, h6 INTEGER NOT NULL DEFAULT 0, h7 INTEGER NOT NULL DEFAULT 0,
  h8 INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (gateway, minute));
CREATE INDEX status_minutes_by_minute ON status_minutes (minute);

-- One row per gateway and Nepal day (day = floor((ms + 5:45) / 1 day)), only from minutes with >= 3 projects.
-- hours: JSON [[samples, ms_total, h0..h8], ...] for the 24 Nepal hours.
CREATE TABLE status_days (gateway TEXT NOT NULL, day INTEGER NOT NULL, shown_minutes INTEGER NOT NULL, ok_minutes INTEGER NOT NULL,
  hours TEXT NOT NULL, computed_at INTEGER NOT NULL, PRIMARY KEY (gateway, day));

CREATE TABLE status_incidents (gateway TEXT NOT NULL, started_minute INTEGER NOT NULL, ended_minute INTEGER NOT NULL, kind TEXT NOT NULL,
  peak_error_rate REAL NOT NULL, peak_p95_ms INTEGER, PRIMARY KEY (gateway, started_minute));
CREATE INDEX status_incidents_by_end ON status_incidents (ended_minute);

-- month = "YYYYMM" of the refund in Nepal time; refund_key = the payment.refunded event id, or "case:<refund_cases.id>".
CREATE TABLE credit_notes (project_id TEXT NOT NULL, env TEXT NOT NULL, refund_key TEXT NOT NULL, attempt_id TEXT NOT NULL,
  gateway TEXT NOT NULL, month TEXT NOT NULL, seq INTEGER NOT NULL, refunded_at INTEGER NOT NULL, amount_paisa INTEGER NOT NULL,
  reason TEXT, refund_ref TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, env, refund_key), UNIQUE (project_id, env, month, seq));
CREATE INDEX credit_notes_by_time ON credit_notes (project_id, env, refunded_at);
CREATE INDEX credit_notes_by_attempt ON credit_notes (project_id, env, attempt_id);

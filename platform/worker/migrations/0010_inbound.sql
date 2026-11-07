-- Multi-currency and inbound provider webhooks (Stripe, Dodo Payments).
--   events.currency, payments.currency   ISO 4217; amounts are minor units of it. Existing rows are NPR.
--   minute_stats                         rebuilt with currency in the key so paid amounts never mix currencies.
--   inbound_sources                      one provider webhook per project environment; secrets AES-GCM encrypted.
ALTER TABLE events ADD COLUMN currency TEXT NOT NULL DEFAULT 'NPR';
ALTER TABLE payments ADD COLUMN currency TEXT NOT NULL DEFAULT 'NPR';

CREATE TABLE minute_stats_new (
  project_id TEXT NOT NULL, env TEXT NOT NULL, gateway TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'NPR', minute INTEGER NOT NULL,
  started INTEGER NOT NULL DEFAULT 0, paid INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
  paid_amount_paisa INTEGER NOT NULL DEFAULT 0, gw_requests INTEGER NOT NULL DEFAULT 0, gw_errors INTEGER NOT NULL DEFAULT 0,
  gw_ms_total INTEGER NOT NULL DEFAULT 0, gw_ms_max INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, env, gateway, minute, currency)
);
INSERT INTO minute_stats_new (project_id, env, gateway, currency, minute, started, paid, failed, paid_amount_paisa, gw_requests, gw_errors, gw_ms_total, gw_ms_max)
  SELECT project_id, env, gateway, 'NPR', minute, started, paid, failed, paid_amount_paisa, gw_requests, gw_errors, gw_ms_total, gw_ms_max FROM minute_stats;
DROP TABLE minute_stats;
ALTER TABLE minute_stats_new RENAME TO minute_stats;
CREATE INDEX minute_stats_by_minute ON minute_stats (minute);

CREATE TABLE inbound_sources (
  id TEXT PRIMARY KEY,                -- ibs_<ulid>; the last path segment of the webhook URL
  project_id TEXT NOT NULL,
  env TEXT NOT NULL,
  provider TEXT NOT NULL,             -- stripe, dodo
  provider_webhook_id TEXT NOT NULL,
  secret_enc TEXT NOT NULL,           -- provider signing secret, AES-GCM (lib/crypto.ts)
  api_key_enc TEXT NOT NULL,          -- merchant API key, kept to delete the webhook on disconnect
  api_key_hint TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_event_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (project_id, env, provider)
);

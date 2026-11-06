-- Outbound webhooks: endpoints per project environment, and one delivery row per endpoint and event.
CREATE TABLE webhook_endpoints (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  env TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT,
  events TEXT NOT NULL,              -- '*' or a JSON array of event types
  secret TEXT NOT NULL,              -- whsec_<base64>
  prev_secret TEXT,                  -- still signed with after a rotation, until prev_secret_until
  prev_secret_until INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  disabled_reason TEXT,
  failing_since INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX webhook_endpoints_project ON webhook_endpoints (project_id, env);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL,
  event_id TEXT NOT NULL,            -- webhook-id header, shared by every endpoint and retry
  project_id TEXT NOT NULL,
  env TEXT NOT NULL,
  type TEXT NOT NULL,
  attempt_id TEXT,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL,              -- pending, delivered, failed
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER,
  last_at INTEGER,
  last_status INTEGER,
  last_error TEXT,
  last_ms INTEGER,
  last_response TEXT,
  UNIQUE (endpoint_id, event_id)
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (project_id, env, status, next_at);
CREATE INDEX webhook_deliveries_overdue ON webhook_deliveries (status, next_at);
CREATE INDEX webhook_deliveries_endpoint ON webhook_deliveries (endpoint_id, created_at);

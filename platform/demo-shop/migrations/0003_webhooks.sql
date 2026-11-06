-- Webhooks received from paynp, one row per event id, counting redeliveries.
CREATE TABLE shop_webhooks (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  attempt_id TEXT,
  status TEXT,
  received_at INTEGER NOT NULL,
  deliveries INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX shop_webhooks_attempt ON shop_webhooks (attempt_id, received_at);

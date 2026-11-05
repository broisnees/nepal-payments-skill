CREATE TABLE shop_orders (id TEXT PRIMARY KEY, sku TEXT NOT NULL, name TEXT NOT NULL, amount_paisa INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE shop_attempts (
  id TEXT PRIMARY KEY,            -- sent to eSewa as transaction_uuid
  order_id TEXT NOT NULL,
  amount_paisa INTEGER NOT NULL,
  status TEXT NOT NULL,           -- initiated, pending, paid, failed, canceled, expired
  provider_ref TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX shop_attempts_open ON shop_attempts (status, created_at);

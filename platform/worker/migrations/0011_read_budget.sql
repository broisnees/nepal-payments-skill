-- D1 rows read (the free plan allows 5M per day for the whole account). See test/read-budget.test.ts.
--
-- Hour summaries for the status report (status/aggregate.ts rollupRecentHours): a report read 48 h of minute rows
-- (28,800 for the probes) per build; it now reads about 49 hour rows per gateway plus the open hour's minutes.
-- hour is a Nepal-aligned hour index, floor((minute * 60000 + 20700000) / 3600000). gateway '*' marks a rolled hour.
CREATE TABLE probe_hours (gateway TEXT NOT NULL, hour INTEGER NOT NULL, requests INTEGER NOT NULL, errors INTEGER NOT NULL,
  samples INTEGER NOT NULL, ms_total INTEGER NOT NULL, ms_max INTEGER NOT NULL,
  h0 INTEGER NOT NULL DEFAULT 0, h1 INTEGER NOT NULL DEFAULT 0, h2 INTEGER NOT NULL DEFAULT 0, h3 INTEGER NOT NULL DEFAULT 0,
  h4 INTEGER NOT NULL DEFAULT 0, h5 INTEGER NOT NULL DEFAULT 0, h6 INTEGER NOT NULL DEFAULT 0, h7 INTEGER NOT NULL DEFAULT 0,
  h8 INTEGER NOT NULL DEFAULT 0, shown_minutes INTEGER NOT NULL, ok_minutes INTEGER NOT NULL, marks TEXT NOT NULL,
  PRIMARY KEY (gateway, hour));
CREATE INDEX probe_hours_by_hour ON probe_hours (hour);

CREATE TABLE status_hours (gateway TEXT NOT NULL, hour INTEGER NOT NULL, requests INTEGER NOT NULL, errors INTEGER NOT NULL,
  samples INTEGER NOT NULL, ms_total INTEGER NOT NULL, ms_max INTEGER NOT NULL,
  h0 INTEGER NOT NULL DEFAULT 0, h1 INTEGER NOT NULL DEFAULT 0, h2 INTEGER NOT NULL DEFAULT 0, h3 INTEGER NOT NULL DEFAULT 0,
  h4 INTEGER NOT NULL DEFAULT 0, h5 INTEGER NOT NULL DEFAULT 0, h6 INTEGER NOT NULL DEFAULT 0, h7 INTEGER NOT NULL DEFAULT 0,
  h8 INTEGER NOT NULL DEFAULT 0, shown_minutes INTEGER NOT NULL, ok_minutes INTEGER NOT NULL, marks TEXT NOT NULL,
  PRIMARY KEY (gateway, hour));
CREATE INDEX status_hours_by_hour ON status_hours (hour);

-- The minute doctor cron (ops/cron-ops.ts) looks for callbacks in one minute. Through events_by_received it read every
-- event of the last 32 minutes; this partial index holds only callbacks, so it is written once per callback event.
CREATE INDEX events_callbacks_by_ts ON events (ts) WHERE type = 'callback.received';

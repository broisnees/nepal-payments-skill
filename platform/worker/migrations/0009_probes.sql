-- Gateway status from the status site's own probes (platform/status): one call per gateway per minute to its
-- production API. Same shape as the status_* tables so the same aggregation reads both; projects is always 1.
CREATE TABLE probe_minutes (gateway TEXT NOT NULL, minute INTEGER NOT NULL, projects INTEGER NOT NULL, requests INTEGER NOT NULL,
  errors INTEGER NOT NULL, ms_total INTEGER NOT NULL, ms_p95 INTEGER,
  samples INTEGER NOT NULL DEFAULT 0, ms_max INTEGER NOT NULL DEFAULT 0,
  h0 INTEGER NOT NULL DEFAULT 0, h1 INTEGER NOT NULL DEFAULT 0, h2 INTEGER NOT NULL DEFAULT 0, h3 INTEGER NOT NULL DEFAULT 0,
  h4 INTEGER NOT NULL DEFAULT 0, h5 INTEGER NOT NULL DEFAULT 0, h6 INTEGER NOT NULL DEFAULT 0, h7 INTEGER NOT NULL DEFAULT 0,
  h8 INTEGER NOT NULL DEFAULT 0,
  -- What the last probe of the minute saw, for the gateway page and the API.
  http_status INTEGER, error TEXT,
  PRIMARY KEY (gateway, minute));
CREATE INDEX probe_minutes_by_minute ON probe_minutes (minute);

CREATE TABLE probe_days (gateway TEXT NOT NULL, day INTEGER NOT NULL, shown_minutes INTEGER NOT NULL, ok_minutes INTEGER NOT NULL,
  hours TEXT NOT NULL, computed_at INTEGER NOT NULL, PRIMARY KEY (gateway, day));

CREATE TABLE probe_incidents (gateway TEXT NOT NULL, started_minute INTEGER NOT NULL, ended_minute INTEGER NOT NULL, kind TEXT NOT NULL,
  peak_error_rate REAL NOT NULL, peak_p95_ms INTEGER, PRIMARY KEY (gateway, started_minute));
CREATE INDEX probe_incidents_by_end ON probe_incidents (ended_minute);

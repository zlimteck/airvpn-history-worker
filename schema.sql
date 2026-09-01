-- Raw snapshots, one row per server per collection cycle (every 15 min).
-- Kept for 7 days, then aggregated into server_snapshots_hourly and purged.
CREATE TABLE IF NOT EXISTS server_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_name TEXT NOT NULL,
  country_name TEXT,
  country_code TEXT,
  location TEXT,
  load_percent INTEGER NOT NULL,
  bw_current INTEGER,
  bw_max INTEGER,
  users_count INTEGER,
  health TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_server_snapshots_name_time
  ON server_snapshots (server_name, recorded_at);

-- Covers queries that filter by recorded_at only (ranking, reliability),
-- which can't use the (server_name, recorded_at) index above since they
-- don't filter on server_name.
CREATE INDEX IF NOT EXISTS idx_server_snapshots_time
  ON server_snapshots (recorded_at);

-- Hourly aggregates, one row per server per hour bucket.
-- Kept for 30 days, then purged.
CREATE TABLE IF NOT EXISTS server_snapshots_hourly (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_name TEXT NOT NULL,
  country_name TEXT,
  country_code TEXT,
  location TEXT,
  load_percent INTEGER NOT NULL,
  bw_current INTEGER,
  bw_max INTEGER,
  users_count INTEGER,
  health TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_server_snapshots_hourly_name_time
  ON server_snapshots_hourly (server_name, recorded_at);

CREATE INDEX IF NOT EXISTS idx_server_snapshots_hourly_time
  ON server_snapshots_hourly (recorded_at);

-- One row per server, upserted every collection cycle. Lets /servers/latest
-- read a constant ~server-count rows instead of scanning all of
-- server_snapshots to find each server's most recent row (that scan cost
-- grows with total history size, not with server count).
CREATE TABLE IF NOT EXISTS server_latest (
  server_name TEXT PRIMARY KEY,
  country_name TEXT,
  country_code TEXT,
  location TEXT,
  load_percent INTEGER NOT NULL,
  bw_current INTEGER,
  bw_max INTEGER,
  users_count INTEGER,
  health TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);

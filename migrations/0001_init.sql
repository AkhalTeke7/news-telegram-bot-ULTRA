-- Phase 1: source channel registry.
CREATE TABLE IF NOT EXISTS channels (
  id                         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_username           TEXT    NOT NULL UNIQUE,
  channel_title              TEXT,
  enabled                    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_checked_at            TEXT,
  last_processed_message_id  INTEGER,
  created_at                 TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at                 TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_channels_enabled ON channels (enabled, channel_username);

-- Phase 1: hourly Cron execution log. Phase 2+ will extend this with run results.
CREATE TABLE IF NOT EXISTS cron_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_name TEXT NOT NULL,
  ran_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

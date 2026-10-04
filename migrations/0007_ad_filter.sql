-- Phase 7: deterministic local advertisement filtering (no AI, no network).
-- Existing rows become 'pending' so they are evaluated once on the next run;
-- the CHECK constraint keeps the status set closed.
ALTER TABLE messages ADD COLUMN filter_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (filter_status IN ('pending', 'filtered', 'passed'));
ALTER TABLE messages ADD COLUMN filter_reason TEXT;
ALTER TABLE messages ADD COLUMN filtered_at TEXT;

-- Serves "evaluate only what is still pending" without scanning the whole table.
CREATE INDEX IF NOT EXISTS idx_messages_filter_pending ON messages (filter_status, message_date ASC);

-- Keeps the hourly bookkeeping (and the admin report) complete.
ALTER TABLE cron_runs ADD COLUMN messages_filtered INTEGER NOT NULL DEFAULT 0;

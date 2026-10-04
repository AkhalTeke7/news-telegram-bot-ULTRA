-- Phase 5: execution detail for the hourly job, so the admin view can report
-- real outcomes instead of guessing from logs.
ALTER TABLE cron_runs ADD COLUMN status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE cron_runs ADD COLUMN finished_at TEXT;
ALTER TABLE cron_runs ADD COLUMN duration_ms INTEGER;
ALTER TABLE cron_runs ADD COLUMN channels_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cron_runs ADD COLUMN messages_inserted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cron_runs ADD COLUMN messages_summarized INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cron_runs ADD COLUMN messages_published INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cron_runs ADD COLUMN failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cron_runs ADD COLUMN error_summary TEXT;

CREATE INDEX IF NOT EXISTS idx_cron_runs_ran_at ON cron_runs (ran_at DESC);

-- Accurate "when did this last fail" signal for the diagnostics panel.
ALTER TABLE messages ADD COLUMN last_publish_error_at TEXT;

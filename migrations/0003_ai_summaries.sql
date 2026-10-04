-- Phase 3: AI summarization state + model bookkeeping.
-- Raw post text stays untouched; the summary is added alongside it so the
-- original source info (channel, telegram_message_id, source_url, message_date)
-- is never lost.
ALTER TABLE messages ADD COLUMN summary_text TEXT;
ALTER TABLE messages ADD COLUMN summary_model TEXT;
ALTER TABLE messages ADD COLUMN summarized_at TEXT;

-- Speeds up "not summarized yet" scans without reading the whole table.
CREATE INDEX IF NOT EXISTS idx_messages_pending ON messages (summarized_at, message_date DESC);

-- Model state only. The OpenCode API key is a Wrangler secret and is NEVER
-- stored here or anywhere else.
CREATE TABLE IF NOT EXISTS ai_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

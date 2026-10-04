-- Phase 4: Telegram destination publishing state.
-- Additive only: no existing column or row is modified or dropped.
ALTER TABLE messages ADD COLUMN published_at TEXT;
ALTER TABLE messages ADD COLUMN telegram_destination_message_id INTEGER;
ALTER TABLE messages ADD COLUMN publish_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN last_publish_error TEXT;

-- Drives "oldest unsummarized-but-unpublished first" reads.
CREATE INDEX IF NOT EXISTS idx_messages_pending_publish
  ON messages (published_at, message_date ASC);

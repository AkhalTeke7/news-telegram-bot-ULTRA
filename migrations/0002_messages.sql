-- Phase 2: raw Telegram posts collected from public channel previews.
-- UNIQUE (source_channel_id, telegram_message_id) is the duplicate-processing
-- guard: the collector inserts with ON CONFLICT DO NOTHING.
CREATE TABLE IF NOT EXISTS messages (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  source_channel_id    INTEGER NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  telegram_message_id  INTEGER NOT NULL,
  message_date         TEXT    NOT NULL,
  message_text         TEXT    NOT NULL DEFAULT '',
  source_url           TEXT    NOT NULL,
  created_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  UNIQUE (source_channel_id, telegram_message_id)
);

-- Supports "newest messages for one channel" reads for later summarization.
CREATE INDEX IF NOT EXISTS idx_messages_channel_date
  ON messages (source_channel_id, message_date DESC);

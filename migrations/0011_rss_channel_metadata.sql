ALTER TABLE channels ADD COLUMN source_type TEXT NOT NULL DEFAULT 'telegram' CHECK (source_type IN ('telegram', 'rss'));
ALTER TABLE channels ADD COLUMN feed_url TEXT;
CREATE INDEX IF NOT EXISTS idx_channels_source_type ON channels (source_type, enabled);

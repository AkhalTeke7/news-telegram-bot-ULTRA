-- RSS sources are separate from Telegram channels so both collectors can coexist.
CREATE TABLE IF NOT EXISTS rss_sources (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  feed_url        TEXT NOT NULL UNIQUE,
  category        TEXT NOT NULL DEFAULT 'general',
  enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_fetched_at TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT OR IGNORE INTO rss_sources (name, feed_url, category) VALUES
  ('BBC Persian', 'https://feeds.bbci.co.uk/persian/rss.xml', 'world'),
  ('Zoomit', 'https://zoomit.ir/feed', 'technology'),
  ('Mobile.ir', 'https://mobile.ir/news/rss.aspx', 'technology'),
  ('IRIB News', 'https://www.iribnews.ir/fa/rss/allnews', 'iran');

CREATE INDEX IF NOT EXISTS idx_rss_sources_enabled ON rss_sources (enabled, id);

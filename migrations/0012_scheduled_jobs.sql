-- Scheduled-job infrastructure for the slideshow / calendar / breaking-news jobs.
--
-- Additive only: no existing table or column is modified or dropped, so the
-- current pipeline keeps running exactly as before.

-- ---------------------------------------------------------------- claims ---
-- The once-per-day guarantee for the Forex Factory calendar (and any future
-- daily job). The PRIMARY KEY (job, claim_date) plus INSERT OR IGNORE is the
-- atomic claim: concurrent or retried invocations race on the same row and
-- exactly one of them observes changes = 1.
--
-- claim_date is the LOCAL civil date in TIMEZONE, not UTC, so "once per day"
-- means once per day as the reader experiences it.
CREATE TABLE IF NOT EXISTS job_claims (
  job        TEXT NOT NULL,
  claim_date TEXT NOT NULL,
  claimed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  status     TEXT NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'sent', 'skipped')),
  detail     TEXT,
  PRIMARY KEY (job, claim_date)
);

-- ------------------------------------------------------------- run log -----
-- One row per job execution, so the admin /status command can report the last
-- run and status of EACH job independently instead of one global cron row.
CREATE TABLE IF NOT EXISTS job_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job         TEXT NOT NULL,
  trigger     TEXT NOT NULL DEFAULT '',
  started_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT,
  duration_ms INTEGER,
  status      TEXT NOT NULL DEFAULT 'running'
                CHECK (status IN ('running', 'success', 'skipped', 'partial', 'failed')),
  detail      TEXT
);

CREATE INDEX IF NOT EXISTS idx_job_runs_job ON job_runs (job, id DESC);
CREATE INDEX IF NOT EXISTS idx_job_runs_started ON job_runs (started_at DESC);

-- ---------------------------------------------------------- slideshow ------
-- Items already delivered as a slide. A row is written ONLY after Telegram
-- confirms the album, so a failed send leaves the item eligible for the next
-- run instead of silently dropping it.
CREATE TABLE IF NOT EXISTS slideshow_sent (
  item_key   TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT '',
  link       TEXT NOT NULL DEFAULT '',
  sent_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  message_id INTEGER,
  -- Telegram file_id of the delivered slide. Re-sending a file_id is free and
  -- instant, so the private-chat /slideshow browser pages through an album
  -- without re-rendering a single PNG.
  file_id    TEXT
);

CREATE INDEX IF NOT EXISTS idx_slideshow_sent_at ON slideshow_sent (sent_at DESC);

-- ----------------------------------------------------- breaking news -------
-- Every candidate headline seen per source. Cross-source confirmation asks
-- this table "how many DISTINCT sources carried this story in the last 30
-- minutes"; UNIQUE (story_key, source_id) keeps one source from confirming
-- itself by republishing.
CREATE TABLE IF NOT EXISTS breaking_seen (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  story_key TEXT NOT NULL,
  source_id TEXT NOT NULL,
  title     TEXT NOT NULL DEFAULT '',
  link      TEXT NOT NULL DEFAULT '',
  seen_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (story_key, source_id)
);

CREATE INDEX IF NOT EXISTS idx_breaking_seen_key ON breaking_seen (story_key, seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_breaking_seen_at ON breaking_seen (seen_at DESC);

-- Alerts actually delivered: the dedupe guard and the per-day cap both read it.
CREATE TABLE IF NOT EXISTS breaking_alerts (
  story_key  TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '',
  score      INTEGER NOT NULL DEFAULT 0,
  category   TEXT NOT NULL DEFAULT '',
  local_date TEXT NOT NULL,
  sent_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  message_id INTEGER,
  -- Telegram file_id of the delivered slide. Re-sending a file_id is free and
  -- instant, so the private-chat /slideshow browser pages through an album
  -- without re-rendering a single PNG.
  file_id    TEXT
);

CREATE INDEX IF NOT EXISTS idx_breaking_alerts_date ON breaking_alerts (local_date);

-- ------------------------------------------------------------ llm usage ----
-- Per-day, per-provider call counter. Lets the jobs stay inside a free tier's
-- daily cap and lets /status show how much budget is left.
CREATE TABLE IF NOT EXISTS llm_usage (
  local_date TEXT NOT NULL,
  provider   TEXT NOT NULL,
  calls      INTEGER NOT NULL DEFAULT 0,
  failures   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (local_date, provider)
);

-- Daily security / bug-bounty writeup digest (task 6).
--
-- Additive only: no existing table or column is modified or dropped.
--
-- The once-per-day guarantee reuses the existing `job_claims` table with
-- job = 'security'; that table has no CHECK on `job`, so no change is needed
-- there. All this migration adds is the "already posted" ledger.

-- Articles already delivered in a digest.
--
-- A row is written ONLY after Telegram confirms the message, so a failed send
-- leaves the item eligible for tomorrow instead of silently dropping it.
--
-- `item_key` is a hash of the canonical URL (falling back to the normalized
-- title when a feed gives no usable link), so the same article re-published
-- with a different tracking query string is still recognized as a repeat.
-- Writeup feeds keep an article at the top for days; without this the digest
-- would post the same piece every morning.
CREATE TABLE IF NOT EXISTS security_seen (
  item_key  TEXT PRIMARY KEY,
  source_id TEXT NOT NULL DEFAULT '',
  title     TEXT NOT NULL DEFAULT '',
  link      TEXT NOT NULL DEFAULT '',
  seen_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Supports the retention sweep at the end of each run.
CREATE INDEX IF NOT EXISTS idx_security_seen_at ON security_seen (seen_at);

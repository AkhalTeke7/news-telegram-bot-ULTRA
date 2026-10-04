-- Phase 6: short-lived conversation state for the Telegram admin interface.
-- Workers are stateless, so the pending action lives in D1 with an explicit
-- expiry. Only the acting admin's chat id is stored; no message contents.
CREATE TABLE IF NOT EXISTS telegram_admin_state (
  chat_id     INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  action      TEXT    NOT NULL,
  payload     TEXT,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telegram_admin_state_expires ON telegram_admin_state (expires_at);

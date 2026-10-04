import type { Channel, ChannelRow } from './types';
import { toChannel } from './types';

const SELECT_COLUMNS =
  'id, channel_username, channel_title, enabled, last_checked_at, last_processed_message_id, created_at, updated_at';

export async function listChannels(db: D1Database): Promise<Channel[]> {
  const { results } = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM channels ORDER BY id ASC`)
    .all<ChannelRow>();
  return (results ?? []).map(toChannel);
}

export async function getChannelById(db: D1Database, id: number): Promise<Channel | null> {
  const row = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM channels WHERE id = ?1`)
    .bind(id)
    .first<ChannelRow>();
  return row ? toChannel(row) : null;
}

export async function getChannelByUsername(
  db: D1Database,
  username: string
): Promise<Channel | null> {
  const row = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM channels WHERE channel_username = ?1`)
    .bind(username)
    .first<ChannelRow>();
  return row ? toChannel(row) : null;
}

export async function insertChannel(
  db: D1Database,
  username: string,
  title: string | null,
  enabled: boolean
): Promise<Channel | null> {
  const result = await db
    .prepare(
      `INSERT INTO channels (channel_username, channel_title, enabled)
       VALUES (?1, ?2, ?3)
       ON CONFLICT (channel_username) DO NOTHING`
    )
    .bind(username, title, enabled ? 1 : 0)
    .run();

  if (!result.meta.changes || result.meta.changes < 1) return null;
  return getChannelByUsername(db, username);
}

export async function setChannelEnabled(
  db: D1Database,
  id: number,
  enabled: boolean
): Promise<Channel | null> {
  const result = await db
    .prepare(
      `UPDATE channels SET enabled = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?2`
    )
    .bind(enabled ? 1 : 0, id)
    .run();

  if (!result.meta.changes) return null;
  return getChannelById(db, id);
}

export async function listEnabledChannels(db: D1Database): Promise<Channel[]> {
  const { results } = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM channels WHERE enabled = 1 ORDER BY id ASC`)
    .all<ChannelRow>();
  return (results ?? []).map(toChannel);
}

export interface NewMessage {
  telegramMessageId: number;
  messageDate: string;
  messageText: string;
  sourceUrl: string;
}

/**
 * Inserts posts, relying on UNIQUE (source_channel_id, telegram_message_id)
 * to make re-collection a no-op instead of a duplicate.
 */
export async function insertMessages(
  db: D1Database,
  sourceChannelId: number,
  messages: NewMessage[]
): Promise<{ inserted: number; duplicates: number }> {
  if (messages.length === 0) return { inserted: 0, duplicates: 0 };

  const stmt = db.prepare(
    `INSERT INTO messages (source_channel_id, telegram_message_id, message_date, message_text, source_url)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (source_channel_id, telegram_message_id) DO NOTHING`
  );

  const results = await db.batch(
    messages.map((m) =>
      stmt.bind(sourceChannelId, m.telegramMessageId, m.messageDate, m.messageText, m.sourceUrl)
    )
  );

  const inserted = results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
  return { inserted, duplicates: messages.length - inserted };
}

/**
 * Records that a channel was collected successfully. Never moves
 * last_processed_message_id backwards.
 */
export async function markChannelProcessed(
  db: D1Database,
  id: number,
  newestMessageId: number
): Promise<void> {
  await db
    .prepare(
      `UPDATE channels
          SET last_checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
              last_processed_message_id = CASE
                WHEN ?1 > COALESCE(last_processed_message_id, 0) THEN ?1
                ELSE last_processed_message_id
              END,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?2`
    )
    .bind(newestMessageId, id)
    .run();
}

export async function deleteChannel(db: D1Database, id: number): Promise<boolean> {
  const result = await db.prepare(`DELETE FROM channels WHERE id = ?1`).bind(id).run();
  return result.meta.changes > 0;
}

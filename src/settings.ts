/** Tiny key/value store over ai_settings. Never used for secrets. */

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare(`SELECT value FROM ai_settings WHERE key = ?1`).bind(key).first<{
    value: string | null;
  }>();
  return row?.value ?? null;
}

export async function setSetting(
  db: D1Database,
  key: string,
  value: string | null
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ai_settings (key, value, updated_at)
       VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT (key) DO UPDATE
         SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
    )
    .bind(key, value)
    .run();
}

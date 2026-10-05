/**
 * Stage 2: cross-source confirmation.
 *
 * The same story arriving from two INDEPENDENT newsrooms inside half an hour
 * is meaningfully stronger evidence than one outlet's headline, so it raises
 * the score. Independence is the whole point: `UNIQUE (story_key, source_id)`
 * stops one feed confirming itself by republishing, and the caller maps
 * source ids to owner `group`s so two feeds from the same newsroom count once.
 *
 * Stories are matched by `storyFingerprint()` — the significant words of the
 * headline, sorted — so "Fed holds rates steady" and "Rates held steady by
 * the Fed" land on the same key.
 */

import { storyFingerprint } from '../lib/hash';
import { describeError } from '../lib/http';

/** Window in which two sightings count as the same breaking story. */
export const CONFIRMATION_WINDOW_MINUTES = 30;

/** Sightings older than this are pruned; nothing reads them. */
export const SIGHTING_RETENTION_HOURS = 6;

export const storyKeyFor = (title: string): string => storyFingerprint(title);

/**
 * Records that `sourceId` carried this story. Idempotent per (story, source).
 *
 * Returns false on a database error: the pipeline continues with whatever
 * confirmation data it has rather than dropping the story.
 */
export async function recordSighting(
  db: D1Database,
  storyKey: string,
  sourceId: string,
  title: string,
  link: string
): Promise<boolean> {
  try {
    await db
      .prepare(
        `INSERT OR IGNORE INTO breaking_seen (story_key, source_id, title, link)
         VALUES (?1, ?2, ?3, ?4)`
      )
      .bind(storyKey, sourceId, title.slice(0, 300), link.slice(0, 500))
      .run();
    return true;
  } catch (error) {
    console.error(
      JSON.stringify({ event: 'breaking', stage: 'record-sighting', error: describeError(error) })
    );
    return false;
  }
}

/**
 * Source ids that carried `storyKey` within the confirmation window.
 *
 * The time filter is computed in TypeScript and passed as an ISO string so
 * the comparison matches how `seen_at` is written, instead of relying on
 * SQLite's `datetime()` arithmetic against a differently-formatted column.
 */
export async function confirmingSourceIds(
  db: D1Database,
  storyKey: string,
  now: Date,
  windowMinutes = CONFIRMATION_WINDOW_MINUTES
): Promise<string[]> {
  const since = new Date(now.getTime() - windowMinutes * 60_000).toISOString();
  try {
    const { results } = await db
      .prepare(
        `SELECT DISTINCT source_id FROM breaking_seen
          WHERE story_key = ?1 AND seen_at >= ?2`
      )
      .bind(storyKey, since)
      .all<{ source_id: string }>();
    return (results ?? []).map((row) => String(row.source_id));
  } catch {
    return [];
  }
}

/**
 * Score bonus for independent corroboration.
 *
 * Deliberately modest: confirmation RAISES confidence, it does not manufacture
 * it. A trivial story carried by five outlets still has to clear the
 * threshold on the LLM's own score.
 */
export function confirmationBonus(independentGroups: number): number {
  if (independentGroups >= 3) return 2;
  if (independentGroups === 2) return 1;
  return 0;
}

/** Deletes sightings nobody will read again. Best effort. */
export async function pruneSightings(db: D1Database, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - SIGHTING_RETENTION_HOURS * 3_600_000).toISOString();
  try {
    await db.prepare(`DELETE FROM breaking_seen WHERE seen_at < ?1`).bind(cutoff).run();
  } catch {
    /* best effort */
  }
}

/* ----------------------------------------------------- delivery guards --- */

/** True when this exact story was already alerted. */
export async function alreadyAlerted(db: D1Database, storyKey: string): Promise<boolean> {
  try {
    const row = await db
      .prepare(`SELECT 1 AS hit FROM breaking_alerts WHERE story_key = ?1`)
      .bind(storyKey)
      .first<{ hit: number }>();
    return Boolean(row);
  } catch {
    // Fail CLOSED: if we cannot prove the story is new, do not alert.
    return true;
  }
}

/** Alerts already sent on `localDate`, for the per-day cap. */
export async function alertsSentToday(db: D1Database, localDate: string): Promise<number> {
  try {
    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM breaking_alerts WHERE local_date = ?1`)
      .bind(localDate)
      .first<{ n: number }>();
    return Number(row?.n ?? 0);
  } catch {
    // Fail closed again: an unknown count must not license unlimited alerts.
    return Number.MAX_SAFE_INTEGER;
  }
}

/** Records a delivered alert. Called only after Telegram confirms. */
export async function recordAlert(
  db: D1Database,
  entry: {
    storyKey: string;
    title: string;
    score: number;
    category: string;
    localDate: string;
    messageId: number | null;
  }
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT OR IGNORE INTO breaking_alerts
           (story_key, title, score, category, local_date, message_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
      )
      .bind(
        entry.storyKey,
        entry.title.slice(0, 300),
        Math.round(entry.score),
        entry.category.slice(0, 40),
        entry.localDate,
        entry.messageId
      )
      .run();
  } catch (error) {
    console.error(
      JSON.stringify({ event: 'breaking', stage: 'record-alert', error: describeError(error) })
    );
  }
}

/**
 * Collection-only mode ("فقط جمع‌آوری اخبار").
 *
 * When enabled the pipeline stages after `collect` — the local advertisement
 * filter, AI summarization, importance ranking and publishing — are skipped on
 * the hourly cron, so the system only fetches and stores raw news and never
 * processes or sends anything. Raw messages stay untouched, so switching back
 * off lets the normal pipeline pick everything up on its next run.
 *
 * Persisted in ai_settings (key/value, never secrets) so it survives deploys
 * without a schema migration.
 */

import { getSetting, setSetting } from './settings';

export const COLLECTION_ONLY_SETTING = 'collection_only_mode';

export async function isCollectionOnly(db: D1Database): Promise<boolean> {
  return (await getSetting(db, COLLECTION_ONLY_SETTING)) === '1';
}

export async function setCollectionOnly(db: D1Database, on: boolean): Promise<void> {
  await setSetting(db, COLLECTION_ONLY_SETTING, on ? '1' : '0');
}

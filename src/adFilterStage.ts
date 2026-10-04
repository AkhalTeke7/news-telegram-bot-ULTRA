/**
 * Pipeline stage: run the local advertisement filter over collected messages and
 * persist the verdict.
 *
 * A message is evaluated exactly once (guarded by `filter_status = 'pending'`),
 * so a filtered advertisement is never reconsidered on later hourly runs, and a
 * passing message never gets re-scored.
 */

import { detectAdvertisement, stripExternalIdentifiers } from './adFilter';

export const MAX_FILTER_PER_RUN = 200;

export interface FilterOutcome {
  checked: number;
  filtered: number;
  passed: number;
}

export async function filterPendingMessages(
  db: D1Database,
  opts: { limit?: number } = {}
): Promise<FilterOutcome> {
  const limit = opts.limit ?? MAX_FILTER_PER_RUN;

  const { results } = await db
    .prepare(
      `SELECT id, message_text FROM messages
        WHERE filter_status = 'pending'
        ORDER BY message_date ASC
        LIMIT ?1`
    )
    .bind(limit)
    .all<{ id: number; message_text: string }>();

  const rows = results ?? [];
  if (rows.length === 0) return { checked: 0, filtered: 0, passed: 0 };

  const update = db.prepare(
    `UPDATE messages
        SET filter_status = ?1,
            filter_reason = ?2,
            filtered_at = CASE WHEN ?1 = 'filtered' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END
      WHERE id = ?3 AND filter_status = 'pending'`
  );

  const statements = rows.map((row) => {
    const verdict = detectAdvertisement(row.message_text ?? '');
    // Empty / media-only posts can never be summarized, so mark them passed
    // rather than leaving them pending forever.
    if ((row.message_text ?? '').trim().length === 0) {
      return update.bind('passed', 'بدون متن', row.id);
    }
    if (verdict.isAdvertisement) {
      return update.bind('filtered', verdict.reason ?? 'محتوای تبلیغاتی', row.id);
    }
    return update.bind('passed', null, row.id);
  });

  await db.batch(statements);

  const verdicts = rows.map((row) => {
    const text = (row.message_text ?? '').trim();
    if (text.length === 0) return 'passed';
    // Score the cleaned body: promotional links only add noise to detection.
    const cleaned = stripExternalIdentifiers(text);
    return detectAdvertisement(cleaned).isAdvertisement ? 'filtered' : 'passed';
  });

  return {
    checked: rows.length,
    filtered: verdicts.filter((v) => v === 'filtered').length,
    passed: verdicts.filter((v) => v === 'passed').length,
  };
}

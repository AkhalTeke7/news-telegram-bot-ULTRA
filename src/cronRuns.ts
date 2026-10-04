/** Hourly-job bookkeeping. Values are counts and categories only — no secrets. */

export type CronStatus = 'success' | 'partial' | 'failed';

/** collect → filter → summarize → rank → publish */
const EXPECTED_STAGES = 5;

/**
 * A run is only "success" when every stage completed *and* no individual item
 * failed. Item-level failures (one bad channel, one bad message) are reported as
 * "partial" so the admin panel never shows a green run that actually skipped work.
 */
export function deriveCronStatus(stagesRun: number, stageErrors: number, itemFailures: number): CronStatus {
  if (stagesRun === 0) return 'failed';
  if (stageErrors > 0 || stagesRun < EXPECTED_STAGES || itemFailures > 0) return 'partial';
  return 'success';
}

export interface CronRunOutcome {
  channelsEnabled: number;
  messagesInserted: number;
  messagesFiltered: number;
  messagesSummarized: number;
  messagesPublished: number;
  failures: number;
  /** Short, safe description of what failed, if anything. */
  errorSummary?: string | null;
}

export interface CronRunRow extends CronRunOutcome {
  id: number;
  triggerName: string;
  ranAt: string;
  status: string;
  finishedAt: string | null;
  durationMs: number | null;
}

const COLUMNS =
  'id, trigger_name, ran_at, status, finished_at, duration_ms, channels_enabled, messages_inserted, messages_filtered, messages_summarized, messages_published, failures, error_summary';

function toRow(raw: Record<string, unknown>): CronRunRow {
  return {
    id: Number(raw.id),
    triggerName: String(raw.trigger_name ?? ''),
    ranAt: String(raw.ran_at ?? ''),
    status: String(raw.status ?? 'unknown'),
    finishedAt: (raw.finished_at as string | null) ?? null,
    durationMs: raw.duration_ms === null ? null : Number(raw.duration_ms),
    channelsEnabled: Number(raw.channels_enabled ?? 0),
    messagesInserted: Number(raw.messages_inserted ?? 0),
    messagesFiltered: Number(raw.messages_filtered ?? 0),
    messagesSummarized: Number(raw.messages_summarized ?? 0),
    messagesPublished: Number(raw.messages_published ?? 0),
    failures: Number(raw.failures ?? 0),
    errorSummary: (raw.error_summary as string | null) ?? null,
  };
}

export async function startCronRun(db: D1Database, triggerName: string): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO cron_runs (trigger_name, status) VALUES (?1, 'running')`
    )
    .bind(triggerName)
    .run();
  return Number(result.meta.last_row_id ?? 0);
}

export async function finishCronRun(
  db: D1Database,
  id: number,
  status: CronStatus,
  startedAtMs: number,
  outcome: CronRunOutcome
): Promise<void> {
  await db
    .prepare(
      `UPDATE cron_runs
          SET status = ?1,
              finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
              duration_ms = ?2,
              channels_enabled = ?3,
              messages_inserted = ?4,
              messages_filtered = ?5,
              messages_summarized = ?6,
              messages_published = ?7,
              failures = ?8,
              error_summary = ?9
        WHERE id = ?10`
    )
    .bind(
      status,
      Math.max(0, Date.now() - startedAtMs),
      outcome.channelsEnabled,
      outcome.messagesInserted,
      outcome.messagesFiltered,
      outcome.messagesSummarized,
      outcome.messagesPublished,
      outcome.failures,
      outcome.errorSummary ?? null,
      id
    )
    .run();
}

export async function getLastCronRun(db: D1Database): Promise<CronRunRow | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM cron_runs ORDER BY id DESC LIMIT 1`)
    .first<Record<string, unknown>>();
  return row ? toRow(row) : null;
}

export interface CronSummary {
  runs24h: number;
  failedRuns24h: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
}

export async function getCronSummary(db: D1Database, sinceIso: string): Promise<CronSummary> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS runs24h,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_runs,
              MAX(CASE WHEN status IN ('success', 'partial') THEN finished_at END) AS last_success,
              MAX(CASE WHEN status = 'failed' THEN finished_at END) AS last_failure
         FROM cron_runs
        WHERE ran_at >= ?1`
    )
    .bind(sinceIso)
    .first<{ runs24h: number; failed_runs: number | null; last_success: string | null; last_failure: string | null }>();

  return {
    runs24h: Number(row?.runs24h ?? 0),
    failedRuns24h: Number(row?.failed_runs ?? 0),
    lastSuccessAt: row?.last_success ?? null,
    lastFailureAt: row?.last_failure ?? null,
  };
}

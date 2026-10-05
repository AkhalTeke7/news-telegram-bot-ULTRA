/**
 * Job bookkeeping: the atomic once-per-day claim and the per-job run log.
 *
 * The claim is the whole reason the daily calendar can never double-send.
 * Cron Triggers are at-least-once: Cloudflare may retry a failed invocation,
 * two deployments can overlap during a rollout, and a manual admin run can
 * race the scheduler. Rather than hoping that never happens, `claimDailyJob`
 * makes the send conditional on winning a row insert.
 */

import { localDateKey } from './jalali';

export type JobName = 'breaking' | 'calendar' | 'slideshow' | 'security';

export type JobStatus = 'running' | 'success' | 'skipped' | 'partial' | 'failed';

export interface ClaimResult {
  /** True only for the single caller that inserted the row. */
  won: boolean;
  /** Local civil date the claim is keyed on. */
  date: string;
  /** Status of an existing claim, when `won` is false. */
  existingStatus?: string;
}

/**
 * Atomically claims `job` for the local civil day containing `now`.
 *
 * `INSERT OR IGNORE` on the composite primary key is the entire mechanism:
 * SQLite/D1 applies it as a single statement, so of N concurrent callers
 * exactly one sees `meta.changes === 1`. Everyone else gets `won: false` and
 * must not send.
 */
export async function claimDailyJob(
  db: D1Database,
  job: JobName,
  timeZone: string,
  now: Date = new Date()
): Promise<ClaimResult> {
  const date = localDateKey(now, timeZone);
  const result = await db
    .prepare(`INSERT OR IGNORE INTO job_claims (job, claim_date) VALUES (?1, ?2)`)
    .bind(job, date)
    .run();

  if ((result.meta.changes ?? 0) > 0) return { won: true, date };

  const existing = await db
    .prepare(`SELECT status FROM job_claims WHERE job = ?1 AND claim_date = ?2`)
    .bind(job, date)
    .first<{ status: string }>();

  return { won: false, date, existingStatus: existing?.status };
}

/** Marks a won claim as delivered. Called only after Telegram confirms. */
export async function markClaimSent(
  db: D1Database,
  job: JobName,
  date: string,
  detail: string | null = null
): Promise<void> {
  await db
    .prepare(`UPDATE job_claims SET status = 'sent', detail = ?3 WHERE job = ?1 AND claim_date = ?2`)
    .bind(job, date, detail)
    .run();
}

/** Marks a won claim as intentionally not sent (e.g. no red events today). */
export async function markClaimSkipped(
  db: D1Database,
  job: JobName,
  date: string,
  detail: string | null = null
): Promise<void> {
  await db
    .prepare(
      `UPDATE job_claims SET status = 'skipped', detail = ?3 WHERE job = ?1 AND claim_date = ?2`
    )
    .bind(job, date, detail)
    .run();
}

/**
 * Releases a claim so a later invocation may retry today.
 *
 * DANGEROUS BY DESIGN — only call this when the failure provably happened
 * BEFORE anything was handed to Telegram (source fetch failed, zero events,
 * analysis failed while the message had not been sent yet).
 *
 * It must never be called after a send attempt whose outcome is unknown (a
 * timeout, a dropped connection): Telegram may well have delivered the
 * message, and releasing would produce exactly the double-send this table
 * exists to prevent. Leaving the claim in place fails closed: at worst a day
 * is missed, which `/status` makes visible.
 */
export async function releaseClaim(db: D1Database, job: JobName, date: string): Promise<void> {
  await db
    .prepare(`DELETE FROM job_claims WHERE job = ?1 AND claim_date = ?2 AND status = 'claimed'`)
    .bind(job, date)
    .run();
}

/* ------------------------------------------------------------- run log --- */

export interface JobRunRecord {
  id: number;
  job: string;
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  status: JobStatus;
  detail: string | null;
}

/** Opens a run row. Returns 0 when bookkeeping itself failed (never throws). */
export async function startJobRun(
  db: D1Database,
  job: JobName,
  trigger: string
): Promise<number> {
  try {
    const result = await db
      .prepare(`INSERT INTO job_runs (job, trigger, status) VALUES (?1, ?2, 'running')`)
      .bind(job, trigger.slice(0, 64))
      .run();
    return Number(result.meta.last_row_id ?? 0);
  } catch {
    return 0;
  }
}

/** Closes a run row. Never throws: bookkeeping must not fail a job. */
export async function finishJobRun(
  db: D1Database,
  id: number,
  status: JobStatus,
  startedAtMs: number,
  detail?: string | null
): Promise<void> {
  if (id <= 0) return;
  try {
    await db
      .prepare(
        `UPDATE job_runs
            SET status = ?1,
                finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                duration_ms = ?2,
                detail = ?3
          WHERE id = ?4`
      )
      .bind(status, Math.max(0, Date.now() - startedAtMs), (detail ?? null)?.slice(0, 500) ?? null, id)
      .run();
  } catch {
    // ignored on purpose
  }
}

/** Most recent run of each job, for the admin /status screen. */
export async function getLastJobRuns(db: D1Database): Promise<Map<string, JobRunRecord>> {
  const { results } = await db
    .prepare(
      `SELECT r.id, r.job, r.trigger, r.started_at, r.finished_at, r.duration_ms, r.status, r.detail
         FROM job_runs r
         JOIN (SELECT job, MAX(id) AS id FROM job_runs GROUP BY job) latest
           ON latest.id = r.id`
    )
    .all<Record<string, unknown>>();

  const map = new Map<string, JobRunRecord>();
  for (const row of results ?? []) {
    const record: JobRunRecord = {
      id: Number(row.id ?? 0),
      job: String(row.job ?? ''),
      trigger: String(row.trigger ?? ''),
      startedAt: String(row.started_at ?? ''),
      finishedAt: (row.finished_at as string | null) ?? null,
      durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
      status: String(row.status ?? 'running') as JobStatus,
      detail: (row.detail as string | null) ?? null,
    };
    map.set(record.job, record);
  }
  return map;
}

/** Counts runs per status for one job in the last `hours`, for /status. */
export async function getJobRunSummary(
  db: D1Database,
  job: JobName,
  sinceIso: string
): Promise<{ total: number; failed: number }> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM job_runs WHERE job = ?1 AND started_at >= ?2`
    )
    .bind(job, sinceIso)
    .first<{ total: number; failed: number | null }>();
  return { total: Number(row?.total ?? 0), failed: Number(row?.failed ?? 0) };
}

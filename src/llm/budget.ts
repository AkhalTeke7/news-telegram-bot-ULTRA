/**
 * Daily LLM call budget.
 *
 * Free tiers are capped per day (OpenRouter's free pool is roughly 50
 * requests/day account-wide, and the other gateways have their own limits).
 * The breaking-news job alone wakes up 288 times a day, so without a budget a
 * single noisy morning would exhaust the quota and the calendar job later that
 * day would silently lose its analysis.
 *
 * The counter is per local civil day so it lines up with how the operator
 * thinks about "today", and per provider so `/status` can show which gateway
 * is carrying the load.
 */

export const DEFAULT_DAILY_LLM_BUDGET = 60;

/** Parses LLM_DAILY_BUDGET; non-numeric or negative values fall back. */
export function resolveDailyBudget(raw: string | undefined): number {
  const parsed = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_DAILY_LLM_BUDGET;
  // A sane ceiling, so a typo like "600000" cannot mean "unlimited".
  return Math.min(parsed, 5000);
}

/** Total calls attempted today across all providers. */
export async function getLlmCallsToday(db: D1Database, localDate: string): Promise<number> {
  try {
    const row = await db
      .prepare(`SELECT COALESCE(SUM(calls), 0) AS total FROM llm_usage WHERE local_date = ?1`)
      .bind(localDate)
      .first<{ total: number }>();
    return Number(row?.total ?? 0);
  } catch {
    // If bookkeeping is unavailable, do not block the job.
    return 0;
  }
}

/** Calls still allowed today. Never negative. */
export async function remainingLlmBudget(
  db: D1Database,
  localDate: string,
  dailyLimit: number
): Promise<number> {
  const used = await getLlmCallsToday(db, localDate);
  return Math.max(0, dailyLimit - used);
}

/** Records one attempt. Never throws: accounting must not fail a job. */
export async function recordLlmCall(
  db: D1Database,
  localDate: string,
  provider: string,
  ok: boolean
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO llm_usage (local_date, provider, calls, failures)
         VALUES (?1, ?2, 1, ?3)
         ON CONFLICT (local_date, provider) DO UPDATE
           SET calls = calls + 1,
               failures = failures + ?3`
      )
      .bind(localDate, provider, ok ? 0 : 1)
      .run();
  } catch {
    // ignored on purpose
  }
}

export interface LlmUsageRow {
  provider: string;
  calls: number;
  failures: number;
}

/** Today's usage per provider, for the admin /status screen. */
export async function getLlmUsage(db: D1Database, localDate: string): Promise<LlmUsageRow[]> {
  try {
    const { results } = await db
      .prepare(
        `SELECT provider, calls, failures FROM llm_usage WHERE local_date = ?1 ORDER BY calls DESC`
      )
      .bind(localDate)
      .all<{ provider: string; calls: number; failures: number }>();
    return (results ?? []).map((r) => ({
      provider: String(r.provider),
      calls: Number(r.calls ?? 0),
      failures: Number(r.failures ?? 0),
    }));
  } catch {
    return [];
  }
}

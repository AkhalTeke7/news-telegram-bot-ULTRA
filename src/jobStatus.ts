/**
 * TASK 5 — the admin-only `/status` report.
 *
 * Answers the only question that matters at 3am: "is each scheduled job
 * actually running, and when did it last do something?"
 *
 * Every lookup is wrapped so a missing table or a D1 hiccup degrades one line
 * of the report instead of failing the whole command — a status screen that
 * cannot render is worse than useless.
 */

import { CALENDAR_CRON, BREAKING_CRON, PIPELINE_CRON, SLIDESHOW_CRON } from './scheduler';
import { getLastCronRun } from './cronRuns';
import { getLastJobRuns, type JobRunRecord, type JobStatus } from './lib/jobs';
import { getLlmUsage, remainingLlmBudget, resolveDailyBudget } from './llm/budget';
import { configuredProviderIds } from './llm/providers';
import { jalaliDateTime, localDateKey, resolveTimeZone } from './lib/jalali';
import type { Env } from './types';

/** Admin-only command. Authorization is enforced by the caller's isAdmin(). */
export const STATUS_COMMAND = '/status';

const STATUS_ICON: Record<JobStatus, string> = {
  running: '⏳',
  success: '✅',
  skipped: '⏭',
  partial: '⚠️',
  failed: '❌',
};

interface JobLine {
  key: string;
  label: string;
  cron: string;
  schedule: string;
}

const JOBS: JobLine[] = [
  { key: 'breaking', label: 'اخبار فوری', cron: BREAKING_CRON, schedule: 'هر ۵ دقیقه' },
  { key: 'calendar', label: 'تقویم اقتصادی', cron: CALENDAR_CRON, schedule: 'روزانه ۰۸:۰۰' },
  { key: 'slideshow', label: 'اسلایدشو', cron: SLIDESHOW_CRON, schedule: 'هر ۳ ساعت' },
];

/** `۳ دقیقه پیش` — relative age, which is what an operator actually reads. */
export function relativeAge(iso: string | null | undefined, now: Date): string {
  if (!iso) return 'هرگز';
  const then = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`);
  if (Number.isNaN(then.getTime())) return 'نامشخص';
  const seconds = Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000));
  if (seconds < 90) return `${seconds} ثانیه پیش`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} دقیقه پیش`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} ساعت پیش`;
  return `${Math.round(hours / 24)} روز پیش`;
}

/** One job's line, defensive about every field. */
function renderJob(job: JobLine, run: JobRunRecord | undefined, now: Date): string[] {
  if (!run) {
    return [`⚪️ ${job.label} (${job.schedule})`, '   هنوز اجرا نشده است.'];
  }
  const icon = STATUS_ICON[run.status] ?? '•';
  const when = relativeAge(run.finishedAt ?? run.startedAt, now);
  const duration = run.durationMs === null ? '' : ` · ${(run.durationMs / 1000).toFixed(1)}s`;
  const lines = [`${icon} ${job.label} (${job.schedule})`, `   آخرین اجرا: ${when}${duration}`];
  if (run.detail) lines.push(`   ${run.detail.slice(0, 180)}`);
  return lines;
}

export interface StatusOptions {
  now?: Date;
}

/**
 * Builds the full `/status` text. Never throws.
 */
export async function buildJobStatusReport(env: Env, opts: StatusOptions = {}): Promise<string> {
  const now = opts.now ?? new Date();
  const timeZone = resolveTimeZone(env.TIMEZONE);
  const today = localDateKey(now, timeZone);

  const lines: string[] = ['📊 وضعیت کارهای زمان‌بندی‌شده', jalaliDateTime(now, timeZone), ''];

  let runs = new Map<string, JobRunRecord>();
  try {
    runs = await getLastJobRuns(env.DB);
  } catch {
    lines.push('⚠️ خواندن تاریخچهٔ اجراها ممکن نشد.', '');
  }

  for (const job of JOBS) {
    lines.push(...renderJob(job, runs.get(job.key), now));
    lines.push('');
  }

  // The legacy digest pipeline predates job_runs and keeps its own cron_runs
  // table, so it is read separately rather than being migrated.
  try {
    const last = await getLastCronRun(env.DB);
    if (!last) {
      lines.push('⚪️ خلاصهٔ خبری (هر ۲ ساعت)', '   هنوز اجرا نشده است.', '');
    } else {
      const icon = last.status === 'success' ? '✅' : last.status === 'partial' ? '⚠️' : last.status === 'running' ? '⏳' : '❌';
      const duration = last.durationMs === null ? '' : ` · ${(last.durationMs / 1000).toFixed(1)}s`;
      lines.push(
        `${icon} خلاصهٔ خبری (هر ۲ ساعت)`,
        `   آخرین اجرا: ${relativeAge(last.finishedAt ?? last.ranAt, now)}${duration}`,
        `   دریافت=${last.messagesInserted} منتشرشده=${last.messagesPublished} خطا=${last.failures}`,
        ''
      );
    }
  } catch {
    /* non-fatal */
  }

  // --- today's claims ------------------------------------------------------
  try {
    const { results } = await env.DB.prepare(
      `SELECT job, status, detail FROM job_claims WHERE claim_date = ?1`
    )
      .bind(today)
      .all<{ job: string; status: string; detail: string | null }>();
    if ((results ?? []).length > 0) {
      lines.push('🔒 قفل‌های امروز:');
      for (const row of results) {
        lines.push(`   ${row.job}: ${row.status}${row.detail ? ` (${row.detail.slice(0, 60)})` : ''}`);
      }
      lines.push('');
    }
  } catch {
    /* non-fatal */
  }

  // --- alerts sent today ---------------------------------------------------
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM breaking_alerts WHERE local_date = ?1`
    )
      .bind(today)
      .first<{ n: number }>();
    const cap = (env.BREAKING_DAILY_CAP ?? '').trim() || '8';
    lines.push(`🚨 هشدارهای امروز: ${Number(row?.n ?? 0)}/${cap}`);
  } catch {
    /* non-fatal */
  }

  // --- slides sent ---------------------------------------------------------
  // `sent_at` is stored in UTC, so this window has to be built from the UTC
  // date, NOT from `today` (which is the Tehran date and would point at a
  // future instant between 00:00 and 03:30 local).
  try {
    const utcMidnight = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM slideshow_sent WHERE sent_at >= ?1`
    )
      .bind(utcMidnight)
      .first<{ n: number }>();
    lines.push(`🖼 اسلایدهای ارسال‌شده (از نیمه‌شب UTC): ${Number(row?.n ?? 0)}`);
  } catch {
    /* non-fatal */
  }

  // --- LLM providers and budget -------------------------------------------
  const providers = configuredProviderIds(env);
  lines.push(
    '',
    `🤖 ارائه‌دهنده‌های فعال: ${providers.length > 0 ? providers.join('، ') : 'هیچ‌کدام'}`
  );
  try {
    const limit = resolveDailyBudget(env.LLM_DAILY_BUDGET);
    const remaining = await remainingLlmBudget(env.DB, today, limit);
    lines.push(`💳 بودجهٔ امروز: ${limit - remaining}/${limit} مصرف شده`);
    const usage = await getLlmUsage(env.DB, today);
    for (const row of usage) {
      lines.push(`   ${row.provider}: ${row.calls} فراخوانی، ${row.failures} خطا`);
    }
  } catch {
    /* non-fatal */
  }

  lines.push(
    '',
    '⏱ زمان‌بندی (UTC):',
    `   ${PIPELINE_CRON} — خلاصهٔ خبری`,
    `   ${BREAKING_CRON} — اخبار فوری`,
    `   ${CALENDAR_CRON} — تقویم اقتصادی`,
    `   ${SLIDESHOW_CRON} — اسلایدشو`
  );

  return lines.join('\n').slice(0, 4000);
}

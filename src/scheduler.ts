/**
 * TASK 5 — the cron router.
 *
 * Cloudflare delivers every trigger to the SAME `scheduled()` handler and
 * tells you which one fired via `controller.cron`. Before this module the
 * handler ran `runNewsPipeline` unconditionally, which was correct while
 * there was exactly one trigger — with four it would have run the digest
 * pipeline every five minutes. Routing on the cron expression is therefore
 * not a nicety, it is the thing that keeps the existing feature correct.
 *
 * Guarantees:
 *  - every job runs inside its own try/catch, so one throwing job can never
 *    stop another;
 *  - every job is wrapped in `ctx.waitUntil`, so the invocation is not killed
 *    the moment the handler returns;
 *  - an UNKNOWN cron expression does nothing and is logged loudly, rather
 *    than falling through to some default job;
 *  - every run is recorded in `job_runs` for `/status`.
 */

import { runBreakingJob } from './breaking/job';
import { runCalendarJob } from './calendar/job';
import { finishJobRun, startJobRun, type JobName, type JobStatus } from './lib/jobs';
import { describeError } from './lib/http';
import { runNewsPipeline } from './pipeline';
import { runSlideshowJob } from './slideshow/job';
import type { Env } from './types';

/** The existing digest pipeline. Untouched, still on its original schedule. */
export const PIPELINE_CRON = '30 */2 * * *';
export const BREAKING_CRON = '*/5 * * * *';
export const CALENDAR_CRON = '30 4 * * *';
export const SLIDESHOW_CRON = '0 */3 * * *';

export type ScheduledJobName = JobName | 'pipeline';

/**
 * Cron expression -> job.
 *
 * Keys must match `wrangler.json` → `triggers.crons` EXACTLY, including
 * spacing: Cloudflare echoes the configured string back verbatim.
 */
export const CRON_ROUTES: Record<string, ScheduledJobName> = {
  [PIPELINE_CRON]: 'pipeline',
  [BREAKING_CRON]: 'breaking',
  [CALENDAR_CRON]: 'calendar',
  [SLIDESHOW_CRON]: 'slideshow',
};

/** Normalizes whitespace so a stray double space cannot orphan a trigger. */
const canonicalCron = (cron: string): string => cron.trim().replace(/\s+/g, ' ');

export function routeCron(cron: string): ScheduledJobName | null {
  return CRON_ROUTES[canonicalCron(cron)] ?? null;
}

export interface JobOutcome {
  job: ScheduledJobName;
  status: JobStatus;
  detail: string;
  durationMs: number;
}

const log = (payload: Record<string, unknown>): void => {
  console.log(JSON.stringify({ event: 'scheduled', timestamp: new Date().toISOString(), ...payload }));
};

/**
 * Runs one job with full isolation and bookkeeping.
 *
 * NEVER throws and never rejects — the caller hands this straight to
 * `ctx.waitUntil`, where a rejection would be an unhandled promise.
 */
export async function runScheduledJob(
  job: ScheduledJobName,
  env: Env,
  trigger: string
): Promise<JobOutcome> {
  const startedAt = Date.now();

  // The legacy pipeline keeps its own `cron_runs` bookkeeping; don't
  // double-log it into job_runs.
  const runId = job === 'pipeline' ? 0 : await startJobRun(env.DB, job, trigger);

  try {
    let status: JobStatus = 'success';
    let detail = '';

    switch (job) {
      case 'pipeline': {
        const outcome = await runNewsPipeline(env.DB, env, { trigger });
        status = 'success';
        detail = `trigger=${outcome.trigger}`;
        break;
      }
      case 'breaking': {
        const result = await runBreakingJob(env);
        status = result.status;
        detail = [
          `feeds=${result.feedsOk}/${result.feedsOk + result.feedsFailed}`,
          `items=${result.items}`,
          `candidates=${result.candidates}`,
          `scored=${result.scored}`,
          `sent=${result.sent}`,
          result.reason ? `reason=${result.reason}` : '',
        ]
          .filter(Boolean)
          .join(' ');
        break;
      }
      case 'calendar': {
        const result = await runCalendarJob(env);
        status = result.status;
        detail = [
          `events=${result.events}`,
          `analyzed=${result.analyzed}`,
          `messages=${result.messages}`,
          result.alreadyClaimed ? 'claimed_elsewhere' : '',
          result.reason ? `reason=${result.reason}` : '',
        ]
          .filter(Boolean)
          .join(' ');
        break;
      }
      case 'slideshow': {
        const result = await runSlideshowJob(env);
        status = result.status;
        detail = [
          `candidates=${result.candidates}`,
          `rendered=${result.rendered}`,
          `sent=${result.sent}`,
          `translated=${result.translated}`,
          `images=${result.withImage}`,
          result.reason ? `reason=${result.reason}` : '',
        ]
          .filter(Boolean)
          .join(' ');
        break;
      }
    }

    const durationMs = Date.now() - startedAt;
    await finishJobRun(env.DB, runId, status, startedAt, detail);
    log({ job, cron: trigger, status, detail, durationMs });
    return { job, status, detail, durationMs };
  } catch (error) {
    // A job should handle its own errors; reaching here means one escaped.
    const durationMs = Date.now() - startedAt;
    const detail = describeError(error, 200);
    await finishJobRun(env.DB, runId, 'failed', startedAt, detail);
    log({ job, cron: trigger, status: 'failed', detail, durationMs });
    return { job, status: 'failed', detail, durationMs };
  }
}

/**
 * Entry point for `scheduled()`.
 *
 * Each job gets its OWN `ctx.waitUntil` rather than sharing one promise, so
 * the runtime keeps every job alive independently and one slow job cannot
 * shorten another's budget.
 */
export function dispatchScheduled(
  controller: { cron: string; scheduledTime?: number },
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void }
): ScheduledJobName | null {
  const job = routeCron(controller.cron);

  if (!job) {
    // Loud, because the usual cause is wrangler.json and this file drifting
    // apart — which would silently disable a feature.
    console.error(
      JSON.stringify({
        event: 'scheduled',
        status: 'unrouted_cron',
        cron: controller.cron,
        known: Object.keys(CRON_ROUTES),
        timestamp: new Date().toISOString(),
      })
    );
    return null;
  }

  ctx.waitUntil(runScheduledJob(job, env, controller.cron));
  return job;
}

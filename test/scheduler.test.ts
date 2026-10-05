import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import wranglerConfig from '../wrangler.json';
import {
  BREAKING_CRON,
  CALENDAR_CRON,
  CRON_ROUTES,
  PIPELINE_CRON,
  SLIDESHOW_CRON,
  dispatchScheduled,
  routeCron,
  runScheduledJob,
} from '../src/scheduler';
import { buildJobStatusReport, relativeAge, STATUS_COMMAND } from '../src/jobStatus';

const NOW = new Date('2026-10-05T08:30:00Z');

/** Captures what the handler asked the runtime to keep alive. */
const makeCtx = () => {
  const promises: Promise<unknown>[] = [];
  return { promises, waitUntil: (p: Promise<unknown>) => void promises.push(p) };
};

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM job_runs`).run();
  await env.DB.prepare(`DELETE FROM job_claims`).run();
  await env.DB.prepare(`DELETE FROM breaking_alerts`).run();
  await env.DB.prepare(`DELETE FROM slideshow_sent`).run();
  await env.DB.prepare(`DELETE FROM llm_usage`).run();
  await env.DB.prepare(`DELETE FROM cron_runs`).run();
});

describe('cron routing', () => {
  it('routes each configured trigger to its own job', () => {
    expect(routeCron(PIPELINE_CRON)).toBe('pipeline');
    expect(routeCron(BREAKING_CRON)).toBe('breaking');
    expect(routeCron(CALENDAR_CRON)).toBe('calendar');
    expect(routeCron(SLIDESHOW_CRON)).toBe('slideshow');
  });

  it('covers EXACTLY the triggers declared in wrangler.json', () => {
    // A trigger with no route would fire and silently do nothing; a route
    // with no trigger would be dead code. Both are bugs.
    expect(new Set(Object.keys(CRON_ROUTES))).toEqual(new Set(wranglerConfig.triggers.crons));
  });

  it('tolerates whitespace drift in the expression', () => {
    expect(routeCron('  */5   * * * *  ')).toBe('breaking');
  });

  it('returns null for an unknown expression instead of guessing', () => {
    expect(routeCron('7 7 7 7 7')).toBeNull();
    expect(routeCron('')).toBeNull();
  });

  it('does not run the digest pipeline on the 5-minute trigger', () => {
    // The regression this whole module exists to prevent: before routing,
    // every cron ran runNewsPipeline.
    expect(routeCron(BREAKING_CRON)).not.toBe('pipeline');
    expect(routeCron(SLIDESHOW_CRON)).not.toBe('pipeline');
    expect(routeCron(CALENDAR_CRON)).not.toBe('pipeline');
  });
});

describe('dispatchScheduled', () => {
  const baseEnv = () => ({ ...env, TELEGRAM_BOT_TOKEN: '', TELEGRAM_DESTINATION_CHANNEL: '' });

  it('hands exactly one promise to waitUntil per firing', async () => {
    const ctx = makeCtx();
    const job = dispatchScheduled({ cron: BREAKING_CRON }, baseEnv() as never, ctx);
    expect(job).toBe('breaking');
    expect(ctx.promises).toHaveLength(1);
    await Promise.all(ctx.promises);
  });

  it('schedules nothing at all for an unknown cron', () => {
    const ctx = makeCtx();
    expect(dispatchScheduled({ cron: '* * * * *' }, baseEnv() as never, ctx)).toBeNull();
    expect(ctx.promises).toHaveLength(0);
  });

  it('never rejects, so waitUntil cannot see an unhandled rejection', async () => {
    const ctx = makeCtx();
    // A DB that throws on everything: the job must still settle cleanly.
    const brokenEnv = {
      ...baseEnv(),
      DB: {
        prepare() {
          throw new Error('database is on fire');
        },
      },
    };
    dispatchScheduled({ cron: SLIDESHOW_CRON }, brokenEnv as never, ctx);
    await expect(Promise.all(ctx.promises)).resolves.toBeDefined();
  });
});

describe('runScheduledJob', () => {
  const baseEnv = () => ({ ...env, TELEGRAM_BOT_TOKEN: '', TELEGRAM_DESTINATION_CHANNEL: '' });

  it('records a run row with status and detail', async () => {
    const outcome = await runScheduledJob('slideshow', baseEnv() as never, SLIDESHOW_CRON);
    expect(outcome.job).toBe('slideshow');
    expect(outcome.status).toBe('skipped');

    const row = await env.DB.prepare(
      `SELECT job, trigger, status, detail, duration_ms FROM job_runs ORDER BY id DESC LIMIT 1`
    ).first<{ job: string; trigger: string; status: string; detail: string; duration_ms: number }>();
    expect(row?.job).toBe('slideshow');
    expect(row?.trigger).toBe(SLIDESHOW_CRON);
    expect(row?.status).toBe('skipped');
    expect(row?.detail).toContain('reason=');
    expect(row?.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('isolates a thrown error into a failed run, never a rejection', async () => {
    const brokenEnv = {
      ...baseEnv(),
      // Credentials present, so the job gets as far as the D1 claim.
      TELEGRAM_BOT_TOKEN: 'T',
      TELEGRAM_DESTINATION_CHANNEL: '@mychannel',
      DB: {
        prepare() {
          throw new Error('database is on fire');
        },
      },
    };
    const outcome = await runScheduledJob('calendar', brokenEnv as never, CALENDAR_CRON);
    expect(outcome.status).toBe('failed');
    expect(outcome.detail).toBeTruthy();
  });

  it('runs each job independently — one failure does not stop the others', async () => {
    const results = await Promise.all([
      runScheduledJob('breaking', baseEnv() as never, BREAKING_CRON),
      runScheduledJob('calendar', baseEnv() as never, CALENDAR_CRON),
      runScheduledJob('slideshow', baseEnv() as never, SLIDESHOW_CRON),
    ]);
    expect(results).toHaveLength(3);
    for (const result of results) expect(result.status).toBeTruthy();

    const { results: rows } = await env.DB.prepare(
      `SELECT DISTINCT job FROM job_runs ORDER BY job`
    ).all<{ job: string }>();
    expect(rows.map((r) => r.job)).toEqual(['breaking', 'calendar', 'slideshow']);
  });

  it('does not double-log the legacy pipeline into job_runs', async () => {
    await runScheduledJob('pipeline', baseEnv() as never, PIPELINE_CRON);
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM job_runs WHERE job = 'pipeline'`
    ).first<{ n: number }>();
    // The pipeline keeps its own cron_runs bookkeeping.
    expect(row?.n).toBe(0);
  });
});

describe('/status report', () => {
  const baseEnv = () => ({ ...env, TIMEZONE: 'Asia/Tehran' });

  it('is reachable as /status', () => {
    expect(STATUS_COMMAND).toBe('/status');
  });

  it('renders every job even before anything has run', async () => {
    const report = await buildJobStatusReport(baseEnv() as never, { now: NOW });
    expect(report).toContain('وضعیت کارهای زمان‌بندی‌شده');
    expect(report).toContain('اخبار فوری');
    expect(report).toContain('تقویم اقتصادی');
    expect(report).toContain('اسلایدشو');
    expect(report).toContain('هنوز اجرا نشده است');
    // and the schedule itself, so the operator can check it against Cloudflare
    expect(report).toContain(BREAKING_CRON);
    expect(report).toContain(CALENDAR_CRON);
    expect(report).toContain(SLIDESHOW_CRON);
  });

  it('shows the last run, its status icon and its detail', async () => {
    await env.DB.prepare(
      `INSERT INTO job_runs (job, trigger, status, detail, finished_at, duration_ms)
       VALUES ('breaking', ?1, 'success', 'feeds=7/7 sent=1', ?2, 1234)`
    )
      .bind(BREAKING_CRON, new Date(NOW.getTime() - 3 * 60_000).toISOString())
      .run();

    const report = await buildJobStatusReport(baseEnv() as never, { now: NOW });
    expect(report).toContain('✅ اخبار فوری');
    // Technical figures stay in Latin digits on this operator screen, in
    // line with the cron expressions and counters printed next to them.
    expect(report).toContain('3 دقیقه پیش');
    expect(report).toContain('feeds=7/7 sent=1');
    expect(report).toContain('1.2s');
  });

  it('reports the legacy digest pipeline from its own cron_runs table', async () => {
    await env.DB.prepare(
      `INSERT INTO cron_runs (trigger_name, ran_at, status, finished_at, duration_ms,
                              messages_inserted, messages_published, failures)
       VALUES (?1, ?2, 'success', ?2, 4500, 12, 3, 0)`
    )
      .bind(PIPELINE_CRON, new Date(NOW.getTime() - 20 * 60_000).toISOString())
      .run();

    const report = await buildJobStatusReport(baseEnv() as never, { now: NOW });
    expect(report).toContain('✅ خلاصهٔ خبری');
    expect(report).toContain('20 دقیقه پیش');
    expect(report).toContain('دریافت=12 منتشرشده=3');
  });

  it('counts slides against UTC midnight, not the Tehran date', async () => {
    // 01:00 Tehran on the 8th is still 21:30 UTC on the 7th. A slide sent at
    // 22:00 UTC on the 7th must therefore be counted, and the old
    // `${tehranDate}T00:00:00Z` window would have missed it entirely.
    const earlyTehran = new Date('2026-10-07T21:40:00.000Z');
    await env.DB.prepare(
      `INSERT INTO slideshow_sent (item_key, title, link, sent_at) VALUES ('k1', 't', 'https://e.x/1', ?1)`
    )
      .bind('2026-10-07T22:00:00.000Z')
      .run();

    const report = await buildJobStatusReport(baseEnv() as never, { now: earlyTehran });
    expect(report).toContain('اسلایدهای ارسال‌شده (از نیمه‌شب UTC): 1');
  });

  it('flags a failed job', async () => {
    await env.DB.prepare(
      `INSERT INTO job_runs (job, trigger, status, detail, finished_at)
       VALUES ('calendar', ?1, 'failed', 'source_http_status_403', ?2)`
    )
      .bind(CALENDAR_CRON, NOW.toISOString())
      .run();
    const report = await buildJobStatusReport(baseEnv() as never, { now: NOW });
    expect(report).toContain('❌ تقویم اقتصادی');
    expect(report).toContain('source_http_status_403');
  });

  it('shows today\'s claims, alert count and LLM budget', async () => {
    await env.DB.prepare(
      `INSERT INTO job_claims (job, claim_date, status, detail) VALUES ('calendar', ?1, 'sent', '2 events')`
    )
      .bind('2026-10-05')
      .run();
    await env.DB.prepare(
      `INSERT INTO breaking_alerts (story_key, title, score, category, local_date)
       VALUES ('k1', 't', 9, 'energy', '2026-10-05')`
    ).run();
    await env.DB.prepare(
      `INSERT INTO llm_usage (local_date, provider, calls, failures) VALUES ('2026-10-05', 'nvidia', 4, 1)`
    ).run();

    const report = await buildJobStatusReport(
      { ...baseEnv(), NVIDIA_API_KEY: 'nvapi-test' } as never,
      { now: NOW }
    );
    expect(report).toContain('calendar: sent');
    expect(report).toContain('هشدارهای امروز: 1/8');
    expect(report).toContain('nvidia');
    expect(report).toContain('4 فراخوانی، 1 خطا');
  });

  it('reports when no LLM provider is configured', async () => {
    const report = await buildJobStatusReport(baseEnv() as never, { now: NOW });
    expect(report).toContain('ارائه‌دهنده‌های فعال: هیچ‌کدام');
  });

  it('stays inside a single Telegram message', async () => {
    const report = await buildJobStatusReport(baseEnv() as never, { now: NOW });
    expect(report.length).toBeLessThanOrEqual(4096);
  });

  it('still renders when the database is unavailable', async () => {
    const brokenEnv = {
      ...baseEnv(),
      DB: {
        prepare() {
          throw new Error('no db');
        },
      },
    };
    const report = await buildJobStatusReport(brokenEnv as never, { now: NOW });
    expect(report).toContain('وضعیت کارهای زمان‌بندی‌شده');
    expect(report).toContain('خواندن تاریخچهٔ اجراها ممکن نشد');
  });
});

describe('relativeAge', () => {
  it('describes recent, hourly and daily ages', () => {
    expect(relativeAge(new Date(NOW.getTime() - 30_000).toISOString(), NOW)).toBe('30 ثانیه پیش');
    expect(relativeAge(new Date(NOW.getTime() - 3 * 60_000).toISOString(), NOW)).toBe('3 دقیقه پیش');
    expect(relativeAge(new Date(NOW.getTime() - 5 * 3_600_000).toISOString(), NOW)).toBe('5 ساعت پیش');
    expect(relativeAge(new Date(NOW.getTime() - 3 * 86_400_000).toISOString(), NOW)).toBe('3 روز پیش');
  });

  it('handles a never-run job and a malformed timestamp', () => {
    expect(relativeAge(null, NOW)).toBe('هرگز');
    expect(relativeAge('nonsense', NOW)).toBe('نامشخص');
  });

  it('treats a D1 timestamp without a zone marker as UTC', () => {
    // strftime('%Y-%m-%dT%H:%M:%fZ') writes a Z, but older rows may not.
    expect(relativeAge('2026-10-05T08:28:00.000', NOW)).toBe('2 دقیقه پیش');
  });
});

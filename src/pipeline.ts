/**
 * The single implementation of collect -> summarize -> publish.
 *
 * Both the hourly Cron Trigger and the Telegram "manual processing" button call
 * this function, so manual runs obey exactly the same rules: one-hour window,
 * deduplication, free-model-only, rotation, validation, rate-limit handling,
 * per-channel/per-message/stage isolation and cron bookkeeping.
 */

import { filterPendingMessages } from './adFilterStage';
import { collectAll } from './collector';
import { deriveCronStatus, finishCronRun, startCronRun, type CronStatus } from './cronRuns';
import { DEFAULT_IMAGE_RENDER_SPACING_MS } from './newsImage';
import { runImportanceRanking } from './newsRanking';
import { isCollectionOnly } from './processingMode';
import { collectRss } from './rssCollector';
import { resolveBaleDelivery, resolveDestination, runPublishing } from './publisher';
import { resolveAiApiKey } from './openrouter';
import { DEFAULT_AI_PACE_MS, runSummarization } from './summarizer';
import type { Env } from './types';

/**
 * Pipeline shape: collect → advertisement filter → summarize → publish.
 * The expected stage count is owned by deriveCronStatus(); a successful run
 * must reach it, which is asserted in the tests so the two cannot drift.
 *
 * Collection-only mode (processingMode.ts) shortens the shape to just
 * `collect`: nothing is filtered, summarized, ranked or published — the
 * system only fetches and stores raw news.
 */

export interface PipelineOutcome {
  trigger: string;
  runId: number;
  /** Canonical UTC ISO timestamp of this run; reports convert it to Tehran. */
  ranAt: string;
  status: CronStatus;
  stagesRun: number;
  itemFailures: number;
  /**
   * True when this run only collected news: filter/summarize/rank/publish are
   * null because they were intentionally skipped, not because they failed.
   */
  collectionOnly: boolean;
  /** Stage-level errors only; each is a short, secret-free message. */
  errors: string[];
  collection: { enabledChannels: number; succeeded: number; failed: number; inserted: number } | null;
  /** Advertisements blocked before any OpenRouter call. */
  filteredAdvertisements: number;
  filter: { checked: number; filtered: number; passed: number } | null;
  summarization: {
    eligible: number;
    summarized: number;
    failed: number;
    model: string | null;
    /** Safe failure categories and their counts, e.g. { invalid_response: 20 }. */
    failureCategories: Record<string, number>;
    /** Free models this run gave up on (rotation trace). */
    abandonedModels: string[];
  } | null;
  ranking: { candidates: number; ranked: number; important: number; error?: string } | null;
  publishing: {
    eligible: number;
    published: number;
    failed: number;
    /** Safe publish-failure categories and their counts (was invisible). */
    failureCategories: Record<string, number>;
    rateLimited: boolean;
    /** Present only when the Bale mirror is configured. */
    bale?: { sent: number; failed: number };
    /**
     * The run album (slideshow). Absent when nothing was publishable;
     * `sent: false` with a `reason` when it was attempted and did not reach
     * the channel — previously this outcome was invisible in every report.
     */
    image?: {
      sent: boolean;
      cards: number;
      ticker: number;
      reason?: string;
      detail?: string;
    };
  } | null;
  durationMs: number;
}

/** Reads a non-negative millisecond tuning value from the environment. */
function readMsEnv(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

export async function runNewsPipeline(
  db: D1Database,
  env: Env,
  opts: { trigger?: string; log?: boolean; modeOverride?: 'collect' | 'process' } = {}
): Promise<PipelineOutcome> {
  const trigger = opts.trigger ?? 'manual';
  const startedAt = Date.now();
  const errors: string[] = [];
  let stagesRun = 0;
  let runId = 0;

  // modeOverride lets a manual run force a specific mode for that run only;
  // otherwise the persisted admin setting decides.
  const collectionOnly = opts.modeOverride
    ? opts.modeOverride === 'collect'
    : await isCollectionOnly(db).catch(() => false);

  try {
    runId = await startCronRun(db, trigger);
  } catch (e) {
    errors.push(`cron-start: ${message(e)}`);
  }

  const stage = async <T>(name: string, run: () => Promise<T>): Promise<T | null> => {
    try {
      const result = await run();
      stagesRun++;
      return result;
    } catch (e) {
      errors.push(`${name}: ${message(e)}`);
      return null;
    }
  };

  const collection = await stage('collect', async () => {
    const telegram = await collectAll(db);
    const rss = await collectRss(db);
    return {
      ...telegram,
      enabledChannels: telegram.enabledChannels + rss.sources,
      succeeded: telegram.succeeded + rss.succeeded,
      failed: telegram.failed + rss.failed,
      inserted: telegram.inserted + rss.inserted,
    };
  });

  // Collection-only mode: stop here. No filtering, summarization, ranking or
  // publishing — the run just stores raw news. All four stages stay null and
  // the status is derived against a single expected stage, so the run records
  // "success" instead of a fake "partial".
  let filter: { checked: number; filtered: number; passed: number } | null = null;
  let summarization: Awaited<ReturnType<typeof runSummarization>> | null = null;
  let ranking: Awaited<ReturnType<typeof runImportanceRanking>> | null = null;
  let publishing: Awaited<ReturnType<typeof runPublishing>> | null = null;

  if (!collectionOnly) {
    // Free-tier pacing, so one run stays under OpenRouter's account-wide
    // ~20 requests/minute cap (AI_REQUEST_PACE_MS, default 3.2s).
    const paceMs = readMsEnv(env.AI_REQUEST_PACE_MS, DEFAULT_AI_PACE_MS, 60_000);
    // Spacing between two album card renders, so the run stays under the
    // Browser Run free-tier ~1 Quick Action / 10s limit
    // (IMAGE_RENDER_SPACING_MS, default 10.5s).
    const renderSpacingMs = readMsEnv(
      env.IMAGE_RENDER_SPACING_MS,
      DEFAULT_IMAGE_RENDER_SPACING_MS,
      120_000
    );

    // Local, offline filter. Runs before any OpenRouter request is made.
    filter = await stage('filter', () => filterPendingMessages(db));
    summarization = await stage('summarize', () =>
      runSummarization(db, { apiKey: resolveAiApiKey(env), paceMs })
    );
    // Global importance ranking across every channel, once per run. Never throws:
    // a failure leaves importance untouched and publishing continues.
    ranking = await stage('rank', () =>
      runImportanceRanking(db, { apiKey: resolveAiApiKey(env) })
    );
    publishing = await stage('publish', () =>
      runPublishing(db, {
        token: env.TELEGRAM_BOT_TOKEN,
        destination: resolveDestination(env) ?? undefined,
        // Optional: skips the run album when the binding is not configured.
        browser: env.BROWSER,
        renderSpacingMs,
        // Optional best-effort Bale mirror of the Telegram output.
        bale: resolveBaleDelivery(env) ?? undefined,
      })
    );
  }

  const itemFailures =
    (collection?.failed ?? 0) +
    (summarization?.failed.length ?? 0) +
    (publishing?.failures.length ?? 0);
  const status = deriveCronStatus(stagesRun, errors.length, itemFailures, collectionOnly ? 1 : undefined);

  const outcome: PipelineOutcome = {
    trigger,
    runId,
    ranAt: new Date(startedAt).toISOString(),
    status,
    stagesRun,
    itemFailures,
    collectionOnly,
    errors,
    collection: collection && {
      enabledChannels: collection.enabledChannels,
      succeeded: collection.succeeded,
      failed: collection.failed,
      inserted: collection.inserted,
    },
    filteredAdvertisements: filter?.filtered ?? 0,
    filter: filter && { checked: filter.checked, filtered: filter.filtered, passed: filter.passed },
    summarization: summarization && {
      eligible: summarization.eligible,
      summarized: summarization.summarized,
      failed: summarization.failed.length,
      model: summarization.model,
      failureCategories: summarization.failureCategories,
      abandonedModels: summarization.abandonedModels,
    },
    ranking: ranking && {
      candidates: ranking.candidates,
      ranked: ranking.ranked,
      important: ranking.important,
      error: ranking.error,
    },
    publishing: publishing && {
      eligible: publishing.eligible,
      published: publishing.published,
      failed: publishing.failures.length,
      failureCategories: countFailureCategories(publishing.failures.map((f) => f.category)),
      rateLimited: publishing.rateLimited,
      bale: publishing.bale,
      image: describeImage(publishing, env),
    },
    durationMs: Date.now() - startedAt,
  };

  if (opts.log !== false) {
    const level = status === 'failed' ? 'error' : 'log';
    console[level](
      JSON.stringify({
        event: 'cron',
        cron: trigger,
        runId,
        status,
        stagesRun,
        collectionOnly,
        collection: outcome.collection,
        filteredAdvertisements: outcome.filteredAdvertisements,
        summarization: outcome.summarization,
        ranking: outcome.ranking,
        publishing: outcome.publishing,
        errors: errors.length > 0 ? errors : undefined,
        durationMs: outcome.durationMs,
        timestamp: new Date().toISOString(),
      })
    );
  }

  if (runId > 0) {
    try {
      await finishCronRun(db, runId, status, startedAt, {
        channelsEnabled: outcome.collection?.enabledChannels ?? 0,
        messagesInserted: outcome.collection?.inserted ?? 0,
        messagesFiltered: outcome.filteredAdvertisements,
        messagesSummarized: outcome.summarization?.summarized ?? 0,
        messagesPublished: outcome.publishing?.published ?? 0,
        failures: itemFailures,
        errorSummary: errors.length > 0 ? errors.slice(0, 5).join(' | ') : null,
      });
    } catch (e) {
      console.error(
        JSON.stringify({
          event: 'cron',
          stage: 'cron-run-finish',
          status: 'error',
          error: message(e),
          timestamp: new Date().toISOString(),
        })
      );
    }
  }

  return outcome;
}

/**
 * Flattens the publisher's album outcome into a report-friendly shape, and
 * explains the two silent cases: no Browser Run binding configured, and a
 * render/send failure. Returns undefined when no album was expected at all.
 */
function describeImage(
  publishing: {
    eligible: number;
    image?: {
      sent: boolean;
      selected: number;
      ticker: number;
      error?: string;
      detail?: string;
    };
  },
  env: Env
): { sent: boolean; cards: number; ticker: number; reason?: string; detail?: string } | undefined {
  if (publishing.image) {
    const { sent, selected, ticker, error, detail } = publishing.image;
    return {
      sent,
      cards: selected,
      ticker,
      ...(error ? { reason: error, ...(detail ? { detail } : {}) } : {}),
    };
  }
  if (publishing.eligible > 0) {
    return {
      sent: false,
      cards: 0,
      ticker: 0,
      reason: env.BROWSER ? 'no_suitable_items' : 'browser_binding_missing',
    };
  }
  return undefined;
}

/** Aggregates per-item failure categories, so reports can say WHY items failed. */
function countFailureCategories(categories: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const category of categories) {
    counts[category] = (counts[category] ?? 0) + 1;
  }
  return counts;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

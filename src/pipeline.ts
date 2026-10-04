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
import { runImportanceRanking } from './newsRanking';
import { collectRss } from './rssCollector';
import { resolveBaleDelivery, resolveDestination, runPublishing } from './publisher';
import { resolveAiApiKey } from './openrouter';
import { runSummarization } from './summarizer';
import type { Env } from './types';

/**
 * Pipeline shape: collect → advertisement filter → summarize → publish.
 * The expected stage count is owned by deriveCronStatus(); a successful run
 * must reach it, which is asserted in the tests so the two cannot drift.
 */

export interface PipelineOutcome {
  trigger: string;
  runId: number;
  /** Canonical UTC ISO timestamp of this run; reports convert it to Tehran. */
  ranAt: string;
  status: CronStatus;
  stagesRun: number;
  itemFailures: number;
  /** Stage-level errors only; each is a short, secret-free message. */
  errors: string[];
  collection: { enabledChannels: number; succeeded: number; failed: number; inserted: number } | null;
  /** Advertisements blocked before any OpenRouter call. */
  filteredAdvertisements: number;
  filter: { checked: number; filtered: number; passed: number } | null;
  summarization: { eligible: number; summarized: number; failed: number; model: string | null } | null;
  ranking: { candidates: number; ranked: number; important: number; error?: string } | null;
  publishing: {
    eligible: number;
    published: number;
    failed: number;
    rateLimited: boolean;
    /** Present only when the Bale mirror is configured. */
    bale?: { sent: number; failed: number };
  } | null;
  durationMs: number;
}

export async function runNewsPipeline(
  db: D1Database,
  env: Env,
  opts: { trigger?: string; log?: boolean } = {}
): Promise<PipelineOutcome> {
  const trigger = opts.trigger ?? 'manual';
  const startedAt = Date.now();
  const errors: string[] = [];
  let stagesRun = 0;
  let runId = 0;

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
  // Local, offline filter. Runs before any OpenRouter request is made.
  const filter = await stage('filter', () => filterPendingMessages(db));
  const summarization = await stage('summarize', () =>
    runSummarization(db, { apiKey: resolveAiApiKey(env) })
  );
  // Global importance ranking across every channel, once per run. Never throws:
  // a failure leaves importance untouched and publishing continues.
  const ranking = await stage('rank', () =>
    runImportanceRanking(db, { apiKey: resolveAiApiKey(env) })
  );
  const publishing = await stage('publish', () =>
    runPublishing(db, {
      token: env.TELEGRAM_BOT_TOKEN,
      destination: resolveDestination(env) ?? undefined,
      // Optional: skips the single run image when the binding is not configured.
      browser: env.BROWSER,
      // Optional best-effort Bale mirror of the Telegram output.
      bale: resolveBaleDelivery(env) ?? undefined,
    })
  );

  const itemFailures =
    (collection?.failed ?? 0) +
    (summarization?.failed.length ?? 0) +
    (publishing?.failures.length ?? 0);
  const status = deriveCronStatus(stagesRun, errors.length, itemFailures);

  const outcome: PipelineOutcome = {
    trigger,
    runId,
    ranAt: new Date(startedAt).toISOString(),
    status,
    stagesRun,
    itemFailures,
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
      rateLimited: publishing.rateLimited,
      bale: publishing.bale,
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

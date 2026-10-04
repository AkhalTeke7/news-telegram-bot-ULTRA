/**
 * Summarizes collected messages with a FREE OpenRouter model.
 *
 * Safety properties:
 *  - a message is only marked summarized after its summary is persisted
 *  - one bad message never stops the run
 *  - one bad model rotates to another free model (or aborts safely) without
 *    ever falling back to a paid model
 */

import { AiError, categorize, summarizeNews } from './openrouter';
import { stripExternalIdentifiers } from './adFilter';
import { recordModelFailure, resolveFreeModel } from './modelManager';
import { DEFAULT_WINDOW_MS } from './collector';

export const MAX_MESSAGES_PER_RUN = 20;
/**
 * Consecutive soft failures (bad JSON, timeout, network) tolerated from one
 * free model before the run rotates to another one.
 */
export const MAX_MODEL_FAILURES = 2;

/**
 * Minimum spacing between two OpenRouter chat requests, so one run stays
 * under the free tier's account-wide ~20 requests/minute cap. Applied by the
 * pipeline (configurable via AI_REQUEST_PACE_MS); 0 disables it.
 */
export const DEFAULT_AI_PACE_MS = 3200;
/**
 * Longest single wait for an account-wide per-minute reset before retrying
 * the same message on the same model.
 */
export const MAX_RATE_LIMIT_WAIT_MS = 30_000;
/** Total attempts per message when the account-wide minute limit hits. */
export const RATE_LIMIT_ATTEMPTS = 2;
/** Total per-run budget for waiting on per-minute resets. */
export const MAX_RUN_RATE_WAIT_MS = 90_000;

export const sleepMs = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export interface EligibleMessage {
  id: number;
  channelId: number;
  channelUsername: string;
  telegramMessageId: number;
  messageText: string;
  messageDate: string;
  sourceUrl: string;
}

export interface SummarizeRunOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  now?: number;
  windowMs?: number;
  limit?: number;
  /**
   * Minimum milliseconds between two AI requests (free-tier pacing).
   * Default 0 = no pacing; the pipeline passes the production value.
   */
  paceMs?: number;
  /** Injectable wait, so tests never sleep for real. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface MessageFailure {
  messageId: number;
  category: string;
}

export interface SummarizeReport {
  eligible: number;
  summarized: number;
  failed: MessageFailure[];
  /** Failure counts per safe category, so a run report can say WHY it failed. */
  failureCategories: Record<string, number>;
  /** Free model ids this run gave up on, in order. */
  abandonedModels: string[];
  /** Items the model judged advertisement or not news. */
  rejected: number;
  /** Summarized rows that received a real AI headline. */
  withTitle: number;
  model: string | null;
  modelRotations: number;
  truncated: boolean;
}

export async function selectEligibleMessages(
  db: D1Database,
  opts: { now?: number; windowMs?: number; limit?: number } = {}
): Promise<EligibleMessage[]> {
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const limit = opts.limit ?? MAX_MESSAGES_PER_RUN;

  const { results } = await db
    .prepare(
      `SELECT m.id, m.source_channel_id, c.channel_username, m.telegram_message_id,
              m.message_text, m.message_date, m.source_url
         FROM messages m
         JOIN channels c ON c.id = m.source_channel_id
        WHERE c.enabled = 1
          AND m.filter_status <> 'filtered'
          AND m.summarized_at IS NULL
          AND TRIM(m.message_text) <> ''
          AND m.message_date >= ?1
        ORDER BY m.message_date ASC
        LIMIT ?2`
    )
    .bind(new Date(now - windowMs).toISOString(), limit)
    .all<{
      id: number;
      source_channel_id: number;
      channel_username: string;
      telegram_message_id: number;
      message_text: string;
      message_date: string;
      source_url: string;
    }>();

  return (results ?? []).map((r) => ({
    id: r.id,
    channelId: r.source_channel_id,
    channelUsername: r.channel_username,
    telegramMessageId: r.telegram_message_id,
    messageText: r.message_text,
    messageDate: r.message_date,
    sourceUrl: r.source_url,
  }));
}

/**
 * Deterministic validation for an AI-generated headline.
 *
 * The prompt already forbids these, but the prompt is not a guarantee, so every
 * title is checked again before it is stored. Reuses the project's existing
 * external-identifier cleaner instead of duplicating that logic.
 *
 * Returns the cleaned title, or null when it must not be used. A null title is
 * safe: the column is nullable, the digest falls back to the summary alone and
 * the image falls back to a derived headline, so the news is still published.
 */
/** Matches the headline length contract in the AI prompt (~90 chars). */
export const MAX_TITLE_CHARS = 90;

export function validateAiTitle(rawTitle: string | null | undefined): string | null {
  if (typeof rawTitle !== 'string') return null;
  const title = rawTitle.replace(/\s+/g, ' ').trim();
  if (!title) return null;
  if (title.length > MAX_TITLE_CHARS) return null;

  // Must actually be Persian text, not a stray symbol or latin fragment.
  if (!/[\u0600-\u06FF]/.test(title)) return null;

  // Control characters and markdown must never reach a plain-text message.
  if (/[\u0000-\u001F\u007F*#`_\[\]<>|]/.test(title)) return null;

  // URLs, domains, handles and the known chat hosts.
  if (/https?:\/\//i.test(title) || /\bwww\./i.test(title) || /@[\w]+/.test(title)) return null;
  if (/\b(?:t\.me|telegram\.me|telegram\.dog|eitaa|instagram|twitter|wa\.me|bit\.ly)\b/i.test(title)) {
    return null;
  }
  if (/\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|ir|io|me|co|xyz|app|dev|ru|ru|info)\b/i.test(title)) {
    return null;
  }

  // Publication metadata and technical identifiers.
  if (title.includes('منبع:') || title.includes('منابع:')) return null;
  if (/\b(?:message_id|chat_id|source_url|rss|api|webhook|id)\b/i.test(title)) return null;
  // Long digit runs are ids, phone numbers or counters rather than headlines.
  if (/\d{5,}/.test(title)) return null;

  // Final gate: the shared cleaner must not find anything left to remove.
  if (stripExternalIdentifiers(title) !== title) return null;

  return title;
}

/**
 * Marks a message summarized only when a valid summary exists.
 * The `summarized_at IS NULL` guard keeps this idempotent under retries.
 */
export async function markSummarized(
  db: D1Database,
  messageId: number,
  summary: string,
  model: string,
  title?: string | null,
  metadata: { highlights: string[]; confidence: number; category: string } = { highlights: [], confidence: 0.5, category: 'general' }
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE messages
          SET summary_text = ?1,
              summary_model = ?2,
              title = ?4,
              highlights_json = ?5,
              confidence = ?6,
              category = ?7,
              ai_processed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
              summarized_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?3 AND summarized_at IS NULL`
    )
    .bind(summary, model, messageId, title && title.trim() ? title.trim() : null, JSON.stringify(metadata.highlights.slice(0, 3)), metadata.confidence, metadata.category)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

/**
 * Semantic rejection by the model: an advertisement or non-news item is parked in
 * the existing `filtered` state, so it is excluded from every digest and from
 * global ranking without needing a new status value.
 */
export async function markRejectedByAi(
  db: D1Database,
  messageId: number,
  reason: 'ai_advertisement' | 'ai_not_news'
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE messages
          SET filter_status = 'filtered',
              filter_reason = ?1,
              filtered_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?2 AND filter_status <> 'filtered'`
    )
    .bind(reason, messageId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

export async function runSummarization(
  db: D1Database,
  opts: SummarizeRunOptions = {}
): Promise<SummarizeReport> {
  const now = opts.now ?? Date.now();
  const messages = await selectEligibleMessages(db, opts);

  const report: SummarizeReport = {
    eligible: messages.length,
    summarized: 0,
    failed: [],
    failureCategories: {},
    abandonedModels: [],
    rejected: 0,
    withTitle: 0,
    model: null,
    modelRotations: 0,
    truncated: messages.length >= (opts.limit ?? MAX_MESSAGES_PER_RUN),
  };

  /** Records one item failure and keeps the per-category counters in sync. */
  const fail = (messageId: number, category: string): void => {
    report.failed.push({ messageId, category });
    report.failureCategories[category] = (report.failureCategories[category] ?? 0) + 1;
  };

  if (messages.length === 0) return report;

  if (!opts.apiKey) {
    log({ operation: 'summarize', status: 'skipped', category: 'config_missing', count: messages.length });
    for (const m of messages) fail(m.id, 'config_missing');
    return report;
  }

  const apiKey = opts.apiKey;
  const excluded: string[] = [];
  /** Consecutive soft failures of the model currently in use. */
  let consecutiveFailures = 0;
  let model = (
    await resolveFreeModel(db, {
      fetchImpl: opts.fetchImpl,
      baseUrl: opts.baseUrl,
      now,
      exclude: excluded,
    })
  ).model;

  if (!model) {
    log({ operation: 'summarize', status: 'skipped', category: 'no_free_model', count: messages.length });
    for (const m of messages) fail(m.id, 'no_free_model');
    return report;
  }
  report.model = model;

  const paceMs = opts.paceMs ?? 0;
  const sleepImpl = opts.sleepImpl ?? sleepMs;
  let lastRequestAt = 0;
  /** Keeps one run under the free tier's account-wide requests/minute cap. */
  const pace = async (): Promise<void> => {
    if (paceMs <= 0 || lastRequestAt === 0) return;
    const wait = paceMs - (Date.now() - lastRequestAt);
    if (wait > 0) await sleepImpl(wait);
  };
  let rateWaitBudget = MAX_RUN_RATE_WAIT_MS;

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const currentModel = model!;

    // External links/identifiers are removed BEFORE the model is called, so
    // promotional URLs and other channels can never influence (or appear in)
    // the summary. The source channel's own identity is the only one allowed.
    const newsBody = stripExternalIdentifiers(message.messageText, message.channelUsername);
    if (newsBody.length === 0) {
      fail(message.id, 'empty_after_filter');
      continue;
    }

    // Set when an ACCOUNT-wide free-tier limit was hit: every remaining
    // message fails with the same category and the run stops making requests.
    // Rotating models cannot help there — the cap is shared by all free
    // models, and burning the catalog was exactly the old failure mode.
    let runAbort: 'rate_limited_minute' | 'rate_limited_daily' | null = null;

    for (let attempt = 1; attempt <= RATE_LIMIT_ATTEMPTS; attempt++) {
      await pace();
      try {
        const { title, summary, isNews, isAdvertisement, highlights, confidence, category, model: usedModel } = await summarizeNews({
          apiKey,
          model: currentModel,
          text: newsBody,
          channelUsername: message.channelUsername,
          messageDate: message.messageDate,
          fetchImpl: opts.fetchImpl,
          baseUrl: opts.baseUrl,
        });
        lastRequestAt = Date.now();

        // Second gate after the deterministic filter: the model's own semantic
        // verdict. Rejected items are parked as filtered, so they never reach a
        // digest or the global ranking.
        if (isAdvertisement || !isNews) {
          await markRejectedByAi(db, message.id, isAdvertisement ? 'ai_advertisement' : 'ai_not_news');
          report.rejected++;
          consecutiveFailures = 0;
          log({
            operation: 'summarize',
            status: 'rejected',
            model: usedModel,
            messageId: message.id,
            telegramMessageId: message.telegramMessageId,
            channelId: message.channelId,
            reason: isAdvertisement ? 'ai_advertisement' : 'ai_not_news',
          });
          break;
        }

        // Deterministic title gate. An invalid headline is simply not stored; the
        // news still publishes from its summary.
        const safeTitle = validateAiTitle(title);
        const persisted = await markSummarized(db, message.id, summary, usedModel, safeTitle, { highlights, confidence, category });
        if (!persisted) {
          // Already summarized by a concurrent run; nothing to do.
          break;
        }
        report.summarized++;
        report.withTitle += safeTitle ? 1 : 0;
        consecutiveFailures = 0;
        log({
          operation: 'summarize',
          status: 'ok',
          model: usedModel,
          messageId: message.id,
          telegramMessageId: message.telegramMessageId,
          channelId: message.channelId,
          hasTitle: !!safeTitle,
          titleRejected: !safeTitle && !!title,
        });
        break;
      } catch (error) {
        lastRequestAt = Date.now();
        const category = categorize(error);

        // Account-wide per-minute limit: wait for the reset, then retry the
        // SAME model and message. Rotation is deliberately skipped.
        if (category === 'rate_limited_minute') {
          const retryAfter = error instanceof AiError ? error.retryAfterMs : undefined;
          const wait = Math.min(retryAfter ?? 20_000, MAX_RATE_LIMIT_WAIT_MS, rateWaitBudget);
          if (attempt < RATE_LIMIT_ATTEMPTS && wait > 0) {
            rateWaitBudget -= wait;
            log({
              operation: 'summarize',
              status: 'rate_wait',
              category,
              model: currentModel,
              messageId: message.id,
              waitMs: wait,
            });
            await sleepImpl(wait);
            continue;
          }
          fail(message.id, category);
          log({
            operation: 'summarize',
            status: 'error',
            category,
            model: currentModel,
            messageId: message.id,
            telegramMessageId: message.telegramMessageId,
            channelId: message.channelId,
            detail: error instanceof AiError ? error.message : 'unexpected error',
          });
          runAbort = category;
          break;
        }

        // Account-wide daily limit: no free model will answer until the next
        // UTC day. Stop the run; the next runs pick up whatever is left.
        if (category === 'rate_limited_daily') {
          fail(message.id, category);
          log({
            operation: 'summarize',
            status: 'aborted',
            category,
            model: currentModel,
            messageId: message.id,
            telegramMessageId: message.telegramMessageId,
            channelId: message.channelId,
          });
          runAbort = category;
          break;
        }

        fail(message.id, category);
        log({
          operation: 'summarize',
          status: 'error',
          category,
          model: currentModel,
          messageId: message.id,
          telegramMessageId: message.telegramMessageId,
          channelId: message.channelId,
          detail: error instanceof AiError ? error.message : 'unexpected error',
        });

        // Rotate away from a failing model, but only among proven-free models.
        //
        // A model is abandoned immediately when the provider itself rejects the
        // call (rate limit / HTTP error), and after MAX_MODEL_FAILURES
        // consecutive soft failures (unparsable answer, timeout, network blip).
        // The soft case is what used to burn a whole run: a free endpoint that
        // answers 200 with prose instead of JSON produced 20 identical
        // `invalid_response` errors and never rotated.
        consecutiveFailures++;
        const hardFailure = category === 'rate_limited' || category === 'provider_error';
        if (hardFailure || consecutiveFailures >= MAX_MODEL_FAILURES) {
          await recordModelFailure(db, currentModel, category, now);
          excluded.push(currentModel);
          report.abandonedModels.push(currentModel);
          report.modelRotations++;
          consecutiveFailures = 0;

          const next = (
            await resolveFreeModel(db, {
              fetchImpl: opts.fetchImpl,
              baseUrl: opts.baseUrl,
              now,
              // The list is only re-queried for provider-side failures; a model
              // that merely answers badly does not mean the catalog is stale.
              forceRefresh: hardFailure,
              exclude: excluded,
              // The admin pin must not be re-selected after it just failed.
              ignorePin: true,
            })
          ).model;

          if (!next) {
            log({ operation: 'summarize', status: 'aborted', category: 'no_free_model' });
            for (const rest of messages.slice(index + 1)) {
              fail(rest.id, 'no_free_model');
            }
            report.model = currentModel;
            return report;
          }
          model = next;
          report.model = next;
          log({ operation: 'model-rotate', status: 'ok', model: next, previous: currentModel });
        }
        break;
      }
    }

    if (runAbort) {
      for (const rest of messages.slice(index + 1)) {
        fail(rest.id, runAbort);
      }
      return report;
    }
  }

  return report;
}

function log(entry: Record<string, unknown>): void {
  console.log(
    JSON.stringify({ event: 'ai', timestamp: new Date().toISOString(), ...entry })
  );
}

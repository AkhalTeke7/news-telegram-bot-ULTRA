/**
 * Phase 4: publishes summarized news to the configured Telegram destination.
 *
 * Guarantees:
 *  - only messages with a real summary, a valid source link and an enabled
 *    source channel are published
 *  - a message is marked published only after Telegram confirms delivery, using
 *    an atomic guarded UPDATE so a repeat run cannot double-publish
 *  - news digests use Telegram HTML formatting; every AI/source value is escaped
 *    before it is inserted, so untrusted content can never break the markup
 *  - rate limits stop the pass instead of hammering; leftovers retry next hour
 */

import { listChannels } from './channels';
import { baleSendMessage, baleSendPhoto } from './bale';
import { renderRunImage, type BrowserBinding } from './newsImage';
import {
  isValidDestinationChat,
  sendMessage,
  sendPhoto,
  TelegramError,
  TelegramRateLimitError,
  type DestinationChat,
} from './telegram';
import type { Env } from './types';
import { topicPresentation } from './topic';

/**
 * Telegram/API safety bound — NOT a product limit.
 *
 * Workers Free allows 50 subrequests per invocation (see Cloudflare "Limits"), and
 * one hourly invocation spends some of them before publishing even starts:
 * one fetch per enabled source channel for collection, up to
 * `MAX_MESSAGES_PER_RUN` (20) for summarization, and occasionally one for the
 * model list. This module therefore spends whatever is left, rather than a flat
 * number that could push the invocation past the platform limit and get it
 * terminated mid-publish.
 */
export const SUBREQUEST_LIMIT_FREE = 50;
/** Matches the summarizer's own per-run message cap. */
export const SUMMARIZE_RESERVE = 20;
export const MODEL_LIST_RESERVE = 1;
/**
 * The single run image costs two subrequests: one Browser Run render plus one
 * `sendPhoto`. Reserving them here keeps the whole invocation inside the
 * platform limit instead of overrunning it at the end of the run.
 */
export const IMAGE_RESERVE = 2;
/** Absolute ceiling, never exceeded regardless of the budget. */
export const MAX_MESSAGES_PER_RUN = 40;

/**
 * Messages this run may send: the platform budget minus what the earlier stages
 * and the run image need, clamped to [1, MAX_MESSAGES_PER_RUN]. Deterministic
 * for a given enabled-channel count. Anything left over is recorded with the
 * explicit `run_limit` category and stays unpublished, so the next run continues
 * with it in the same configured order — nothing is silently dropped.
 */
export function publishMessageBudget(enabledChannelCount: number): number {
  const available =
    SUBREQUEST_LIMIT_FREE -
    enabledChannelCount -
    SUMMARIZE_RESERVE -
    MODEL_LIST_RESERVE -
    IMAGE_RESERVE;
  return Math.min(MAX_MESSAGES_PER_RUN, Math.max(1, available));
}

const TELEGRAM_TEXT_LIMIT = 4096;
/** Kept below Telegram's limit so HTML tags and topic details always fit. */
const MAX_SUMMARY_CHARS = 1050;
/** AI headlines are short by contract; this only guards the 4096 limit. */
const MAX_TITLE_CHARS = 180;
const MAX_HIGHLIGHT_CHARS = 120;
const MAX_HIGHLIGHTS = 3;

/** Telegram HTML escaping for AI and RSS text. */
export function escapeTelegramHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Only original public-channel post links are ever published. */
const SOURCE_URL_RE = /^https:\/\/t\.me\/[A-Za-z][A-Za-z0-9_]{4,31}\/\d{1,20}$/;

/** Source kind of a channel row, mirroring `channels.source_type`. */
export type SourceType = 'telegram' | 'rss';

/**
 * RSS article link: a well-formed absolute https URL with a real hostname.
 * RSS rows store the article URL (bbc.com, zoomit.ir, …), never a t.me link —
 * without this rule every RSS summary failed publishing forever as
 * `invalid_source_url`, which also emptied the run image and the Bale mirror.
 */
export function isValidArticleUrl(raw: string): boolean {
  if (!raw || raw.length > 2048) return false;
  if (/[\s\u0000-\u001F\u007F]/.test(raw)) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.hostname.includes('.');
}

/** Per-source-type gate deciding whether a stored source link is publishable. */
export function isUsableSourceUrl(item: { sourceUrl: string; sourceType: SourceType }): boolean {
  return item.sourceType === 'rss'
    ? isValidArticleUrl(item.sourceUrl)
    : SOURCE_URL_RE.test(item.sourceUrl);
}

export interface PublishableMessage {
  id: number;
  channelId: number;
  channelUsername: string;
  /** Used only as a display fallback when a username is missing. */
  channelTitle: string | null;
  /** 'telegram' for public channels, 'rss' for feed-backed channels. */
  sourceType: SourceType;
  telegramMessageId: number;
  summaryText: string;
  /** AI headline. NULL for rows summarized before migration 0008. */
  title: string | null;
  /** AI global importance 1-5. NULL until the ranking stage has run. */
  importance: number | null;
  /** AI editorial topic used for the digest emoji and image accent. */
  category?: string | null;
  /** Optional AI key points, stored as JSON and treated as display data only. */
  highlights?: string[];
  messageDate: string;
  sourceUrl: string;
}

export type PublishErrorCategory =
  | 'invalid_source_url'
  | 'rate_limited'
  | 'telegram_error'
  | 'network'
  | 'run_limit';

export interface PublishFailure {
  messageId: number;
  category: PublishErrorCategory;
  retryAfterSeconds?: number;
}

export interface PublishReport {
  eligible: number;
  published: number;
  failures: PublishFailure[];
  rateLimited: boolean;
  destination: string | null;
  /** Absent when no image was attempted. */
  image?: ImagePublishOutcome;
  /** Bale mirror counters; absent when Bale delivery is not configured. */
  bale?: { sent: number; failed: number };
}

export interface PublishOptions {
  token?: string;
  destination?: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /**
   * Browser Run binding. When absent, the run image is skipped entirely and the
   * per-channel text digests behave exactly as before.
   */
  browser?: BrowserBinding;
  now?: Date;
  /**
   * Optional Bale mirror (BALE_BOT_TOKEN + BALE_DESTINATION_CHANNEL). Every
   * delivered Telegram message — the run image and each text digest part — is
   * also sent to Bale. Best effort: a Bale failure is logged and counted but
   * never affects Telegram delivery or publish state.
   */
  bale?: BaleDeliveryOptions;
}

/** Outcome of the single optional run image. */
export interface ImagePublishOutcome {
  /** Items shown in the image (at most four, across all channels). */
  selected: number;
  /** Distinct source channels represented in the image. */
  channels: number;
  sent: boolean;
  bytes: number;
  width: number;
  height: number;
  browserRunMs: number;
  /** Set when rendering or sending failed; text publishing is unaffected. */
  error?: string;
}

/**
 * Reads the destination from the server-side environment only. It is never
 * exposed through the API, the frontend, or the database.
 */
export function resolveDestination(env: Env): DestinationChat | null {
  const raw = env.TELEGRAM_DESTINATION_CHANNEL?.trim();
  return raw && isValidDestinationChat(raw) ? (raw as DestinationChat) : null;
}

/** Bale destination: @username or a numeric chat/channel id. */
export function isValidBaleDestination(value: string): boolean {
  return /^@[A-Za-z][A-Za-z0-9_]{2,31}$/.test(value) || /^-?\d{1,20}$/.test(value);
}

/** Credentials for the best-effort Bale mirror of the Telegram output. */
export interface BaleDeliveryOptions {
  token: string;
  destination: string;
}

/**
 * Reads the Bale mirror configuration from the server-side environment only.
 * Returns null when Bale is not configured (either secret missing) or the
 * destination is malformed — in both cases publishing stays Telegram-only.
 */
export function resolveBaleDelivery(env: Env): BaleDeliveryOptions | null {
  const token = env.BALE_BOT_TOKEN?.trim();
  const destination = env.BALE_DESTINATION_CHANNEL?.trim();
  if (!token || !destination) return null;
  if (!isValidBaleDestination(destination)) {
    console.error(
      JSON.stringify({
        event: 'publish',
        operation: 'bale',
        status: 'skipped',
        category: 'bale_destination_invalid',
        timestamp: new Date().toISOString(),
      })
    );
    return null;
  }
  return { token, destination };
}

/**
 * Reads every publishable row, newest-run backlog included.
 *
 * Deliberately uncapped: a per-channel or global row cap would silently
 * postpone valid news from the current window to a later hour. Ordering is by
 * configured channel order, then chronological inside each channel.
 */
export async function selectPublishableMessages(db: D1Database): Promise<PublishableMessage[]> {
  const { results } = await db
    .prepare(
      `SELECT m.id, m.source_channel_id, c.channel_username, c.channel_title, c.source_type, m.telegram_message_id,
              m.summary_text, m.title, m.importance, m.category, m.highlights_json, m.message_date, m.source_url
         FROM messages m
         JOIN channels c ON c.id = m.source_channel_id
        WHERE c.enabled = 1
          AND m.filter_status <> 'filtered'
          AND m.summarized_at IS NOT NULL
          AND m.published_at IS NULL
          AND TRIM(COALESCE(m.summary_text, '')) <> ''
          AND TRIM(COALESCE(m.source_url, '')) <> ''
        ORDER BY m.source_channel_id ASC, m.message_date ASC, m.id ASC`
    )
    .all<{
      id: number;
      source_channel_id: number;
      channel_username: string;
      channel_title: string | null;
      source_type: string | null;
      telegram_message_id: number;
      summary_text: string;
      title: string | null;
      importance: number | null;
      category: string | null;
      highlights_json: string | null;
      message_date: string;
      source_url: string;
    }>();

  return (results ?? []).map((r) => ({
    id: r.id,
    channelId: r.source_channel_id,
    channelUsername: r.channel_username,
    channelTitle: r.channel_title ?? null,
    sourceType: (r.source_type === 'rss' ? 'rss' : 'telegram') as SourceType,
    telegramMessageId: r.telegram_message_id,
    summaryText: r.summary_text,
    title: r.title ?? null,
    importance: r.importance ?? null,
    category: r.category ?? null,
    highlights: parseHighlights(r.highlights_json),
    messageDate: r.message_date,
    sourceUrl: r.source_url,
  }));
}

/** Parses AI key points defensively; malformed legacy data is simply omitted. */
function parseHighlights(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, MAX_HIGHLIGHTS);
  } catch {
    return [];
  }
}

/** One source channel and its publishable news, oldest first. */
export interface ChannelGroup {
  channelId: number;
  channelUsername: string;
  channelTitle: string | null;
  sourceType: SourceType;
  items: PublishableMessage[];
}

/**
 * Groups rows by source channel, preserving the configured channel order
 * (channel id order) and chronological order inside each group.
 */
export function groupByChannel(items: PublishableMessage[]): ChannelGroup[] {
  const groups = new Map<number, ChannelGroup>();
  for (const item of items) {
    const existing = groups.get(item.channelId);
    if (existing) existing.items.push(item);
    else {
      groups.set(item.channelId, {
        channelId: item.channelId,
        channelUsername: item.channelUsername,
        channelTitle: item.channelTitle ?? null,
        sourceType: item.sourceType ?? 'telegram',
        items: [item],
      });
    }
  }
  return [...groups.values()];
}

export interface DigestPart {
  text: string;
  /** News rows carried by this part; marked published only after delivery. */
  itemIds: number[];
}

/**
 * Display identifier for a channel: its username, else its configured title.
 * RSS channels prefer the configured feed title (e.g. «بی‌بی‌سی فارسی») over the
 * synthetic internal username (`rss_3`).
 * Never invents a name; an empty result makes the digest skip sending.
 */
export function channelDisplayName(item: {
  channelUsername: string;
  channelTitle?: string | null;
  sourceType?: SourceType;
}): string {
  const username = item.channelUsername.trim();
  const title = (item.channelTitle ?? '').trim();
  if (item.sourceType === 'rss') return title || username;
  return username || title;
}

/**
 * Footer/label form of a source name: `@username` for real Telegram usernames,
 * the display title verbatim for everything else (RSS feed names are Persian
 * text and must not get a bogus `@`).
 */
export function sourceLabel(name: string): string {
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(name) ? `@${name}` : name;
}

/**
 * Display form of the configured destination channel.
 *
 * Only used for the footer line that tells readers where the digest is
 * published; the actual `sendMessage` target keeps using the configured value
 * unchanged. Usernames get an `@`, numeric channel ids are printed as stored
 * (no invented handle).
 */
export function destinationLabel(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (!value) return '';
  if (value.startsWith('@')) return value;
  if (/^-?\d+$/.test(value)) return value;
  return `@${value}`;
}

/**
 * Builds an HTML-formatted digest for one source channel.
 *
 * Each story deliberately contains both the AI headline and its full summary.
 * The topic emoji comes from the AI category, while every value originating in
 * D1 is escaped before it is sent with Telegram's HTML parse mode.
 *
 * Layout:
 *
 *   🏛️ <b>Headline</b>
 *   📝 <b>خلاصه:</b> The complete detail...
 *   🔎 <b>نکات مهم:</b> point one · point two
 *
 *   📡 <i>منبع: @source</i>
 *   📣 <i>@destination</i>
 */
export function buildChannelDigest(
  channelName: string,
  destination: string,
  items: {
    id: number;
    summaryText: string;
    title?: string | null;
    category?: string | null;
    highlights?: string[];
  }[]
): DigestPart[] {
  const name = channelName.trim();
  if (!name) return [];

  const separator = '\n\n';
  const source = escapeTelegramHtml(sourceLabel(name));
  const displayedDestination = destination.trim() ? escapeTelegramHtml(destination.trim()) : '';
  const footer = `📡 <i>منبع: ${source}</i>${displayedDestination ? `\n📣 <i>${displayedDestination}</i>` : ''}`;
  const overhead = separator.length + footer.length;
  const maxBodyLength = Math.max(1, TELEGRAM_TEXT_LIMIT - overhead);

  const prepared = items
    .map((item) => {
      const summary = sanitizeText(item.summaryText, Math.min(MAX_SUMMARY_CHARS, maxBodyLength));
      const title = item.title
        ? sanitizeText(item.title, MAX_TITLE_CHARS).replace(/\n+/g, ' ').trim()
        : '';
      const highlights = (item.highlights ?? [])
        .map((highlight) => sanitizeText(highlight, MAX_HIGHLIGHT_CHARS).replace(/\n+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, MAX_HIGHLIGHTS);
      const topic = topicPresentation(item.category, `${title} ${summary}`);

      const heading = title
        ? `${topic.emoji} <b>${escapeTelegramHtml(title)}</b>`
        : `${topic.emoji} <b>خبر ${escapeTelegramHtml(topic.label)}</b>`;
      const detail = `📝 <b>خلاصه:</b> ${escapeTelegramHtml(summary)}`;
      const keyPoints = highlights.length > 0
        ? `\n🔎 <b>نکات مهم:</b> ${highlights.map(escapeTelegramHtml).join(' · ')}`
        : '';
      const body = `${heading}\n${detail}${keyPoints}`;
      return { id: item.id, body, summary, title, highlights, topic };
    })
    .filter((item) => item.summary.length > 0 || item.title.length > 0);
  if (prepared.length === 0) return [];

  // A normal AI response is comfortably below the limit. This compact fallback
  // also protects the Bot API limit when legacy data contains a large amount of
  // HTML-sensitive text that expands while escaped.
  for (const item of prepared) {
    if (item.body.length <= maxBodyLength) continue;
    const compactSummary = sanitizeText(item.summary, 600);
    const compactTitle = sanitizeText(item.title, 120).replace(/\n+/g, ' ').trim();
    const topic = item.topic;
    const heading = compactTitle
      ? `${topic.emoji} <b>${escapeTelegramHtml(compactTitle)}</b>`
      : `${topic.emoji} <b>خبر ${escapeTelegramHtml(topic.label)}</b>`;
    item.body = `${heading}\n📝 <b>خلاصه:</b> ${escapeTelegramHtml(compactSummary)}`;
  }

  // Greedy packing on the actual HTML source length. The Bot API measures the
  // resulting message, so conservative accounting of tags keeps every part
  // under 4096 characters even when a digest is split.
  const chunks: { id: number; body: string }[][] = [];
  let current: { id: number; body: string }[] = [];
  let used = overhead;

  for (const item of prepared) {
    const addition = item.body.length + (current.length > 0 ? separator.length : 0);
    if (current.length > 0 && used + addition > TELEGRAM_TEXT_LIMIT) {
      chunks.push(current);
      current = [item];
      used = overhead + item.body.length;
    } else {
      current = [...current, { id: item.id, body: item.body }];
      used += addition;
    }
  }
  if (current.length > 0) chunks.push(current);

  return chunks.map((chunk) => ({
    text: `${chunk.map((item) => item.body).join(separator)}${separator}${footer}`,
    itemIds: chunk.map((item) => item.id),
  }));
}

/** Plain-text sanitizer used before HTML escaping. */
function sanitizeText(text: string, limit: number): string {
  const cleaned = String(text ?? '')
    // Strips C0/C1 control chars except tab and newline.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return cleaned.length > limit ? `${cleaned.slice(0, Math.max(1, limit - 1)).trimEnd()}…` : cleaned;
}

/**
 * Marks a message published. The `published_at IS NULL` guard makes this
 * idempotent, so a repeated call cannot overwrite or double-count.
 */
export async function markPublished(
  db: D1Database,
  messageId: number,
  destinationMessageId: number
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE messages
          SET published_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
              telegram_destination_message_id = ?1,
              publish_attempts = publish_attempts + 1,
              last_publish_error = NULL
        WHERE id = ?2 AND published_at IS NULL`
    )
    .bind(destinationMessageId, messageId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

/** Records a safe error category only — never provider bodies or credentials. */
export async function recordPublishFailure(
  db: D1Database,
  messageId: number,
  category: PublishErrorCategory
): Promise<void> {
  await db
    .prepare(
      `UPDATE messages
          SET publish_attempts = publish_attempts + 1,
              last_publish_error = ?1,
              last_publish_error_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?2 AND published_at IS NULL`
    )
    .bind(category, messageId)
    .run();
}

export async function runPublishing(db: D1Database, opts: PublishOptions = {}): Promise<PublishReport> {
  const destination = opts.destination ?? null;

  if (!destination || !isValidDestinationChat(destination)) {
    return {
      eligible: 0,
      published: 0,
      failures: [],
      rateLimited: false,
      destination: null,
    };
  }

  if (!opts.token) {
    console.error(
      JSON.stringify({
        event: 'publish',
        operation: 'skip',
        status: 'skipped',
        category: 'telegram_token_missing',
        timestamp: new Date().toISOString(),
      })
    );
    return { eligible: 0, published: 0, failures: [], rateLimited: false, destination };
  }

  const items = await selectPublishableMessages(db);
  const report: PublishReport = {
    eligible: items.length,
    published: 0,
    failures: [],
    rateLimited: false,
    destination,
  };

  // Best-effort Bale mirror of everything this run delivers to Telegram.
  const bale = opts.bale ?? null;
  const baleCounters = { sent: 0, failed: 0 };
  const finish = (): PublishReport => {
    if (bale) report.bale = { sent: baleCounters.sent, failed: baleCounters.failed };
    return report;
  };

  // Phase 4 guarantee: a row whose stored source link is unusable is never
  // published. The link itself is no longer printed, but the check stands.
  // Telegram rows must carry a t.me post link; RSS rows carry the article URL.
  const usable = items.filter((i) => isUsableSourceUrl(i));
  for (const invalid of items.filter((i) => !isUsableSourceUrl(i))) {
    await recordPublishFailure(db, invalid.id, 'invalid_source_url');
    report.failures.push({ messageId: invalid.id, category: 'invalid_source_url' });
  }

  // One destination message per source channel, in configured channel order.
  // No channel is dropped: every enabled channel is represented.
  const groups = groupByChannel(usable);
  const enabledChannels = (await listChannels(db)).filter((c) => c.enabled).length;
  const messageBudget = publishMessageBudget(enabledChannels);
  let messagesSent = 0;

  // The single run image. Generated once from the flat publishable list and sent
  // BEFORE any text digest. Deliberately outside the per-channel loop below, so
  // Browser Run can be called at most once per pipeline run.
  const image = await publishRunImage({
    // RSS rows swap the synthetic `rss_N` username for the feed's display
    // title, so the image cards and footer show «بی‌بی‌سی فارسی», not @rss_3.
    items: usable.map((i) =>
      i.sourceType === 'rss' ? { ...i, channelUsername: channelDisplayName(i) } : i
    ),
    destination,
    token: opts.token,
    browser: opts.browser,
    bale,
    baleCounters,
    fetchImpl: opts.fetchImpl,
    baseUrl: opts.baseUrl,
    now: opts.now,
  });
  // Left absent (not null) when there was nothing to show, so "no image" is
  // distinguishable from "an image that failed".
  if (image) report.image = image;

  for (const group of groups) {
    const parts = buildChannelDigest(
      channelDisplayName(group),
      destinationLabel(destination),
      group.items
    );
    if (parts.length === 0) continue;

    for (const part of parts) {
      if (messagesSent >= messageBudget) {
        // Explicit, deterministic bound. The remainder is recorded (not silently
        // dropped) and stays unpublished, so the next run continues in the same
        // configured order without losing or reordering anything.
        for (const itemId of part.itemIds) {
          await recordPublishFailure(db, itemId, 'run_limit');
          report.failures.push({ messageId: itemId, category: 'run_limit' });
        }
        logPublish('skipped', 'run_limit', group, {
          newsCount: part.itemIds.length,
          messagesSent,
          messageBudget,
        });
        return finish();
      }

      try {
        const sent = await sendMessage({
          token: opts.token!,
          chatId: destination,
          text: part.text,
          parseMode: 'HTML',
          fetchImpl: opts.fetchImpl,
          baseUrl: opts.baseUrl,
        });
        messagesSent++;

        // Only the rows carried by THIS delivered message are marked.
        let markedCount = 0;
        for (const itemId of part.itemIds) {
          if (await markPublished(db, itemId, sent.message_id)) markedCount++;
        }
        report.published += markedCount;
        logPublish('ok', undefined, group, {
          destinationMessageId: sent.message_id,
          newsCount: markedCount,
        });

        // Mirror the delivered part to Bale. Only delivered parts are mirrored,
        // so a later retry (rows still unpublished) cannot duplicate on Bale.
        if (bale) {
          try {
            await baleSendMessage({
              token: bale.token,
              chatId: bale.destination,
              text: part.text,
              parseMode: 'HTML',
              fetchImpl: opts.fetchImpl,
            });
            baleCounters.sent++;
          } catch (error) {
            baleCounters.failed++;
            logBale('error', {
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } catch (error) {
        const category: PublishErrorCategory =
          error instanceof TelegramRateLimitError
            ? 'rate_limited'
            : error instanceof TelegramError && error.status === 0
              ? 'network'
              : 'telegram_error';

        const retryAfter =
          error instanceof TelegramRateLimitError ? error.retryAfterSeconds : undefined;
        for (const itemId of part.itemIds) {
          await recordPublishFailure(db, itemId, category);
          report.failures.push(
            retryAfter === undefined
              ? { messageId: itemId, category }
              : { messageId: itemId, category, retryAfterSeconds: retryAfter }
          );
        }

        if (error instanceof TelegramRateLimitError) {
          // Stop immediately: retrying in a tight loop would burn the invocation
          // budget. Everything left stays unpublished for the next run.
          report.rateLimited = true;
          logPublish('rate_limited', category, group, {
            retryAfterSeconds: error.retryAfterSeconds,
          });
          return finish();
        }

        logPublish('error', category, group, { newsCount: part.itemIds.length });
      }
    }
  }

  return finish();
}

/**
 * Generates and sends THE single image for this run.
 *
 * Invariants:
 *  - called exactly once from `runPublishing`, outside the channel loop, so at
 *    most one Browser Run request is made per pipeline execution;
 *  - never touches publish state: a failure here leaves every text digest and
 *    every `published_at` exactly as the existing logic would have left them;
 *  - the PNG is a local buffer that is released as soon as the send resolves.
 *
 * Returns null when there is nothing to show, in which case no Browser Run
 * request is made at all.
 */
async function publishRunImage(input: {
  items: PublishableMessage[];
  destination: string;
  token: string;
  browser: BrowserBinding | undefined;
  bale: BaleDeliveryOptions | null;
  baleCounters: { sent: number; failed: number };
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  now?: Date;
}): Promise<ImagePublishOutcome | null> {
  const { items, destination, token, browser } = input;
  if (items.length === 0) return null;

  let rendered;
  try {
    rendered = await renderRunImage({ browser, items, now: input.now });
  } catch (error) {
    // Rendering failed (Browser Run unavailable or rate limited). Text
    // publishing continues untouched and nothing is marked published.
    logImage('error', {
      newsCount: items.length,
      reason: error instanceof Error ? error.message : String(error),
    });
    return {
      selected: 0,
      channels: 0,
      sent: false,
      bytes: 0,
      width: 0,
      height: 0,
      browserRunMs: 0,
      error: 'render_failed',
    };
  }

  // No publishable news, or no Browser Run binding configured: no image and no
  // Browser Run request at all.
  if (!rendered) return null;

  // Mirror the rendered PNG to Bale before the Telegram send. Independent and
  // isolated: a Bale failure never changes the Telegram outcome below.
  if (input.bale) {
    try {
      await baleSendPhoto({
        token: input.bale.token,
        chatId: input.bale.destination,
        photo: rendered.png,
        fetchImpl: input.fetchImpl,
      });
      input.baleCounters.sent++;
    } catch (error) {
      input.baleCounters.failed++;
      logBale('error', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const base: ImagePublishOutcome = {
    selected: rendered.items.length,
    channels: new Set(rendered.items.map((i) => i.channelUsername)).size,
    sent: false,
    bytes: rendered.bytes,
    width: rendered.width,
    height: rendered.height,
    browserRunMs: rendered.browserRunMs,
  };

  try {
    await sendPhoto({
      token,
      chatId: destination,
      photo: rendered.png,
      fetchImpl: input.fetchImpl,
      baseUrl: input.baseUrl,
    });
    // The PNG is never persisted; it stays referenced only by this local
    // variable and becomes unreachable when this function returns.
    logImage('ok', { ...base, newsCount: items.length });
    return { ...base, sent: true };
  } catch (error) {
    logImage('send_failed', {
      newsCount: items.length,
      reason: error instanceof Error ? error.message : String(error),
    });
    return { ...base, error: 'send_failed' };
  }
}

function logImage(status: string, extra: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({
      event: 'publish',
      operation: 'runImage',
      status,
      timestamp: new Date().toISOString(),
      ...extra,
    })
  );
}

/** Best-effort Bale mirror bookkeeping; reasons are error messages only. */
function logBale(status: string, extra: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({
      event: 'publish',
      operation: 'bale',
      status,
      timestamp: new Date().toISOString(),
      ...extra,
    })
  );
}

function logPublish(
  status: string,
  category: string | undefined,
  group: { channelId: number; channelUsername: string },
  extra: Record<string, unknown> = {}
): void {
  console.log(
    JSON.stringify({
      event: 'publish',
      operation: 'sendMessage',
      status,
      category,
      channel: group.channelUsername,
      channelId: group.channelId,
      timestamp: new Date().toISOString(),
      ...extra,
    })
  );
}

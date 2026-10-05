/**
 * Phase 4: publishes summarized news to the configured Telegram destination.
 *
 * The run is published as PICTURES ONLY. No text digest is ever sent: the top
 * news of the run are rendered onto slides (two news items per picture) and
 * delivered as one Telegram album, which the client shows as a single
 * swipeable slideshow. The only text that leaves this module is the album's
 * one-line date caption.
 *
 * Guarantees:
 *  - only messages with a real summary, a valid source link and an enabled
 *    source channel can reach a slide
 *  - a message is marked published only after Telegram confirms the album,
 *    using an atomic guarded UPDATE so a repeat run cannot double-publish
 *  - news the album could not carry stays unpublished and is picked up by the
 *    next run, in importance order — nothing is silently dropped
 *  - rate limits stop the pass instead of hammering; leftovers retry next run
 */

import { doc, slideshow } from 'tg-rich-messages';
import { baleSendPhoto } from './bale';
import {
  buildAlbumCaption,
  MAX_ALBUM_SLIDES,
  renderRunAlbum,
  type BrowserBinding,
  type RenderedSlideImage,
} from './newsImage';
import {
  isValidDestinationChat,
  sendPhoto,
  sendRichMessage,
  TelegramError,
  TelegramRateLimitError,
  type DestinationChat,
  type SentMessage,
} from './telegram';
import type { Env } from './types';

/**
 * Browser Run cost of one run, as a sanity bound rather than a product limit.
 *
 * Workers Free allows 50 subrequests per invocation and the earlier stages
 * (collection, summarization, the occasional model list) already spend some.
 * Image-only publishing spends at most `MAX_ALBUM_SLIDES` renders plus ONE
 * send, which is why the album is capped at six slides / twelve news items.
 */
export const MAX_ALBUM_SUBREQUESTS = MAX_ALBUM_SLIDES + 1;

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
  | 'network';

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
  /**
   * Rows retired this run because the AI ranked them as not newsworthy. They
   * are not failures: nothing went wrong, they simply never enter a picture.
   */
  retired: number;
}

export interface PublishOptions {
  token?: string;
  destination?: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /**
   * Browser Run binding. When absent nothing is published at all — the album
   * is the only output, so the run keeps every item pending for next time.
   */
  browser?: BrowserBinding;
  now?: Date;
  /**
   * Wait between two album slide renders, honoring the free-plan Quick Action
   * rate limit (≈1 request/10s). The pipeline passes the production value;
   * 0 (default) renders back to back.
   */
  renderSpacingMs?: number;
  /** Injectable wait, so tests never sleep for real. */
  sleepImpl?: (ms: number) => Promise<void>;
  /**
   * Optional Bale mirror (BALE_BOT_TOKEN + BALE_DESTINATION_CHANNEL). Every
   * delivered picture is also sent to Bale, as separate photo messages (Bale
   * has no album transport). Best effort: a Bale failure is logged and counted
   * but never affects Telegram delivery or publish state.
   */
  bale?: BaleDeliveryOptions;
}

/** Outcome of the optional run album (the multi-image slideshow). */
export interface ImagePublishOutcome {
  /** Slide images actually sent in the album (at most MAX_ALBUM_SLIDES). */
  slides: number;
  /** News items carried across the sent slides (up to four per slide). */
  selected: number;
  /** Distinct source channels represented in the album. */
  channels: number;
  sent: boolean;
  bytes: number;
  width: number;
  height: number;
  browserRunMs: number;
  /** Overflow headlines carried by the last slide's ticker and caption. */
  ticker: number;
  /** Selected slides that failed to render and were skipped. */
  skipped: number;
  /** Set when rendering or sending failed; text publishing is unaffected. */
  error?: string;
  /** Short, safe detail behind `error` (stage/status), for run reports. */
  detail?: string;
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
/** Editorial key points kept per row; only the picture template reads them. */
const MAX_STORED_HIGHLIGHTS = 3;

function parseHighlights(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, MAX_STORED_HIGHLIGHTS);
  } catch {
    return [];
  }
}

/**
 * Display identifier for a channel: its username, else its configured title.
 * RSS channels prefer the configured feed title (e.g. «بی‌بی‌سی فارسی») over the
 * synthetic internal username (`rss_3`).
 * Never invents a name; an empty result simply leaves the card footer bare.
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
      retired: 0,
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
    return { eligible: 0, published: 0, failures: [], rateLimited: false, destination, retired: 0 };
  }

  const items = await selectPublishableMessages(db);
  const report: PublishReport = {
    eligible: items.length,
    published: 0,
    failures: [],
    rateLimited: false,
    destination,
    retired: 0,
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

  // Rows the AI scored 1 ("not worth publishing") can never enter a slide.
  // With no text digest to carry them they would be re-selected by every run
  // forever, so they are retired here with an explicit, auditable reason.
  const rejected = usable.filter((i) => i.importance === 1);
  for (const item of rejected) {
    if (await markNotNewsworthy(db, item.id)) report.retired++;
  }
  if (report.retired > 0) logPublish('retired', 'not_newsworthy', { newsCount: report.retired });

  // THE run album — the only thing this module publishes. Rendered once from
  // the flat publishable list, so Browser Run is called at most once per
  // slide (≤ MAX_ALBUM_SLIDES) per run.
  const album = await publishRunAlbum({
    // RSS rows swap the synthetic `rss_N` username for the feed's display
    // title, so the slides show «بی‌بی‌سی فارسی», not @rss_3.
    items: usable.map((i) =>
      i.sourceType === 'rss' ? { ...i, channelUsername: channelDisplayName(i) } : i
    ),
    destination,
    token: opts.token,
    browser: opts.browser,
    renderSpacingMs: opts.renderSpacingMs,
    sleepImpl: opts.sleepImpl,
    bale,
    baleCounters,
    fetchImpl: opts.fetchImpl,
    baseUrl: opts.baseUrl,
    now: opts.now,
  });

  // Left absent (not null) when there was nothing to show, so "no image" is
  // distinguishable from "an image that failed".
  if (!album) return finish();
  report.image = album.outcome;

  if (!album.outcome.sent) {
    // Nothing was delivered: every row stays unpublished and is retried by the
    // next run. A rate limit additionally stops this pass.
    const category: PublishErrorCategory =
      album.outcome.detail === 'rate_limited'
        ? 'rate_limited'
        : album.outcome.detail === 'network'
          ? 'network'
          : 'telegram_error';
    if (album.outcome.error === 'send_failed') {
      for (const id of album.itemIds) {
        await recordPublishFailure(db, id, category);
        report.failures.push({ messageId: id, category });
      }
      report.rateLimited = category === 'rate_limited';
    }
    return finish();
  }

  // Only the news ON the delivered slides is marked — and only now, after
  // Telegram confirmed the album. Everything else stays pending for the next
  // run, in importance order.
  for (const id of album.itemIds) {
    if (await markPublished(db, id, album.messageId ?? 0)) report.published++;
  }
  logPublish('ok', undefined, {
    destinationMessageId: album.messageId,
    newsCount: report.published,
    slides: album.outcome.slides,
  });

  return finish();
}

/**
 * Retires a row the AI ranked as not newsworthy (importance 1).
 *
 * It is marked `filtered`, the same terminal state the ad filter and the
 * summarizer use, so `selectPublishableMessages` stops returning it. Nothing
 * is deleted: the row, its summary and the reason stay auditable in D1.
 */
export async function markNotNewsworthy(db: D1Database, messageId: number): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE messages
          SET filter_status = 'filtered',
              filter_reason = 'low_importance',
              filtered_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?1 AND published_at IS NULL AND filter_status <> 'filtered'`
    )
    .bind(messageId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** What the album delivered, and which rows `runPublishing` may now mark. */
interface AlbumDelivery {
  outcome: ImagePublishOutcome;
  /** Message ids of the news ON the delivered slides, in display order. */
  itemIds: number[];
  /** First message id of the album; the rows point at it once published. */
  messageId: number | null;
}

/**
 * Generates and sends THE run album: a slideshow of fixed-template slides,
 * every slide covering two news items (headline + introductory text),
 * delivered by Telegram as a single `sendMediaGroup`.
 *
 * Invariants:
 *  - called exactly once from `runPublishing`, so Browser Run is spent only on
 *    the album (≤ MAX_ALBUM_SLIDES renders) and Telegram receives one send;
 *  - never touches publish state itself — it reports what was delivered and
 *    the caller marks those rows, so a failure leaves every `published_at`
 *    untouched and the news returns in the next run;
 *  - every PNG is a local buffer released as soon as the send resolves.
 *
 * Returns null when there is nothing to show, in which case no Browser Run
 * request is made at all.
 */
async function publishRunAlbum(input: {
  items: PublishableMessage[];
  destination: string;
  token: string;
  browser: BrowserBinding | undefined;
  renderSpacingMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
  bale: BaleDeliveryOptions | null;
  baleCounters: { sent: number; failed: number };
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  now?: Date;
}): Promise<AlbumDelivery | null> {
  const { items, destination, token, browser } = input;
  if (items.length === 0) return null;

  let album: Awaited<ReturnType<typeof renderRunAlbum>>;
  try {
    album = await renderRunAlbum({
      browser,
      items,
      now: input.now,
      spacingMs: input.renderSpacingMs,
      sleepImpl: input.sleepImpl,
    });
  } catch (error) {
    // Rendering failed before any slide existed (binding unusable). Text
    // publishing continues untouched and nothing is marked published.
    const detail = error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 120) : 'unknown';
    logImage('error', { newsCount: items.length, reason: detail });
    return {
      outcome: {
        slides: 0,
        selected: 0,
        channels: 0,
        sent: false,
        bytes: 0,
        width: 0,
        height: 0,
        browserRunMs: 0,
        ticker: 0,
        skipped: 0,
        error: 'render_failed',
        detail,
      },
      itemIds: [],
      messageId: null,
    };
  }

  // No publishable news, or no Browser Run binding configured: no album and
  // no Browser Run request at all.
  if (!album) return null;

  // Every selected slide failed to render (Browser Run down or rate limited).
  if (album.slides.length === 0) {
    logImage('error', { newsCount: items.length, reason: album.error, skipped: album.skipped });
    return {
      outcome: {
        slides: 0,
        selected: 0,
        channels: 0,
        sent: false,
        bytes: 0,
        width: 0,
        height: 0,
        browserRunMs: album.browserRunMs,
        ticker: 0,
        skipped: album.skipped,
        error: 'render_failed',
        ...(album.error ? { detail: album.error } : {}),
      },
      itemIds: [],
      messageId: null,
    };
  }

  // ONE short date line for the whole run — the news itself is in the picture.
  const albumCaption = buildAlbumCaption(input.now ?? new Date());

  // Mirror every slide to Bale before the Telegram send. Bale has no album
  // transport, so the same PNGs go out as separate photos, the first one
  // captioned exactly like the Telegram album. Independent and isolated: a
  // Bale failure never changes the Telegram outcome below.
  if (input.bale) {
    for (const [index, slide] of album.slides.entries()) {
      try {
        await baleSendPhoto({
          token: input.bale.token,
          chatId: input.bale.destination,
          photo: slide.png,
          ...(index === 0 ? { caption: albumCaption } : {}),
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
  }

  const base: ImagePublishOutcome = {
    slides: album.slides.length,
    selected: album.selected,
    channels: new Set(album.slides.flatMap((slide) => slide.items.map((i) => i.channelUsername)))
      .size,
    sent: false,
    bytes: album.slides.reduce((sum, slide) => sum + slide.bytes, 0),
    width: album.slides[0].width,
    height: album.slides[0].height,
    browserRunMs: album.browserRunMs,
    ticker: album.ticker.filter((t) => !t.more).length,
    skipped: album.skipped,
  };

  const deliveredIds = album.slides.flatMap((slide) => slide.items.map((item) => item.id));

  try {
    const sent = await sendAlbum({
      token,
      destination,
      slides: album.slides,
      caption: albumCaption,
      fetchImpl: input.fetchImpl,
      baseUrl: input.baseUrl,
    });
    // The PNGs are never persisted; they stay referenced only by the local
    // album variable and become unreachable when this function returns.
    logImage('ok', { ...base, newsCount: items.length });
    return {
      outcome: { ...base, sent: true },
      itemIds: deliveredIds,
      messageId: sent?.message_id ?? null,
    };
  } catch (error) {
    const detail =
      error instanceof TelegramRateLimitError
        ? 'rate_limited'
        : error instanceof TelegramError
          ? `HTTP ${error.status}`
          : 'network';
    logImage('send_failed', {
      newsCount: items.length,
      reason: error instanceof Error ? error.message : String(error),
    });
    return {
      outcome: { ...base, error: 'send_failed', detail },
      itemIds: deliveredIds,
      messageId: null,
    };
  }
}

/**
 * Sends the album: one `sendMediaGroup` for two or more slides — Telegram
 * shows them as a single swipeable slideshow — and a plain `sendPhoto` for a
 * single slide, because a media group requires at least two items.
 *
 * The run summary travels as the album's single caption. Captioning every
 * photo would make Telegram split the group into one message per photo, which
 * is exactly the slideshow-less layout this transport exists to avoid.
 */
async function sendAlbum(input: {
  token: string;
  destination: string;
  slides: RenderedSlideImage[];
  caption: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}): Promise<SentMessage | null> {
  if (input.slides.length === 1) {
    return await sendPhoto({
      token: input.token,
      chatId: input.destination,
      photo: input.slides[0].png,
      caption: input.caption,
      fetchImpl: input.fetchImpl,
      baseUrl: input.baseUrl,
    });
  }
  // A media group is only a photo album. Rich Messages has a real slideshow
  // block; attach:// references let Telegram consume our in-memory PNGs in the
  // same request, with no R2 bucket or public image hosting.
  const attachments = input.slides.map((slide, index) => ({
    name: `slide${index}`,
    data: slide.png,
    filename: `slide-${index + 1}.png`,
    contentType: 'image/png',
  }));
  const rich = doc(
    slideshow(
      attachments.map((attachment) => ({ url: `attach://${attachment.name}`, type: 'photo' as const })),
      { caption: input.caption }
    )
  );
  return await sendRichMessage({
    token: input.token,
    chatId: input.destination as DestinationChat,
    richMessage: rich.toInputRichMessage({ isRtl: true, skipEntityDetection: true }),
    attachments,
    fetchImpl: input.fetchImpl,
    baseUrl: input.baseUrl,
  });
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

/** Run-level publish bookkeeping; the album is the only thing published. */
function logPublish(
  status: string,
  category: string | undefined,
  extra: Record<string, unknown> = {}
): void {
  console.log(
    JSON.stringify({
      event: 'publish',
      operation: 'album',
      status,
      category,
      timestamp: new Date().toISOString(),
      ...extra,
    })
  );
}

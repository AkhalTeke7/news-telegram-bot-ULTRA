import { insertMessages, listEnabledChannels, markChannelProcessed } from './channels';
import { describeError, fetchChannelPreview } from './telegramPreview';
import type { Channel } from './types';

/**
 * Collection window: two hours, matching the bi-hourly cron trigger (every
 * other UTC hour at minute 30, i.e. every other Tehran hour boundary). A
 * one-hour window would silently miss the news posted during the skipped hour;
 * dedup (UNIQUE per channel + message id) keeps the wider window from
 * double-inserting.
 */
export const DEFAULT_WINDOW_MS = 2 * 60 * 60 * 1000;
/**
 * Telegram timestamps come from Telegram's servers. If its clock runs slightly
 * ahead of the Worker's, a strict "not after now" filter would silently drop
 * every post, so a small forward tolerance is allowed. The lower window bound
 * and the UNIQUE constraint still prevent double processing.
 */
export const DEFAULT_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

export interface CollectOptions {
  /** Window end. Defaults to Date.now(). */
  now?: number;
  windowMs?: number;
  futureToleranceMs?: number;
  /** Injected for tests. Must never hit the network in tests. */
  fetchImpl?: typeof fetch;
}

export interface ChannelResult {
  channelId: number;
  channel: string;
  operation: string;
  ok: boolean;
  fetched: number;
  inserted: number;
  duplicates: number;
  ignoredOutOfWindow: number;
  error?: string;
  timestamp: string;
}

export interface CollectSummary {
  now: string;
  windowStart: string;
  windowMs: number;
  enabledChannels: number;
  succeeded: number;
  failed: number;
  inserted: number;
  duplicates: number;
  results: ChannelResult[];
}

/**
 * Collects one channel. Throws on retrieval failure *before* touching
 * last_checked_at / last_processed_message_id, so a failed channel is retried
 * on the next run instead of being silently marked as processed.
 */
export async function collectChannel(
  db: D1Database,
  channel: Channel,
  opts: CollectOptions = {}
): Promise<ChannelResult> {
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const windowStart = now - windowMs;
  const futureLimit = now + (opts.futureToleranceMs ?? DEFAULT_FUTURE_TOLERANCE_MS);

  const preview = await fetchChannelPreview(channel.channelUsername, {
    fetchImpl: opts.fetchImpl,
  });

  const inWindow = preview.filter(
    (m) => m.messageDateMs >= windowStart && m.messageDateMs <= futureLimit
  );
  const { inserted, duplicates } = await insertMessages(
    db,
    channel.id,
    inWindow.map((m) => ({
      telegramMessageId: m.telegramMessageId,
      messageDate: m.messageDate,
      messageText: m.messageText,
      sourceUrl: m.sourceUrl,
    }))
  );

  const newestId = inWindow.reduce((max, m) => Math.max(max, m.telegramMessageId), 0);
  await markChannelProcessed(db, channel.id, newestId);

  return {
    channelId: channel.id,
    channel: channel.channelUsername,
    operation: 'collect-channel',
    ok: true,
    fetched: preview.length,
    inserted,
    duplicates,
    ignoredOutOfWindow: preview.length - inWindow.length,
    timestamp: new Date(now).toISOString(),
  };
}

/**
 * Runs every enabled channel. A failure in one channel is isolated: it is
 * logged with channel/operation/error/timestamp and never blocks the others.
 */
export async function collectAll(db: D1Database, opts: CollectOptions = {}): Promise<CollectSummary> {
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;

  const channels = await listEnabledChannels(db);
  const results: ChannelResult[] = [];

  for (const channel of channels) {
    try {
      results.push(await collectChannel(db, channel, { ...opts, now, windowMs }));
    } catch (error) {
      results.push({
        channelId: channel.id,
        channel: channel.channelUsername,
        operation: 'collect-channel',
        ok: false,
        fetched: 0,
        inserted: 0,
        duplicates: 0,
        ignoredOutOfWindow: 0,
        error: describeError(error),
        timestamp: new Date(now).toISOString(),
      });
    }
  }

  for (const r of results) {
    if (r.ok) {
      console.log(
        JSON.stringify({
          event: 'collect',
          channel: r.channel,
          channelId: r.channelId,
          operation: r.operation,
          status: 'ok',
          fetched: r.fetched,
          inserted: r.inserted,
          duplicates: r.duplicates,
          ignoredOutOfWindow: r.ignoredOutOfWindow,
          timestamp: r.timestamp,
        })
      );
    } else {
      console.error(
        JSON.stringify({
          event: 'collect',
          channel: r.channel,
          channelId: r.channelId,
          operation: r.operation,
          status: 'error',
          error: r.error,
          timestamp: r.timestamp,
        })
      );
    }
  }

  const ok = results.filter((r) => r.ok);
  return {
    now: new Date(now).toISOString(),
    windowStart: new Date(now - windowMs).toISOString(),
    windowMs,
    enabledChannels: channels.length,
    succeeded: ok.length,
    failed: results.length - ok.length,
    inserted: ok.reduce((n, r) => n + r.inserted, 0),
    duplicates: ok.reduce((n, r) => n + r.duplicates, 0),
    results,
  };
}

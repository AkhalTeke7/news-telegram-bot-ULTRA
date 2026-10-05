/**
 * TASK 2 — the once-a-day red-folder (high impact) economic calendar.
 *
 * Cron is `30 4 * * *` UTC. Cloudflare Cron Triggers are UTC-only; Iran is a
 * fixed UTC+03:30 with no DST, so 04:30 UTC is 08:00 Asia/Tehran every day of
 * the year. If TIMEZONE is changed to a zone WITH daylight saving, the local
 * send time will shift by an hour across DST boundaries — that is a property
 * of UTC crons, not a bug here, and `/status` shows the actual run time.
 *
 * "Exactly once per day" is enforced by an atomic D1 claim, not by trusting
 * the scheduler:
 *
 *   - `claimDailyJob` does `INSERT OR IGNORE` on (job, claim_date). Of N
 *     concurrent or retried invocations exactly one sees `changes == 1`.
 *   - Everyone else returns immediately without sending.
 *   - On a failure BEFORE anything reached Telegram the claim is released so
 *     a later invocation can retry today.
 *   - On an AMBIGUOUS send (timeout, dropped connection) the claim is NOT
 *     released. Telegram may have delivered it; failing closed costs at most
 *     one missed day, while releasing could double-post.
 */

import {
  analyzeCalendarEvents,
  renderCalendarAnalysis,
  withDisclaimer,
  type CalendarAnalysis,
} from '../analysis/marketImpact';
import { describeError } from '../lib/http';
import { jalaliDate, localDateKey, resolveTimeZone, toPersianDigits } from '../lib/jalali';
import { claimDailyJob, markClaimSent, markClaimSkipped, releaseClaim } from '../lib/jobs';
import { resolveDailyBudget } from '../llm/budget';
import { resolveProviders } from '../llm/providers';
import { resolveDestination } from '../publisher';
import { sendMessage, TelegramError, type DestinationChat } from '../telegram';
import type { Env } from '../types';
import {
  CalendarSourceError,
  currencyFlag,
  currencyName,
  fetchCalendarFeed,
  selectTodayHighImpact,
  toCalendarEvents,
  type CalendarEvent,
} from './forexFactory';

/** Telegram's hard limit is 4096 characters; leave room for the disclaimer. */
const MESSAGE_SOFT_LIMIT = 3500;

export interface CalendarJobResult {
  status: 'success' | 'skipped' | 'failed';
  /** High-impact events found for today. */
  events: number;
  /** Events that got an analysis block. */
  analyzed: number;
  /** Telegram messages sent. */
  messages: number;
  claimDate: string;
  /** Short, secret-free reason. */
  reason?: string;
  /** True when another invocation already owns today. */
  alreadyClaimed?: boolean;
}

export interface RunCalendarOptions {
  now?: Date;
  fetchImpl?: typeof fetch;
  /** Skip the KV cache (manual admin refresh). */
  force?: boolean;
}

/** `۰۸:۳۰` — Persian digits, matching the rest of the Persian output. */
const faTime = (hhmm: string): string => toPersianDigits(hhmm);

/**
 * Formats one event. `forecast`/`previous` are frequently empty strings and
 * may contain a `|` (e.g. `"3.00|3.3"`), so they are printed verbatim and
 * never parsed as numbers.
 */
export function formatCalendarEvent(
  event: CalendarEvent,
  analysis: CalendarAnalysis | undefined
): string[] {
  const lines = [
    `🔴 ${faTime(event.localTime)} — ${currencyFlag(event.currency)} ${currencyName(event.currency)}`,
    `📌 ${event.title}`,
  ];

  const forecast = event.forecast.trim();
  const previous = event.previous.trim();
  const figures: string[] = [];
  if (forecast) figures.push(`پیش‌بینی: ${forecast}`);
  if (previous) figures.push(`قبلی: ${previous}`);
  lines.push(figures.length > 0 ? `   ${figures.join(' | ')}` : '   پیش‌بینی: — | قبلی: —');

  lines.push(...renderCalendarAnalysis(analysis));
  return lines;
}

/**
 * Builds the message(s).
 *
 * Splits on event boundaries when the text would exceed Telegram's limit, so
 * an event is never cut in half. Every part carries the disclaimer, because
 * each part is independently forwardable.
 */
export function buildCalendarMessages(
  events: readonly CalendarEvent[],
  analyses: ReadonlyMap<string, CalendarAnalysis>,
  jalali: string,
  hasAnalysis: boolean
): string[] {
  const header = [
    '🗓 رویدادهای مهم اقتصادی امروز',
    `📅 ${jalali}`,
    `🔴 تعداد رویدادهای پراهمیت: ${toPersianDigits(events.length)}`,
    '',
    '',
  ].join('\n');

  const blocks = events.map((event) => formatCalendarEvent(event, analyses.get(event.ref)).join('\n'));

  const messages: string[] = [];
  let current = header;
  for (const block of blocks) {
    const candidate = current === header ? `${current}${block}` : `${current}\n\n${block}`;
    if (candidate.length > MESSAGE_SOFT_LIMIT && current !== header) {
      messages.push(current);
      current = block;
    } else {
      current = candidate;
    }
  }
  messages.push(current);

  // The disclaimer is mandatory whenever analysis is present.
  return hasAnalysis ? messages.map(withDisclaimer) : messages;
}

/**
 * Runs the daily calendar job. Never throws.
 */
export async function runCalendarJob(
  env: Env,
  opts: RunCalendarOptions = {}
): Promise<CalendarJobResult> {
  const now = opts.now ?? new Date();
  const timeZone = resolveTimeZone(env.TIMEZONE);
  const today = localDateKey(now, timeZone);

  const base: CalendarJobResult = {
    status: 'skipped',
    events: 0,
    analyzed: 0,
    messages: 0,
    claimDate: today,
  };

  const destination = resolveDestination(env);
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!destination || !token) {
    return { ...base, reason: 'destination_or_token_missing' };
  }

  // --- the one-send-per-day gate ------------------------------------------
  let claim: Awaited<ReturnType<typeof claimDailyJob>>;
  try {
    claim = await claimDailyJob(env.DB, 'calendar', timeZone, now);
  } catch (error) {
    return { ...base, status: 'failed', reason: `claim: ${describeError(error, 80)}` };
  }
  if (!claim.won) {
    return {
      ...base,
      alreadyClaimed: true,
      reason: `already_${claim.existingStatus ?? 'claimed'}`,
    };
  }

  // From here on, every exit path must either send, skip, or release.
  let feed;
  try {
    feed = await fetchCalendarFeed({ kv: env.KV, fetchImpl: opts.fetchImpl, force: opts.force });
  } catch (error) {
    // Nothing was sent: let a later invocation retry today.
    await releaseClaim(env.DB, 'calendar', claim.date);
    const reason =
      error instanceof CalendarSourceError
        ? `source_${error.failure}${error.status ? `_${error.status}` : ''}`
        : describeError(error, 80);
    await notifyAdmin(
      env,
      token,
      `❌ دریافت تقویم اقتصادی ناموفق بود (${reason}).\nهیچ پیامی ارسال نشد و داده‌ای ساخته نشد.`,
      opts.fetchImpl
    );
    return { ...base, status: 'failed', reason };
  }

  const events = selectTodayHighImpact(toCalendarEvents(feed.events, timeZone), timeZone, now);
  base.events = events.length;

  if (events.length === 0) {
    // Spec: no red events -> send nothing. This is a success, not a failure,
    // and the claim stays so we do not re-check all day.
    await markClaimSkipped(env.DB, 'calendar', claim.date, 'no_high_impact_events');
    return { ...base, status: 'success', reason: 'no_high_impact_events' };
  }

  // --- analysis (Task 4): one batched call, optional --------------------
  const analyses = await analyzeCalendarEvents(
    events.map((event) => ({
      ref: event.ref,
      title: event.title,
      currency: event.currency,
      forecast: event.forecast,
      previous: event.previous,
    })),
    {
      providers: resolveProviders(env),
      budget: { db: env.DB, localDate: today, dailyLimit: resolveDailyBudget(env.LLM_DAILY_BUDGET) },
      fetchImpl: opts.fetchImpl,
    }
  );
  base.analyzed = analyses.size;

  const messages = buildCalendarMessages(
    events,
    analyses,
    jalaliDate(now, timeZone),
    analyses.size > 0
  );

  let sent = 0;
  for (const text of messages) {
    try {
      await sendMessage({
        token,
        chatId: destination as DestinationChat,
        text,
        disableLinkPreview: true,
        fetchImpl: opts.fetchImpl,
      });
      sent++;
    } catch (error) {
      const reason =
        error instanceof TelegramError ? `telegram_${error.status}` : describeError(error, 60);
      // Do NOT release: part of the list may already be in the channel, and
      // the outcome of this very call may be ambiguous. Fail closed.
      await markClaimSent(env.DB, 'calendar', claim.date, `partial:${sent}/${messages.length}`);
      return { ...base, status: 'failed', messages: sent, reason };
    }
  }

  await markClaimSent(env.DB, 'calendar', claim.date, `${events.length} events`);
  return { ...base, status: 'success', messages: sent };
}

/** Best-effort operator notification. Never throws, never blocks the result. */
async function notifyAdmin(
  env: Env,
  token: string,
  text: string,
  fetchImpl?: typeof fetch
): Promise<void> {
  const adminId = (env.TELEGRAM_ADMIN_USER_ID ?? env.ADMIN_ID ?? '').trim();
  if (!/^\d{5,20}$/.test(adminId)) return;
  try {
    await sendMessage({
      token,
      chatId: adminId as `${number}`,
      text,
      disableLinkPreview: true,
      fetchImpl,
    });
  } catch {
    /* best effort */
  }
}

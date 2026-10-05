/**
 * TASK 2 — the Forex Factory weekly calendar feed.
 *
 * Source: https://nfs.faireconomy.media/ff_calendar_thisweek.json
 * This is the ONLY accepted source. If it is unreachable or its shape changes,
 * the job reports the failure and sends nothing. There is deliberately no HTML
 * scraping fallback and no synthesized data anywhere in this file.
 *
 * Verified live on 2026-10-05, the feed is a flat array of objects with
 * exactly six fields:
 *
 *   {"title":"FOMC Meeting Minutes","country":"USD",
 *    "date":"2026-10-07T14:00:00-04:00","impact":"High",
 *    "forecast":"","previous":""}
 *
 * Two traps that are handled here:
 *  1. `country` is a CURRENCY code (USD, EUR, …) or the literal "All" — not
 *     an ISO country code.
 *  2. `date` carries a NEW YORK offset (-04:00/-05:00), not UTC. It must be
 *     parsed as an instant and converted with `Intl`; slicing the string
 *     would put events on the wrong day for a Tehran reader.
 */

import { z } from 'zod';
import { HttpError, describeError, safeFetch } from '../lib/http';
import { kvGetJson, kvPutJson } from '../lib/kv';
import { localDateKey, localTimeHm } from '../lib/jalali';

export const FOREX_FACTORY_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

/** 6 hours: the weekly file barely changes, and 4 hits/day is "a few". */
export const CALENDAR_CACHE_TTL_SECONDS = 6 * 60 * 60;
export const CALENDAR_CACHE_KEY = 'calendar:ff:thisweek';
export const CALENDAR_FETCH_TIMEOUT_MS = 15_000;

/**
 * Impact is `High | Medium | Low | Holiday`. Unknown values are kept as-is
 * rather than rejected: a new level must not break the whole feed, it just
 * will not match the High filter.
 */
const RawEventSchema = z.object({
  title: z.string().min(1).max(300),
  country: z.string().max(10),
  date: z.string().min(10).max(40),
  impact: z.string().max(20),
  forecast: z.string().max(40).optional().default(''),
  previous: z.string().max(40).optional().default(''),
});

/** The feed is a bare array. Anything else is a shape change we must notice. */
export const ForexFactoryFeedSchema = z.array(RawEventSchema).max(1000);

export type RawForexEvent = z.infer<typeof RawEventSchema>;

export interface CalendarEvent {
  title: string;
  /** Currency code (USD, EUR, …) or 'All'. */
  currency: string;
  /** The parsed instant. */
  at: Date;
  /** `HH:MM` in the configured local timezone. */
  localTime: string;
  /** `YYYY-MM-DD` in the configured local timezone. */
  localDate: string;
  impact: string;
  forecast: string;
  previous: string;
  /** Stable key for matching analysis back to the event. */
  ref: string;
}

/** Flags for the currencies the feed actually emits. */
const CURRENCY_FLAGS: Record<string, string> = {
  USD: '🇺🇸',
  EUR: '🇪🇺',
  GBP: '🇬🇧',
  JPY: '🇯🇵',
  CHF: '🇨🇭',
  CAD: '🇨🇦',
  AUD: '🇦🇺',
  NZD: '🇳🇿',
  CNY: '🇨🇳',
  All: '🌐',
};

export const currencyFlag = (currency: string): string => CURRENCY_FLAGS[currency] ?? '🏳️';

/** Persian names, so the message does not mix scripts awkwardly. */
const CURRENCY_NAMES: Record<string, string> = {
  USD: 'دلار آمریکا',
  EUR: 'یورو',
  GBP: 'پوند انگلیس',
  JPY: 'ین ژاپن',
  CHF: 'فرانک سوئیس',
  CAD: 'دلار کانادا',
  AUD: 'دلار استرالیا',
  NZD: 'دلار نیوزیلند',
  CNY: 'یوان چین',
  All: 'عمومی',
};

export const currencyName = (currency: string): string => CURRENCY_NAMES[currency] ?? currency;

export type CalendarFetchFailure = 'timeout' | 'network' | 'http_status' | 'invalid_json' | 'invalid_shape';

export class CalendarSourceError extends Error {
  constructor(
    readonly failure: CalendarFetchFailure,
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'CalendarSourceError';
  }
}

export interface FetchCalendarOptions {
  kv?: KVNamespace;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Set true to bypass the cache (used by a manual admin refresh). */
  force?: boolean;
}

export interface CalendarFeedResult {
  events: RawForexEvent[];
  source: 'cache' | 'origin';
}

/**
 * Returns the raw weekly feed, from KV when possible.
 *
 * Throws `CalendarSourceError` when the feed cannot be obtained or validated.
 * Callers MUST surface that to the operator instead of inventing a list.
 */
export async function fetchCalendarFeed(
  opts: FetchCalendarOptions = {}
): Promise<CalendarFeedResult> {
  if (!opts.force) {
    const cached = await kvGetJson(opts.kv, CALENDAR_CACHE_KEY, ForexFactoryFeedSchema);
    if (cached) return { events: cached, source: 'cache' };
  }

  let res: Response;
  try {
    res = await safeFetch(FOREX_FACTORY_URL, {
      headers: { accept: 'application/json' },
      timeoutMs: opts.timeoutMs ?? CALENDAR_FETCH_TIMEOUT_MS,
      fetchImpl: opts.fetchImpl,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      throw new CalendarSourceError(
        error.failure === 'timeout' ? 'timeout' : 'network',
        describeError(error)
      );
    }
    throw new CalendarSourceError('network', describeError(error));
  }

  if (!res.ok) {
    // 403 here usually means Cloudflare/the CDN is blocking the Worker.
    throw new CalendarSourceError('http_status', `منبع تقویم پاسخ ${res.status} داد.`, res.status);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(await res.text());
  } catch {
    throw new CalendarSourceError('invalid_json', 'پاسخ منبع تقویم JSON معتبر نبود.');
  }

  const parsed = ForexFactoryFeedSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new CalendarSourceError('invalid_shape', 'ساختار داده‌های تقویم تغییر کرده است.');
  }

  await kvPutJson(opts.kv, CALENDAR_CACHE_KEY, parsed.data, CALENDAR_CACHE_TTL_SECONDS);
  return { events: parsed.data, source: 'origin' };
}

/**
 * Converts raw rows into local-time events, keeping only valid dates.
 *
 * `new Date(iso)` honours the embedded offset, so the instant is correct;
 * `Intl` then places it on the right local day.
 */
export function toCalendarEvents(
  raw: readonly RawForexEvent[],
  timeZone: string
): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  for (const row of raw) {
    const at = new Date(row.date);
    if (Number.isNaN(at.getTime())) continue;
    events.push({
      title: row.title,
      currency: row.country,
      at,
      localTime: localTimeHm(at, timeZone),
      localDate: localDateKey(at, timeZone),
      impact: row.impact,
      forecast: row.forecast ?? '',
      previous: row.previous ?? '',
      ref: `${row.country}|${row.date}|${row.title}`.slice(0, 160),
    });
  }
  return events;
}

/** True for the high-impact ("red folder") rows. Case-insensitive. */
export const isHighImpact = (event: { impact: string }): boolean =>
  event.impact.trim().toLowerCase() === 'high';

/**
 * High-impact events falling on `now`'s local day, earliest first.
 *
 * Sorting is by the true instant, not the formatted string, so a run that
 * straddles midnight still orders correctly.
 */
export function selectTodayHighImpact(
  events: readonly CalendarEvent[],
  timeZone: string,
  now: Date
): CalendarEvent[] {
  const today = localDateKey(now, timeZone);
  return events
    .filter((event) => isHighImpact(event) && event.localDate === today)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
}

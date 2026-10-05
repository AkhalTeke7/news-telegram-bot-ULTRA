import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildCalendarMessages,
  formatCalendarEvent,
  runCalendarJob,
} from '../src/calendar/job';
import {
  CALENDAR_CACHE_KEY,
  CalendarSourceError,
  currencyFlag,
  currencyName,
  fetchCalendarFeed,
  FOREX_FACTORY_URL,
  isHighImpact,
  selectTodayHighImpact,
  toCalendarEvents,
} from '../src/calendar/forexFactory';
import {
  ANALYSIS_DISCLAIMER,
  assertScenarioLanguage,
  isSafeCalendarAnalysis,
  renderCalendarAnalysis,
  withDisclaimer,
  type CalendarAnalysis,
} from '../src/analysis/marketImpact';

const TZ = 'Asia/Tehran';

/**
 * Real rows copied verbatim from the live feed on 2026-10-05, including the
 * New York offset and the empty forecast/previous strings.
 */
const REAL_FEED = [
  {
    title: 'BOJ Gov Ueda Speaks',
    country: 'JPY',
    date: '2026-10-06T01:30:00-04:00',
    impact: 'High',
    forecast: '',
    previous: '',
  },
  {
    title: 'FOMC Meeting Minutes',
    country: 'USD',
    date: '2026-10-07T14:00:00-04:00',
    impact: 'High',
    forecast: '',
    previous: '',
  },
  {
    title: 'Employment Change',
    country: 'CAD',
    date: '2026-10-09T08:30:00-04:00',
    impact: 'High',
    forecast: '9.0K',
    previous: '-41.7K',
  },
  {
    title: 'Unemployment Rate',
    country: 'CAD',
    date: '2026-10-09T08:30:00-04:00',
    impact: 'High',
    forecast: '6.5%',
    previous: '6.4%',
  },
  {
    title: 'Flash Manufacturing PMI',
    country: 'EUR',
    date: '2026-10-07T04:00:00-04:00',
    impact: 'Medium',
    forecast: '49.5',
    previous: '49.2',
  },
  {
    title: 'Bank Holiday',
    country: 'CNY',
    date: '2026-10-07T00:00:00-04:00',
    impact: 'Holiday',
    forecast: '',
    previous: '',
  },
];

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(async () => {
  // The Worker shares one KV namespace across tests; a feed cached by an
  // earlier test would mask the origin behaviour this file asserts.
  await env.KV?.delete(CALENDAR_CACHE_KEY);
  await env.DB.prepare(`DELETE FROM job_claims`).run();
  await env.DB.prepare(`DELETE FROM job_runs`).run();
  await env.DB.prepare(`DELETE FROM llm_usage`).run();
});

/* ------------------------------------------------------------ the feed --- */

describe('forex factory feed', () => {
  it('points at the one accepted source', () => {
    expect(FOREX_FACTORY_URL).toBe('https://nfs.faireconomy.media/ff_calendar_thisweek.json');
  });

  it('parses the real payload shape', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      expect(String(input)).toBe(FOREX_FACTORY_URL);
      return jsonResponse(REAL_FEED);
    };
    const { events, source } = await fetchCalendarFeed({ fetchImpl });
    expect(source).toBe('origin');
    expect(events).toHaveLength(6);
    expect(events[0].title).toBe('BOJ Gov Ueda Speaks');
  });

  it('converts the New York offset to the configured local day, not by slicing', () => {
    // 2026-10-06T01:30-04:00 == 05:30 UTC == 09:00 Tehran on the 6th.
    const [boj] = toCalendarEvents([REAL_FEED[0]], TZ);
    expect(boj.localDate).toBe('2026-10-06');
    expect(boj.localTime).toBe('09:00');

    // 2026-10-07T14:00-04:00 == 18:00 UTC == 21:30 Tehran, still the 7th.
    const [fomc] = toCalendarEvents([REAL_FEED[1]], TZ);
    expect(fomc.localDate).toBe('2026-10-07');
    expect(fomc.localTime).toBe('21:30');
  });

  it('rolls an evening New York event onto the NEXT Tehran day', () => {
    // 20:00 New York == 00:00 UTC+0 next day == 03:30 Tehran next day.
    const [late] = toCalendarEvents(
      [{ ...REAL_FEED[1], date: '2026-10-07T20:00:00-04:00' }],
      TZ
    );
    expect(late.localDate).toBe('2026-10-08');
    expect(late.localTime).toBe('03:30');
  });

  it('keeps only High impact, ignoring Medium, Low and Holiday', () => {
    const events = toCalendarEvents(REAL_FEED, TZ);
    expect(events.filter(isHighImpact)).toHaveLength(4);
    expect(isHighImpact({ impact: 'high' })).toBe(true);
    expect(isHighImpact({ impact: 'Holiday' })).toBe(false);
  });

  it('selects today only, sorted by the true instant', () => {
    const events = toCalendarEvents(REAL_FEED, TZ);
    const today = selectTodayHighImpact(events, TZ, new Date('2026-10-09T06:00:00Z'));
    expect(today.map((e) => e.title)).toEqual(['Employment Change', 'Unemployment Rate']);
    expect(today[0].at.getTime()).toBeLessThanOrEqual(today[1].at.getTime());
  });

  it('returns nothing on a day with no red events', () => {
    const events = toCalendarEvents(REAL_FEED, TZ);
    expect(selectTodayHighImpact(events, TZ, new Date('2026-10-11T06:00:00Z'))).toHaveLength(0);
  });

  it('drops rows with an unparseable date rather than guessing', () => {
    const events = toCalendarEvents(
      [...REAL_FEED, { ...REAL_FEED[0], date: 'not-a-date' }],
      TZ
    );
    expect(events).toHaveLength(REAL_FEED.length);
  });

  it('throws instead of inventing data when the source is blocked', async () => {
    const fetchImpl: typeof fetch = async () => new Response('forbidden', { status: 403 });
    await expect(fetchCalendarFeed({ fetchImpl })).rejects.toBeInstanceOf(CalendarSourceError);
    await fetchCalendarFeed({ fetchImpl }).catch((e: CalendarSourceError) => {
      expect(e.failure).toBe('http_status');
      expect(e.status).toBe(403);
    });
  });

  it('throws on a changed shape instead of half-reading it', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ events: REAL_FEED });
    await fetchCalendarFeed({ fetchImpl }).catch((e: CalendarSourceError) => {
      expect(e.failure).toBe('invalid_shape');
    });
    await expect(fetchCalendarFeed({ fetchImpl })).rejects.toBeInstanceOf(CalendarSourceError);
  });

  it('throws on invalid json', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('<html>blocked</html>', { headers: { 'content-type': 'application/json' } });
    await expect(fetchCalendarFeed({ fetchImpl })).rejects.toBeInstanceOf(CalendarSourceError);
  });

  it('throws on a network failure', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('connection reset');
    };
    await expect(fetchCalendarFeed({ fetchImpl })).rejects.toBeInstanceOf(CalendarSourceError);
  });

  it('serves from KV and only hits the origin once', async () => {
    let hits = 0;
    const fetchImpl: typeof fetch = async () => {
      hits++;
      return jsonResponse(REAL_FEED);
    };
    const store = new Map<string, string>();
    const kv = {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => void store.set(key, value),
      delete: async (key: string) => void store.delete(key),
    } as unknown as KVNamespace;

    await fetchCalendarFeed({ kv, fetchImpl });
    const second = await fetchCalendarFeed({ kv, fetchImpl });
    expect(hits).toBe(1);
    expect(second.source).toBe('cache');
    expect(store.has(CALENDAR_CACHE_KEY)).toBe(true);

    // force bypasses the cache.
    await fetchCalendarFeed({ kv, fetchImpl, force: true });
    expect(hits).toBe(2);
  });

  it('labels the currencies the feed actually emits', () => {
    expect(currencyFlag('USD')).toBe('🇺🇸');
    expect(currencyName('CAD')).toBe('دلار کانادا');
    // `All` is a real value in this feed and must not render as a blank.
    expect(currencyFlag('All')).toBe('🌐');
    expect(currencyName('XYZ')).toBe('XYZ');
  });
});

/* ------------------------------------------------------- task 4 guards --- */

describe('market impact guardrails', () => {
  const safe: CalendarAnalysis = {
    i: 0,
    event: 'Employment Change',
    if_higher_than_forecast: 'معمولاً دلار کانادا تقویت می‌شود.',
    if_lower_than_forecast: 'اغلب فشار فروش روی دلار کانادا بیشتر می‌شود.',
    affected_assets: ['دلار کانادا', 'نفت'],
    volatility: 'high',
    note: '',
  };

  it('accepts conditional language', () => {
    expect(assertScenarioLanguage('معمولاً دلار تقویت می‌شود.').ok).toBe(true);
    expect(isSafeCalendarAnalysis(safe)).toBe(true);
  });

  it('rejects certainty', () => {
    expect(assertScenarioLanguage('قطعاً طلا رشد می‌کند.').ok).toBe(false);
    expect(assertScenarioLanguage('حتماً دلار ریزش می‌کند.').reason).toBe('certainty');
  });

  it('rejects buy/sell advice', () => {
    expect(assertScenarioLanguage('همین حالا طلا بخرید.').ok).toBe(false);
    expect(assertScenarioLanguage('حد ضرر را اینجا بگذارید.').reason).toBe('trade_levels');
    expect(assertScenarioLanguage('Buy now before it moves.').ok).toBe(false);
  });

  it('rejects English directional predictions', () => {
    expect(assertScenarioLanguage('Gold will rise after the print.').ok).toBe(false);
  });

  it('rejects invented numbers in calendar analysis but allows them for breaking news', () => {
    expect(assertScenarioLanguage('طلا تا ۲۴۵۰ دلار می‌رود.').ok).toBe(false);
    expect(assertScenarioLanguage('طلا تا ۲۴۵۰ دلار می‌رود.', true).ok).toBe(true);
  });

  it('drops an unsafe analysis wholesale', () => {
    expect(
      isSafeCalendarAnalysis({ ...safe, if_higher_than_forecast: 'قطعاً دلار بالا می‌رود.' })
    ).toBe(false);
  });

  it('renders the analysis block with both scenarios', () => {
    const lines = renderCalendarAnalysis(safe);
    expect(lines[0]).toContain('اگر بالاتر از پیش‌بینی');
    expect(lines[1]).toContain('اگر پایین‌تر از پیش‌بینی');
    expect(lines[2]).toContain('دلار کانادا، نفت');
    expect(lines[3]).toContain('زیاد');
    expect(renderCalendarAnalysis(undefined)).toEqual([]);
  });

  it('appends the mandatory disclaimer exactly once', () => {
    const once = withDisclaimer('متن');
    expect(once).toContain(ANALYSIS_DISCLAIMER);
    expect(withDisclaimer(once)).toBe(once);
  });
});

/* ------------------------------------------------------------ formatting -- */

describe('calendar message formatting', () => {
  const [, , employment] = toCalendarEvents(REAL_FEED, TZ);

  it('shows time, red dot, currency, title and both figures', () => {
    const lines = formatCalendarEvent(employment, undefined);
    expect(lines[0]).toContain('🔴');
    expect(lines[0]).toContain('۱۶:۰۰'); // 08:30 New York == 16:00 Tehran
    expect(lines[0]).toContain('🇨🇦');
    expect(lines[1]).toContain('Employment Change');
    expect(lines[2]).toContain('پیش‌بینی: 9.0K');
    expect(lines[2]).toContain('قبلی: -41.7K');
  });

  it('prints a dash when the feed has no forecast or previous', () => {
    const [boj] = toCalendarEvents(REAL_FEED, TZ);
    expect(formatCalendarEvent(boj, undefined)[2]).toBe('   پیش‌بینی: — | قبلی: —');
  });

  it('adds the disclaimer only when analysis is present', () => {
    const events = toCalendarEvents(REAL_FEED, TZ).filter(isHighImpact);
    const without = buildCalendarMessages(events, new Map(), '۱۳ مهر ۱۴۰۵', false);
    expect(without.join('')).not.toContain(ANALYSIS_DISCLAIMER);

    const analysis: CalendarAnalysis = {
      i: 0,
      event: events[0].title,
      if_higher_than_forecast: 'معمولاً ین تقویت می‌شود.',
      if_lower_than_forecast: 'اغلب ین تضعیف می‌شود.',
      affected_assets: ['ین'],
      volatility: 'medium',
      note: '',
    };
    const withIt = buildCalendarMessages(
      events,
      new Map([[events[0].ref, analysis]]),
      '۱۳ مهر ۱۴۰۵',
      true
    );
    expect(withIt.every((m) => m.includes(ANALYSIS_DISCLAIMER))).toBe(true);
  });

  it('splits long lists on event boundaries, never mid-event', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      ...REAL_FEED[2],
      title: `Very long economic event title number ${i} `.repeat(3),
      date: `2026-10-09T0${i % 9}:30:00-04:00`,
    }));
    const events = toCalendarEvents(many, TZ);
    const messages = buildCalendarMessages(events, new Map(), '۱۳ مهر ۱۴۰۵', false);
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(4096);
      // A split must not orphan a title from its figures line.
      const titles = (message.match(/📌/g) ?? []).length;
      const figures = (message.match(/پیش‌بینی:/g) ?? []).length;
      expect(titles).toBe(figures);
    }
  });
});

/* -------------------------------------------------------------- the job -- */

describe('runCalendarJob', () => {
  const baseEnv = () => ({
    ...env,
    TELEGRAM_BOT_TOKEN: 'T',
    TELEGRAM_DESTINATION_CHANNEL: '@mychannel',
    TIMEZONE: TZ,
  });

  const feedAndTelegram = (sent: string[], feed: unknown = REAL_FEED) => {
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === FOREX_FACTORY_URL) return jsonResponse(feed);
      if (url.includes('/sendMessage')) {
        sent.push(JSON.parse(String((init as RequestInit).body)).text);
        return jsonResponse({ ok: true, result: { message_id: sent.length, date: 0 } });
      }
      throw new Error(`unexpected call: ${url}`);
    };
    return fetchImpl;
  };

  it('sends the red list once and records the claim', async () => {
    const sent: string[] = [];
    const result = await runCalendarJob(baseEnv() as never, {
      now: new Date('2026-10-09T06:00:00Z'),
      fetchImpl: feedAndTelegram(sent),
    });

    expect(result.status).toBe('success');
    expect(result.events).toBe(2);
    expect(result.messages).toBe(1);
    expect(sent[0]).toContain('Employment Change');
    expect(sent[0]).toContain('Unemployment Rate');
    // Medium/Holiday rows must never appear.
    expect(sent[0]).not.toContain('Flash Manufacturing PMI');
    expect(sent[0]).not.toContain('Bank Holiday');

    const claim = await env.DB.prepare(
      `SELECT status, claim_date FROM job_claims WHERE job = 'calendar'`
    ).first<{ status: string; claim_date: string }>();
    expect(claim?.status).toBe('sent');
    expect(claim?.claim_date).toBe('2026-10-09');
  });

  it('never double-sends, however many times it is invoked', async () => {
    const sent: string[] = [];
    const now = new Date('2026-10-09T06:00:00Z');
    const fetchImpl = feedAndTelegram(sent);

    const results = await Promise.all([
      runCalendarJob(baseEnv() as never, { now, fetchImpl }),
      runCalendarJob(baseEnv() as never, { now, fetchImpl }),
      runCalendarJob(baseEnv() as never, { now, fetchImpl }),
    ]);
    const later = await runCalendarJob(baseEnv() as never, { now, fetchImpl });

    expect(sent).toHaveLength(1);
    expect(results.filter((r) => r.status === 'success')).toHaveLength(1);
    expect(results.filter((r) => r.alreadyClaimed)).toHaveLength(2);
    expect(later.alreadyClaimed).toBe(true);
  });

  it('sends nothing at all when today has no red events', async () => {
    const sent: string[] = [];
    const result = await runCalendarJob(baseEnv() as never, {
      now: new Date('2026-10-11T06:00:00Z'),
      fetchImpl: feedAndTelegram(sent),
    });
    expect(result.status).toBe('success');
    expect(result.reason).toBe('no_high_impact_events');
    expect(sent).toHaveLength(0);

    const claim = await env.DB.prepare(
      `SELECT status FROM job_claims WHERE job = 'calendar'`
    ).first<{ status: string }>();
    // 'skipped' keeps the day claimed so we do not re-check all day.
    expect(claim?.status).toBe('skipped');
  });

  it('releases the claim when the source is blocked, so a retry can work', async () => {
    let attempt = 0;
    const sent: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === FOREX_FACTORY_URL) {
        attempt++;
        return attempt === 1 ? new Response('blocked', { status: 403 }) : jsonResponse(REAL_FEED);
      }
      if (url.includes('/sendMessage')) {
        sent.push(JSON.parse(String((init as RequestInit).body)).text);
        return jsonResponse({ ok: true, result: { message_id: 1, date: 0 } });
      }
      throw new Error(`unexpected: ${url}`);
    };

    const now = new Date('2026-10-09T06:00:00Z');
    const failed = await runCalendarJob(baseEnv() as never, { now, fetchImpl });
    expect(failed.status).toBe('failed');
    expect(failed.reason).toBe('source_http_status_403');
    expect(sent).toHaveLength(0);

    // The claim was released, so the next cron firing retries the same day.
    const afterFailure = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM job_claims WHERE job = 'calendar'`
    ).first<{ n: number }>();
    expect(afterFailure?.n).toBe(0);

    const retried = await runCalendarJob(baseEnv() as never, { now, fetchImpl });
    expect(retried.status).toBe('success');
    expect(sent).toHaveLength(1);
  });

  it('rides out a transient source outage from the KV cache (real data, not invented)', async () => {
    const sent: string[] = [];
    let blocked = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === FOREX_FACTORY_URL) {
        return blocked ? new Response('blocked', { status: 403 }) : jsonResponse(REAL_FEED);
      }
      if (url.includes('/sendMessage')) {
        sent.push(JSON.parse(String((init as RequestInit).body)).text);
        return jsonResponse({ ok: true, result: { message_id: 1, date: 0 } });
      }
      throw new Error(`unexpected: ${url}`);
    };

    // Day 1 populates the cache.
    await runCalendarJob(baseEnv() as never, {
      now: new Date('2026-10-09T06:00:00Z'),
      fetchImpl,
    });
    expect(sent).toHaveLength(1);

    // Day 2 the origin is blocked, but the cached WEEKLY file still covers it.
    blocked = true;
    const next = await runCalendarJob(baseEnv() as never, {
      now: new Date('2026-10-07T06:00:00Z'),
      fetchImpl,
    });
    expect(next.status).toBe('success');
    expect(sent[1]).toContain('FOMC Meeting Minutes');
  });

  it('keeps the claim when Telegram fails mid-list, so nothing is re-posted', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === FOREX_FACTORY_URL) return jsonResponse(REAL_FEED);
      if (url.includes('/sendMessage')) {
        return jsonResponse({ ok: false, description: 'CHAT_WRITE_FORBIDDEN' }, 403);
      }
      throw new Error(`unexpected: ${url}`);
    };

    const result = await runCalendarJob(baseEnv() as never, {
      now: new Date('2026-10-09T06:00:00Z'),
      fetchImpl,
    });
    expect(result.status).toBe('failed');

    // Deliberately NOT released: the outcome of the send is unknown.
    const claim = await env.DB.prepare(
      `SELECT status FROM job_claims WHERE job = 'calendar'`
    ).first<{ status: string }>();
    expect(claim?.status).toBe('sent');
  });

  it('still sends the plain list when the LLM is unavailable', async () => {
    const sent: string[] = [];
    const result = await runCalendarJob(
      // No provider keys at all => analyzeCalendarEvents returns an empty map.
      baseEnv() as never,
      { now: new Date('2026-10-09T06:00:00Z'), fetchImpl: feedAndTelegram(sent) }
    );
    expect(result.status).toBe('success');
    expect(result.analyzed).toBe(0);
    expect(sent[0]).toContain('Employment Change');
    // No analysis => no disclaimer, because there is nothing to disclaim.
    expect(sent[0]).not.toContain(ANALYSIS_DISCLAIMER);
  });

  it('refuses to run without a destination', async () => {
    const result = await runCalendarJob(
      { ...baseEnv(), TELEGRAM_DESTINATION_CHANNEL: '' } as never,
      { now: new Date('2026-10-09T06:00:00Z') }
    );
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('destination_or_token_missing');
  });
});

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { decodeXmlText, parseFeed, parseFeedDate, recentEntries } from '../src/breaking/rss';
import { prefilter } from '../src/breaking/filter';
import {
  alertsSentToday,
  alreadyAlerted,
  confirmationBonus,
  confirmingSourceIds,
  pruneSightings,
  recordAlert,
  recordSighting,
  storyKeyFor,
} from '../src/breaking/confirm';
import { BREAKING_SOURCES, REJECTED_SOURCES, enabledSources } from '../src/breaking/sources';
import { formatAlert, loadSource, runBreakingJob } from '../src/breaking/job';
import { ANALYSIS_DISCLAIMER } from '../src/analysis/marketImpact';

const TZ = 'Asia/Tehran';
const NOW = new Date('2026-10-05T08:30:00Z');

/** BBC-style RSS: CDATA titles, RFC-822 dates, tracking params on links. */
const BBC_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title><![CDATA[BBC News]]></title>
  <item>
    <title><![CDATA[G7 to release millions of barrels of oil after OPEC output cut]]></title>
    <description><![CDATA[Energy ministers agreed an emergency release.]]></description>
    <link>https://www.bbc.co.uk/news/articles/ck87zg8jnwngo?at_medium=RSS&amp;at_campaign=rss</link>
    <pubDate>Mon, 05 Oct 2026 08:20:00 GMT</pubDate>
  </item>
  <item>
    <title><![CDATA[The job interview question you don't have to answer]]></title>
    <description><![CDATA[Careers advice.]]></description>
    <link>https://www.bbc.co.uk/news/articles/cje3r35p0qeno</link>
    <pubDate>Sun, 04 Oct 2026 23:22:07 GMT</pubDate>
  </item>
</channel></rss>`;

/** CNBC-style: same story, different wording, independent newsroom. */
const CNBC_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <title>OPEC output cut prompts G7 oil release of millions of barrels</title>
    <description>Crude prices moved after the announcement.</description>
    <link>https://www.cnbc.com/2026/10/05/opec-g7-oil.html</link>
    <pubDate>Mon, 05 Oct 2026 08:25:00 GMT</pubDate>
  </item>
</channel></rss>`;

/** Atom, to prove the parser is not RSS-only. */
const ATOM_XML = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Federal Reserve announces emergency rate decision</title>
    <link rel="alternate" href="https://www.federalreserve.gov/newsevents/pressreleases/monetary20261005a.htm"/>
    <summary>The Board announced a change to the target range.</summary>
    <updated>2026-10-05T08:10:00Z</updated>
  </entry>
</feed>`;

const xmlResponse = (body: string) =>
  new Response(body, { headers: { 'content-type': 'application/rss+xml' } });

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const TEST_SOURCES = [
  { id: 'bbc', name: 'BBC', url: 'https://bbc.test/rss', group: 'bbc', weight: 1 as const, enabled: true },
  { id: 'cnbc', name: 'CNBC', url: 'https://cnbc.test/rss', group: 'cnbc', weight: 1 as const, enabled: true },
];

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM breaking_seen`).run();
  await env.DB.prepare(`DELETE FROM breaking_alerts`).run();
  await env.DB.prepare(`DELETE FROM llm_usage`).run();
});

/* ------------------------------------------------------------- sources -- */

describe('feed configuration', () => {
  it('ships only feeds verified live on 2026-10-05', () => {
    expect(enabledSources()).toHaveLength(7);
    for (const source of BREAKING_SOURCES) {
      expect(source.url).toMatch(/^https:\/\//);
      expect(source.id).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('keeps the dead and stale feeds documented so they are not re-added', () => {
    const urls = REJECTED_SOURCES.map((r) => r.url);
    expect(urls).toContain('https://feeds.reuters.com/reuters/businessNews');
    expect(urls).toContain('https://www.investing.com/rss/news_285.rss');
    // and they must not have crept back into the live list
    for (const url of urls) {
      expect(BREAKING_SOURCES.some((s) => s.url === url)).toBe(false);
    }
  });

  it('gives the central bank a higher weight than ordinary outlets', () => {
    const fed = BREAKING_SOURCES.find((s) => s.id === 'fed-press');
    expect(fed?.weight).toBe(2);
  });

  it('assigns a distinct group per newsroom so nothing confirms itself', () => {
    const groups = BREAKING_SOURCES.map((s) => s.group);
    expect(new Set(groups).size).toBe(groups.length);
  });
});

/* ----------------------------------------------------------- rss parse -- */

describe('feed parsing', () => {
  it('parses RSS with CDATA and entity-escaped links', () => {
    const entries = parseFeed(BBC_XML);
    expect(entries).toHaveLength(2);
    expect(entries[0].title).toBe(
      'G7 to release millions of barrels of oil after OPEC output cut'
    );
    expect(entries[0].link).toContain('at_campaign=rss');
    expect(entries[0].link).not.toContain('&amp;');
    expect(entries[0].publishedAt?.toISOString()).toBe('2026-10-05T08:20:00.000Z');
  });

  it('parses Atom entries and their href links', () => {
    const entries = parseFeed(ATOM_XML);
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toContain('emergency rate decision');
    expect(entries[0].link).toContain('federalreserve.gov');
    expect(entries[0].description).toContain('target range');
  });

  it('repairs the mojibake OilPrice serves', () => {
    expect(decodeXmlText('Oil â€” the big squeeze')).toBe('Oil — the big squeeze');
    expect(decodeXmlText('Brentâ€™s rally')).toBe('Brent’s rally');
  });

  it('decodes numeric and hex entities', () => {
    expect(decodeXmlText('AT&#38;T and &#x26; more')).toBe('AT&T and & more');
  });

  it('strips embedded html from descriptions', () => {
    expect(decodeXmlText('<p>Hello <b>world</b></p>')).toBe('Hello world');
  });

  it('returns null rather than "now" for a missing or broken date', () => {
    expect(parseFeedDate('<item><title>x</title></item>')).toBeNull();
    expect(parseFeedDate('<item><pubDate>not a date</pubDate></item>')).toBeNull();
  });

  it('ignores items with no title or no link', () => {
    expect(parseFeed('<rss><item><title>No link</title></item></rss>')).toHaveLength(0);
    expect(parseFeed('<rss><item><link>https://a.test/x</link></item></rss>')).toHaveLength(0);
  });

  it('never throws on garbage input', () => {
    expect(parseFeed('')).toEqual([]);
    expect(parseFeed('<html><body>not a feed</body></html>')).toEqual([]);
    expect(parseFeed('<item><item><item>')).toEqual([]);
  });

  it('keeps fresh items, drops stale ones, keeps undated ones', () => {
    const entries = [
      { title: 'fresh', link: 'a', description: '', publishedAt: new Date('2026-10-05T08:20:00Z') },
      { title: 'stale', link: 'b', description: '', publishedAt: new Date('2026-10-05T06:00:00Z') },
      { title: 'undated', link: 'c', description: '', publishedAt: null },
      { title: 'future', link: 'd', description: '', publishedAt: new Date('2026-10-06T08:00:00Z') },
    ];
    const kept = recentEntries(entries, NOW, 45).map((e) => e.title);
    expect(kept).toEqual(['fresh', 'undated']);
  });
});

/* -------------------------------------------------------------- filter -- */

describe('keyword pre-filter', () => {
  it('passes central bank and macro headlines', () => {
    expect(prefilter('Federal Reserve announces surprise rate cut').passed).toBe(true);
    expect(prefilter('US CPI comes in hotter than expected').passed).toBe(true);
    expect(prefilter('OPEC agrees surprise production cut').passed).toBe(true);
  });

  it('passes geopolitical and credit shocks', () => {
    expect(prefilter('Russia declares war, missile strike hits port').passed).toBe(true);
    expect(prefilter('Argentina defaults on sovereign debt').passed).toBe(true);
  });

  it('rejects ordinary business and lifestyle coverage', () => {
    expect(prefilter('The job interview question you do not have to answer').passed).toBe(false);
    expect(prefilter('Starting a watch collection? What beginners should know').passed).toBe(false);
    expect(prefilter('Chick-fil-A wants to stay a family business').passed).toBe(false);
  });

  it('vetoes sport and celebrity outright', () => {
    const verdict = prefilter('Premier League clubs surge in record high TV deal');
    expect(verdict.passed).toBe(false);
    expect(verdict.score).toBe(0);
  });

  it('weights the headline above the body', () => {
    const inTitle = prefilter('OPEC output cut agreed', '');
    const inBody = prefilter('Energy ministers meet', 'They discussed an OPEC output cut.');
    expect(inTitle.score).toBeGreaterThan(inBody.score);
  });

  it('reports which terms matched, for debugging', () => {
    const verdict = prefilter('Fed chair signals rate cut as CPI cools');
    expect(verdict.hits.map((h) => h.term)).toContain('rate cut');
    expect(verdict.hits.map((h) => h.term)).toContain('cpi');
  });
});

/* -------------------------------------------------- confirmation in D1 -- */

describe('cross-source confirmation', () => {
  it('matches the same story written two different ways', () => {
    // Real pair from 2026-10-05: BBC and CNBC on the same G7/OPEC story.
    expect(storyKeyFor('G7 to release millions of barrels of oil after OPEC output cut')).toBe(
      storyKeyFor('OPEC output cut prompts G7 oil release of millions of barrels')
    );
    // Light stemming absorbs plural/tense differences too.
    expect(storyKeyFor('Fed cuts interest rates')).toBe(storyKeyFor('Interest rate cut by the Fed'));
  });

  it('does not collapse genuinely different stories', () => {
    expect(storyKeyFor('OPEC agrees output cut')).not.toBe(
      storyKeyFor('Fed announces emergency rate decision')
    );
  });

  it('counts distinct sources inside the 30 minute window', async () => {
    const key = storyKeyFor('OPEC agrees surprise output cut');
    await recordSighting(env.DB, key, 'bbc', 'OPEC agrees surprise output cut', 'https://a.test/1');
    await recordSighting(env.DB, key, 'cnbc', 'Surprise OPEC output cut agreed', 'https://b.test/1');
    expect((await confirmingSourceIds(env.DB, key, NOW)).sort()).toEqual(['bbc', 'cnbc']);
  });

  it('refuses to let one source confirm itself by republishing', async () => {
    const key = storyKeyFor('OPEC agrees surprise output cut');
    await recordSighting(env.DB, key, 'bbc', 'OPEC agrees surprise output cut', 'https://a.test/1');
    await recordSighting(env.DB, key, 'bbc', 'OPEC agrees surprise output cut', 'https://a.test/2');
    expect(await confirmingSourceIds(env.DB, key, NOW)).toEqual(['bbc']);
  });

  it('ignores sightings older than the window', async () => {
    const key = storyKeyFor('Old story about an OPEC output cut');
    await env.DB.prepare(
      `INSERT INTO breaking_seen (story_key, source_id, title, link, seen_at)
       VALUES (?1, 'bbc', 't', 'l', ?2)`
    )
      .bind(key, new Date(NOW.getTime() - 60 * 60_000).toISOString())
      .run();
    expect(await confirmingSourceIds(env.DB, key, NOW)).toEqual([]);
  });

  it('scales the bonus with independent corroboration', () => {
    expect(confirmationBonus(1)).toBe(0);
    expect(confirmationBonus(2)).toBe(1);
    expect(confirmationBonus(5)).toBe(2);
  });

  it('prunes sightings older than the retention window', async () => {
    await env.DB.prepare(
      `INSERT INTO breaking_seen (story_key, source_id, seen_at) VALUES ('k', 's', ?1)`
    )
      .bind(new Date(NOW.getTime() - 10 * 3_600_000).toISOString())
      .run();
    await pruneSightings(env.DB, NOW);
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM breaking_seen`).first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it('tracks what was alerted and how many went out today', async () => {
    expect(await alreadyAlerted(env.DB, 'k1')).toBe(false);
    await recordAlert(env.DB, {
      storyKey: 'k1',
      title: 't',
      score: 9,
      category: 'energy',
      localDate: '2026-10-05',
      messageId: 1,
    });
    expect(await alreadyAlerted(env.DB, 'k1')).toBe(true);
    expect(await alertsSentToday(env.DB, '2026-10-05')).toBe(1);
    expect(await alertsSentToday(env.DB, '2026-10-06')).toBe(0);
  });
});

/* -------------------------------------------------------- loading feeds -- */

describe('loadSource', () => {
  it('reports a parse success with its item count', async () => {
    const fetchImpl: typeof fetch = async () => xmlResponse(BBC_XML);
    const { entries, health } = await loadSource(TEST_SOURCES[0], fetchImpl);
    expect(health.ok).toBe(true);
    expect(health.items).toBe(2);
    expect(entries).toHaveLength(2);
  });

  it('reports a dead feed without throwing', async () => {
    const fetchImpl: typeof fetch = async () => new Response('gone', { status: 404 });
    const { health } = await loadSource(TEST_SOURCES[0], fetchImpl);
    expect(health.ok).toBe(false);
    expect(health.error).toBe('http_404');
  });

  it('reports a network error without throwing', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('ECONNRESET');
    };
    const { health } = await loadSource(TEST_SOURCES[0], fetchImpl);
    expect(health.ok).toBe(false);
    expect(health.error).toBeTruthy();
  });
});

/* ------------------------------------------------------------ the job --- */

describe('runBreakingJob', () => {
  const baseEnv = () => ({
    ...env,
    TELEGRAM_BOT_TOKEN: 'T',
    TELEGRAM_DESTINATION_CHANNEL: '@mychannel',
    TIMEZONE: TZ,
    // A key is required for the LLM stage to be attempted at all.
    OPENROUTER_API_KEY: 'sk-test',
  });

  /** Feeds + a scripted LLM reply + Telegram. */
  const makeFetch = (opts: {
    llm?: unknown;
    telegram?: (text: string) => Response;
    sent?: string[];
    feeds?: Record<string, string>;
  }) => {
    const feeds = opts.feeds ?? {
      'https://bbc.test/rss': BBC_XML,
      'https://cnbc.test/rss': CNBC_XML,
    };
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (feeds[url]) return xmlResponse(feeds[url]);
      if (url.includes('/chat/completions')) {
        return jsonResponse(
          opts.llm ?? {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    items: [
                      {
                        i: 0,
                        score: 9,
                        category: 'energy',
                        summary_fa: 'گروه هفت آزادسازی ذخایر نفتی را پس از کاهش تولید اوپک اعلام کرد.',
                        market_impact_fa:
                          'در صورت تأیید، معمولاً فشار فروش روی نفت بیشتر می‌شود و ارزهای کالایی تحت تأثیر قرار می‌گیرند.',
                        affected_assets: ['نفت', 'دلار کانادا'],
                      },
                    ],
                  }),
                },
              },
            ],
          }
        );
      }
      if (url.includes('/sendMessage')) {
        const text = JSON.parse(String((init as RequestInit).body)).text as string;
        opts.sent?.push(text);
        return opts.telegram
          ? opts.telegram(text)
          : jsonResponse({ ok: true, result: { message_id: 1, date: 0 } });
      }
      throw new Error(`unexpected call: ${url}`);
    };
    return fetchImpl;
  };

  it('alerts on a confirmed, high-scoring story', async () => {
    const sent: string[] = [];
    const result = await runBreakingJob(baseEnv() as never, {
      now: NOW,
      sources: TEST_SOURCES,
      fetchImpl: makeFetch({ sent }),
    });

    expect(result.status).toBe('success');
    expect(result.feedsOk).toBe(2);
    expect(result.sent).toBe(1);
    expect(sent).toHaveLength(1);

    // The alert carries everything the spec asks for.
    expect(sent[0]).toContain('🚨');
    expect(sent[0]).toContain('گروه هفت');
    expect(sent[0]).toContain('https://www.bbc.co.uk/news/articles/ck87zg8jnwngo');
    expect(sent[0]).toContain('اثر احتمالی بر بازار');
    expect(sent[0]).toContain(ANALYSIS_DISCLAIMER);
    // Two independent newsrooms carried it.
    expect(sent[0]).toContain('منبع مستقل');

    const row = await env.DB.prepare(
      `SELECT story_key, score, category, local_date FROM breaking_alerts`
    ).first<{ score: number; category: string; local_date: string }>();
    // 9 from the model + 1 for the second independent source.
    expect(row?.score).toBe(10);
    expect(row?.category).toBe('energy');
    expect(row?.local_date).toBe('2026-10-05');
  });

  it('never alerts twice for the same story', async () => {
    const sent: string[] = [];
    const fetchImpl = makeFetch({ sent });
    await runBreakingJob(baseEnv() as never, { now: NOW, sources: TEST_SOURCES, fetchImpl });
    const second = await runBreakingJob(baseEnv() as never, {
      now: new Date(NOW.getTime() + 5 * 60_000),
      sources: TEST_SOURCES,
      fetchImpl,
    });
    expect(sent).toHaveLength(1);
    expect(second.reason).toBe('all_already_alerted');
  });

  it('stays silent below the score threshold', async () => {
    const sent: string[] = [];
    const result = await runBreakingJob(baseEnv() as never, {
      now: NOW,
      sources: TEST_SOURCES,
      fetchImpl: makeFetch({
        sent,
        llm: {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  items: [
                    {
                      i: 0,
                      score: 5,
                      category: 'energy',
                      summary_fa: 'خبری با اهمیت متوسط.',
                      market_impact_fa: 'معمولاً اثر محدودی دارد.',
                      affected_assets: ['نفت'],
                    },
                  ],
                }),
              },
            },
          ],
        },
      }),
    });
    expect(result.sent).toBe(0);
    expect(result.reason).toBe('below_threshold');
    expect(sent).toHaveLength(0);
  });

  it('honours a configurable threshold', async () => {
    const sent: string[] = [];
    const result = await runBreakingJob(
      { ...baseEnv(), BREAKING_MIN_SCORE: '6' } as never,
      {
        now: NOW,
        sources: TEST_SOURCES,
        fetchImpl: makeFetch({
          sent,
          llm: {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    items: [
                      {
                        i: 0,
                        score: 6,
                        category: 'energy',
                        summary_fa: 'خبر متوسط اما مهم.',
                        market_impact_fa: 'در صورت تأیید، معمولاً نوسان بیشتر می‌شود.',
                        affected_assets: ['نفت'],
                      },
                    ],
                  }),
                },
              },
            ],
          },
        }),
      }
    );
    expect(result.sent).toBe(1);
  });

  it('enforces the daily cap', async () => {
    for (let i = 0; i < 8; i++) {
      await recordAlert(env.DB, {
        storyKey: `old-${i}`,
        title: 't',
        score: 9,
        category: 'markets',
        localDate: '2026-10-05',
        messageId: i,
      });
    }
    const sent: string[] = [];
    const result = await runBreakingJob(baseEnv() as never, {
      now: NOW,
      sources: TEST_SOURCES,
      fetchImpl: makeFetch({ sent }),
    });
    expect(result.reason).toContain('daily_cap_reached');
    expect(sent).toHaveLength(0);
    // The cap is checked BEFORE any feed is fetched.
    expect(result.feedsOk).toBe(0);
  });

  it('sends nothing when the LLM is unavailable (never an unscored alert)', async () => {
    const sent: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === 'https://bbc.test/rss') return xmlResponse(BBC_XML);
      if (url === 'https://cnbc.test/rss') return xmlResponse(CNBC_XML);
      if (url.includes('/chat/completions')) return new Response('down', { status: 503 });
      if (url.includes('/sendMessage')) {
        sent.push('x');
        return jsonResponse({ ok: true, result: { message_id: 1, date: 0 } });
      }
      throw new Error(`unexpected: ${url}`);
    };
    const result = await runBreakingJob(baseEnv() as never, {
      now: NOW,
      sources: TEST_SOURCES,
      fetchImpl,
    });
    expect(result.reason).toBe('no_scored_stories');
    expect(sent).toHaveLength(0);
  });

  it('drops an analysis that breaks the no-advice rule', async () => {
    const sent: string[] = [];
    const result = await runBreakingJob(baseEnv() as never, {
      now: NOW,
      sources: TEST_SOURCES,
      fetchImpl: makeFetch({
        sent,
        llm: {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  items: [
                    {
                      i: 0,
                      score: 10,
                      category: 'energy',
                      summary_fa: 'خبر مهم نفتی.',
                      market_impact_fa: 'همین حالا نفت بخرید، قطعاً رشد می‌کند.',
                      affected_assets: ['نفت'],
                    },
                  ],
                }),
              },
            },
          ],
        },
      }),
    });
    expect(result.scored).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('keeps working when some feeds are down', async () => {
    const sent: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === 'https://bbc.test/rss') return xmlResponse(BBC_XML);
      if (url === 'https://cnbc.test/rss') return new Response('nope', { status: 500 });
      if (url.includes('/chat/completions')) {
        return jsonResponse({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  items: [
                    {
                      i: 0,
                      score: 9,
                      category: 'energy',
                      summary_fa: 'آزادسازی ذخایر نفتی گروه هفت.',
                      market_impact_fa: 'در صورت تأیید، معمولاً نوسان نفت بیشتر می‌شود.',
                      affected_assets: ['نفت'],
                    },
                  ],
                }),
              },
            },
          ],
        });
      }
      if (url.includes('/sendMessage')) {
        sent.push(JSON.parse(String((init as RequestInit).body)).text);
        return jsonResponse({ ok: true, result: { message_id: 1, date: 0 } });
      }
      throw new Error(`unexpected: ${url}`);
    };

    const result = await runBreakingJob(baseEnv() as never, {
      now: NOW,
      sources: TEST_SOURCES,
      fetchImpl,
    });
    expect(result.status).toBe('partial');
    expect(result.feedsOk).toBe(1);
    expect(result.feedsFailed).toBe(1);
    expect(result.sent).toBe(1);
    // Only one source carried it, so no confirmation bonus is claimed.
    expect(sent[0]).not.toContain('منبع مستقل');
  });

  it('fails loudly when every feed is down', async () => {
    const fetchImpl: typeof fetch = async () => new Response('down', { status: 503 });
    const result = await runBreakingJob(baseEnv() as never, {
      now: NOW,
      sources: TEST_SOURCES,
      fetchImpl,
    });
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('all_feeds_failed');
  });

  it('records nothing when Telegram rejects the alert', async () => {
    const sent: string[] = [];
    const result = await runBreakingJob(baseEnv() as never, {
      now: NOW,
      sources: TEST_SOURCES,
      fetchImpl: makeFetch({
        sent,
        telegram: () => jsonResponse({ ok: false, description: 'CHAT_NOT_FOUND' }, 400),
      }),
    });
    expect(result.status).toBe('failed');
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM breaking_alerts`).first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it('skips the run entirely when no story passes the keyword filter', async () => {
    const boring = `<rss><channel><item><title>Starting a watch collection</title>
      <link>https://a.test/1</link><pubDate>Mon, 05 Oct 2026 08:20:00 GMT</pubDate></item></channel></rss>`;
    const result = await runBreakingJob(baseEnv() as never, {
      now: NOW,
      sources: [TEST_SOURCES[0]],
      fetchImpl: makeFetch({ feeds: { 'https://bbc.test/rss': boring } }),
    });
    expect(result.reason).toBe('no_candidates');
    expect(result.candidates).toBe(0);
  });
});

/* ----------------------------------------------------------- formatting -- */

describe('alert formatting', () => {
  it('includes headline, summary, link, impact and the disclaimer', () => {
    const text = formatAlert(
      {
        index: 0,
        score: 9,
        category: 'monetary_policy',
        summaryFa: 'فدرال رزرو نرخ بهره را کاهش داد.',
        marketImpactFa: 'معمولاً دلار تضعیف می‌شود.',
        affectedAssets: ['دلار', 'طلا'],
      },
      {
        source: { ...TEST_SOURCES[0], name: 'Federal Reserve' },
        entry: {
          title: 'Fed cuts rates',
          link: 'https://fed.test/1',
          description: '',
          publishedAt: NOW,
        },
        storyKey: 'k',
        prefilterScore: 6,
        confirmations: 3,
      },
      10,
      '۱۲:۰۰'
    );

    expect(text).toContain('🚨');
    expect(text).toContain('سیاست پولی');
    expect(text).toContain('فدرال رزرو نرخ بهره را کاهش داد.');
    expect(text).toContain('Fed cuts rates');
    expect(text).toContain('https://fed.test/1');
    expect(text).toContain('دلار، طلا');
    expect(text).toContain('+2 منبع مستقل دیگر');
    expect(text.trimEnd().endsWith(ANALYSIS_DISCLAIMER)).toBe(true);
    expect(text.length).toBeLessThanOrEqual(4096);
  });
});

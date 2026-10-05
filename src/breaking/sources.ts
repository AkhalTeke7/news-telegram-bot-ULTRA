/**
 * TASK 3 — the breaking-news feed list.
 *
 * Every URL here was fetched and inspected on 2026-10-05; the ones that were
 * dead or stale are recorded at the bottom of this file so nobody
 * re-adds them. `weight` expresses how much a source's bare word is worth:
 * a central bank publishing its own press release is stronger evidence than
 * a commodity blog, and it feeds the pre-filter score.
 *
 * Independence matters for cross-source confirmation. Two feeds owned by the
 * same newsroom (e.g. two CNBC sections) would confirm each other and defeat
 * the check, so `group` marks who really owns the byline — only DISTINCT
 * groups count toward confirmation.
 */

export interface BreakingSource {
  /** Stable id stored in `breaking_seen.source_id`. Never change it. */
  id: string;
  name: string;
  url: string;
  /** Owner of the newsroom; only distinct groups confirm each other. */
  group: string;
  /** 1 = ordinary outlet, 2 = primary/official source. */
  weight: 1 | 2;
  enabled: boolean;
}

export const BREAKING_SOURCES: readonly BreakingSource[] = [
  {
    id: 'bbc-business',
    name: 'BBC Business',
    url: 'https://feeds.bbci.co.uk/news/business/rss.xml',
    group: 'bbc',
    weight: 1,
    enabled: true,
  },
  {
    id: 'cnbc-top',
    name: 'CNBC Top News',
    url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html',
    group: 'cnbc',
    weight: 1,
    enabled: true,
  },
  {
    id: 'wsj-markets',
    name: 'WSJ Markets',
    url: 'https://feeds.content.dowjones.io/public/rss/RSSMarketsMain',
    group: 'dowjones',
    weight: 1,
    enabled: true,
  },
  {
    id: 'aljazeera-all',
    name: 'Al Jazeera',
    url: 'https://www.aljazeera.com/xml/rss/all.xml',
    group: 'aljazeera',
    weight: 1,
    enabled: true,
  },
  {
    id: 'oilprice-main',
    name: 'OilPrice.com',
    url: 'https://oilprice.com/rss/main',
    group: 'oilprice',
    weight: 1,
    enabled: true,
  },
  {
    // Returns 301 to /us/business/rss — safeFetch follows redirects.
    id: 'guardian-business',
    name: 'Guardian Business',
    url: 'https://www.theguardian.com/business/rss',
    group: 'guardian',
    weight: 1,
    enabled: true,
  },
  {
    // Primary source: the Fed publishing its own statements. Highest weight.
    id: 'fed-press',
    name: 'Federal Reserve',
    url: 'https://www.federalreserve.gov/feeds/press_all.xml',
    group: 'federalreserve',
    weight: 2,
    enabled: true,
  },
];

/**
 * Checked and REJECTED on 2026-10-05. Documented so they are not re-added:
 *
 *  - https://feeds.reuters.com/reuters/businessNews
 *      Discontinued. Reuters retired its public RSS feeds; the host no longer
 *      serves this path.
 *  - https://www.investing.com/rss/news_285.rss
 *      Returns HTTP 200 with a well-formed feed, but the content is frozen at
 *      2024-11-26. A stale feed is worse than a dead one: it looks healthy
 *      while silently never producing news.
 */
export const REJECTED_SOURCES = [
  { url: 'https://feeds.reuters.com/reuters/businessNews', reason: 'discontinued' },
  { url: 'https://www.investing.com/rss/news_285.rss', reason: 'stale since 2024-11-26' },
] as const;

export const enabledSources = (): BreakingSource[] => BREAKING_SOURCES.filter((s) => s.enabled);

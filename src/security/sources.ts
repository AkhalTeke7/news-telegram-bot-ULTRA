/**
 * TASK 6 — the security / bug-bounty writeup feed list.
 *
 * Every URL here was fetched and inspected on 2026-10-05. The ones with no
 * machine-readable feed are recorded in REJECTED_SOURCES at the bottom so
 * nobody re-adds them after another fruitless hour. See
 * docs/TASK6-SECURITY-DIGEST.md for the full survey.
 *
 * `kind` matters more than it looks. These feeds publish three genuinely
 * different things, and the digest treats them differently because mixing
 * them would bury the one that the channel actually exists for:
 *
 *   writeup — a narrative: the hunch, the testing, the exploit. The point.
 *   exploit — a PoC artifact with a one-line title. No story.
 *   repo    — a git commit log for a reference work. "This page changed."
 *
 * A `repo` feed is roughly 50% merge commits and housekeeping, so those
 * sources are filtered far more aggressively than the writeup ones.
 */

export type SecuritySourceKind = 'writeup' | 'exploit' | 'repo';

export interface SecuritySource {
  /** Stable id stored in `security_seen.source_id`. Never change it. */
  id: string;
  name: string;
  url: string;
  kind: SecuritySourceKind;
  /**
   * Reject an item whose link contains any of these path fragments. Used for
   * feeds that interleave corporate posts with technical ones; it is exact,
   * free and needs no LLM call.
   */
  excludePathFragments?: readonly string[];
  /** Per-source cap, applied after filtering, before selection. */
  maxItems: number;
  /**
   * How old the newest item may get before `npm run check:feeds` calls the
   * feed stale. These cadences differ by two orders of magnitude — a monthly
   * research blog is healthy at 40 days, a commit log is not — so a single
   * global threshold would either cry wolf or never fire. Doubles as the
   * documented expected cadence of each source.
   */
  staleHours: number;
  enabled: boolean;
}

export const SECURITY_SOURCES: readonly SecuritySource[] = [
  {
    // The reference source for this channel: full narrative writeups, and the
    // feed carries the ENTIRE article body in content:encoded (one item can be
    // tens of KB), so the fetch is size-capped and the body truncated early.
    id: 'infosec-writeups',
    name: 'InfoSec Write-ups',
    url: 'https://infosecwriteups.com/feed',
    kind: 'writeup',
    maxItems: 8,
    staleHours: 48, // several per day
    enabled: true,
  },
  {
    // Mixed feed. The URL path separates the two halves cleanly:
    //   /researchers/blog/hacking-tools/...  -> technical
    //   /blog/business-insights/, /blog/news/ -> corporate
    id: 'intigriti-blog',
    name: 'Intigriti',
    url: 'https://www.intigriti.com/blog/feed',
    kind: 'writeup',
    excludePathFragments: [
      '/business-insights/',
      '/blog/news/',
      '/hacker-spotlight/',
      '/customer-stories/',
    ],
    maxItems: 4,
    staleHours: 336, // roughly weekly
    enabled: true,
  },
  {
    // NOT on the original list — added because the original list was thin on
    // deep technical research and this is the best feed of its kind. Low
    // volume (1-2/month), so it costs almost nothing. Remove if unwanted.
    id: 'portswigger-research',
    name: 'PortSwigger Research',
    url: 'https://portswigger.net/research/rss',
    kind: 'writeup',
    maxItems: 3,
    staleHours: 1440, // 1-2 per month
    enabled: true,
  },
  {
    // Titles only: "[webapps] Krayin CRM 2.2.4 - IDOR". No discovery story,
    // so these are listed compactly rather than given a full entry.
    id: 'exploit-db',
    name: 'Exploit-DB',
    url: 'https://www.exploit-db.com/rss.xml',
    kind: 'exploit',
    maxItems: 6,
    staleHours: 96, // most days
    enabled: true,
  },
  {
    // Commit log. Very busy (several per day) and roughly half the entries are
    // the merge commit for the bot commit immediately below it.
    id: 'hacktricks',
    name: 'HackTricks',
    url: 'https://github.com/HackTricks-wiki/hacktricks/commits/master.atom',
    kind: 'repo',
    maxItems: 5,
    staleHours: 72, // several per day
    enabled: true,
  },
  {
    // Commit log, low volume (roughly monthly).
    id: 'payloadsallthethings',
    name: 'PayloadsAllTheThings',
    url: 'https://github.com/swisskyrepo/PayloadsAllTheThings/commits/master.atom',
    kind: 'repo',
    maxItems: 4,
    staleHours: 1440, // roughly monthly
    enabled: true,
  },
];

export interface RejectedSource {
  name: string;
  tried: readonly string[];
  reason: string;
}

/**
 * Checked on 2026-10-05 and deliberately NOT included.
 *
 * All three publish excellent material; none of them expose it as a feed. The
 * project rule is that a source without a machine-readable feed is reported,
 * not scraped, so they stay out until an official endpoint exists.
 */
export const REJECTED_SOURCES: readonly RejectedSource[] = [
  {
    name: 'HackerOne Hacktivity',
    tried: ['https://hackerone.com/hacktivity.rss'],
    reason:
      'No feed. Redirects to /hacktivity/overview, a React SPA that renders nothing without JS ' +
      'and prompts for login. Disclosed reports are reachable only through an undocumented ' +
      'GraphQL endpoint, which is not a published API and is ToS-grey to poll.',
  },
  {
    name: 'Bugcrowd Blog',
    tried: ['https://www.bugcrowd.com/blog/feed/', 'https://www.bugcrowd.com/feed/'],
    reason:
      'No public feed. /blog/feed/ redirects to the marketing homepage and /feed/ redirects to ' +
      'an Okta OAuth login (login.hackers.bugcrowd.com). The blog is WordPress, so a feed ' +
      'probably exists behind some path, but neither conventional one resolves.',
  },
  {
    name: 'YesWeHack Blog',
    tried: ['https://blog.yeswehack.com/feed/', 'https://www.yeswehack.com/blog/feed'],
    reason:
      'No feed. The first redirects to www.yeswehack.com/blog (a Next.js HTML page) and the ' +
      'second returns 404. Sanity CMS behind Next.js with no feed route exposed.',
  },
];

export const enabledSecuritySources = (): SecuritySource[] =>
  SECURITY_SOURCES.filter((source) => source.enabled);

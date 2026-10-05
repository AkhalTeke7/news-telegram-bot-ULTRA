import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  evaluate,
  extractReferencePath,
  hasSecuritySignal,
  isNoise,
} from '../src/security/filter';
import {
  REJECTED_SOURCES,
  SECURITY_SOURCES,
  enabledSecuritySources,
  type SecuritySource,
} from '../src/security/sources';
import { assertGrounded, selectWriteups } from '../src/security/select';
import {
  buildDigestMessages,
  digestDate,
  resolveSecurityDestination,
  runSecurityJob,
  securityItemKey,
  type DigestSections,
} from '../src/security/job';
import { parseFeed } from '../src/breaking/rss';

const TZ = 'Asia/Tehran';
const NOW = new Date('2026-10-05T17:00:00Z'); // 20:30 Tehran

/* ------------------------------------------------------------- fixtures --- */

/** Medium-style: full article body in content:encoded. */
const WRITEUPS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <title><![CDATA[How I Tricked OpenClaw Into Attacking Its Own Network: A NAT64 SSRF Bypass]]></title>
    <description><![CDATA[A story about how a single misread pair of bytes let a public-looking IPv6 address secretly point at 169.254.169.254.]]></description>
    <link>https://infosecwriteups.com/how-i-tricked-openclaw-9b93a7f11cd9?source=rss----7b722bfd1b8d---4</link>
    <pubDate>Mon, 05 Oct 2026 04:44:33 GMT</pubDate>
  </item>
  <item>
    <title><![CDATA[The moment it clicked]]></title>
    <description><![CDATA[A long read with no obvious keywords in the title at all.]]></description>
    <link>https://infosecwriteups.com/the-moment-it-clicked-abc123</link>
    <pubDate>Mon, 05 Oct 2026 03:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

/** Intigriti-style: technical and corporate posts in one feed. */
const INTIGRITI_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <title><![CDATA[Exploiting insecure cookie policies]]></title>
    <link>https://www.intigriti.com/researchers/blog/hacking-tools/exploiting-insecure-cookie-policies</link>
    <pubDate>Mon, 05 Oct 2026 02:00:00 GMT</pubDate>
  </item>
  <item>
    <title><![CDATA[10 years of Intigriti]]></title>
    <link>https://www.intigriti.com/blog/news/10-years-of-intigriti</link>
    <pubDate>Mon, 05 Oct 2026 01:00:00 GMT</pubDate>
  </item>
  <item>
    <title><![CDATA[From sceptic to supercharged. How AI changed my day as a QA Engineer]]></title>
    <link>https://www.intigriti.com/blog/business-insights/how-ai-changed-my-day-as-a-qa-engineer</link>
    <pubDate>Mon, 05 Oct 2026 00:30:00 GMT</pubDate>
  </item>
</channel></rss>`;

const EXPLOITDB_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <title><![CDATA[[webapps] Krayin CRM 2.2.4 - IDOR]]></title>
    <link>https://www.exploit-db.com/exploits/52687</link>
    <pubDate>Mon, 05 Oct 2026 00:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

/** GitHub commit Atom: no description/summary, body lives in <content>. */
const HACKTRICKS_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Add content from: Research Update Enhanced src/pentesting-web/client-...</title>
    <link rel="alternate" type="text/html" href="https://github.com/HackTricks-wiki/hacktricks/commit/d485c35"/>
    <updated>2026-10-05T05:09:45Z</updated>
    <content type="html">&lt;pre&gt;Add content from: Research Update Enhanced src/pentesting-web/client-side-template-injection-csti&lt;/pre&gt;</content>
  </entry>
  <entry>
    <title>Merge pull request #3020 from HackTricks-wiki/research_update_src_bin...</title>
    <link rel="alternate" type="text/html" href="https://github.com/HackTricks-wiki/hacktricks/commit/f8ce187"/>
    <updated>2026-10-05T04:27:53Z</updated>
    <content type="html">&lt;pre&gt;Merge pull request #3020&lt;/pre&gt;</content>
  </entry>
  <entry>
    <title>Run auto-merge schedule at minute 17</title>
    <link rel="alternate" type="text/html" href="https://github.com/HackTricks-wiki/hacktricks/commit/1cb5afe"/>
    <updated>2026-10-05T03:51:46Z</updated>
    <content type="html">&lt;pre&gt;Run auto-merge schedule at minute 17&lt;/pre&gt;</content>
  </entry>
</feed>`;

const src = (over: Partial<SecuritySource>): SecuritySource => ({
  id: 'test',
  name: 'Test',
  url: 'https://test.invalid/feed',
  kind: 'writeup',
  staleHours: 48,
  maxItems: 10,
  enabled: true,
  ...over,
});

const WRITEUP_SRC = src({ id: 'iw', name: 'InfoSec Write-ups', url: 'https://iw.test/feed' });
const INTIGRITI_SRC = src({
  id: 'intigriti',
  name: 'Intigriti',
  url: 'https://intigriti.test/feed',
  excludePathFragments: ['/business-insights/', '/blog/news/'],
});
const EXPLOIT_SRC = src({
  id: 'edb',
  name: 'Exploit-DB',
  url: 'https://edb.test/rss',
  kind: 'exploit',
});
const REPO_SRC = src({
  id: 'ht',
  name: 'HackTricks',
  url: 'https://ht.test/atom',
  kind: 'repo',
});

const xmlResponse = (body: string) =>
  new Response(body, { headers: { 'content-type': 'application/rss+xml' } });
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM security_seen`).run();
  await env.DB.prepare(`DELETE FROM job_claims`).run();
  await env.DB.prepare(`DELETE FROM llm_usage`).run();
});

/* ---------------------------------------------------------------- sources */

describe('source list', () => {
  it('only lists feeds that were actually verified', () => {
    for (const source of SECURITY_SOURCES) {
      expect(source.url).toMatch(/^https:\/\//);
      expect(source.id).toMatch(/^[a-z0-9-]+$/);
      expect(source.maxItems).toBeGreaterThan(0);
    }
    expect(enabledSecuritySources().length).toBeGreaterThan(0);
  });

  it('declares an expected cadence for every feed so check:feeds can judge it', () => {
    // A monthly research blog and a commit log cannot share one staleness
    // threshold, so each source carries its own.
    for (const source of SECURITY_SOURCES) {
      expect(source.staleHours).toBeGreaterThan(0);
      expect(source.maxItems).toBeGreaterThan(0);
    }
  });

  it('records why the feed-less platforms were dropped', () => {
    const names = REJECTED_SOURCES.map((entry) => entry.name);
    expect(names).toContain('HackerOne Hacktivity');
    expect(names).toContain('Bugcrowd Blog');
    expect(names).toContain('YesWeHack Blog');
    // Each one names what was tried, so nobody repeats the search.
    for (const entry of REJECTED_SOURCES) {
      expect(entry.tried.length).toBeGreaterThan(0);
      expect(entry.reason.length).toBeGreaterThan(40);
    }
  });

  it('never silently includes a rejected platform as a live source', () => {
    const liveHosts = SECURITY_SOURCES.map((source) => new URL(source.url).hostname);
    expect(liveHosts.some((host) => host.includes('hackerone'))).toBe(false);
    expect(liveHosts.some((host) => host.includes('bugcrowd'))).toBe(false);
    expect(liveHosts.some((host) => host.includes('yeswehack'))).toBe(false);
  });
});

/* ----------------------------------------------------------------- filter */

describe('noise filter', () => {
  it('rejects the commit-log housekeeping that dominates repo feeds', () => {
    const noise = [
      'Merge pull request #861 from lukejahnke/patch-1',
      'Run auto-merge schedule at minute 17',
      'Fix broken links',
      'Update sponsors logo',
      'Add Talordata sponsor',
      'Fix typo: DNS rebidding -> DNS rebinding',
      'Fix grammar in contribution guide',
      'Update references date, fix format',
      'Pre-commit hook and markdown table fix',
      'chore: bump deps',
    ];
    for (const title of noise) {
      expect(isNoise(title), title).toBe(true);
    }
  });

  it('does not reject real research that merely contains a noise word', () => {
    const real = [
      'Fixing broken access control in a GraphQL gateway',
      'Add four-dot traversal bypass payloads to deep_traversal.txt',
      'RegEx BackTrack Limit + PostgreSQL Dollar Quoting',
      'Update to the SSRF filter bypass cheat sheet',
    ];
    for (const title of real) {
      expect(isNoise(title), title).toBe(false);
    }
  });
});

describe('signal gate', () => {
  it('recognizes vulnerability and technique vocabulary', () => {
    expect(hasSecuritySignal('A NAT64 SSRF bypass')).toBe(true);
    expect(hasSecuritySignal('Krayin CRM 2.2.4 - IDOR')).toBe(true);
    expect(hasSecuritySignal('src/binary-exploitation/libc-heap/house-of-einherjar')).toBe(true);
    expect(hasSecuritySignal('Our quarterly company update')).toBe(false);
  });

  it('extracts the reference page a commit touched', () => {
    expect(
      extractReferencePath('Add content from: Research Update Enhanced src/pentesting-web/file-upload/README.md')
    ).toBe('pentesting-web/file-upload');
    expect(extractReferencePath('Update sponsors logo')).toBeUndefined();
  });
});

describe('evaluate', () => {
  const entry = (over: Partial<{ title: string; link: string; description: string }> = {}) => ({
    title: 'A NAT64 SSRF bypass in the wild',
    link: 'https://example.test/post',
    description: '',
    ...over,
  });

  it('lets a writeup through even when the title has no keywords', () => {
    // This is the whole reason writeup sources skip the signal gate: a great
    // writeup can be called "The moment it clicked".
    const verdict = evaluate(entry({ title: 'The moment it clicked' }), WRITEUP_SRC);
    expect(verdict.keep).toBe(true);
  });

  it('requires a signal from repo and exploit sources', () => {
    expect(evaluate(entry({ title: 'The moment it clicked' }), REPO_SRC).keep).toBe(false);
    expect(evaluate(entry({ title: 'The moment it clicked' }), REPO_SRC).reason).toBe('no_signal');
    expect(evaluate(entry({ title: 'Krayin CRM 2.2.4 - IDOR' }), EXPLOIT_SRC).keep).toBe(true);
  });

  it('drops corporate posts by URL path', () => {
    const verdict = evaluate(
      entry({
        title: 'How AI changed my day as a QA Engineer',
        link: 'https://www.intigriti.com/blog/business-insights/how-ai-changed-my-day',
      }),
      INTIGRITI_SRC
    );
    expect(verdict.keep).toBe(false);
    expect(verdict.reason).toBe('excluded_path');
  });

  it('keeps the technical half of the same feed', () => {
    const verdict = evaluate(
      entry({
        title: 'Exploiting insecure cookie policies',
        link: 'https://www.intigriti.com/researchers/blog/hacking-tools/exploiting-insecure-cookie-policies',
      }),
      INTIGRITI_SRC
    );
    expect(verdict.keep).toBe(true);
  });

  it('rejects noise before it ever reaches the signal gate', () => {
    expect(evaluate(entry({ title: 'Merge pull request #3020 from x/y' }), REPO_SRC).reason).toBe(
      'noise'
    );
  });

  it('surfaces the reference path for a substantive repo commit', () => {
    const verdict = evaluate(
      entry({
        title: 'Add content from: Research Update Enhanced src/pentesting-web/xs-search/perf...',
        description: 'src/pentesting-web/xs-search/performance.now-example',
      }),
      REPO_SRC
    );
    expect(verdict.keep).toBe(true);
    expect(verdict.referencePath).toBe('pentesting-web/xs-search/performance.now-example');
  });
});

/* -------------------------------------------------- Atom <content> support */

describe('feed parsing for commit logs', () => {
  it('reads the commit body out of Atom <content> when there is no summary', () => {
    const entries = parseFeed(HACKTRICKS_ATOM);
    expect(entries).toHaveLength(3);
    expect(entries[0].link).toContain('github.com/HackTricks-wiki');
    // Without the <content> fallback this would be '' and the reference path
    // could never be recovered.
    expect(entries[0].description).toContain('src/pentesting-web/client-side-template-injection');
  });
});

/* ----------------------------------------------------------------- select */

describe('grounding guard', () => {
  it('accepts a CVE that appears in the source text', () => {
    expect(assertGrounded('Bypasses the patch for CVE-2026-42167.', 'CVE-2026-42167 ProFTPD')).toBe(
      true
    );
  });

  it('rejects a CVE the model made up', () => {
    expect(assertGrounded('This is CVE-2026-99999.', 'ProFTPD SQLi writeup')).toBe(false);
  });

  it('is indifferent to prose with no identifiers', () => {
    expect(assertGrounded('An SSRF guard misreads NAT64 addresses.', 'anything')).toBe(true);
  });
});

describe('selectWriteups', () => {
  const candidates = [
    { title: 'A NAT64 SSRF bypass', sourceName: 'IW', context: 'guard misreads the last 32 bits' },
    { title: 'Top 10 recon tools', sourceName: 'IW', context: 'listicle' },
  ];
  const providers = [
    {
      id: 'openrouter' as const,
      label: 'OpenRouter',
      baseUrl: 'https://openrouter.test/v1',
      apiKey: 'sk-test',
      model: 'test-model',
      supportsJsonMode: false,
    },
  ];
  const llm = (payload: unknown): typeof fetch =>
    (async () =>
      jsonResponse({
        choices: [{ message: { content: JSON.stringify(payload) } }],
      })) as unknown as typeof fetch;

  it('returns nothing when there are no candidates', async () => {
    expect(await selectWriteups([], { providers })).toEqual([]);
  });

  it('keeps a grounded selection and normalizes its tags', async () => {
    const out = await selectWriteups(candidates, {
      providers,
      fetchImpl: llm({ items: [{ i: 0, why: 'SSRF guard misreads NAT64.', discoveryEvidence: 'A NAT64 SSRF bypass', exploitEvidence: 'guard misreads the last 32 bits', tags: ['SSRF', 'By pass!'] }] }),
    });
    expect(out).toHaveLength(1);
    expect(out[0].index).toBe(0);
    expect(out[0].tags).toEqual(['ssrf', 'bypass']);
  });

  it('drops an index the model invented', async () => {
    const out = await selectWriteups(candidates, {
      providers,
      fetchImpl: llm({ items: [{ i: 99, why: 'Nonexistent item.' }] }),
    });
    expect(out).toEqual([]);
  });

  it('drops an entry whose sentence cites an invented CVE', async () => {
    const out = await selectWriteups(candidates, {
      providers,
      fetchImpl: llm({ items: [{ i: 0, why: 'Exploits CVE-2026-00001 in the guard.' }] }),
    });
    expect(out).toEqual([]);
  });

  it('never returns the same item twice', async () => {
    const out = await selectWriteups(candidates, {
      providers,
      fetchImpl: llm({
        items: [
          { i: 0, why: 'First take on the guard.', discoveryEvidence: 'A NAT64 SSRF bypass', exploitEvidence: 'guard misreads the last 32 bits' },
          { i: 0, why: 'Second take on the guard.', discoveryEvidence: 'A NAT64 SSRF bypass', exploitEvidence: 'guard misreads the last 32 bits' },
        ],
      }),
    });
    expect(out).toHaveLength(1);
  });

  it('degrades to an empty list when the provider fails, never throws', async () => {
    const out = await selectWriteups(candidates, {
      providers,
      fetchImpl: (async () => jsonResponse({ error: 'boom' }, 500)) as unknown as typeof fetch,
    });
    expect(out).toEqual([]);
  });
});

/* -------------------------------------------------------------- rendering */

describe('digest rendering', () => {
  const entry = (title: string, link: string) => ({
    title,
    link,
    sourceName: 'InfoSec Write-ups',
    tags: ['ssrf'],
  });

  it('returns no messages for an empty digest', () => {
    expect(
      buildDigestMessages({ writeups: [], exploits: [], repoUpdates: [] }, '5 Oct 2026')
    ).toEqual([]);
  });

  it('renders the three sections with links and tags', () => {
    const sections: DigestSections = {
      writeups: [{ ...entry('A NAT64 SSRF bypass', 'https://iw.test/a'), why: 'Guard misreads bits.' }],
      exploits: [entry('[webapps] Krayin CRM 2.2.4 - IDOR', 'https://edb.test/1')],
      repoUpdates: [
        { ...entry('Add content from: ...', 'https://gh.test/c'), referencePath: 'pentesting-web/file-upload' },
      ],
    };
    const [message] = buildDigestMessages(sections, '5 Oct 2026');
    expect(message).toContain('Security Writeups');
    expect(message).toContain('5 Oct 2026');
    expect(message).toContain('WRITEUPS');
    expect(message).toContain('Guard misreads bits.');
    expect(message).toContain('#ssrf');
    expect(message).toContain('NEW PUBLIC EXPLOITS');
    expect(message).toContain('TECHNIQUE REFERENCE UPDATED');
    // The reference path replaces the truncated commit subject.
    expect(message).toContain('pentesting-web/file-upload');
  });

  it('escapes HTML so a hostile title cannot break the markup', () => {
    const sections: DigestSections = {
      writeups: [entry('<script>alert(1)</script> & "quotes"', 'https://iw.test/x')],
      exploits: [],
      repoUpdates: [],
    };
    const [message] = buildDigestMessages(sections, '5 Oct 2026');
    expect(message).not.toContain('<script>');
    expect(message).toContain('&lt;script&gt;');
    expect(message).toContain('&amp;');
  });

  it('splits at entry boundaries and repeats the header', () => {
    const long = 'x'.repeat(600);
    const sections: DigestSections = {
      writeups: Array.from({ length: 12 }, (_, i) => ({
        ...entry(`${long} ${i}`, `https://iw.test/${i}`),
        why: long,
      })),
      exploits: [],
      repoUpdates: [],
    };
    const messages = buildDigestMessages(sections, '5 Oct 2026');
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(4096);
      expect(message).toContain('Security Writeups');
    }
    expect(messages[1]).toContain('cont.');
  });

  it('formats the date in the configured timezone', () => {
    // 17:00 UTC is already the next day in Tehran? No - 20:30 on the 5th.
    expect(digestDate(NOW, TZ)).toBe('5 Oct 2026');
    // 21:00 UTC on the 5th is 00:30 on the 6th in Tehran.
    expect(digestDate(new Date('2026-10-05T21:00:00Z'), TZ)).toBe('6 Oct 2026');
  });
});

/* ------------------------------------------------------------ destination */

describe('destination resolution', () => {
  it('publishes nowhere when the secret is unset', () => {
    expect(resolveSecurityDestination({} as never)).toBeNull();
  });

  it('never falls back to the finance channel by accident', () => {
    const resolved = resolveSecurityDestination({
      TELEGRAM_DESTINATION_CHANNEL: '@financechannel',
    } as never);
    expect(resolved).toBeNull();
  });

  it('reuses the main channel only when explicitly told to', () => {
    expect(
      resolveSecurityDestination({
        TELEGRAM_SECURITY_CHANNEL: 'MAIN',
        TELEGRAM_DESTINATION_CHANNEL: '@financechannel',
      } as never)
    ).toBe('@financechannel');
  });

  it('accepts a username or a numeric id and rejects junk', () => {
    expect(resolveSecurityDestination({ TELEGRAM_SECURITY_CHANNEL: '@sec_channel' } as never)).toBe(
      '@sec_channel'
    );
    expect(resolveSecurityDestination({ TELEGRAM_SECURITY_CHANNEL: '-1001234567890' } as never)).toBe(
      '-1001234567890'
    );
    expect(resolveSecurityDestination({ TELEGRAM_SECURITY_CHANNEL: 'not a channel' } as never)).toBeNull();
  });
});

describe('item key', () => {
  it('treats the same article with different tracking params as one item', () => {
    const a = securityItemKey('https://infosecwriteups.com/post-abc?source=rss----7b722bfd1b8d', 'T');
    const b = securityItemKey('https://infosecwriteups.com/post-abc', 'T');
    expect(a).toBe(b);
  });

  it('separates genuinely different articles', () => {
    expect(securityItemKey('https://iw.test/a', 'A')).not.toBe(securityItemKey('https://iw.test/b', 'B'));
  });
});

/* ------------------------------------------------------------------- job */

describe('runSecurityJob', () => {
  const TEST_SOURCES = [WRITEUP_SRC, INTIGRITI_SRC, EXPLOIT_SRC, REPO_SRC];

  const baseEnv = (over: Record<string, unknown> = {}) => ({
    ...env,
    TELEGRAM_BOT_TOKEN: 'T',
    TELEGRAM_SECURITY_CHANNEL: '@sec_channel',
    TIMEZONE: TZ,
    OPENROUTER_API_KEY: 'sk-test',
    ...over,
  });

  const makeFetch = (opts: {
    sent?: string[];
    telegram?: (text: string) => Response;
    llm?: unknown;
    feeds?: Record<string, string>;
  }) => {
    const feeds = opts.feeds ?? {
      'https://iw.test/feed': WRITEUPS_XML,
      'https://intigriti.test/feed': INTIGRITI_XML,
      'https://edb.test/rss': EXPLOITDB_XML,
      'https://ht.test/atom': HACKTRICKS_ATOM,
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
                        why: 'The author found and exploited an SSRF guard that misread NAT64 addresses.',
                        discoveryEvidence: 'single misread pair of bytes',
                        exploitEvidence: 'point at 169.254.169.254',
                        tags: ['ssrf'],
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

  it('publishes nothing when the channel secret is missing', async () => {
    const result = await runSecurityJob(baseEnv({ TELEGRAM_SECURITY_CHANNEL: undefined }) as never, {
      now: NOW,
      sources: TEST_SOURCES,
      fetchImpl: makeFetch({}),
    });
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('destination_or_token_missing');
  });

  it('sends one digest and records every delivered item', async () => {
    const sent: string[] = [];
    const result = await runSecurityJob(baseEnv() as never, {
      now: NOW,
      sources: TEST_SOURCES,
      fetchImpl: makeFetch({ sent }),
    });

    expect(result.status).toBe('success');
    expect(result.messages).toBe(1);
    expect(sent).toHaveLength(1);

    // The corporate Intigriti posts and the commit noise are gone.
    expect(sent[0]).not.toContain('10 years of Intigriti');
    expect(sent[0]).not.toContain('QA Engineer');
    expect(sent[0]).not.toContain('Merge pull request');
    expect(sent[0]).not.toContain('auto-merge');
    // The real content is there.
    expect(sent[0]).toContain('NAT64 SSRF Bypass');
    expect(sent[0]).not.toContain('Exploiting insecure cookie policies');
    expect(sent[0]).not.toContain('Krayin CRM');
    expect(sent[0]).toContain('found and exploited an SSRF guard');

    const rows = await env.DB.prepare(`SELECT COUNT(*) AS n FROM security_seen`).first<{ n: number }>();
    expect(rows?.n).toBeGreaterThan(0);
  });

  it('is English: it never emits Persian text', async () => {
    const sent: string[] = [];
    await runSecurityJob(baseEnv() as never, {
      now: NOW,
      sources: TEST_SOURCES,
      fetchImpl: makeFetch({ sent }),
    });
    expect(sent[0]).not.toMatch(/[\u0600-\u06FF]/);
  });

  it('sends exactly once per day no matter how many invocations race', async () => {
    const sent: string[] = [];
    const run = () =>
      runSecurityJob(baseEnv() as never, {
        now: NOW,
        sources: TEST_SOURCES,
        fetchImpl: makeFetch({ sent }),
      });

    const [a, b, c] = await Promise.all([run(), run(), run()]);
    const later = await run();

    const statuses = [a, b, c, later].map((r) => r.status);
    expect(statuses.filter((s) => s === 'success')).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect([a, b, c, later].filter((r) => r.alreadyClaimed).length).toBe(3);
  });

  it('never posts the same article twice, even from an unchanged feed', async () => {
    const sent: string[] = [];
    await runSecurityJob(baseEnv() as never, {
      now: NOW,
      sources: TEST_SOURCES,
      fetchImpl: makeFetch({ sent }),
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('NAT64 SSRF Bypass');
    expect(sent[0]).not.toContain('Krayin CRM');

    // Next day, the feeds still carry yesterday's articles at the top.
    const tomorrow = new Date(NOW.getTime() + 24 * 3_600_000);
    await runSecurityJob(baseEnv() as never, {
      now: tomorrow,
      sources: TEST_SOURCES,
      fetchImpl: makeFetch({ sent }),
    });

    // Anything already delivered must never appear again. Items that were
    // filtered out or not selected yesterday MAY appear, which is intended:
    // an unpublished item stays eligible.
    for (const message of sent.slice(1)) {
      expect(message).not.toContain('NAT64 SSRF Bypass');
      expect(message).not.toContain('Krayin CRM');
      expect(message).not.toContain('Exploiting insecure cookie policies');
    }
  });

  it('skips entirely once every candidate has already been posted', async () => {
    const sent: string[] = [];
    // Only a qualifying narrative writeup can be delivered.
    const opts = { sources: [WRITEUP_SRC], fetchImpl: makeFetch({ sent }) };
    const first = await runSecurityJob(baseEnv() as never, { now: NOW, ...opts });
    expect(first.status).toBe('success');

    const second = await runSecurityJob(baseEnv() as never, {
      now: new Date(NOW.getTime() + 24 * 3_600_000),
      ...opts,
    });
    expect(second.status).toBe('skipped');
    expect(second.reason).toBe('no_verified_exploited_bug');
    expect(sent).toHaveLength(1);
  });

  it('publishes nothing when no LLM can verify a bug', async () => {
    const sent: string[] = [];
    const result = await runSecurityJob(
      baseEnv({ OPENROUTER_API_KEY: undefined, NVIDIA_API_KEY: undefined }) as never,
      { now: NOW, sources: TEST_SOURCES, fetchImpl: makeFetch({ sent }) }
    );
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('no_verified_exploited_bug');
    expect(result.selected).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('publishes nothing when the LLM returns garbage', async () => {
    const sent: string[] = [];
    const result = await runSecurityJob(baseEnv() as never, {
      now: NOW,
      sources: TEST_SOURCES,
      fetchImpl: makeFetch({ sent, llm: { choices: [{ message: { content: 'not json' } }] } }),
    });
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('no_verified_exploited_bug');
    expect(result.selected).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('reports partial when one feed is down but still publishes', async () => {
    const sent: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      if (String(input) === 'https://edb.test/rss') return new Response('nope', { status: 503 });
      return makeFetch({ sent })(input, init);
    };
    const result = await runSecurityJob(baseEnv() as never, {
      now: NOW,
      sources: TEST_SOURCES,
      fetchImpl,
    });
    expect(result.status).toBe('partial');
    expect(result.feedsFailed).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('fails and releases the claim when every feed is down', async () => {
    const result = await runSecurityJob(baseEnv() as never, {
      now: NOW,
      sources: TEST_SOURCES,
      fetchImpl: (async () => new Response('down', { status: 500 })) as unknown as typeof fetch,
    });
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('all_feeds_failed');

    // Released, so a later invocation today may retry.
    const claim = await env.DB.prepare(`SELECT COUNT(*) AS n FROM job_claims WHERE job='security'`).first<{
      n: number;
    }>();
    expect(claim?.n).toBe(0);
  });

  it('fails closed on a Telegram rejection and records nothing new', async () => {
    const sent: string[] = [];
    const result = await runSecurityJob(baseEnv() as never, {
      now: NOW,
      sources: TEST_SOURCES,
      fetchImpl: makeFetch({
        sent,
        telegram: () => jsonResponse({ ok: false, description: 'chat not found' }, 400),
      }),
    });

    expect(result.status).toBe('failed');
    expect(result.messages).toBe(0);
    expect(result.reason).toContain('telegram_');

    // Nothing delivered -> nothing marked seen, so tomorrow can retry the items.
    const rows = await env.DB.prepare(`SELECT COUNT(*) AS n FROM security_seen`).first<{ n: number }>();
    expect(rows?.n).toBe(0);
    // But the claim stays, so today is not retried blindly.
    const claim = await env.DB
      .prepare(`SELECT status FROM job_claims WHERE job='security'`)
      .first<{ status: string }>();
    expect(claim?.status).toBe('sent');
  });

  it('skips cleanly when every feed is empty', async () => {
    const empty = `<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>`;
    const result = await runSecurityJob(baseEnv() as never, {
      now: NOW,
      sources: TEST_SOURCES,
      fetchImpl: makeFetch({
        feeds: {
          'https://iw.test/feed': empty,
          'https://intigriti.test/feed': empty,
          'https://edb.test/rss': empty,
          'https://ht.test/atom': empty,
        },
      }),
    });
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('no_candidates');
  });

  it('ignores items far outside the lookback window', async () => {
    const stale = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item><title>An ancient SSRF writeup from last year</title>
      <link>https://iw.test/old</link>
      <pubDate>Mon, 05 Oct 2026 00:00:00 GMT</pubDate></item>
    </channel></rss>`.replace('2026', '2024');
    const result = await runSecurityJob(baseEnv() as never, {
      now: NOW,
      sources: [WRITEUP_SRC],
      fetchImpl: makeFetch({ feeds: { 'https://iw.test/feed': stale } }),
    });
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('no_candidates');
  });
});

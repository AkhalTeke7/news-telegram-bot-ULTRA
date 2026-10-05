/**
 * A small RSS 2.0 + Atom reader for the breaking-news scan.
 *
 * `src/rssCollector.ts` already has a minimal `<item>` parser, but it is
 * tuned for the existing Persian-channel pipeline (its own table, its own
 * window rules) and only understands RSS. This one is separate rather than a
 * refactor of a working module, and adds what the alert path needs:
 *
 *  - Atom `<entry>` as well as RSS `<item>`;
 *  - `<link href="...">` (Atom) as well as `<link>text</link>` (RSS);
 *  - numeric and hex HTML entities, plus the mojibake OilPrice emits;
 *  - a published date from any of pubDate / published / updated / dc:date;
 *  - hard caps on item count and field length, because this parses hostile
 *    input on a 5-minute cron.
 */

export interface FeedEntry {
  title: string;
  link: string;
  /** Plain-text description/summary, HTML stripped. May be empty. */
  description: string;
  /** Parsed publication instant, or null when the feed omitted/mangled it. */
  publishedAt: Date | null;
}

/** Guards against a malicious or broken feed exhausting the invocation. */
const MAX_ITEMS = 60;
const MAX_TITLE = 400;
const MAX_DESCRIPTION = 1200;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
};

/**
 * UTF-8 bytes that were decoded as Latin-1 somewhere upstream.
 *
 * OilPrice.com serves `â€”` where it means `—`. Repairing the common cases
 * keeps those headlines readable instead of shipping garbage into an alert.
 */
const MOJIBAKE: [RegExp, string][] = [
  [/â€”/g, '—'],
  [/â€“/g, '–'],
  [/â€˜/g, '‘'],
  [/â€™/g, '’'],
  [/â€œ/g, '“'],
  [/â€\u009d/g, '”'],
  [/â€¦/g, '…'],
  [/Â /g, ' '],
];

/** CDATA, entities, tags and mojibake out; plain text in. */
export function decodeXmlText(value: string): string {
  let out = value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  out = out.replace(/<[^>]+>/g, ' ');
  out = out.replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)));
  out = out.replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)));
  out = out.replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
  for (const [pattern, replacement] of MOJIBAKE) out = out.replace(pattern, replacement);
  return out.replace(/\s+/g, ' ').trim();
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** First `<name>…</name>` of a block, decoded. */
function tagText(xml: string, name: string): string {
  const match = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return match ? decodeXmlText(match[1]) : '';
}

/** RSS `<link>url</link>` or Atom `<link rel="alternate" href="url"/>`. */
function extractLink(block: string): string {
  const rss = tagText(block, 'link');
  if (rss && /^https?:\/\//i.test(rss)) return rss;

  // Prefer rel="alternate"; fall back to the first href.
  const alternate = block.match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i);
  if (alternate && /^https?:\/\//i.test(alternate[1])) return decodeXmlText(alternate[1]);

  const any = block.match(/<link\b[^>]*href=["']([^"']+)["']/i);
  if (any && /^https?:\/\//i.test(any[1])) return decodeXmlText(any[1]);

  const guid = tagText(block, 'guid');
  return /^https?:\/\//i.test(guid) ? guid : '';
}

/**
 * Parses a date from any field the feeds actually use.
 *
 * `new Date()` handles RFC 822/2822 (`Mon, 05 Oct 2026 08:31:39 GMT`) and
 * ISO 8601. An unparseable or absent date yields null and the caller decides
 * — it must never become "now", which would make stale items look fresh.
 */
export function parseFeedDate(block: string): Date | null {
  for (const field of ['pubDate', 'published', 'updated', 'dc:date', 'date']) {
    const raw = tagText(block, field);
    if (!raw) continue;
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

/** Parses an RSS or Atom document into entries. Never throws. */
export function parseFeed(xml: string): FeedEntry[] {
  const blocks = [
    ...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi),
    ...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi),
  ].slice(0, MAX_ITEMS);

  const entries: FeedEntry[] = [];
  for (const match of blocks) {
    const block = match[1];
    const title = tagText(block, 'title').slice(0, MAX_TITLE);
    const link = extractLink(block);
    if (!title || !link) continue;
    const description = (tagText(block, 'description') || tagText(block, 'summary') || '').slice(
      0,
      MAX_DESCRIPTION
    );
    entries.push({ title, link, description, publishedAt: parseFeedDate(block) });
  }
  return entries;
}

/**
 * Keeps entries published within `windowMinutes` of `now`.
 *
 * Entries with NO date are kept: several feeds omit it, and dropping them
 * would blind us to exactly the fast-moving wires we care about. They are
 * deduped later by story key, so a dateless item cannot alert twice.
 *
 * Entries dated in the future beyond a small skew allowance are dropped —
 * that is a broken feed, not news.
 */
export function recentEntries(
  entries: readonly FeedEntry[],
  now: Date,
  windowMinutes: number
): FeedEntry[] {
  const floor = now.getTime() - windowMinutes * 60_000;
  const ceiling = now.getTime() + 10 * 60_000;
  return entries.filter((entry) => {
    if (!entry.publishedAt) return true;
    const at = entry.publishedAt.getTime();
    return at >= floor && at <= ceiling;
  });
}

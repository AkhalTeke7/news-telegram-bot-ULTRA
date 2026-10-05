/**
 * Small, stable, non-cryptographic hashing + URL canonicalization.
 *
 * Used for dedupe keys only (slideshow items, breaking-news stories). These
 * keys are compared against our own rows, never used as a security boundary,
 * so FNV-1a is the right trade: deterministic across deploys, no async, no
 * WebCrypto round-trip inside a hot loop.
 */

/** 32-bit FNV-1a as 8 lowercase hex characters. */
export function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Tracking parameters that differ per fetch and would defeat URL dedupe. */
const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'at_medium', 'at_campaign', 'at_custom1', 'at_custom2', 'at_custom3', 'at_custom4',
  'fbclid', 'gclid', 'mc_cid', 'mc_eid', 'igshid', 'ref', 'ref_src',
  'traffic_source', 'mod', 'cmpid', 'smid', 'partner', '__source',
];

/**
 * Canonical form of an article URL for dedupe.
 *
 * Drops the scheme, a leading `www.`, tracking query parameters, the fragment
 * and a trailing slash, so the same story arriving from an RSS feed and from a
 * social share resolves to one key.
 */
export function canonicalUrl(raw: string): string {
  try {
    const url = new URL(raw.trim());
    for (const param of TRACKING_PARAMS) url.searchParams.delete(param);
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const query = url.searchParams.toString();
    return `${host}${path}${query ? `?${query}` : ''}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}

/**
 * Normalizes a headline for fuzzy "same story" comparison.
 *
 * Lowercases, strips Arabic/Persian diacritics, unifies the Arabic/Persian
 * ye and kaf (a constant source of false negatives in Persian text), removes
 * punctuation and collapses whitespace.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[\u064A\u06CC]/g, 'ی')
    .replace(/[\u0643\u06A9]/g, 'ک')
    .replace(/[\u0623\u0625\u0622]/g, 'ا')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** English + Persian stop words, removed before building a story fingerprint. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'at', 'by',
  'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'that', 'this',
  'after', 'over', 'into', 'about', 'says', 'say', 'said', 'will', 'new', 'more',
  'they', 'them', 'their', 'has', 'have', 'had', 'not', 'but', 'than', 'then',
  'when', 'while', 'who', 'what', 'how', 'out', 'off', 'per', 'via', 'amid',
  'could', 'would', 'may', 'might', 'amid', 'report', 'reports',
  'از', 'به', 'در', 'که', 'را', 'با', 'این', 'آن', 'برای', 'است', 'شد', 'شده',
  'های', 'ها', 'یک', 'تا', 'بر', 'هم', 'می', 'کرد', 'کند', 'گفت', 'خبر',
]);

/**
 * Very light English suffix stripping.
 *
 * Only the regular inflections that actually cause cross-source misses:
 * plural `-s` ("rates"/"rate", "cuts"/"cut") and `-ed`/`-ing`
 * ("raised"/"raising"). It is intentionally NOT a real stemmer — no
 * irregular verbs, no dictionary. "holds" and "held" still differ, and that
 * is an accepted limitation rather than a silent approximation.
 */
export function lightStem(word: string): string {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/**
 * Content fingerprint of a headline: the significant words, stemmed, sorted.
 *
 * Sorting makes the key insensitive to how different outlets order the same
 * facts, which is what lets cross-source confirmation actually match. Real
 * example from 2026-10-05, both of which produce the SAME key:
 *
 *   BBC  "G7 to release millions of barrels of oil after OPEC output cut"
 *   CNBC "OPEC output cut prompts G7 oil release of millions of barrels"
 */
export function storyFingerprint(title: string, keep = 6): string {
  const words = normalizeTitle(title)
    .split(' ')
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
    .map(lightStem)
    .filter((w) => w.length >= 3);
  const significant = [...new Set(words)].sort().slice(0, keep);
  if (significant.length === 0) return fnv1a(normalizeTitle(title));
  return fnv1a(significant.join(' '));
}

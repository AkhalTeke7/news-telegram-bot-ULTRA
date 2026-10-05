/**
 * Finds the article's lead image (`og:image`) for a slide.
 *
 * Deliberately conservative:
 *  - one bounded request per item, never a crawl;
 *  - only the first 256 KB of HTML is inspected (meta tags live in `<head>`);
 *  - the result must be an absolute http(s) URL after resolution;
 *  - every failure returns `null`, which the template renders as the gradient
 *    placeholder with the category icon. A missing picture must never cost us
 *    a slide.
 *
 * The image bytes are NOT downloaded by the Worker. The URL goes into the
 * slide HTML and Browser Run's Chromium fetches it while rendering, which
 * keeps Worker subrequests and memory flat regardless of image size.
 */

import { HttpError, safeFetch } from '../lib/http';

/** Meta tags are in <head>; no need to buffer a 3 MB article page. */
const MAX_HTML_BYTES = 256 * 1024;
export const OG_IMAGE_TIMEOUT_MS = 8_000;

/** Browsers get served the real page; a blank UA often gets a bot wall. */
const USER_AGENT =
  'Mozilla/5.0 (compatible; NewsSlideBot/1.0; +https://developers.cloudflare.com/workers/)';

const META_PATTERNS: RegExp[] = [
  /<meta[^>]+property\s*=\s*["']og:image(?::secure_url|:url)?["'][^>]*>/gi,
  /<meta[^>]+name\s*=\s*["']og:image["'][^>]*>/gi,
  /<meta[^>]+name\s*=\s*["']twitter:image(?::src)?["'][^>]*>/gi,
  /<meta[^>]+property\s*=\s*["']twitter:image["'][^>]*>/gi,
];

function readContentAttr(tag: string): string | null {
  const match =
    tag.match(/content\s*=\s*"([^"]*)"/i) ??
    tag.match(/content\s*=\s*'([^']*)'/i) ??
    tag.match(/content\s*=\s*([^\s>]+)/i);
  return match ? match[1].trim() : null;
}

/** Decodes the handful of entities that legitimately appear in a URL attribute. */
function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&')
    .replace(/&#x26;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Pulls an absolute image URL out of an HTML document.
 *
 * `pageUrl` is the base for resolving protocol-relative (`//cdn/..`) and
 * root-relative (`/img/..`) values, which are common in the wild.
 */
export function extractOgImage(html: string, pageUrl: string): string | null {
  // Only look at the head; some pages embed og:image-looking strings in body
  // JSON blobs.
  const headEnd = html.search(/<\/head>/i);
  const scope = headEnd > 0 ? html.slice(0, headEnd) : html;

  for (const pattern of META_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of scope.matchAll(pattern)) {
      const raw = readContentAttr(match[0]);
      if (!raw) continue;
      const resolved = resolveImageUrl(decodeEntities(raw), pageUrl);
      if (resolved) return resolved;
    }
  }
  return null;
}

/** Resolves a possibly relative image reference against the page URL. */
export function resolveImageUrl(value: string, pageUrl: string): string | null {
  const candidate = value.trim();
  if (!candidate || candidate.startsWith('data:')) return null;
  try {
    const url = new URL(candidate, pageUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

export interface FetchOgImageOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Fetches `pageUrl` and returns its og:image, or null.
 *
 * Never throws: the caller treats null as "use the placeholder".
 */
export async function fetchOgImage(
  pageUrl: string,
  opts: FetchOgImageOptions = {}
): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(pageUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

  try {
    const res = await safeFetch(parsed.toString(), {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': USER_AGENT,
        'accept-language': 'en,fa;q=0.8',
      },
      timeoutMs: opts.timeoutMs ?? OG_IMAGE_TIMEOUT_MS,
      fetchImpl: opts.fetchImpl,
    });
    if (!res.ok) return null;

    const type = res.headers.get('content-type') ?? '';
    if (type && !/text\/html|application\/xhtml/i.test(type)) return null;

    const html = await readCapped(res, MAX_HTML_BYTES);
    return extractOgImage(html, res.url || parsed.toString());
  } catch (error) {
    if (error instanceof HttpError) return null;
    return null;
  }
}

/** Reads at most `maxBytes` of a body, aborting the stream afterwards. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const body = res.body;
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false });
  let out = '';
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      out += decoder.decode(value, { stream: true });
      if (total >= maxBytes) break;
      if (/<\/head>/i.test(out)) break; // everything we need has arrived
    }
  } catch {
    // partial content is fine — we only need the head
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
  return out;
}

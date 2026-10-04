/**
 * Telegram public channel preview reader.
 *
 * Transport: GET https://t.me/s/<username> — the same server-rendered page a
 * browser gets when opening a public channel's web preview. No credentials, no
 * session, no MTProto. Undocumented upstream, so parsing is deliberately
 * defensive and never throws on malformed markup.
 *
 * ponytail: regex + tag counting instead of an HTML parser dependency (Workers
 * has no DOM). If Telegram ever nests the text block differently, fix
 * extractBlock() — the selectors are the only thing that would change.
 */

const PREVIEW_BASE = 'https://t.me/s/';
const USERNAME_RE = /^[a-z][a-z0-9_]{4,31}$/;
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export class PreviewError extends Error {
  constructor(
    readonly operation: string,
    message: string
  ) {
    super(message);
    this.name = 'PreviewError';
  }
}

export interface PreviewMessage {
  channelUsername: string;
  telegramMessageId: number;
  /** Telegram post timestamp, normalized to UTC ISO-8601. */
  messageDate: string;
  /** Epoch milliseconds of the post, for window comparisons. */
  messageDateMs: number;
  messageText: string;
  sourceUrl: string;
}

export interface FetchPreviewOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /**
   * Hard timeout per channel. Without it a single unreachable host can stall the
   * hourly invocation, because channels are collected sequentially.
   */
  timeoutMs?: number;
}

export const PREVIEW_TIMEOUT_MS = 15_000;

export async function fetchChannelPreview(
  username: string,
  opts: FetchPreviewOptions = {}
): Promise<PreviewMessage[]> {
  if (!USERNAME_RE.test(username)) {
    throw new PreviewError('fetch-preview', `Refusing to fetch preview for invalid username.`);
  }

  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl ?? PREVIEW_BASE;

  let res: Response;
  try {
    res = await doFetch(`${base}${username}`, {
      headers: { 'user-agent': BROWSER_UA, accept: 'text/html' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? PREVIEW_TIMEOUT_MS),
    });
  } catch (e) {
    throw new PreviewError('fetch-preview', `Network failure: ${describe(e)}`);
  }

  if (!res.ok) {
    throw new PreviewError('fetch-preview', `HTTP ${res.status} from channel preview.`);
  }

  return parsePreviewHtml(await res.text(), username);
}

const POST_MARKER = /data-post="([A-Za-z0-9_]+)\/(\d+)"/g;
const DATETIME_ATTR = /<time[^>]*\bdatetime="([^"]+)"/i;
const TEXT_MARKER = /<div[^>]*class="[^"]*\btgme_widget_message_text\b[^"]*"[^>]*>/i;

/**
 * Splits the preview page into per-post chunks on `data-post="<channel>/<id>"`
 * and extracts the post timestamp plus plain text.
 */
export function parsePreviewHtml(html: string, username: string): PreviewMessage[] {
  const markers = [...html.matchAll(POST_MARKER)];
  const out: PreviewMessage[] = [];
  const seen = new Set<number>();

  markers.forEach((marker, i) => {
    const [, channel, idRaw] = marker;
    if (channel.toLowerCase() !== username) return;

    const messageId = Number(idRaw);
    if (!Number.isSafeInteger(messageId) || seen.has(messageId)) return;

    const start = (marker.index ?? 0) + marker[0].length;
    const end = markers[i + 1]?.index ?? html.length;
    const chunk = html.slice(start, end);

    const dateAttr = chunk.match(DATETIME_ATTR)?.[1];
    if (!dateAttr) return;

    const dateMs = Date.parse(dateAttr);
    if (!Number.isFinite(dateMs)) return;

    seen.add(messageId);
    out.push({
      channelUsername: channel.toLowerCase(),
      telegramMessageId: messageId,
      messageDate: new Date(dateMs).toISOString(),
      messageDateMs: dateMs,
      messageText: extractText(chunk),
      sourceUrl: `https://t.me/${channel.toLowerCase()}/${messageId}`,
    });
  });

  return out;
}

/** Extracts the message text block, tolerating nested <div>s inside it. */
function extractText(chunk: string): string {
  const marker = chunk.match(TEXT_MARKER);
  if (!marker || marker.index === undefined) return '';

  const inner = extractBlock(chunk, marker.index + marker[0].length);
  return decodeEntities(collapseWhitespace(stripTags(inner)));
}

/** Walks forward from `from` (just past an opening tag) to its matching close. */
function extractBlock(html: string, from: number): string {
  const tag = /<(\/?)div\b[^>]*>/gi;
  tag.lastIndex = from;

  let depth = 1;
  let token: RegExpExecArray | null;
  while ((token = tag.exec(html)) !== null) {
    if (token[1] === '/') {
      depth--;
      if (depth === 0) return html.slice(from, token.index);
    } else if (!token[0].endsWith('/>')) {
      depth++;
    }
  }
  return html.slice(from);
}

function stripTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<div\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]*>/g, '');
}

function collapseWhitespace(text: string): string {
  return text.replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  nbsp: ' ',
  zwnj: '‌',
  zwj: '‍',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const key = entity.toLowerCase();
    if (key in NAMED_ENTITIES) return NAMED_ENTITIES[key];

    const isHex = key.startsWith('#x');
    const code = Number.parseInt(isHex ? key.slice(2) : key.slice(1), isHex ? 16 : 10);
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;

    try {
      return String.fromCodePoint(code);
    } catch {
      return match;
    }
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { describe as describeError };

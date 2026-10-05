/**
 * TASK 1 — the news slideshow.
 *
 * Pipeline for one run:
 *   1. pick at most N (default 10) summarized items not sent as a slide before
 *   2. translate the non-Persian ones to Persian      (1 batched LLM call)
 *   3. extract 2-4 verbatim keywords per item          (1 batched LLM call)
 *   4. resolve each article's og:image                 (1 bounded fetch each)
 *   5. render one 1080x1350 PNG per item via Browser Run
 *   6. deliver as ONE Telegram album (sendMediaGroup, 2-10 photos)
 *   7. ONLY after Telegram confirms, mark the items as sent in D1
 *
 * Step 7 is the important one. Marking before the send would mean a Telegram
 * outage permanently swallows that batch of news; marking after means the
 * worst case is a duplicate-free retry on the next run.
 *
 * Every stage degrades instead of failing: no LLM -> no highlighting and no
 * translation; no og:image -> gradient placeholder; Browser Run rate limited
 * -> a shorter album. The job only reports `failed` when nothing shipped.
 */

import { fnv1a, canonicalUrl } from '../lib/hash';
import { describeError } from '../lib/http';
import { jalaliDateTime, localDateKey, resolveTimeZone } from '../lib/jalali';
import { resolveDailyBudget } from '../llm/budget';
import { resolveProviders } from '../llm/providers';
import { resolveDestination } from '../publisher';
import {
  largestPhotoFileId,
  MEDIA_GROUP_MIN_ITEMS,
  sendMediaGroup,
  sendPhoto,
  TelegramError,
  type DestinationChat,
  type SentMessage,
} from '../telegram';
import { topicPresentation } from '../topic';
import type { Env } from '../types';
import { extractKeywords, isPersian, translateToPersian } from './enrich';
import { fetchOgImage } from './ogImage';
import { DEFAULT_SLIDE_SPACING_MS, renderSlides, type RenderedSlide } from './render';
import { buildSlideHtml, clampChars, MAX_SLIDES } from './slideTemplate';

export const DEFAULT_BRAND_NAME = 'اخبار فوری';
/** Telegram hard limit is 1024 characters per media caption. */
const CAPTION_LIMIT = 900;

export interface SlideshowItem {
  /** `messages.id`, used only to correlate; dedupe uses `key`. */
  id: number;
  /** Stable dedupe key stored in `slideshow_sent`. */
  key: string;
  headline: string;
  summary: string;
  sourceName: string;
  sourceUrl: string;
  category: string | null;
}

export interface SlideshowResult {
  status: 'success' | 'partial' | 'skipped' | 'failed';
  /** Items considered before rendering. */
  candidates: number;
  /** Slides successfully rendered. */
  rendered: number;
  /** Slides Telegram accepted (and therefore marked as sent). */
  sent: number;
  translated: number;
  withImage: number;
  keywordItems: number;
  browserRunMs: number;
  /** Short, secret-free reason when something went wrong. */
  reason?: string;
}

/** Reads a bounded positive integer from the environment. */
function readInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/**
 * Stable dedupe key for an item.
 *
 * Prefers the canonical article URL (the same story keeps one key across
 * feeds and reruns) and falls back to a hash of the headline when a row has
 * no usable URL.
 */
export function slideItemKey(sourceUrl: string, headline: string): string {
  const url = (sourceUrl ?? '').trim();
  if (url) return `u:${fnv1a(canonicalUrl(url))}`;
  return `t:${fnv1a(headline.replace(/\s+/g, ' ').trim().toLowerCase())}`;
}

/**
 * Candidate items for the next slideshow: summarized, not filtered as an
 * advertisement, not already delivered as a slide, most important first.
 *
 * NOTE: this intentionally does NOT look at `published_at`. The slideshow is a
 * separate output channel from the existing text digest, so the two never
 * block each other.
 */
export async function selectSlideshowItems(
  db: D1Database,
  limit: number
): Promise<SlideshowItem[]> {
  const { results } = await db
    .prepare(
      `SELECT m.id, m.title, m.summary_text, m.category, m.source_url,
              c.channel_username, c.channel_title
         FROM messages m
         JOIN channels c ON c.id = m.source_channel_id
        WHERE c.enabled = 1
          AND m.filter_status <> 'filtered'
          AND m.summarized_at IS NOT NULL
          AND TRIM(COALESCE(m.summary_text, '')) <> ''
          AND COALESCE(m.importance, 3) > 1
        ORDER BY COALESCE(m.importance, 3) DESC, m.message_date DESC, m.id DESC
        LIMIT ?1`
    )
    // Over-fetch: some rows will already be in slideshow_sent.
    .bind(Math.min(limit * 6, 120))
    .all<{
      id: number;
      title: string | null;
      summary_text: string;
      category: string | null;
      source_url: string | null;
      channel_username: string;
      channel_title: string | null;
    }>();

  const candidates: SlideshowItem[] = [];
  for (const row of results ?? []) {
    const summary = String(row.summary_text ?? '').trim();
    if (!summary) continue;
    const headline = (row.title ?? '').trim() || summary.split(/(?<=[.؟!])\s+/)[0] || summary;
    const sourceUrl = (row.source_url ?? '').trim();
    candidates.push({
      id: Number(row.id),
      key: slideItemKey(sourceUrl, headline),
      headline,
      summary,
      sourceName: (row.channel_title ?? '').trim() || String(row.channel_username ?? '').trim(),
      sourceUrl,
      category: row.category,
    });
  }

  if (candidates.length === 0) return [];

  // Drop anything already delivered. Chunked so the IN list stays sane.
  const alreadySent = new Set<string>();
  const keys = [...new Set(candidates.map((c) => c.key))];
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50);
    const placeholders = chunk.map((_, j) => `?${j + 1}`).join(', ');
    const { results: sent } = await db
      .prepare(`SELECT item_key FROM slideshow_sent WHERE item_key IN (${placeholders})`)
      .bind(...chunk)
      .all<{ item_key: string }>();
    for (const row of sent ?? []) alreadySent.add(String(row.item_key));
  }

  const seen = new Set<string>();
  const fresh: SlideshowItem[] = [];
  for (const candidate of candidates) {
    if (alreadySent.has(candidate.key) || seen.has(candidate.key)) continue;
    seen.add(candidate.key);
    fresh.push(candidate);
    if (fresh.length === limit) break;
  }
  return fresh;
}

/** One short caption per album photo. Plain text: no parse mode to reject. */
export function buildSlideCaption(
  item: { headline: string; sourceName: string; category: { emoji: string } },
  index: number,
  total: number
): string {
  const lines = [
    `${item.category.emoji} ${clampChars(item.headline, 170)}`,
    `📡 منبع: ${clampChars(item.sourceName, 48)} · ${index}/${total}`,
  ];
  const caption = lines.join('\n');
  return caption.length > CAPTION_LIMIT ? `${caption.slice(0, CAPTION_LIMIT - 1)}…` : caption;
}

/** Marks items as delivered. Called only after Telegram confirms. */
async function markSlidesSent(
  db: D1Database,
  items: readonly { item: SlideshowItem; messageId: number | null; fileId: string | null }[]
): Promise<void> {
  for (const { item, messageId, fileId } of items) {
    try {
      await db
        .prepare(
          `INSERT OR IGNORE INTO slideshow_sent (item_key, title, source, link, message_id, file_id)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
        )
        .bind(
          item.key,
          item.headline.slice(0, 300),
          item.sourceName.slice(0, 80),
          item.sourceUrl.slice(0, 500),
          messageId,
          fileId
        )
        .run();
    } catch (error) {
      // A bookkeeping failure must not undo a successful send; worst case the
      // item reappears next run, which the operator can see in the logs.
      console.error(
        JSON.stringify({ event: 'slideshow', stage: 'mark-sent', key: item.key, error: describeError(error) })
      );
    }
  }
}

/** Best-effort archive of a rendered slide. Never affects the send. */
async function archiveSlide(
  bucket: R2Bucket | undefined,
  key: string,
  png: ArrayBuffer
): Promise<void> {
  if (!bucket) return;
  try {
    await bucket.put(`slides/${key}.png`, png, { httpMetadata: { contentType: 'image/png' } });
  } catch (error) {
    console.error(JSON.stringify({ event: 'slideshow', stage: 'r2-archive', error: describeError(error) }));
  }
}

export interface RunSlideshowOptions {
  now?: Date;
  /** Injectable for tests; production uses the real spacing. */
  spacingMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

/**
 * Runs one slideshow cycle. Never throws — always returns a result the caller
 * can log and store.
 */
export async function runSlideshowJob(
  env: Env,
  opts: RunSlideshowOptions = {}
): Promise<SlideshowResult> {
  const now = opts.now ?? new Date();
  const timeZone = resolveTimeZone(env.TIMEZONE);
  const brand = (env.BRAND_NAME ?? '').trim() || DEFAULT_BRAND_NAME;
  const limit = readInt(env.SLIDESHOW_MAX_ITEMS, MAX_SLIDES, 1, MAX_SLIDES);

  const base: SlideshowResult = {
    status: 'skipped',
    candidates: 0,
    rendered: 0,
    sent: 0,
    translated: 0,
    withImage: 0,
    keywordItems: 0,
    browserRunMs: 0,
  };

  const destination = resolveDestination(env);
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!destination || !token) {
    return { ...base, reason: 'destination_or_token_missing' };
  }
  if (!env.BROWSER) {
    return { ...base, reason: 'browser_binding_missing' };
  }

  let items: SlideshowItem[];
  try {
    items = await selectSlideshowItems(env.DB, limit);
  } catch (error) {
    return { ...base, status: 'failed', reason: `select: ${describeError(error, 80)}` };
  }
  if (items.length === 0) return { ...base, reason: 'no_new_items' };

  base.candidates = items.length;

  const providers = resolveProviders(env);
  const budget = {
    db: env.DB,
    localDate: localDateKey(now, timeZone),
    dailyLimit: resolveDailyBudget(env.LLM_DAILY_BUDGET),
  };

  /* -- 2. translate the non-Persian items (one batched call) -------------- */
  const needsTranslation = items
    .map((item, ref) => ({ ref, headline: item.headline, summary: item.summary }))
    .filter(({ headline, summary }) => !isPersian(`${headline} ${summary}`));

  let translated = 0;
  if (needsTranslation.length > 0) {
    const map = await translateToPersian({
      providers,
      items: needsTranslation,
      budget,
      fetchImpl: opts.fetchImpl,
    });
    for (const [ref, text] of map) {
      items[ref] = { ...items[ref], headline: text.headline, summary: text.summary };
      translated++;
    }
  }
  base.translated = translated;

  /* -- 3. keywords (one batched call) ------------------------------------- */
  const keywordLists = await extractKeywords({
    providers,
    items: items.map((item) => ({ headline: item.headline, summary: item.summary })),
    budget,
    fetchImpl: opts.fetchImpl,
  });
  base.keywordItems = keywordLists.filter((list) => list.length > 0).length;

  /* -- 4. og:image per item ----------------------------------------------- */
  const images: (string | null)[] = [];
  for (const item of items) {
    images.push(item.sourceUrl ? await fetchOgImage(item.sourceUrl, { fetchImpl: opts.fetchImpl }) : null);
  }
  base.withImage = images.filter(Boolean).length;

  /* -- 5. render ----------------------------------------------------------- */
  const stamp = jalaliDateTime(now, timeZone);
  const total = items.length;
  const pages = items.map((item, i) => {
    const category = topicPresentation(item.category, `${item.headline} ${item.summary}`);
    return {
      meta: { item, category },
      html: buildSlideHtml({
        index: i + 1,
        total,
        category: { emoji: category.emoji, label: category.label },
        headline: item.headline,
        summary: item.summary,
        keywords: keywordLists[i] ?? [],
        imageUrl: images[i],
        sourceName: item.sourceName,
        brandName: brand,
        stamp,
      }),
    };
  });

  const render = await renderSlides({
    browser: env.BROWSER,
    pages,
    spacingMs: opts.spacingMs ?? DEFAULT_SLIDE_SPACING_MS,
    sleepImpl: opts.sleepImpl,
  });
  base.rendered = render.slides.length;
  base.browserRunMs = render.browserRunMs;

  if (render.slides.length === 0) {
    return { ...base, status: 'failed', reason: render.error ?? 'render_failed' };
  }

  /* -- 6. deliver ---------------------------------------------------------- */
  const captions = render.slides.map((slide, i) =>
    buildSlideCaption(
      {
        headline: slide.meta.item.headline,
        sourceName: slide.meta.item.sourceName,
        category: slide.meta.category,
      },
      i + 1,
      render.slides.length
    )
  );

  let sentMessages: SentMessage[] = [];
  try {
    if (render.slides.length >= MEDIA_GROUP_MIN_ITEMS) {
      sentMessages = await sendMediaGroup({
        token,
        chatId: destination as DestinationChat,
        media: render.slides.map((slide, i) => ({ photo: slide.png, caption: captions[i] })),
        fetchImpl: opts.fetchImpl,
      });
    } else {
      sentMessages = [
        await sendPhoto({
          token,
          chatId: destination,
          photo: render.slides[0].png,
          caption: captions[0],
          fetchImpl: opts.fetchImpl,
        }),
      ];
    }
  } catch (error) {
    const reason =
      error instanceof TelegramError ? `telegram_${error.status}: ${error.description}` : describeError(error, 80);
    // Nothing is marked sent, so every item stays eligible for the next run.
    return { ...base, status: 'failed', reason: reason.slice(0, 160) };
  }

  /* -- 7. mark sent, only now --------------------------------------------- */
  // Telegram returns the album messages in the order they were submitted, so
  // slide i maps to message i and we can keep each slide's own file_id.
  const delivered = render.slides.map((slide, i) => ({
    item: slide.meta.item,
    messageId: sentMessages[i]?.message_id ?? sentMessages[0]?.message_id ?? null,
    fileId: largestPhotoFileId(sentMessages[i]),
  }));
  await markSlidesSent(env.DB, delivered);
  base.sent = delivered.length;

  for (const slide of render.slides) {
    await archiveSlide(env.MEDIA, slide.meta.item.key, slide.png);
  }

  return {
    ...base,
    status: render.skipped > 0 ? 'partial' : 'success',
    ...(render.error ? { reason: render.error } : {}),
  };
}

/** Exposed for tests: the shape `renderSlides` hands back for a slideshow. */
export type SlideshowRenderedSlide = RenderedSlide<{
  item: SlideshowItem;
  category: { emoji: string; label: string };
}>;

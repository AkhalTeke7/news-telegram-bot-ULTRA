/**
 * One Liquid Glass news image per pipeline run.
 *
 * Purpose: a single 1920x1080 "front page" for the whole run, rendered through
 * Cloudflare Browser Run, showing the most important news across ALL enabled
 * source channels.
 *
 * Design constraints this module exists to satisfy:
 *  - AT MOST ONE Browser Run request per pipeline execution. Callers must
 *    invoke `renderRunImage()` once, outside any per-channel loop. Free-plan
 *    Quick Actions are rate limited to roughly one request per 10s, so a
 *    per-channel image would both break the budget and hit 429.
 *  - Rasterization happens inside Browser Run, never in this Worker: no WASM,
 *    no canvas, no local PNG encoding. The Worker only builds an HTML string.
 *  - The image is never persisted. The PNG exists as one local variable for the
 *    duration of the send and is dropped immediately afterwards; nothing is
 *    written to D1, R2 or any other store.
 *
 * The image is completely independent of the per-channel text digests: those
 * are still built and sent by `runPublishing()` exactly as before.
 */

import type { PublishableMessage } from './publisher';
import { formatTehranDateTime, tehranParts } from './time';

/** Hard cap required by the product: one image shows at most four news items. */
export const IMAGE_WIDTH = 1920;
export const IMAGE_HEIGHT = 1080;
export const MAX_IMAGE_ITEMS = 4;

/** Persian sentence terminators, used when cutting a readable card headline. */

/** Below this, a single sentence is too short to work as a headline. */
const MIN_HEADLINE_CHARS = 24;
const CARD_TITLE_MAX_CHARS = 90;

/** The Browser Run binding, structurally typed so tests can supply a fake. */
export interface BrowserBinding {
  quickAction(action: 'screenshot', payload: Record<string, unknown>): Promise<Response>;
}

export interface ImageNewsItem {
  /** Same row id the text digest marks published; not used for publishing. */
  id: number;
  channelUsername: string;
  /** Derived from the same summary text the digest publishes. */
  title: string;
  /** Byte-identical to the summary the Telegram digest will carry. */
  summary: string;
}

export interface ImageFrame {
  headline: string;
  kicker: string;
  date: string;
  time: string;
  /** Pre-formatted source line, e.g. `منبع: @a` or `منابع: @a · @b`. */
  footer: string;
  items: ImageNewsItem[];
}

/**
 * Source line for the image footer.
 *
 * A single represented channel keeps the singular form. When the Top 4 spans
 * several channels, every unique channel is listed once, in the order it first
 * appears among the selected items. Per-card `@channel` labels are unchanged.
 */
export function buildSourceFooter(items: ImageNewsItem[]): string {
  const seen: string[] = [];
  for (const item of items) {
    const name = item.channelUsername.trim();
    if (name && !seen.includes(name)) seen.push(name);
  }
  if (seen.length === 0) return '';
  if (seen.length === 1) return `منبع: @${seen[0]}`;
  return `منابع: ${seen.map((name) => `@${name}`).join(' · ')}`;
}

/**
 * Card headline for one item.
 *
 * There is no title column and the summarizer is explicitly instructed to emit
 * summary text only, so the headline is built from the SAME summary string the
 * digest publishes: the leading sentence(s), extended only when a single short
 * sentence would make a meaningless headline. No second AI call, no schema
 * change and no invented text.
 */
export function deriveCardTitle(summary: string): string {
  const clean = summary.replace(/\s+/g, ' ').trim();
  if (!clean) return '';

  // A single very short sentence ("اعلام شد.") is not a usable headline, so
  // keep adding following sentences until the headline is meaningful again.
  const sentences = clean
    .split(/(?<=[.؟!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  let headline = '';
  for (const sentence of sentences.length > 0 ? sentences : [clean]) {
    const candidate = headline ? `${headline} ${sentence}` : sentence;
    if (candidate.length > CARD_TITLE_MAX_CHARS) break;
    headline = candidate;
    if (headline.length >= MIN_HEADLINE_CHARS) break;
  }
  if (!headline) headline = clean.slice(0, CARD_TITLE_MAX_CHARS);

  if (headline.length <= CARD_TITLE_MAX_CHARS) return headline;
  const cut = headline.slice(0, CARD_TITLE_MAX_CHARS);
  const space = cut.lastIndexOf(' ');
  return (space > CARD_TITLE_MAX_CHARS * 0.6 ? cut.slice(0, space) : cut).trim();
}

/**
 * Picks the most important news for the single image.
 *
 * Importance comes from the AI ranking stage (`importance`, 1-5) and is the
 * PRIMARY key. Recency and id are tie-breakers only, so the result is stable
 * without ever overriding the model's judgement.
 *
 * Ranking happens over the flat publishable list, so it never depends on channel
 * order or on how many posts a channel contributed. Channels with no new posts
 * contribute no rows and are ignored.
 */
export function selectTopNews(
  items: readonly PublishableMessage[],
  limit = MAX_IMAGE_ITEMS
): ImageNewsItem[] {
  const usable = items.filter((i) => i.summaryText.trim().length > 0);
  if (usable.length === 0 || limit <= 0) return [];

  const ranked = [...usable].sort((a, b) => {
    const byImportance = (b.importance ?? 0) - (a.importance ?? 0);
    if (byImportance !== 0) return byImportance;
    const byDate = b.messageDate.localeCompare(a.messageDate);
    if (byDate !== 0) return byDate;
    return a.id - b.id;
  });

  return ranked.slice(0, limit).map((item) => ({
    id: item.id,
    channelUsername: item.channelUsername,
    // The AI headline when present; legacy rows without one fall back to the
    // summary's leading sentence so the card is never blank.
    title: item.title && item.title.trim() ? item.title.trim() : deriveCardTitle(item.summaryText),
    summary: item.summaryText,
  }));
}

/** Deterministic particle scatter: seeded PRNG, never Math.random(). */
function particles(count: number, seed: number): string {
  let a = seed >>> 0;
  const rnd = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const roll = rnd();
    const color = roll < 0.34 ? '#8fd3ff' : roll < 0.67 ? '#b79cff' : '#ffffff';
    out.push(
      `<i style="left:${(rnd() * 100).toFixed(3)}%;top:${(rnd() * 100).toFixed(3)}%;` +
        `width:${(1.2 + rnd() * 3.2).toFixed(2)}px;height:${(1.2 + rnd() * 3.2).toFixed(2)}px;` +
        `opacity:${(0.05 + rnd() * 0.15).toFixed(3)};background:${color}"></i>`
    );
  }
  return out.join('');
}

function esc(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Liquid Glass frame as HTML/CSS. Layout follows the same rules as the verified
 * renderer prototype: 1 item centred, 2 items centred, 3 items as 1-over-2,
 * 4 items as 2x2. Text is laid out by the browser, so Persian shaping is native.
 */
export function buildImageHtml(frame: ImageFrame): string {
  // The four-card maximum is enforced here as well as in selectTopNews(), so the
  // template can never lay out a fifth card outside the 2x2 grid.
  const items = frame.items.slice(0, MAX_IMAGE_ITEMS);
  const cards = items
    .map(
      (item, i) => `<article class="card" style="--accent:${
        ['#4f8cff', '#22d3ee', '#a78bfa', '#34d399'][i % 4]
      }">
        <div class="src">@${esc(item.channelUsername)}</div>
        <h2>${esc(item.title)}</h2>
        <p>${esc(item.summary)}</p>
      </article>`
    )
    .join('\n        ');

  const grid = ['one', 'two', 'three', 'four'][Math.max(0, Math.min(3, items.length - 1))];

  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<style>
  @font-face{font-family:'Vazirmatn';font-style:normal;font-weight:400;font-display:block;
    src:url('https://cdn.jsdelivr.net/gh/rastikerdar/vazirmatn@v33.003/fonts/webfonts/Vazirmatn-Regular.woff2') format('woff2');}
  @font-face{font-family:'Vazirmatn';font-style:normal;font-weight:800;font-display:block;
    src:url('https://cdn.jsdelivr.net/gh/rastikerdar/vazirmatn@v33.003/fonts/webfonts/Vazirmatn-Bold.woff2') format('woff2');}
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${IMAGE_WIDTH}px;height:${IMAGE_HEIGHT}px;overflow:hidden}
  body{font-family:'Vazirmatn',system-ui,sans-serif;color:#fff;position:relative;
    background:
      radial-gradient(ellipse 62% 62% at 82% 8%, rgba(37,99,235,.42), transparent 70%),
      radial-gradient(ellipse 60% 60% at 12% 95%, rgba(124,58,237,.34), transparent 70%),
      linear-gradient(135deg,#04060f 0%,#0a1230 45%,#120c28 100%);}
  .particles{position:absolute;inset:0}
  .particles i{position:absolute;border-radius:50%;display:block}
  .frame{position:relative;width:${IMAGE_WIDTH}px;height:${IMAGE_HEIGHT}px;padding:96px 130px 0;display:flex;flex-direction:column}
  .head{display:flex;justify-content:space-between;align-items:flex-start}
  .head h1{font-size:62px;font-weight:800;line-height:1.15}
  .kicker{font-size:30px;font-weight:500;color:#9fb6d4;margin-top:10px}
  .pill{display:flex;align-items:center;gap:26px;padding:26px 40px;border-radius:52px;
    background:linear-gradient(180deg,rgba(255,255,255,.15),rgba(255,255,255,.055));
    border:2px solid rgba(255,255,255,.26);font-size:32px;font-weight:600}
  .pill .time{font-weight:700;color:#7dd3fc}
  .rule{height:2px;margin-top:42px;border-radius:1px;
    background:linear-gradient(90deg,transparent,#4f8cff 50%,transparent)}
  .grid{flex:1;display:grid;gap:20px;padding:24px 0 0;min-height:0}
  .grid.one{grid-template-columns:1fr;grid-template-rows:1fr}
  .grid.two{grid-template-columns:1fr 1fr;grid-template-rows:1fr}
  .grid.three{grid-template-columns:1fr 1fr;grid-template-rows:auto 1fr}
  .grid.three .card:first-child{grid-column:1/-1}
  .grid.four{grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr}
  .card{position:relative;overflow:hidden;border-radius:34px;padding:28px 44px 28px 56px;
    background:linear-gradient(180deg,rgba(255,255,255,.15),rgba(255,255,255,.055));
    border:2px solid rgba(255,255,255,.30);
    display:flex;flex-direction:column;justify-content:center;gap:12px}
  .card::before{content:'';position:absolute;inset:0 0 auto 0;height:40%;
    background:linear-gradient(180deg,rgba(255,255,255,.10),transparent);pointer-events:none}
  .card::after{content:'';position:absolute;top:22%;bottom:22%;right:0;width:5px;border-radius:3px;
    background:var(--accent);opacity:.75}
  .card .src{position:relative;font-size:24px;font-weight:600;color:#7dd3fc;direction:ltr;
    text-align:right;letter-spacing:.5px}
  .card h2{position:relative;font-size:44px;font-weight:800;line-height:1.32}
  .card p{position:relative;font-size:29px;font-weight:400;line-height:1.45;color:#d7e6f7;opacity:.93}
  .foot{padding:24px 0 38px;font-size:32px;font-weight:600;color:#cfe0f5;text-align:right}
</style>
</head>
<body>
  <div class="particles">${particles(78, 0x5eed1234)}</div>
  <div class="frame">
    <div class="head">
      <div>
        <h1>${esc(frame.headline)}</h1>
        <div class="kicker">${esc(frame.kicker)}</div>
      </div>
      <div class="pill">
        <span>${esc(frame.date)}</span><span class="time">${esc(frame.time)}</span>
      </div>
    </div>
    <div class="rule"></div>
    <section class="grid ${grid}">
        ${cards}
    </section>
    <div class="foot">${esc(frame.footer)}</div>
  </div>
</body>
</html>`;
}

/** Builds the frame for a run, using the project's Asia/Tehran handling. */
export function buildRunFrame(items: ImageNewsItem[], now: Date): ImageFrame {
  const parts = tehranParts(now);
  const full = formatTehranDateTime(now);
  const [date, time] = full ? full.split(' - ') : ['', ''];
  return {
    headline: 'اخبار لحظه‌ای',
    kicker: 'گزارش خبری خودکار',
    date: date || (parts ? `${parts.year}/${parts.month}/${parts.day}` : ''),
    time: time || (parts ? `${parts.hour}:${parts.minute}` : ''),
    footer: buildSourceFooter(items),
    items,
  };
}

export interface RenderedImage {
  png: ArrayBuffer;
  bytes: number;
  width: number;
  height: number;
  browserRunMs: number;
  /** Exactly what the image shows, in display order. */
  items: ImageNewsItem[];
}

export class NewsImageError extends Error {
  constructor(
    readonly stage: 'build' | 'browser_run' | 'validate',
    message: string
  ) {
    super(message);
    this.name = 'NewsImageError';
  }
}

/** PNG signature + IHDR dimensions, so a non-PNG reply is never trusted. */
function readPngSize(buffer: ArrayBuffer): { width: number; height: number } | null {
  if (buffer.byteLength < 24) return null;
  const view = new DataView(buffer);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i++) if (view.getUint8(i) !== signature[i]) return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export interface RenderRunImageOptions {
  browser: BrowserBinding | undefined;
  items: readonly PublishableMessage[];
  now?: Date;
  timeoutMs?: number;
}

/**
 * Renders THE single image for this pipeline run.
 *
 * Must be called at most once per run. Returns null when there is nothing worth
 * showing (no publishable news) or when no Browser Run binding is configured —
 * in both cases no Browser Run request is made.
 */
export async function renderRunImage(
  opts: RenderRunImageOptions
): Promise<RenderedImage | null> {
  const selected = selectTopNews(opts.items);
  if (selected.length === 0) return null;
  if (!opts.browser) return null;

  const html = buildImageHtml(buildRunFrame(selected, opts.now ?? new Date()));
  const started = Date.now();

  let response: Response;
  try {
    response = await opts.browser.quickAction('screenshot', {
      html,
      viewport: { width: IMAGE_WIDTH, height: IMAGE_HEIGHT, deviceScaleFactor: 1 },
      screenshotOptions: { type: 'png', fullPage: false, captureBeyondViewport: false },
      gotoOptions: { waitUntil: 'networkidle0', timeout: opts.timeoutMs ?? 20_000 },
    });
  } catch (e) {
    throw new NewsImageError('browser_run', e instanceof Error ? e.message : String(e));
  }

  const browserRunMs = Date.now() - started;
  const png = await response.arrayBuffer();
  const size = readPngSize(png);
  if (!response.ok || !size) {
    throw new NewsImageError(
      'validate',
      `Browser Run did not return a PNG (status ${response.status})`
    );
  }

  return {
    png,
    bytes: png.byteLength,
    width: size.width,
    height: size.height,
    browserRunMs,
    items: selected,
  };
}
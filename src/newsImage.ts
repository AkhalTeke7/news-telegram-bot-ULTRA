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
  /** Brand signature displayed in the footer. */
  signature?: string;
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
  // An explicit AI score of 1 means "not worth publishing". Keep NULL rows
  // as a backwards-compatible fallback for messages created before the
  // importance migration; a failed ranking run must not make those rows vanish
  // from the normal publishing path.
  const usable = items.filter(
    (i) => i.summaryText.trim().length > 0 && i.importance !== 1
  );
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

/** Glossy decorative bubbles matching the reference dashboard. */
function bubbles(): string {
  const bubble = (cls: string, left: number, top: number, size: number): string =>
    `<div class="bubble ${cls}" style="left:${left}px;top:${top}px;width:${size}px;height:${size}px"></div>`;
  return [
    bubble('gold', 420, 50, 96),
    bubble('', 36, 760, 150),
    bubble('gold mini', 170, 930, 48),
    bubble('', 1700, 905, 96),
  ].join('');
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
  const cards = frame.items
    .map(
      (item, i) => `<article class="card" style="--accent:${
        ['#3f5efb', '#8e54bf', '#fc466b', '#43b89c'][i % 4]
      }">
        <div class="src">@${esc(item.channelUsername)}</div>
        <h2>${esc(item.title)}</h2>
        <p>${esc(item.summary)}</p>
      </article>`
    )
    .join('\n        ');

  const grid = ['one', 'two', 'three', 'four'][Math.max(0, Math.min(3, frame.items.length - 1))];

  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bitcount+Ink&display=block" rel="stylesheet">
<style>
  @font-face{font-family:'Vazirmatn';font-style:normal;font-weight:400;font-display:block;
    src:url('https://cdn.jsdelivr.net/gh/rastikerdar/vazirmatn@v33.003/fonts/webfonts/Vazirmatn-Regular.woff2') format('woff2');}
  @font-face{font-family:'Vazirmatn';font-style:normal;font-weight:800;font-display:block;
    src:url('https://cdn.jsdelivr.net/gh/rastikerdar/vazirmatn@v33.003/fonts/webfonts/Vazirmatn-Bold.woff2') format('woff2');}
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${IMAGE_WIDTH}px;height:${IMAGE_HEIGHT}px;overflow:hidden}
  body{font-family:'Vazirmatn',system-ui,sans-serif;color:#1d2433;position:relative;
    background:
      radial-gradient(circle at 10% 8%, rgba(252,70,107,.20), transparent 28%),
      radial-gradient(circle at 92% 88%, rgba(63,94,251,.24), transparent 34%),
      linear-gradient(135deg,#e8edf8 0%,#dfe5f1 42%,#eef1ed 100%);}
  .particles{position:absolute;inset:0}
  .particles i{position:absolute;border-radius:50%;display:block}
  .bubble{position:absolute;pointer-events:none;border-radius:50%;background:radial-gradient(circle at 30% 24%,rgba(255,255,255,.95),rgba(255,255,255,.2) 18%,rgba(150,170,205,.35) 100%);border:1px solid rgba(255,255,255,.8);box-shadow:inset 8px 8px 18px rgba(255,255,255,.9),inset -11px -14px 24px rgba(105,120,155,.35),0 20px 30px rgba(70,80,110,.2)}
  .bubble.gold{background:radial-gradient(circle at 30% 24%,#fffbe6,rgba(255,225,120,.5) 20%,rgba(238,176,30,.45) 100%)}
  .bubble.mini{box-shadow:inset 3px 3px 7px rgba(255,251,225,.9),inset -4px -5px 9px rgba(200,140,10,.28),0 8px 12px rgba(190,140,30,.2)}
  .frame{position:relative;width:${IMAGE_WIDTH}px;height:${IMAGE_HEIGHT}px;padding:72px 78px 0;display:flex;flex-direction:column}
  .frame::before{content:'';position:absolute;inset:168px 28px 34px;border-radius:42px;
    background:rgba(255,255,255,.38);border:2px solid rgba(255,255,255,.72);
    box-shadow:0 24px 70px rgba(63,94,251,.12),inset 0 1px 0 rgba(255,255,255,.88);z-index:-1}
  .head{display:flex;justify-content:space-between;align-items:flex-start;padding:0 18px}
  .head h1{font-size:58px;font-weight:800;line-height:1.15;color:#202838;letter-spacing:-1px}
  .kicker{font-size:30px;font-weight:500;color:#6e7483;margin-top:10px}
  .pill{display:flex;align-items:center;gap:26px;padding:26px 40px;border-radius:52px;
    background:linear-gradient(180deg,rgba(255,255,255,.78),rgba(255,255,255,.42));
    border:2px solid rgba(255,255,255,.82);font-size:32px;font-weight:600;color:#343b4a;box-shadow:0 14px 32px rgba(63,94,251,.12)}
  .pill{position:relative;min-width:420px;min-height:150px;justify-content:center;flex-direction:column;gap:2px}
  .pill svg{position:absolute;inset:0;width:100%;height:100%;z-index:-1;fill:rgba(180,210,245,.45);stroke:rgba(255,255,255,.9);stroke-width:2;filter:drop-shadow(0 10px 14px rgba(70,95,150,.22))}
  .pill .time{font-weight:700;color:#3a6fb8}
  .rule{height:2px;margin-top:42px;border-radius:1px;
    background:linear-gradient(90deg,transparent,#8e54bf 42%,#fc466b 72%,transparent)}
  .grid{flex:1;display:grid;gap:22px;padding:28px 28px 0;min-height:0}
  .grid.one{grid-template-columns:1fr;grid-template-rows:1fr}
  .grid.two{grid-template-columns:1fr 1fr;grid-template-rows:1fr}
  .grid.three{grid-template-columns:1fr 1fr;grid-template-rows:auto 1fr}
  .grid.three .card:first-child{grid-column:1/-1}
  .grid.four{grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr}
  .card{position:relative;overflow:hidden;border-radius:28px;padding:30px 40px 30px 52px;
    background:linear-gradient(180deg,rgba(255,255,255,.82),rgba(255,255,255,.48));
    border:2px solid rgba(255,255,255,.86);
    box-shadow:0 18px 42px rgba(63,94,251,.13), inset 0 1px 0 rgba(255,255,255,.9);
    display:flex;flex-direction:column;justify-content:center;gap:12px}
  .card::before{content:'';position:absolute;inset:0 0 auto 0;height:40%;
    background:linear-gradient(180deg,rgba(255,255,255,.55),transparent);pointer-events:none}
  .card::after{content:'';position:absolute;top:22%;bottom:22%;right:0;width:5px;border-radius:3px;
    background:var(--accent);opacity:.75}
  .card .src{position:relative;font-size:24px;font-weight:600;color:#3f5efb;direction:ltr;
    text-align:right;letter-spacing:.5px}
  .card h2{position:relative;font-size:40px;font-weight:800;line-height:1.32;color:#202838}
  .card p{position:relative;font-size:27px;font-weight:400;line-height:1.45;color:#596274;opacity:.93}
  .foot{display:flex;justify-content:space-between;align-items:center;padding:22px 28px 34px;font-size:28px;font-weight:600;color:#596274;text-align:right}
  .sig{font-family:'Bitcount Ink',system-ui,sans-serif;font-size:34px;font-weight:400;letter-spacing:1px;color:#8e54bf;direction:ltr}
</style>
</head>
<body>
  <div class="particles">${particles(14, 0x5eed1234)}</div>
  ${bubbles()}
  <div class="frame">
    <div class="head">
      <div>
        <h1>${esc(frame.headline)}</h1>
        <div class="kicker">${esc(frame.kicker)}</div>
      </div>
      <div class="pill">
        <svg viewBox="0 0 372 150" aria-hidden="true"><path d="M66 128A34 34 0 0 1 66 60A32 32 0 0 1 122 44A52 52 0 0 1 214 40A50 50 0 0 1 306 60A34 34 0 0 1 306 128Z"/></svg>
        <span>${esc(frame.date)}</span><span class="time">${esc(frame.time)}</span>
      </div>
    </div>
    <div class="rule"></div>
    <section class="grid ${grid}">
        ${cards}
    </section>
    <div class="foot"><span>${esc(frame.footer)}</span><span class="sig">${esc(frame.signature ?? 'Akhal-Teke')}</span></div>
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
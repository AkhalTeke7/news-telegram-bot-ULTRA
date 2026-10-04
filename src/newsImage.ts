/**
 * White-template news slides for pipeline runs.
 *
 * Purpose: a per-run ALBUM (Telegram `sendMediaGroup` slideshow) built from a
 * FIXED HTML layout with clearly defined sections — header (run title + Tehran
 * date/time stamp), news board (the 2×2 grid carrying FOUR news items per
 * slide: emoji + headline + introductory text + source), optional overflow
 * ticker on the last slide, and footer (source credits + signature).
 *
 * Every slide covers four news items, so the whole run's news is spread across
 * a swipeable slideshow instead of being squeezed into one composite image.
 * The headline and introductory text are the AI-authored `title` and `summary`
 * of each item — the exact text the site/source content was condensed into —
 * so a slide exists only for news the AI actually processed (no AI, no slide).
 *
 * Design constraints this module exists to satisfy:
 *  - at most `MAX_ALBUM_SLIDES` Browser Run requests per pipeline execution
 *    (one per slide), spaced by `DEFAULT_IMAGE_RENDER_SPACING_MS`, because the
 *    Workers Free plan allows roughly one Quick Action every 10 seconds. A 429
 *    from Browser Run skips the remaining slides instead of hammering.
 *  - Rasterization happens inside Browser Run, never in this Worker: no WASM,
 *    no canvas, no local PNG encoding. The Worker only builds an HTML string.
 *  - The images are never persisted. Each PNG exists as one local variable
 *    for the duration of the send and is dropped immediately afterwards;
 *    nothing is written to D1, R2 or any other store.
 *  - The album is completely independent of the per-channel text digests:
 *    those are still built and sent by `runPublishing()` exactly as before.
 */

import type { PublishableMessage } from './publisher';
import { topicPresentation } from './topic';
import { formatTehranDateTime, tehranParts } from './time';

/**
 * High-resolution output keeps the summary readable after Telegram scales the
 * photo down in a channel preview. The HTML viewport and the PNG share these
 * dimensions, so Browser Run captures the larger canvas rather than merely
 * stretching a small image.
 */
export const IMAGE_WIDTH = 2560;
export const IMAGE_HEIGHT = 1440;
/** One slide covers four news items: the fixed 2×2 grid of the template. */
export const MAX_IMAGE_ITEMS = 4;
/** Slides per album; Telegram `sendMediaGroup` accepts at most ten photos. */
export const MAX_ALBUM_SLIDES = 10;
/** News items the whole slideshow can carry (MAX_ALBUM_SLIDES × 4). */
export const MAX_ALBUM_NEWS = MAX_ALBUM_SLIDES * MAX_IMAGE_ITEMS;

/** Below this, a single sentence is too short to work as a headline. */
const MIN_HEADLINE_CHARS = 24;
const CARD_TITLE_MAX_CHARS = 90;

/** Ticker: every remaining headline, one per line, kept brief. */
export const MAX_TICKER_ITEMS = 8;
export const TICKER_MAX_CHARS = 72;

/**
 * The Browser Run binding, structurally typed so tests can supply a fake.
 *
 * Two call shapes are accepted because the Workers binding has been exposed
 * under different names across its lifetime: the Quick Action form
 * (`quickAction('screenshot', …)`) and the direct form (`screenshot(…)`).
 * Whichever the deployment exposes is used; when neither exists the render
 * fails with a typed error instead of a silent "render_failed" mystery.
 */
export interface BrowserBinding {
  quickAction?(action: 'screenshot', payload: Record<string, unknown>): Promise<Response>;
  screenshot?(payload: Record<string, unknown>): Promise<Response>;
}

/**
 * Dispatches one screenshot request through whichever binding method exists.
 * All renderers go through here, so the dispatch lives in exactly one place.
 */
export async function browserScreenshot(
  browser: BrowserBinding,
  payload: Record<string, unknown>
): Promise<Response> {
  if (typeof browser.quickAction === 'function') return browser.quickAction('screenshot', payload);
  if (typeof browser.screenshot === 'function') return browser.screenshot(payload);
  throw new NewsImageError(
    'browser_run',
    'Browser Run binding exposes no screenshot method (quickAction/screenshot).'
  );
}

export interface ImageNewsItem {
  /** Same row id the text digest marks published; not used for publishing. */
  id: number;
  channelUsername: string;
  /** AI topic category, used only for the small topic emoji. */
  category?: string | null;
  /** Derived from the same summary text the digest publishes. */
  title: string;
  /** Byte-identical to the summary the Telegram digest will carry. */
  summary: string;
}

/** One single-line entry in the horizontal ticker below the cards. */
export interface TickerNewsItem {
  id: number;
  channelUsername: string;
  /** Already truncated to TICKER_MAX_CHARS so the line stays brief. */
  text: string;
  /** Marks the trailing «و n خبر دیگر» overflow line. */
  more?: boolean;
}

export interface TickerSelection {
  items: TickerNewsItem[];
  /** Rows left over after MAX_TICKER_ITEMS; shown as «و n خبر دیگر». */
  hidden: number;
}

/** Persian digits for the image, matching the fa-IR date/time formatting. */
export function faDigits(value: number): string {
  const FA = '۰۱۲۳۴۵۶۷۸۹';
  return String(value).replace(/\d/g, (d) => FA[Number(d)]);
}

/** Brief one-line headline for the ticker: truncate at a word boundary. */
function truncateLine(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export interface ImageFrame {
  headline: string;
  kicker: string;
  date: string;
  time: string;
  /** Pre-formatted source line, e.g. `منبع: @a` or `منابع: @a · @b`. */
  footer: string;
  /** Brand signature in the footer corner; defaults to `Akhal-Teke / DwAArKa`. */
  signature?: string;
  items: ImageNewsItem[];
  /** Remaining headlines for the ticker strip; absent when there are none. */
  ticker?: TickerNewsItem[];
}

/**
 * Source line for the image footer.
 *
 * A single represented channel keeps the singular form. When the image spans
 * several channels — cards AND ticker lines — every unique channel is listed
 * once, in the order it first appears among the selected items. Per-card
 * `@channel` labels are unchanged.
 */
export function buildSourceFooter(
  items: readonly { channelUsername: string }[]
): string {
  const seen: string[] = [];
  for (const item of items) {
    const name = item.channelUsername.trim();
    if (name && !seen.includes(name)) seen.push(name);
  }
  if (seen.length === 0) return '';
  if (seen.length === 1) return `منبع: ${channelLabel(seen[0])}`;
  return `منابع: ${seen.map(channelLabel).join(' · ')}`;
}

/**
 * `@username` for real ASCII usernames; RSS display titles (Persian text)
 * appear verbatim, never with an invented `@`.
 */
export function channelLabel(name: string): string {
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(name) ? `@${name}` : name;
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
    category: item.category,
    // The AI headline when present; legacy rows without one fall back to the
    // summary's leading sentence so the card is never blank.
    title: item.title && item.title.trim() ? item.title.trim() : deriveCardTitle(item.summaryText),
    summary: item.summaryText,
  }));
}

/**
 * Every remaining headline for the horizontal ticker below the cards.
 *
 * Same eligibility and ordering as selectTopNews, minus the top cards already
 * chosen. Each entry becomes ONE brief line (title, else the derived headline,
 * truncated to TICKER_MAX_CHARS). Items beyond MAX_TICKER_ITEMS are counted in
 * `hidden` so the frame can end the ticker with «و n خبر دیگر».
 */
export function selectTickerNews(
  items: readonly PublishableMessage[],
  excludeIds: ReadonlySet<number>,
  limit = MAX_TICKER_ITEMS
): TickerSelection {
  const usable = items.filter(
    (i) =>
      i.summaryText.trim().length > 0 &&
      i.importance !== 1 &&
      !excludeIds.has(i.id)
  );
  if (usable.length === 0 || limit <= 0) return { items: [], hidden: 0 };

  const ranked = [...usable].sort((a, b) => {
    const byImportance = (b.importance ?? 0) - (a.importance ?? 0);
    if (byImportance !== 0) return byImportance;
    const byDate = b.messageDate.localeCompare(a.messageDate);
    if (byDate !== 0) return byDate;
    return a.id - b.id;
  });

  const shown = ranked.slice(0, limit).map((item) => ({
    id: item.id,
    channelUsername: item.channelUsername,
    text: truncateLine(
      item.title && item.title.trim() ? item.title.trim() : deriveCardTitle(item.summaryText),
      TICKER_MAX_CHARS
    ),
  }));

  return { items: shown, hidden: Math.max(0, ranked.length - shown.length) };
}

/** Glossy decorative bubbles (white + gold), same look as the price-board style. */
function bubbles(): string {
  const b = (cls: string, l: number, t: number, w: number, h: number, r: number): string =>
    `<div class="bubble ${cls}" style="left:${l}px;top:${t}px;width:${w}px;height:${h}px;transform:rotate(${r}deg)"></div>`;
  return [
    b('gold', 420, 50, 96, 92, -8),
    b('', 36, 760, 150, 146, -6),
    b('gold mini', 170, 930, 48, 46, 0),
    b('', 1700, 905, 96, 94, 10),
  ].join('');
}

function esc(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const ACCENTS = ['#1fb98a', '#f0b34a', '#5b9dff', '#d34f74'];

/**
 * Frosted white "liquid glass" frame as HTML/CSS: pastel mesh background, glossy
 * bubbles, a big glass board holding one glass card per news item. Layout:
 * 1 item centred, 2 side by side, 3 as 1-over-2, 4 as 2x2. Text is laid out by
 * the browser, so Persian shaping is native.
 *
 * `layout: 'four'` forces the FIXED 2×2 news board — the layout every full
 * album slide uses, so the slideshow has one constant template with clearly
 * defined sections (header / news board / ticker / footer). The adaptive
 * layouts remain only for the trailing partial slide and the preview page.
 */
export function buildImageHtml(frame: ImageFrame, layout: 'auto' | 'four' = 'auto'): string {
  // The four-card maximum is enforced here as well as in selectTopNews(), so the
  // template can never lay out a fifth card outside the 2x2 grid.
  const items = frame.items.slice(0, MAX_IMAGE_ITEMS);
  const cards = items
    .map((item, i) => {
      const topic = topicPresentation(item.category, `${item.title} ${item.summary}`);
      return `<article class="card" style="--c:${ACCENTS[i % 4]}">
        <div class="top">
          <span class="icon" aria-label="${esc(topic.label)}">${topic.emoji}</span>
          <div class="txt"><h2>${esc(item.title)}</h2><div class="sub">${esc(topic.label)} · ${esc(channelLabel(item.channelUsername))}</div></div>
        </div>
        <p>${esc(item.summary)}</p>
        <div class="live">زنده</div>
      </article>`;
    })
    .join('\n        ');

  const grid =
    layout === 'four'
      ? 'four' // FIXED slide layout: always the 2×2 news board.
      : ['one', 'two', 'three', 'four'][Math.max(0, Math.min(3, items.length - 1))];
  const tickerItems = frame.ticker ?? [];

  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bitcount+Ink&family=Vazirmatn:wght@300;400;500;700;800&display=block" rel="stylesheet">
<style>
  @font-face{font-family:'VazirFallback';font-weight:400;font-display:block;
    src:url('https://cdn.jsdelivr.net/gh/rastikerdar/vazirmatn@v33.003/fonts/webfonts/Vazirmatn-Regular.woff2') format('woff2');}
  @font-face{font-family:'VazirFallback';font-weight:800;font-display:block;
    src:url('https://cdn.jsdelivr.net/gh/rastikerdar/vazirmatn@v33.003/fonts/webfonts/Vazirmatn-Bold.woff2') format('woff2');}
  :root{--ink:#1c2029;--soft:#6f7683;--up:#159d78;--line:rgba(70,80,100,.28)}
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${IMAGE_WIDTH}px;height:${IMAGE_HEIGHT}px;overflow:hidden}
  body{position:relative;font-family:'Vazirmatn','VazirFallback',system-ui,sans-serif;color:var(--ink);
    background:
      radial-gradient(ellipse 45% 60% at 0% 55%,#a9b0cb 0%,transparent 70%),
      radial-gradient(ellipse 40% 50% at 100% 15%,#b4cdca 0%,transparent 70%),
      radial-gradient(ellipse 35% 45% at 100% 100%,#d7dfc2 0%,transparent 70%),
      radial-gradient(ellipse 50% 50% at 50% 45%,#e8eaf1 0%,transparent 80%),#cfd5e0}
  .rule{position:absolute;left:4%;right:4%;height:1px;background:var(--line)}
  .rule.t{top:4.5%}.rule.b{top:96%}
  .bubble{position:absolute;pointer-events:none;border-radius:46% 54% 50% 50%/52% 46% 54% 48%;
    background:radial-gradient(circle at 30% 24%,rgba(255,255,255,.95) 0,rgba(255,255,255,.35) 14%,rgba(255,255,255,0) 40%),
      radial-gradient(circle at 70% 78%,rgba(255,255,255,.55) 0,rgba(255,255,255,0) 35%),
      radial-gradient(circle at 50% 50%,rgba(255,255,255,.08) 0,rgba(190,202,225,.42) 100%);
    border:1px solid rgba(255,255,255,.75);
    box-shadow:inset 8px 8px 18px rgba(255,255,255,.9),inset -11px -14px 24px rgba(105,120,155,.38),0 20px 30px rgba(70,80,110,.2)}
  .bubble.gold{opacity:.92;
    background:radial-gradient(circle at 30% 24%,rgba(255,251,230,.97) 0,rgba(255,232,150,.5) 16%,rgba(255,205,70,0) 43%),
      radial-gradient(circle at 70% 78%,rgba(255,214,90,.6) 0,rgba(255,190,40,0) 40%),
      radial-gradient(circle at 50% 50%,rgba(255,214,80,.14) 0,rgba(238,176,30,.46) 100%);
    border-color:rgba(255,242,190,.9);
    box-shadow:inset 8px 8px 18px rgba(255,251,225,.92),inset -11px -14px 24px rgba(200,140,10,.28),0 16px 26px rgba(190,140,30,.2)}
  .bubble.mini{box-shadow:inset 3px 3px 7px rgba(255,251,225,.9),inset -4px -5px 9px rgba(200,140,10,.28),0 8px 12px rgba(190,140,30,.2)}
  .frame{position:relative;z-index:2;width:${IMAGE_WIDTH}px;height:${IMAGE_HEIGHT}px;padding:96px 150px 0;display:flex;flex-direction:column}
  .head{display:flex;justify-content:space-between;align-items:center;padding:0 8px}
  .title{display:flex;align-items:center;gap:22px;font-size:84px;font-weight:800;line-height:1.1;text-shadow:1px 1px 0 rgba(255,255,255,.5)}
  .title i{width:20px;height:20px;border-radius:50%;background:#e9a93a;box-shadow:0 0 0 8px rgba(255,255,255,.55),0 0 24px rgba(233,169,58,.6)}
  .kicker{margin:10px 42px 0 0;font-size:30px;font-weight:400;color:var(--soft)}
  .stamp{position:relative;width:500px;height:170px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
  .stamp svg{position:absolute;inset:0;width:100%;height:100%;z-index:-1;filter:drop-shadow(0 10px 14px rgba(70,95,150,.22))}
  .stamp .d{font-size:38px;font-weight:500}.stamp .tm{margin-top:2px;font-size:30px;font-weight:700;color:#3a6fb8}
  .grid{flex:1;display:grid;gap:28px;margin-top:24px;padding:32px;border-radius:52px;min-height:0;
    background:radial-gradient(ellipse at 30% 0%,rgba(255,255,255,.85) 0%,rgba(255,255,255,0) 60%),linear-gradient(145deg,rgba(255,255,255,.62),rgba(255,255,255,.34));
    border:1px solid rgba(255,255,255,.85);
    box-shadow:0 40px 80px rgba(70,82,110,.18),0 0 0 6px rgba(255,255,255,.14),inset 2px 2px 3px rgba(255,255,255,.95),inset -2px -2px 6px rgba(170,182,205,.28),inset 0 0 40px rgba(255,255,255,.35)}
  .grid.one{grid-template-columns:1fr;grid-template-rows:1fr}
  .grid.two{grid-template-columns:1fr 1fr;grid-template-rows:1fr}
  .grid.three{grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr}
  .grid.three .card:first-child{grid-column:1/-1}
  .grid.four{grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr}
  .card{position:relative;overflow:hidden;min-height:0;display:flex;flex-direction:column;justify-content:flex-start;gap:18px;padding:34px 42px;border-radius:34px;
    background:linear-gradient(145deg,rgba(255,255,255,.78),rgba(255,255,255,.34));border:1px solid rgba(255,255,255,.78);
    box-shadow:inset 1px 1px 2px rgba(255,255,255,.9),0 12px 24px rgba(70,82,110,.12)}
  .top{display:flex;align-items:center;gap:22px}
  .icon{flex:none;width:78px;height:78px;display:grid;place-items:center;border-radius:24px;font-size:44px;font-weight:800;color:var(--c);
    background:linear-gradient(145deg,rgba(255,255,255,.9),rgba(255,255,255,.28));border:1px solid rgba(255,255,255,.9);
    box-shadow:inset 1px 1px 2px #fff,0 6px 14px rgba(70,82,110,.14)}
  .txt{min-width:0}
  h2{font-size:50px;font-weight:800;line-height:1.28;letter-spacing:-.3px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;color:#17202c}
  .sub{margin-top:5px;font-size:24px;font-weight:600;letter-spacing:1px;color:#596577;direction:ltr;text-align:right}
  p{font-size:34px;font-weight:500;line-height:1.55;color:#26313f;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
  .live{align-self:flex-start;display:flex;align-items:center;gap:10px;height:40px;padding:0 18px;border-radius:15px;font-size:21px;font-weight:600;color:var(--up);
    background:rgba(21,157,120,.1);border:1px solid rgba(21,157,120,.25)}
  .live::before{content:"";width:11px;height:11px;border-radius:50%;background:var(--up);box-shadow:0 0 0 5px rgba(21,157,120,.18)}
  .grid.one h2{font-size:76px}.grid.one p{font-size:50px;-webkit-line-clamp:7}.grid.one .icon{width:102px;height:102px;font-size:56px}
  .grid.two h2{font-size:62px;-webkit-line-clamp:3}.grid.two p{font-size:40px;-webkit-line-clamp:6}
  .grid.three .card:first-child p{-webkit-line-clamp:3}.grid.three p{-webkit-line-clamp:3}.grid.three h2{font-size:46px}
  .grid.four h2{font-size:44px}.grid.four p{font-size:32px;-webkit-line-clamp:3}
  .ticker{display:flex;align-items:flex-start;gap:24px;margin-top:18px;padding:20px 34px;border-radius:30px;
    background:linear-gradient(145deg,rgba(255,255,255,.58),rgba(255,255,255,.28));border:1px solid rgba(255,255,255,.7);
    box-shadow:inset 1px 1px 2px rgba(255,255,255,.9),0 8px 18px rgba(70,82,110,.08)}
  .tlabel{flex:none;margin-top:3px;font-size:30px;font-weight:800;color:var(--soft)}
  .titems{display:flex;flex-wrap:wrap;align-items:center;gap:10px 16px;min-width:0}
  .ti{max-width:980px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:30px;font-weight:500;line-height:1.55;color:#2d3745}
  .ti.more{color:var(--soft);font-weight:600}
  .tdot{flex:none;color:var(--soft);font-size:30px;line-height:1.55;opacity:.7}
  .foot{display:flex;justify-content:space-between;align-items:center;padding:0 16px;height:104px;font-size:32px;font-weight:600;color:#323b49}
  .sig{font-family:'Bitcount Ink',Arial,sans-serif;font-size:38px;font-weight:400;letter-spacing:.8px;direction:ltr;text-shadow:1px 1px 0 rgba(255,255,255,.65)}
</style>
</head>
<body>
  <div class="rule t"></div><div class="rule b"></div>
  ${bubbles()}
  <div class="frame">
    <div class="head">
      <div>
        <div class="title"><i></i>${esc(frame.headline)}</div>
        <div class="kicker">${esc(frame.kicker)}</div>
      </div>
      <div class="stamp">
        <svg viewBox="0 0 372 150" preserveAspectRatio="none" aria-hidden="true">
          <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".92"/><stop offset=".5" stop-color="#bfd8f6" stop-opacity=".55"/><stop offset="1" stop-color="#7ea5dd" stop-opacity=".5"/></linearGradient></defs>
          <path d="M66 128A34 34 0 0 1 66 60A32 32 0 0 1 122 44A52 52 0 0 1 214 40A50 50 0 0 1 306 60A34 34 0 0 1 306 128Z" fill="url(#g)" stroke="rgba(255,255,255,.9)" stroke-width="2"/>
          <ellipse cx="92" cy="50" rx="22" ry="5" fill="#fff" opacity=".65" transform="rotate(-18 92 50)"/>
        </svg>
        <div class="d">${esc(frame.date)}</div><div class="tm">${esc(frame.time)}</div>
      </div>
    </div>
    <section class="grid ${grid}">
        ${cards}
    </section>
    ${tickerItems.length > 0 ? `<section class="ticker">
      <span class="tlabel">سایر عناوین</span>
      <div class="titems">${tickerItems
        .map((t) => `<span class="ti${t.more ? ' more' : ''}">${esc(t.text)}</span>`)
        .join('<span class="tdot">·</span>')}</div>
    </section>` : ''}
    <div class="foot"><span>${esc(frame.footer)}</span><span class="sig">${esc(frame.signature ?? 'Akhal-Teke / DwAArKa')}</span></div>
  </div>
</body>
</html>`;
}

/** Builds the frame for a run, using the project's Asia/Tehran handling. */
export function buildRunFrame(
  items: ImageNewsItem[],
  now: Date,
  ticker: TickerNewsItem[] = []
): ImageFrame {
  const parts = tehranParts(now);
  const full = formatTehranDateTime(now);
  const [date, time] = full ? full.split(' - ') : ['', ''];
  return {
    headline: 'اخبار لحظه‌ای',
    kicker: 'گزارش خبری خودکار',
    date: date || (parts ? `${parts.year}/${parts.month}/${parts.day}` : ''),
    time: time || (parts ? `${parts.hour}:${parts.minute}` : ''),
    // The footer credits every channel visible in the image: cards and ticker.
    footer: buildSourceFooter([...items, ...ticker]),
    items,
    ticker,
  };
}

/**
 * Splits the run's selected news into slides of four (the last slide may hold
 * fewer). The slideshow covers the whole run this way: nothing is relegated to
 * a tiny ticker line while slide capacity remains.
 */
export function chunkSlides(
  items: readonly ImageNewsItem[],
  perSlide: number = MAX_IMAGE_ITEMS
): ImageNewsItem[][] {
  const chunks: ImageNewsItem[][] = [];
  for (let i = 0; i < items.length; i += perSlide) {
    chunks.push(items.slice(i, i + perSlide));
  }
  return chunks;
}

/**
 * Builds the frame of ONE slide: the same fixed white template, with the slide
 * number in the header so a reader swiping through the album knows where they
 * are («اسلاید ۲ از ۵»). Single-slide albums keep the plain kicker.
 */
export function buildSlideFrame(
  items: ImageNewsItem[],
  now: Date,
  slideIndex: number,
  slideCount: number,
  ticker: TickerNewsItem[] = []
): ImageFrame {
  const frame = buildRunFrame(items, now, ticker);
  if (slideCount > 1) {
    frame.kicker = `گزارش خبری خودکار — اسلاید ${faDigits(slideIndex + 1)} از ${faDigits(slideCount)}`;
  }
  return frame;
}

export interface RenderedImage {
  png: ArrayBuffer;
  bytes: number;
  width: number;
  height: number;
  browserRunMs: number;
  /** Exactly what the image shows, in display order. */
  items: ImageNewsItem[];
  /** Headlines shown in the ticker strip below the cards (overflow line excluded). */
  tickerCount: number;
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

  // Every remaining headline becomes one brief line in the ticker below the
  // cards, so the single image still carries ALL of the run's news.
  const ticker = selectTickerNews(opts.items, new Set(selected.map((s) => s.id)));
  const tickerItems: TickerNewsItem[] = [...ticker.items];
  if (ticker.hidden > 0) {
    tickerItems.push({
      id: 0,
      channelUsername: '',
      text: `و ${faDigits(ticker.hidden)} خبر دیگر`,
      more: true,
    });
  }

  const html = buildImageHtml(buildRunFrame(selected, opts.now ?? new Date(), tickerItems));
  const started = Date.now();

  let response: Response;
  try {
    response = await browserScreenshot(opts.browser, {
      html,
      viewport: { width: IMAGE_WIDTH, height: IMAGE_HEIGHT, deviceScaleFactor: 1 },
      screenshotOptions: { type: 'png', fullPage: false, captureBeyondViewport: false },
      gotoOptions: { waitUntil: 'networkidle0', timeout: opts.timeoutMs ?? 20_000 },
    });
  } catch (e) {
    if (e instanceof NewsImageError) throw e;
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
    tickerCount: ticker.items.length,
  };
}

/* ------------------------------------------------------------- the album -- */

/**
 * Spacing between two Browser Run screenshot requests. The Workers Free plan
 * allows about one Quick Action per 10 seconds; the pipeline passes this value
 * (configurable via IMAGE_RENDER_SPACING_MS) so a multi-slide album never
 * trips it.
 */
export const DEFAULT_IMAGE_RENDER_SPACING_MS = 10_500;
/** One retry when a screenshot comes back HTTP 429 (Quick Action rate limit). */
export const SCREENSHOT_RETRIES = 2;

export const sleepMs = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** One fully rendered slide of the album: a PNG plus the news it carries. */
export interface RenderedSlideImage {
  /** The slide's news, in display (importance) order — at most four items. */
  items: ImageNewsItem[];
  png: ArrayBuffer;
  bytes: number;
  width: number;
  height: number;
}

export interface RenderedAlbum {
  /** Successfully rendered slides, in display order. */
  slides: RenderedSlideImage[];
  /** News items across every rendered slide. */
  selected: number;
  /** Remaining headlines for the last slide's ticker (overflow line included). */
  ticker: TickerNewsItem[];
  /** Headlines beyond MAX_TICKER_ITEMS (already folded into the last line). */
  hidden: number;
  /** Total time spent inside Browser Run, excluding waits. */
  browserRunMs: number;
  /** Selected slides that could not be rendered; the album degrades gracefully. */
  skipped: number;
  /** Short, safe reason for the first failure (stage/status only). */
  error?: string;
}

export interface RenderAlbumOptions {
  browser: BrowserBinding | undefined;
  items: readonly PublishableMessage[];
  now?: Date;
  timeoutMs?: number;
  /** Wait between two slide renders; 0 = no spacing (tests). */
  spacingMs?: number;
  /** Injectable wait, so tests never sleep for real. */
  sleepImpl?: (ms: number) => Promise<void>;
}

/** Short, secret-free reason for a render failure (stage + status only). */
function describeRenderError(error: unknown): string {
  if (error instanceof NewsImageError) {
    return `${error.stage}: ${error.message}`.slice(0, 120);
  }
  const name = error instanceof Error ? error.name : 'Error';
  const text = error instanceof Error ? error.message : String(error);
  return `${name}: ${text}`.slice(0, 120);
}

/**
 * Renders THE run album: a slideshow in which every slide covers four news
 * items (the last one may hold fewer), laid out by the FIXED white template.
 *
 * Selection takes the run's most important news up to the album capacity
 * (`MAX_ALBUM_SLIDES` × 4 items); when AI limits left fewer summarized items,
 * the slideshow is simply shorter. Whatever still does not fit rides along as
 * the last slide's ticker strip and caption overflow line.
 *
 * One Browser Run screenshot per slide, spaced so the free-tier Quick Action
 * limit (≈1 request / 10s) is respected. Failures degrade instead of failing
 * the run: a slide that cannot be rendered is skipped, and once Browser Run
 * answers 429 twice the remaining slides are skipped without further requests.
 * Returns null when there is nothing worth showing or no binding configured —
 * in both cases no Browser Run request is made at all.
 */
export async function renderRunAlbum(opts: RenderAlbumOptions): Promise<RenderedAlbum | null> {
  // The whole run's eligible news, ranked: importance first, recency and id as
  // stable tie-breakers. Only items the AI actually summarized (headline +
  // introductory text) can enter a slide.
  const selected = selectTopNews(opts.items, MAX_ALBUM_NEWS);
  if (selected.length === 0) return null;
  if (!opts.browser) return null;

  const slideChunks = chunkSlides(selected);
  const slideCount = slideChunks.length;

  // Overflow beyond the album capacity: the last slide's ticker strip keeps
  // the old "سایر عناوین" behavior alive, exactly like the single-image era.
  const tickerSelection = selectTickerNews(opts.items, new Set(selected.map((s) => s.id)));
  const ticker: TickerNewsItem[] = [...tickerSelection.items];
  if (tickerSelection.hidden > 0) {
    ticker.push({
      id: 0,
      channelUsername: '',
      text: `و ${faDigits(tickerSelection.hidden)} خبر دیگر`,
      more: true,
    });
  }

  const sleepImpl = opts.sleepImpl ?? sleepMs;
  const spacing = opts.spacingMs ?? 0;
  const slides: RenderedSlideImage[] = [];
  let browserRunMs = 0;
  let skipped = 0;
  let firstError: string | undefined;
  /** Set once Browser Run itself rate limits us: stop asking for more slides. */
  let rateLimited = false;

  for (let i = 0; i < slideChunks.length; i++) {
    if (rateLimited) {
      skipped++;
      continue;
    }
    if (i > 0) await sleepImpl(spacing);

    const chunk = slideChunks[i];
    // Every FULL slide uses the fixed 2×2 news board; only a trailing partial
    // slide lets the adaptive grid fill the board (same template, same
    // sections — just 1-3 cards spread over the 2×2 area).
    const layout: 'auto' | 'four' = chunk.length === MAX_IMAGE_ITEMS ? 'four' : 'auto';
    const isLastSlide = i === slideCount - 1;
    const html = buildImageHtml(
      buildSlideFrame(
        chunk,
        opts.now ?? new Date(),
        i,
        slideCount,
        // Only the last slide can carry the overflow ticker.
        isLastSlide ? ticker : []
      ),
      layout
    );
    let rendered: RenderedSlideImage | null = null;

    for (let attempt = 1; attempt <= SCREENSHOT_RETRIES && !rendered; attempt++) {
      const started = Date.now();
      try {
        const response = await browserScreenshot(opts.browser, {
          html,
          viewport: { width: IMAGE_WIDTH, height: IMAGE_HEIGHT, deviceScaleFactor: 1 },
          screenshotOptions: { type: 'png', fullPage: false, captureBeyondViewport: false },
          gotoOptions: { waitUntil: 'networkidle0', timeout: opts.timeoutMs ?? 20_000 },
        });
        const png = await response.arrayBuffer();
        const size = readPngSize(png);
        browserRunMs += Date.now() - started;
        if (response.status === 429) {
          firstError ??= 'browser_run: HTTP 429';
          // Quick Actions are ~1/10s on the free plan: wait once and retry.
          // The wait reuses the caller's spacing so tests (spacing 0) stay fast.
          if (attempt < SCREENSHOT_RETRIES && spacing > 0) {
            await sleepImpl(spacing);
            continue;
          }
          rateLimited = true;
          break;
        }
        if (!response.ok || !size) {
          throw new NewsImageError(
            'validate',
            `Browser Run did not return a PNG (status ${response.status})`
          );
        }
        rendered = {
          items: chunk,
          png,
          bytes: png.byteLength,
          width: size.width,
          height: size.height,
        };
      } catch (error) {
        browserRunMs += Date.now() - started;
        if (error instanceof NewsImageError) {
          firstError ??= describeRenderError(error);
          break; // not transient — skip this slide
        }
        firstError ??= describeRenderError(error);
        break;
      }
    }

    if (rendered) slides.push(rendered);
    else skipped++;
  }

  return {
    slides,
    selected: slides.reduce((sum, slide) => sum + slide.items.length, 0),
    ticker,
    hidden: tickerSelection.hidden,
    browserRunMs,
    skipped,
    ...(firstError ? { error: firstError } : {}),
  };
}

/** Telegram caption limit, kept below the 1024 hard limit for headroom. */
export const MAX_CAPTION_CHARS = 1000;
/** One caption line per slide headline; keeps four items + header < 1000. */
const CAPTION_HEADLINE_CHARS = 150;

/** Strips control characters so a caption is always plain, single-line-safe text. */
function cleanCaptionLine(text: string, limit: number = Number.MAX_SAFE_INTEGER): string {
  const clean = text
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * Builds the plain-text caption of every album slide.
 *
 * Layout (no HTML, so neither Telegram nor Bale can reject the markup):
 *
 *   slide 1:  📰 اخبار لحظه‌ای — ۱۴۰۵/۰۷/۱۲ ساعت ۱۴:۳۰ تهران
 *             {emoji} <headline>
 *             📡 منبع: @channel
 *             … (one pair per news item on the slide)
 *   slide N:  {emoji} <headline> + 📡 منبع pairs
 *             🔎 سایر عناوین: … · … · و n خبر دیگر   (overflow only)
 *
 * The run header lands on the first slide; when the slideshow cannot carry the
 * whole run (more than MAX_ALBUM_NEWS items) the last slide lists what is left.
 */
export function buildAlbumCaptions(
  slides: readonly (readonly ImageNewsItem[])[],
  ticker: readonly TickerNewsItem[],
  hidden: number,
  now: Date
): string[] {
  const stamp = formatTehranDateTime(now) ?? '';
  const overflow =
    hidden > 0
      ? ticker.some((t) => t.more)
        ? ''
        : `و ${faDigits(hidden)} خبر دیگر`
      : '';

  return slides.map((items, index) => {
    const lines: string[] = [];
    if (index === 0 && stamp) lines.push(`📰 اخبار لحظه‌ای — ${stamp} تهران`);

    for (const item of items) {
      const topic = topicPresentation(item.category, `${item.title} ${item.summary}`);
      lines.push(`${topic.emoji} ${cleanCaptionLine(item.title, CAPTION_HEADLINE_CHARS)}`);
      lines.push(`📡 منبع: ${channelLabel(item.channelUsername)}`);
    }

    if (index === slides.length - 1) {
      const headlines = ticker.map((t) => cleanCaptionLine(t.text)).filter(Boolean);
      if (headlines.length > 0) {
        lines.push(`🔎 سایر عناوین: ${headlines.join(' · ')}`);
      } else if (overflow) {
        lines.push(`🔎 ${overflow}`);
      }
    }

    const caption = lines.join('\n');
    return caption.length > MAX_CAPTION_CHARS
      ? `${caption.slice(0, MAX_CAPTION_CHARS - 1).trimEnd()}…`
      : caption;
  });
}

/**
 * The white-glass news slide: 1080x1350, RTL Persian.
 *
 * Two shapes share this file:
 *   `buildSlideHtml()`      — ONE news item, full bleed (the solo slide).
 *   `buildPairSlideHtml()`  — TWO news items stacked (the album slide).
 *
 * The album uses the pair slide because the run is published as pictures
 * only: twelve news items have to reach the channel inside Telegram's ten
 * photo album limit, so each picture carries two stories.
 *
 * Solo layout (top to bottom, inside one translucent white rounded card):
 *   header   — green "زنده" pill + Jalali date/time in Persian digits
 *   media    — the article's og:image, or a gradient placeholder + category icon
 *   meta     — category emoji + category name
 *   headline — bold, max 3 lines, keywords highlighted
 *   summary  — max 4 lines, keywords highlighted, never overflows
 *   footer   — «منبع: …», brand name, slide counter «۳/۱۰»
 *
 * Two hard rules this file exists to enforce:
 *
 *  1. NO font is ever loaded from the internet. Vazirmatn is inlined as a
 *     base64 woff2 data URL (see fontAssets.ts). A webfont fetched at render
 *     time races `networkidle0`; when it loses, Persian renders in a fallback
 *     font with broken shaping and the slide is silently wrong. Inlining makes
 *     that failure mode impossible.
 *
 *  2. NOTHING interpolated into this HTML is trusted. Headlines, summaries,
 *     source names and LLM-produced keywords are all escaped first; `<mark>`
 *     highlighting is applied to the ALREADY-ESCAPED string by literal
 *     substring search, so a keyword containing `<script>` cannot become
 *     markup. The only raw HTML in the output is written by this module.
 */

import { toPersianDigits } from '../lib/jalali';
import { VAZIRMATN_BOLD_WOFF2_BASE64, VAZIRMATN_REGULAR_WOFF2_BASE64 } from './fontAssets';

export const SLIDE_WIDTH = 1080;
export const SLIDE_HEIGHT = 1350;

/**
 * News items per album picture. Two stories per slide keep twelve items
 * inside a six-photo album, well under Telegram's ten-photo limit.
 */
export const SLIDE_ITEMS = 2;
/** Pictures per album. Telegram caps a media group at ten photos. */
export const MAX_SLIDES = 6;
/** News items one run can publish: MAX_SLIDES × SLIDE_ITEMS. */
export const MAX_SLIDESHOW_ITEMS = MAX_SLIDES * SLIDE_ITEMS;

/** Belt-and-braces caps; CSS line clamping is the real guarantee. */
export const HEADLINE_MAX_CHARS = 150;
export const SUMMARY_MAX_CHARS = 300;
/** Half the canvas per story, so the pair slide clamps a little tighter. */
export const PAIR_HEADLINE_MAX_CHARS = 110;
export const PAIR_SUMMARY_MAX_CHARS = 220;

export interface SlideCategory {
  emoji: string;
  label: string;
}

export interface SlideInput {
  /** 1-based position in the album. */
  index: number;
  total: number;
  category: SlideCategory;
  headline: string;
  summary: string;
  /** Verbatim substrings of headline/summary to highlight. */
  keywords: readonly string[];
  /** Absolute https URL of the article image, or null for the placeholder. */
  imageUrl: string | null;
  sourceName: string;
  brandName: string;
  /** Pre-formatted Jalali date/time in Persian digits. */
  stamp: string;
}

/** HTML-escapes a value for use in text content or a quoted attribute. */
export function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Collapses whitespace and trims; keeps a single logical line of text. */
function normalize(text: string): string {
  return text.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Truncates on a word boundary with an ellipsis. */
export function clampChars(text: string, limit: number): string {
  const clean = normalize(text);
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Escapes `text`, then wraps every occurrence of each keyword in `<mark>`.
 *
 * Both sides are escaped before matching, so the search operates purely on
 * escaped text and the inserted tags are the only markup. Matching is literal
 * (indexOf), never a regex, so keywords containing regex metacharacters —
 * `(`, `$`, `.` — behave correctly instead of throwing or matching wildly.
 *
 * Overlapping matches are avoided by walking left to right and skipping past
 * each match, so `<mark>` can never nest.
 */
export function highlight(text: string, keywords: readonly string[]): string {
  const escapedText = escapeHtml(normalize(text));
  if (escapedText.length === 0) return '';

  const needles = [...new Set(keywords.map((k) => escapeHtml(normalize(k))).filter((k) => k.length >= 2))]
    // Longest first, so "بانک مرکزی" wins over "بانک".
    .sort((a, b) => b.length - a.length);
  if (needles.length === 0) return escapedText;

  const marked: boolean[] = new Array(escapedText.length).fill(false);
  for (const needle of needles) {
    let from = 0;
    for (;;) {
      const at = escapedText.indexOf(needle, from);
      if (at === -1) break;
      // Skip if this span already overlaps an earlier (longer) match.
      let free = true;
      for (let i = at; i < at + needle.length; i++) {
        if (marked[i]) {
          free = false;
          break;
        }
      }
      if (free) for (let i = at; i < at + needle.length; i++) marked[i] = true;
      from = at + needle.length;
    }
  }

  let out = '';
  let inMark = false;
  for (let i = 0; i < escapedText.length; i++) {
    if (marked[i] && !inMark) {
      out += '<mark>';
      inMark = true;
    } else if (!marked[i] && inMark) {
      out += '</mark>';
      inMark = false;
    }
    out += escapedText[i];
  }
  if (inMark) out += '</mark>';
  return out;
}

/** «۳/۱۰» — Persian digits, slide position over album size. */
export function slideCounter(index: number, total: number): string {
  return `${toPersianDigits(index)}/${toPersianDigits(total)}`;
}

/** Only absolute http(s) URLs may reach an `<img src>`. */
export function isSafeImageUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Builds the complete, self-contained HTML of ONE slide.
 *
 * The returned string is handed to Browser Run as-is; it references no
 * external resource except, optionally, the article image.
 */
export function buildSlideHtml(input: SlideInput): string {
  const headline = highlight(clampChars(input.headline, HEADLINE_MAX_CHARS), input.keywords);
  const summary = highlight(clampChars(input.summary, SUMMARY_MAX_CHARS), input.keywords);
  const category = escapeHtml(normalize(input.category.label));
  const emoji = escapeHtml(input.category.emoji);
  const source = escapeHtml(clampChars(input.sourceName, 48));
  const brand = escapeHtml(clampChars(input.brandName, 32));
  const stamp = escapeHtml(input.stamp);
  const counter = escapeHtml(slideCounter(input.index, input.total));

  // The image element is only emitted for a validated absolute URL. `onerror`
  // removes it so the gradient placeholder underneath becomes visible: a dead
  // or hotlink-protected og:image degrades to the placeholder instead of
  // leaving a broken-image icon in the middle of the slide.
  const media = isSafeImageUrl(input.imageUrl)
    ? `<img class="shot" src="${escapeHtml(input.imageUrl)}" alt="" referrerpolicy="no-referrer"
           onerror="this.remove()">`
    : '';

  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<title>slide</title>
<style>
  @font-face{
    font-family:'Vazirmatn';font-style:normal;font-weight:400;font-display:block;
    src:url(data:font/woff2;base64,${VAZIRMATN_REGULAR_WOFF2_BASE64}) format('woff2');
  }
  @font-face{
    font-family:'Vazirmatn';font-style:normal;font-weight:700;font-display:block;
    src:url(data:font/woff2;base64,${VAZIRMATN_BOLD_WOFF2_BASE64}) format('woff2');
  }

  :root{
    --ink:#16202e;--muted:#5d6b7f;--line:rgba(120,140,170,.22);
    --live:#17a673;--mark:#ffe16b;
  }
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${SLIDE_WIDTH}px;height:${SLIDE_HEIGHT}px;overflow:hidden}
  body{
    font-family:'Vazirmatn',system-ui,sans-serif;color:var(--ink);
    display:flex;align-items:center;justify-content:center;padding:44px;
    /* soft blue-gray gradient */
    background:
      radial-gradient(ellipse 70% 55% at 12% 8%, #dbe4f2 0%, rgba(219,228,242,0) 62%),
      radial-gradient(ellipse 65% 50% at 92% 18%, #cfdae9 0%, rgba(207,218,233,0) 60%),
      radial-gradient(ellipse 80% 60% at 50% 104%, #b9c6da 0%, rgba(185,198,218,0) 68%),
      linear-gradient(165deg,#eef2f8 0%,#dce4ef 48%,#c6d1e1 100%);
  }

  /* the single translucent white card */
  .card{
    position:relative;width:100%;height:100%;
    display:flex;flex-direction:column;
    padding:34px 38px 28px;border-radius:46px;
    background:linear-gradient(160deg,rgba(255,255,255,.80),rgba(255,255,255,.56));
    border:1px solid rgba(255,255,255,.92);
    box-shadow:
      0 38px 70px rgba(44,62,92,.20),
      inset 1px 1px 2px rgba(255,255,255,.98),
      inset -2px -3px 10px rgba(150,168,196,.22);
  }

  header{display:flex;align-items:center;justify-content:space-between;flex:none;margin-bottom:24px}
  .live{
    display:inline-flex;align-items:center;gap:11px;height:48px;padding:0 22px;
    border-radius:24px;font-size:25px;font-weight:700;color:var(--live);
    background:rgba(23,166,115,.11);border:1px solid rgba(23,166,115,.30);
  }
  .live::before{
    content:"";width:13px;height:13px;border-radius:50%;background:var(--live);
    box-shadow:0 0 0 6px rgba(23,166,115,.17);
  }
  .stamp{font-size:26px;font-weight:400;color:var(--muted);letter-spacing:.2px}

  /* media: placeholder sits underneath, the photo covers it when it loads */
  .media{
    position:relative;flex:none;width:100%;height:520px;border-radius:30px;overflow:hidden;
    border:1px solid rgba(255,255,255,.85);
    background:linear-gradient(150deg,#9fb2cd 0%,#8fa6c6 42%,#aebdd4 100%);
    box-shadow:inset 0 2px 4px rgba(255,255,255,.55),0 12px 26px rgba(50,68,100,.16);
    display:grid;place-items:center;
  }
  .media .ghost{font-size:150px;line-height:1;opacity:.92;filter:drop-shadow(0 6px 14px rgba(30,45,75,.28))}
  .media .shot{
    position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;
  }
  /* keeps text legible if a photo is very light at the bottom edge */
  .media::after{
    content:"";position:absolute;inset:auto 0 0 0;height:34%;pointer-events:none;
    background:linear-gradient(to top,rgba(16,26,42,.26),rgba(16,26,42,0));
  }

  .meta{display:flex;align-items:center;gap:13px;flex:none;margin:26px 0 14px}
  .meta .ico{
    width:58px;height:58px;flex:none;display:grid;place-items:center;border-radius:18px;font-size:32px;
    background:linear-gradient(150deg,rgba(255,255,255,.95),rgba(255,255,255,.45));
    border:1px solid rgba(255,255,255,.95);
    box-shadow:inset 1px 1px 2px #fff,0 5px 12px rgba(60,80,115,.13);
  }
  .meta .name{font-size:28px;font-weight:700;color:#41506a}

  h1{
    flex:none;font-size:52px;font-weight:700;line-height:1.34;letter-spacing:-.4px;color:#131d2b;
    display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;
  }
  p.sum{
    flex:none;margin-top:18px;font-size:33px;font-weight:400;line-height:1.62;color:#36455b;
    /* the "max 4 lines, never overflow" guarantee */
    display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;
  }

  mark{
    background:linear-gradient(180deg,rgba(255,225,107,0) 42%,var(--mark) 42%);
    color:inherit;padding:0 3px;border-radius:5px;box-decoration-break:clone;
    -webkit-box-decoration-break:clone;
  }

  footer{
    margin-top:auto;padding-top:20px;border-top:1px solid var(--line);flex:none;
    display:flex;align-items:center;justify-content:space-between;gap:16px;
    font-size:25px;font-weight:400;color:#46566e;
  }
  footer .src{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  footer .brand{font-weight:700;color:#2b3a52}
  footer .count{
    flex:none;font-weight:700;color:#41506a;background:rgba(255,255,255,.72);
    border:1px solid rgba(255,255,255,.95);border-radius:14px;padding:5px 15px;
  }
</style>
</head>
<body>
  <div class="card">
    <header>
      <span class="live">زنده</span>
      <span class="stamp">${stamp}</span>
    </header>

    <div class="media">
      <span class="ghost">${emoji}</span>
      ${media}
    </div>

    <div class="meta">
      <span class="ico">${emoji}</span>
      <span class="name">${category}</span>
    </div>

    <h1>${headline}</h1>
    <p class="sum">${summary}</p>

    <footer>
      <span class="src">منبع: ${source}</span>
      <span class="brand">${brand}</span>
      <span class="count">${counter}</span>
    </footer>
  </div>
</body>
</html>`;
}

/** One story inside a pair slide. Same data the solo slide renders. */
export interface PairSlideStory {
  category: SlideCategory;
  headline: string;
  summary: string;
  /** Verbatim substrings of headline/summary to highlight. */
  keywords: readonly string[];
  /** Absolute https URL of the article image, or null for the placeholder. */
  imageUrl: string | null;
  sourceName: string;
}

export interface PairSlideInput {
  /** 1-based position in the album. */
  index: number;
  total: number;
  /** One or two stories; a trailing odd item renders alone, same template. */
  stories: readonly PairSlideStory[];
  brandName: string;
  /** Pre-formatted Jalali date/time in Persian digits. */
  stamp: string;
}

/**
 * Builds the complete, self-contained HTML of ONE album picture carrying two
 * stories, stacked vertically.
 *
 * Each story is a horizontal block: the article image on one side, the
 * category, headline and summary on the other, with its own source line. The
 * picture is the whole message — there is no text digest underneath it — so
 * the type is sized to be readable in a Telegram preview, and every block is
 * line-clamped so a long summary can never push the second story off the
 * canvas.
 *
 * Same two hard rules as the solo slide: the font is inlined (never fetched)
 * and every interpolated value is escaped before any `<mark>` is applied.
 */
export function buildPairSlideHtml(input: PairSlideInput): string {
  const brand = escapeHtml(clampChars(input.brandName, 32));
  const stamp = escapeHtml(input.stamp);
  const counter = escapeHtml(slideCounter(input.index, input.total));
  const stories = input.stories.slice(0, SLIDE_ITEMS);
  const solo = stories.length === 1;

  const blocks = stories
    .map((story) => {
      const headline = highlight(
        clampChars(story.headline, PAIR_HEADLINE_MAX_CHARS),
        story.keywords
      );
      const summary = highlight(clampChars(story.summary, PAIR_SUMMARY_MAX_CHARS), story.keywords);
      const emoji = escapeHtml(story.category.emoji);
      const label = escapeHtml(normalize(story.category.label));
      const source = escapeHtml(clampChars(story.sourceName, 42));
      // Only a validated absolute URL reaches an <img>. `onerror` drops the
      // element so the gradient placeholder underneath shows through instead
      // of a broken-image icon.
      const shot = isSafeImageUrl(story.imageUrl)
        ? `<img class="shot" src="${escapeHtml(story.imageUrl)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">`
        : '';
      return `<article class="story">
      <div class="media"><span class="ghost">${emoji}</span>${shot}</div>
      <div class="body">
        <div class="meta"><span class="ico">${emoji}</span><span class="name">${label}</span></div>
        <h2>${headline}</h2>
        <p class="sum">${summary}</p>
        <div class="src">منبع: ${source}</div>
      </div>
    </article>`;
    })
    .join('\n    ');

  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<title>slide</title>
<style>
  @font-face{
    font-family:'Vazirmatn';font-style:normal;font-weight:400;font-display:block;
    src:url(data:font/woff2;base64,${VAZIRMATN_REGULAR_WOFF2_BASE64}) format('woff2');
  }
  @font-face{
    font-family:'Vazirmatn';font-style:normal;font-weight:700;font-display:block;
    src:url(data:font/woff2;base64,${VAZIRMATN_BOLD_WOFF2_BASE64}) format('woff2');
  }

  :root{
    --ink:#16202e;--muted:#5d6b7f;--line:rgba(120,140,170,.22);
    --live:#17a673;--mark:#ffe16b;
  }
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${SLIDE_WIDTH}px;height:${SLIDE_HEIGHT}px;overflow:hidden}
  body{
    font-family:'Vazirmatn',system-ui,sans-serif;color:var(--ink);
    display:flex;align-items:center;justify-content:center;padding:40px;
    background:
      radial-gradient(ellipse 70% 55% at 12% 8%, #dbe4f2 0%, rgba(219,228,242,0) 62%),
      radial-gradient(ellipse 65% 50% at 92% 18%, #cfdae9 0%, rgba(207,218,233,0) 60%),
      radial-gradient(ellipse 80% 60% at 50% 104%, #b9c6da 0%, rgba(185,198,218,0) 68%),
      linear-gradient(165deg,#eef2f8 0%,#dce4ef 48%,#c6d1e1 100%);
  }

  .card{
    position:relative;width:100%;height:100%;
    display:flex;flex-direction:column;
    padding:30px 34px 24px;border-radius:46px;
    background:linear-gradient(160deg,rgba(255,255,255,.80),rgba(255,255,255,.56));
    border:1px solid rgba(255,255,255,.92);
    box-shadow:
      0 38px 70px rgba(44,62,92,.20),
      inset 1px 1px 2px rgba(255,255,255,.98),
      inset -2px -3px 10px rgba(150,168,196,.22);
  }

  header{display:flex;align-items:center;justify-content:space-between;flex:none;margin-bottom:18px}
  .live{
    display:inline-flex;align-items:center;gap:11px;height:46px;padding:0 20px;
    border-radius:23px;font-size:24px;font-weight:700;color:var(--live);
    background:rgba(23,166,115,.11);border:1px solid rgba(23,166,115,.30);
  }
  .live::before{
    content:"";width:12px;height:12px;border-radius:50%;background:var(--live);
    box-shadow:0 0 0 6px rgba(23,166,115,.17);
  }
  .stamp{font-size:25px;font-weight:400;color:var(--muted);letter-spacing:.2px}

  /* the stories: equal halves, so neither can push the other off the canvas */
  .stories{flex:1;min-height:0;display:grid;grid-template-rows:repeat(${
    solo ? 1 : SLIDE_ITEMS
  },1fr);gap:22px}
  .story{
    min-height:0;display:grid;grid-template-columns:400px 1fr;gap:26px;
    padding:22px;border-radius:34px;
    background:linear-gradient(150deg,rgba(255,255,255,.72),rgba(255,255,255,.34));
    border:1px solid rgba(255,255,255,.88);
    box-shadow:inset 1px 1px 2px rgba(255,255,255,.95),0 10px 22px rgba(50,68,100,.12);
  }

  .media{
    position:relative;border-radius:26px;overflow:hidden;min-height:0;
    border:1px solid rgba(255,255,255,.85);
    background:linear-gradient(150deg,#9fb2cd 0%,#8fa6c6 42%,#aebdd4 100%);
    box-shadow:inset 0 2px 4px rgba(255,255,255,.55),0 10px 20px rgba(50,68,100,.14);
    display:grid;place-items:center;
  }
  .media .ghost{font-size:120px;line-height:1;opacity:.92;filter:drop-shadow(0 6px 14px rgba(30,45,75,.28))}
  .media .shot{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
  .media::after{
    content:"";position:absolute;inset:auto 0 0 0;height:30%;pointer-events:none;
    background:linear-gradient(to top,rgba(16,26,42,.24),rgba(16,26,42,0));
  }

  .body{min-width:0;min-height:0;display:flex;flex-direction:column}
  .meta{display:flex;align-items:center;gap:11px;flex:none;margin-bottom:10px}
  .meta .ico{
    width:50px;height:50px;flex:none;display:grid;place-items:center;border-radius:16px;font-size:28px;
    background:linear-gradient(150deg,rgba(255,255,255,.95),rgba(255,255,255,.45));
    border:1px solid rgba(255,255,255,.95);
    box-shadow:inset 1px 1px 2px #fff,0 5px 12px rgba(60,80,115,.13);
  }
  .meta .name{font-size:26px;font-weight:700;color:#41506a}

  h2{
    flex:none;font-size:${solo ? 50 : 42}px;font-weight:700;line-height:1.32;letter-spacing:-.3px;color:#131d2b;
    display:-webkit-box;-webkit-line-clamp:${solo ? 3 : 2};-webkit-box-orient:vertical;overflow:hidden;
  }
  p.sum{
    flex:none;margin-top:12px;font-size:${solo ? 34 : 29}px;font-weight:400;line-height:1.6;color:#36455b;
    /* the "never overflows" guarantee */
    display:-webkit-box;-webkit-line-clamp:${solo ? 7 : 4};-webkit-box-orient:vertical;overflow:hidden;
  }
  .src{
    margin-top:auto;padding-top:12px;font-size:24px;color:#46566e;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  }

  mark{
    background:linear-gradient(180deg,rgba(255,225,107,0) 42%,var(--mark) 42%);
    color:inherit;padding:0 3px;border-radius:5px;box-decoration-break:clone;
    -webkit-box-decoration-break:clone;
  }

  footer{
    margin-top:16px;padding-top:16px;border-top:1px solid var(--line);flex:none;
    display:flex;align-items:center;justify-content:space-between;gap:16px;
    font-size:25px;font-weight:400;color:#46566e;
  }
  footer .brand{font-weight:700;color:#2b3a52}
  footer .count{
    flex:none;font-weight:700;color:#41506a;background:rgba(255,255,255,.72);
    border:1px solid rgba(255,255,255,.95);border-radius:14px;padding:5px 15px;
  }
</style>
</head>
<body>
  <div class="card">
    <header>
      <span class="live">زنده</span>
      <span class="stamp">${stamp}</span>
    </header>

    <section class="stories">
    ${blocks}
    </section>

    <footer>
      <span class="brand">${brand}</span>
      <span class="count">${counter}</span>
    </footer>
  </div>
</body>
</html>`;
}

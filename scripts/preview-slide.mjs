/**
 * Local design preview for the slideshow template.
 *
 * Renders `buildPairSlideHtml()` with realistic sample data in your own
 * browser, so Persian shaping, RTL layout, the embedded Vazirmatn font, the
 * <mark> highlighting and the summary clamps can all be checked WITHOUT
 * spending Browser Run minutes or sending anything to Telegram.
 *
 * A production slide carries TWO stories; the last slide of a run may carry
 * one, so both shapes are in the samples below.
 *
 *   npm run preview:slide         # then open http://localhost:8080
 *
 * Routes:
 *   /            contact sheet of every sample slide, scaled down
 *   /slide/<n>   one slide at exactly 1080x1350 (what Browser Run screenshots)
 *   /raw/<n>     the same slide's HTML source
 *
 * This file is a developer tool. It is not bundled into the Worker.
 */

import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';

/* The template is TypeScript; bundle it to a temp ESM file we can import. */
const outDir = join(tmpdir(), `slide-preview-${process.pid}`);
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'template.mjs');

execFileSync(
  'node_modules/.bin/esbuild',
  ['src/slideshow/slideTemplate.ts', '--bundle', '--format=esm', '--platform=neutral', `--outfile=${outFile}`],
  { stdio: 'inherit' }
);

const { buildPairSlideHtml, SLIDE_WIDTH, SLIDE_HEIGHT } = await import(
  pathToFileURL(outFile).href
);

// Same shape jalaliDateTime() produces: Jalali date + Persian-digit clock.
const stamp = '۱۳ مهر ۱۴۰۵ — ۱۱:۴۵';

/**
 * Deliberately awkward stories: a very long headline, a summary far past the
 * line budget, a missing image, an English source name, and keywords that
 * overlap so the highlighter's longest-first rule gets exercised.
 */
const STORIES = [
  {
    category: { emoji: '💰', label: 'اقتصاد' },
    headline: 'بانک مرکزی آمریکا نرخ بهره را بدون تغییر نگه داشت و از احتمال کاهش در نشست بعدی خبر داد',
    summary:
      'فدرال رزرو در نشست امروز نرخ بهره را در محدودهٔ ۴٫۲۵ تا ۴٫۵ درصد ثابت نگه داشت. جروم پاول گفت تورم هنوز بالاتر از هدف دو درصدی است اما بازار کار در حال تعادل است. تحلیلگران احتمال کاهش نرخ بهره در نشست دسامبر را بیش از ۶۰ درصد می‌دانند و همین موضوع باعث رشد طلا و افت شاخص دلار شد.',
    keywords: ['فدرال رزرو', 'نرخ بهره', 'جروم پاول', 'طلا'],
    imageUrl: 'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=1200&q=70',
    sourceName: 'رویترز',
  },
  {
    category: { emoji: '🛢️', label: 'انرژی' },
    headline: 'اوپک پلاس تولید نفت را افزایش می‌دهد',
    summary:
      'اعضای اوپک پلاس بر سر افزایش تولید روزانه ۱۳۷ هزار بشکه از ماه نوامبر به توافق رسیدند. قیمت نفت برنت پس از این خبر حدود یک درصد افت کرد.',
    keywords: ['اوپک پلاس', 'نفت برنت', '۱۳۷ هزار بشکه'],
    imageUrl: null, // -> gradient placeholder + category icon
    sourceName: 'OilPrice.com',
  },
  {
    category: { emoji: '🌍', label: 'جهان' },
    headline:
      'نشست اضطراری شورای امنیت دربارهٔ تنش‌های منطقه‌ای برگزار شد و نمایندگان خواستار آتش‌بس فوری و بازگشت به میز مذاکره شدند',
    summary:
      'شورای امنیت سازمان ملل در نشستی اضطراری دربارهٔ تشدید تنش‌ها گفت‌وگو کرد. چند عضو دائم خواستار آتش‌بس فوری شدند. دبیرکل سازمان ملل هشدار داد ادامهٔ درگیری می‌تواند مسیرهای انرژی را مختل کند و بازارهای جهانی را تحت فشار بگذارد. این متن عمداً بلند است تا بریدن خلاصه بررسی شود و مطمئن شویم هیچ‌وقت از کارت بیرون نمی‌زند حتی وقتی خبر طولانی باشد.',
    keywords: ['شورای امنیت', 'آتش‌بس'],
    imageUrl: 'https://images.unsplash.com/photo-1526470498-9ae73c665de8?w=1200&q=70',
    sourceName: 'Al Jazeera',
  },
];

/**
 * A run ships twelve news on six slides. These two samples cover both shapes:
 * a full slide of two stories and the trailing solo slide.
 */
const SAMPLES = [
  { index: 1, total: 6, stories: [STORIES[0], STORIES[1]], brandName: 'اخبار فوری', stamp },
  { index: 6, total: 6, stories: [STORIES[2]], brandName: 'اخبار فوری', stamp },
];

const html = (n) => buildPairSlideHtml(SAMPLES[n]);

const indexPage = `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
<title>پیش‌نمایش اسلاید</title>
<style>
 body{margin:0;background:#0f172a;color:#e2e8f0;font-family:system-ui,sans-serif;padding:24px}
 h1{font-size:18px;font-weight:600;margin:0 0 4px}
 p{margin:0 0 20px;font-size:13px;color:#94a3b8}
 .row{display:flex;gap:20px;flex-wrap:wrap}
 .cell{text-align:center}
 .frame{width:${SLIDE_WIDTH / 3}px;height:${SLIDE_HEIGHT / 3}px;border:0;border-radius:10px;overflow:hidden;background:#fff}
 .frame iframe{width:${SLIDE_WIDTH}px;height:${SLIDE_HEIGHT}px;border:0;transform:scale(.3333);transform-origin:top right}
 a{color:#7dd3fc;font-size:12px;text-decoration:none}
</style></head><body>
<h1>پیش‌نمایش اسلاید — ${SLIDE_WIDTH}×${SLIDE_HEIGHT}</h1>
<p>همان HTML‌ای که به Browser Run فرستاده می‌شود. برای اندازهٔ واقعی روی هر اسلاید کلیک کنید.</p>
<div class="row">
${SAMPLES.map(
  (s, i) => `<div class="cell"><div class="frame"><iframe src="/slide/${i}" scrolling="no"></iframe></div>
  <a href="/slide/${i}">اسلاید ${s.index} از ${s.total} (${s.stories.length} خبر) — اندازهٔ واقعی</a></div>`
).join('\n')}
</div></body></html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const slide = url.pathname.match(/^\/(slide|raw)\/(\d+)$/);
  try {
    if (slide) {
      const n = Number(slide[2]);
      if (!SAMPLES[n]) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('no such slide');
      }
      const body = html(n);
      const type = slide[1] === 'raw' ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      return res.end(body);
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(indexPage);
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(String(error?.stack ?? error));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`slide preview on http://${HOST}:${PORT}`);
});

const shutdown = () => {
  server.close();
  rmSync(outDir, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

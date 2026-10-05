import { createApi } from './api';
import { dispatchScheduled } from './scheduler';
import type { Env } from './types';
import { APP_HTML } from './ui';
import { buildImageHtml, buildSlideFrame, type ImageNewsItem } from './newsImage';

const api = createApi();

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return new Response(APP_HTML, { headers: HTML_HEADERS });
    }

    if (request.method === 'GET' && url.pathname === '/preview/news-image') {
      const sample: ImageNewsItem[] = [
        { id: 1, channelUsername: 'BBC Persian', title: 'اعلام عملیات دولت یمن برای پس گرفتن قلمرو در پی پیشروی حوثی‌ها', summary: 'گزارش تازه درباره عملیات دولت یمن و تغییرات میدانی منطقه.' },
        { id: 2, channelUsername: 'BBC Persian', title: 'استرالیا در حال بررسی ارتباط کمک‌خلبان هواپیمای فلای‌دبی با آن کشور است', summary: 'مقام‌های استرالیا در حال بررسی اطلاعات مرتبط با کمک‌خلبان این هواپیما هستند.' },
        { id: 3, channelUsername: 'BBC Persian', title: 'گسترش نفوذ حوثی‌ها در آفریقا؛ ایران چه نقشی دارد؟', summary: 'این گزارش به گسترش نفوذ حوثی‌ها در آفریقا و نقش احتمالی ایران می‌پردازد.' },
        { id: 4, channelUsername: 'BBC Persian', title: 'اگر جنگ به فضا کشیده شود؛ ماهواره‌ها چگونه هدف قرار می‌گیرند؟', summary: 'گزارشی درباره آسیب‌پذیری ماهواره‌ها در صورت گسترش درگیری‌ها به فضا.' },
      ];
      // The preview shows exactly what a run slide looks like: the FIXED
      // 2×2 news board (four items per slide) plus the last slide's overflow
      // ticker strip, so the template can be inspected without a render.
      const sampleTicker = [
        { id: 101, channelUsername: 'BBC Persian', text: 'بازارهای جهانی امروز با رشد شاخص‌ها همراه بودند' },
        { id: 102, channelUsername: 'Zoomit', text: 'رونمایی از نسل جدید تراشه‌های هوش مصنوعی اعلام شد' },
        { id: 103, channelUsername: 'IRIB News', text: 'پیش‌بینی کاهش دما در استان‌های شمالی کشور' },
      ];
      const frame = buildSlideFrame(sample, new Date(), 1, 3, sampleTicker);
      return new Response(buildImageHtml(frame, 'four'), { headers: HTML_HEADERS });
    }

    if (url.pathname === '/favicon.ico') {
      return new Response(null, { status: 204 });
    }

    if (url.pathname === '/healthz') {
      return new Response('ok', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }

    const response = await api.fetch(request, env, ctx);

    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
    return new Response(response.body, { status: response.status, headers });
  },

  /**
   * All four Cron Triggers land here; `controller.cron` says which fired.
   *
   * Cloudflare Cron Triggers are UTC-only ("Cron Triggers execute on UTC
   * time") and have no timezone field. Iran is a fixed UTC+03:30 with no
   * daylight saving, so every Iranian hour boundary falls on a UTC `:30`.
   *
   *   30 *&#47;2 * * *  -> news digest pipeline, every other Iranian hour
   *                   (20:30 UTC -> 00:00 Tehran). The collector's window is
   *                   two hours for the same reason, so no hour is skipped.
   *   *&#47;5 * * * *   -> breaking-news scan
   *   30 4 * * *   -> Forex Factory red list, 08:00 Tehran
   *   0 *&#47;3 * * *   -> news slideshow (minute 0, so it never collides
   *                   with the :30 pipeline run)
   *
   * `dispatchScheduled` routes on that expression and wraps each job in its
   * own try/catch inside its own `ctx.waitUntil`, so one failing job can
   * never stop another — and an unknown expression does nothing loudly
   * instead of silently running the wrong job.
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    dispatchScheduled(controller, env, ctx);
  },
} satisfies ExportedHandler<Env>;

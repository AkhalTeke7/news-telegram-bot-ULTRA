/**
 * Sends the image TEST ALBUM — and nothing else — to the configured Telegram
 * destination.
 *
 * Purpose: let the admin exercise the FULL image path (real pending news from
 * D1 → fixed-template slides, four news items each → Browser Run screenshots →
 * sendMediaGroup slideshow) without waiting for the cron run and without
 * touching any publish state:
 *
 *  - the news is REAL: exactly the rows the next run would publish
 *    (summarized, unfiltered, not yet published);
 *  - NOTHING is marked published — the next real run still publishes every
 *    row normally, the test image is purely diagnostic;
 *  - no text digests are sent — this tests ONLY the album;
 *  - when there is no pending news, nothing is rendered or sent.
 *
 * Security rules match src/testMessage.ts: the destination and token are read
 * only from the server-side environment, never echoed, logged or stored.
 */

import { baleSendPhoto } from './bale';
import { readMsEnv } from './pipeline';
import {
  DEFAULT_IMAGE_RENDER_SPACING_MS,
  buildAlbumCaptions,
  renderRunAlbum,
  type BrowserBinding,
} from './newsImage';
import { resolveBaleDelivery, resolveDestination, selectPublishableMessages } from './publisher';
import { sendMediaGroup, sendPhoto, TelegramError } from './telegram';
import { describeTelegramError, type BaleTestOutcome, type TestMessageErrorCategory } from './testMessage';
import type { Env } from './types';

/** Telegram command that triggers the image-only test. */
export const TEST_IMAGE_COMMAND = '/testimage';

export type TestImageErrorCategory =
  | 'no_news'
  | 'browser_missing'
  | 'destination_not_configured'
  | 'invalid_destination'
  | 'token_missing'
  | 'render_failed'
  | TestMessageErrorCategory;

export interface TestImageSuccess {
  ok: true;
  /** Message id Telegram assigned to the delivered test photo. */
  messageId: number;
  /** Slides sent in the test album (each covers four news items). */
  slides: number;
  /** News items carried across the slides. */
  items: number;
  /** Overflow headlines shown in the last slide's ticker. */
  ticker: number;
  /** PNG size in bytes. */
  bytes: number;
  /** How long the Browser Run screenshot took, in milliseconds. */
  browserRunMs: number;
  /** Bale mirror outcome; absent when Bale is not configured. */
  bale?: BaleTestOutcome;
}

export interface TestImageFailure {
  ok: false;
  category: TestImageErrorCategory;
  /** Safe admin-facing Persian reason; never the token or destination. */
  message: string;
}

export type TestImageResult = TestImageSuccess | TestImageFailure;

export interface SendTestImageOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  now?: Date;
}

/**
 * Renders and sends the test album. Never throws.
 */
export async function sendTestImage(
  env: Env,
  opts: SendTestImageOptions = {}
): Promise<TestImageResult> {
  const raw = env.TELEGRAM_DESTINATION_CHANNEL?.trim();
  if (!raw) {
    return {
      ok: false,
      category: 'destination_not_configured',
      message: 'کانال مقصد (TELEGRAM_DESTINATION_CHANNEL) تنظیم نشده است.',
    };
  }

  const destination = resolveDestination(env);
  if (!destination) {
    return {
      ok: false,
      category: 'invalid_destination',
      message: 'مقدار کانال مقصد معتبر نیست؛ باید @username یا شناسه عددی کانال باشد.',
    };
  }

  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    return {
      ok: false,
      category: 'token_missing',
      message: 'توکن ربات (TELEGRAM_BOT_TOKEN) تنظیم نشده است.',
    };
  }

  const browser: BrowserBinding | undefined = env.BROWSER;
  if (!browser) {
    return {
      ok: false,
      category: 'browser_missing',
      message: 'اتصال Browser Run (BROWSER) تنظیم نشده است.',
    };
  }

  // Real pending news only: exactly what the next run would publish.
  const rows = await selectPublishableMessages(env.DB);
  if (rows.length === 0) {
    return {
      ok: false,
      category: 'no_news',
      message: 'خبری در انتظار انتشار نیست؛ ابتدا پردازش را اجرا کنید.',
    };
  }

  let album;
  try {
    // The test renders the REAL album, so it paces its Browser Run calls with
    // the very same IMAGE_RENDER_SPACING_MS setting the pipeline uses — a
    // diagnostic that tripped the free-tier Quick Action limit would not
    // diagnose anything. (Tests set the binding to 0 and stay fast.)
    album = await renderRunAlbum({
      browser,
      items: rows,
      now: opts.now,
      spacingMs: readMsEnv(
        env.IMAGE_RENDER_SPACING_MS,
        DEFAULT_IMAGE_RENDER_SPACING_MS,
        120_000
      ),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logTestImage('error', { category: 'render_failed' });
    return {
      ok: false,
      category: 'render_failed',
      message: `ساخت تصویر ناموفق بود: ${reason.slice(0, 120)}`,
    };
  }

  // Every row was excluded (e.g. all scored importance 1): nothing to show.
  if (!album) {
    return {
      ok: false,
      category: 'no_news',
      message: 'خبر مهمی برای نمایش در تصویر نیست.',
    };
  }

  // Slides were selected but none could be rendered (Browser Run down or rate
  // limited) — the same outcome the pipeline would report as render_failed.
  if (album.slides.length === 0) {
    logTestImage('error', { category: 'render_failed', reason: album.error });
    return {
      ok: false,
      category: 'render_failed',
      message: `ساخت تصویر ناموفق بود: ${(album.error ?? 'نامشخص').slice(0, 120)}`,
    };
  }

  const captions = buildAlbumCaptions(
    album.slides.map((slide) => slide.items),
    album.ticker,
    album.hidden,
    opts.now ?? new Date()
  );
  const bytes = album.slides.reduce((sum, slide) => sum + slide.bytes, 0);

  try {
    const media = album.slides.map((slide, index) => ({
      photo: slide.png,
      caption: captions[index],
    }));
    // A media group needs at least two photos; one slide goes as sendPhoto.
    const sent =
      media.length >= 2
        ? (await sendMediaGroup({
            token,
            chatId: destination,
            media,
            // Clearly a diagnostic; subscribers should not be buzzed for it.
            disableNotification: true,
            fetchImpl: opts.fetchImpl,
            baseUrl: opts.baseUrl,
          }))[0]
        : await sendPhoto({
            token,
            chatId: destination,
            photo: album.slides[0].png,
            caption: captions[0],
            disableNotification: true,
            fetchImpl: opts.fetchImpl,
            baseUrl: opts.baseUrl,
          });
    logTestImage('ok', {
      messageId: sent.message_id,
      slides: album.slides.length,
      items: album.selected,
      ticker: album.ticker.filter((t) => !t.more).length,
      bytes,
    });
    // Best-effort Bale mirror of the very same PNGs, so this button also
    // verifies the Bale token + destination. Never affects the Telegram result.
    const bale = await mirrorTestImageToBale(env, album.slides, captions, opts.fetchImpl);
    return {
      ok: true,
      messageId: sent.message_id,
      slides: album.slides.length,
      items: album.selected,
      ticker: album.ticker.filter((t) => !t.more).length,
      bytes,
      browserRunMs: album.browserRunMs,
      ...(bale ? { bale } : {}),
    };
  } catch (error) {
    if (error instanceof TelegramError || error instanceof Error) {
      const { category, message } = describeTelegramError(error);
      logTestImage('error', { category });
      return { ok: false, category, message };
    }
    return {
      ok: false,
      category: 'telegram_error',
      message: 'ارسال تصویر با خطای نامشخص مواجه شد.',
    };
  }
}

/** Mirrors every test slide to Bale; undefined when Bale is not configured. */
async function mirrorTestImageToBale(
  env: Env,
  cards: { png: ArrayBuffer }[],
  captions: string[],
  fetchImpl?: typeof fetch
): Promise<BaleTestOutcome | undefined> {
  const bale = resolveBaleDelivery(env);
  if (!bale) return undefined;
  try {
    for (const [index, card] of cards.entries()) {
      await baleSendPhoto({
        token: bale.token,
        chatId: bale.destination,
        photo: card.png,
        caption: captions[index],
        fetchImpl,
      });
    }
    logTestImage('bale_ok');
    return { sent: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logTestImage('bale_error', { reason });
    return { sent: false, reason };
  }
}

function logTestImage(status: string, extra: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({
      event: 'testImage',
      status,
      timestamp: new Date().toISOString(),
      ...extra,
    })
  );
}

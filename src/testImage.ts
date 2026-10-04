/**
 * Sends ONE test image — and nothing else — to the configured Telegram
 * destination.
 *
 * Purpose: let the admin exercise the FULL image path (real pending news from
 * D1 → top-4 cards + ticker → Browser Run screenshot → sendPhoto) without
 * waiting for the cron run and without touching any publish state:
 *
 *  - the news is REAL: exactly the rows the next run would publish
 *    (summarized, unfiltered, not yet published);
 *  - NOTHING is marked published — the next real run still publishes every
 *    row normally, the test image is purely diagnostic;
 *  - no text digests are sent — this tests ONLY the image;
 *  - when there is no pending news, nothing is rendered or sent.
 *
 * Security rules match src/testMessage.ts: the destination and token are read
 * only from the server-side environment, never echoed, logged or stored.
 */

import { baleSendPhoto } from './bale';
import { NewsImageError, renderRunImage, type BrowserBinding } from './newsImage';
import { resolveBaleDelivery, resolveDestination, selectPublishableMessages } from './publisher';
import { sendPhoto, TelegramError } from './telegram';
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
  /** News shown as cards (at most four). */
  cards: number;
  /** Headlines shown in the ticker strip below the cards. */
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
 * Renders and sends the test image. Never throws.
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

  let rendered;
  try {
    rendered = await renderRunImage({ browser, items: rows, now: opts.now });
  } catch (error) {
    const reason =
      error instanceof NewsImageError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    logTestImage('error', { category: 'render_failed' });
    return {
      ok: false,
      category: 'render_failed',
      message: `ساخت تصویر ناموفق بود: ${reason.slice(0, 120)}`,
    };
  }

  // Every row was excluded (e.g. all scored importance 1): nothing to show.
  if (!rendered) {
    return {
      ok: false,
      category: 'no_news',
      message: 'خبر مهمی برای نمایش در تصویر نیست.',
    };
  }

  try {
    const sent = await sendPhoto({
      token,
      chatId: destination,
      photo: rendered.png,
      // Clearly a diagnostic; subscribers should not be buzzed for it.
      disableNotification: true,
      fetchImpl: opts.fetchImpl,
      baseUrl: opts.baseUrl,
    });
    logTestImage('ok', {
      messageId: sent.message_id,
      cards: rendered.items.length,
      ticker: rendered.tickerCount,
      bytes: rendered.bytes,
    });
    // Best-effort Bale mirror of the very same PNG, so this button also
    // verifies the Bale token + destination. Never affects the Telegram result.
    const bale = await mirrorTestImageToBale(env, rendered.png, opts.fetchImpl);
    return {
      ok: true,
      messageId: sent.message_id,
      cards: rendered.items.length,
      ticker: rendered.tickerCount,
      bytes: rendered.bytes,
      browserRunMs: rendered.browserRunMs,
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

/** Mirrors the test PNG to Bale; undefined when Bale is not configured. */
async function mirrorTestImageToBale(
  env: Env,
  png: ArrayBuffer,
  fetchImpl?: typeof fetch
): Promise<BaleTestOutcome | undefined> {
  const bale = resolveBaleDelivery(env);
  if (!bale) return undefined;
  try {
    await baleSendPhoto({ token: bale.token, chatId: bale.destination, photo: png, fetchImpl });
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

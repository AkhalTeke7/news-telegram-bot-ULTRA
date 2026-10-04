/**
 * Sends one clearly-marked test message to the configured Telegram destination.
 *
 * Purpose: let the admin verify the exact publish path (token + destination +
 * the bot's admin rights in the destination channel) without waiting for the
 * hourly cron and without needing fresh news in the window.
 *
 * Rules, shared with the publisher:
 *  - the destination is read only from the server-side environment and is never
 *    returned to the caller, logged, or written to the database;
 *  - plain text only (no parse_mode), so nothing can break Telegram formatting;
 *  - never throws — every failure is returned as a safe, admin-facing Persian
 *    message with a stable category, mirroring the publisher's error model.
 */

import { resolveDestination } from './publisher';
import {
  sendMessage,
  TelegramError,
  TelegramRateLimitError,
  type DestinationChat,
} from './telegram';
import { formatTehranDateTime } from './time';
import type { Env } from './types';

export type TestMessageErrorCategory =
  | 'destination_not_configured'
  | 'invalid_destination'
  | 'token_missing'
  | 'rate_limited'
  | 'network'
  | 'telegram_error';

export interface TestMessageSuccess {
  ok: true;
  /** Message id Telegram assigned to the delivered test message. */
  messageId: number;
}

export interface TestMessageFailure {
  ok: false;
  category: TestMessageErrorCategory;
  /** Safe admin-facing Persian reason; never contains the token or destination. */
  message: string;
}

export type TestMessageResult = TestMessageSuccess | TestMessageFailure;

/** Telegram command that triggers the test message from the admin chat. */
export const TEST_MESSAGE_COMMAND = '/test';

/** The test message body. Deterministic for a given moment; plain text only. */
export function buildTestMessageText(now: Date = new Date()): string {
  const when = formatTehranDateTime(now) ?? '—';
  return [
    '🧪 پیام آزمایشی ربات خبر',
    '',
    'این پیام فقط برای بررسی اتصال و دسترسی ربات به این کانال ارسال شده است.',
    `زمان ارسال: ${when} به وقت تهران`,
  ].join('\n');
}

function describeError(error: unknown): { category: TestMessageErrorCategory; message: string } {
  if (error instanceof TelegramRateLimitError) {
    const wait = error.retryAfterSeconds > 0 ? `${error.retryAfterSeconds} ثانیه دیگر` : 'چند لحظه بعد';
    return {
      category: 'rate_limited',
      message: `تلگرام محدودیت نرخ ارسال را اعلام کرد؛ ${wait} دوباره تلاش کنید.`,
    };
  }
  if (error instanceof TelegramError && error.status === 0) {
    return {
      category: 'network',
      message: 'ارتباط با تلگرام برقرار نشد.',
    };
  }
  if (error instanceof TelegramError) {
    // The description comes from Telegram's own response (e.g.
    // "Bad Request: chat not found"), never from our request, so it cannot
    // carry the token. It is the single most useful diagnostic for the admin.
    const description = error.description.slice(0, 200);
    return {
      category: 'telegram_error',
      message: `تلگرام پیام را نپذیرفت: ${description}`,
    };
  }
  return {
    category: 'telegram_error',
    message: 'ارسال پیام با خطای نامشخص مواجه شد.',
  };
}

export interface SendTestMessageOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  now?: Date;
}

/**
 * Sends the test message to the configured destination. Never throws.
 */
export async function sendTestMessage(
  env: Env,
  opts: SendTestMessageOptions = {}
): Promise<TestMessageResult> {
  const raw = env.TELEGRAM_DESTINATION_CHANNEL?.trim();
  if (!raw) {
    return {
      ok: false,
      category: 'destination_not_configured',
      message: 'کانال مقصد (TELEGRAM_DESTINATION_CHANNEL) تنظیم نشده است.',
    };
  }

  const destination: DestinationChat | null = resolveDestination(env);
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

  try {
    const sent = await sendMessage({
      token,
      chatId: destination,
      text: buildTestMessageText(opts.now),
      // A diagnostic should not buzz subscribers who keep notifications on.
      disableNotification: true,
      fetchImpl: opts.fetchImpl,
      baseUrl: opts.baseUrl,
    });
    logTestMessage('ok', { messageId: sent.message_id });
    return { ok: true, messageId: sent.message_id };
  } catch (error) {
    const { category, message } = describeError(error);
    logTestMessage('error', { category });
    return { ok: false, category, message };
  }
}

function logTestMessage(status: string, extra: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({
      event: 'testMessage',
      status,
      timestamp: new Date().toISOString(),
      ...extra,
    })
  );
}

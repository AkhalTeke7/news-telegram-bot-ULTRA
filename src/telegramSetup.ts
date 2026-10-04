/**
 * TEMPORARY: one-shot registration of the Telegram webhook for this Worker.
 *
 * Security model — no new secret is introduced:
 *  1. the route sits behind the existing Phase 1 admin session cookie (login with
 *     ADMIN_PASSWORD), so it is never publicly callable;
 *  2. it only answers on the production hostname, so a local `wrangler dev`
 *     cannot register a development URL by accident;
 *  3. the bot token and webhook secret are read only from bindings, sent to
 *     Telegram, and never returned, logged or echoed.
 *
 * Both the token and the shared secret come from Wrangler secrets
 * (TELEGRAM_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET). Delete this module and its
 * route once the webhook is registered and confirmed.
 */

import { setWebhook, TelegramError, TelegramRateLimitError } from './telegram';
import type { Env } from './types';

/** Public hostname of the deployed Worker. Not a secret. */
export const PRODUCTION_HOST = 'news-telegram-bot.m-abner-9907.workers.dev';
export const WEBHOOK_PATH = '/api/telegram/webhook';
export const WEBHOOK_URL = `https://${PRODUCTION_HOST}${WEBHOOK_PATH}`;
export const ALLOWED_UPDATES = ['message', 'callback_query'];
export const SETUP_ROUTE = '/api/telegram/setup-webhook';

export function isProductionHost(hostname: string): boolean {
  return hostname.toLowerCase() === PRODUCTION_HOST;
}

export type SetupOutcome =
  | { status: 200; body: { ok: true; registered: true; webhookUrl: string; allowedUpdates: string[] } }
  | { status: 503; body: { ok: false; error: string } }
  | { status: 502; body: { ok: false; error: string; category: string } };

/**
 * Calls the Bot API setWebhook method. The response deliberately contains only
 * the registered URL and update types — never the token or the shared secret.
 */
export async function registerTelegramWebhook(
  env: Env,
  deps: { fetchImpl?: typeof fetch; baseUrl?: string } = {}
): Promise<SetupOutcome> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    return {
      status: 503,
      body: { ok: false, error: 'TELEGRAM_BOT_TOKEN تنظیم نشده است.' },
    };
  }
  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    return {
      status: 503,
      body: { ok: false, error: 'TELEGRAM_WEBHOOK_SECRET تنظیم نشده است.' },
    };
  }

  try {
    const registration = await setWebhook({
      token: env.TELEGRAM_BOT_TOKEN,
      secretToken: env.TELEGRAM_WEBHOOK_SECRET,
      url: WEBHOOK_URL,
      allowedUpdates: ALLOWED_UPDATES,
      fetchImpl: deps.fetchImpl,
      baseUrl: deps.baseUrl,
    });
    return {
      status: 200,
      body: {
        ok: true,
        registered: true,
        webhookUrl: registration.url,
        allowedUpdates: registration.allowedUpdates,
      },
    };
  } catch (error) {
    const category =
      error instanceof TelegramRateLimitError
        ? 'rate_limited'
        : error instanceof TelegramError
          ? 'telegram_error'
          : 'internal_error';
    // Only Telegram's own description; never our headers, token or secret.
    const detail = error instanceof Error ? error.message : 'unknown error';
    return { status: 502, body: { ok: false, error: detail, category } };
  }
}
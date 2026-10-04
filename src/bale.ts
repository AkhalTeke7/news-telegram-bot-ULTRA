/**
 * Minimal Bale Business Bot API transport. Tokens are never logged.
 *
 * Used by the publisher as a best-effort MIRROR of the Telegram output: the
 * run image and every text digest are also sent to the Bale destination when
 * BALE_BOT_TOKEN and BALE_DESTINATION_CHANNEL are configured. A Bale failure
 * never affects Telegram delivery or publish state.
 */

/**
 * Standard Bale Bot API base (docs.bale.ai): `https://tapi.bale.ai/bot<TOKEN>`.
 *
 * Deliberately NOT the `/business/bot` variant: that base is only enabled for
 * accounts with Bale's bulk-messaging (کسب‌وکاری) eligibility and rejects every
 * call from a normal bot token — which made the mirror silently deliver
 * nothing. The standard base works for every bot created with Bale BotFather.
 */
const BALE_API = 'https://tapi.bale.ai/bot';

/** Bounded so one slow Bale call cannot consume the invocation budget. */
export const BALE_TIMEOUT_MS = 15_000;

interface BaleCallOptions {
  token: string;
  chatId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type BaleParseMode = 'HTML' | 'MarkdownV2';

export async function baleSendMessage(
  opts: BaleCallOptions & { text: string; parseMode?: BaleParseMode }
): Promise<void> {
  await call('sendMessage', opts, {
    chat_id: opts.chatId,
    text: opts.text,
    ...(opts.parseMode ? { parse_mode: opts.parseMode } : {}),
  });
}

export async function baleSendPhoto(
  opts: BaleCallOptions & { photo: ArrayBuffer; caption?: string }
): Promise<void> {
  const body = new FormData();
  body.append('chat_id', opts.chatId);
  if (opts.caption) body.append('caption', opts.caption);
  // A filename is required for the file part; the name is cosmetic.
  body.append('photo', new Blob([opts.photo], { type: 'image/png' }), 'news.png');

  const response = await (opts.fetchImpl ?? fetch)(
    // Raw token, exactly like the Telegram transport: Bale tokens contain a
    // ':' and the documented URL shape uses it unencoded.
    `${BALE_API}${opts.token}/sendPhoto`,
    {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? BALE_TIMEOUT_MS),
    }
  );
  if (!response.ok) {
    throw new Error(`Bale sendPhoto failed with HTTP ${response.status}`);
  }
}

async function call(
  method: string,
  opts: BaleCallOptions,
  payload: Record<string, unknown>
): Promise<void> {
  const response = await (opts.fetchImpl ?? fetch)(
    `${BALE_API}${opts.token}/${method}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(opts.timeoutMs ?? BALE_TIMEOUT_MS),
    }
  );
  if (!response.ok) {
    throw new Error(`Bale ${method} failed with HTTP ${response.status}`);
  }
}

export interface TelegramChat {
  id: number;
  title: string;
  username: string;
  type: string;
}

export interface TelegramMe {
  id: number;
  username: string;
  first_name: string;
  is_bot: boolean;
}

export class TelegramError extends Error {
  constructor(
    readonly status: number,
    readonly description: string
  ) {
    super(description);
    this.name = 'TelegramError';
  }
}

const API_BASE = 'https://api.telegram.org';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface TelegramClientOptions {
  token: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

async function call<T>(
  opts: TelegramClientOptions,
  method: string,
  payload: Record<string, string> = {}
): Promise<T> {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl ?? API_BASE;
  const res = await doFetch(`${base}/bot${opts.token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = (await res.json().catch(() => null)) as
    | { ok: boolean; result?: T; description?: string }
    | null;

  if (!res.ok || !data?.ok || data.result === undefined) {
    throw new TelegramError(
      res.status,
      data?.description ?? `Telegram API request failed with status ${res.status}`
    );
  }
  return data.result;
}

export function getMe(opts: TelegramClientOptions): Promise<TelegramMe> {
  return call<TelegramMe>(opts, 'getMe');
}

/**
 * Resolves a public @username to chat metadata. Throws TelegramError(400)
 * when Telegram does not recognize the username or it is not a channel.
 */
export async function getChatByUsername(
  opts: TelegramClientOptions,
  username: string
): Promise<TelegramChat> {
  const chat = await call<TelegramChat>(opts, 'getChat', { chat_id: `@${username}` });
  if (chat.type !== 'channel') {
    throw new TelegramError(400, `"@${username}" is not a Telegram channel (type: ${chat.type}).`);
  }
  return chat;
}

/** Destination chat reference: @username or a numeric channel id. */
export type DestinationChat = `@${string}` | `${number}`;

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

/** Telegram rejects callback payloads longer than 64 bytes. */
export const CALLBACK_DATA_LIMIT = 64;


export function isValidDestinationChat(value: string): value is DestinationChat {
  return /^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(value) || /^-?\d{5,20}$/.test(value);
}

export class TelegramRateLimitError extends TelegramError {
  constructor(
    status: number,
    description: string,
    /** Seconds Telegram asks us to wait. 0 when the API did not say. */
    readonly retryAfterSeconds: number
  ) {
    super(status, description);
    this.name = 'TelegramRateLimitError';
  }
}

/** One size of a photo Telegram stored for us. */
export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface SentMessage {
  message_id: number;
  date: number;
  /**
   * Present on photo messages. Telegram returns every stored size, largest
   * last. Re-sending a `file_id` is free and instant, which is how the
   * `/slideshow` browser pages through an album without re-rendering.
   */
  photo?: TelegramPhotoSize[];
}

/** The largest stored size's file_id, or null for a non-photo message. */
export function largestPhotoFileId(message: SentMessage | undefined): string | null {
  const sizes = message?.photo;
  if (!Array.isArray(sizes) || sizes.length === 0) return null;
  const largest = sizes.reduce((a, b) => ((b.width ?? 0) * (b.height ?? 0) > (a.width ?? 0) * (a.height ?? 0) ? b : a));
  return typeof largest.file_id === 'string' && largest.file_id ? largest.file_id : null;
}

export type TelegramParseMode = 'HTML' | 'MarkdownV2';

export interface SendMessageOptions extends TelegramClientOptions {
  chatId: DestinationChat;
  /** Text to send. Callers must escape untrusted values when using a parse mode. */
  text: string;
  /** Optional Telegram rich-text parser. News digests use HTML. */
  parseMode?: TelegramParseMode;
  disableNotification?: boolean;
  replyMarkup?: InlineKeyboardMarkup;
  /** Bounded so one slow Telegram call cannot consume the invocation budget. */
  timeoutMs?: number;
}

export const SEND_TIMEOUT_MS = 15_000;

/** Bot API `setWebhook`. Same client, separate from the read/publish helpers. */
export interface SetWebhookOptions extends TelegramClientOptions {
  url: string;
  /** Shared secret Telegram echoes back in X-Telegram-Bot-Api-Secret-Token. */
  secretToken?: string;
  allowedUpdates?: string[];
  timeoutMs?: number;
}

export interface WebhookRegistration {
  url: string;
  allowedUpdates: string[];
}

export const SET_WEBHOOK_TIMEOUT_MS = 15_000;

/**
 * Registers the webhook URL for this bot. The token and the shared secret are
 * only ever read from the caller's bindings and are never returned or logged.
 */
export async function setWebhook(opts: SetWebhookOptions): Promise<WebhookRegistration> {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl ?? API_BASE;

  const payload: Record<string, string> = { url: opts.url };
  if (opts.secretToken) payload.secret_token = opts.secretToken;
  if (opts.allowedUpdates) payload.allowed_updates = JSON.stringify(opts.allowedUpdates);

  let res: Response;
  try {
    res = await doFetch(`${base}/bot${opts.token}/setWebhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(opts.timeoutMs ?? SET_WEBHOOK_TIMEOUT_MS),
    });
  } catch (e) {
    const reason = e instanceof Error && e.name === 'TimeoutError' ? 'timed out' : message(e);
    throw new TelegramError(0, `setWebhook failed: ${reason}`);
  }

  const data = (await res.json().catch(() => null)) as
    | { ok: boolean; result?: unknown; description?: string; parameters?: { retry_after?: number } }
    | null;

  if (res.status === 429) {
    const retryAfter = Number(data?.parameters?.retry_after);
    throw new TelegramRateLimitError(
      429,
      data?.description ?? 'Telegram rate limit reached.',
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0
    );
  }
  if (!res.ok || !data?.ok || data.result === undefined) {
    throw new TelegramError(
      res.status,
      data?.description ?? `setWebhook failed with status ${res.status}`
    );
  }

  return { url: opts.url, allowedUpdates: opts.allowedUpdates ?? [] };
}

/**
 * Bot API `sendMessage`. Kept separate from the read helpers because its error
 * handling differs (rate-limit retry_after) and because it is the only write
 * path. Never logs the token.
 */
export async function sendMessage(opts: SendMessageOptions): Promise<SentMessage> {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl ?? API_BASE;

  const payload: Record<string, string> = {
    chat_id: opts.chatId,
    text: opts.text,
  };
  if (opts.parseMode) payload.parse_mode = opts.parseMode;
  if (opts.disableNotification) payload.disable_notification = 'true';
  if (opts.replyMarkup) payload.reply_markup = JSON.stringify(opts.replyMarkup);

  let res: Response;
  try {
    res = await doFetch(`${base}/bot${opts.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(opts.timeoutMs ?? SEND_TIMEOUT_MS),
    });
  } catch (e) {
    const reason = e instanceof Error && e.name === 'TimeoutError' ? 'timed out' : message(e);
    throw new TelegramError(0, `Telegram sendMessage failed: ${reason}`);
  }

  return parseSentMessageResponse(res, 'sendMessage');
}

/** Input shape accepted by Telegram's Rich Messages API. */
export interface TelegramRichMessage {
  html?: string;
  markdown?: string;
  is_rtl?: boolean;
  skip_entity_detection?: boolean;
}

export interface SendRichMessageOptions extends TelegramClientOptions {
  chatId: DestinationChat;
  richMessage: TelegramRichMessage;
  disableNotification?: boolean;
  timeoutMs?: number;
}

export const SEND_RICH_MESSAGE_TIMEOUT_MS = 15_000;

/**
 * Bot API `sendRichMessage` (Rich Messages API 10.3).
 *
 * The digest builder uses `tg-rich-messages` to validate/build the HTML payload;
 * this transport keeps the API call separate so a rich message never falls
 * through the ordinary entity parser or loses its RTL document metadata.
 */
export async function sendRichMessage(opts: SendRichMessageOptions): Promise<SentMessage> {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl ?? API_BASE;
  const payload: Record<string, unknown> = {
    chat_id: opts.chatId,
    rich_message: opts.richMessage,
  };
  if (opts.disableNotification) payload.disable_notification = true;

  let res: Response;
  try {
    res = await doFetch(`${base}/bot${opts.token}/sendRichMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(opts.timeoutMs ?? SEND_RICH_MESSAGE_TIMEOUT_MS),
    });
  } catch (e) {
    const reason = e instanceof Error && e.name === 'TimeoutError' ? 'timed out' : message(e);
    throw new TelegramError(0, `Telegram sendRichMessage failed: ${reason}`);
  }

  return parseSentMessageResponse(res, 'sendRichMessage');
}

async function parseSentMessageResponse(res: Response, operation: string): Promise<SentMessage> {
  const data = (await res.json().catch(() => null)) as
    | { ok: boolean; result?: SentMessage; description?: string; parameters?: { retry_after?: number } }
    | null;

  if (res.status === 429) {
    const retryAfter = Number(data?.parameters?.retry_after);
    throw new TelegramRateLimitError(
      429,
      data?.description ?? 'Telegram rate limit reached.',
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0
    );
  }

  if (!res.ok || !data?.ok || data.result === undefined) {
    throw new TelegramError(
      res.status,
      data?.description ?? `Telegram ${operation} failed with status ${res.status}`
    );
  }
  return data.result;
}

export interface SendPhotoOptions extends TelegramClientOptions {
  chatId: string;
  /** Raw PNG bytes. Sent as multipart/form-data, never written to any store. */
  photo: ArrayBuffer;
  caption?: string;
  disableNotification?: boolean;
  /**
   * Inline keyboard. Only the private-chat `/slideshow` browser uses this —
   * channel posts are deliberately button-free.
   */
  replyMarkup?: InlineKeyboardMarkup;
  timeoutMs?: number;
}

export const SEND_PHOTO_TIMEOUT_MS = 20_000;

/**
 * Bot API `sendPhoto`.
 *
 * Deliberately mirrors `sendMessage`'s error handling (same `TelegramError` /
 * `TelegramRateLimitError` contract, same "never log the token" rule) so the
 * publisher can treat a photo failure exactly like a text failure.
 *
 * The image is streamed as multipart form data and is never persisted: the
 * caller drops the buffer as soon as this resolves.
 */
export async function sendPhoto(opts: SendPhotoOptions): Promise<SentMessage> {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl ?? API_BASE;

  const form = new FormData();
  form.set('chat_id', opts.chatId);
  // A filename is required for the file part; the name is cosmetic.
  form.set('photo', new Blob([opts.photo], { type: 'image/png' }), 'news.png');
  if (opts.caption) form.set('caption', opts.caption);
  if (opts.disableNotification) form.set('disable_notification', 'true');
  if (opts.replyMarkup) form.set('reply_markup', JSON.stringify(opts.replyMarkup));

  let res: Response;
  try {
    res = await doFetch(`${base}/bot${opts.token}/sendPhoto`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(opts.timeoutMs ?? SEND_PHOTO_TIMEOUT_MS),
    });
  } catch (e) {
    const reason = e instanceof Error && e.name === 'TimeoutError' ? 'timed out' : message(e);
    throw new TelegramError(0, `Telegram sendPhoto failed: ${reason}`);
  }

  const data = (await res.json().catch(() => null)) as
    | { ok: boolean; result?: SentMessage; description?: string; parameters?: { retry_after?: number } }
    | null;

  if (res.status === 429) {
    const retryAfter = Number(data?.parameters?.retry_after);
    throw new TelegramRateLimitError(
      429,
      data?.description ?? 'Telegram rate limit reached.',
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0
    );
  }

  if (!res.ok || !data?.ok || data.result === undefined) {
    throw new TelegramError(
      res.status,
      data?.description ?? `Telegram sendPhoto failed with status ${res.status}`
    );
  }
  return data.result;
}

/** One photo of an album. Captions are plain text (no parse mode). */
export interface MediaGroupItem {
  /** Raw PNG bytes. Sent as multipart/form-data, never written to any store. */
  photo: ArrayBuffer;
  /** Optional caption; Telegram allows 0-1024 characters per item. */
  caption?: string;
}

export interface SendMediaGroupOptions extends TelegramClientOptions {
  chatId: string;
  /** The album: 2–10 photos, delivered by Telegram as one slideshow. */
  media: MediaGroupItem[];
  disableNotification?: boolean;
  timeoutMs?: number;
}

export const SEND_MEDIA_GROUP_TIMEOUT_MS = 30_000;
export const MEDIA_GROUP_MIN_ITEMS = 2;
export const MEDIA_GROUP_MAX_ITEMS = 10;

/**
 * Bot API `sendMediaGroup` — the album/slideshow transport.
 *
 * Photos are uploaded as multipart attachments referenced by
 * `attach://card<i>`; captions are plain text so no entity parsing can ever
 * reject the album. Error handling mirrors `sendPhoto` exactly, so the
 * publisher can treat an album failure like any other photo failure.
 */
export async function sendMediaGroup(opts: SendMediaGroupOptions): Promise<SentMessage[]> {
  if (opts.media.length < MEDIA_GROUP_MIN_ITEMS || opts.media.length > MEDIA_GROUP_MAX_ITEMS) {
    throw new TelegramError(
      0,
      `sendMediaGroup requires ${MEDIA_GROUP_MIN_ITEMS}-${MEDIA_GROUP_MAX_ITEMS} media items.`
    );
  }

  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl ?? API_BASE;

  const form = new FormData();
  form.set('chat_id', opts.chatId);
  form.set(
    'media',
    JSON.stringify(
      opts.media.map((item, i) => ({
        type: 'photo',
        media: `attach://card${i}`,
        ...(item.caption ? { caption: item.caption } : {}),
      }))
    )
  );
  opts.media.forEach((item, i) => {
    // A filename is required for the file part; the name is cosmetic.
    form.set(`card${i}`, new Blob([item.photo], { type: 'image/png' }), `news-${i}.png`);
  });
  if (opts.disableNotification) form.set('disable_notification', 'true');

  let res: Response;
  try {
    res = await doFetch(`${base}/bot${opts.token}/sendMediaGroup`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(opts.timeoutMs ?? SEND_MEDIA_GROUP_TIMEOUT_MS),
    });
  } catch (e) {
    const reason = e instanceof Error && e.name === 'TimeoutError' ? 'timed out' : message(e);
    throw new TelegramError(0, `Telegram sendMediaGroup failed: ${reason}`);
  }

  const data = (await res.json().catch(() => null)) as
    | { ok: boolean; result?: SentMessage[]; description?: string; parameters?: { retry_after?: number } }
    | null;

  if (res.status === 429) {
    const retryAfter = Number(data?.parameters?.retry_after);
    throw new TelegramRateLimitError(
      429,
      data?.description ?? 'Telegram rate limit reached.',
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0
    );
  }

  if (!res.ok || !data?.ok || !Array.isArray(data.result)) {
    throw new TelegramError(
      res.status,
      data?.description ?? `Telegram sendMediaGroup failed with status ${res.status}`
    );
  }
  return data.result;
}

export interface EditMessageOptions extends TelegramClientOptions {
  chatId: string;
  messageId: number;
  text: string;
  replyMarkup?: InlineKeyboardMarkup;
  timeoutMs?: number;
}

export interface EditMessageResult {
  edited: boolean;
  /** Telegram reports "message is not modified" for a no-op edit (e.g. a re-tap). */
  notModified: boolean;
}

/**
 * Edits an existing message. A repeated/stale tap yields notModified instead of
 * an error, so the UI never spams errors for harmless double presses.
 */
export async function editMessageText(opts: EditMessageOptions): Promise<EditMessageResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl ?? API_BASE;

  const payload: Record<string, string> = {
    chat_id: opts.chatId,
    message_id: String(opts.messageId),
    text: opts.text,
  };
  if (opts.replyMarkup) payload.reply_markup = JSON.stringify(opts.replyMarkup);

  const res = await doFetch(`${base}/bot${opts.token}/editMessageText`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(opts.timeoutMs ?? SEND_TIMEOUT_MS),
  });

  const data = (await res.json().catch(() => null)) as
    | { ok: boolean; description?: string }
    | null;

  if (!res.ok || !data?.ok) {
    const description = data?.description ?? '';
    if (/not modified/i.test(description)) return { edited: false, notModified: true };
    throw new TelegramError(res.status, description || `editMessageText failed (HTTP ${res.status}).`);
  }
  return { edited: true, notModified: false };
}

export interface EditMessageMediaOptions extends TelegramClientOptions {
  chatId: string;
  messageId: number;
  /**
   * An EXISTING Telegram `file_id`. Re-using a file_id costs no upload and no
   * re-render, which is what makes paging through a slideshow instant.
   */
  fileId: string;
  /** Plain-text caption (no parse mode, so nothing can fail to parse). */
  caption?: string;
  replyMarkup?: InlineKeyboardMarkup;
  timeoutMs?: number;
}

/**
 * Bot API `editMessageMedia` — swaps the photo of an already-sent message.
 *
 * Used only by the private-chat `/slideshow` browser. "Message is not
 * modified" is reported, not thrown: it just means the user pressed a button
 * that lands on the slide already displayed.
 */
export async function editMessageMedia(
  opts: EditMessageMediaOptions
): Promise<{ edited: boolean; notModified: boolean }> {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl ?? API_BASE;

  const payload: Record<string, unknown> = {
    chat_id: opts.chatId,
    message_id: opts.messageId,
    media: {
      type: 'photo',
      media: opts.fileId,
      ...(opts.caption ? { caption: opts.caption.slice(0, 1024) } : {}),
    },
  };
  if (opts.replyMarkup) payload.reply_markup = opts.replyMarkup;

  let res: Response;
  try {
    res = await doFetch(`${base}/bot${opts.token}/editMessageMedia`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(opts.timeoutMs ?? SEND_TIMEOUT_MS),
    });
  } catch (e) {
    const reason = e instanceof Error && e.name === 'TimeoutError' ? 'timed out' : message(e);
    throw new TelegramError(0, `Telegram editMessageMedia failed: ${reason}`);
  }

  const data = (await res.json().catch(() => null)) as { ok: boolean; description?: string } | null;

  if (!res.ok || !data?.ok) {
    const description = data?.description ?? '';
    if (/not modified/i.test(description)) return { edited: false, notModified: true };
    throw new TelegramError(res.status, description || `editMessageMedia failed (HTTP ${res.status}).`);
  }
  return { edited: true, notModified: false };
}

export interface AnswerCallbackOptions extends TelegramClientOptions {
  callbackQueryId: string;
  text?: string;
  showAlert?: boolean;
  timeoutMs?: number;
}

/** Answers a callback query so the client's spinner stops. Never throws. */
export async function answerCallbackQuery(opts: AnswerCallbackOptions): Promise<void> {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl ?? API_BASE;

  const payload: Record<string, string> = { callback_query_id: opts.callbackQueryId };
  if (opts.text) payload.text = opts.text.slice(0, 200);
  if (opts.showAlert) payload.show_alert = 'true';

  try {
    await doFetch(`${base}/bot${opts.token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(opts.timeoutMs ?? SEND_TIMEOUT_MS),
    });
  } catch {
    // Best effort: a failed acknowledgement must never break update handling.
  }
}

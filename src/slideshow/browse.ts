/**
 * The optional `/slideshow` browser — PRIVATE CHATS ONLY.
 *
 * Channel posts stay button-free by design; this is a personal reader for the
 * admin's own chat with the bot. It pages through the slides most recently
 * delivered to the channel using the Telegram `file_id` recorded at send time,
 * so a page turn costs ONE `editMessageMedia` call: no Browser Run minutes, no
 * R2 reads, no re-upload.
 *
 * Session state (which message is being browsed and the ordered file_ids)
 * lives in KV with a 30 minute TTL. KV is optional everywhere else in the
 * codebase, and it is optional here too: with no KV binding the command simply
 * reports that browsing is unavailable instead of throwing.
 */

import { z } from 'zod';
import { kvGetJson, kvPutJson } from '../lib/kv';
import { toPersianDigits } from '../lib/jalali';
import {
  answerCallbackQuery,
  editMessageMedia,
  sendMessage,
  TelegramError,
  type InlineKeyboardMarkup,
} from '../telegram';
import { MAX_SLIDES } from './slideTemplate';

/** The command that opens the browser. Private chats only. */
export const SLIDESHOW_COMMAND = '/slideshow';

/** Telegram keeps callback data to 64 bytes; `ss:next` fits easily. */
export const SLIDESHOW_CALLBACK_PREFIX = 'ss';
export const SESSION_TTL_SECONDS = 30 * 60;

const SessionSlideSchema = z.object({
  fileId: z.string().min(1).max(200),
  caption: z.string().max(1024),
});

const SessionSchema = z.object({
  chatId: z.string().min(1).max(32),
  messageId: z.number().int().positive(),
  index: z.number().int().nonnegative(),
  slides: z.array(SessionSlideSchema).min(1).max(MAX_SLIDES),
});

export type SlideshowSession = z.infer<typeof SessionSchema>;

/** One KV key per chat: a second `/slideshow` replaces the first. */
export const sessionKey = (chatId: string | number): string => `slideshow:session:${chatId}`;

export async function loadSession(
  kv: KVNamespace | undefined,
  chatId: string | number
): Promise<SlideshowSession | null> {
  return kvGetJson(kv, sessionKey(chatId), SessionSchema);
}

export async function saveSession(
  kv: KVNamespace | undefined,
  session: SlideshowSession
): Promise<boolean> {
  return kvPutJson(kv, sessionKey(session.chatId), session, SESSION_TTL_SECONDS);
}

/**
 * `◀ قبلی | ۳/۱۰ | بعدی ▶`
 *
 * The middle button is a no-op counter (`ss:noop`) rather than a disabled
 * button, because Telegram has no disabled state. Edge buttons stay visible
 * at the ends and simply answer "this is the first/last slide".
 */
export function slideshowKeyboard(index: number, total: number): InlineKeyboardMarkup {
  const counter = `${toPersianDigits(index + 1)}/${toPersianDigits(total)}`;
  return {
    inline_keyboard: [
      [
        // RTL reading order: "next" sits on the left, "previous" on the right.
        { text: 'بعدی ▶', callback_data: `${SLIDESHOW_CALLBACK_PREFIX}:next` },
        { text: counter, callback_data: `${SLIDESHOW_CALLBACK_PREFIX}:noop` },
        { text: '◀ قبلی', callback_data: `${SLIDESHOW_CALLBACK_PREFIX}:prev` },
      ],
    ],
  };
}

export interface StoredSlide {
  fileId: string;
  title: string;
  source: string;
  link: string;
}

/**
 * The slides of the most recent album, oldest-to-newest within that album.
 *
 * Rows without a `file_id` (sent before this feature, or by a Telegram
 * response we could not parse) are skipped: there is nothing to re-send.
 */
export async function loadLatestSlides(db: D1Database, limit = MAX_SLIDES): Promise<StoredSlide[]> {
  const latest = await db
    .prepare(
      `SELECT message_id FROM slideshow_sent
        WHERE file_id IS NOT NULL AND TRIM(file_id) <> ''
        ORDER BY sent_at DESC, rowid DESC LIMIT 1`
    )
    .first<{ message_id: number | null }>();
  if (!latest) return [];

  // Group by the album the slide belongs to when we know it; otherwise fall
  // back to "the most recent N slides".
  const query =
    latest.message_id === null
      ? `SELECT file_id, title, source, link FROM slideshow_sent
          WHERE file_id IS NOT NULL AND TRIM(file_id) <> ''
          ORDER BY sent_at DESC, rowid DESC LIMIT ?1`
      : `SELECT file_id, title, source, link FROM slideshow_sent
          WHERE file_id IS NOT NULL AND TRIM(file_id) <> ''
            AND message_id BETWEEN ?2 AND ?2 + ?1
          ORDER BY sent_at ASC, rowid ASC LIMIT ?1`;

  const statement =
    latest.message_id === null
      ? db.prepare(query).bind(limit)
      : db.prepare(query).bind(limit, latest.message_id);

  const { results } = await statement.all<{
    file_id: string;
    title: string;
    source: string;
    link: string;
  }>();

  return (results ?? []).map((row) => ({
    fileId: String(row.file_id),
    title: String(row.title ?? ''),
    source: String(row.source ?? ''),
    link: String(row.link ?? ''),
  }));
}

/** Caption shown under a browsed slide. Plain text, no parse mode. */
export function browseCaption(slide: StoredSlide, index: number, total: number): string {
  const counter = `${toPersianDigits(index + 1)}/${toPersianDigits(total)}`;
  const lines = [slide.title.slice(0, 220)];
  if (slide.source) lines.push(`📡 ${slide.source.slice(0, 48)} · ${counter}`);
  else lines.push(counter);
  if (slide.link) lines.push(slide.link.slice(0, 300));
  return lines.join('\n').slice(0, 1000);
}

export interface SlideshowCommandOptions {
  token: string;
  db: D1Database;
  kv: KVNamespace | undefined;
  chatId: number | string;
  /** Guard: the handler must have verified this is a private chat. */
  isPrivateChat: boolean;
  fetchImpl?: typeof fetch;
}

/**
 * Handles `/slideshow`: sends the first slide with the navigation keyboard
 * and stores the session.
 */
export async function handleSlideshowCommand(
  opts: SlideshowCommandOptions
): Promise<{ status: 'sent' | 'rejected'; reason?: string }> {
  const chatId = String(opts.chatId);
  const say = (text: string) =>
    sendMessage({ token: opts.token, chatId: chatId as `${number}`, text, fetchImpl: opts.fetchImpl }).catch(
      () => undefined
    );

  if (!opts.isPrivateChat) {
    // Belt and braces: the channel must never get buttons.
    return { status: 'rejected', reason: 'not_private' };
  }
  if (!opts.kv) {
    await say('مرور اسلایدها در دسترس نیست (فضای ذخیره‌سازی KV تنظیم نشده است).');
    return { status: 'rejected', reason: 'kv_missing' };
  }

  let slides: StoredSlide[];
  try {
    slides = await loadLatestSlides(opts.db);
  } catch {
    await say('خطا در خواندن اسلایدها.');
    return { status: 'rejected', reason: 'db_error' };
  }
  if (slides.length === 0) {
    await say('هنوز اسلایدی ارسال نشده است.');
    return { status: 'rejected', reason: 'no_slides' };
  }

  try {
    const sent = await sendPhotoByFileId({
      token: opts.token,
      chatId,
      fileId: slides[0].fileId,
      caption: browseCaption(slides[0], 0, slides.length),
      replyMarkup: slideshowKeyboard(0, slides.length),
      fetchImpl: opts.fetchImpl,
    });
    await saveSession(opts.kv, {
      chatId,
      messageId: sent.message_id,
      index: 0,
      slides: slides.map((slide, i) => ({
        fileId: slide.fileId,
        caption: browseCaption(slide, i, slides.length),
      })),
    });
    return { status: 'sent' };
  } catch (error) {
    const reason = error instanceof TelegramError ? error.description : 'send_failed';
    await say('ارسال اسلاید ناموفق بود.');
    return { status: 'rejected', reason: reason.slice(0, 120) };
  }
}

/**
 * `sendPhoto` with an existing file_id.
 *
 * The shared `sendPhoto` uploads bytes; re-sending a stored photo only needs
 * the id, so this posts JSON instead of multipart.
 */
async function sendPhotoByFileId(opts: {
  token: string;
  chatId: string;
  fileId: string;
  caption: string;
  replyMarkup: InlineKeyboardMarkup;
  fetchImpl?: typeof fetch;
}): Promise<{ message_id: number }> {
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`https://api.telegram.org/bot${opts.token}/sendPhoto`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: opts.chatId,
        photo: opts.fileId,
        caption: opts.caption,
        reply_markup: opts.replyMarkup,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    const reason = e instanceof Error && e.name === 'TimeoutError' ? 'timed out' : 'network error';
    throw new TelegramError(0, `Telegram sendPhoto failed: ${reason}`);
  }
  const data = (await res.json().catch(() => null)) as
    | { ok: boolean; result?: { message_id: number }; description?: string }
    | null;
  if (!res.ok || !data?.ok || !data.result) {
    throw new TelegramError(res.status, data?.description ?? `sendPhoto failed (HTTP ${res.status}).`);
  }
  return data.result;
}

export interface SlideshowCallbackOptions {
  token: string;
  kv: KVNamespace | undefined;
  chatId: number | string;
  messageId: number;
  callbackQueryId: string;
  /** `prev`, `next` or `noop`. */
  action: string;
  fetchImpl?: typeof fetch;
}

/**
 * Handles a `ss:*` button press: moves the cursor and swaps the photo.
 *
 * Always answers the callback query so the client's spinner stops, even when
 * the session has expired.
 */
export async function handleSlideshowCallback(
  opts: SlideshowCallbackOptions
): Promise<{ status: 'moved' | 'edge' | 'expired' | 'noop' | 'error' }> {
  const ack = (text?: string) =>
    answerCallbackQuery({
      token: opts.token,
      callbackQueryId: opts.callbackQueryId,
      ...(text ? { text } : {}),
      fetchImpl: opts.fetchImpl,
    });

  if (opts.action === 'noop') {
    await ack();
    return { status: 'noop' };
  }

  const session = await loadSession(opts.kv, opts.chatId);
  if (!session || session.messageId !== opts.messageId) {
    await ack('این گالری منقضی شده است. دوباره /slideshow بزنید.');
    return { status: 'expired' };
  }

  const delta = opts.action === 'next' ? 1 : -1;
  const next = session.index + delta;
  if (next < 0 || next >= session.slides.length) {
    await ack(delta > 0 ? 'آخرین اسلاید است.' : 'اولین اسلاید است.');
    return { status: 'edge' };
  }

  try {
    await editMessageMedia({
      token: opts.token,
      chatId: String(opts.chatId),
      messageId: opts.messageId,
      fileId: session.slides[next].fileId,
      caption: session.slides[next].caption,
      replyMarkup: slideshowKeyboard(next, session.slides.length),
      fetchImpl: opts.fetchImpl,
    });
  } catch {
    await ack('تغییر اسلاید ناموفق بود.');
    return { status: 'error' };
  }

  // Refreshing the session also refreshes its 30 minute TTL.
  await saveSession(opts.kv, { ...session, index: next });
  await ack();
  return { status: 'moved' };
}

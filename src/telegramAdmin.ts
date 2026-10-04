/**
 * Telegram admin interface (Bot API only).
 *
 * Authorization is by numeric Telegram User.id only, compared in constant time
 * against TELEGRAM_ADMIN_USER_ID. Usernames, first names and chat titles are
 * never used for authorization, and the configured id is never disclosed.
 *
 * All long work goes through the shared runNewsPipeline(), so a manual run obeys
 * exactly the same rules as the hourly Cron Trigger.
 */

import {
  answerCallbackQuery,
  editMessageText,
  sendMessage,
  type InlineKeyboardMarkup,
} from './telegram';
import {
  deleteChannel,
  getChannelById,
  listChannels,
  setChannelEnabled,
} from './channels';
import { getCronSummary, getLastCronRun } from './cronRuns';
import { runNewsPipeline } from './pipeline';
import { getChannelStats, getStatusReport } from './status';
import { addSourceChannel } from './sourceChannels';
import { getSetting } from './settings';
import {
  sendTestImage,
  TEST_IMAGE_COMMAND,
  type TestImageResult,
} from './testImage';
import {
  sendTestMessage,
  TEST_MESSAGE_COMMAND,
  type TestMessageResult,
} from './testMessage';
import { formatTehranDateTimeOrDash } from './time';
import type { Env } from './types';

export const UNAUTHORIZED_MESSAGE = 'دسترسی غیرمجاز است.';
export const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_UPDATE_BYTES = 64 * 1024;

type Action = 'await_channel' | 'await_del' | 'await_run';

interface AdminState {
  chatId: number;
  userId: number;
  action: Action;
  payload: string | null;
  expiresAt: number;
}

/* ------------------------------------------------------------------ auth -- */

const USER_ID_RE = /^[0-9]{1,15}$/;

/** Strictly parses a numeric Telegram user id. Returns null when unusable. */
export function parseAdminUserId(raw: string | undefined | null): string | null {
  const value = (raw ?? '').trim();
  return USER_ID_RE.test(value) ? value : null;
}

function isAdmin(env: Env, userId: number | undefined): boolean {
  const configured = parseAdminUserId(env.TELEGRAM_ADMIN_USER_ID);
  if (!configured || !userId || !Number.isSafeInteger(userId)) return false;
  return String(userId) === configured;
}

/** Constant-time secret comparison, shared with the web admin session code. */
async function secretEquals(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

/* ----------------------------------------------------------------- state -- */

async function purgeExpired(db: D1Database, now: number): Promise<void> {
  await db
    .prepare(`DELETE FROM telegram_admin_state WHERE expires_at <= ?1`)
    .bind(new Date(now).toISOString())
    .run();
}

export async function getAdminState(
  db: D1Database,
  chatId: number,
  now = Date.now()
): Promise<AdminState | null> {
  await purgeExpired(db, now);
  const row = await db
    .prepare(
      `SELECT chat_id, user_id, action, payload, expires_at
         FROM telegram_admin_state WHERE chat_id = ?1`
    )
    .bind(chatId)
    .first<{ chat_id: number; user_id: number; action: string; payload: string | null; expires_at: string }>();

  if (!row) return null;
  if (!isKnownAction(row.action)) return null;
  return {
    chatId: row.chat_id,
    userId: row.user_id,
    action: row.action,
    payload: row.payload,
    expiresAt: Date.parse(row.expires_at),
  };
}

function isKnownAction(action: string): action is Action {
  return action === 'await_channel' || action === 'await_del' || action === 'await_run';
}

export async function setAdminState(
  db: D1Database,
  state: { chatId: number; userId: number; action: Action; payload?: string | null; ttlMs?: number },
  now = Date.now()
): Promise<void> {
  const expires = new Date(now + (state.ttlMs ?? STATE_TTL_MS)).toISOString();
  await db
    .prepare(
      `INSERT INTO telegram_admin_state (chat_id, user_id, action, payload, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (chat_id) DO UPDATE
         SET user_id = excluded.user_id,
             action = excluded.action,
             payload = excluded.payload,
             created_at = excluded.created_at,
             expires_at = excluded.expires_at`
    )
    .bind(state.chatId, state.userId, state.action, state.payload ?? null, new Date(now).toISOString(), expires)
    .run();
}

export async function clearAdminState(db: D1Database, chatId: number): Promise<void> {
  await db.prepare(`DELETE FROM telegram_admin_state WHERE chat_id = ?1`).bind(chatId).run();
}

/* -------------------------------------------------------------- keyboards -- */

export const MENU_TEXT = '🤖 مدیریت ربات اخبار';

export function menuKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '➕ افزودن کانال', callback_data: 'ch:add' }],
      [
        { text: '📋 کانال‌ها', callback_data: 'ch:list' },
        { text: '📊 وضعیت سامانه', callback_data: 'sys:status' },
      ],
      [
        { text: '🤖 وضعیت مدل AI', callback_data: 'sys:ai' },
        { text: '📈 آخرین اجرا', callback_data: 'sys:last' },
      ],
      [
        { text: '📰 پردازش دستی', callback_data: 'run:ask' },
        { text: '❌ لغو', callback_data: 'no' },
      ],
      [
        { text: '🧪 پیام آزمایشی', callback_data: 'msg:test' },
        { text: '🖼 تصویر آزمایشی', callback_data: 'img:test' },
      ],
    ],
  };
}

function channelListKeyboard(channels: { id: number; channelUsername: string; enabled: boolean }[]): InlineKeyboardMarkup {
  const rows: InlineKeyboardMarkup['inline_keyboard'] = [];
  for (const ch of channels) {
    rows.push([
      { text: ch.enabled ? `🔴 غیرفعال @${ch.channelUsername}` : `🟢 فعال @${ch.channelUsername}`, callback_data: `ch:toggle:${ch.id}` },
    ]);
    rows.push([{ text: `🗑 حذف @${ch.channelUsername}`, callback_data: `ch:del:${ch.id}` }]);
  }
  rows.push([{ text: '🔙 منوی اصلی', callback_data: 'menu' }]);
  return { inline_keyboard: rows };
}

function confirmDeleteKeyboard(id: number): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '✅ بله، حذف شود', callback_data: `ch:delok:${id}` },
        { text: '❌ لغو', callback_data: 'no' },
      ],
    ],
  };
}

function runConfirmKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '▶️ اجرای پردازش', callback_data: 'run:yes' },
        { text: '❌ لغو', callback_data: 'no' },
      ],
    ],
  };
}

/* -------------------------------------------------------------- rendering -- */

function faDate(iso: string | null | undefined): string {
  return formatTehranDateTimeOrDash(iso);
}

function faDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${ms} میلی‌ثانیه`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} ثانیه`;
  return `${Math.floor(seconds / 60)} دقیقه و ${seconds % 60} ثانیه`;
}

async function renderStatus(env: Env): Promise<string> {
  const report = await getStatusReport(env.DB, {
    destinationConfigured: Boolean(env.TELEGRAM_DESTINATION_CHANNEL?.trim()),
  });
  const lines = [
    '📊 وضعیت سامانه',
    '',
    `کانال‌های فعال: ${report.channels.enabled} از ${report.channels.total}`,
    `آخرین اجرای Cron: ${faDate(report.cron.lastRun?.ranAt)}`,
    `آخرین اجرای موفق: ${faDate(report.cron.lastSuccessAt)}`,
    `آخرین اجرای ناموفق: ${faDate(report.cron.lastFailureAt)}`,
    `پیام‌های یک ساعت اخیر: ${report.messages.collectedLastHour}`,
    `تبلیغات فیلترشده: ${report.messages.filteredAdvertisements}`,
    `در انتظار فیلتر: ${report.messages.pendingFilter}`,
    `در انتظار خلاصه‌سازی: ${report.messages.waitingSummarization}`,
    `در انتظار انتشار: ${report.messages.waitingPublishing}`,
    `آخرین انتشار: ${faDate(report.messages.lastPublishedAt)}`,
    `کانال مقصد: ${report.publishing.destinationConfigured ? 'تنظیم شده' : 'تنظیم نشده'}`,
    `تعداد مدل‌های Free: ${report.ai.freeModelsCached}`,
    `آخرین refresh مدل‌ها: ${faDate(report.ai.lastModelRefreshAt)}`,
  ];
  if (report.recentErrors.length > 0) {
    lines.push(
      '',
      `خطاهای اخیر: ${report.recentErrors.map((e) => `${e.category} (${e.count})`).join('، ')}`
    );
  }
  return lines.join('\n');
}

/** Cached state only — opening this screen never triggers a model-list fetch. */
async function renderAiStatus(env: Env): Promise<string> {
  const [modelsRaw, refreshedAt, selected, failure] = await Promise.all([
    getSetting(env.DB, 'free_models'),
    getSetting(env.DB, 'free_models_refreshed_at'),
    getSetting(env.DB, 'selected_model'),
    getSetting(env.DB, 'last_model_failure'),
  ]);

  let count = 0;
  try {
    const parsed: unknown = modelsRaw ? JSON.parse(modelsRaw) : [];
    count = Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    count = 0;
  }

  const refreshedMs = refreshedAt ? Date.parse(refreshedAt) : Number.NaN;
  const ageMs = Number.isFinite(refreshedMs) ? Date.now() - refreshedMs : Number.NaN;
  const fresh = Number.isFinite(ageMs) && ageMs < 24 * 60 * 60 * 1000;

  return [
    '🤖 وضعیت مدل AI',
    '',
    `تعداد مدل‌های Free: ${count}`,
    `مدل فعال: ${selected ?? '—'}`,
    `آخرین refresh: ${faDate(refreshedAt)}`,
    `وضعیت فهرست: ${count === 0 ? 'خالی' : fresh ? 'به‌روز' : 'قدیمی (نیازمند refresh)'}`,
    `آخرین خطای مدل: ${failure ? 'ثبت شده' : 'ندارد'}`,
  ].join('\n');
}

async function renderLastRun(env: Env): Promise<string> {
  const [last, summary] = await Promise.all([
    getLastCronRun(env.DB),
    getCronSummary(env.DB, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
  ]);

  if (!last) return '📈 آخرین اجرا\n\nهنوز اجرایی ثبت نشده است.';

  const lines = [
    '📈 آخرین اجرا',
    '',
    `وضعیت: ${last.status}`,
    `مدت: ${faDuration(last.durationMs)}`,
    `کانال‌های فعال: ${last.channelsEnabled}`,
    `جمع‌آوری: ${last.messagesInserted}`,
    `فیلتر تبلیغات: ${last.messagesFiltered}`,
    `خلاصه‌سازی: ${last.messagesSummarized}`,
    `انتشار: ${last.messagesPublished}`,
    `خطاها: ${last.failures}`,
    `اجراهای ۲۴ ساعت اخیر: ${summary.runs24h}`,
  ];
  if (last.errorSummary) lines.push('', `خلاصه خطا: ${last.errorSummary.slice(0, 200)}`);
  return lines.join('\n');
}

async function renderChannelList(env: Env): Promise<string> {
  const channels = await listChannels(env.DB);
  if (channels.length === 0) return '📋 کانال‌ها\n\nهنوز کانالی ثبت نشده است.';

  const stats = await getChannelStats(env.DB);
  const lines = ['📋 کانال‌ها', ''];
  for (const c of channels) {
    const s = stats.get(c.id);
    lines.push(
      `${c.enabled ? '🟢' : '🔴'} @${c.channelUsername} — ${c.enabled ? 'فعال' : 'غیرفعال'}` +
        (s ? `\n   پیام: ${s.messages} | خلاصه: ${s.summarized} | منتشرشده: ${s.published}` : '')
    );
  }
  return lines.join('\n');
}

/**
 * Admin-facing report for the image-only test. Success lists what the image
 * contains (cards, ticker lines, size, render time); failure repeats the safe
 * Persian reason from sendTestImage.
 */
export function renderTestImageResult(result: TestImageResult): string {
  if (result.ok) {
    return [
      '✅ تصویر آزمایشی به کانال مقصد ارسال شد.',
      '',
      `شناسه پیام: ${result.messageId}`,
      `خبرهای اصلی (کارت): ${result.cards}`,
      `سایر عناوین (نوار): ${result.ticker}`,
      `حجم تصویر: ${Math.max(1, Math.round(result.bytes / 1024))} کیلوبایت`,
      `زمان رندر: ${result.browserRunMs} میلی‌ثانیه`,
    ].join('\n');
  }
  const header = result.category === 'no_news' ? '⚠️ تصویری ساخته نشد.' : '❌ ارسال تصویر آزمایشی ناموفق بود.';
  return [header, '', result.message].join('\n');
}

/**
 * Admin-facing report for a test-message attempt. Success includes the
 * destination message id; failure repeats the safe Persian reason from
 * sendTestMessage and, when Telegram rejected the send, the most common
 * cause (the bot is not an admin of the destination channel).
 */
export function renderTestMessageResult(result: TestMessageResult): string {
  if (result.ok) {
    return ['✅ پیام آزمایشی به کانال مقصد ارسال شد.', '', `شناسه پیام: ${result.messageId}`].join('\n');
  }
  const hint =
    result.category === 'telegram_error'
      ? '\nمعمول‌ترین دلیل: ربات ادمین کانال مقصد با دسترسی ارسال پیام نیست.'
      : '';
  return ['❌ ارسال پیام آزمایشی ناموفق بود.', '', result.message + hint].join('\n');
}

export function renderPipelineResult(outcome: {
  status: string;
  ranAt: string;
  collection: { inserted: number } | null;
  filteredAdvertisements: number;
  summarization: { summarized: number } | null;
  publishing: { published: number; bale?: { sent: number; failed: number } } | null;
  itemFailures: number;
  durationMs: number;
}): string {
  const header =
    outcome.status === 'success'
      ? '✅ پردازش انجام شد.'
      : outcome.status === 'partial'
        ? '⚠️ پردازش با خطاهای جزئی تمام شد.'
        : '❌ پردازش با خطا مواجه شد.';

  return [
    header,
    '',
    `زمان اجرا: ${formatTehranDateTimeOrDash(outcome.ranAt)} به وقت تهران`,
    `جمع‌آوری: ${outcome.collection?.inserted ?? 0}`,
    `فیلتر تبلیغات: ${outcome.filteredAdvertisements}`,
    `خلاصه‌سازی: ${outcome.summarization?.summarized ?? 0}`,
    `انتشار: ${outcome.publishing?.published ?? 0}`,
    ...(outcome.publishing?.bale
      ? [`بیل: ${outcome.publishing.bale.sent} ارسال${
          outcome.publishing.bale.failed > 0
            ? `، ${outcome.publishing.bale.failed} خطا`
            : ''
        }`]
      : []),
    `خطا: ${outcome.itemFailures}`,
    `مدت: ${faDuration(outcome.durationMs)}`,
  ].join('\n');
}

/* -------------------------------------------------------- callback parsing -- */

export interface ParsedCallback {
  action: string;
  arg: number | null;
}

export function parseCallbackData(raw: unknown): ParsedCallback | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64) return null;
  if (!/^[a-z:]+[0-9]*$/.test(raw)) return null;

  const parts = raw.split(':');
  const action = parts[0];
  if (!action) return null;

  const ALLOWED = new Set(['menu', 'no', 'ch', 'sys', 'run', 'msg', 'img']);
  if (!ALLOWED.has(action)) return null;

  const sub = parts[1] ?? '';
  if (action === 'ch' && ['toggle', 'del', 'delok'].includes(sub)) {
    const id = Number(parts[2]);
    if (!/^[0-9]{1,15}$/.test(parts[2] ?? '') || !Number.isSafeInteger(id) || id <= 0) return null;
    return { action: `${action}:${sub}`, arg: id };
  }
  if (action === 'ch' && sub === 'list') return { action: 'ch:list', arg: null };
  if (action === 'ch' && sub === 'add') return { action: 'ch:add', arg: null };
  if (action === 'sys' && ['status', 'ai', 'last'].includes(sub)) return { action: `sys:${sub}`, arg: null };
  if (action === 'run' && ['ask', 'yes', 'no'].includes(sub)) return { action: `run:${sub}`, arg: null };
  if (action === 'msg' && sub === 'test') return { action: 'msg:test', arg: null };
  if (action === 'img' && sub === 'test') return { action: 'img:test', arg: null };
  if (action === 'menu' || action === 'no') return { action, arg: null };
  return null;
}

/* ------------------------------------------------------------- interaction -- */

interface TelegramUser {
  id: number;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  from?: TelegramUser;
  text?: string;
}

interface CallbackQuery {
  id: string;
  data?: string;
  from: TelegramUser;
  message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
  callback_query?: CallbackQuery;
}

type Sender = (chatId: string, text: string, markup?: InlineKeyboardMarkup) => Promise<void>;
type Editor = (chatId: string, messageId: number, text: string, markup?: InlineKeyboardMarkup) => Promise<void>;

/**
 * Handles one Telegram update. Never throws; all problems degrade to a safe
 * reply or a logged category.
 */
export async function handleTelegramUpdate(
  update: TelegramUpdate,
  env: Env,
  ctx?: WaitUntilCtx,
  deps: { send?: Sender; edit?: Editor; answer?: typeof answerCallbackQuery; now?: number } = {}
): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN ?? '';
  const send: Sender =
    deps.send ??
    (async (chatId, text, markup) => {
      await sendMessage({ token, chatId: chatId as `@${string}`, text, replyMarkup: markup });
    });
  const edit: Editor =
    deps.edit ??
    (async (chatId, messageId, text, markup) => {
      await editMessageText({ token, chatId, messageId, text, replyMarkup: markup });
    });
  const answer = deps.answer ?? answerCallbackQuery;

  try {
    if (update.callback_query) {
      await handleCallback(update.callback_query, env, { send, edit, answer }, ctx);
      return;
    }
    if (update.message) {
      await handleMessage(update.message, env, { send });
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'telegram-update',
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      })
    );
  }
}

interface Deps {
  send: Sender;
  edit: Editor;
  answer: typeof answerCallbackQuery;
}

async function handleMessage(message: TelegramMessage, env: Env, deps: { send: Sender }): Promise<void> {
  const chatId = String(message.chat.id);
  const text = (message.text ?? '').trim();

  if (!isAdmin(env, message.from?.id)) {
    await deps.send(chatId, UNAUTHORIZED_MESSAGE);
    return;
  }

  if (text === '/start' || text === '/start@' + (env.TELEGRAM_BOT_USERNAME ?? '')) {
    await clearAdminState(env.DB, message.chat.id);
    await deps.send(chatId, MENU_TEXT, menuKeyboard());
    return;
  }

  if (text === '/cancel') {
    await clearAdminState(env.DB, message.chat.id);
    await deps.send(chatId, 'لغو شد.', menuKeyboard());
    return;
  }

  // Runs before the pending-state checks so /test behaves like /start and
  // /cancel: it is always a command, never interpreted as channel input.
  if (text === TEST_MESSAGE_COMMAND || text === `${TEST_MESSAGE_COMMAND}@${env.TELEGRAM_BOT_USERNAME ?? ''}`) {
    const result = await sendTestMessage(env);
    await deps.send(chatId, renderTestMessageResult(result), menuKeyboard());
    return;
  }

  // Image-only test: renders the REAL pending news and sends just the picture.
  // Also before the pending-state checks, for the same reason as /test.
  if (text === TEST_IMAGE_COMMAND || text === `${TEST_IMAGE_COMMAND}@${env.TELEGRAM_BOT_USERNAME ?? ''}`) {
    const result = await sendTestImage(env);
    await deps.send(chatId, renderTestImageResult(result), menuKeyboard());
    return;
  }

  const state = await getAdminState(env.DB, message.chat.id);

  if (state?.action === 'await_channel') {
    const result = await addSourceChannel(env.DB, {
      token: env.TELEGRAM_BOT_TOKEN,
      rawInput: text,
    });
    await clearAdminState(env.DB, message.chat.id);
    await deps.send(chatId, telegramAddMessage(result.code), menuKeyboard());
    return;
  }

  if (text.startsWith('/')) {
    await deps.send(chatId, 'فرمان ناشناخته است. برای شروع /start را بفرستید.');
    return;
  }

  await deps.send(chatId, 'برای مدیریت، /start را بفرستید.');
}

function telegramAddMessage(code: string): string {
  switch (code) {
    case 'added':
      return '✅ کانال با موفقیت اضافه شد.';
    case 'duplicate':
      return '⚠️ این کانال قبلاً وجود دارد.';
    case 'not_public_channel':
      return '❌ نام کانال معتبر نیست.';
    default:
      return '❌ نام کانال معتبر نیست.';
  }
}

async function handleCallback(
  query: CallbackQuery,
  env: Env,
  deps: Deps,
  ctx?: WaitUntilCtx
): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN ?? '';
  const chatId = query.message ? String(query.message.chat.id) : '';
  const messageId = query.message?.message_id ?? 0;

  const ack = async (text?: string) => {
    await deps.answer({ token, callbackQueryId: query.id, text });
  };

  if (!isAdmin(env, query.from?.id)) {
    await ack(UNAUTHORIZED_MESSAGE);
    return;
  }

  const parsed = parseCallbackData(query.data);
  if (!parsed) {
    await ack('درخواست نامعتبر است.');
    return;
  }

  const editTarget = async (text: string, markup?: InlineKeyboardMarkup) => {
    if (chatId && messageId) {
      await deps.edit(chatId, messageId, text, markup);
    } else {
      await deps.send(chatId, text, markup);
    }
  };

  switch (parsed.action) {
    case 'menu': {
      await ack();
      await clearAdminState(env.DB, query.message!.chat.id);
      await editTarget(MENU_TEXT, menuKeyboard());
      return;
    }
    case 'no': {
      await ack('لغو شد.');
      await clearAdminState(env.DB, query.message!.chat.id);
      await editTarget(MENU_TEXT, menuKeyboard());
      return;
    }
    case 'ch:add': {
      await ack();
      await setAdminState(env.DB, {
        chatId: query.message!.chat.id,
        userId: query.from.id,
        action: 'await_channel',
      });
      await editTarget(
        'نام کاربری کانال عمومی را ارسال کنید.\nمثال: @example_channel\nبرای لغو /cancel را ارسال کنید.',
        menuKeyboard()
      );
      return;
    }
    case 'ch:list': {
      await ack();
      const channels = await listChannels(env.DB);
      await editTarget(
        await renderChannelList(env),
        channelListKeyboard(
          channels.map((c) => ({ id: c.id, channelUsername: c.channelUsername, enabled: c.enabled }))
        )
      );
      return;
    }
    case 'ch:toggle': {
      const channel = parsed.arg === null ? null : await getChannelById(env.DB, parsed.arg);
      if (!channel) {
        await ack('کانال یافت نشد.');
        return;
      }
      const updated = await setChannelEnabled(env.DB, channel.id, !channel.enabled);
      if (!updated) {
        await ack('کانال یافت نشد.');
        return;
      }
      await ack();
      const state = `${updated.enabled ? '🟢' : '🔴'} @${updated.channelUsername} ${
        updated.enabled ? 'فعال شد.' : 'غیرفعال شد.'
      }`;
      await editTarget(state, menuKeyboard());
      return;
    }
    case 'ch:del': {
      const channel = parsed.arg === null ? null : await getChannelById(env.DB, parsed.arg);
      if (!channel) {
        await ack('کانال یافت نشد.');
        return;
      }
      await ack();
      await setAdminState(env.DB, {
        chatId: query.message!.chat.id,
        userId: query.from.id,
        action: 'await_del',
        payload: String(channel.id),
      });
      await editTarget(
        `⚠️ آیا از حذف @${channel.channelUsername} مطمئن هستید؟`,
        confirmDeleteKeyboard(channel.id)
      );
      return;
    }
    case 'ch:delok': {
      const state = await getAdminState(env.DB, query.message!.chat.id);
      const matches =
        state?.action === 'await_del' && parsed.arg !== null && state.payload === String(parsed.arg);
      if (!matches) {
        // Stale or replayed confirmation: refuse, never delete.
        await ack('این درخواست منقضی شده است.');
        await editTarget(MENU_TEXT, menuKeyboard());
        return;
      }
      await ack('در حال حذف…');
      const channel = parsed.arg === null ? null : await getChannelById(env.DB, parsed.arg);
      await clearAdminState(env.DB, query.message!.chat.id);
      if (!channel) {
        await editTarget('❌ کانال یافت نشد.', menuKeyboard());
        return;
      }
      const deleted = await deleteChannel(env.DB, channel.id);
      await editTarget(
        deleted ? `🗑 کانال @${channel.channelUsername} حذف شد.` : '❌ حذف انجام نشد.',
        menuKeyboard()
      );
      return;
    }
    case 'sys:status': {
      await ack();
      await editTarget(await renderStatus(env), menuKeyboard());
      return;
    }
    case 'sys:ai': {
      await ack();
      await editTarget(await renderAiStatus(env), menuKeyboard());
      return;
    }
    case 'sys:last': {
      await ack();
      await editTarget(await renderLastRun(env), menuKeyboard());
      return;
    }
    case 'run:ask': {
      await ack();
      await setAdminState(env.DB, {
        chatId: query.message!.chat.id,
        userId: query.from.id,
        action: 'await_run',
      });
      await editTarget(
        '⚠️ پردازش دستی اجرا شود؟\nاین عملیات ممکن است پیام‌های جدید را جمع‌آوری، خلاصه و منتشر کند.',
        runConfirmKeyboard()
      );
      return;
    }
    case 'run:yes': {
      const state = await getAdminState(env.DB, query.message!.chat.id);
      if (state?.action !== 'await_run') {
        await ack('این درخواست منقضی شده است.');
        await editTarget(MENU_TEXT, menuKeyboard());
        return;
      }
      await ack('پردازش آغاز شد…');
      await clearAdminState(env.DB, query.message!.chat.id);

      // The pipeline is long-running, so it is handed to the SAME execution
      // context the webhook request arrived with. Registering it keeps the
      // invocation alive; an untracked promise here would be discarded once the
      // webhook response is sent, which is why manual runs silently never
      // finished in production.
      const work = (async () => {
        const outcome = await runNewsPipeline(env.DB, env, { trigger: 'manual' });
        await deps.send(chatId, renderPipelineResult(outcome), menuKeyboard());
      })().catch(async (error: unknown) => {
        console.error(
          JSON.stringify({
            event: 'telegram-manual-run',
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString(),
          })
        );
        await deps.send(chatId, '❌ پردازش با خطا مواجه شد.', menuKeyboard());
      });

      if (ctx) {
        ctx.waitUntil(work);
      } else {
        await work;
      }
      return;
    }
    case 'run:no': {
      await ack('لغو شد.');
      await clearAdminState(env.DB, query.message!.chat.id);
      await editTarget(MENU_TEXT, menuKeyboard());
      return;
    }
    case 'msg:test': {
      // One quick Telegram round-trip, so this is safe to run inline (unlike
      // the manual pipeline run, which needs ctx.waitUntil).
      await ack('در حال ارسال پیام آزمایشی…');
      const result = await sendTestMessage(env);
      await editTarget(renderTestMessageResult(result), menuKeyboard());
      return;
    }
    case 'img:test': {
      // One Browser Run request plus one sendPhoto; still a single bounded
      // round-trip, safe to run inline like msg:test.
      await ack('در حال ساخت و ارسال تصویر…');
      const result = await sendTestImage(env);
      await editTarget(renderTestImageResult(result), menuKeyboard());
      return;
    }
    default:
      await ack('درخواست نامعتبر است.');
  }
}

/* ----------------------------------------------------------------- webhook -- */

export interface WebhookResult {
  status: number;
  handled: boolean;
}

/** Minimal execution-context shape so tests can run updates inline. */
export interface WaitUntilCtx {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Validates the webhook secret and dispatches one update.
 * Rejects: wrong method, missing/short body, non-JSON, oversized, bad secret.
 *
 * When no execution context is supplied the update is processed inline, which
 * keeps tests deterministic; in production a context is always present.
 */
export async function handleWebhook(
  request: Request,
  env: Env,
  ctx?: WaitUntilCtx,
  deps: { send?: Sender; edit?: Editor; answer?: typeof answerCallbackQuery } = {}
): Promise<WebhookResult> {
  if (request.method !== 'POST') return { status: 405, handled: false };

  const configured = env.TELEGRAM_WEBHOOK_SECRET;
  if (!configured || configured.length < 16) {
    console.error(
      JSON.stringify({
        event: 'telegram-webhook',
        status: 'error',
        category: 'webhook_secret_not_configured',
        timestamp: new Date().toISOString(),
      })
    );
    return { status: 503, handled: false };
  }

  const provided = request.headers.get('x-telegram-bot-api-secret-token') ?? '';
  if (!(await secretEquals(provided, configured))) {
    return { status: 401, handled: false };
  }

  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_UPDATE_BYTES) return { status: 413, handled: false };

  const raw = await request.text();
  // Length check again: content-length is absent or untrusted for chunked bodies.
  if (raw.length > MAX_UPDATE_BYTES) return { status: 413, handled: false };
  if (raw.length === 0) return { status: 400, handled: false };

  let update: TelegramUpdate;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { status: 400, handled: false };
    update = parsed as TelegramUpdate;
  } catch {
    return { status: 400, handled: false };
  }

  const isRecognizable =
    update && typeof update === 'object' && (Boolean(update.message) || Boolean(update.callback_query));
  if (!isRecognizable) return { status: 200, handled: false };

  if (ctx) {
    ctx.waitUntil(handleTelegramUpdate(update, env, ctx, deps).catch(() => undefined));
  } else {
    await handleTelegramUpdate(update, env, undefined, deps);
  }
  return { status: 200, handled: true };
}

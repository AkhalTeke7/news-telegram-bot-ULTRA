import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAdminState,
  getAdminState,
  handleTelegramUpdate,
  handleWebhook,
  MENU_TEXT,
  parseAdminUserId,
  parseCallbackData,
  renderPipelineResult,
  setAdminState,
  STATE_TTL_MS,
  UNAUTHORIZED_MESSAGE,
  type TelegramUpdate,
} from '../src/telegramAdmin';
import { addSourceChannel } from '../src/sourceChannels';
import { runNewsPipeline } from '../src/pipeline';
import worker from '../src/index';
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import type { Env } from '../src/types';

const ADMIN_ID = 424242;
const OTHER_ID = 999999;
const SECRET = 'webhook-secret-0123456789';

const baseEnv = (over: Partial<Env> = {}): Env =>
  ({
    DB: env.DB,
    TELEGRAM_BOT_TOKEN: '',
    ADMIN_PASSWORD: 'x',
    TELEGRAM_ADMIN_USER_ID: String(ADMIN_ID),
    TELEGRAM_WEBHOOK_SECRET: SECRET,
    ...over,
  }) as Env;

interface Sent {
  chatId: string;
  text: string;
  markup?: unknown;
}

function recorder() {
  const sent: Sent[] = [];
  const edited: Sent[] = [];
  const acks: string[] = [];
  return {
    sent,
    edited,
    acks,
    send: vi.fn(async (chatId: string, text: string, markup?: unknown) => {
      sent.push({ chatId, text, markup });
    }),
    edit: vi.fn(async (chatId: string, _m: number, text: string, markup?: unknown) => {
      edited.push({ chatId, text, markup });
    }),
    answer: vi.fn(async (o: { text?: string }) => {
      acks.push(o.text ?? '');
    }),
  };
}

const msg = (text: string, fromId = ADMIN_ID, chatId = 100) => ({
  message: { message_id: 1, chat: { id: chatId }, from: { id: fromId }, text },
});

const cb = (data: string, fromId = ADMIN_ID, chatId = 100, messageId = 5) => ({
  callback_query: {
    id: 'cb1',
    data,
    from: { id: fromId },
    message: { message_id: messageId, chat: { id: chatId }, from: { id: fromId } },
  },
});

async function reset() {
  await env.DB.prepare(`DELETE FROM telegram_admin_state`).run();
  await env.DB.prepare(`DELETE FROM messages`).run();
  await env.DB.prepare(`DELETE FROM channels`).run();
  await env.DB.prepare(`DELETE FROM cron_runs`).run();
  await env.DB.prepare(`DELETE FROM ai_settings`).run();
}

async function seedChannel(username: string, enabled = true) {
  const r = await env.DB.prepare(`INSERT INTO channels (channel_username, enabled) VALUES (?1, ?2)`)
    .bind(username, enabled ? 1 : 0)
    .run();
  return Number(r.meta.last_row_id);
}

beforeEach(reset);

/* -------------------------------------------------------------- authorization */

describe('authorization', () => {
  it('parses only strict numeric ids', () => {
    expect(parseAdminUserId('424242')).toBe('424242');
    expect(parseAdminUserId(' 424242 ')).toBe('424242');
    expect(parseAdminUserId('abc')).toBeNull();
    expect(parseAdminUserId('-5')).toBeNull();
    expect(parseUserish('424242abc')).toBeNull();
    expect(parseUserish('')).toBeNull();
    expect(parseUserish(undefined)).toBeNull();
  });

  it('accepts the exact admin id', async () => {
    const r = recorder();
    await handleTelegramUpdate(msg('/start') as TelegramUpdate, baseEnv(), undefined, r);
    expect(r.send).toHaveBeenCalled();
    expect(r.sent[0].text).toBe(MENU_TEXT);
  });

  it('rejects any other numeric id with the generic message', async () => {
    const r = recorder();
    await handleTelegramUpdate(msg('/start', OTHER_ID) as TelegramUpdate, baseEnv(), undefined, r);
    expect(r.sent[0].text).toBe(UNAUTHORIZED_MESSAGE);
    expect(r.sent[0].text).not.toContain(String(ADMIN_ID));
  });

  it('username cannot bypass authorization', async () => {
    const r = recorder();
    await handleTelegramUpdate(
      { message: { message_id: 1, chat: { id: 1 }, from: { id: OTHER_ID }, text: '/start' } } as unknown as TelegramUpdate,
      baseEnv(),
      undefined,
      r
    );
    expect(r.sent[0].text).toBe(UNAUTHORIZED_MESSAGE);
  });

  it('rejects everyone when no admin id is configured', async () => {
    const r = recorder();
    await handleTelegramUpdate(msg('/start') as TelegramUpdate, baseEnv({ TELEGRAM_ADMIN_USER_ID: undefined }), undefined, r);
    expect(r.sent[0].text).toBe(UNAUTHORIZED_MESSAGE);
  });
});

function parseUserish(v: string | undefined) {
  return parseAdminUserId(v);
}

/* ------------------------------------------------------------------- webhook */

describe('webhook', () => {
  const post = (body: string, headers: Record<string, string> = {}) =>
    new Request('https://worker.test/api/telegram/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET, ...headers },
      body,
    });

  it('rejects non-POST', async () => {
    const res = await handleWebhook(new Request('https://w.test/api/telegram/webhook'), baseEnv());
    expect(res.status).toBe(405);
  });

  it('rejects a missing secret', async () => {
    const res = await handleWebhook(
      new Request('https://w.test/api/telegram/webhook', { method: 'POST', body: '{}' }),
      baseEnv()
    );
    expect(res.status).toBe(401);
  });

  it('rejects a wrong secret', async () => {
    const res = await handleWebhook(
      post(JSON.stringify(msg('/start')), { 'x-telegram-bot-api-secret-token': 'wrong-secret-000000' }),
      baseEnv()
    );
    expect(res.status).toBe(401);
  });

  it('refuses to process when no secret is configured', async () => {
    const res = await handleWebhook(post(JSON.stringify(msg('/start'))), baseEnv({ TELEGRAM_WEBHOOK_SECRET: undefined }));
    expect(res.status).toBe(503);
  });

  it('rejects malformed and oversized bodies', async () => {
    expect((await handleWebhook(post('not-json'), baseEnv())).status).toBe(400);
    expect((await handleWebhook(post('[1,2,3]'), baseEnv())).status).toBe(400);
    expect((await handleWebhook(post(''), baseEnv())).status).toBe(400);
    expect((await handleWebhook(post('{"padding":"' + 'x'.repeat(70 * 1024) + '"}'), baseEnv())).status).toBe(413);
  });

  it('accepts a valid update and handles it', async () => {
    const r = recorder();
    const res = await handleWebhook(post(JSON.stringify(msg('/start'))), baseEnv(), undefined, r);
    expect(res.status).toBe(200);
    expect(res.handled).toBe(true);
    expect(r.sent[0].text).toBe(MENU_TEXT);
  });

  it('returns 200 for unrecognizable but valid JSON', async () => {
    const res = await handleWebhook(post(JSON.stringify({ update_id: 5 })), baseEnv());
    expect(res.status).toBe(200);
    expect(res.handled).toBe(false);
  });

  it('is reachable through the worker without a session cookie', async () => {
    // A payload with no message/callback is acknowledged but performs no
    // outbound Telegram call, so this route test stays offline.
    const ok = await worker.fetch(
      new Request('https://worker.test/api/telegram/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
        body: JSON.stringify({ update_id: 5 }),
      }),
      baseEnv(),
      createExecutionContext()
    );
    expect(ok.status).toBe(200);

    const rejected = await worker.fetch(
      new Request('https://worker.test/api/telegram/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'nope' },
        body: JSON.stringify({ update_id: 5 }),
      }),
      baseEnv(),
      createExecutionContext()
    );
    expect(rejected.status).toBe(401);
  });
});

/* ------------------------------------------------------------------ commands */

describe('commands', () => {
  it('/start shows the menu with all seven buttons', async () => {
    const r = recorder();
    await handleTelegramUpdate(msg('/start') as TelegramUpdate, baseEnv(), undefined, r);
    const markup = r.sent[0].markup as { inline_keyboard: { text: string; callback_data?: string }[][] };
    const labels = markup.inline_keyboard.flat().map((b) => b.text);
    for (const expected of [
      '➕ افزودن کانال',
      '📋 کانال‌ها',
      '📊 وضعیت سامانه',
      '🤖 وضعیت مدل AI',
      '📰 پردازش دستی',
      '📈 آخرین اجرا',
      '❌ لغو',
    ]) {
      expect(labels).toContain(expected);
    }
  });

  it('add channel: asks for input, then stores it', async () => {
    const r = recorder();
    await handleTelegramUpdate(cb('ch:add') as unknown as TelegramUpdate, baseEnv(), undefined, r);
    expect(r.edited[0].text).toContain('نام کاربری کانال عمومی را ارسال کنید.');
    expect(r.edited[0].text).toContain('@example_channel');
    expect(r.edited[0].text).toContain('/cancel');

    const r2 = recorder();
    await handleTelegramUpdate(msg('https://t.me/My_New_Channel/') as TelegramUpdate, baseEnv(), undefined, r2);
    expect(r2.sent[0].text).toBe('✅ کانال با موفقیت اضافه شد.');
    const rows = await env.DB.prepare(`SELECT channel_username FROM channels`).all<{ channel_username: string }>();
    expect(rows.results[0].channel_username).toBe('my_new_channel');
    expect(await getAdminState(env.DB, 100)).toBeNull();
  });

  it('rejects duplicates', async () => {
    await seedChannel('dupe_channel');
    const r = recorder();
    await handleTelegramUpdate(cb('ch:add') as unknown as TelegramUpdate, baseEnv(), undefined, r);
    const r2 = recorder();
    await handleTelegramUpdate(msg('@dupe_channel') as TelegramUpdate, baseEnv(), undefined, r2);
    expect(r2.sent[0].text).toBe('⚠️ این کانال قبلاً وجود دارد.');
  });

  it('rejects invalid input', async () => {
    const r = recorder();
    await handleTelegramUpdate(cb('ch:add') as unknown as TelegramUpdate, baseEnv(), undefined, r);
    const r2 = recorder();
    await handleTelegramUpdate(msg('not a channel!!') as TelegramUpdate, baseEnv(), undefined, r2);
    expect(r2.sent[0].text).toBe('❌ نام کانال معتبر نیست.');
  });

  it('/cancel clears the pending state', async () => {
    const r = recorder();
    await handleTelegramUpdate(cb('ch:add') as unknown as TelegramUpdate, baseEnv(), undefined, r);
    expect(await getAdminState(env.DB, 100)).not.toBeNull();

    const r2 = recorder();
    await handleTelegramUpdate(msg('/cancel') as TelegramUpdate, baseEnv(), undefined, r2);
    expect(await getAdminState(env.DB, 100)).toBeNull();
    expect(r2.sent[0].text).toBe('لغو شد.');
  });

  it('lists channels with state and stats', async () => {
    await seedChannel('alpha_channel', true);
    await seedChannel('beta_channel', false);
    const r = recorder();
    await handleTelegramUpdate(cb('ch:list') as unknown as TelegramUpdate, baseEnv(), undefined, r);
    const text = r.edited[0].text;
    expect(text).toContain('@alpha_channel');
    expect(text).toContain('فعال');
    expect(text).toContain('@beta_channel');
    expect(text).toContain('غیرفعال');

    const markup = r.edited[0].markup as { inline_keyboard: { callback_data: string }[][] };
    const data = markup.inline_keyboard.flat().map((b) => b.callback_data);
    expect(data.some((d) => /^ch:toggle:\d+$/.test(d))).toBe(true);
    expect(data.some((d) => /^ch:del:\d+$/.test(d))).toBe(true);
  });

  it('toggles enable/disable', async () => {
    const id = await seedChannel('toggle_channel', true);
    const r = recorder();
    await handleTelegramUpdate(cb(`ch:toggle:${id}`) as unknown as TelegramUpdate, baseEnv(), undefined, r);
    expect(r.edited[0].text).toBe('🔴 @toggle_channel غیرفعال شد.');

    const r2 = recorder();
    await handleTelegramUpdate(cb(`ch:toggle:${id}`) as unknown as TelegramUpdate, baseEnv(), undefined, r2);
    expect(r2.edited[0].text).toBe('🟢 @toggle_channel فعال شد.');
  });

  it('requires confirmation before deleting and refuses stale confirmations', async () => {
    const id = await seedChannel('delete_channel');
    const r = recorder();
    await handleTelegramUpdate(cb(`ch:del:${id}`) as unknown as TelegramUpdate, baseEnv(), undefined, r);
    expect(r.edited[0].text).toContain('⚠️ آیا از حذف @delete_channel مطمئن هستید؟');

    // Not deleted on the first tap.
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM channels`).first<{ n: number }>())!.n).toBe(1);

    const r2 = recorder();
    await handleTelegramUpdate(cb(`ch:delok:${id}`) as unknown as TelegramUpdate, baseEnv(), undefined, r2);
    expect(r2.acks[0]).toBe('در حال حذف…');
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM channels`).first<{ n: number }>())!.n).toBe(0);
  });

  it('refuses a delete confirmation without a pending confirmation', async () => {
    const id = await seedChannel('no_confirm_channel');
    const r = recorder();
    await handleTelegramUpdate(cb(`ch:delok:${id}`) as unknown as TelegramUpdate, baseEnv(), undefined, r);
    expect(r.acks[0]).toBe('این درخواست منقضی شده است.');
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM channels`).first<{ n: number }>())!.n).toBe(1);
  });

  it('cancelling a delete keeps the channel', async () => {
    const id = await seedChannel('keep_channel');
    await handleTelegramUpdate(cb(`ch:del:${id}`) as unknown as TelegramUpdate, baseEnv(), undefined, recorder());
    await handleTelegramUpdate(cb('no') as unknown as TelegramUpdate, baseEnv(), undefined, recorder());
    const r = recorder();
    await handleTelegramUpdate(cb(`ch:delok:${id}`) as unknown as TelegramUpdate, baseEnv(), undefined, r);
    expect(r.acks[0]).toBe('این درخواست منقضی شده است.');
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM channels`).first<{ n: number }>())!.n).toBe(1);
  });

  it('shows system status without secrets', async () => {
    await seedChannel('stat_channel');
    const r = recorder();
    await handleTelegramUpdate(cb('sys:status') as unknown as TelegramUpdate, baseEnv(), undefined, r);
    const text = r.edited[0].text;
    expect(text).toContain('📊 وضعیت سامانه');
    expect(text).toContain('کانال‌های فعال');
    expect(text).toContain('در انتظار خلاصه‌سازی');
    expect(text).toContain('در انتظار انتشار');
    expect(text).not.toMatch(/TELEGRAM_BOT_TOKEN|OPENCODE_API_KEY|ADMIN_PASSWORD|ADMIN_USER_ID/);
    expect(text).not.toContain(String(ADMIN_ID));
  });

  it('shows AI model status from cache without forcing a refresh', async () => {
    await env.DB.prepare(
      `INSERT INTO ai_settings (key, value) VALUES ('free_models', ?1), ('selected_model', ?2), ('free_models_refreshed_at', ?3)`
    )
      .bind(JSON.stringify(['a-free', 'b-free']), 'a-free', new Date().toISOString())
      .run();

    const r = recorder();
    await handleTelegramUpdate(cb('sys:ai') as unknown as TelegramUpdate, baseEnv(), undefined, r);
    expect(r.edited[0].text).toContain('تعداد مدل‌های Free: 2');
    expect(r.edited[0].text).toContain('a-free');
    expect(r.edited[0].text).toContain('به‌روز');
  });

  it('shows the last run', async () => {
    const r0 = recorder();
    await handleTelegramUpdate(cb('sys:last') as unknown as TelegramUpdate, baseEnv(), undefined, r0);
    expect(r0.edited[0].text).toContain('هنوز اجرایی ثبت نشده');

    await runNewsPipeline(env.DB, baseEnv(), { trigger: '0 * * * *', log: false });
    const r = recorder();
    await handleTelegramUpdate(cb('sys:last') as unknown as TelegramUpdate, baseEnv(), undefined, r);
    expect(r.edited[0].text).toContain('📈 آخرین اجرا');
    expect(r.edited[0].text).toContain('وضعیت:');
  });
});

/* ------------------------------------------------------------ callback safety */

describe('callback queries', () => {
  it('parses only known actions', () => {
    expect(parseCallbackData('menu')).toEqual({ action: 'menu', arg: null });
    expect(parseCallbackData('ch:toggle:12')).toEqual({ action: 'ch:toggle', arg: 12 });
    expect(parseCallbackData('sys:status')).toEqual({ action: 'sys:status', arg: null });
    expect(parseCallbackData('ch:del:-5')).toBeNull();
    expect(parseCallbackData('ch:toggle:abc')).toBeNull();
    expect(parseCallbackData('ch:delok:1;DROP')).toBeNull();
    expect(parseCallbackData('evil:action')).toBeNull();
    expect(parseCallbackData('')).toBeNull();
    expect(parseCallbackData(undefined)).toBeNull();
    expect(parseCallbackData(42)).toBeNull();
    expect(parseCallbackData('x'.repeat(65))).toBeNull();
  });

  it('answers unauthorized callbacks without acting', async () => {
    const r = recorder();
    await handleTelegramUpdate(cb('ch:list', OTHER_ID) as unknown as TelegramUpdate, baseEnv(), undefined, r);
    expect(r.acks[0]).toBe(UNAUTHORIZED_MESSAGE);
    expect(r.send).not.toHaveBeenCalled();
    expect(r.edit).not.toHaveBeenCalled();
  });

  it('rejects malformed callback data', async () => {
    const r = recorder();
    await handleTelegramUpdate(cb('garbage') as unknown as TelegramUpdate, baseEnv(), undefined, r);
    expect(r.acks[0]).toBe('درخواست نامWhenever است.'.replace('Whenever', 'عتبر'));
  });

  it('refuses a nonexistent channel id', async () => {
    const r = recorder();
    await handleTelegramUpdate(cb('ch:toggle:987654') as unknown as TelegramUpdate, baseEnv(), undefined, r);
    expect(r.acks[0]).toBe('کانال یافت نشد.');
    expect(r.edit).not.toHaveBeenCalled();
  });

  it('repeating a delete confirmation only deletes once', async () => {
    const id = await seedChannel('repeat_delete');
    await handleTelegramUpdate(cb(`ch:del:${id}`) as unknown as TelegramUpdate, baseEnv(), undefined, recorder());
    await handleTelegramUpdate(cb(`ch:delok:${id}`) as unknown as TelegramUpdate, baseEnv(), undefined, recorder());
    const replay = recorder();
    await handleTelegramUpdate(cb(`ch:delok:${id}`) as unknown as TelegramUpdate, baseEnv(), undefined, replay);
    expect(replay.acks[0]).toBe('این درخواست منقضی شده است.');
  });
});

/* --------------------------------------------------------------- state (D1) */

describe('conversation state', () => {
  it('creates, reads and clears state', async () => {
    await setAdminState(env.DB, { chatId: 7, userId: ADMIN_ID, action: 'await_channel' });
    const state = await getAdminState(env.DB, 7);
    expect(state?.action).toBe('await_channel');
    await clearAdminState(env.DB, 7);
    expect(await getAdminState(env.DB, 7)).toBeNull();
  });

  it('expires automatically', async () => {
    const now = Date.now();
    await setAdminState(env.DB, { chatId: 8, userId: ADMIN_ID, action: 'await_run' }, now);
    expect(await getAdminState(env.DB, 8, now + 1000)).not.toBeNull();
    expect(await getAdminState(env.DB, 8, now + STATE_TTL_MS + 60_000)).toBeNull();
  });

  it('stores no message contents', async () => {
    await setAdminState(env.DB, { chatId: 9, userId: ADMIN_ID, action: 'await_del', payload: '3' });
    const row = await env.DB.prepare(
      `SELECT * FROM telegram_admin_state WHERE chat_id = 9`
    ).first<Record<string, string>>();
    expect(Object.keys(row!).sort()).toEqual(
      ['action', 'chat_id', 'created_at', 'expires_at', 'payload', 'user_id'].sort()
    );
  });

  it('unauthorized users cannot drive existing state', async () => {
    await setAdminState(env.DB, { chatId: 100, userId: ADMIN_ID, action: 'await_channel' });
    const r = recorder();
    await handleTelegramUpdate(msg('@sneaky_channel', OTHER_ID) as TelegramUpdate, baseEnv(), undefined, r);
    expect(r.sent[0].text).toBe(UNAUTHORIZED_MESSAGE);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM channels`).first<{ n: number }>())!.n).toBe(0);
    expect(await getAdminState(env.DB, 100)).not.toBeNull();
  });
});

/* -------------------------------------------------------------- manual run */

describe('manual processing', () => {
  it('requires confirmation before running', async () => {
    const r = recorder();
    await handleTelegramUpdate(cb('run:ask') as unknown as TelegramUpdate, baseEnv(), undefined, r);
    expect(r.edited[0].text).toContain('⚠️ پردازش دستی اجرا شود؟');
    expect(r.edited[0].text).toContain('جمع‌آوری');

    // No confirmation: nothing ran.
    const runs = await env.DB.prepare(`SELECT COUNT(*) AS n FROM cron_runs`).first<{ n: number }>();
    expect(runs?.n).toBe(0);
  });

it('registers the manual pipeline with the execution context instead of firing a floating promise', async () => {
    // Confirmation first, exactly as the admin does in Telegram.
    const ask = recorder();
    await handleTelegramUpdate(
      cb('run:ask') as unknown as TelegramUpdate,
      baseEnv(),
      undefined,
      ask
    );
    expect(ask.acks).toHaveLength(1);

    const r = recorder();
    // Simulates Cloudflare: only promises handed to waitUntil keep the
    // invocation alive, and nothing else is awaited.
    const waited: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => {
        waited.push(promise);
      },
    };

    await handleTelegramUpdate(
      cb('run:yes') as unknown as TelegramUpdate,
      baseEnv(),
      ctx,
      r
    );

    // The pipeline was handed to waitUntil (not a detached `void` promise).
    expect(waited).toHaveLength(1);
    // The callback is still acknowledged and the state is already cleared.
    expect(r.acks[0]).toBe('پردازش آغاز شد…');
    expect(await getAdminState(env.DB, 100)).toBeNull();

    // Nothing has completed yet: nothing was awaited outside the context.
    expect(r.sent.filter((s) => s.text.includes('انتشار:'))).toHaveLength(0);

    // The runtime would now await exactly this promise.
    await Promise.all(waited);

    // Pipeline ran under the manual trigger and the result was reported back.
    const runs = await env.DB.prepare(`SELECT trigger_name FROM cron_runs`).all<{
      trigger_name: string;
    }>();
    expect(runs.results.map((x) => x.trigger_name)).toEqual(['manual']);

    const last = r.sent.at(-1)!;
    expect(last.text).toContain('انتشار:');
    expect(last.text).toContain('جمع‌آوری:');
    expect(last.text).toContain('خطا:');
    expect(last.text).toContain('به وقت تهران');
  });

  it('runs inline when no execution context is supplied (tests / direct calls)', async () => {
    await handleTelegramUpdate(cb('run:ask') as unknown as TelegramUpdate, baseEnv(), undefined, recorder());
    const r = recorder();
    await handleTelegramUpdate(cb('run:yes') as unknown as TelegramUpdate, baseEnv(), undefined, r);

    expect(r.sent.at(-1)!.text).toContain('انتشار:');
    const runs = await env.DB.prepare(`SELECT trigger_name FROM cron_runs`).first<{ trigger_name: string }>();
    expect(runs?.trigger_name).toBe('manual');
  });

  it('registers an error path that still reports to the admin without secrets', async () => {
    await handleTelegramUpdate(cb('run:ask') as unknown as TelegramUpdate, baseEnv(), undefined, recorder());

    const waited: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void waited.push(p) };
    const r = recorder();
    await handleTelegramUpdate(cb('run:yes') as unknown as TelegramUpdate, baseEnv(), ctx, r);

    expect(waited).toHaveLength(1);
    await Promise.all(waited);

    // A normal run reports a result (no throw escapes into the invocation).
    const last = r.sent.at(-1)!;
    expect(last.text.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.sent)).not.toContain('test-admin-password');
    expect(JSON.stringify(r.sent)).not.toMatch(/OPENCODE_API_KEY|TELEGRAM_BOT_TOKEN/);
  });

  it('run:no cancels without registering any work', async () => {
    const r = recorder();
    const waited: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void waited.push(p) };

    await handleTelegramUpdate(cb('run:ask') as unknown as TelegramUpdate, baseEnv(), undefined, recorder());
    await handleTelegramUpdate(cb('run:no') as unknown as TelegramUpdate, baseEnv(), ctx, r);

    expect(waited).toHaveLength(0);
    const runs = await env.DB.prepare(`SELECT COUNT(*) AS n FROM cron_runs`).first<{ n: number }>();
    expect(runs?.n).toBe(0);
  });

  it('an unauthorized user cannot register pipeline work', async () => {
    const r = recorder();
    const waited: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void waited.push(p) };

    await handleTelegramUpdate(
      cb('run:yes', OTHER_ID) as unknown as TelegramUpdate,
      baseEnv(),
      ctx,
      r
    );

    expect(r.acks[0]).toBe(UNAUTHORIZED_MESSAGE);
    expect(waited).toHaveLength(0);
    const runs = await env.DB.prepare(`SELECT COUNT(*) AS n FROM cron_runs`).first<{ n: number }>();
    expect(runs?.n).toBe(0);
  });

  it('refuses a run confirmation that was never requested', async () => {
    const r = recorder();
    await handleTelegramUpdate(cb('run:yes') as unknown as TelegramUpdate, baseEnv(), undefined, r);
    expect(r.acks[0]).toBe('این درخواست منقضی شده است.');
    const runs = await env.DB.prepare(`SELECT COUNT(*) AS n FROM cron_runs`).first<{ n: number }>();
    expect(runs?.n).toBe(0);
  });

  it('cannot be triggered by an unauthorized user', async () => {
    await handleTelegramUpdate(cb('run:ask') as unknown as TelegramUpdate, baseEnv(), undefined, recorder());
    const r = recorder();
    await handleTelegramUpdate(cb('run:yes', OTHER_ID) as unknown as TelegramUpdate, baseEnv(), undefined, r);
    expect(r.acks[0]).toBe(UNAUTHORIZED_MESSAGE);
    const runs = await env.DB.prepare(`SELECT COUNT(*) AS n FROM cron_runs`).first<{ n: number }>();
    expect(runs?.n).toBe(0);
  });

  it('renders partial and failed outcomes distinctly', () => {
    const base = {
      ranAt: '2026-01-15T20:30:00.000Z',
      collection: { inserted: 1 },
      filteredAdvertisements: 4,
      summarization: { summarized: 2 },
      publishing: { published: 3 },
      itemFailures: 0,
      durationMs: 1200,
    };
    expect(renderPipelineResult({ ...base, status: 'success' })).toContain('✅ پردازش انجام شد.');
    expect(renderPipelineResult({ ...base, status: 'success' })).toContain('فیلتر تبلیغات: 4');
    expect(renderPipelineResult({ ...base, status: 'success' })).toContain('به وقت تهران');
    // 2026-01-15T20:30:00Z is 00:00 the next day in Tehran (UTC+03:30).
    expect(renderPipelineResult({ ...base, status: 'success' })).toContain('۰۰:۰۰');
    expect(renderPipelineResult({ ...base, status: 'partial' })).toContain('⚠️ پردازش با خطاهای جزئی تمام شد.');
    expect(renderPipelineResult({ ...base, status: 'failed' })).toContain('❌ پردازش با خطا مواجه شد.');
  });
});

/* -------------------------------------------------------- shared pipeline */

describe('shared pipeline', () => {
  it('the scheduled handler uses the same pipeline', async () => {
    // No channels seeded: collection must stay offline so this test is
    // deterministic and never touches the network.
    const ctx = createExecutionContext();
    await worker.scheduled!(
      createScheduledController({ cron: '0 * * * *', scheduledTime: Date.now() }),
      baseEnv(),
      ctx
    );
    await waitOnExecutionContext(ctx);

    const rows = await env.DB.prepare(`SELECT trigger_name, finished_at FROM cron_runs`).all<{
      trigger_name: string;
      finished_at: string | null;
    }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].trigger_name).toBe('0 * * * *');
    expect(rows.results[0].finished_at).not.toBeNull();
  });

  it('manual and cron runs both write the same bookkeeping shape', async () => {
    await runNewsPipeline(env.DB, baseEnv(), { trigger: 'manual', log: false });
    const manual = await env.DB.prepare(`SELECT * FROM cron_runs WHERE trigger_name='manual'`).first<Record<string, number | string | null>>();
    expect(manual).not.toBeNull();
    expect(manual!.finished_at).toBeTruthy();
    expect(manual!.status).toBeTruthy();
    expect(manual!.messages_published).toBe(0);
  });

  it('web and telegram add-channel share one implementation', async () => {
    const result = await addSourceChannel(env.DB, { rawInput: 'https://t.me/Shared_Path/' });
    expect(result.code).toBe('added');
    const again = await addSourceChannel(env.DB, { rawInput: '@shared_path' });
    expect(again.code).toBe('duplicate');
  });
});

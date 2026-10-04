import { createExecutionContext, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApi } from '../src/api';
import {
  handleTelegramUpdate,
  menuKeyboard,
  parseCallbackData,
  renderTestMessageResult,
  UNAUTHORIZED_MESSAGE,
  type TelegramUpdate,
} from '../src/telegramAdmin';
import {
  buildTestMessageText,
  sendTestMessage,
  TEST_MESSAGE_COMMAND,
} from '../src/testMessage';
import type { Env } from '../src/types';

const PASSWORD = 'test-admin-password';
const BOT_TOKEN = 'unit-test-bot-token';
const DESTINATION = '@test_dest_channel';
const ADMIN_ID = 424242;
const OTHER_ID = 999999;
const SECRET = 'webhook-secret-0123456789';

const baseEnv = (over: Partial<Env> = {}): Env =>
  ({
    DB: env.DB,
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    ADMIN_PASSWORD: PASSWORD,
    TELEGRAM_ADMIN_USER_ID: String(ADMIN_ID),
    TELEGRAM_WEBHOOK_SECRET: SECRET,
    TELEGRAM_DESTINATION_CHANNEL: DESTINATION,
    ...over,
  }) as Env;

/** Captures the outbound sendMessage request without any real network call. */
function telegramOk(messageId = 777) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init.body)) });
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: messageId, date: 1234 } }),
      { status: 200 }
    );
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function telegramFailure(status: number, body: Record<string, unknown>) {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status })
  ) as unknown as typeof fetch;
}

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

async function loginCookie(e: Env = baseEnv(), password = PASSWORD): Promise<string> {
  const res = await createApi().fetch(
    new Request('https://worker.test/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    }),
    e,
    createExecutionContext()
  );
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie')!.split(';')[0];
}

async function callEndpoint(e: Env, cookie?: string): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (cookie) headers.set('cookie', cookie);
  return createApi().fetch(
    new Request('https://worker.test/api/telegram/test-message', {
      method: 'POST',
      headers,
    }),
    e,
    createExecutionContext()
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------- message text */

describe('buildTestMessageText', () => {
  it('is a clearly-marked Persian test notice with the Tehran timestamp', () => {
    const text = buildTestMessageText(new Date('2026-10-04T12:00:00Z'));
    expect(text).toContain('🧪');
    expect(text).toContain('پیام آزمایشی');
    // 12:00 UTC is 15:30 in the fixed UTC+03:30 Tehran offset.
    expect(text).toContain('۱۵:۳۰');
    expect(text).toContain('به وقت تهران');
  });

  it('survives a missing/invalid timestamp input', () => {
    const text = buildTestMessageText(new Date('not-a-date'));
    expect(text).toContain('پیام آزمایشی');
    expect(text).toContain('—');
  });
});

/* -------------------------------------------------------------- core sender */

describe('sendTestMessage', () => {
  it('sends to the configured destination and returns the message id', async () => {
    const t = telegramOk(4242);
    const result = await sendTestMessage(baseEnv(), { fetchImpl: t.fetchImpl });

    expect(result).toEqual({ ok: true, messageId: 4242 });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    expect(t.calls[0].body.chat_id).toBe(DESTINATION);
    expect(t.calls[0].body.disable_notification).toBe('true');
    expect(String(t.calls[0].body.text)).toContain('پیام آزمایشی');
  });

  it('fails safely when the destination is not configured', async () => {
    const fetchImpl = vi.fn();
    const result = await sendTestMessage(
      baseEnv({ TELEGRAM_DESTINATION_CHANNEL: undefined }),
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.category).toBe('destination_not_configured');
      expect(result.message).toContain('TELEGRAM_DESTINATION_CHANNEL');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails safely on a malformed destination value', async () => {
    const fetchImpl = vi.fn();
    const result = await sendTestMessage(
      baseEnv({ TELEGRAM_DESTINATION_CHANNEL: 'not a channel!' }),
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.category).toBe('invalid_destination');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails safely when the bot token is missing', async () => {
    const fetchImpl = vi.fn();
    const result = await sendTestMessage(baseEnv({ TELEGRAM_BOT_TOKEN: '' }), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.category).toBe('token_missing');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('surfaces the Telegram description for a rejected send (chat not found)', async () => {
    vi.stubGlobal(
      'fetch',
      telegramFailure(400, { ok: false, description: 'Bad Request: chat not found' })
    );
    const result = await sendTestMessage(baseEnv());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.category).toBe('telegram_error');
      expect(result.message).toContain('chat not found');
    }
  });

  it('categorizes rate limits and mentions the retry window', async () => {
    vi.stubGlobal(
      'fetch',
      telegramFailure(429, {
        ok: false,
        description: 'Too Many Requests',
        parameters: { retry_after: 30 },
      })
    );
    const result = await sendTestMessage(baseEnv());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.category).toBe('rate_limited');
      expect(result.message).toContain('30 ثانیه');
    }
  });

  it('categorizes network failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection reset');
      })
    );
    const result = await sendTestMessage(baseEnv());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.category).toBe('network');
  });

  it('never leaks the token or destination in any result', async () => {
    vi.stubGlobal(
      'fetch',
      telegramFailure(400, { ok: false, description: 'Bad Request: chat not found' })
    );
    const failed = await sendTestMessage(baseEnv());
    expect(JSON.stringify(failed)).not.toContain(BOT_TOKEN);
    expect(JSON.stringify(failed)).not.toContain(DESTINATION);

    const t = telegramOk(1);
    const ok = await sendTestMessage(baseEnv(), { fetchImpl: t.fetchImpl });
    expect(JSON.stringify(ok)).not.toContain(BOT_TOKEN);
    expect(JSON.stringify(ok)).not.toContain(DESTINATION);
  });
});

/* ---------------------------------------------------------- admin rendering */

describe('renderTestMessageResult', () => {
  it('reports success with the destination message id', () => {
    const text = renderTestMessageResult({ ok: true, messageId: 555 });
    expect(text).toContain('✅');
    expect(text).toContain('555');
  });

  it('reports failure with the safe reason', () => {
    const text = renderTestMessageResult({
      ok: false,
      category: 'destination_not_configured',
      message: 'کانال مقصد (TELEGRAM_DESTINATION_CHANNEL) تنظیم نشده است.',
    });
    expect(text).toContain('❌');
    expect(text).toContain('TELEGRAM_DESTINATION_CHANNEL');
  });

  it('adds the channel-admin hint when Telegram rejected the send', () => {
    const text = renderTestMessageResult({
      ok: false,
      category: 'telegram_error',
      message: 'تلگرام پیام را نپذیرفت: Bad Request: chat not found',
    });
    expect(text).toContain('ادمین');
    // No hint for configuration problems — the reason is already exact.
    const config = renderTestMessageResult({
      ok: false,
      category: 'token_missing',
      message: 'توکن ربات (TELEGRAM_BOT_TOKEN) تنظیم نشده است.',
    });
    expect(config).not.toContain('ادمین');
  });
});

/* -------------------------------------------------------- telegram commands */

describe('/test command and msg:test button', () => {
  it('the menu offers the test-message button', () => {
    const buttons = JSON.stringify(menuKeyboard());
    expect(buttons).toContain('پیام آزمایشی');
    expect(buttons).toContain('msg:test');
  });

  it('parses msg:test and rejects unknown msg callbacks', () => {
    expect(parseCallbackData('msg:test')).toEqual({ action: 'msg:test', arg: null });
    expect(parseCallbackData('msg:other')).toBeNull();
    expect(parseCallbackData('msg')).toBeNull();
  });

  it('/test sends a test message and reports success to the admin', async () => {
    const t = telegramOk(888);
    vi.stubGlobal('fetch', t.fetchImpl);
    const r = recorder();

    await handleTelegramUpdate(msg(TEST_MESSAGE_COMMAND) as TelegramUpdate, baseEnv(), undefined, r);

    // Exactly one outbound send: the test message to the destination.
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].body.chat_id).toBe(DESTINATION);
    expect(t.calls[0].url).toContain(`/bot${BOT_TOKEN}/sendMessage`);

    // The admin chat receives the success report, not the test text itself.
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0].chatId).toBe('100');
    expect(r.sent[0].text).toContain('✅');
    expect(r.sent[0].text).toContain('888');
  });

  it('/test reports a Telegram failure with the diagnostic hint', async () => {
    vi.stubGlobal(
      'fetch',
      telegramFailure(403, {
        ok: false,
        description: 'Forbidden: bot is not a member of the channel chat',
      })
    );
    const r = recorder();

    await handleTelegramUpdate(msg(TEST_MESSAGE_COMMAND) as TelegramUpdate, baseEnv(), undefined, r);

    expect(r.sent).toHaveLength(1);
    expect(r.sent[0].text).toContain('❌');
    expect(r.sent[0].text).toContain('not a member');
    expect(r.sent[0].text).toContain('ادمین');
  });

  it('/test is refused for non-admins and sends nothing', async () => {
    const t = telegramOk();
    vi.stubGlobal('fetch', t.fetchImpl);
    const r = recorder();

    await handleTelegramUpdate(
      msg(TEST_MESSAGE_COMMAND, OTHER_ID) as TelegramUpdate,
      baseEnv(),
      undefined,
      r
    );

    expect(r.sent[0].text).toBe(UNAUTHORIZED_MESSAGE);
    expect(t.fetchImpl).not.toHaveBeenCalled();
  });

  it('the menu button sends a test message and edits the menu with the result', async () => {
    const t = telegramOk(999);
    vi.stubGlobal('fetch', t.fetchImpl);
    const r = recorder();

    await handleTelegramUpdate(cb('msg:test') as TelegramUpdate, baseEnv(), undefined, r);

    expect(t.calls).toHaveLength(1);
    expect(r.acks[0]).toContain('ارسال');
    expect(r.edited).toHaveLength(1);
    expect(r.edited[0].text).toContain('✅');
    expect(r.edited[0].text).toContain('999');
  });

  it('works while an add-channel conversation is pending (like /cancel)', async () => {
    const t = telegramOk();
    vi.stubGlobal('fetch', t.fetchImpl);
    const r = recorder();

    // Start the add-channel flow, then send /test instead of a channel name.
    await handleTelegramUpdate(cb('ch:add') as TelegramUpdate, baseEnv(), undefined, r);
    await handleTelegramUpdate(msg(TEST_MESSAGE_COMMAND) as TelegramUpdate, baseEnv(), undefined, r);

    // The outbound call went to the destination, not interpreted as a channel.
    expect(t.calls).toHaveLength(1);
    expect(r.sent.at(-1)!.text).toContain('✅');
  });
});

/* ------------------------------------------------------------ API endpoint */

describe('POST /api/telegram/test-message', () => {
  it('requires the admin session', async () => {
    const t = telegramOk();
    vi.stubGlobal('fetch', t.fetchImpl);

    const res = await callEndpoint(baseEnv());
    expect(res.status).toBe(401);
    expect(t.fetchImpl).not.toHaveBeenCalled();
  });

  it('returns 503 with a Persian reason when the destination is not configured', async () => {
    const cookie = await loginCookie(baseEnv({ TELEGRAM_DESTINATION_CHANNEL: '' }));
    const t = telegramOk();
    vi.stubGlobal('fetch', t.fetchImpl);

    const res = await callEndpoint(baseEnv({ TELEGRAM_DESTINATION_CHANNEL: '' }), cookie);
    const body = await res.json<{ error: string }>();

    expect(res.status).toBe(503);
    expect(body.error).toContain('TELEGRAM_DESTINATION_CHANNEL');
    expect(t.fetchImpl).not.toHaveBeenCalled();
  });

  it('delivers for an authenticated admin and never echoes secrets', async () => {
    const cookie = await loginCookie();
    const t = telegramOk(31337);
    vi.stubGlobal('fetch', t.fetchImpl);

    const res = await callEndpoint(baseEnv(), cookie);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain('"messageId":31337');
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].body.chat_id).toBe(DESTINATION);
    expect(body).not.toContain(BOT_TOKEN);
    expect(body).not.toContain(DESTINATION);
    expect(body).not.toContain(PASSWORD);
  });

  it('maps a Telegram rejection to 502 with the safe reason', async () => {
    const cookie = await loginCookie();
    vi.stubGlobal(
      'fetch',
      telegramFailure(400, { ok: false, description: 'Bad Request: chat not found' })
    );

    const res = await callEndpoint(baseEnv(), cookie);
    const body = await res.json<{ error: string }>();

    expect(res.status).toBe(502);
    expect(body.error).toContain('chat not found');
  });

  it('maps a rate limit to 429', async () => {
    const cookie = await loginCookie();
    vi.stubGlobal(
      'fetch',
      telegramFailure(429, {
        ok: false,
        description: 'Too Many Requests',
        parameters: { retry_after: 42 },
      })
    );

    const res = await callEndpoint(baseEnv(), cookie);
    expect(res.status).toBe(429);
  });

  it('is not reachable with a session minted for a different password', async () => {
    // A cookie minted for one password must not unlock another (HMAC keyed by it).
    const otherEnv = baseEnv({ ADMIN_PASSWORD: 'other-password' });
    const cookie = await loginCookie(otherEnv, 'other-password');
    const res = await callEndpoint(baseEnv(), cookie);
    expect(res.status).toBe(401);
  });
});

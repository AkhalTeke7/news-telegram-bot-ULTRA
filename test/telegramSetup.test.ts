import { env, createExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApi } from '../src/api';
import {
  ALLOWED_UPDATES,
  isProductionHost,
  PRODUCTION_HOST,
  registerTelegramWebhook,
  WEBHOOK_URL,
} from '../src/telegramSetup';
import type { Env } from '../src/types';

const PASSWORD = 'test-admin-password';
const BOT_TOKEN = 'unit-test-bot-token';
const WEBHOOK_SECRET = 'unit-test-webhook-secret';

const baseEnv = (over: Partial<Env> = {}): Env =>
  ({
    DB: env.DB,
    ADMIN_PASSWORD: PASSWORD,
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ...over,
  }) as Env;

/** Captures the outbound setWebhook request without any real network call. */
function telegramOk() {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

async function loginCookie(): Promise<string> {
  const res = await createApi().fetch(
    new Request('https://worker.test/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    }),
    baseEnv(),
    createExecutionContext()
  );
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie')!.split(';')[0];
}

async function callSetup(cookie?: string, host = PRODUCTION_HOST) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (cookie) headers.set('cookie', cookie);
  return createApi().fetch(
    new Request(`https://${host}/api/telegram/setup-webhook`, { method: 'POST', headers }),
    baseEnv(),
    createExecutionContext()
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('production host guard', () => {
  it('accepts only the production hostname', () => {
    expect(isProductionHost(PRODUCTION_HOST)).toBe(true);
    expect(isProductionHost(PRODUCTION_HOST.toUpperCase())).toBe(true);
    expect(isProductionHost('127.0.0.1')).toBe(false);
    expect(isProductionHost('localhost')).toBe(false);
    expect(isProductionHost(`${PRODUCTION_HOST}.evil.example`)).toBe(false);
  });
});

describe('registerTelegramWebhook', () => {
  it('sends exactly the required url, secret_token and allowed_updates', async () => {
    const t = telegramOk();
    const outcome = await registerTelegramWebhook(baseEnv(), { fetchImpl: t.fetchImpl, baseUrl: 'https://api.test' });

    expect(outcome.status).toBe(200);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].url).toBe(`https://api.test/bot${BOT_TOKEN}/setWebhook`);
    expect(t.calls[0].body).toEqual({
      url: WEBHOOK_URL,
      secret_token: WEBHOOK_SECRET,
      allowed_updates: JSON.stringify(ALLOWED_UPDATES),
    });
    expect(WEBHOOK_URL).toBe(
      `https://news-telegram-bot.m-abner-9907.workers.dev/api/telegram/webhook`
    );
    expect(JSON.parse(String(t.calls[0].body.allowed_updates))).toEqual(['message', 'callback_query']);
  });

  it('never returns the token or the secret', async () => {
    const t = telegramOk();
    const outcome = await registerTelegramWebhook(baseEnv(), { fetchImpl: t.fetchImpl, baseUrl: 'https://api.test' });
    const body = JSON.stringify(outcome.body);
    expect(body).not.toContain(BOT_TOKEN);
    expect(body).not.toContain(WEBHOOK_SECRET);
    expect(body).toContain(WEBHOOK_URL);
  });

  it('reports a missing secret without calling Telegram', async () => {
    const t = telegramOk();
    const outcome = await registerTelegramWebhook(
      baseEnv({ TELEGRAM_WEBHOOK_SECRET: undefined }),
      { fetchImpl: t.fetchImpl }
    );
    expect(outcome.status).toBe(503);
    expect(t.fetchImpl).not.toHaveBeenCalled();
  });

  it('reports a missing bot token without calling Telegram', async () => {
    const t = telegramOk();
    const outcome = await registerTelegramWebhook(baseEnv({ TELEGRAM_BOT_TOKEN: undefined }), {
      fetchImpl: t.fetchImpl,
    });
    expect(outcome.status).toBe(503);
    expect(t.fetchImpl).not.toHaveBeenCalled();
  });

  it('surfaces a Telegram error safely', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }), { status: 400 })
    ) as unknown as typeof fetch;

    const outcome = await registerTelegramWebhook(baseEnv(), { fetchImpl, baseUrl: 'https://api.test' });
    expect(outcome.status).toBe(502);
    if (outcome.status === 502) {
      expect(outcome.body.category).toBe('telegram_error');
      expect(outcome.body.error).toContain('chat not found');
      expect(JSON.stringify(outcome.body)).not.toContain(BOT_TOKEN);
      expect(JSON.stringify(outcome.body)).not.toContain(WEBHOOK_SECRET);
    }
  });

  it('treats a timeout or network failure as a Telegram error', async () => {
    const boom = vi.fn(async () => {
      throw new Error('socket hang up');
    }) as unknown as typeof fetch;

    const outcome = await registerTelegramWebhook(baseEnv(), { fetchImpl: boom, baseUrl: 'https://api.test' });
    expect(outcome.status).toBe(502);
    expect(JSON.stringify(outcome.body)).not.toContain(BOT_TOKEN);
    expect(JSON.stringify(outcome.body)).not.toContain(WEBHOOK_SECRET);
  });

  it('sends an abort signal so the outbound call is bounded', async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_u: unknown, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }) as unknown as typeof fetch;

    await registerTelegramWebhook(baseEnv(), { fetchImpl, baseUrl: 'https://api.test' });
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});

describe('POST /api/telegram/setup-webhook', () => {
  it('rejects an unauthenticated request', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const res = await callSetup();
    expect(res.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects a request that is not on the production host', async () => {
    const cookie = await loginCookie();
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);

    const res = await callSetup(cookie, '127.0.0.1');
    expect(res.status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it('registers the webhook for an authenticated production-host request', async () => {
    const cookie = await loginCookie();
    const t = telegramOk();
    vi.stubGlobal('fetch', t.fetchImpl);

    const res = await callSetup(cookie);
    const body = await res.json<Record<string, unknown>>();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      registered: true,
      webhookUrl: WEBHOOK_URL,
      allowedUpdates: ALLOWED_UPDATES,
    });
    expect(t.calls[0].body.url).toBe(WEBHOOK_URL);
    expect(JSON.stringify(body)).not.toContain(BOT_TOKEN);
    expect(JSON.stringify(body)).not.toContain(WEBHOOK_SECRET);
    expect(JSON.stringify(body)).not.toContain(PASSWORD);
  });

  it('reports a Telegram failure as 502 without leaking secrets', async () => {
    const cookie = await loginCookie();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: false, description: 'Bad Request' }), { status: 400 })
      )
    );

    const res = await callSetup(cookie);
    const body = await res.text();

    expect(res.status).toBe(502);
    expect(body).not.toContain(BOT_TOKEN);
    expect(body).not.toContain(WEBHOOK_SECRET);
  });

  it('does not disturb the existing telegram webhook route', async () => {
    // The public webhook route must keep answering with its own secret header.
    const secret = 'unit-test-webhook-secret-value-1234';
    const res = await createApi().fetch(
      new Request('https://worker.test/api/telegram/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-telegram-bot-api-secret-token': secret,
        },
        body: JSON.stringify({ update_id: 1 }),
      }),
      baseEnv({ TELEGRAM_WEBHOOK_SECRET: secret })
    );
    expect(res.status).toBe(200);
  });
});
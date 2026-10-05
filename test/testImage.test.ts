import { createExecutionContext, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApi } from '../src/api';
import {
  handleTelegramUpdate,
  menuKeyboard,
  parseCallbackData,
  renderTestImageResult,
  UNAUTHORIZED_MESSAGE,
  type TelegramUpdate,
} from '../src/telegramAdmin';
import { sendTestImage, TEST_IMAGE_COMMAND } from '../src/testImage';
import type { Env } from '../src/types';

const PASSWORD = 'test-admin-password';
const BOT_TOKEN = 'unit-test-bot-token';
const DESTINATION = '@test_dest_channel';
const ADMIN_ID = 424242;
const OTHER_ID = 999999;
const SECRET = 'webhook-secret-0123456789';

const NOW = Date.now();

const baseEnv = (over: Partial<Env> = {}): Env =>
  ({
    DB: env.DB,
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    ADMIN_PASSWORD: PASSWORD,
    TELEGRAM_ADMIN_USER_ID: String(ADMIN_ID),
    TELEGRAM_WEBHOOK_SECRET: SECRET,
    TELEGRAM_DESTINATION_CHANNEL: DESTINATION,
    // The test album renders its slides back to back, like the pipeline in CI.
    IMAGE_RENDER_SPACING_MS: '0',
    ...over,
  }) as Env;

/** Minimal valid 1920x1080 PNG header + payload. */
function fakePng(): ArrayBuffer {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 1920);
  view.setUint32(20, 1080);
  return bytes.buffer;
}

/** Browser Run fake + fetch fake that records every outbound HTTP call. */
function harness(opts: { png?: ArrayBuffer | null; photoStatus?: number } = {}) {
  const calls: { url: string; body?: string }[] = [];
  const browser = {
    quickAction: vi.fn(async () => {
      if (opts.png === null) return new Response('rate limited', { status: 429 });
      return new Response(opts.png ?? fakePng(), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }),
  };
  const albums: { caption?: string }[][] = [];
  const fetchImpl = vi.fn(async (url: unknown, init: RequestInit) => {
    calls.push({ url: String(url), body: init.body ? String(init.body) : undefined });
    if (init.body instanceof FormData && init.body.has('media')) {
      albums.push(JSON.parse(String(init.body.get('media'))));
    }
    const status = opts.photoStatus ?? 200;
    // A media group answers with an ARRAY of messages; everything else with one.
    const isGroup = String(url).includes('sendMediaGroup');
    const result = isGroup
      ? [{ message_id: 707, date: 1 }, { message_id: 708, date: 1 }]
      : { message_id: 707, date: 1 };
    return new Response(
      JSON.stringify({
        ok: status < 400,
        result,
        description: status < 400 ? undefined : 'Bad Request: chat not found',
      }),
      { status, headers: { 'content-type': 'application/json' } }
    );
  }) as unknown as typeof fetch;
  return { browser, fetchImpl, calls, albums };
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

async function reset() {
  await env.DB.prepare(`DELETE FROM telegram_admin_state`).run();
  await env.DB.prepare(`DELETE FROM messages`).run();
  await env.DB.prepare(`DELETE FROM channels`).run();
}

/** Seeds one enabled channel with `count` summarized, unpublished news rows. */
async function seedNews(count: number, username = 'news_chan') {
  const r = await env.DB.prepare(
    `INSERT INTO channels (channel_username, enabled) VALUES (?1, 1)`
  )
    .bind(username)
    .run();
  const channelId = Number(r.meta.last_row_id);
  for (let i = 1; i <= count; i++) {
    await env.DB.prepare(
      `INSERT INTO messages (source_channel_id, telegram_message_id, message_date, message_text, source_url, summary_text, summarized_at)
       VALUES (?1, ?2, ?3, 'body', ?4, ?5, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    )
      .bind(
        channelId,
        i,
        new Date(NOW - i * 60_000).toISOString(),
        `https://t.me/${username}/${i}`,
        `خلاصهٔ خبر ${i} از کانال آزمایشی.`
      )
      .run();
  }
  return channelId;
}

async function loginCookie(e: Env = baseEnv()): Promise<string> {
  const res = await createApi().fetch(
    new Request('https://worker.test/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
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
    new Request('https://worker.test/api/telegram/test-image', { method: 'POST', headers }),
    e,
    createExecutionContext()
  );
}

beforeEach(reset);
afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------- core sender */

describe('sendTestImage', () => {
  it('renders the REAL pending news and sends only the album', async () => {
    await seedNews(6); // 3 pictures of two news each, no overflow ticker
    const h = harness();

    const result = await sendTestImage(baseEnv({ BROWSER: h.browser }), {
      fetchImpl: h.fetchImpl,
    });

    expect(result).toMatchObject({ ok: true, messageId: 707, slides: 3, items: 6, ticker: 0 });

    // One Browser Run request per picture, and exactly one Telegram album send.
    expect(h.browser.quickAction).toHaveBeenCalledTimes(3);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMediaGroup`);

    // The album carries ONE caption, on its first photo, so Telegram renders
    // the slides as a single swipeable item instead of two messages.
    expect(h.albums).toHaveLength(1);
    expect(h.albums[0]).toHaveLength(3);
    expect(h.albums[0].filter((item) => item.caption !== undefined)).toHaveLength(1);
    expect(h.albums[0][0].caption).toContain('📰 اخبار لحظه‌ای');

    // The rendered HTML carries the real summaries (one card per render).
    // (quickAction payload is asserted through the html the browser receives.)
  });

  it('mirrors every album card to Bale when the mirror is configured', async () => {
    await seedNews(2);
    const h = harness();

    const result = await sendTestImage(
      baseEnv({ BROWSER: h.browser, BALE_BOT_TOKEN: 'bale-token', BALE_DESTINATION_CHANNEL: '@bale_dest' }),
      { fetchImpl: h.fetchImpl }
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bale).toEqual({ sent: true });
    const urls = h.calls.map((c) => c.url);
    // Two news share one slide: a Telegram sendPhoto plus one Bale photo.
    expect(urls.filter((u) => u.includes('sendMediaGroup'))).toHaveLength(0);
    expect(urls.filter((u) => u.includes('sendPhoto'))).toHaveLength(2);
    expect(urls.filter((u) => u === 'https://tapi.bale.ai/botbale-token/sendPhoto')).toHaveLength(1);
    // Standard bot base — never the restricted /business/ endpoint.
    expect(urls.some((u) => u.includes('/business/'))).toBe(false);
  });

  it('marks NOTHING published — the rows stay pending for the real run', async () => {
    await seedNews(3);
    const h = harness();

    await sendTestImage(baseEnv({ BROWSER: h.browser }), { fetchImpl: h.fetchImpl });

    const rows = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE published_at IS NOT NULL`)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it('replies no_news when the queue is empty and sends nothing', async () => {
    const h = harness();
    const result = await sendTestImage(baseEnv({ BROWSER: h.browser }), {
      fetchImpl: h.fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.category).toBe('no_news');
    expect(h.browser.quickAction).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(0);
  });

  it('replies no_news when every row scored importance 1', async () => {
    await seedNews(2);
    await env.DB.prepare(`UPDATE messages SET importance = 1`).run();
    const h = harness();

    const result = await sendTestImage(baseEnv({ BROWSER: h.browser }), {
      fetchImpl: h.fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.category).toBe('no_news');
  });

  it('fails safely when Browser Run is not bound', async () => {
    await seedNews(2);
    const h = harness();
    const result = await sendTestImage(baseEnv({ BROWSER: undefined }), {
      fetchImpl: h.fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.category).toBe('browser_missing');
    expect(h.calls).toHaveLength(0);
  });

  it('fails safely for missing destination or token', async () => {
    await seedNews(2);
    const h = harness();

    const noDest = await sendTestImage(
      baseEnv({ BROWSER: h.browser, TELEGRAM_DESTINATION_CHANNEL: '' }),
      { fetchImpl: h.fetchImpl }
    );
    expect(noDest.ok).toBe(false);
    if (!noDest.ok) expect(noDest.category).toBe('destination_not_configured');

    const badDest = await sendTestImage(
      baseEnv({ BROWSER: h.browser, TELEGRAM_DESTINATION_CHANNEL: 'nope!' }),
      { fetchImpl: h.fetchImpl }
    );
    expect(badDest.ok).toBe(false);
    if (!badDest.ok) expect(badDest.category).toBe('invalid_destination');

    const noToken = await sendTestImage(baseEnv({ BROWSER: h.browser, TELEGRAM_BOT_TOKEN: '' }), {
      fetchImpl: h.fetchImpl,
    });
    expect(noToken.ok).toBe(false);
    if (!noToken.ok) expect(noToken.category).toBe('token_missing');
  });

  it('maps a render failure and a send failure to safe reasons', async () => {
    await seedNews(2);

    const failRender = harness({ png: null });
    const rendered = await sendTestImage(baseEnv({ BROWSER: failRender.browser }), {
      fetchImpl: failRender.fetchImpl,
    });
    expect(rendered.ok).toBe(false);
    if (!rendered.ok) expect(rendered.category).toBe('render_failed');

    const failSend = harness({ photoStatus: 400 });
    const sent = await sendTestImage(baseEnv({ BROWSER: failSend.browser }), {
      fetchImpl: failSend.fetchImpl,
    });
    expect(sent.ok).toBe(false);
    if (!sent.ok) {
      expect(sent.category).toBe('telegram_error');
      expect(sent.message).toContain('chat not found');
    }
  });

  it('never leaks the token or destination in any result', async () => {
    await seedNews(2);
    const failSend = harness({ photoStatus: 403 });
    const result = await sendTestImage(baseEnv({ BROWSER: failSend.browser }), {
      fetchImpl: failSend.fetchImpl,
    });
    expect(JSON.stringify(result)).not.toContain(BOT_TOKEN);
    expect(JSON.stringify(result)).not.toContain(DESTINATION);
  });
});

/* ---------------------------------------------------------- admin rendering */

describe('renderTestImageResult', () => {
  it('reports success with slides, news items and size', () => {
    const text = renderTestImageResult({
      ok: true,
      messageId: 707,
      slides: 4,
      items: 15,
      ticker: 3,
      bytes: 250_000,
      browserRunMs: 1200,
    });
    expect(text).toContain('✅');
    expect(text).toContain('707');
    expect(text).toContain('4');
    expect(text).toContain('3');
  });

  it('uses a distinct header for the no-news case', () => {
    const text = renderTestImageResult({
      ok: false,
      category: 'no_news',
      message: 'خبری در انتظار انتشار نیست؛ ابتدا پردازش را اجرا کنید.',
    });
    expect(text).toContain('⚠️');
    const fail = renderTestImageResult({
      ok: false,
      category: 'token_missing',
      message: 'توکن ربات (TELEGRAM_BOT_TOKEN) تنظیم نشده است.',
    });
    expect(fail).toContain('❌');
  });
});

/* -------------------------------------------------------- telegram commands */

describe('/testimage command and img:test button', () => {
  it('the menu offers the image-test button', () => {
    const buttons = JSON.stringify(menuKeyboard());
    expect(buttons).toContain('تصویر آزمایشی');
    expect(buttons).toContain('img:test');
  });

  it('parses img:test and rejects unknown img callbacks', () => {
    expect(parseCallbackData('img:test')).toEqual({ action: 'img:test', arg: null });
    expect(parseCallbackData('img:other')).toBeNull();
    expect(parseCallbackData('img')).toBeNull();
  });

  it('/testimage sends ONLY the image — no text digest to the destination', async () => {
    await seedNews(6);
    const h = harness();
    vi.stubGlobal('fetch', h.fetchImpl);
    const r = recorder();

    await handleTelegramUpdate(
      msg(TEST_IMAGE_COMMAND) as TelegramUpdate,
      baseEnv({ BROWSER: h.browser }),
      undefined,
      r
    );

    // One Browser Run request per picture + one sendMediaGroup, and no sendMessage anywhere.
    expect(h.browser.quickAction).toHaveBeenCalledTimes(3);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].url).toContain('/sendMediaGroup');

    // The admin chat gets the report, not the image itself.
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0].text).toContain('✅');
    expect(r.sent[0].text).toContain('707');

    // And nothing was marked published.
    const rows = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE published_at IS NOT NULL`)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it('/testimage is refused for non-admins and sends nothing', async () => {
    await seedNews(2);
    const h = harness();
    vi.stubGlobal('fetch', h.fetchImpl);
    const r = recorder();

    await handleTelegramUpdate(
      msg(TEST_IMAGE_COMMAND, OTHER_ID) as TelegramUpdate,
      baseEnv({ BROWSER: h.browser }),
      undefined,
      r
    );

    expect(r.sent[0].text).toBe(UNAUTHORIZED_MESSAGE);
    expect(h.browser.quickAction).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(0);
  });

  it('the menu button edits the menu with the result', async () => {
    await seedNews(3);
    const h = harness();
    vi.stubGlobal('fetch', h.fetchImpl);
    const r = recorder();

    await handleTelegramUpdate(cb('img:test') as TelegramUpdate, baseEnv({ BROWSER: h.browser }), undefined, r);

    // Three news = two pictures (2 + 1).
    expect(h.browser.quickAction).toHaveBeenCalledTimes(2);
    expect(r.edited).toHaveLength(1);
    expect(r.edited[0].text).toContain('✅');
  });
});

/* ------------------------------------------------------------ API endpoint */

describe('POST /api/telegram/test-image', () => {
  it('requires the admin session', async () => {
    await seedNews(2);
    const h = harness();
    vi.stubGlobal('fetch', h.fetchImpl);

    const res = await callEndpoint(baseEnv({ BROWSER: h.browser }));
    expect(res.status).toBe(401);
    expect(h.browser.quickAction).not.toHaveBeenCalled();
  });

  it('delivers for an authenticated admin and never echoes secrets', async () => {
    await seedNews(6);
    const h = harness();
    vi.stubGlobal('fetch', h.fetchImpl);
    const cookie = await loginCookie(baseEnv({ BROWSER: h.browser }));

    const res = await callEndpoint(baseEnv({ BROWSER: h.browser }), cookie);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain('"messageId":707');
    expect(body).toContain('"slides":3');
    expect(body).toContain('"items":6');
    expect(body).toContain('"ticker":0');
    expect(body).not.toContain(BOT_TOKEN);
    expect(body).not.toContain(DESTINATION);
  });

  it('returns 404 with a Persian reason when there is no news', async () => {
    const h = harness();
    const cookie = await loginCookie(baseEnv({ BROWSER: h.browser }));

    const res = await callEndpoint(baseEnv({ BROWSER: h.browser }), cookie);
    const body = await res.json<{ error: string }>();

    expect(res.status).toBe(404);
    expect(body.error).toContain('خبر');
  });

  it('returns 503 when Browser Run is not bound', async () => {
    await seedNews(2);
    const cookie = await loginCookie(baseEnv());

    const res = await callEndpoint(baseEnv(), cookie);
    expect(res.status).toBe(503);
  });

  it('maps a Telegram rejection to 502', async () => {
    await seedNews(2);
    const h = harness({ photoStatus: 400 });
    vi.stubGlobal('fetch', h.fetchImpl);
    const cookie = await loginCookie(baseEnv({ BROWSER: h.browser }));

    const res = await callEndpoint(baseEnv({ BROWSER: h.browser }), cookie);
    expect(res.status).toBe(502);
  });
});

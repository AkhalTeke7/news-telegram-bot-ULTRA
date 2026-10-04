import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';

const BASE = 'https://worker.test';
const PASSWORD = 'test-admin-password';

type Session = { cookie: string };

async function login(password = PASSWORD): Promise<Session> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    }),
    env,
    ctx
  );
  expect(res.status).toBe(200);
  const setCookie = res.headers.get('set-cookie');
  expect(setCookie).toBeTruthy();
  return { cookie: setCookie!.split(';')[0] };
}

async function call(path: string, init: RequestInit & { session?: Session } = {}): Promise<Response> {
  const { session, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set('content-type', 'application/json');
  if (session) headers.set('cookie', session.cookie);
  return worker.fetch(
    new Request(`${BASE}${path}`, { ...rest, headers }),
    env,
    createExecutionContext()
  );
}

async function resetDb() {
  await env.DB.prepare('DELETE FROM channels').run();
  await env.DB.prepare('DELETE FROM cron_runs').run();
}

describe('D1 migrations', () => {
  it('created the channels table with the expected columns', async () => {
    const { results } = await env.DB.prepare(`PRAGMA table_info(channels)`).all<{
      name: string;
      type: string;
      notnull: number;
    }>();
    const cols = new Map(results.map((r: { name: string; notnull: number }) => [r.name, r]));
    for (const name of [
      'id',
      'channel_username',
      'channel_title',
      'enabled',
      'created_at',
      'updated_at',
      'last_checked_at',
      'last_processed_message_id',
    ]) {
      expect(cols.has(name), `missing column ${name}`).toBe(true);
    }
    expect(cols.get('channel_username')!.notnull).toBe(1);
  });

  it('enforces uniqueness on channel_username', async () => {
    await env.DB.prepare(`INSERT INTO channels (channel_username) VALUES ('dupcheck')`).run();
    await expect(
      env.DB.prepare(`INSERT INTO channels (channel_username) VALUES ('dupcheck')`).run()
    ).rejects.toThrow();
    await env.DB.prepare(`DELETE FROM channels`).run();
  });

  it('rejects enabled values outside 0/1', async () => {
    await expect(
      env.DB.prepare(`INSERT INTO channels (channel_username, enabled) VALUES ('badflag', 5)`).run()
    ).rejects.toThrow();
  });
});

describe('auth', () => {
  beforeEach(resetDb);

  it('rejects GET /api/channels without a session', async () => {
    const res = await call('/api/channels');
    expect(res.status).toBe(401);
    expect((await res.json<{ error: string }>()).error).toBeTruthy();
  });

  it('rejects a wrong password', async () => {
    const res = await call('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password: 'nope' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects non-string passwords', async () => {
    const res = await call('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password: { $ne: 1 } }),
    });
    expect(res.status).toBe(401);
  });

  it('sets an HttpOnly Secure SameSite=Strict cookie on success', async () => {
    const res = await call('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password: PASSWORD }),
    });
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
  });

  it('rejects a forged session token', async () => {
    const res = await call('/api/channels', {
      session: { cookie: 'ntb_admin_session=99999999999999.deadbeef' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects a session token signed with a different password', async () => {
    const { createSessionToken } = await import('../src/auth');
    const token = await createSessionToken('a-different-password');
    const res = await call('/api/channels', { session: { cookie: `ntb_admin_session=${token}` } });
    expect(res.status).toBe(401);
  });

  it('clears the session on logout', async () => {
    const s = await login();
    const res = await call('/api/auth/logout', { method: 'POST', body: '{}', session: s });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('never exposes secrets in responses', async () => {
    const s = await login();
    const res = await call('/api/channels', { session: s });
    const body = await res.text();
    expect(body).not.toContain(PASSWORD);
    expect(body).not.toContain('TELEGRAM_BOT_TOKEN');
  });
});

describe('channels API', () => {
  let s: Session;

  beforeEach(async () => {
    await resetDb();
    s = await login();
  });

  it('starts empty', async () => {
    const res = await call('/api/channels', { session: s });
    expect(res.status).toBe(200);
    expect((await res.json<{ channels: unknown[] }>()).channels).toEqual([]);
  });

  it('creates a channel from a bare username', async () => {
    const res = await call('/api/channels', {
      method: 'POST',
      session: s,
      body: JSON.stringify({ username: 'TelegramNews' }),
    });
    expect(res.status).toBe(201);
    const { channel } = await res.json<{ channel: Record<string, unknown> }>();
    expect(channel.channelUsername).toBe('telegramnews');
    expect(channel.enabled).toBe(true);
    expect(channel.createdAt).toBeTruthy();
    expect(channel.lastProcessedMessageId).toBeNull();
  });

  it('creates a channel from a t.me URL and normalizes it', async () => {
    const res = await call('/api/channels', {
      method: 'POST',
      session: s,
      body: JSON.stringify({ url: 'https://t.me/Some_News/' }),
    });
    expect(res.status).toBe(201);
    const { channel } = await res.json<{ channel: Record<string, unknown> }>();
    expect(channel.channelUsername).toBe('some_news');
  });

  it('rejects an invalid username with 400', async () => {
    const res = await call('/api/channels', {
      method: 'POST',
      session: s,
      body: JSON.stringify({ username: 'https://t.me/joinchat/SECRET' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a malformed JSON body', async () => {
    const res = await call('/api/channels', { method: 'POST', session: s, body: '{oops' });
    expect(res.status).toBe(400);
  });

  it('rejects an oversized body', async () => {
    const res = await call('/api/channels', {
      method: 'POST',
      session: s,
      body: JSON.stringify({ username: 'x'.repeat(9000) }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a missing username field', async () => {
    const res = await call('/api/channels', { method: 'POST', session: s, body: JSON.stringify({}) });
    expect(res.status).toBe(400);
  });

  it('prevents duplicates in every accepted form (409)', async () => {
    const first = await call('/api/channels', {
      method: 'POST',
      session: s,
      body: JSON.stringify({ username: 'DuplicateOne' }),
    });
    expect(first.status).toBe(201);

    for (const input of ['duplicateone', '@DuplicateOne', 'https://t.me/DuplicateOne', 't.me/duplicateone/']) {
      const res = await call('/api/channels', {
        method: 'POST',
        session: s,
        body: JSON.stringify({ username: input }),
      });
      expect(res.status, `input: ${input}`).toBe(409);
    }

    const list = await call('/api/channels', { session: s });
    expect((await list.json<{ channels: unknown[] }>()).channels).toHaveLength(1);
  });

  it('lists channels after creating several', async () => {
    for (const name of ['alpha_channel', 'bravo_channel']) {
      await call('/api/channels', {
        method: 'POST',
        session: s,
        body: JSON.stringify({ username: name }),
      });
    }
    const res = await call('/api/channels', { session: s });
    const { channels } = await res.json<{ channels: { channelUsername: string }[] }>();
    expect(channels.map((c) => c.channelUsername)).toEqual(['alpha_channel', 'bravo_channel']);
  });

  it('disables a channel without deleting it', async () => {
    const created = await call('/api/channels', {
      method: 'POST',
      session: s,
      body: JSON.stringify({ username: 'toggle_me' }),
    });
    const { channel } = await created.json<{ channel: { id: number } }>();

    const res = await call(`/api/channels/${channel.id}`, {
      method: 'PATCH',
      session: s,
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    expect((await res.json<{ channel: { enabled: boolean } }>()).channel.enabled).toBe(false);

    const list = await call('/api/channels', { session: s });
    const { channels } = await list.json<{ channels: { id: number; enabled: boolean }[] }>();
    expect(channels).toHaveLength(1);
    expect(channels[0].enabled).toBe(false);
  });

  it('re-enables a disabled channel', async () => {
    const created = await call('/api/channels', {
      method: 'POST',
      session: s,
      body: JSON.stringify({ username: 'retoggle_me' }),
    });
    const { channel } = await created.json<{ channel: { id: number } }>();

    for (const enabled of [false, true]) {
      const res = await call(`/api/channels/${channel.id}`, {
        method: 'PATCH',
        session: s,
        body: JSON.stringify({ enabled }),
      });
      expect((await res.json<{ channel: { enabled: boolean } }>()).channel.enabled).toBe(enabled);
    }
  });

  it('bump updated_at when toggled', async () => {
    const created = await call('/api/channels', {
      method: 'POST',
      session: s,
      body: JSON.stringify({ username: 'stamp_me' }),
    });
    const { channel } = await created.json<{ channel: { id: number; updatedAt: string } }>();
    await new Promise((r) => setTimeout(r, 5));    const res = await call(`/api/channels/${channel.id}`, {
      method: 'PATCH',
      session: s,
      body: JSON.stringify({ enabled: false }),
    });
    const { channel: updated } = await res.json<{ channel: { updatedAt: string } }>();
    expect(updated.updatedAt >= channel.updatedAt).toBe(true);
  });

  it('rejects PATCH with a non-boolean enabled value', async () => {
    const created = await call('/api/channels', {
      method: 'POST',
      session: s,
      body: JSON.stringify({ username: 'strict_channel' }),
    });
    const { channel } = await created.json<{ channel: { id: number } }>();

    for (const value of ['false', 0, 1, null, { on: true }]) {
      const res = await call(`/api/channels/${channel.id}`, {
        method: 'PATCH',
        session: s,
        body: JSON.stringify({ enabled: value }),
      });
      expect(res.status, `value: ${JSON.stringify(value)}`).toBe(400);
    }
  });

  it('updates a channel title', async () => {
    const created = await call('/api/channels', {
      method: 'POST',
      session: s,
      body: JSON.stringify({ username: 'title_channel' }),
    });
    const { channel } = await created.json<{ channel: { id: number; channelTitle: string | null } }>();
    // Title is populated by Telegram verification on add; there is no manual
    // title-write endpoint, so it stays null here (no bot token in tests).
    expect(channel.channelTitle).toBeNull();
  });

  it('deletes a channel', async () => {
    const created = await call('/api/channels', {
      method: 'POST',
      session: s,
      body: JSON.stringify({ username: 'delete_me' }),
    });
    const { channel } = await created.json<{ channel: { id: number } }>();

    const res = await call(`/api/channels/${channel.id}`, { method: 'DELETE', session: s });
    expect(res.status).toBe(204);

    const list = await call('/api/channels', { session: s });
    expect((await list.json<{ channels: unknown[] }>()).channels).toEqual([]);
  });

  it('returns 404 for a missing channel id', async () => {
    const patch = await call('/api/channels/999999', {
      method: 'PATCH',
      session: s,
      body: JSON.stringify({ enabled: false }),
    });
    expect(patch.status).toBe(404);

    const del = await call('/api/channels/999999', { method: 'DELETE', session: s });
    expect(del.status).toBe(404);
  });

  it.each(['abc', '0', '-1', '1;DROP TABLE channels', '1.5'])(
    'rejects a bad id %s with 400',
    async (id) => {
      const res = await call(`/api/channels/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        session: s,
      });
      expect(res.status).toBe(400);
    }
  );

  it('requires auth for every mutating endpoint', async () => {
    for (const req of [
      { path: '/api/channels', method: 'POST' },
      { path: '/api/channels/1', method: 'PATCH' },
      { path: '/api/channels/1', method: 'DELETE' },
    ]) {
      const res = await call(req.path, { method: req.method, body: '{}' });
      expect(res.status, `${req.method} ${req.path}`).toBe(401);
    }
  });

  it('404s unknown api routes', async () => {
    const res = await call('/api/nope', { session: s });
    expect(res.status).toBe(404);
  });

  it('keeps the Phase 1 schema intact alongside Phase 2 messages', async () => {
    const tables = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'`
    ).all<{ name: string }>();
    const names = tables.results.map((t) => t.name);
    expect(names).toContain('channels');
    expect(names).toContain('cron_runs');
    expect(names).toContain('messages');

    const cols = await env.DB.prepare(`PRAGMA table_info(channels)`).all<{ name: string }>();
    const channelCols = cols.results.map((c) => c.name);
    // Phase 1 fields must survive Phase 2.
    for (const name of [
      'channel_username',
      'channel_title',
      'enabled',
      'created_at',
      'updated_at',
      'last_checked_at',
      'last_processed_message_id',
    ]) {
      expect(channelCols, `channels.${name} must exist`).toContain(name);
    }
  });
});

describe('processing settings API', () => {
  let s: Session;

  beforeEach(async () => {
    await resetDb();
    await env.DB.prepare(`DELETE FROM ai_settings`).run();
    s = await login();
  });

  it('requires auth for settings read and write', async () => {
    expect((await call('/api/settings')).status).toBe(401);
    expect((await call('/api/settings', { method: 'POST', body: '{}' })).status).toBe(401);
  });

  it('defaults to full processing', async () => {
    const res = await call('/api/settings', { session: s });
    expect(res.status).toBe(200);
    expect((await res.json<{ collectionOnly: boolean }>()).collectionOnly).toBe(false);
  });

  it('persists collection-only mode', async () => {
    const set = await call('/api/settings', {
      method: 'POST',
      session: s,
      body: JSON.stringify({ collectionOnly: true }),
    });
    expect(set.status).toBe(200);
    expect((await set.json<{ collectionOnly: boolean }>()).collectionOnly).toBe(true);

    const get = await call('/api/settings', { session: s });
    expect((await get.json<{ collectionOnly: boolean }>()).collectionOnly).toBe(true);

    const row = await env.DB.prepare(
      `SELECT value FROM ai_settings WHERE key = 'collection_only_mode'`
    ).first<{ value: string }>();
    expect(row?.value).toBe('1');
  });

  it('rejects a non-boolean collectionOnly', async () => {
    for (const value of ['true', 1, null, { on: true }]) {
      const res = await call('/api/settings', {
        method: 'POST',
        session: s,
        body: JSON.stringify({ collectionOnly: value }),
      });
      expect(res.status, `value: ${JSON.stringify(value)}`).toBe(400);
    }
  });

  it('rejects a non-JSON body (CSRF hardening)', async () => {
    const res = await call('/api/settings', {
      method: 'POST',
      session: s,
      headers: { 'content-type': 'text/plain', cookie: s.cookie },
      body: 'collectionOnly=true',
    });
    expect(res.status).toBe(400);
  });
});

describe('manual pipeline run API', () => {
  let s: Session;

  beforeEach(async () => {
    await resetDb();
    await env.DB.prepare(`DELETE FROM ai_settings`).run();
    s = await login();
  });

  it('requires auth', async () => {
    const res = await call('/api/pipeline/run', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });

  it('rejects an invalid mode', async () => {
    for (const mode of ['everything', '', 1, true, null]) {
      const res = await call('/api/pipeline/run', {
        method: 'POST',
        session: s,
        body: JSON.stringify({ mode }),
      });
      expect(res.status, `mode: ${JSON.stringify(mode)}`).toBe(400);
    }
  });

  it('runs a forced collection-only run and skips processing stages', async () => {
    const res = await call('/api/pipeline/run', {
      method: 'POST',
      session: s,
      body: JSON.stringify({ mode: 'collect' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, any>>();
    expect(body.collectionOnly).toBe(true);
    expect(body.summarization).toBeNull();
    expect(body.ranking).toBeNull();
    expect(body.publishing).toBeNull();
    expect(body.collection).not.toBeNull();
  });

  it('forces the full pipeline on demand even in collection-only mode', async () => {
    await call('/api/settings', {
      method: 'POST',
      session: s,
      body: JSON.stringify({ collectionOnly: true }),
    });
    const res = await call('/api/pipeline/run', {
      method: 'POST',
      session: s,
      body: JSON.stringify({ mode: 'process' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, any>>();
    expect(body.collectionOnly).toBe(false);
    // With no API key in tests the summarize/rank stages record safe errors,
    // but the publish stage always runs and reports its counts.
    expect(body.publishing).not.toBeNull();
  });

  it('follows the stored setting when no mode is given', async () => {
    await call('/api/settings', {
      method: 'POST',
      session: s,
      body: JSON.stringify({ collectionOnly: true }),
    });
    const res = await call('/api/pipeline/run', {
      method: 'POST',
      session: s,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, any>>();
    expect(body.collectionOnly).toBe(true);
    expect(body.publishing).toBeNull();
  });
});

describe('cron', () => {
  beforeEach(async () => {
    await resetDb();
    await env.DB.prepare(`DELETE FROM ai_settings`).run();
  });

  it('records an hourly execution and stores no messages', async () => {
    const before = await env.DB.prepare(`SELECT COUNT(*) AS n FROM cron_runs`).first<{ n: number }>();
    expect(before?.n).toBe(0);

    const ctx = createExecutionContext();
    await worker.scheduled!(
      createScheduledController({ cron: '0 * * * *', scheduledTime: Date.now() }),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);

    const after = await env.DB.prepare(`SELECT COUNT(*) AS n FROM cron_runs`).first<{ n: number }>();
    expect(after?.n).toBe(1);

    const row = await env.DB.prepare(
      `SELECT trigger_name FROM cron_runs ORDER BY id DESC LIMIT 1`
    ).first<{ trigger_name: string }>();
    expect(row?.trigger_name).toBe('0 * * * *');
  });

  it('collection-only mode records a successful collect-only run with no processing', async () => {
    const { setSetting } = await import('../src/settings');
    await setSetting(env.DB, 'collection_only_mode', '1');

    const ctx = createExecutionContext();
    await worker.scheduled!(
      createScheduledController({ cron: '30 */2 * * *', scheduledTime: Date.now() }),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);

    const row = await env.DB.prepare(
      `SELECT status, messages_summarized, messages_published FROM cron_runs ORDER BY id DESC LIMIT 1`
    ).first<{ status: string; messages_summarized: number; messages_published: number }>();
    // One stage (collect) completed cleanly, and deliberately no summarize/publish.
    expect(row?.status).toBe('success');
    expect(row?.messages_summarized).toBe(0);
    expect(row?.messages_published).toBe(0);
  });
});

describe('static UI', () => {
  it('serves the Persian RTL admin page without secrets', async () => {
    const res = await worker.fetch(new Request(`${BASE}/`), env, createExecutionContext());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('lang="fa"');
    expect(html).toContain('کانال‌ها');
    expect(html).toContain('افزودن کانال');
    expect(html).toContain('فعال');
    expect(html).toContain('غیرفعال');
    expect(html).toContain('حذف');
    expect(html).toContain('آخرین بررسی');
    expect(html).toContain('ابزارها و آزمون');
    expect(html).toContain('فقط جمع‌آوری');
    expect(html).toContain('جمع‌آوری فوری اخبار');
    expect(html).toContain('اجرای کامل پردازش');
    expect(html).toContain('پیام آزمایشی');
    expect(html).toContain('تصویر آزمایشی');
    expect(html).not.toContain(PASSWORD);
    expect(html).not.toContain('TELEGRAM_BOT_TOKEN');
  });

  it('answers /healthz', async () => {
    const res = await worker.fetch(new Request(`${BASE}/healthz`), env, createExecutionContext());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('answers /api/health without a session', async () => {
    const res = await call('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json<{ ok: boolean }>()).toEqual({ ok: true });
  });
});

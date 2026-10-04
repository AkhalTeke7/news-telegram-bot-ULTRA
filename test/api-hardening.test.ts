import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '../src/api';

const PASSWORD = 'test-admin-password';

async function login(): Promise<string> {
  const res = await createApi().fetch(
    new Request('https://worker.test/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    }),
    env
  );
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie')!.split(';')[0];
}

function req(path: string, init: RequestInit & { cookie?: string } = {}) {
  const { cookie, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (!headers.has('content-type') && rest.body) headers.set('content-type', 'application/json');
  if (cookie) headers.set('cookie', cookie);
  return createApi().fetch(new Request(`https://worker.test${path}`, { ...rest, headers }), env);
}

async function reset() {
  await env.DB.prepare(`DELETE FROM messages`).run();
  await env.DB.prepare(`DELETE FROM channels`).run();
  await env.DB.prepare(`DELETE FROM cron_runs`).run();
  await env.DB.prepare(`DELETE FROM ai_settings`).run();
}

describe('write requests require a JSON content-type', () => {
  let cookie: string;

  beforeEach(async () => {
    await reset();
    cookie = await login();
  });

  it('rejects a JSON body sent as text/plain (CSRF hardening)', async () => {
    const res = await req('/api/channels', {
      method: 'POST',
      cookie,
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ username: 'csrf_channel' }),
    });
    expect(res.status).toBe(400);

    const rows = await env.DB.prepare(`SELECT COUNT(*) AS n FROM channels`).first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it('rejects a JSON body sent as form-urlencoded', async () => {
    const res = await req('/api/channels', {
      method: 'POST',
      cookie,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'username=csrf_channel',
    });
    expect(res.status).toBe(400);
  });

  it('accepts a proper JSON body', async () => {
    const res = await req('/api/channels', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ username: 'good_channel' }),
    });
    expect(res.status).toBe(201);
  });

  it('requires auth on the status endpoint', async () => {
    expect((await req('/api/status')).status).toBe(401);
    expect((await req('/api/status', { cookie })).status).toBe(200);
  });
});

describe('channel listing includes processing stats', () => {
  let cookie: string;

  beforeEach(async () => {
    await reset();
    cookie = await login();

    const ch = await env.DB.prepare(`INSERT INTO channels (channel_username, enabled) VALUES (?1, 1)`)
      .bind('stats_chan')
      .run();
    const id = Number(ch.meta.last_row_id);
    await env.DB.prepare(
      `INSERT INTO messages (source_channel_id, telegram_message_id, message_date, message_text, source_url)
       VALUES (?1, 1, ?2, 'متن', 'https://t.me/stats_chan/1')`
    )
      .bind(id, new Date().toISOString())
      .run();
  });

  it('returns counts per channel', async () => {
    const res = await req('/api/channels', { cookie });
    const { channels } = await res.json<{
      channels: { channelUsername: string; stats: { messages: number; published: number } }[];
    }>();

    expect(channels).toHaveLength(1);
    expect(channels[0].stats.messages).toBe(1);
    expect(channels[0].stats.published).toBe(0);
  });
});

describe('removed write surface', () => {
  let cookie: string;

  beforeEach(async () => {
    await reset();
    cookie = await login();
  });

  it('no longer exposes a title-edit endpoint', async () => {
    const created = await req('/api/channels', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ username: 'no_title_chan' }),
    });
    const { channel } = await created.json<{ channel: { id: number } }>();

    const res = await req(`/api/channels/${channel.id}/title`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'hack' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('status endpoint never leaks secrets', () => {
  beforeEach(reset);

  it('returns operational data without secret material', async () => {
    const cookie = await login();
    const res = await req('/api/status', { cookie });
    const body = await res.text();

    expect(body).not.toContain(PASSWORD);
    expect(body).not.toContain('OPENCODE_API_KEY');
    expect(body).not.toContain('TELEGRAM_BOT_TOKEN');
    expect(body).not.toContain('TELEGRAM_DESTINATION_CHANNEL');
  });
});

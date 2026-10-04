import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { sendMessage } from '../src/telegram';
import { fetchChannelPreview, PREVIEW_TIMEOUT_MS } from '../src/telegramPreview';
import { discoverFreeModels, MODEL_LIST_TIMEOUT_MS } from '../src/opencode';
import { collectAll } from '../src/collector';

/**
 * Regression coverage for the QA finding: a single unreachable upstream used to
 * stall the sequential hourly run for as long as the socket took to fail.
 */
describe('outbound calls are time-bounded', () => {
  it('preview fetch sends an abort signal', async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_u: unknown, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Response('<html><body></body></html>', { status: 200 });
    }) as unknown as typeof fetch;

    await fetchChannelPreview('timeout_chan', { fetchImpl });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(PREVIEW_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });

  it('model list fetch sends an abort signal', async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_u: unknown, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Response(JSON.stringify({ data: [{ id: 'x-free' }] }), { status: 200 });
    }) as unknown as typeof fetch;

    await discoverFreeModels({ fetchImpl });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(MODEL_LIST_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });

  it('sendMessage sends an abort signal', async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_u: unknown, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1, date: 1 } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    await sendMessage({ token: 'T', chatId: '@dest_channel', text: 'hi', fetchImpl });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('a hung preview does not stop other channels', async () => {
    await env.DB.prepare(`DELETE FROM messages`).run();
    await env.DB.prepare(`DELETE FROM channels`).run();
    await env.DB.prepare(`DELETE FROM ai_settings`).run();

    for (const name of ['hung_chan', 'ok_chan']) {
      await env.DB.prepare(`INSERT INTO channels (channel_username, enabled) VALUES (?1, 1)`)
        .bind(name).run();
    }

    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).includes('hung_chan')) throw new Error('socket hang up');
      const body = `<div data-post="ok_chan/5"><time datetime="${new Date().toISOString()}"></time>
        <div class="tgme_widget_message_text">متن</div></div>`;
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;

    const summary = await collectAll(env.DB, { fetchImpl });

    expect(summary.enabledChannels).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.succeeded).toBe(1);
    const rows = await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages`).first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it('tolerates small clock skew ahead of the Worker clock', async () => {
    await env.DB.prepare(`DELETE FROM messages`).run();
    await env.DB.prepare(`DELETE FROM channels`).run();

    await env.DB.prepare(`INSERT INTO channels (channel_username, enabled) VALUES ('skew_chan', 1)`).run();

    const now = Date.now();
    const fetchImpl = (async () => {
      // Telegram's clock running 30s ahead must not silently drop the post.
      const body = `<div data-post="skew_chan/9"><time datetime="${new Date(
        now + 30_000
      ).toISOString()}"></time><div class="tgme_widget_message_text">متن</div></div>`;
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;

    const summary = await collectAll(env.DB, { now, fetchImpl });
    expect(summary.inserted).toBe(1);
  });

  it('still drops posts that are far in the future', async () => {
    await env.DB.prepare(`DELETE FROM messages`).run();
    await env.DB.prepare(`DELETE FROM channels`).run();
    await env.DB.prepare(`INSERT INTO channels (channel_username, enabled) VALUES ('far_chan', 1)`).run();

    const now = Date.now();
    const fetchImpl = (async () => {
      const body = `<div data-post="far_chan/9"><time datetime="${new Date(
        now + 60 * 60_000
      ).toISOString()}"></time><div class="tgme_widget_message_text">متن</div></div>`;
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;

    const summary = await collectAll(env.DB, { now, fetchImpl });
    expect(summary.inserted).toBe(0);
  });
});

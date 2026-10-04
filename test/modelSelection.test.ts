import { createExecutionContext, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import {
  KEY_FREE_MODELS,
  KEY_PINNED_MODEL,
  KEY_REFRESHED_AT,
  KEY_SELECTED_MODEL,
  getFreeModelCatalog,
  rankFreeModels,
  resolveFreeModel,
  scoreModelId,
  setPinnedModel,
} from '../src/modelManager';
import {
  MODELS_PER_PAGE,
  modelKeyboard,
  parseCallbackData,
  renderModelPicker,
  renderPipelineResult,
} from '../src/telegramAdmin';
import { runSummarization } from '../src/summarizer';
import { getSetting, setSetting } from '../src/settings';

const NOW = Date.parse('2026-10-04T09:00:00.000Z');
const BASE = 'https://worker.test';
const PASSWORD = 'test-admin-password';

const jsonFetch = (payload: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(payload), { status })) as unknown as typeof fetch;

async function reset() {
  await env.DB.prepare(`DELETE FROM messages`).run();
  await env.DB.prepare(`DELETE FROM channels`).run();
  await env.DB.prepare(`DELETE FROM ai_settings`).run();
}

async function seedCatalog(models: string[], now = NOW) {
  await setSetting(env.DB, KEY_FREE_MODELS, JSON.stringify(models));
  await setSetting(env.DB, KEY_REFRESHED_AT, new Date(now).toISOString());
}

async function seedChannel(username: string) {
  const r = await env.DB.prepare(
    `INSERT INTO channels (channel_username, enabled) VALUES (?1, 1)`
  )
    .bind(username)
    .run();
  return Number(r.meta.last_row_id);
}

async function seedMessage(channelId: number, id: number) {
  await env.DB.prepare(
    `INSERT INTO messages (source_channel_id, telegram_message_id, message_date, message_text, source_url)
     VALUES (?1, ?2, ?3, ?4, ?5)`
  )
    .bind(
      channelId,
      id,
      new Date(NOW - 10 * 60_000).toISOString(),
      `خبر شمارهٔ ${id} دربارهٔ تصمیم تازهٔ شورای شهر و بودجهٔ سال آینده.`,
      `https://t.me/testchan/${id}`
    )
    .run();
}

describe('free model preference ordering', () => {
  it('prefers well-known free families over unknown experimental endpoints', () => {
    const ranked = rankFreeModels([
      'apodex/apodex-1.1-mini:free',
      'deepseek/deepseek-chat-v3:free',
      'meta-llama/llama-3.3-70b-instruct:free',
    ]);
    expect(ranked[0]).toBe('deepseek/deepseek-chat-v3:free');
    expect(ranked[ranked.length - 1]).toBe('apodex/apodex-1.1-mini:free');
  });

  it('keeps the provider order for ids it knows nothing about', () => {
    expect(rankFreeModels(['alpha-free', 'beta-free'])).toEqual(['alpha-free', 'beta-free']);
    expect(scoreModelId('alpha-free')).toBe(scoreModelId('beta-free'));
  });
});

describe('manual model selection', () => {
  beforeEach(reset);

  it('refuses to pin a model that is not proven free', async () => {
    await seedCatalog(['alpha-free']);
    expect(await setPinnedModel(env.DB, 'openai/gpt-paid')).toBe('unknown_model');
    expect(await getSetting(env.DB, KEY_PINNED_MODEL)).toBeNull();
  });

  it('uses the pinned model instead of the automatic choice', async () => {
    await seedCatalog(['deepseek/deepseek-chat-v3:free', 'apodex/apodex-1.1-mini:free']);
    expect(await setPinnedModel(env.DB, 'apodex/apodex-1.1-mini:free')).toBe('pinned');

    const result = await resolveFreeModel(env.DB, { now: NOW });
    expect(result.model).toBe('apodex/apodex-1.1-mini:free');
    expect(result.pinned).toBe(true);
    expect(result.reason).toBe('pinned');
  });

  it('survives the 24h refresh as long as the model is still free', async () => {
    await seedCatalog(['alpha-free', 'beta-free']);
    await setPinnedModel(env.DB, 'beta-free');

    const fetchImpl = jsonFetch({ data: [{ id: 'alpha-free' }, { id: 'beta-free' }] });
    const result = await resolveFreeModel(env.DB, {
      fetchImpl,
      now: NOW + 25 * 60 * 60 * 1000,
    });
    expect(result.model).toBe('beta-free');
  });

  it('falls back to automatic selection when the pinned model disappears', async () => {
    await seedCatalog(['alpha-free', 'beta-free']);
    await setPinnedModel(env.DB, 'beta-free');

    const fetchImpl = jsonFetch({ data: [{ id: 'alpha-free' }] });
    const result = await resolveFreeModel(env.DB, {
      fetchImpl,
      now: NOW + 25 * 60 * 60 * 1000,
    });
    expect(result.model).toBe('alpha-free');
  });

  it('clears the pin and returns to automatic selection', async () => {
    await seedCatalog(['alpha-free', 'beta-free']);
    await setPinnedModel(env.DB, 'beta-free');
    expect(await setPinnedModel(env.DB, null)).toBe('cleared');

    const catalog = await getFreeModelCatalog(env.DB);
    expect(catalog.pinned).toBeNull();
    expect(catalog.models).toEqual(['alpha-free', 'beta-free']);
  });

  it('never spends a request when reading the cached catalog', async () => {
    await seedCatalog(['alpha-free']);
    const fetchImpl = jsonFetch({ data: [{ id: 'other-free' }] });
    const catalog = await getFreeModelCatalog(env.DB, { fetchImpl });
    expect(catalog.models).toEqual(['alpha-free']);
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });
});

describe('summarizer rotation on unusable answers', () => {
  beforeEach(reset);

  it('rotates to another free model when one keeps returning invalid JSON', async () => {
    const channelId = await seedChannel('testchan');
    for (let i = 1; i <= 4; i++) await seedMessage(channelId, i);
    await seedCatalog(['alpha-free', 'beta-free']);
    await setSetting(env.DB, KEY_SELECTED_MODEL, 'alpha-free');

    const usedModels: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'alpha-free' }, { id: 'beta-free' }] }), {
          status: 200,
        });
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { model: string };
      usedModels.push(body.model);
      const content =
        body.model === 'alpha-free'
          ? 'سلام! البته، این خبر را خلاصه می‌کنم.' // prose instead of JSON
          : JSON.stringify({
              title: 'تصمیم تازهٔ شورای شهر',
              summary: 'شورای شهر بودجهٔ سال آینده را تصویب کرد.',
              is_news: true,
              is_advertisement: false,
              highlights: [],
              confidence: 0.9,
              category: 'general',
            });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const report = await runSummarization(env.DB, { apiKey: 'k', fetchImpl, now: NOW });

    expect(report.abandonedModels).toContain('alpha-free');
    expect(report.model).toBe('beta-free');
    expect(report.summarized).toBeGreaterThan(0);
    expect(report.failureCategories.invalid_response).toBeGreaterThan(0);
    expect(usedModels.filter((m) => m === 'alpha-free').length).toBeLessThanOrEqual(2);
  });

  it('does not re-select the pinned model after it failed in the same run', async () => {
    const channelId = await seedChannel('testchan');
    for (let i = 1; i <= 3; i++) await seedMessage(channelId, i);
    await seedCatalog(['alpha-free', 'beta-free']);
    await setPinnedModel(env.DB, 'alpha-free');

    const usedModels: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'alpha-free' }, { id: 'beta-free' }] }), {
          status: 200,
        });
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { model: string };
      usedModels.push(body.model);
      if (body.model === 'alpha-free') return new Response('nope', { status: 500 });
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  title: 'عنوان',
                  summary: 'خلاصهٔ معتبر خبر.',
                  is_news: true,
                  is_advertisement: false,
                }),
              },
            },
          ],
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const report = await runSummarization(env.DB, { apiKey: 'k', fetchImpl, now: NOW });
    expect(report.model).toBe('beta-free');
    expect(usedModels.filter((m) => m === 'alpha-free')).toHaveLength(1);
    // The pin itself is preserved; only this run rotated away from it.
    expect(await getSetting(env.DB, KEY_PINNED_MODEL)).toBe('alpha-free');
  });
});

describe('model admin API', () => {
  beforeEach(reset);

  async function login(): Promise<string> {
    const res = await worker.fetch(
      new Request(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      }),
      env,
      createExecutionContext()
    );
    expect(res.status).toBe(200);
    return res.headers.get('set-cookie')!.split(';')[0];
  }

  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    const cookie = await login();
    const headers = new Headers(init.headers);
    headers.set('content-type', 'application/json');
    headers.set('cookie', cookie);
    return worker.fetch(
      new Request(`${BASE}${path}`, { ...init, headers }),
      env,
      createExecutionContext()
    );
  }

  it('requires a session', async () => {
    const res = await worker.fetch(
      new Request(`${BASE}/api/models`),
      env,
      createExecutionContext()
    );
    expect(res.status).toBe(401);
  });

  it('lists the cached free models', async () => {
    await seedCatalog(['alpha-free', 'beta-free']);
    const res = await call('/api/models');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: string[]; pinned: string | null };
    expect(body.models).toEqual(['alpha-free', 'beta-free']);
    expect(body.pinned).toBeNull();
  });

  it('pins and unpins a free model', async () => {
    await seedCatalog(['alpha-free', 'beta-free']);

    const pinned = await call('/api/models', {
      method: 'POST',
      body: JSON.stringify({ model: 'beta-free' }),
    });
    expect(pinned.status).toBe(200);
    expect(((await pinned.json()) as { pinned: string }).pinned).toBe('beta-free');

    const cleared = await call('/api/models', {
      method: 'POST',
      body: JSON.stringify({ model: null }),
    });
    expect(((await cleared.json()) as { pinned: string | null }).pinned).toBeNull();
  });

  it('rejects a model that is not in the free list', async () => {
    await seedCatalog(['alpha-free']);
    const res = await call('/api/models', {
      method: 'POST',
      body: JSON.stringify({ model: 'openai/gpt-paid' }),
    });
    expect(res.status).toBe(422);
  });
});

describe('telegram model picker', () => {
  it('accepts only the bounded model callbacks', () => {
    expect(parseCallbackData('mdl:list')).toEqual({ action: 'mdl:list', arg: null });
    expect(parseCallbackData('mdl:p:2')).toEqual({ action: 'mdl:p', arg: 2 });
    expect(parseCallbackData('mdl:s:11')).toEqual({ action: 'mdl:s', arg: 11 });
    expect(parseCallbackData('mdl:auto')).toEqual({ action: 'mdl:auto', arg: null });
    expect(parseCallbackData('mdl:refresh')).toEqual({ action: 'mdl:refresh', arg: null });
    expect(parseCallbackData('mdl:s:-1')).toBeNull();
    expect(parseCallbackData('mdl:s:deepseek/x')).toBeNull();
    expect(parseCallbackData('mdl:drop')).toBeNull();
  });

  it('paginates the catalog and marks the pinned model', () => {
    const models = Array.from({ length: MODELS_PER_PAGE + 2 }, (_, i) => `model-${i}:free`);
    const catalog = {
      models,
      selected: 'model-7:free',
      pinned: 'model-7:free',
      refreshedAt: new Date(NOW).toISOString(),
      lastFailure: null,
    };

    const first = modelKeyboard(catalog, 0);
    expect(first.inline_keyboard[0][0].callback_data).toBe('mdl:s:0');
    expect(JSON.stringify(first)).toContain('mdl:p:1');

    const second = modelKeyboard(catalog, 1);
    expect(second.inline_keyboard[0][0].callback_data).toBe(`mdl:s:${MODELS_PER_PAGE}`);

    const text = renderModelPicker(catalog, 1);
    expect(text).toContain('✅ model-7:free');
    expect(text).toContain('دستی');
  });

  it('explains an empty catalog instead of showing a blank screen', () => {
    const text = renderModelPicker(
      { models: [], selected: null, pinned: null, refreshedAt: null, lastFailure: null },
      0
    );
    expect(text).toContain('به‌روزرسانی فهرست');
  });
});

describe('run report diagnostics', () => {
  it('names the AI failure cause and the image outcome', () => {
    const text = renderPipelineResult({
      status: 'partial',
      ranAt: new Date(NOW).toISOString(),
      collection: { inserted: 0 },
      filteredAdvertisements: 0,
      summarization: {
        summarized: 0,
        model: 'apodex/apodex-1.1-mini:free',
        failureCategories: { invalid_response: 20 },
      },
      publishing: { published: 0, image: { sent: false, cards: 0, reason: 'browser_binding_missing' } },
      itemFailures: 20,
      durationMs: 50_000,
    });

    expect(text).toContain('پاسخ نامعتبر مدل (20)');
    expect(text).toContain('اتصال Browser Run تنظیم نشده است');
    expect(text).toContain('apodex/apodex-1.1-mini:free');
  });
});

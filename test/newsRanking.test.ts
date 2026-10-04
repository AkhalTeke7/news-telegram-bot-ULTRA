import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  markImportance,
  RANK_CANDIDATE_LIMIT,
  runImportanceRanking,
  selectRankCandidates,
} from '../src/newsRanking';
import { parseNewsJson, parseRanking, rankNewsItems, summarizeNews } from '../src/openrouter';
import {
  markRejectedByAi,
  MAX_TITLE_CHARS,
  runSummarization,
  selectEligibleMessages,
  validateAiTitle,
} from '../src/summarizer';

const NOW = Date.now();

async function reset() {
  await env.DB.prepare(`DELETE FROM messages`).run();
  await env.DB.prepare(`DELETE FROM channels`).run();
  await env.DB.prepare(`DELETE FROM cron_runs`).run();
  await env.DB.prepare(`DELETE FROM ai_settings`).run();
}

async function seedChannel(username: string) {
  const r = await env.DB
    .prepare(`INSERT INTO channels (channel_username, enabled) VALUES (?1, 1)`)
    .bind(username)
    .run();
  return Number(r.meta.last_row_id);
}

async function seedProcessed(
  channelId: number,
  username: string,
  telegramId: number,
  title: string | null,
  summary: string,
  minutesAgo = 10
) {
  const r = await env.DB.prepare(
    `INSERT INTO messages (source_channel_id, telegram_message_id, message_date, message_text, source_url,
                           summary_text, title, summarized_at, filter_status)
     VALUES (?1, ?2, ?3, 'body', ?4, ?5, ?6, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'passed')`
  )
    .bind(
      channelId,
      telegramId,
      new Date(NOW - minutesAgo * 60_000).toISOString(),
      `https://t.me/${username}/${telegramId}`,
      summary,
      title
    )
    .run();
  return Number(r.meta.last_row_id);
}

/** Canned OpenRouter chat-completions reply. */
function aiFetch(content: string) {
  const calls: { body: any }[] = [];
  const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
    calls.push({ body: JSON.parse(String(init.body)) });
    return new Response(
      JSON.stringify({ choices: [{ message: { content } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

/** Seeds the free-model cache so no model-list request is needed. */
async function seedModel(model = 'free-model-a') {
  const { setSetting } = await import('../src/settings');
  const { KEY_FREE_MODELS, KEY_REFRESHED_AT, KEY_SELECTED_MODEL } = await import(
    '../src/modelManager'
  );
  await setSetting(env.DB, KEY_FREE_MODELS, JSON.stringify([model]));
  await setSetting(env.DB, KEY_REFRESHED_AT, new Date().toISOString());
  await setSetting(env.DB, KEY_SELECTED_MODEL, model);
}

beforeEach(async () => {
  await reset();
});

describe('AI news contract', () => {
  it('returns title, summary and the semantic verdict', async () => {
    const ai = aiFetch(
      JSON.stringify({ title: 'تیتر خبر', summary: 'خلاصهٔ خبر.', is_news: true, is_advertisement: false })
    );
    const result = await summarizeNews({
      apiKey: 'K',
      model: 'free-model-a',
      text: 'متن خبر',
      channelUsername: 'news_one',
      messageDate: '2026-10-03T10:00:00Z',
      fetchImpl: ai.fetchImpl,
    });
    expect(result.title).toBe('تیتر خبر');
    expect(result.summary).toBe('خلاصهٔ خبر.');
    expect(result.isNews).toBe(true);
    expect(result.isAdvertisement).toBe(false);
  });

  it('never sends secrets or channel metadata to the model', async () => {
    const ai = aiFetch(JSON.stringify({ title: 't', summary: 's', is_news: true }));
    await summarizeNews({
      apiKey: 'SECRET-KEY',
      model: 'free-model-a',
      text: 'متن خبر',
      channelUsername: 'iran_efsha_news',
      messageDate: '2026-10-03T10:00:00Z',
      fetchImpl: ai.fetchImpl,
    });
    const serialized = JSON.stringify(ai.calls[0].body);
    expect(serialized).not.toContain('SECRET-KEY');
    expect(serialized).not.toContain('@iran_efsha_news');
    expect(serialized).not.toContain('post_date');
  });

  it('parses JSON wrapped in code fences', () => {
    const parsed = parseNewsJson('```json\n{"title":"t","summary":"s","is_news":true}\n```');
    expect(parsed.title).toBe('t');
    expect(parsed.isNews).toBe(true);
  });

  it('fails closed when the verdict is missing', () => {
    const parsed = parseNewsJson('{"title":"t","summary":"s"}');
    expect(parsed.isNews).toBe(false);
    expect(parsed.isAdvertisement).toBe(false);
  });

  it('rejects malformed JSON', () => {
    expect(() => parseNewsJson('not json at all')).toThrow();
  });

  it('repairs a reply truncated inside the summary and keeps whole sentences', () => {
    // Exactly what a free model emits when it hits the token cap mid-reply.
    const truncated =
      '{"title":"تیتر خبر","is_news":true,"is_advertisement":false,"category":"politics","confidence":0.9,"summary":"جملهٔ اول کامل است. جملهٔ دوم ناتمام';
    const parsed = parseNewsJson(truncated);
    expect(parsed.isNews).toBe(true);
    expect(parsed.title).toBe('تیتر خبر');
    // The half sentence never reaches a digest.
    expect(parsed.summary).toBe('جملهٔ اول کامل است.');
    expect(parsed.category).toBe('politics');
  });

  it('repairs a reply truncated inside the highlights array', () => {
    const truncated =
      '{"title":"ت","is_news":true,"is_advertisement":false,"category":"general","confidence":0.8,"summary":"خلاصهٔ کامل.","highlights":["اول","دو';
    const parsed = parseNewsJson(truncated);
    expect(parsed.summary).toBe('خلاصهٔ کامل.');
    expect(parsed.isNews).toBe(true);
    expect(parsed.highlights[0]).toBe('اول');
  });

  it('repairs a reply truncated at a dangling key', () => {
    const truncated = '{"title":"ت","is_news":true,"summary":"خلاصهٔ کامل.","high';
    const parsed = parseNewsJson(truncated);
    expect(parsed.summary).toBe('خلاصهٔ کامل.');
    expect(parsed.isNews).toBe(true);
  });

  it('never trusts a truncated reply that lost the verdict', () => {
    // Without an explicit is_news boolean, repair must fail instead of
    // parking real news as "not news".
    expect(() => parseNewsJson('{"title":"ت","summary":"جملهٔ کامل. نیمه')).toThrow(
      /verdict|malformed|JSON/i
    );
  });

  it('never trusts a truncated reply without one complete sentence', () => {
    expect(() =>
      parseNewsJson('{"title":"ت","is_news":true,"summary":"جملهٔ ناتمام بدون پایان')
    ).toThrow();
  });
});

describe('AI advertisement and non-news rejection', () => {
  it('parks an AI-rejected advertisement in the filtered state', async () => {
    await seedModel();
    const id = await seedChannel('news_ads');
    await env.DB.prepare(
      `INSERT INTO messages (source_channel_id, telegram_message_id, message_date, message_text, source_url)
       VALUES (?1, 1, ?2, 'متن تبلیغی', 'https://t.me/news_ads/1')`
    )
      .bind(id, new Date(NOW).toISOString())
      .run();

    const ai = aiFetch(
      JSON.stringify({ title: 'تیتر', summary: 'خلاصه.', is_news: false, is_advertisement: true })
    );
    await runSummarization(env.DB, { apiKey: 'K', fetchImpl: ai.fetchImpl, now: NOW });

    const row = await env.DB.prepare(
      `SELECT filter_status, filter_reason, summary_text FROM messages WHERE source_channel_id = ?1`
    )
      .bind(id)
      .first<{ filter_status: string; filter_reason: string; summary_text: string | null }>();
    expect(row?.filter_status).toBe('filtered');
    expect(row?.filter_reason).toBe('ai_advertisement');
    expect(row?.summary_text).toBeNull();
  });

  it('parks AI-rejected non-news in the filtered state', async () => {
    await seedModel();
    const id = await seedChannel('news_junk');
    await env.DB.prepare(
      `INSERT INTO messages (source_channel_id, telegram_message_id, message_date, message_text, source_url)
       VALUES (?1, 1, ?2, 'متن بی‌ربط', 'https://t.me/news_junk/1')`
    )
      .bind(id, new Date(NOW).toISOString())
      .run();

    const ai = aiFetch(
      JSON.stringify({ title: 'تیتر', summary: 'خلاصه.', is_news: false, is_advertisement: false })
    );
    await runSummarization(env.DB, { apiKey: 'K', fetchImpl: ai.fetchImpl, now: NOW });

    const row = await env.DB.prepare(
      `SELECT filter_status, filter_reason FROM messages WHERE source_channel_id = ?1`
    )
      .bind(id)
      .first<{ filter_status: string; filter_reason: string }>();
    expect(row?.filter_status).toBe('filtered');
    expect(row?.filter_reason).toBe('ai_not_news');
  });

  it('keeps the deterministic ad filter as the first gate', async () => {
    const id = await seedChannel('news_spam');
    await env.DB.prepare(
      `INSERT INTO messages (source_channel_id, telegram_message_id, message_date, message_text, source_url, filter_status)
       VALUES (?1, 1, ?2, 'عضویت در کانال با لینک', 'https://t.me/news_spam/1', 'filtered')`
    )
      .bind(id, new Date(NOW).toISOString())
      .run();

    const eligible = await selectEligibleMessages(env.DB, { now: NOW });
    expect(eligible.some((e) => e.channelId === id)).toBe(false);
  });
});

describe('global ranking', () => {
  it('ranks every channel together in one request and stores importance', async () => {
    await seedModel();
    const a = await seedChannel('channel_alpha');
    const b = await seedChannel('channel_beta');
    await seedProcessed(a, 'channel_alpha', 1, 'تیتر یک', 'خلاصهٔ یک.', 30);
    await seedProcessed(a, 'channel_alpha', 2, 'تیتر دو', 'خلاصهٔ دو.', 20);
    await seedProcessed(b, 'channel_beta', 1, 'تیتر سه', 'خلاصهٔ سه.', 10);

    const ai = aiFetch('[{"i":2,"importance":5},{"i":0,"importance":3},{"i":1,"importance":1}]');
    const report = await runImportanceRanking(env.DB, {
      apiKey: 'K',
      fetchImpl: ai.fetchImpl,
      now: NOW,
    });

    expect(ai.fetchImpl).toHaveBeenCalledTimes(1);
    expect(report.candidates).toBe(3);
    expect(report.ranked).toBe(3);
    expect(report.important).toBe(2);

    const rows = await env.DB.prepare(`SELECT importance FROM messages ORDER BY id`).all<{
      importance: number;
    }>();
    expect(rows.results?.map((r) => r.importance)).toEqual([3, 1, 5]);
  });

  it('does not let channel order or volume drive the ranking', async () => {
    await seedModel();
    const a = await seedChannel('channel_alpha');
    const b = await seedChannel('channel_beta');
    // channel A has 4 posts, channel B has 1
    for (let i = 1; i <= 4; i++) await seedProcessed(a, 'channel_alpha', i, `تیتر ${i}`, `خلاصهٔ ${i}.`, 40);
    await seedProcessed(b, 'channel_beta', 1, 'تیتر ب', 'خلاصهٔ ب.', 10);

    const ai = aiFetch('[{"i":4,"importance":5},{"i":0,"importance":1},{"i":1,"importance":1},{"i":2,"importance":1},{"i":3,"importance":1}]');
    await runImportanceRanking(env.DB, { apiKey: 'K', fetchImpl: ai.fetchImpl, now: NOW });

    const best = await env.DB.prepare(
      `SELECT m.source_channel_id FROM messages m WHERE m.importance = 5`
    ).first<{ source_channel_id: number }>();
    expect(best?.source_channel_id).toBe(b);
  });

  it('a channel with zero posts contributes no candidates', async () => {
    await seedModel();
    const a = await seedChannel('channel_alpha');
    await seedChannel('channel_silent');
    await seedProcessed(a, 'channel_alpha', 1, 'تیتر', 'خلاصه.', 10);

    const candidates = await selectRankCandidates(env.DB);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].channelId).toBe(a);
  });

  it('clamps out-of-range and unknown indices safely', () => {
    const items = [
      { id: 11, title: 'a', summary: 'a' },
      { id: 22, title: 'b', summary: 'b' },
    ];
    const ranked = parseRanking(
      '[{"i":0,"importance":99},{"i":7,"importance":3},{"i":-1,"importance":2},{"i":1,"importance":0}]',
      items
    );
    expect(ranked).toEqual([
      { id: 11, importance: 5 },
      { id: 22, importance: 1 },
    ]);
  });

  it('keeps omitted candidates at a neutral score instead of dropping them', () => {
    const items = [
      { id: 1, title: 'a', summary: 'a' },
      { id: 2, title: 'b', summary: 'b' },
      { id: 3, title: 'c', summary: 'c' },
    ];
    const ranked = parseRanking('[{"i":1,"importance":4}]', items);
    expect(ranked).toHaveLength(3);
    expect(ranked.find((r) => r.id === 2)?.importance).toBe(4);
    // Not 1: importance 1 means "do not publish" and would drop the row from
    // the run image, which a partial answer must never do.
    expect(ranked.find((r) => r.id === 1)?.importance).toBe(2);
    expect(ranked.find((r) => r.id === 3)?.importance).toBe(2);
  });

  it('ranks globally and produces exactly four selected items', async () => {
    await seedModel();
    const a = await seedChannel('channel_alpha');
    const b = await seedChannel('channel_beta');
    const alphaIds: number[] = [];
    for (let i = 1; i <= 6; i++) {
      alphaIds.push(await seedProcessed(a, 'channel_alpha', i, `تیتر ${i}`, `خلاصهٔ ${i}.`, 50 - i));
    }
    const betaId = await seedProcessed(b, 'channel_beta', 1, 'تیتر ب', 'خلاصهٔ ب.', 5);

    // candidate order is chronological ascending: the six alpha rows then beta.
    // Filler rows score 2, not 1: an explicit 1 means "not worth the image" and
    // is excluded from selection entirely (see README / selectTopNews).
    const scores = JSON.stringify(
      Array.from({ length: 7 }, (_, i) => ({ i, importance: i === 6 ? 5 : i === 0 ? 4 : 2 }))
    );
    const ai = aiFetch(scores);
    await runImportanceRanking(env.DB, { apiKey: 'K', fetchImpl: ai.fetchImpl, now: NOW });

    const { selectTopNews } = await import('../src/newsImage');
    const { selectPublishableMessages } = await import('../src/publisher');
    const rows = await selectPublishableMessages(env.DB);
    const top = selectTopNews(rows);

    expect(top).toHaveLength(4);
    // globally highest score wins, regardless of channel and volume
    expect(top[0].id).toBe(betaId);
    expect(top[1].id).toBe(alphaIds[0]);
    // the remaining two slots are filled from the five rows tied at importance 2,
    // so at least some alpha rows must be left out of the image
    expect(top.filter((t) => alphaIds.includes(t.id))).toHaveLength(3);
    expect(alphaIds.some((id) => !top.some((t) => t.id === id))).toBe(true);
  });

  it('stores importance without touching publish state', async () => {
    const a = await seedChannel('channel_alpha');
    const id = await seedProcessed(a, 'channel_alpha', 1, 'تیتر', 'خلاصه.', 10);
    await markImportance(env.DB, id, 4);
    const row = await env.DB.prepare(
      `SELECT importance, published_at, summary_text, title FROM messages WHERE id = ?1`
    )
      .bind(id)
      .first<{ importance: number; published_at: string | null; summary_text: string; title: string }>();
    expect(row?.importance).toBe(4);
    expect(row?.published_at).toBeNull();
    expect(row?.summary_text).toBe('خلاصه.');
    expect(row?.title).toBe('تیتر');
  });

  it('is a no-op with no candidates and makes no AI request', async () => {
    const ai = aiFetch('[]');
    const report = await runImportanceRanking(env.DB, { apiKey: 'K', fetchImpl: ai.fetchImpl, now: NOW });
    expect(report.candidates).toBe(0);
    expect(ai.fetchImpl).not.toHaveBeenCalled();
  });

  it('reports an error and changes nothing when the AI reply is unusable', async () => {
    await seedModel();
    const a = await seedChannel('channel_alpha');
    await seedProcessed(a, 'channel_alpha', 1, 'تیتر', 'خلاصه.', 10);

    const ai = aiFetch('totally not json');
    const report = await runImportanceRanking(env.DB, { apiKey: 'K', fetchImpl: ai.fetchImpl, now: NOW });
    expect(report.ranked).toBe(0);
    expect(report.error).toBeTruthy();

    const row = await env.DB.prepare(`SELECT importance FROM messages`).first<{ importance: number | null }>();
    expect(row?.importance).toBeNull();
  });

  it('bounds the candidate list', async () => {
    expect(RANK_CANDIDATE_LIMIT).toBeGreaterThanOrEqual(4);
    const { runImportanceRanking: run } = await import('../src/newsRanking');
    expect(typeof run).toBe('function');
  });
});

describe('ranking input hygiene', () => {
  it('sends only title and summary to the ranking model', async () => {
    const ai = aiFetch('[{"i":0,"importance":3}]');
    await rankNewsItems({
      apiKey: 'SECRET-KEY',
      model: 'free-model-a',
      items: [{ id: 1, title: 'تیتر', summary: 'خلاصه' }],
      fetchImpl: ai.fetchImpl,
    });
    const body = JSON.stringify(ai.calls[0].body);
    expect(body).not.toContain('SECRET-KEY');
    expect(body).not.toContain('@');
    expect(body).not.toContain('https://t.me');
    expect(body).toContain('تیتر');
  });
});

describe('publish budget includes the image', () => {
  it('reserves subrequests for the Browser Run render and sendPhoto', async () => {
    const { publishMessageBudget, IMAGE_RESERVE, SUBREQUEST_LIMIT_FREE, SUMMARIZE_RESERVE, MODEL_LIST_RESERVE } =
      await import('../src/publisher');

    for (const channels of [1, 2, 3, 5, 8]) {
      const budget = publishMessageBudget(channels);
      const total =
        channels + SUMMARIZE_RESERVE + MODEL_LIST_RESERVE + IMAGE_RESERVE + budget;
      expect(total).toBeLessThanOrEqual(SUBREQUEST_LIMIT_FREE);
    }
  });

  it('reduces the budget by the image cost versus the previous formula', async () => {
    const { publishMessageBudget, IMAGE_RESERVE } = await import('../src/publisher');
    const channels = 5;
    const withoutImage =
      50 - channels - 20 - 1;
    expect(publishMessageBudget(channels)).toBe(Math.max(1, withoutImage - IMAGE_RESERVE));
  });
});

describe('title and summary are shared between image and digest', () => {
  it('uses the identical AI title and summary in both outputs', async () => {
    const a = await seedChannel('channel_alpha');
    const title = 'تیتر دقیق خبر';
    const summary = 'خلاصهٔ دقیق خبر.';
    await seedProcessed(a, 'channel_alpha', 1, title, summary, 10);
    await markImportance(env.DB, (await selectRankCandidates(env.DB))[0].id, 5);

    const { selectPublishableMessages, buildChannelDigest, runPublishing } = await import(
      '../src/publisher'
    );
    const { selectTopNews } = await import('../src/newsImage');
    const { sendMessage } = await import('../src/telegram');

    const rows = await selectPublishableMessages(env.DB);
    const [imageItem] = selectTopNews(rows);
    const parts = buildChannelDigest('channel_alpha', '@destination', rows);

    expect(imageItem.title).toBe(title);
    expect(imageItem.summary).toBe(summary);
    expect(parts[0].text).toContain(title);
    expect(parts[0].text).toContain(summary);
    expect(typeof sendMessage).toBe('function');
    expect(typeof runPublishing).toBe('function');
  });

  it('keeps legacy rows readable with rich formatting when no title exists', async () => {
    const { buildChannelDigest } = await import('../src/publisher');
    const parts = buildChannelDigest('channel_alpha', '@destination', [
      { id: 1, summaryText: 'خلاصهٔ خبر.', title: null },
    ]);
    expect(parts[0].text).toContain('📰 <b>خبر عمومی</b>\n📝 <b>خلاصه:</b> خلاصهٔ خبر.');
    expect(parts[0].text).toContain('📡 <i>منبع: @channel_alpha</i>\n📣 <i>@destination</i>');
  });
});

describe('AI title validation', () => {
  it('accepts a clean Persian headline', () => {
    expect(validateAiTitle('اعلامیه مهم درباره بارش‌های شدید')).toBe('اعلامیه مهم درباره بارش‌های شدید');
  });

  it('rejects an empty or non-string title', () => {
    expect(validateAiTitle('')).toBeNull();
    expect(validateAiTitle('   ')).toBeNull();
    expect(validateAiTitle(null)).toBeNull();
    expect(validateAiTitle(undefined)).toBeNull();
  });

  it('rejects a title longer than the contract maximum', () => {
    expect(validateAiTitle('ا'.repeat(MAX_TITLE_CHARS))).toBe('ا'.repeat(MAX_TITLE_CHARS));
    expect(validateAiTitle('ا'.repeat(MAX_TITLE_CHARS + 1))).toBeNull();
  });

  it('rejects URLs, domains and chat hosts', () => {
    expect(validateAiTitle('جزئیات در https://example.com منتشر شد')).toBeNull();
    expect(validateAiTitle('خبر در example.com منتشر شد')).toBeNull();
    expect(validateAiTitle('گزارش در t.me/somechannel')).toBeNull();
    expect(validateAiTitle('پیوند در eitaa.com/x')).toBeNull();
    expect(validateAiTitle('سایت www.example.org')).toBeNull();
  });

  it('rejects handles and source labels', () => {
    expect(validateAiTitle('گزارش @some_channel')).toBeNull();
    expect(validateAiTitle('منبع: خبرگزاری')).toBeNull();
  });

  it('rejects technical metadata and long digit runs', () => {
    expect(validateAiTitle('گزارش با message_id 12345')).toBeNull();
    expect(validateAiTitle('شماره 123456789')).toBeNull();
  });

  it('rejects non-Persian and markdown content', () => {
    expect(validateAiTitle('Breaking News')).toBeNull();
    expect(validateAiTitle('**تیتر** پررنگ')).toBeNull();
    expect(validateAiTitle('تیتر\nبا خط جدید')).toBe('تیتر با خط جدید');
  });

  it('never stores an invalid title, and still publishes the news', async () => {
    await seedModel();
    const ch = await seedChannel('news_titles');
    await env.DB.prepare(
      `INSERT INTO messages (source_channel_id, telegram_message_id, message_date, message_text, source_url)
       VALUES (?1, 1, ?2, 'متن خبر', 'https://t.me/news_titles/1')`
    )
      .bind(ch, new Date(NOW).toISOString())
      .run();

    const ai = aiFetch(
      JSON.stringify({
        title: 'گزارش @bad_channel و لینک https://evil.example',
        summary: 'خلاصهٔ معتبر خبر.',
        is_news: true,
      })
    );
    const report = await runSummarization(env.DB, { apiKey: 'K', fetchImpl: ai.fetchImpl, now: NOW });

    expect(report.summarized).toBe(1);
    expect(report.withTitle).toBe(0);

    const row = await env.DB.prepare(
      `SELECT title, summary_text FROM messages WHERE source_channel_id = ?1`
    )
      .bind(ch)
      .first<{ title: string | null; summary_text: string }>();
    expect(row?.title).toBeNull();
    expect(row?.summary_text).toBe('خلاصهٔ معتبر خبر.');
  });

  it('stores a valid title', async () => {
    await seedModel();
    const ch = await seedChannel('news_good_titles');
    await env.DB.prepare(
      `INSERT INTO messages (source_channel_id, telegram_message_id, message_date, message_text, source_url)
       VALUES (?1, 1, ?2, 'متن خبر', 'https://t.me/news_good_titles/1')`
    )
      .bind(ch, new Date(NOW).toISOString())
      .run();

    const ai = aiFetch(
      JSON.stringify({ title: 'تیتر معتبر خبر', summary: 'خلاصهٔ خبر.', is_news: true })
    );
    await runSummarization(env.DB, { apiKey: 'K', fetchImpl: ai.fetchImpl, now: NOW });

    const row = await env.DB.prepare(`SELECT title FROM messages WHERE source_channel_id = ?1`)
      .bind(ch)
      .first<{ title: string | null }>();
    expect(row?.title).toBe('تیتر معتبر خبر');
  });
});

describe('rejection helper', () => {
  it('marks a row filtered and is idempotent', async () => {
    const a = await seedChannel('channel_alpha');
    const rowId = await seedProcessed(a, 'channel_alpha', 1, 'تیتر', 'خلاصه.', 10);
    const first = await markRejectedByAi(env.DB, rowId, 'ai_not_news');
    const second = await markRejectedByAi(env.DB, rowId, 'ai_not_news');
    expect(first).toBe(true);
    expect(second).toBe(false);
  });
});
/* ------------------------------------------------- rate-limit awareness -- */

describe('ranking rate limits', () => {
  it('waits once for an account-wide minute limit and retries the SAME model', async () => {
    await seedModel('free-model-a');
    const a = await seedChannel('channel_alpha');
    await seedProcessed(a, 'channel_alpha', 1, 'تیتر یک', 'خلاصهٔ یک.', 30);

    let chatCalls = 0;
    const waits: number[] = [];
    const fetchImpl = vi.fn(async () => {
      chatCalls++;
      if (chatCalls === 1) {
        return new Response(
          JSON.stringify({
            error: { message: 'Rate limit exceeded: free-models-per-minute.', code: 429 },
          }),
          { status: 429 }
        );
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '[{"i":0,"importance":4}]' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as unknown as typeof fetch;

    const report = await runImportanceRanking(env.DB, {
      apiKey: 'K',
      fetchImpl,
      now: NOW,
      sleepImpl: async (ms) => {
        waits.push(ms);
      },
    });

    expect(report.error).toBeUndefined();
    expect(report.ranked).toBe(1);
    expect(report.model).toBe('free-model-a'); // never rotated
    expect(chatCalls).toBe(2);
    expect(waits).toHaveLength(1);
  });

  it('gives up without rotating when the daily free-tier cap is hit', async () => {
    await seedModel('free-model-a');
    const a = await seedChannel('channel_alpha');
    await seedProcessed(a, 'channel_alpha', 1, 'تیتر یک', 'خلاصهٔ یک.', 30);

    let chatCalls = 0;
    const fetchImpl = vi.fn(async () => {
      chatCalls++;
      return new Response(
        JSON.stringify({
          error: { message: 'Rate limit exceeded: free-models-per-day.', code: 429 },
        }),
        { status: 429 }
      );
    }) as unknown as typeof fetch;

    const report = await runImportanceRanking(env.DB, {
      apiKey: 'K',
      fetchImpl,
      now: NOW,
      sleepImpl: async () => {},
    });

    // One request, one safe error, no catalog churn, importance untouched.
    expect(chatCalls).toBe(1);
    expect(report.error).toBe('rate_limited_daily');
    expect(report.ranked).toBe(0);
    const rows = await env.DB.prepare(`SELECT importance FROM messages`).all<{ importance: number | null }>();
    expect(rows.results?.[0].importance).toBeNull();
  });
});

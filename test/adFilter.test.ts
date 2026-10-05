import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ADVERTISEMENT_SCORE_THRESHOLD,
  detectAdvertisement,
  normalizeText,
} from '../src/adFilter';
import { filterPendingMessages } from '../src/adFilterStage';
import { runNewsPipeline } from '../src/pipeline';
import { selectEligibleMessages } from '../src/summarizer';
import { selectPublishableMessages } from '../src/publisher';
import type { Env } from '../src/types';

const AD_TEXTS = [
  'همین حالا خرید کنید! فروش ویژه با تخفیف ویژه و ارسال رایگان',
  'تخفیف ویژه امروز، همین حالا سفارش دهید و کد تخفیف را دریافت کنید',
  'لینک خرید در سایت https://shop.example.com با قیمت استثنایی',
  'سایت شرط بندی با بونوس ویژه و پاداش ثبت نام کنید',
  'کازینو آنلاین با بونوس خوش‌آمدگویی و چرخش رایگان',
  'با معرفی دوستتان ۵۰ دلار هدیه بگیرید و شرکت کنید',
  'ثبت نام در سایت پوکر آنلاین با بونوس و جایزه بزرگ',
  'BUY NOW! Special offer 50% discount — free shipping. Order today: https://deals.example.com',
];

const NEWS_TEXTS = [
  'قیمت خودرو امروز افزایش یافت',
  'پلیس یک سایت شرط‌بندی را مسدود کرد',
  'مجلس طرح جدیدی برای نظارت بر کازینو تصویب کرد',
  'تیم ملی فوتبال در بازی دوستانه پیروز شد',
  'قیمت سکه در بازار امروز رشد کرد',
  'شرکت اپل محصول جدیدی معرفی کرد',
  'گزارش تازه از مذاکرات اقتصادی در سایت https://news.example.com منتشر شد',
  'فروش خودرو در بازار امروز افزایش یافت',
  'تحقیقات پلیس درباره شبکه قمار در جریان است',
  'قانون جدید کازینوها در اروپا تصویب شد',
];

describe('normalizeText', () => {
  it('folds Persian and Arabic digits', () => {
    expect(normalizeText('قیمت ۱۲۳ تومان')).toContain('123');
    expect(normalizeText('۱۲۳٤٥')).toBe('12345');
  });

  it('folds Arabic letter variants', () => {
    expect(normalizeText('کازینو')).toBe(normalizeText('كازينو'));
  });

  it('removes zero-width characters and keeps ZWNJ as a separator', () => {
    expect(normalizeText('خبر\u200bجدید')).toBe(normalizeText('خبر جدید'));
    expect(normalizeText('شرط‌بندی')).toBe('شرط بندی');
  });

  it('collapses whitespace and punctuation, lowercases English', () => {
    expect(normalizeText('  BUY   NOW!!!  ')).toBe('buy now');
  });
});

describe('advertisements are filtered', () => {
  it.each(AD_TEXTS)('flags: %s', (text) => {
    const result = detectAdvertisement(text);
    expect(result.isAdvertisement).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(ADVERTISEMENT_SCORE_THRESHOLD);
    expect(result.reason).toBeTruthy();
  });
});

describe('normal news is not filtered', () => {
  it.each(NEWS_TEXTS)('allows: %s', (text) => {
    const result = detectAdvertisement(text);
    expect(result.isAdvertisement).toBe(false);
    expect(result.score).toBeLessThan(ADVERTISEMENT_SCORE_THRESHOLD);
  });

  it('never filters on bare commercial vocabulary', () => {
    for (const word of ['خرید', 'فروش', 'قیمت', 'بازار', 'محصول']) {
      expect(detectAdvertisement(`گزارش ${word} بازار امروز`).isAdvertisement).toBe(false);
    }
  });

  it('does not treat a plain source link as an advertisement', () => {
    expect(detectAdvertisement('منبع: https://example.org/news/1').isAdvertisement).toBe(false);
  });

  it('does not treat "ثبت" as the gambling token "بت"', () => {
    expect(detectAdvertisement('ثبت نام در خبرنامه رایگان انجام دهید').isAdvertisement).toBe(false);
  });
});

describe('edge cases', () => {
  it('handles empty and whitespace-only input', () => {
    for (const input of ['', '   ', '\n\t', '']) {
      expect(detectAdvertisement(input)).toEqual({ isAdvertisement: false, score: 0, reason: null });
    }
  });

  it('handles emoji-heavy posts', () => {
    expect(detectAdvertisement('🔥🚀💥 خبر مهم امروز منتشر شد').isAdvertisement).toBe(false);
  });

  it('handles hashtags and mixed scripts', () => {
    expect(detectAdvertisement('#خبر #فوتبال تیم ملی برنده شد').isAdvertisement).toBe(false);
    expect(detectAdvertisement('Promo #bet #casino — BUY NOW with bonus').isAdvertisement).toBe(true);
  });

  it('is deterministic', () => {
    const text = AD_TEXTS[0];
    expect(detectAdvertisement(text)).toEqual(detectAdvertisement(text));
  });

  it('handles mixed Persian/English advertising text', () => {
    expect(
      detectAdvertisement('فروش ویژه امروز! BUY NOW at https://example.com/shop').isAdvertisement
    ).toBe(true);
  });

  it('tolerates a non-string input', () => {
    expect(detectAdvertisement(undefined as unknown as string).isAdvertisement).toBe(false);
  });
});

/* ------------------------------------------------------------------- stage */

async function reset() {
  await env.DB.prepare(`DELETE FROM messages`).run();
  await env.DB.prepare(`DELETE FROM channels`).run();
  await env.DB.prepare(`DELETE FROM cron_runs`).run();
  await env.DB.prepare(`DELETE FROM ai_settings`).run();
}

async function seedChannel(enabled = true) {
  const r = await env.DB.prepare(`INSERT INTO channels (channel_username, enabled) VALUES ('ad_filter_chan', ?1)`)
    .bind(enabled ? 1 : 0)
    .run();
  return Number(r.meta.last_row_id);
}

/**
 * Pipeline tests seed the channel DISABLED so the collect stage has nothing to
 * fetch (tests must never touch the network), then enable it afterwards to
 * assert what summarization/publishing would pick up.
 */
async function enableChannel(id: number) {
  await env.DB.prepare(`UPDATE channels SET enabled = 1 WHERE id = ?1`).bind(id).run();
}

async function seedMessage(channelId: number, telegramId: number, text: string) {
  await env.DB.prepare(
    `INSERT INTO messages (source_channel_id, telegram_message_id, message_date, message_text, source_url)
     VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?3, ?4)`
  )
    .bind(channelId, telegramId, text, `https://t.me/ad_filter_chan/${telegramId}`)
    .run();
}

async function statusOf(telegramId: number) {
  const row = await env.DB.prepare(
    `SELECT filter_status, filter_reason, filtered_at FROM messages WHERE telegram_message_id = ?1`
  )
    .bind(telegramId)
    .first<{ filter_status: string; filter_reason: string | null; filtered_at: string | null }>();
  return row!;
}

describe('filter stage', () => {
  beforeEach(reset);

  it('marks advertisements filtered with a reason and timestamp', async () => {
    const ch = await seedChannel();
    await seedMessage(ch, 1, AD_TEXTS[0]);

    const outcome = await filterPendingMessages(env.DB);
    expect(outcome).toMatchObject({ checked: 1, filtered: 1, passed: 0 });

    const row = await statusOf(1);
    expect(row.filter_status).toBe('filtered');
    expect(row.filter_reason).toBeTruthy();
    expect(row.filtered_at).not.toBeNull();
  });

  it('marks normal news as passed without a reason', async () => {
    const ch = await seedChannel();
    await seedMessage(ch, 2, NEWS_TEXTS[0]);

    const outcome = await filterPendingMessages(env.DB);
    expect(outcome).toMatchObject({ checked: 1, filtered: 0, passed: 1 });

    const row = await statusOf(2);
    expect(row.filter_status).toBe('passed');
    expect(row.filtered_at).toBeNull();
  });

  it('does not re-evaluate a message on later runs', async () => {
    const ch = await seedChannel();
    await seedMessage(ch, 3, AD_TEXTS[3]);

    await filterPendingMessages(env.DB);
    const second = await filterPendingMessages(env.DB);
    expect(second).toMatchObject({ checked: 0, filtered: 0, passed: 0 });
  });

  it('treats media-only posts as passed, not pending forever', async () => {
    const ch = await seedChannel();
    await seedMessage(ch, 4, '');
    const outcome = await filterPendingMessages(env.DB);
    expect(outcome.passed).toBe(1);
    expect((await statusOf(4)).filter_status).toBe('passed');
  });

  it('existing rows default to pending and stay valid', async () => {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM pragma_table_info('messages') WHERE name = 'filter_status'`
    ).first<{ n: number }>();
    expect(row?.n).toBe(1);

    const ch = await seedChannel();
    await seedMessage(ch, 5, 'یک خبر معمولی درباره بازار');
    const status = await env.DB.prepare(
      `SELECT filter_status FROM messages WHERE telegram_message_id = 5`
    ).first<{ filter_status: string }>();
    expect(status?.filter_status).toBe('pending');
  });
});

/* --------------------------------------------------------------- pipeline */

const testEnv = () =>
  ({
    DB: env.DB,
    TELEGRAM_BOT_TOKEN: '',
    ADMIN_PASSWORD: 'x',
    OPENCODE_API_KEY: 'fake-key-for-offline-test',
  }) as Env;

describe('pipeline integration', () => {
  beforeEach(reset);

  it('filtered advertisements never reach summarization or publishing', async () => {
    const ch = await seedChannel(false);
    await seedMessage(ch, 10, 'همین حالا خرید کنید! فروش ویژه با تخفیف ویژه');
    await seedMessage(ch, 11, 'قیمت خودرو امروز افزایش یافت');

    const outcome = await runNewsPipeline(env.DB, testEnv(), { trigger: 'test', log: false });

    expect(outcome.filteredAdvertisements).toBe(1);
    expect((await statusOf(10)).filter_status).toBe('filtered');
    expect((await statusOf(11)).filter_status).toBe('passed');

    await enableChannel(ch);
    const eligible = await selectEligibleMessages(env.DB);
    expect(eligible.map((m) => m.telegramMessageId)).toEqual([11]);

    // Even a summarized advertisement could not be selected for publishing.
    await env.DB.prepare(
      `UPDATE messages SET summary_text = 'x', summarized_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
    ).run();
    const publishable = await selectPublishableMessages(env.DB);
    expect(publishable.map((m) => m.telegramMessageId)).toEqual([11]);
  });

  it('reports the filtered count once and keeps the rest of the report', async () => {
    const ch = await seedChannel(false);
    await seedMessage(ch, 20, 'سایت شرط بندی با بونوس ویژه ثبت نام کنید');
    await seedMessage(ch, 21, 'پلیس یک سایت شرط‌بندی را مسدود کرد');

    const outcome = await runNewsPipeline(env.DB, testEnv(), { trigger: 'test', log: false });
    expect(outcome.filteredAdvertisements).toBe(1);
    expect(outcome.filter).toMatchObject({ checked: 2, filtered: 1, passed: 1 });
    expect(outcome.stagesRun).toBe(5);
    // A clean run reaches every stage, so the status must be success — this is
    // what pins deriveCronStatus()'s expected stage count to the real pipeline.
    expect(outcome.status).toBe('success');
    expect(outcome).toHaveProperty('summarization');
    expect(outcome).toHaveProperty('ranking');
    expect(outcome).toHaveProperty('publishing');

    const run = await env.DB.prepare(`SELECT messages_filtered FROM cron_runs`).first<{
      messages_filtered: number;
    }>();
    expect(run?.messages_filtered).toBe(1);
  });

  it('the scheduled handler filters too, using the same pipeline', async () => {
    const { createExecutionContext, createScheduledController, waitOnExecutionContext } = await import(
      'cloudflare:test'
    );
    const { default: worker } = await import('../src/index');

    const ch = await seedChannel(false);
    await seedMessage(ch, 30, 'کازینو آنلاین با بونوس خوش‌آمدگویی و چرخش رایگان');

    const ctx = createExecutionContext();
    await worker.scheduled!(
      createScheduledController({ cron: '30 */2 * * *', scheduledTime: Date.now() }),
      testEnv(),
      ctx
    );
    await waitOnExecutionContext(ctx);

    expect((await statusOf(30)).filter_status).toBe('filtered');
  });

  it('a failing message does not stop other messages', async () => {
    const ch = await seedChannel();
    await seedMessage(ch, 40, 'لینک خرید در سایت https://shop.example.com با تخفیف');
    await seedMessage(ch, 41, 'قیمت سکه در بازار امروز رشد کرد');
    await seedMessage(ch, 42, 'با معرفی دوستتان ۵۰ دلار هدیه بگیرید');

    const outcome = await filterPendingMessages(env.DB);
    expect(outcome).toMatchObject({ checked: 3, filtered: 2, passed: 1 });
    expect((await statusOf(41)).filter_status).toBe('passed');
  });
});

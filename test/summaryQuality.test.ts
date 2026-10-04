import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stripExternalIdentifiers } from '../src/adFilter';
import { filterPendingMessages } from '../src/adFilterStage';
import { runSummarization } from '../src/summarizer';
import { buildChannelDigest } from '../src/publisher';

const NOW = Date.now();
const SOURCE = 'iran_efsha_news';

describe('external identifier stripping', () => {
  it('keeps the source channel identity', () => {
    const out = stripExternalIdentifiers(`خبر @${SOURCE} دربارهٔ بازار`, SOURCE);
    expect(out).toContain(`@${SOURCE}`);
  });

  it('removes any other @handle', () => {
    const out = stripExternalIdentifiers('خبر مهم @other_channel و @some_bot و @advertiser', SOURCE);
    expect(out).not.toMatch(/@other_channel|@some_bot|@advertiser/);
    expect(out).toContain('خبر مهم');
  });

  it.each([
    ['https://example.com/x', 'https://example.com'],
    ['http://example.com', 'http://example.com'],
    ['www.example.com', 'www.example.com'],
    ['example.com', 'example.com'],
    ['news.example.ir/path', 'example.ir'],
    ['https://t.me/otherchannel/12', 't.me'],
    ['t.me/otherchannel', 't.me'],
    ['telegram.me/otherchannel', 'telegram.me'],
    ['telegram.dog/otherchannel', 'telegram.dog'],
    ['https://eitaa.com/news/12345', 'eitaa.com'],
    ['eitaa.com/iran_efsha_news', 'eitaa.com'],
    ['https://instagram.com/brand', 'instagram.com'],
    ['https://wa.me/9712345', 'wa.me'],
    ['https://youtube.com/watch?v=x', 'youtube.com'],
    ['https://t.me/joinchat/AAAA', 'joinchat'],
    ['bit.ly/xyz', 'bit.ly'],
    ['tinyurl.com/abc', 'tinyurl.com'],
  ])('removes %s', (input, forbidden) => {
    const out = stripExternalIdentifiers(`متن خبر ${input} پایان`, SOURCE);
    expect(out).not.toContain(forbidden);
    expect(out).toContain('متن خبر');
  });

  it('removes every external link when several are present', () => {
    const out = stripExternalIdentifiers(
      'گزارش: eitaa.com/a https://t.me/x @bot_one instagram.com/y پایان',
      SOURCE
    );
    expect(out).not.toMatch(/eitaa|t\.me|@bot_one|instagram/);
    expect(out).toContain('گزارش');
    expect(out).toContain('پایان');
  });

  it('leaves legitimate news facts untouched', () => {
    const news =
      'در جلسهٔ امروز هیئت‌مدیرهٔ شرکت پتروشیمی با ۱۲۸ میلیارد تومان و ۱۵ درصد سود، ' +
      'در تاریخ ۱۲ آبان، دربارهٔ صادرات به عراق و تهران و شرکت ملی نفت صحبت شد؛ تلفن ۰۲۱-۱۲۳۴۵۶۷۸.';
    expect(stripExternalIdentifiers(news, SOURCE)).toBe(news);
  });

  it('handles empty and non-string input safely', () => {
    expect(stripExternalIdentifiers('', SOURCE)).toBe('');
    expect(stripExternalIdentifiers(undefined as unknown as string, SOURCE)).toBe('');
  });

  it('keeps the raw post url available in the database untouched', async () => {
    await env.DB.prepare(`DELETE FROM messages`).run();
    await env.DB.prepare(`DELETE FROM channels`).run();
    const ch = await env.DB.prepare(
      `INSERT INTO channels (channel_username, enabled) VALUES (?1, 1)`
    ).bind(SOURCE).run();
    const channelId = Number(ch.meta.last_row_id);
    await env.DB.prepare(
      `INSERT INTO messages (source_channel_id, telegram_message_id, message_date, message_text, source_url)
       VALUES (?1, 1, ?2, 'خبر @other با لینک https://eitaa.com/z', 'https://t.me/${SOURCE}/1')`
    ).bind(channelId, new Date(NOW).toISOString()).run();

    await filterPendingMessages(env.DB);

    const row = await env.DB.prepare(
      `SELECT message_text, source_url, filter_status FROM messages`
    ).first<{ message_text: string; source_url: string; filter_status: string }>();
    // Deduplication/tracking data preserved even though the AI never sees it.
    expect(row!.source_url).toBe(`https://t.me/${SOURCE}/1`);
    expect(row!.filter_status).toBe('passed');
  });
});

async function reset() {
  await env.DB.prepare(`DELETE FROM messages`).run();
  await env.DB.prepare(`DELETE FROM channels`).run();
  await env.DB.prepare(`DELETE FROM cron_runs`).run();
  await env.DB.prepare(`DELETE FROM ai_settings`).run();
}

describe('summarizer input hygiene', () => {
  beforeEach(reset);

  async function seedAndCapture(text: string) {
    const ch = await env.DB.prepare(
      `INSERT INTO channels (channel_username, enabled) VALUES (?1, 1)`
    ).bind(SOURCE).run();
    const channelId = Number(ch.meta.last_row_id);
    await env.DB.prepare(
      `INSERT INTO messages (source_channel_id, telegram_message_id, message_date, message_text, source_url)
       VALUES (?1, 1, ?2, ?3, ?4)`
    )
      .bind(channelId, new Date(NOW - 60_000).toISOString(), text, `https://t.me/${SOURCE}/1`)
      .run();

    let sent: { text: string } | null = null;
    const fetchImpl = vi.fn(async (url: unknown) => {
      if (String(url).endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'alpha-free' }] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'خلاصه خبر بدون هیچ فراداده‌ای.' } }] }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    await runSummarization(env.DB, {
      apiKey: 'offline-test-key',
      fetchImpl,
      now: NOW,
    });

    // Capture the user message actually sent to the model.
    for (const call of (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls) {
      const init = call[1] as RequestInit | undefined;
      if (!init?.body) continue;
      const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] };
      sent = { text: body.messages.find((m) => m.role === 'user')!.content };
    }
    return sent?.text ?? '';
  }

  it('never sends external links or foreign handles to the model', async () => {
    const userContent = await seedAndCapture(
      `گزارش روز ${SOURCE} در سایت eitaa.com/x و @other_channel و https://t.me/joinchat/AAA منتشر شد.`
    );

    expect(userContent).not.toMatch(/eitaa\.com|@other_channel|t\.me|joinchat/);
    // The news words themselves are still there.
    expect(userContent).toContain('گزارش روز');
  });

  it('never tells the model the channel name, post date or message id', async () => {
    const userContent = await seedAndCapture('متن سادهٔ خبر بدون هیچ لینکی.');

    expect(userContent).not.toContain(SOURCE);
    expect(userContent).not.toMatch(/post_date|message_id|channel=/);
    expect(userContent).not.toContain(new Date(NOW - 60_000).toISOString());
    // The body is still passed for summarization.
    expect(userContent).toContain('متن سادهٔ خبر');
  });

  it('asks for rich summaries of long news instead of one short line', async () => {
    const userContent = await seedAndCapture(
      'خبر بلند دربارهٔ بستهٔ حمایتی، بودجه و واکنش بازار با جزئیات زیاد و اعداد متعدد و تاریخ‌های مشخص و علت و نتیجه.'
    );

    // The per-message contract now asks for a Persian title + summary as JSON
    // (migration from the old "write a Persian summary" wording).
    expect(userContent).toContain('این متن را طبق قرارداد JSON به عنوان و خلاصهٔ فارسی تبدیل کن.');
    expect(userContent).not.toMatch(/۱ تا ۴ جمله|یک جملهٔ کوتاه بنویس/);
  });
});

describe('digest never carries source metadata into the body', () => {
  it('renders summaries only, then the two footer lines', () => {
    const parts = buildChannelDigest(SOURCE, '@destination', [
      { id: 1, summaryText: 'امام جمعه مشهد اعلام کرد که مراسم برگزار می‌شود.' },
      {
        id: 2,
        summaryText:
          'همزمان وزیر راه از باز شدن ۲۰ کیلومتر مسیر جدید خبر داد که درآمدزایی سالانهٔ آن ۴۰ میلیارد تومان است و به ۱۲ روستا می‌رسد.',
      },
    ]);

    const text = parts[0].text;
    expect(text).toContain('📰 <b>خبر عمومی</b>\n📝 <b>خلاصه:</b> امام جمعه مشهد اعلام کرد که مراسم برگزار می‌شود.');
    expect(text).toContain('🏛️ <b>خبر سیاست</b>\n📝 <b>خلاصه:</b> همزمان وزیر راه از باز شدن ۲۰ کیلومتر مسیر جدید خبر داد');
    expect(text).toContain(`📡 <i>منبع: @${SOURCE}</i>\n📣 <i>@destination</i>`);
    expect(text).not.toMatch(/t\.me|eitaa|published a post|post titled/);
  });
});
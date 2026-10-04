import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildChannelDigest,
  channelDisplayName,
  destinationLabel,
  groupByChannel,
  isValidArticleUrl,
  isValidBaleDestination,
  MAX_MESSAGES_PER_RUN,
  publishMessageBudget,
  resolveBaleDelivery,
  runPublishing,
  selectPublishableMessages,
  sourceLabel,
  type PublishableMessage,
} from '../src/publisher';
import { isValidDestinationChat } from '../src/telegram';
import { runNewsPipeline } from '../src/pipeline';
import type { Env } from '../src/types';

const NOW = Date.now();

async function reset() {
  await env.DB.prepare(`DELETE FROM messages`).run();
  await env.DB.prepare(`DELETE FROM channels`).run();
  await env.DB.prepare(`DELETE FROM cron_runs`).run();
  await env.DB.prepare(`DELETE FROM ai_settings`).run();
}

async function seedChannel(username: string, enabled = true) {
  const r = await env.DB.prepare(`INSERT INTO channels (channel_username, enabled) VALUES (?1, ?2)`)
    .bind(username, enabled ? 1 : 0)
    .run();
  return Number(r.meta.last_row_id);
}

/** One summarized, unpublished news row. */
async function seedNews(
  channelId: number,
  channelUsername: string,
  telegramId: number,
  summary: string,
  minutesAgo = 10
) {
  const r = await env.DB.prepare(
    `INSERT INTO messages (source_channel_id, telegram_message_id, message_date, message_text, source_url, summary_text, summarized_at)
     VALUES (?1, ?2, ?3, 'متن خام که نباید منتشر شود', ?4, ?5, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
  )
    .bind(
      channelId,
      telegramId,
      new Date(NOW - minutesAgo * 60_000).toISOString(),
      `https://t.me/${channelUsername}/${telegramId}`,
      summary
    )
    .run();
  return Number(r.meta.last_row_id);
}

/** Records every text sent to Telegram, in order. */
function telegramRecorder(ok: (text: string) => boolean = () => true, status = 200) {
  const sent: { text: string; messageId: number }[] = [];
  const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { text: string };
    if (!ok(body.text)) {
      return new Response(JSON.stringify({ ok: false, description: 'Bad Request' }), { status });
    }
    sent.push({ text: body.text, messageId: 1000 + sent.length });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1000 + sent.length, date: 1 } }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

function expectRichDigest(
  text: string,
  summaries: string[],
  source: string,
  destination = '@destination'
): void {
  for (const summary of summaries) {
    expect(text).toContain(`📰 <b>خبر عمومی</b>\n📝 <b>خلاصه:</b> ${summary}`);
  }
  expect(text).toContain(`📡 <i>منبع: ${source}</i>`);
  if (destination) expect(text).toContain(`📣 <i>${destination}</i>`);
  expect(text).not.toContain('https://');
}

const envFor = () =>
  ({ DB: env.DB, TELEGRAM_BOT_TOKEN: 'T', ADMIN_PASSWORD: 'x' }) as Env;

async function publishedRows() {
  const { results } = await env.DB.prepare(
    `SELECT id, published_at, telegram_destination_message_id FROM messages ORDER BY id`
  ).all<{ id: number; published_at: string | null; telegram_destination_message_id: number | null }>();
  return results ?? [];
}

describe('digest formatting', () => {
  it('groups summaries in order and ends with source + destination footer', () => {
    const parts = buildChannelDigest('news1', '@destination', [
      { id: 1, summaryText: 'خبر اول' },
      { id: 2, summaryText: 'خبر دوم' },
      { id: 3, summaryText: 'خبر سوم' },
    ]);

    expect(parts).toHaveLength(1);
    expectRichDigest(parts[0].text, ['خبر اول', 'خبر دوم', 'خبر سوم'], '@news1');
    expect(parts[0].itemIds).toEqual([1, 2, 3]);
  });

  it('exposes no ids, model names, filter data, URLs or raw post text', () => {
    const text = buildChannelDigest('news1', '@destination', [{ id: 7, summaryText: 'خلاصه خبر' }])[0].text;
    expectRichDigest(text, ['خلاصه خبر'], '@news1');
    expect(text).not.toMatch(/🔗|https?:\/\/|t\.me|eitaa\.com|\bid\b|free|score|مدل|published a post/);
  });

  it('renders the AI title, topic emoji, key points and escaped detail as HTML', () => {
    const [part] = buildChannelDigest('tech_news', '@destination', [
      {
        id: 1,
        title: 'افشای <نسخه> جدید',
        category: 'technology',
        summaryText: 'جزئیات خبر با مقدار A & B.',
        highlights: ['نکته اول', 'نکته دوم'],
      },
    ]);

    expect(part.text).toContain('💻 <b>افشای &lt;نسخه&gt; جدید</b>');
    expect(part.text).toContain('📝 <b>خلاصه:</b> جزئیات خبر با مقدار A &amp; B.');
    expect(part.text).toContain('🔎 <b>نکات مهم:</b> نکته اول · نکته دوم');
    expect(part.text).toContain('📡 <i>منبع: @tech_news</i>');
  });

  it('splits oversized output without cutting a summary and keeps the footer', () => {
    const long = 'الف'.repeat(1500); // sanitized down to the 1200-char cap
    const parts = buildChannelDigest('news1', '@destination', [
      { id: 1, summaryText: long },
      { id: 2, summaryText: long },
      { id: 3, summaryText: long },
      { id: 4, summaryText: long },
    ]);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.text.length).toBeLessThanOrEqual(4096);
      // Every part carries the required footer and no header.
      expect(part.text).toContain('📡 <i>منبع: @news1</i>');
      expect(part.text).toContain('📣 <i>@destination</i>');
      // No summary was cut in half: every body line is a whole summary.
      for (const chunk of part.text.split('منبع:')[0].trim().split('\n\n')) {
        if (!chunk.includes('📝')) continue;
        expect(chunk).toContain(long.slice(0, 100));
      }
    }
    expect(parts.flatMap((p) => p.itemIds)).toEqual([1, 2, 3, 4]);
    expect(parts[0].text).toContain(long.slice(0, 1000));
  });

  it('keeps a single oversized summary intact rather than dropping it', () => {
    const parts = buildChannelDigest('news1', '@destination', [{ id: 1, summaryText: 'ب'.repeat(5000) }]);
    expect(parts).toHaveLength(1);
    expect(parts[0].itemIds).toEqual([1]);
    expect(parts[0].text.length).toBeLessThanOrEqual(4096);
    expect(parts[0].text).toContain('📡 <i>منبع: @news1</i>\n📣 <i>@destination</i>');
  });
});

describe('grouping', () => {
  const item = (channelId: number, username: string, id: number): PublishableMessage => ({
    id,
    channelId,
    channelUsername: username,
    channelTitle: null,
    sourceType: 'telegram',
    telegramMessageId: id,
    summaryText: 'x',
    title: null,
    importance: null,
    messageDate: '2026-10-02T11:00:00.000Z',
    sourceUrl: `https://t.me/${username}/${id}`,
  });

  it('groups by channel and keeps channel order then chronological order', () => {
    const groups = groupByChannel([
      item(2, 'b', 20),
      item(1, 'a', 11),
      item(1, 'a', 10),
    ]);
    expect(groups.map((g) => g.channelUsername)).toEqual(['b', 'a']);
    expect(groups[1].items.map((i) => i.id)).toEqual([11, 10]);
  });
});

describe('publishing one message per channel', () => {
  beforeEach(reset);

  it('one channel with several news produces exactly one message', async () => {
    const ch = await seedChannel('news1');
    await seedNews(ch, 'news1', 1, 'خبر اول');
    await seedNews(ch, 'news1', 2, 'خبر دوم');
    await seedNews(ch, 'news1', 3, 'خبر سوم');

    const t = telegramRecorder();
    const report = await runPublishing(env.DB, { token: 'T', destination: '@destination', fetchImpl: t.fetchImpl });

    expect(report.published).toBe(3);
    expect(t.sent).toHaveLength(1);
    expectRichDigest(t.sent[0].text, ['خبر اول', 'خبر دوم', 'خبر سوم'], '@news1');
    expect((await publishedRows()).every((r) => r.published_at !== null)).toBe(true);
    expect((await publishedRows()).every((r) => r.telegram_destination_message_id === 1001)).toBe(true);
  });

  it('three channels produce three messages, skipping the empty one, in order', async () => {
    const a = await seedChannel('news1');
    const b = await seedChannel('news2');
    const c = await seedChannel('news3');

    await seedNews(a, 'news1', 1, 'خبر ۱');
    await seedNews(a, 'news1', 2, 'خبر ۲');
    await seedNews(a, 'news1', 3, 'خبر ۳');
    // news2 gets no news at all.
    await seedNews(c, 'news3', 10, 'خبر الف');
    await seedNews(c, 'news3', 11, 'خبر ب');

    const t = telegramRecorder();
    const report = await runPublishing(env.DB, { token: 'T', destination: '@destination', fetchImpl: t.fetchImpl });

    expect(report.published).toBe(5);
    expect(t.sent).toHaveLength(2);
    expectRichDigest(t.sent[0].text, ['خبر ۱', 'خبر ۲', 'خبر ۳'], '@news1');
    expectRichDigest(t.sent[1].text, ['خبر الف', 'خبر ب'], '@news3');
    expect(t.sent.map((s) => s.text.includes('@news2'))).toEqual([false, false]);
    void b;
  });

  it('never merges different channels into one message', async () => {
    const a = await seedChannel('alpha');
    const b = await seedChannel('beta_channel');
    await seedNews(a, 'alpha', 1, 'الف');
    await seedNews(b, 'beta_channel', 2, 'ب');

    const t = telegramRecorder();
    await runPublishing(env.DB, { token: 'T', destination: '@destination', fetchImpl: t.fetchImpl });

    expect(t.sent).toHaveLength(2);
    for (const s of t.sent) {
      expect(s.text).not.toMatch(/@alpha[\s\S]*@beta|@beta[\s\S]*@alpha/);
    }
  });

  it('orders channels by configured order and news oldest-first', async () => {
    const a = await seedChannel('first_chan');
    const b = await seedChannel('second_chan');
    // Insert newest first so a naive implementation would reverse them.
    await seedNews(a, 'first_chan', 2, 'دوم', 5);
    await seedNews(a, 'first_chan', 1, 'اول', 50);
    await seedNews(b, 'second_chan', 3, 'تنها', 5);

    const t = telegramRecorder();
    await runPublishing(env.DB, { token: 'T', destination: '@destination', fetchImpl: t.fetchImpl });

    expect(t.sent).toHaveLength(2);
    expectRichDigest(t.sent[0].text, ['اول', 'دوم'], '@first_chan');
    expectRichDigest(t.sent[1].text, ['تنها'], '@second_chan');
  });

  it('an oversized channel is split into several messages, never merged with another', async () => {
    const a = await seedChannel('big_chan');
    const b = await seedChannel('small_chan');
    // Summaries are capped at 1200 chars each, so 8 of them overflow 4096.
    const long = 'الف'.repeat(1500);
    for (let i = 1; i <= 8; i++) await seedNews(a, 'big_chan', i, long);
    await seedNews(b, 'small_chan', 99, 'کوچک');

    const t = telegramRecorder();
    const report = await runPublishing(env.DB, { token: 'T', destination: '@destination', fetchImpl: t.fetchImpl });

    expect(report.published).toBe(9);
    const bigParts = t.sent.filter((s) => s.text.includes('@big_chan'));
    const smallParts = t.sent.filter((s) => s.text.includes('@small_chan'));
    expect(bigParts.length).toBeGreaterThan(1);
    expect(smallParts).toHaveLength(1);
    for (const s of t.sent) {
      expect(s.text.includes('@big_chan') && s.text.includes('@small_chan')).toBe(false);
      expect(s.text.length).toBeLessThanOrEqual(4096);
    }
    // Every item was delivered exactly once across this channel's parts.
    expect(report.published).toBe(9);
    const delivered = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE published_at IS NOT NULL`
    ).first<{ n: number }>();
    expect(delivered?.n).toBe(9);
    // Continuation parts stay on the same channel, in order.
    expect(bigParts.every((p) => p.text.includes('📡 <i>منبع: @big_chan</i>'))).toBe(true);
  });

  it('a failed delivery marks nothing published and keeps rows for retry', async () => {
    const ch = await seedChannel('fail_chan');
    await seedNews(ch, 'fail_chan', 1, 'الف');
    await seedNews(ch, 'fail_chan', 2, 'ب');

    const t = telegramRecorder(() => false, 400);
    const report = await runPublishing(env.DB, { token: 'T', destination: '@destination', fetchImpl: t.fetchImpl });

    expect(report.published).toBe(0);
    expect(report.failures).toHaveLength(2);
    expect(report.failures.every((f) => f.category === 'telegram_error')).toBe(true);

    const rows = await publishedRows();
    expect(rows.every((r) => r.published_at === null)).toBe(true);
    const errs = await env.DB.prepare(`SELECT last_publish_error, publish_attempts FROM messages`).all<{
      last_publish_error: string;
      publish_attempts: number;
    }>();
    expect(errs.results.every((e) => e.last_publish_error === 'telegram_error')).toBe(true);
    expect(errs.results.every((e) => e.publish_attempts === 1)).toBe(true);
  });

  it('429 stops the pass and leaves everything unpublished', async () => {
    const a = await seedChannel('rl_alpha');
    const b = await seedChannel('rl_beta');
    await seedNews(a, 'rl_alpha', 1, 'الف');
    await seedNews(b, 'rl_beta', 2, 'ب');

    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return new Response(
        JSON.stringify({ ok: false, description: 'Too Many Requests', parameters: { retry_after: 30 } }),
        { status: 429 }
      );
    }) as unknown as typeof fetch;

    const report = await runPublishing(env.DB, { token: 'T', destination: '@destination', fetchImpl });

    expect(report.rateLimited).toBe(true);
    expect(report.published).toBe(0);
    expect(calls).toBe(1);
    expect(report.failures[0].retryAfterSeconds).toBe(30);
    expect((await publishedRows()).every((r) => r.published_at === null)).toBe(true);
  });

  it('marks published only after delivery, and never twice', async () => {
    const ch = await seedChannel('once_chan');
    await seedNews(ch, 'once_chan', 1, 'الف');

    const t = telegramRecorder();
    await runPublishing(env.DB, { token: 'T', destination: '@destination', fetchImpl: t.fetchImpl });
    const second = await runPublishing(env.DB, { token: 'T', destination: '@destination', fetchImpl: t.fetchImpl });

    expect(t.sent).toHaveLength(1);
    expect(second.published).toBe(0);
    expect(second.eligible).toBe(0);
    expect((await selectPublishableMessages(env.DB))).toHaveLength(0);
  });

  it('skips disabled channels and filtered advertisements', async () => {
    const on = await seedChannel('on_chan');
    const off = await seedChannel('off_chan', false);
    await seedNews(on, 'on_chan', 1, 'مجاز');
    const badId = await seedNews(off, 'off_chan', 2, 'غیرمجاز');
    await env.DB.prepare(`UPDATE messages SET filter_status = 'filtered' WHERE id = ?1`).bind(badId).run();
    await env.DB.prepare(`UPDATE channels SET enabled = 1 WHERE id = ?1`).bind(off).run();

    const t = telegramRecorder();
    await runPublishing(env.DB, { token: 'T', destination: '@destination', fetchImpl: t.fetchImpl });

    expect(t.sent).toHaveLength(1);
    expectRichDigest(t.sent[0].text, ['مجاز'], '@on_chan');
  });

  it('does not publish rows whose stored source link is unusable', async () => {
    const ch = await seedChannel('url_chan');
    const bad = await seedNews(ch, 'url_chan', 1, 'بدون لینک');
    await env.DB.prepare(`UPDATE messages SET source_url = 'https://evil.test/x/1' WHERE id = ?1`).bind(bad).run();

    const t = telegramRecorder();
    const report = await runPublishing(env.DB, { token: 'T', destination: '@destination', fetchImpl: t.fetchImpl });

    expect(t.sent).toHaveLength(0);
    expect(report.failures[0].category).toBe('invalid_source_url');
  });
});

describe('RSS-sourced news', () => {
  beforeEach(reset);

  async function seedRssChannel(id: number, title: string) {
    const r = await env.DB.prepare(
      `INSERT INTO channels (channel_username, channel_title, enabled, source_type) VALUES (?1, ?2, 1, 'rss')`
    )
      .bind(`rss_${id}`, title)
      .run();
    return Number(r.meta.last_row_id);
  }

  async function seedRssNews(channelId: number, telegramId: number, summary: string, url: string) {
    const r = await env.DB.prepare(
      `INSERT INTO messages (source_channel_id, telegram_message_id, message_date, message_text, source_url, summary_text, summarized_at)
       VALUES (?1, ?2, ?3, 'متن خام', ?4, ?5, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    )
      .bind(channelId, telegramId, new Date(NOW - 600_000).toISOString(), url, summary)
      .run();
    return Number(r.meta.last_row_id);
  }

  it('publishes RSS rows whose source link is a normal https article URL', async () => {
    const ch = await seedRssChannel(1, 'بی‌بی‌سی فارسی');
    await seedRssNews(ch, 1, 'خلاصهٔ خبر آر‌اس‌اس', 'https://www.bbc.com/persian/articles/c1234567890o');

    const t = telegramRecorder();
    const report = await runPublishing(env.DB, { token: 'T', destination: '@destination', fetchImpl: t.fetchImpl });

    expect(report.published).toBe(1);
    expect(report.failures).toHaveLength(0);
    expect(t.sent).toHaveLength(1);
    // The footer uses the feed's display title, never the internal rss_N
    // username and never an invented @ in front of Persian text.
    expectRichDigest(t.sent[0].text, ['خلاصهٔ خبر آر‌اس‌اس'], 'بی‌بی‌سی فارسی');
    expect(t.sent[0].text).not.toContain('rss_');
  });

  it('still rejects RSS rows whose stored link is not a valid https URL', async () => {
    const ch = await seedRssChannel(2, 'زومیت');
    await seedRssNews(ch, 1, 'خبر با لینک خراب', 'http://insecure.example.com/a');
    await seedRssNews(ch, 2, 'خبر بدون لینک معتبر', 'not a url');

    const t = telegramRecorder();
    const report = await runPublishing(env.DB, { token: 'T', destination: '@destination', fetchImpl: t.fetchImpl });

    expect(t.sent).toHaveLength(0);
    expect(report.published).toBe(0);
    expect(report.failures.map((f) => f.category)).toEqual(['invalid_source_url', 'invalid_source_url']);
  });

  it('keeps requiring t.me links for Telegram-sourced rows', async () => {
    const ch = await seedChannel('tg_chan');
    const bad = await seedNews(ch, 'tg_chan', 1, 'خبر تلگرامی');
    await env.DB.prepare(`UPDATE messages SET source_url = 'https://example.com/a' WHERE id = ?1`).bind(bad).run();

    const t = telegramRecorder();
    const report = await runPublishing(env.DB, { token: 'T', destination: '@destination', fetchImpl: t.fetchImpl });

    expect(t.sent).toHaveLength(0);
    expect(report.failures[0].category).toBe('invalid_source_url');
  });

  it('validates article URLs strictly', () => {
    expect(isValidArticleUrl('https://www.bbc.com/persian/articles/x')).toBe(true);
    expect(isValidArticleUrl('https://zoomit.ir/2026/a-b-c/')).toBe(true);
    expect(isValidArticleUrl('http://www.bbc.com/persian')).toBe(false); // not https
    expect(isValidArticleUrl('https://localhost/x')).toBe(false); // no dot in host
    expect(isValidArticleUrl('https://a.b/ x')).toBe(false); // whitespace
    expect(isValidArticleUrl('')).toBe(false);
    expect(isValidArticleUrl(`https://a.ir/${'x'.repeat(2050)}`)).toBe(false); // too long
  });

  it('prefers the feed title as the display name for RSS channels', () => {
    expect(
      channelDisplayName({ channelUsername: 'rss_3', channelTitle: 'بی‌بی‌سی فارسی', sourceType: 'rss' })
    ).toBe('بی‌بی‌سی فارسی');
    // Telegram channels keep the username-first behavior.
    expect(
      channelDisplayName({ channelUsername: 'news_one', channelTitle: 'عنوان', sourceType: 'telegram' })
    ).toBe('news_one');
    // RSS without a title falls back to the internal username, never invents one.
    expect(channelDisplayName({ channelUsername: 'rss_9', channelTitle: null, sourceType: 'rss' })).toBe('rss_9');
  });

  it('labels ASCII usernames with @ and display titles verbatim', () => {
    expect(sourceLabel('news_one')).toBe('@news_one');
    expect(sourceLabel('بی‌بی‌سی فارسی')).toBe('بی‌بی‌سی فارسی');
  });
});

describe('final channel message format', () => {
  it('has no header and ends with exactly one منبع footer plus the destination', () => {
    const text = buildChannelDigest('news_one', '@destination', [
      { id: 1, summaryText: 'خبر اول' },
      { id: 2, summaryText: 'خبر دوم' },
      { id: 3, summaryText: 'خبر سوم' },
    ])[0].text;

    expectRichDigest(text, ['خبر اول', 'خبر دوم', 'خبر سوم'], '@news_one');
    // Exactly one source footer, destination immediately below it.
    expect(text.match(/منبع:/g)).toHaveLength(1);
    expect(text).toContain('📡 <i>منبع: @news_one</i>\n📣 <i>@destination</i>');
  });

  it('never repeats the source channel after individual summaries', () => {
    const text = buildChannelDigest('chan_two', '@destination', [
      { id: 1, summaryText: 'الف' },
      { id: 2, summaryText: 'ب' },
    ])[0].text;
    // The only mention is in the footer.
    const body = text.slice(0, text.indexOf('منبع:'));
    expect(body).not.toContain('@chan_two');
    expect(text.match(/@chan_two/g)).toHaveLength(1);
  });

  it('contains no forbidden content', () => {
    const text = buildChannelDigest('clean_chan', '@destination', [{ id: 9, summaryText: 'خلاصه' }])[0].text;
    expect(text).not.toMatch(
      /🔗|https?:\/\/|t\.me|telegram\.me|telegram\.dog|eitaa\.com|instagram|wa\.me|youtube|bit\.ly|joinchat|www\.|\bid\b|free|score|مدل|published a post|این پست|کانال مذکور|بیان می‌کند/
    );
  });

  it('uses the real source channel and the configured destination, never hardcoded', () => {
    const a = buildChannelDigest('alpha_chan', '@first_dest', [{ id: 1, summaryText: 'x' }])[0].text;
    const b = buildChannelDigest('beta_channel', '@second_dest', [{ id: 2, summaryText: 'x' }])[0].text;
    expect(a).toContain('منبع: @alpha_chan');
    expect(a).toContain('@first_dest');
    expect(a).not.toContain('beta_channel');
    expect(b).toContain('منبع: @beta_channel');
    expect(b).toContain('@second_dest');
  });

  it('normalizes the destination for display without changing the send target', () => {
    expect(destinationLabel('@dest_channel')).toBe('@dest_channel');
    expect(destinationLabel('dest_channel')).toBe('@dest_channel');
    expect(destinationLabel('  @dest_channel  ')).toBe('@dest_channel');
    // A numeric channel id is printed as configured; no invented handle.
    expect(destinationLabel('-1001234567890')).toBe('-1001234567890');
    expect(destinationLabel(undefined)).toBe('');
    // The value actually sent to Telegram stays exactly as configured.
    expect(isValidDestinationChat('-1001234567890')).toBe(true);
  });

  it('omits the destination line only when nothing is configured', () => {
    const text = buildChannelDigest('chan_three', '', [{ id: 1, summaryText: 'الف' }])[0].text;
    expectRichDigest(text, ['الف'], '@chan_three', '');
  });

  it('counts footer lines in the 4096 limit', () => {
    const long = 'الف'.repeat(1500);
    const parts = buildChannelDigest(
      'limit_chan',
      '@destination',
      [1, 2, 3, 4, 5].map((id) => ({ id, summaryText: long }))
    );

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.text.length).toBeLessThanOrEqual(4096);
      expect(part.text).toContain('📡 <i>منبع: @limit_chan</i>');
    }
    expect(parts.flatMap((p) => p.itemIds)).toEqual([1, 2, 3, 4, 5]);
  });

  it('handles a single summary too long to fit, keeping the footer', () => {
    const parts = buildChannelDigest('huge_chan', '@destination', [
      { id: 1, summaryText: 'ب'.repeat(20_000) },
    ]);
    expect(parts).toHaveLength(1);
    expect(parts[0].text.length).toBeLessThanOrEqual(4096);
    expect(parts[0].text).toContain('📡 <i>منبع: @huge_chan</i>');
    expect(parts[0].itemIds).toEqual([1]);
  });

  it('falls back to the configured title only when no username exists', () => {
    expect(channelDisplayName({ channelUsername: '', channelTitle: 'عنوان' })).toBe('عنوان');
    expect(channelDisplayName({ channelUsername: 'user_chan', channelTitle: 'عنوان' })).toBe('user_chan');
    // No identifier at all => nothing is published rather than a broken label.
    expect(buildChannelDigest('', '@destination', [{ id: 1, summaryText: 'x' }])).toEqual([]);
  });
});
describe('per-run limits', () => {
  beforeEach(reset);

  it('does not postpone current-window news because of a per-run row cap', async () => {
    const ch = await seedChannel('busy_chan');
    // Far more than the old per-channel cap of 50.
    for (let i = 1; i <= 60; i++) await seedNews(ch, 'busy_chan', i, `خبر ${i}`);

    const t = telegramRecorder();
    const report = await runPublishing(env.DB, { token: 'T', destination: '@destination', fetchImpl: t.fetchImpl });

    expect(report.published).toBe(60);
    const rows = await publishedRows();
    expect(rows.filter((r) => r.published_at !== null)).toHaveLength(60);
    // Everything is delivered, oldest first, in as few messages as needed.
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].text).toContain('خبر 1');
    expect(t.sent[0].text).toContain('خبر 60');
  });

  it('covers all channels across runs without ever dropping one', async () => {
    for (let i = 1; i <= 18; i++) {
      const name = `many_chan_${i}`;
      const ch = await seedChannel(name);
      await seedNews(ch, name, 1, `خبر ${i}`);
    }

    // 18 enabled channels leave a smaller publish budget than 18 (the platform
    // subrequest limit is shared with collection and summarization), so run one
    // publishes the first channels in order and defers the rest explicitly.
    const t = telegramRecorder();
    const first = await runPublishing(env.DB, { token: 'T', destination: '@destination', fetchImpl: t.fetchImpl });

    expect(t.sent).toHaveLength(publishMessageBudget(18));
    expect(t.sent[0].text).toContain('@many_chan_1');
    expect(first.failures.some((f) => f.category === 'run_limit')).toBe(true);

    // The follow-up run drains the deferred channels in the same order.
    const t2 = telegramRecorder();
    await runPublishing(env.DB, { token: 'T', destination: '@destination', fetchImpl: t2.fetchImpl });

    const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages WHERE published_at IS NULL`).first<{ n: number }>();
    expect(left?.n).toBe(0);
    // Every channel appeared exactly once across the two runs, in order.
    const delivered = [...t.sent, ...t2.sent].map((s) => s.text.match(/@many_chan_\d+/)?.[0]);
    expect(delivered).toEqual(
      Array.from({ length: 18 }, (_, i) => `@many_chan_${i + 1}`)
    );
  });

  it('stops at the documented message bound and records the remainder explicitly', async () => {
    const ch = await seedChannel('bound_chan');
    // Each summary sanitizes to 1200 chars, so many parts are produced.
    const long = 'الف'.repeat(1500);
    for (let i = 1; i <= 200; i++) await seedNews(ch, 'bound_chan', i, long);

    const t = telegramRecorder();
    const report = await runPublishing(env.DB, { token: 'T', destination: '@destination', fetchImpl: t.fetchImpl });

    const budget = publishMessageBudget(1);
    expect(t.sent.length).toBe(budget);
    expect(t.sent.length).toBeLessThanOrEqual(MAX_MESSAGES_PER_RUN);
    // The rest is recorded, not silently dropped.
    const notPublished = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE published_at IS NULL AND last_publish_error = 'run_limit'`
    ).first<{ n: number }>();
    expect(notPublished!.n).toBeGreaterThan(0);
    expect(report.failures.some((f) => f.category === 'run_limit')).toBe(true);

    // Repeated runs drain the backlog completely — nothing is lost or duplicated.
    let totalPublished = report.published;
    for (let run = 0; run < 10; run++) {
      const t2 = telegramRecorder();
      const next = await runPublishing(env.DB, { token: 'T', destination: '@destination', fetchImpl: t2.fetchImpl });
      totalPublished += next.published;
      const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages WHERE published_at IS NULL`).first<{ n: number }>();
      if ((left?.n ?? 0) === 0) break;
    }
    expect(totalPublished).toBe(200);
    const stillUnpublished = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE published_at IS NULL`
    ).first<{ n: number }>();
    expect(stillUnpublished?.n).toBe(0);
    // Each item was delivered exactly once.
    const publishedRows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE published_at IS NOT NULL`
    ).first<{ n: number }>();
    expect(publishedRows?.n).toBe(200);
  });
});

describe('subrequest budget', () => {
  beforeEach(reset);

  it('derives the budget from the Free subrequest limit and the enabled channels', () => {
    // 50 total - summarize(20) - model list(1) - collection(1 per channel)
    expect(publishMessageBudget(0)).toBe(27);
    expect(publishMessageBudget(5)).toBe(22);
    expect(publishMessageBudget(10)).toBe(17);
    // Always at least one message, so publishing never stalls completely.
    expect(publishMessageBudget(1000)).toBe(1);
    // Never above the hard ceiling.
    expect(publishMessageBudget(0)).toBeLessThanOrEqual(MAX_MESSAGES_PER_RUN);
  });

  it('stays inside the budget and records the remainder instead of overflowing', async () => {
    const long = 'الف'.repeat(1500);
    // 5 enabled channels, each needing several messages.
    for (let c = 1; c <= 5; c++) {
      const name = `budget_chan_${c}`;
      const ch = await seedChannel(name);
      for (let i = 1; i <= 40; i++) await seedNews(ch, name, c * 100 + i, long);
    }

    const t = telegramRecorder();
    const report = await runPublishing(env.DB, { token: 'T', destination: '@destination', fetchImpl: t.fetchImpl });

    // Budget for 5 enabled channels is 24; the run must not exceed it.
    expect(t.sent.length).toBeLessThanOrEqual(publishMessageBudget(5));
    expect(report.failures.some((f) => f.category === 'run_limit')).toBe(true);

    // Collection + summarization + publishing now fit the 50-subrequest budget.
    const totalFetches = 5 + 20 + t.sent.length;
    expect(totalFetches).toBeLessThanOrEqual(50);

    // A later run continues with the deferred backlog.
    const t2 = telegramRecorder();
    const next = await runPublishing(env.DB, { token: 'T', destination: '@destination', fetchImpl: t2.fetchImpl });
    expect(next.published).toBeGreaterThan(0);
  });
});

describe('manual processing uses the same behavior', () => {
  beforeEach(reset);

  it('the shared pipeline wires the same publisher (one message per channel)', async () => {
    // Channels stay disabled so the collect stage never touches the network;
    // the publish stage is the very same runPublishing() used by manual runs.
    const a = await seedChannel('manual_a', false);
    const b = await seedChannel('manual_b', false);
    await seedNews(a, 'manual_a', 1, 'الف');
    await seedNews(a, 'manual_a', 2, 'ب');
    await seedNews(b, 'manual_b', 3, 'ج');

    const t = telegramRecorder();
    const outcome = await runNewsPipeline(env.DB, envFor(), { trigger: 'manual', log: false });

    // Stage ran, produced no candidates while the channels were disabled.
    expect(outcome.publishing).not.toBeNull();
    expect(outcome.publishing!.published).toBe(0);
    expect(t.sent).toHaveLength(0);

    // Once the channels are enabled (as they are in production), the exact same
    // stage groups them per channel in configured order.
    await env.DB.prepare(`UPDATE channels SET enabled = 1`).run();
    const grouped = groupByChannel(await selectPublishableMessages(env.DB));
    expect(grouped.map((g) => g.channelUsername)).toEqual(['manual_a', 'manual_b']);
    expect(grouped.map((g) => g.items.length)).toEqual([2, 1]);

    const report = await runPublishing(env.DB, {
      token: 'T',
      destination: '@destination',
      fetchImpl: t.fetchImpl,
    });
    expect(report.published).toBe(3);
    expect(t.sent).toHaveLength(2);
    expectRichDigest(t.sent[0].text, ['الف', 'ب'], '@manual_a');
    expectRichDigest(t.sent[1].text, ['ج'], '@manual_b');
  });
});

describe('Bale mirror', () => {
  const BALE = { token: 'bale-token', destination: '@bale_dest' };

  beforeEach(reset);

  it('validates Bale destinations', () => {
    expect(isValidBaleDestination('@chan')).toBe(true);
    expect(isValidBaleDestination('@Chan_123')).toBe(true);
    expect(isValidBaleDestination('-1001234567890')).toBe(true);
    expect(isValidBaleDestination('12345')).toBe(true);
    expect(isValidBaleDestination('not a channel')).toBe(false);
    expect(isValidBaleDestination('@a')).toBe(false);
  });

  it('resolves only when both Bale secrets are set', () => {
    expect(
      resolveBaleDelivery({ BALE_BOT_TOKEN: 't', BALE_DESTINATION_CHANNEL: '@chan' } as never)
    ).toEqual({ token: 't', destination: '@chan' });
    expect(resolveBaleDelivery({ BALE_BOT_TOKEN: 't' } as never)).toBeNull();
    expect(resolveBaleDelivery({ BALE_DESTINATION_CHANNEL: '@chan' } as never)).toBeNull();
    expect(
      resolveBaleDelivery({ BALE_BOT_TOKEN: 't', BALE_DESTINATION_CHANNEL: 'bad value' } as never)
    ).toBeNull();
  });

  /** Distinguishes Bale (tapi.bale.ai) from Telegram (api.telegram.org) calls. */
  function dualHarness(baleStatus = 200) {
    const baleTexts: string[] = [];
    const balePhotos: number[] = [];
    const telegramTexts: string[] = [];
    const telegramPhotos: number[] = [];
    const fetchMock = vi.fn(async (url: unknown) => {
      const href = String(url);
      const ok = href.includes('tapi.bale.ai') ? baleStatus < 400 : true;
      if (href.includes('tapi.bale.ai') && href.includes('sendPhoto')) {
        if (ok) balePhotos.push(1);
        return new Response(ok ? '{}' : 'err', { status: baleStatus });
      }
      if (href.includes('tapi.bale.ai') && href.includes('sendMessage')) {
        if (ok) baleTexts.push('x');
        return new Response(ok ? '{}' : 'err', { status: baleStatus });
      }
      if (href.includes('sendPhoto')) {
        telegramPhotos.push(1);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 501 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      telegramTexts.push('x');
      return new Response(JSON.stringify({ ok: true, result: { message_id: 601 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return {
      fetchImpl: fetchMock as unknown as typeof fetch,
      fetchMock,
      baleTexts,
      balePhotos,
      telegramTexts,
      telegramPhotos,
    };
  }

  async function seedTwoChannels() {
    const a = await env.DB.prepare(
      `INSERT INTO channels (channel_username, enabled) VALUES ('bale_a', 1)`
    ).run();
    const b = await env.DB.prepare(
      `INSERT INTO channels (channel_username, enabled) VALUES ('bale_b', 1)`
    ).run();
    for (const [cid, username, tid] of [
      [Number(a.meta.last_row_id), 'bale_a', 1],
      [Number(b.meta.last_row_id), 'bale_b', 2],
    ]) {
      await env.DB.prepare(
        `INSERT INTO messages (source_channel_id, telegram_message_id, message_date, message_text, source_url, summary_text, summarized_at)
         VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'body', ?3, 'خلاصه خبر.', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
      )
        .bind(cid, tid, `https://t.me/${username}/${tid}`)
        .run();
    }
  }

  it('mirrors the image and every delivered digest to Bale', async () => {
    await seedTwoChannels();
    const h = dualHarness();
    const report = await runPublishing(env.DB, {
      token: 'T',
      destination: '@destination',
      fetchImpl: h.fetchImpl,
      bale: BALE,
    });

    // No browser binding configured: text-only run, but still mirrored.
    expect(h.telegramTexts).toHaveLength(2);
    expect(h.baleTexts).toHaveLength(2);
    expect(report.published).toBe(2);
    expect(report.bale).toEqual({ sent: 2, failed: 0 });
  });

  it('mirrors the image when Browser Run is configured', async () => {
    await seedTwoChannels();
    const h = dualHarness();
    const browser = {
      quickAction: async () =>
        new Response(fakePngBytes(), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
    };
    const report = await runPublishing(env.DB, {
      token: 'T',
      destination: '@destination',
      fetchImpl: h.fetchImpl,
      browser,
      bale: BALE,
    });

    expect(h.telegramPhotos).toHaveLength(1);
    expect(h.balePhotos).toHaveLength(1);
    expect(h.baleTexts).toHaveLength(2);
    expect(report.bale).toEqual({ sent: 3, failed: 0 });
  });

  it('a Bale failure never blocks Telegram publishing', async () => {
    await seedTwoChannels();
    const h = dualHarness(500);
    const report = await runPublishing(env.DB, {
      token: 'T',
      destination: '@destination',
      fetchImpl: h.fetchImpl,
      bale: BALE,
    });

    expect(report.published).toBe(2);
    expect(report.bale).toEqual({ sent: 0, failed: 2 });
    expect(h.telegramTexts).toHaveLength(2);
  });

  it('calls the standard Bale bot API, never the business endpoint', async () => {
    await seedTwoChannels();
    const h = dualHarness();
    await runPublishing(env.DB, {
      token: 'T',
      destination: '@destination',
      fetchImpl: h.fetchImpl,
      bale: BALE,
    });

    const baleCalls = (h.fetchMock as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes('tapi.bale.ai'));
    expect(baleCalls.length).toBeGreaterThan(0);
    for (const url of baleCalls) {
      // The /business/bot base is restricted to bulk-messaging accounts and
      // rejects normal bot tokens — it must never be used for the mirror.
      expect(url.startsWith(`https://tapi.bale.ai/bot${BALE.token}/`)).toBe(true);
      expect(url).not.toContain('/business/');
      expect(url).not.toContain('%3A');
    }
  });

  it('makes no Bale calls when the mirror is not configured', async () => {
    await seedTwoChannels();
    const h = dualHarness();
    const report = await runPublishing(env.DB, {
      token: 'T',
      destination: '@destination',
      fetchImpl: h.fetchImpl,
    });
    expect(report.bale).toBeUndefined();
    const called = (h.fetchMock as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      String(c[0])
    );
    expect(called.every((u) => !u.includes('tapi.bale.ai'))).toBe(true);
  });
});

/** Minimal valid PNG header for the Browser Run fake. */
function fakePngBytes(): ArrayBuffer {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 1920);
  view.setUint32(20, 1080);
  return bytes.buffer;
}

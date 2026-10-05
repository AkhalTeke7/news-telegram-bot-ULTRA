import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  channelDisplayName,
  isValidArticleUrl,
  isValidBaleDestination,
  MAX_ALBUM_SUBREQUESTS,
  resolveBaleDelivery,
  runPublishing,
  selectPublishableMessages,
} from '../src/publisher';
import { MAX_ALBUM_NEWS, MAX_ALBUM_SLIDES, MAX_IMAGE_ITEMS } from '../src/newsImage';
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

/** Minimal valid PNG header for the Browser Run fake. */
function fakePngBytes(): ArrayBuffer {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 2560);
  view.setUint32(20, 1440);
  return bytes.buffer;
}

/**
 * Records every Telegram call: album sends with their media payload, photo
 * sends, and — the thing this bot must never do again — text messages.
 */
function harness(opts: { sendStatus?: number; retryAfter?: number } = {}) {
  const browser = {
    quickAction: vi.fn(
      async () =>
        new Response(fakePngBytes(), { status: 200, headers: { 'content-type': 'image/png' } })
    ),
  };

  const albums: { media: { caption?: string }[] }[] = [];
  const photos: { caption?: string }[] = [];
  const texts: string[] = [];
  const baleCalls: { url: string; caption?: string }[] = [];
  let messageId = 500;

  const fetchImpl = vi.fn(async (url: unknown, init: RequestInit) => {
    const href = String(url);
    const status = opts.sendStatus ?? 200;
    const body = init?.body;

    if (href.includes('tapi.bale.ai')) {
      const form = body instanceof FormData ? body : null;
      baleCalls.push({ url: href, caption: form?.get('caption')?.toString() });
      return new Response('{}', { status: 200 });
    }

    if (href.includes('sendMediaGroup')) {
      const form = body as FormData;
      const media = JSON.parse(String(form.get('media'))) as { caption?: string }[];
      albums.push({ media });
      if (status >= 400) {
        return new Response(
          JSON.stringify({
            ok: false,
            description: 'Bad Request',
            ...(opts.retryAfter ? { parameters: { retry_after: opts.retryAfter } } : {}),
          }),
          { status, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({ ok: true, result: media.map(() => ({ message_id: ++messageId, date: 1 })) }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (href.includes('sendPhoto')) {
      const form = body as FormData;
      photos.push({ caption: form.get('caption')?.toString() });
      if (status >= 400) {
        return new Response(JSON.stringify({ ok: false, description: 'Bad Request' }), { status });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: ++messageId, date: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // Any OTHER Bot API call is a text message — recorded so a regression
    // fails loudly. Non-Telegram URLs (channel previews fetched by the
    // collector) are answered with an empty page instead.
    if (href.includes('api.telegram.org')) {
      texts.push(href);
      return new Response(JSON.stringify({ ok: true, result: { message_id: ++messageId, date: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('<html><body></body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  }) as unknown as typeof fetch;

  return { browser, fetchImpl, albums, photos, texts, baleCalls };
}

const envFor = () => ({ DB: env.DB, TELEGRAM_BOT_TOKEN: 'T', ADMIN_PASSWORD: 'x' }) as Env;

async function publishedRows() {
  const { results } = await env.DB.prepare(
    `SELECT id, published_at, telegram_destination_message_id FROM messages ORDER BY id`
  ).all<{ id: number; published_at: string | null; telegram_destination_message_id: number | null }>();
  return results ?? [];
}

/* ------------------------------------------------------- album geometry -- */

describe('album geometry', () => {
  it('publishes twelve news as six pictures of two', () => {
    expect(MAX_IMAGE_ITEMS).toBe(2);
    expect(MAX_ALBUM_SLIDES).toBe(6);
    expect(MAX_ALBUM_NEWS).toBe(12);
    // Six renders plus one send: comfortably inside the Workers Free budget.
    expect(MAX_ALBUM_SUBREQUESTS).toBe(7);
    // Telegram refuses a media group larger than ten photos.
    expect(MAX_ALBUM_SLIDES).toBeLessThanOrEqual(10);
  });
});

/* ----------------------------------------------------- pictures, no text -- */

describe('publishing is pictures only', () => {
  beforeEach(reset);

  it('sends ONE album and not a single text message', async () => {
    const a = await seedChannel('news_a');
    const b = await seedChannel('news_b');
    for (let i = 1; i <= 3; i++) {
      await seedNews(a, 'news_a', i, `خبر شمارهٔ ${i} از کانال اول.`, 30 - i);
      await seedNews(b, 'news_b', 10 + i, `خبر شمارهٔ ${10 + i} از کانال دوم.`, 20 - i);
    }

    const h = harness();
    const report = await runPublishing(env.DB, {
      token: 'T',
      destination: '@destination',
      fetchImpl: h.fetchImpl,
      browser: h.browser,
      now: new Date(NOW),
    });

    // Six news → three pictures → exactly one album, zero text messages.
    expect(h.browser.quickAction).toHaveBeenCalledTimes(3);
    expect(h.albums).toHaveLength(1);
    expect(h.albums[0].media).toHaveLength(3);
    expect(h.texts).toHaveLength(0);
    expect(report.image?.slides).toBe(3);
    expect(report.image?.selected).toBe(6);
    expect(report.published).toBe(6);
  });

  it('carries one short date caption on the first photo only', async () => {
    const ch = await seedChannel('cap_chan');
    for (let i = 1; i <= 4; i++) await seedNews(ch, 'cap_chan', i, `خبر شمارهٔ ${i} برای کپشن.`, i);

    const h = harness();
    await runPublishing(env.DB, {
      token: 'T',
      destination: '@destination',
      fetchImpl: h.fetchImpl,
      browser: h.browser,
      now: new Date(NOW),
    });

    const media = h.albums[0].media;
    expect(media.filter((m) => m.caption !== undefined)).toHaveLength(1);
    const caption = media[0].caption!;
    expect(caption.startsWith('📰 اخبار لحظه‌ای —')).toBe(true);
    // A date line and nothing else: no headline, no source, no link.
    expect(caption.split('\n')).toHaveLength(1);
    expect(caption).not.toContain('خبر شمارهٔ');
    expect(caption).not.toContain('منبع');
    expect(caption).not.toContain('http');
    expect(caption.length).toBeLessThanOrEqual(1024);
  });

  it('never sends more than the album capacity and keeps the rest pending', async () => {
    const ch = await seedChannel('many_chan');
    for (let i = 1; i <= MAX_ALBUM_NEWS + 4; i++) {
      await seedNews(ch, 'many_chan', i, `خبر شمارهٔ ${i} از صف طولانی.`, 60 - i);
    }

    const h = harness();
    const report = await runPublishing(env.DB, {
      token: 'T',
      destination: '@destination',
      fetchImpl: h.fetchImpl,
      browser: h.browser,
      now: new Date(NOW),
    });

    expect(h.albums[0].media).toHaveLength(MAX_ALBUM_SLIDES);
    expect(report.published).toBe(MAX_ALBUM_NEWS);
    // The leftovers are untouched — no failure, no publish — so the next run
    // picks them up in the same importance order.
    const pending = (await publishedRows()).filter((r) => r.published_at === null);
    expect(pending).toHaveLength(4);
    expect(report.failures).toHaveLength(0);
  });

  it('marks rows published only after Telegram confirms, pointing at the album', async () => {
    const ch = await seedChannel('mark_chan');
    await seedNews(ch, 'mark_chan', 1, 'خبر اول برای ثبت انتشار.');
    await seedNews(ch, 'mark_chan', 2, 'خبر دوم برای ثبت انتشار.');

    const h = harness();
    const report = await runPublishing(env.DB, {
      token: 'T',
      destination: '@destination',
      fetchImpl: h.fetchImpl,
      browser: h.browser,
    });

    const rows = await publishedRows();
    expect(rows.every((r) => r.published_at !== null)).toBe(true);
    expect(new Set(rows.map((r) => r.telegram_destination_message_id)).size).toBe(1);
    expect(report.published).toBe(2);

    // A second run has nothing left to publish and spends no Browser Run.
    const second = harness();
    const again = await runPublishing(env.DB, {
      token: 'T',
      destination: '@destination',
      fetchImpl: second.fetchImpl,
      browser: second.browser,
    });
    expect(again.published).toBe(0);
    expect(second.browser.quickAction).not.toHaveBeenCalled();
  });

  it('publishes nothing — and no text fallback — when Browser Run is missing', async () => {
    const ch = await seedChannel('no_browser');
    await seedNews(ch, 'no_browser', 1, 'خبری که تصویر ندارد.');

    const h = harness();
    const report = await runPublishing(env.DB, {
      token: 'T',
      destination: '@destination',
      fetchImpl: h.fetchImpl,
    });

    expect(h.texts).toHaveLength(0);
    expect(h.albums).toHaveLength(0);
    expect(report.published).toBe(0);
    expect(report.image).toBeUndefined();
    const rows = await publishedRows();
    expect(rows.every((r) => r.published_at === null)).toBe(true);
  });

  it('a failed album marks nothing and records the rows for retry', async () => {
    const ch = await seedChannel('fail_chan');
    await seedNews(ch, 'fail_chan', 1, 'خبر اول.');
    await seedNews(ch, 'fail_chan', 2, 'خبر دوم.');
    await seedNews(ch, 'fail_chan', 3, 'خبر سوم.');
    await seedNews(ch, 'fail_chan', 4, 'خبر چهارم.');

    const h = harness({ sendStatus: 400 });
    const report = await runPublishing(env.DB, {
      token: 'T',
      destination: '@destination',
      fetchImpl: h.fetchImpl,
      browser: h.browser,
    });

    expect(report.published).toBe(0);
    expect(report.image?.sent).toBe(false);
    expect(report.failures.map((f) => f.category)).toEqual([
      'telegram_error',
      'telegram_error',
      'telegram_error',
      'telegram_error',
    ]);
    const rows = await publishedRows();
    expect(rows.every((r) => r.published_at === null)).toBe(true);
  });

  it('a 429 stops the pass and leaves everything unpublished', async () => {
    const ch = await seedChannel('rate_chan');
    await seedNews(ch, 'rate_chan', 1, 'خبر یک.');
    await seedNews(ch, 'rate_chan', 2, 'خبر دو.');
    await seedNews(ch, 'rate_chan', 3, 'خبر سه.');
    await seedNews(ch, 'rate_chan', 4, 'خبر چهار.');

    const h = harness({ sendStatus: 429, retryAfter: 17 });
    const report = await runPublishing(env.DB, {
      token: 'T',
      destination: '@destination',
      fetchImpl: h.fetchImpl,
      browser: h.browser,
    });

    expect(report.rateLimited).toBe(true);
    expect(report.published).toBe(0);
    expect(report.failures.every((f) => f.category === 'rate_limited')).toBe(true);
    const rows = await publishedRows();
    expect(rows.every((r) => r.published_at === null)).toBe(true);
  });

  it('a single surviving picture is sent as a plain photo with the same caption', async () => {
    const ch = await seedChannel('solo_chan');
    await seedNews(ch, 'solo_chan', 1, 'تنها خبر این اجرا.');

    const h = harness();
    const report = await runPublishing(env.DB, {
      token: 'T',
      destination: '@destination',
      fetchImpl: h.fetchImpl,
      browser: h.browser,
      now: new Date(NOW),
    });

    // A media group needs two photos, so one picture goes as sendPhoto.
    expect(h.albums).toHaveLength(0);
    expect(h.photos).toHaveLength(1);
    expect(h.photos[0].caption?.startsWith('📰 اخبار لحظه‌ای —')).toBe(true);
    expect(h.texts).toHaveLength(0);
    expect(report.published).toBe(1);
  });

  it('skips disabled channels, filtered ads and unusable source links', async () => {
    const good = await seedChannel('good_chan');
    const off = await seedChannel('off_chan', false);
    await seedNews(good, 'good_chan', 1, 'خبر سالم.');
    await seedNews(off, 'off_chan', 2, 'خبر کانال غیرفعال.');
    const ad = await seedNews(good, 'good_chan', 3, 'تبلیغ.');
    await env.DB.prepare(`UPDATE messages SET filter_status = 'filtered' WHERE id = ?1`).bind(ad).run();
    const broken = await seedNews(good, 'good_chan', 4, 'خبر با لینک نامعتبر.');
    await env.DB.prepare(`UPDATE messages SET source_url = 'https://evil.test/x/1' WHERE id = ?1`)
      .bind(broken)
      .run();

    const h = harness();
    const report = await runPublishing(env.DB, {
      token: 'T',
      destination: '@destination',
      fetchImpl: h.fetchImpl,
      browser: h.browser,
    });

    expect(report.published).toBe(1);
    expect(report.failures.map((f) => f.category)).toEqual(['invalid_source_url']);
  });

  it('retires rows the AI scored as not newsworthy instead of queueing them forever', async () => {
    const ch = await seedChannel('rank_chan');
    const keep = await seedNews(ch, 'rank_chan', 1, 'خبر مهم.');
    const drop = await seedNews(ch, 'rank_chan', 2, 'خبر بی‌اهمیت.');
    await env.DB.prepare(`UPDATE messages SET importance = 5 WHERE id = ?1`).bind(keep).run();
    await env.DB.prepare(`UPDATE messages SET importance = 1 WHERE id = ?1`).bind(drop).run();

    const h = harness();
    const report = await runPublishing(env.DB, {
      token: 'T',
      destination: '@destination',
      fetchImpl: h.fetchImpl,
      browser: h.browser,
    });

    expect(report.published).toBe(1);
    expect(report.retired).toBe(1);
    // Retiring is not a failure, and the row never comes back as a candidate.
    expect(report.failures).toHaveLength(0);
    const row = await env.DB.prepare(`SELECT filter_status, filter_reason FROM messages WHERE id = ?1`)
      .bind(drop)
      .first<{ filter_status: string; filter_reason: string | null }>();
    expect(row?.filter_status).toBe('filtered');
    expect(row?.filter_reason).toBe('low_importance');
    expect((await selectPublishableMessages(env.DB)).map((i) => i.id)).not.toContain(drop);
  });
});

/* --------------------------------------------------------- source links -- */

describe('source links and display names', () => {
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

    const h = harness();
    const report = await runPublishing(env.DB, {
      token: 'T',
      destination: '@destination',
      fetchImpl: h.fetchImpl,
      browser: h.browser,
    });

    expect(report.published).toBe(1);
    expect(report.failures).toHaveLength(0);
    expect(h.photos).toHaveLength(1);
  });

  it('still rejects RSS rows whose stored link is not a valid https URL', async () => {
    const ch = await seedRssChannel(2, 'زومیت');
    await seedRssNews(ch, 1, 'خبر با لینک خراب', 'http://insecure.example.com/a');
    await seedRssNews(ch, 2, 'خبر بدون لینک معتبر', 'not a url');

    const h = harness();
    const report = await runPublishing(env.DB, {
      token: 'T',
      destination: '@destination',
      fetchImpl: h.fetchImpl,
      browser: h.browser,
    });

    expect(report.published).toBe(0);
    expect(report.failures.map((f) => f.category)).toEqual(['invalid_source_url', 'invalid_source_url']);
  });

  it('keeps requiring t.me links for Telegram-sourced rows', async () => {
    const ch = await seedChannel('tg_chan');
    const bad = await seedNews(ch, 'tg_chan', 1, 'خبر تلگرامی');
    await env.DB.prepare(`UPDATE messages SET source_url = 'https://example.com/a' WHERE id = ?1`)
      .bind(bad)
      .run();

    const h = harness();
    const report = await runPublishing(env.DB, {
      token: 'T',
      destination: '@destination',
      fetchImpl: h.fetchImpl,
      browser: h.browser,
    });

    expect(report.published).toBe(0);
    expect(report.failures[0].category).toBe('invalid_source_url');
  });

  it('validates article URLs strictly', () => {
    expect(isValidArticleUrl('https://www.bbc.com/persian/articles/x')).toBe(true);
    expect(isValidArticleUrl('https://zoomit.ir/2026/a-b-c/')).toBe(true);
    expect(isValidArticleUrl('http://www.bbc.com/persian')).toBe(false); // not https
    expect(isValidArticleUrl('https://localhost/x')).toBe(false); // no dot in host
    expect(isValidArticleUrl('not a url')).toBe(false);
  });

  it('prefers the feed title as the display name for RSS channels', () => {
    expect(
      channelDisplayName({ channelUsername: 'rss_3', channelTitle: 'بی‌بی‌سی فارسی', sourceType: 'rss' })
    ).toBe('بی‌بی‌سی فارسی');
    expect(
      channelDisplayName({ channelUsername: 'news_one', channelTitle: 'عنوان', sourceType: 'telegram' })
    ).toBe('news_one');
    expect(channelDisplayName({ channelUsername: 'rss_9', channelTitle: null, sourceType: 'rss' })).toBe(
      'rss_9'
    );
    expect(channelDisplayName({ channelUsername: '', channelTitle: 'عنوان' })).toBe('عنوان');
  });

  it('validates the destination chat', () => {
    expect(isValidDestinationChat('@my_channel')).toBe(true);
    expect(isValidDestinationChat('-1001234567890')).toBe(true);
    expect(isValidDestinationChat('nonsense value')).toBe(false);
  });
});

/* --------------------------------------------------------------- pipeline -- */

describe('manual processing uses the same behavior', () => {
  beforeEach(reset);

  it('the shared pipeline publishes the album and no text message', async () => {
    const ch = await seedChannel('pipe_chan');
    await seedNews(ch, 'pipe_chan', 1, 'خبر خط لوله یک.');
    await seedNews(ch, 'pipe_chan', 2, 'خبر خط لوله دو.');
    await seedNews(ch, 'pipe_chan', 3, 'خبر خط لوله سه.');

    const h = harness();
    // The pipeline uses global fetch; channel previews answer with an empty
    // page so the collect stage finds nothing new.
    vi.stubGlobal('fetch', h.fetchImpl);
    try {
      const outcome = await runNewsPipeline(
        env.DB,
        {
          ...envFor(),
          TELEGRAM_DESTINATION_CHANNEL: '@destination',
          BROWSER: h.browser,
          IMAGE_RENDER_SPACING_MS: '0',
        } as unknown as Env,
        { trigger: 'manual', log: false }
      );

      expect(outcome.publishing?.published).toBe(3);
      expect(outcome.publishing?.image).toMatchObject({ sent: true, slides: 2 });
      // Two pictures, one album, and not one text message.
      expect(h.albums).toHaveLength(1);
      expect(h.albums[0].media).toHaveLength(2);
      expect(h.texts).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the pipeline report explains WHY publishing failed (failure categories)', async () => {
    const a = await seedChannel('pub_a');
    await seedNews(a, 'pub_a', 1, 'خبر معتبر.');
    // Two summarized rows whose stored source links are unusable forever.
    for (const id of [7, 8]) {
      await env.DB.prepare(
        `INSERT INTO messages (source_channel_id, telegram_message_id, message_date, message_text, source_url, summary_text, summarized_at, filter_status)
         VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'body', 'broken-link', 'خلاصه.', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'passed')`
      )
        .bind(a, id)
        .run();
    }

    const h = harness();
    vi.stubGlobal('fetch', h.fetchImpl);
    try {
      const outcome = await runNewsPipeline(
        env.DB,
        { ...envFor(), TELEGRAM_DESTINATION_CHANNEL: '@destination' } as Env,
        { trigger: 'manual', log: false }
      );

      expect(outcome.publishing?.failureCategories).toEqual({ invalid_source_url: 2 });
      // No Browser Run binding: nothing is published at all, because pictures
      // are the only output — and no text is sent as a consolation prize.
      expect(outcome.publishing?.published).toBe(0);
      expect(outcome.publishing?.image).toMatchObject({
        sent: false,
        reason: 'browser_binding_missing',
      });
      expect(h.texts).toHaveLength(0);
      expect(h.albums).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/* ------------------------------------------------------------ Bale mirror -- */

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

  it('mirrors the pictures as separate photos, because Bale has no album', async () => {
    const ch = await seedChannel('bale_chan');
    for (let i = 1; i <= 4; i++) await seedNews(ch, 'bale_chan', i, `خبر شمارهٔ ${i} برای بله.`, i);

    const h = harness();
    const report = await runPublishing(env.DB, {
      token: 'T',
      destination: '@destination',
      fetchImpl: h.fetchImpl,
      browser: h.browser,
      bale: BALE,
      now: new Date(NOW),
    });

    // Four news → two pictures → one Telegram album, two Bale photos.
    expect(h.albums[0].media).toHaveLength(2);
    expect(h.baleCalls).toHaveLength(2);
    expect(h.baleCalls.every((c) => c.url.includes('/sendPhoto'))).toBe(true);
    // Same single caption as Telegram, on the first photo only; no text posts.
    expect(h.baleCalls[0].caption?.startsWith('📰 اخبار لحظه‌ای —')).toBe(true);
    expect(h.baleCalls[1].caption).toBeUndefined();
    expect(h.baleCalls.some((c) => c.url.includes('sendMessage'))).toBe(false);
    expect(report.bale).toEqual({ sent: 2, failed: 0 });
  });

  it('a Bale failure never blocks Telegram publishing', async () => {
    const ch = await seedChannel('bale_fail');
    await seedNews(ch, 'bale_fail', 1, 'خبر یک.');
    await seedNews(ch, 'bale_fail', 2, 'خبر دو.');

    const browser = {
      quickAction: async () =>
        new Response(fakePngBytes(), { status: 200, headers: { 'content-type': 'image/png' } }),
    };
    const fetchImpl = vi.fn(async (url: unknown) => {
      const href = String(url);
      if (href.includes('tapi.bale.ai')) return new Response('err', { status: 500 });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7, date: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const report = await runPublishing(env.DB, {
      token: 'T',
      destination: '@destination',
      fetchImpl,
      browser,
      bale: BALE,
    });

    expect(report.published).toBe(2);
    expect(report.bale).toEqual({ sent: 0, failed: 1 });
  });

  it('calls the standard Bale bot API, never the business endpoint', async () => {
    const ch = await seedChannel('bale_api');
    await seedNews(ch, 'bale_api', 1, 'خبر یک.');
    await seedNews(ch, 'bale_api', 2, 'خبر دو.');

    const h = harness();
    await runPublishing(env.DB, {
      token: 'T',
      destination: '@destination',
      fetchImpl: h.fetchImpl,
      browser: h.browser,
      bale: BALE,
    });

    expect(h.baleCalls.length).toBeGreaterThan(0);
    for (const call of h.baleCalls) {
      // The /business/bot base is restricted to bulk-messaging accounts and
      // rejects normal bot tokens — it must never be used for the mirror.
      expect(call.url.startsWith(`https://tapi.bale.ai/bot${BALE.token}/`)).toBe(true);
      expect(call.url).not.toContain('/business/');
      expect(call.url).not.toContain('%3A');
    }
  });

  it('makes no Bale calls when the mirror is not configured', async () => {
    const ch = await seedChannel('bale_off');
    await seedNews(ch, 'bale_off', 1, 'خبر یک.');

    const h = harness();
    const report = await runPublishing(env.DB, {
      token: 'T',
      destination: '@destination',
      fetchImpl: h.fetchImpl,
      browser: h.browser,
    });

    expect(report.bale).toBeUndefined();
    expect(h.baleCalls).toHaveLength(0);
  });
});

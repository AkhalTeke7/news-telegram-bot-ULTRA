import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runPublishing, type PublishableMessage } from '../src/publisher';
import {
  buildAlbumCaption,
  buildAlbumCaptions,
  buildImageHtml,
  buildRunFrame,
  buildSourceFooter,
  deriveCardTitle,
  faDigits,
  IMAGE_HEIGHT,
  IMAGE_WIDTH,
  MAX_IMAGE_ITEMS,
  MAX_TICKER_ITEMS,
  renderRunAlbum,
  renderRunImage,
  selectTickerNews,
  selectTopNews,
  NewsImageError,
  TICKER_MAX_CHARS,
} from '../src/newsImage';

const NOW = Date.now();

async function reset() {
  await env.DB.prepare(`DELETE FROM messages`).run();
  await env.DB.prepare(`DELETE FROM channels`).run();
  await env.DB.prepare(`DELETE FROM cron_runs`).run();
  await env.DB.prepare(`DELETE FROM ai_settings`).run();
}

async function seedChannel(username: string, enabled = true) {
  const r = await env.DB
    .prepare(`INSERT INTO channels (channel_username, enabled) VALUES (?1, ?2)`)
    .bind(username, enabled ? 1 : 0)
    .run();
  return Number(r.meta.last_row_id);
}

async function seedNews(
  channelId: number,
  username: string,
  telegramId: number,
  summary: string,
  minutesAgo = 10
) {
  const r = await env.DB.prepare(
    `INSERT INTO messages (source_channel_id, telegram_message_id, message_date, message_text, source_url, summary_text, summarized_at)
     VALUES (?1, ?2, ?3, 'body', ?4, ?5, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
  )
    .bind(
      channelId,
      telegramId,
      new Date(NOW - minutesAgo * 60_000).toISOString(),
      `https://t.me/${username}/${telegramId}`,
      summary
    )
    .run();
  return Number(r.meta.last_row_id);
}

/** Minimal valid 1920x1080 PNG header + payload. */
function fakePng(): ArrayBuffer {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, IMAGE_WIDTH);
  view.setUint32(20, IMAGE_HEIGHT);
  return bytes.buffer;
}

/** Records every Browser Run call and every Telegram call, in order. */
function harness(opts: { png?: ArrayBuffer; sendStatus?: number } = {}) {
  const order: string[] = [];
  const browserCalls: { html: string }[] = [];

  const browser = {
    quickAction: vi.fn(async (_action: string, payload: Record<string, unknown>) => {
      order.push('browser');
      browserCalls.push({ html: String(payload.html) });
      if (opts.png === null) return new Response('rate limited', { status: 429 });
      return new Response(opts.png ?? fakePng(), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }),
  };

  const texts: string[] = [];
  const photos: number[] = [];
  const groups: { captions: string[]; count: number }[] = [];
  let messageId = 100;
  const fetchImpl = vi.fn(async (url: unknown, init: RequestInit) => {
    const href = String(url);
    if (href.includes('sendMediaGroup')) {
      order.push('sendMediaGroup');
      const form = init.body as FormData;
      const media = JSON.parse(String(form.get('media'))) as { caption?: string }[];
      groups.push({
        captions: media.map((item) => item.caption ?? ''),
        count: media.length,
      });
      const status = opts.sendStatus ?? 200;
      return new Response(
        JSON.stringify({
          ok: status < 400,
          result: media.map(() => ({ message_id: ++messageId })),
          description: status < 400 ? undefined : 'failed',
        }),
        { status, headers: { 'content-type': 'application/json' } }
      );
    }
    if (href.includes('sendPhoto')) {
      order.push('sendPhoto');
      photos.push(1);
      const status = opts.sendStatus ?? 200;
      return new Response(
        JSON.stringify({
          ok: status < 400,
          result: { message_id: ++messageId },
          description: status < 400 ? undefined : 'failed',
        }),
        { status, headers: { 'content-type': 'application/json' } }
      );
    }
    if (href.includes('sendMessage') || href.includes('sendRichMessage')) {
      order.push('sendMessage');
      const body = JSON.parse(String(init.body)) as {
        text?: string;
        rich_message?: { html?: string };
      };
      texts.push(body.text ?? body.rich_message?.html ?? '');
      return new Response(JSON.stringify({ ok: true, result: { message_id: ++messageId } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  return {
    order,
    browserCalls,
    browser,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    texts,
    photos,
    groups,
  };
}

function row(over: Partial<PublishableMessage> & { id: number }): PublishableMessage {
  return {
    channelId: 1,
    channelUsername: 'news_one',
    channelTitle: null,
    telegramMessageId: over.id,
    summaryText: 'خلاصه خبر.',
    title: null,
    importance: null,
    messageDate: new Date(NOW).toISOString(),
    sourceUrl: `https://t.me/news_one/${over.id}`,
    ...over,
  } as PublishableMessage;
}

beforeEach(async () => {
  await reset();
});

describe('image source footer', () => {
  const mk = (channels: string[]) =>
    channels.map((c, i) => ({ id: i + 1, channelUsername: c, title: 'تیتر', summary: 'خلاصه' }));

  it('keeps the singular form when every item is from one channel', () => {
    expect(buildSourceFooter(mk(['news_alpha', 'news_alpha']))).toBe('منبع: @news_alpha');
  });

  it('lists every unique channel once when items span several channels', () => {
    const footer = buildSourceFooter(mk(['a_chan', 'b_chan', 'c_chan']));
    expect(footer).toBe('منابع: @a_chan · @b_chan · @c_chan');
    expect(footer.match(/@a_chan/g)).toHaveLength(1);
  });

  it('de-duplicates repeated channels', () => {
    const footer = buildSourceFooter(mk(['a_chan', 'b_chan', 'a_chan', 'b_chan']));
    expect(footer).toBe('منابع: @a_chan · @b_chan');
  });

  it('preserves first-appearance order among the selected items', () => {
    const footer = buildSourceFooter(mk(['zeta_chan', 'alpha_chan', 'zeta_chan']));
    expect(footer).toBe('منابع: @zeta_chan · @alpha_chan');
  });

  it('is empty when there are no items', () => {
    expect(buildSourceFooter([])).toBe('');
  });

  it('renders the multi-channel footer in the html and keeps per-card labels', () => {
    const frame = buildRunFrame(
      [
        { id: 1, channelUsername: 'chan_one', title: 'یک', summary: 'خلاصهٔ یک' },
        { id: 2, channelUsername: 'chan_two', title: 'دو', summary: 'خلاصهٔ دو' },
      ],
      new Date(NOW)
    );
    const html = buildImageHtml(frame);
    expect(html).toContain('منابع: @chan_one · @chan_two');
    // per-card labels unchanged
    expect(html).toContain('@chan_one');
    expect(html).toContain('@chan_two');
  });
});

describe('news selection', () => {
  it('ranks by AI importance, not by summary length or recency', () => {
    const items = [
      // shortest and oldest, but the AI scored it highest
      row({ id: 1, channelId: 1, channelUsername: 'a', summaryText: 'کوتاه.', importance: 5 }),
      // longest text, but only moderately important
      row({
        id: 2,
        channelId: 2,
        channelUsername: 'b',
        summaryText: 'خلاصه‌ای بسیار مفصل و کامل با جزئیات بسیار بیشتر و طولانی.',
        importance: 2,
      }),
    ];
    expect(selectTopNews(items).map((i) => i.id)).toEqual([1, 2]);
  });

  it('uses recency only as a tie-break between equal importance', () => {
    const items = [
      row({ id: 1, summaryText: 'الف.', importance: 3, messageDate: '2026-01-01T00:00:00.000Z' }),
      row({ id: 2, summaryText: 'ب.', importance: 3, messageDate: '2026-01-02T00:00:00.000Z' }),
    ];
    expect(selectTopNews(items).map((i) => i.id)).toEqual([2, 1]);
  });

  it('does not let channel order decide the ranking', () => {
    const items = [
      row({ id: 1, channelId: 1, channelUsername: 'a_first', importance: 1 }),
      row({ id: 2, channelId: 9, channelUsername: 'z_last', importance: 5 }),
    ];
    expect(selectTopNews(items)[0].channelUsername).toBe('z_last');
  });

  it('uses the AI title when present', () => {
    const [item] = selectTopNews([
      row({ id: 1, title: 'عنوان واقعی خبر', summaryText: 'خلاصهٔ خبر.' }),
    ]);
    expect(item.title).toBe('عنوان واقعی خبر');
  });

  it('falls back to a derived headline only for legacy rows without a title', () => {
    const [item] = selectTopNews([row({ id: 1, title: null, summaryText: 'خلاصهٔ خبر اصلی. ادامهٔ خبر.' })]);
    expect(item.title.length).toBeGreaterThan(0);
    expect('خلاصهٔ خبر اصلی. ادامهٔ خبر.'.startsWith(item.title)).toBe(true);
  });

  it('ignores channels with no news and still ranks the rest', () => {
    // channel 2 simply has no rows at all
    const items = [row({ id: 1, channelId: 1, channelUsername: 'only_channel', importance: 3 })];
    const top = selectTopNews(items);
    expect(top).toHaveLength(1);
    expect(top[0].channelUsername).toBe('only_channel');
  });

  it('never selects empty or blank summaries', () => {
    const items = [
      row({ id: 1, summaryText: '   ', importance: 5 }),
      row({ id: 2, summaryText: '', importance: 5 }),
      row({ id: 3, summaryText: 'خبر معتبر.', importance: 4 }),
    ];
    expect(selectTopNews(items).map((i) => i.id)).toEqual([3]);
  });

  it('excludes items the AI scored 1, keeping null-scored legacy rows', () => {
    const items = [
      row({ id: 1, summaryText: 'خبر کم‌اهمیت.', importance: 1 }),
      row({ id: 2, summaryText: 'خبر بدون امتیاز.', importance: null }),
      row({ id: 3, summaryText: 'خبر مهم.', importance: 3 }),
    ];
    expect(selectTopNews(items).map((i) => i.id)).toEqual([3, 2]);
  });

  it('is deterministic for equal importance and equal dates', () => {
    const items = [
      row({ id: 5, summaryText: 'یکسان', importance: 3 }),
      row({ id: 4, summaryText: 'یکسان', importance: 3 }),
    ];
    expect(selectTopNews(items).map((i) => i.id)).toEqual([4, 5]);
    expect(selectTopNews([...items].reverse()).map((i) => i.id)).toEqual([4, 5]);
  });

  it('uses the exact summary text the digest uses, with a title derived from it', () => {
    const summary = 'قیمت خودروها افزایش یافت. بازار واکنش نشان داد.';
    const [item] = selectTopNews([row({ id: 1, summaryText: summary, title: null })]);
    expect(item.summary).toBe(summary);
    expect(summary.startsWith(item.title)).toBe(true);
    expect(item.title.length).toBeGreaterThan(0);
  });

  it('returns at most four items even when many are available', () => {
    const items = Array.from({ length: 9 }, (_, i) =>
      row({ id: i + 1, summaryText: `خلاصهٔ خبر ${i + 1}.`, importance: 5 - i })
    );
    const top = selectTopNews(items);
    expect(top).toHaveLength(4);
    expect(top.map((t) => t.id)).toEqual([1, 2, 3, 4]);
    expect(MAX_IMAGE_ITEMS).toBe(4);
  });

  it('the template itself never renders more than four cards', () => {
    const html = buildImageHtml(
      buildRunFrame(
        Array.from({ length: 7 }, (_, i) => ({
          id: i + 1,
          channelUsername: 'chan_x',
          title: `تیتر ${i + 1}`,
          summary: `خلاصه ${i + 1}.`,
        })),
        new Date(NOW)
      )
    );
    expect(html.split('<article class="card"').length - 1).toBe(4);
    expect(html).toContain('class="grid four"');
  });

  it('returns nothing when there is no news', () => {
    expect(selectTopNews([])).toEqual([]);
  });
});

describe('image html', () => {
  it('is a 2560x1440 high-resolution RTL Liquid Glass frame with escaped content', () => {
    const frame = buildRunFrame(
      [{ id: 1, channelUsername: 'iran_efsha_news', title: 'عنوان', summary: 'خلاصه' }],
      new Date(NOW)
    );
    const html = buildImageHtml(frame);
    expect(html).toContain('width:2560px');
    expect(html).toContain('height:1440px');
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('lang="fa"');
    expect(html).toContain('منبع: @iran_efsha_news');
    expect(html).toContain('linear-gradient');
  });

  it('carries the brand signature in the footer corner', () => {
    const frame = buildRunFrame(
      [{ id: 1, channelUsername: 'c', title: 'عنوان', summary: 'خلاصه' }],
      new Date(NOW)
    );
    expect(buildImageHtml(frame)).toContain('Akhal-Teke / DwAArKa');
  });

  it('shows RSS display titles without an invented @ prefix', () => {
    const frame = buildRunFrame(
      [{ id: 1, channelUsername: 'بی‌بی‌سی فارسی', title: 'عنوان', summary: 'خلاصه' }],
      new Date(NOW)
    );
    const html = buildImageHtml(frame);
    expect(html).toContain('منبع: بی‌بی‌سی فارسی');
    expect(html).not.toContain('@بی‌بی‌سی');
  });

  it('escapes html so untrusted summary text cannot inject markup', () => {
    const frame = buildRunFrame(
      [{ id: 1, channelUsername: 'c', title: '<b>x</b>', summary: '<script>alert(1)</script>' }],
      new Date(NOW)
    );
    const html = buildImageHtml(frame);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('never contains external identifiers or links in the card text', () => {
    const frame = buildRunFrame(
      [{ id: 1, channelUsername: 'src', title: 'تیتر', summary: 'متن خبر بدون هیچ پیوندی' }],
      new Date(NOW)
    );
    const html = buildImageHtml(frame);
    expect(html).not.toMatch(/https?:\/\/t\.me\//);
  });

  it('lays out 1/2/3/4 items with the intended composition', () => {
    const mk = (n: number) =>
      buildImageHtml(
        buildRunFrame(
          Array.from({ length: n }, (_, i) => ({
            id: i,
            channelUsername: 'c',
            title: 't',
            summary: 's',
          })),
          new Date(NOW)
        )
      );
    expect(mk(1)).toContain('class="grid one"');
    expect(mk(2)).toContain('class="grid two"');
    expect(mk(3)).toContain('class="grid three"');
    expect(mk(4)).toContain('class="grid four"');
  });

  it('derives a headline from the summary without inventing text', () => {
    // a short leading sentence alone is not a usable headline, so the next
    // sentence is included; no wording is ever added that is not in the summary
    expect(deriveCardTitle('خبر اول. خبر دوم')).toBe('خبر اول. خبر دوم');
    expect(deriveCardTitle('بدون نقطه پایانی')).toBe('بدون نقطه پایانی');
    expect(deriveCardTitle('   ')).toBe('');
    // short with no following sentence: the whole (only) sentence is kept
    expect(deriveCardTitle('یک جمله کوتاه.')).toBe('یک جمله کوتاه.');
    const long = 'جملهٔ نخست بسیار طولانی است که به تنهایی از سقف مجاز عنوان فراتر می‌رود و باید بریده شود. جملهٔ دوم.';
    expect(deriveCardTitle(long).length).toBeLessThanOrEqual(90);
    expect(long.startsWith(deriveCardTitle(long))).toBe(true);
  });
});

describe('renderRunImage', () => {
  it('makes exactly one Browser Run call and validates the PNG', async () => {
    const h = harness();
    const rendered = await renderRunImage({
      browser: h.browser,
      items: [row({ id: 1 })],
      now: new Date(NOW),
    });
    expect(h.browser.quickAction).toHaveBeenCalledTimes(1);
    expect(rendered?.width).toBe(IMAGE_WIDTH);
    expect(rendered?.height).toBe(IMAGE_HEIGHT);
    expect(rendered?.items).toHaveLength(1);
  });

  it('makes no Browser Run call when there is no news', async () => {
    const h = harness();
    const rendered = await renderRunImage({ browser: h.browser, items: [] });
    expect(rendered).toBeNull();
    expect(h.browser.quickAction).not.toHaveBeenCalled();
  });

  it('makes no Browser Run call when no binding is configured', async () => {
    const rendered = await renderRunImage({ browser: undefined, items: [row({ id: 1 })] });
    expect(rendered).toBeNull();
  });

  it('throws a typed error when Browser Run rate limits the request', async () => {
    const h = harness({ png: null as unknown as ArrayBuffer });
    await expect(
      renderRunImage({ browser: h.browser, items: [row({ id: 1 })] })
    ).rejects.toBeInstanceOf(NewsImageError);
  });

  it('throws when the reply is not a PNG', async () => {
    const browser = {
      quickAction: vi.fn(async () => new Response('nope', { status: 200 })),
    };
    await expect(
      renderRunImage({ browser: browser as never, items: [row({ id: 1 })] })
    ).rejects.toBeInstanceOf(NewsImageError);
  });
});

describe('runPublishing image integration', () => {
  it('sends the ALBUM (slides of four news) before the per-channel text digests', async () => {
    const a = await seedChannel('news_a');
    const b = await seedChannel('news_b');
    // Six items across two channels: slide 1 carries four, slide 2 the rest.
    for (let i = 1; i <= 3; i++) {
      await seedNews(a, 'news_a', i, `خبر شمارهٔ ${i} از کانال اول.`, 30 - i);
      await seedNews(b, 'news_b', 10 + i, `خبر شمارهٔ ${10 + i} از کانال دوم.`, 30 - i);
    }

    const h = harness();
    const report = await runPublishing(env.DB, {
      token: 'T',
      destination: '@destination',
      fetchImpl: h.fetchImpl,
      browser: h.browser,
      now: new Date(NOW),
    });

    // One Browser Run render per slide, then ONE sendMediaGroup slideshow.
    expect(h.browser.quickAction).toHaveBeenCalledTimes(2);
    expect(h.groups).toHaveLength(1);
    expect(h.groups[0].count).toBe(2);
    expect(h.order[0]).toBe('browser');
    expect(h.order[1]).toBe('browser');
    expect(h.order[2]).toBe('sendMediaGroup');
    expect(h.texts).toHaveLength(2);
    expect(report.image?.sent).toBe(true);
    expect(report.image?.channels).toBe(2);
    expect(report.image?.slides).toBe(2);
    expect(report.image?.selected).toBe(6);
  });

  it('sends the album before ANY text message', async () => {
    const a = await seedChannel('news_a');
    const b = await seedChannel('news_b');
    const c = await seedChannel('news_c');
    // Five items: one full slide of four plus a partial second slide.
    await seedNews(a, 'news_a', 1, 'خبر یک.', 5);
    await seedNews(a, 'news_a', 2, 'خبر دو.', 6);
    await seedNews(b, 'news_b', 3, 'خبر سه.', 7);
    await seedNews(b, 'news_b', 4, 'خبر چهارم.', 8);
    await seedNews(c, 'news_c', 5, 'خبر پنجم.', 9);

    const h = harness();
    await runPublishing(env.DB, {
      token: 'T',
      destination: '@destination',
      fetchImpl: h.fetchImpl,
      browser: h.browser,
      now: new Date(NOW),
    });

    expect(h.groups).toHaveLength(1);
    expect(h.groups[0].count).toBe(2);
    // The album is ONE swipeable slideshow: a caption on the first photo only.
    expect(h.groups[0].captions.filter(Boolean)).toHaveLength(1);
    expect(h.groups[0].captions[0]).toContain('📰 اخبار لحظه‌ای');
    const firstText = h.order.indexOf('sendMessage');
    const album = h.order.indexOf('sendMediaGroup');
    expect(album).toBeGreaterThanOrEqual(0);
    expect(album).toBeLessThan(firstText);
  });

  it('chunks the news into slides of four regardless of channel count', async () => {
    const names = ['chan_one', 'chan_two', 'chan_three', 'chan_four', 'chan_five'];
    for (const name of names) {
      const id = await seedChannel(name);
      await seedNews(id, name, 1, `خبر کانال ${name}.`, 5);
    }
    const h = harness();
    const report = await runPublishing(env.DB, {
      token: 'T',
      destination: '@destination',
      fetchImpl: h.fetchImpl,
      browser: h.browser,
      now: new Date(NOW),
    });
    // Five items: slide 1 covers four of them, slide 2 the fifth. Every item
    // is on a slide, so nothing is demoted to the overflow ticker.
    expect(h.browser.quickAction).toHaveBeenCalledTimes(2);
    expect(h.groups[0].count).toBe(2);
    expect(report.image?.slides).toBe(2);
    expect(report.image?.selected).toBe(5);
    expect(report.image?.ticker).toBe(0);
    expect(h.texts).toHaveLength(5);
    // The full slide uses the FIXED 2×2 news board and carries the slide count.
    expect(h.browserCalls[0].html).toContain('grid four');
    expect(h.browserCalls[0].html).toContain('اسلاید ۱ از ۲');
    expect(h.browserCalls[1].html).toContain('خبر کانال chan_five');
  });

  it('generates no image when no valid news exists', async () => {
    await seedChannel('news_a');
    const h = harness();
    const report = await runPublishing(env.DB, {
      token: 'T',
      destination: '@destination',
      fetchImpl: h.fetchImpl,
      browser: h.browser,
      now: new Date(NOW),
    });
    expect(h.browser.quickAction).not.toHaveBeenCalled();
    expect(h.photos).toHaveLength(0);
    expect(h.groups).toHaveLength(0);
    expect(report.image).toBeUndefined();
    expect(h.texts).toHaveLength(0);
  });

  it('still publishes every text digest when rendering fails', async () => {
    const a = await seedChannel('news_a');
    await seedNews(a, 'news_a', 1, 'خبر مهم.', 5);

    const h = harness({ png: null as unknown as ArrayBuffer });
    const report = await runPublishing(env.DB, {
      token: 'T',
      destination: '@destination',
      fetchImpl: h.fetchImpl,
      browser: h.browser,
      now: new Date(NOW),
    });

    expect(report.image?.sent).toBe(false);
    expect(report.image?.error).toBe('render_failed');
    expect(report.image?.detail).toContain('429');
    expect(h.groups).toHaveLength(0);
    expect(h.texts).toHaveLength(1);
    expect(report.published).toBe(1);
  });

  it('publishes text digests even when the album send fails', async () => {
    const a = await seedChannel('news_a');
    await seedNews(a, 'news_a', 1, 'خبر مهم.', 5);

    const h = harness({ sendStatus: 500 });
    const report = await runPublishing(env.DB, {
      token: 'T',
      destination: '@destination',
      fetchImpl: h.fetchImpl,
      browser: h.browser,
      now: new Date(NOW),
    });

    expect(report.image?.sent).toBe(false);
    expect(report.image?.error).toBe('send_failed');
    expect(h.texts).toHaveLength(1);
    expect(report.published).toBe(1);
  });

  it('leaves existing behaviour untouched when no binding is supplied', async () => {
    const a = await seedChannel('news_a');
    await seedNews(a, 'news_a', 1, 'خبر بدون تصویر.', 5);
    const h = harness();
    const report = await runPublishing(env.DB, {
      token: 'T',
      destination: '@destination',
      fetchImpl: h.fetchImpl,
    });
    expect(h.browser.quickAction).not.toHaveBeenCalled();
    expect(h.photos).toHaveLength(0);
    expect(h.texts).toHaveLength(1);
    expect(report.published).toBe(1);
    expect(report.image).toBeUndefined();
  });

  it('keeps the per-channel digest text unchanged', async () => {
    const a = await seedChannel('news_a');
    await seedNews(a, 'news_a', 1, 'خلاصهٔ خبر برای کانال اول.', 5);
    const h = harness();
    await runPublishing(env.DB, {
      token: 'T',
      destination: '@destination',
      fetchImpl: h.fetchImpl,
      browser: h.browser,
      now: new Date(NOW),
    });
    expect(h.texts[0]).toContain('📰 <b>خبر عمومی</b>\n📝 <b>خلاصه:</b> خلاصهٔ خبر برای کانال اول.');
    expect(h.texts[0]).toContain('📡 <i>منبع: @news_a</i>\n📣 <i>@destination</i>');
  });

  it('fills the first slide with the globally most important news', async () => {
    const a = await seedChannel('news_a');
    const b = await seedChannel('news_b');
    await seedNews(a, 'news_a', 1, 'کوتاه.', 5);
    await seedNews(b, 'news_b', 2, 'خلاصه‌ای بسیار مفصل‌تر و مهم‌تر با جزئیات کامل بیشتر.', 6);
    await env.DB.prepare(`UPDATE messages SET importance = 5 WHERE source_channel_id = ?1`)
      .bind(b)
      .run();
    // Score 2, not 1: a score of 1 would exclude the row from the image entirely.
    await env.DB.prepare(`UPDATE messages SET importance = 2 WHERE source_channel_id = ?1`)
      .bind(a)
      .run();

    const h = harness();
    const report = await runPublishing(env.DB, {
      token: 'T',
      destination: '@destination',
      fetchImpl: h.fetchImpl,
      browser: h.browser,
      now: new Date(NOW),
    });

    expect(report.image?.selected).toBe(2);
    expect(report.image?.channels).toBe(2);
    // Both items share one slide; the higher-scored one is the lead story.
    expect(h.browserCalls[0].html).toContain('خلاصه‌ای بسیار مفصل‌تر');
    expect(h.browserCalls[0].html).toContain('کوتاه.');
    // A single slide is a sendPhoto (a media group needs two photos).
    expect(h.photos).toHaveLength(1);
    expect(h.groups).toHaveLength(0);
  });
});
describe('ticker selection', () => {
  it('lists every remaining headline in the same order as the cards', () => {
    const items = [
      row({ id: 1, summaryText: 'خبر یک.', importance: 5 }),
      row({ id: 2, summaryText: 'خبر دو.', importance: 4 }),
      row({ id: 3, summaryText: 'خبر سه.', importance: 3 }),
      row({ id: 4, summaryText: 'خبر چهار.', importance: 2 }),
      row({ id: 5, summaryText: 'خبر پنج.', importance: 2 }),
      row({ id: 6, summaryText: 'خبر شش.', importance: 1 }),
    ];
    const top = selectTopNews(items);
    expect(top.map((t) => t.id)).toEqual([1, 2, 3, 4]);

    const ticker = selectTickerNews(items, new Set(top.map((t) => t.id)));
    // id 6 scored importance 1 and is excluded; only id 5 remains.
    expect(ticker.items.map((t) => t.id)).toEqual([5]);
    expect(ticker.hidden).toBe(0);
  });

  it('keeps each line brief and single-line sized', () => {
    const long = 'این یک خبر بسیار طولانی است که باید در نوار عناوین کوتاه شود و ادامهٔ آن قطع می‌شود.'
      .repeat(3);
    const [item] = selectTickerNews([row({ id: 1, summaryText: long, importance: 5 })], new Set()).items;
    expect(item.text.length).toBeLessThanOrEqual(TICKER_MAX_CHARS);
    expect(item.text.endsWith('…')).toBe(true);
  });

  it('caps the ticker and reports the hidden remainder', () => {
    const items = Array.from(
      { length: MAX_TICKER_ITEMS + 5 },
      (_, i) => row({ id: i + 1, summaryText: `خبر ${i + 1}.`, importance: 5 })
    );
    const ticker = selectTickerNews(items, new Set());
    expect(ticker.items).toHaveLength(MAX_TICKER_ITEMS);
    expect(ticker.hidden).toBe(5);
  });

  it('is empty when everything is already a card or scored 1', () => {
    const items = [
      row({ id: 1, summaryText: 'خبر کارت.', importance: 5 }),
      row({ id: 2, summaryText: 'خبر کم‌اهمیت.', importance: 1 }),
    ];
    const top = selectTopNews(items);
    const ticker = selectTickerNews(items, new Set(top.map((t) => t.id)));
    expect(ticker.items).toEqual([]);
    expect(ticker.hidden).toBe(0);
  });

  it('converts digits to Persian for the overflow line', () => {
    expect(faDigits(12)).toBe('۱۲');
    expect(faDigits(0)).toBe('۰');
  });
});

describe('ticker html', () => {
  const cards = [
    { id: 1, channelUsername: 'news_a', title: 'تیتر یک', summary: 'خلاصه یک' },
    { id: 2, channelUsername: 'news_b', title: 'تیتر دو', summary: 'خلاصه دو' },
  ];
  const ticker = [
    { id: 11, channelUsername: 'news_c', text: 'عنوان کوتاه از کانال سوم' },
    { id: 12, channelUsername: 'news_d', text: 'عنوان کوتاه از کانال چهارم' },
  ];

  it('renders the ticker strip with one single-line entry per item', () => {
    const html = buildImageHtml(buildRunFrame(cards, new Date(NOW), ticker));
    expect(html).toContain('class="ticker"');
    expect(html).toContain('سایر عناوین');
    expect(html).toContain('white-space:nowrap');
    expect(html).toContain('>عنوان کوتاه از کانال سوم<');
    expect(html).toContain('>عنوان کوتاه از کانال چهارم<');
  });

  it('omits the strip entirely when there are no extra headlines', () => {
    const html = buildImageHtml(buildRunFrame(cards, new Date(NOW)));
    expect(html).not.toContain('class="ticker"');
    expect(html).not.toContain('سایر عناوین');
  });

  it('marks the overflow line and keeps the card count at the top four', () => {
    const html = buildImageHtml(
      buildRunFrame(cards, new Date(NOW), [
        ...ticker,
        { id: 0, channelUsername: '', text: `و ${faDigits(3)} خبر دیگر`, more: true },
      ])
    );
    expect(html).toContain('class="ti more"');
    expect(html).toContain('و ۳ خبر دیگر');
    expect(html.split('<article class="card"').length - 1).toBe(2);
  });

  it('credits ticker channels in the footer too', () => {
    const frame = buildRunFrame(cards, new Date(NOW), ticker);
    expect(frame.footer).toContain('@news_c');
    expect(frame.footer).toContain('@news_d');
    expect(frame.footer).toContain('منابع:');
  });

  it('renderRunImage feeds the ticker and reports its size', async () => {
    const items = [
      row({ id: 1, summaryText: 'خبر یک.', importance: 6 }),
      row({ id: 2, summaryText: 'خبر دو.', importance: 5 }),
      row({ id: 3, summaryText: 'خبر سه.', importance: 4 }),
      row({ id: 4, summaryText: 'خبر چهار.', importance: 3 }),
      row({ id: 5, summaryText: 'خبر پنجم برای نوار عناوین.', importance: 2 }),
    ];
    const browser = {
      quickAction: vi.fn(async (_a: string, _payload: Record<string, unknown>) =>
        new Response(fakePng(), { status: 200, headers: { 'content-type': 'image/png' } })
      ),
    };
    const rendered = await renderRunImage({ browser, items, now: new Date(NOW) });
    expect(rendered).not.toBeNull();
    expect(rendered!.items).toHaveLength(4);
    expect(rendered!.tickerCount).toBe(1);
    const html = String((browser.quickAction as ReturnType<typeof vi.fn>).mock.calls[0][1].html);
    expect(html).toContain('class="ticker"');
    expect(html).toContain('خبر پنجم برای نوار عناوین.');
  });
});

/* ---------------------------------------------------------------- albums -- */

describe('renderRunAlbum', () => {
  it('chunks the run into slides of four, most important first', async () => {
    const browser = {
      quickAction: vi.fn(async () => new Response(fakePng(), { status: 200 })),
    };
    // Importance order: 5,4,3 then a three-way tie at 2 broken by id.
    const importances = [5, 4, 3, 2, 2, 2];
    const items = [1, 2, 3, 4, 5, 6].map((id) =>
      row({ id, importance: importances[id - 1], summaryText: `خبر شمارهٔ ${id} دربارهٔ بودجهٔ جدید.` })
    );

    const album = await renderRunAlbum({ browser, items, now: new Date(NOW) });

    expect(album).not.toBeNull();
    expect(album!.slides).toHaveLength(2); // 6 items -> 4 + 2
    expect(browser.quickAction).toHaveBeenCalledTimes(2);
    expect(album!.slides[0].items.map((i) => i.id)).toEqual([1, 2, 3, 4]);
    expect(album!.slides[1].items.map((i) => i.id)).toEqual([5, 6]);
    expect(album!.selected).toBe(6);
    // Everything fits in the slides: no overflow ticker at all.
    expect(album!.ticker).toHaveLength(0);
    expect(album!.skipped).toBe(0);
    expect(album!.browserRunMs).toBeGreaterThanOrEqual(0);
  });

  it('caps the album at ten slides and keeps the overflow for the ticker', async () => {
    const browser = {
      quickAction: vi.fn(async () => new Response(fakePng(), { status: 200 })),
    };
    // 45 eligible items: 40 fill ten slides, five remain as ticker lines.
    const items = Array.from({ length: 45 }, (_, i) =>
      row({ id: i + 1, importance: 3, summaryText: `خبر شمارهٔ ${i + 1} دربارهٔ بودجه.` })
    );

    const album = await renderRunAlbum({ browser, items, now: new Date(NOW) });

    expect(album!.slides).toHaveLength(10);
    expect(album!.selected).toBe(40);
    expect(browser.quickAction).toHaveBeenCalledTimes(10);
    expect(album!.ticker).toHaveLength(5);
    expect(album!.hidden).toBe(0);
  });

  it('waits between slide renders so the free-tier Quick Action limit is respected', async () => {
    const browser = { quickAction: vi.fn(async () => new Response(fakePng(), { status: 200 })) };
    const waits: number[] = [];
    const items = Array.from({ length: 9 }, (_, i) =>
      row({ id: i + 1, summaryText: `خبر مهم شمارهٔ ${i + 1} دربارهٔ اقتصاد.` })
    );

    await renderRunAlbum({
      browser,
      items,
      spacingMs: 10_500,
      sleepImpl: async (ms) => {
        waits.push(ms);
      },
    });

    // Two gaps between three slides, each of the full spacing.
    expect(waits).toEqual([10_500, 10_500]);
  });

  it('retries once on a 429 and then stops asking for more slides', async () => {
    const calls: number[] = [];
    const browser = {
      quickAction: vi.fn(async () => {
        calls.push(1);
        return new Response('rate limited', { status: 429 });
      }),
    };
    const items = Array.from({ length: 8 }, (_, i) =>
      row({ id: i + 1, summaryText: `خبر مهم شمارهٔ ${i + 1} دربارهٔ اقتصاد.` })
    );

    const album = await renderRunAlbum({
      browser,
      items,
      spacingMs: 5,
      sleepImpl: async () => {},
    });

    // First slide: two attempts (retry); after the second 429 the remaining
    // slides are skipped without any further Browser Run request.
    expect(calls).toHaveLength(2);
    expect(album!.slides).toHaveLength(0);
    expect(album!.skipped).toBe(2);
    expect(album!.error).toContain('429');
  });

  it('skips a failing slide but still returns the healthy ones', async () => {
    let calls = 0;
    const browser = {
      quickAction: vi.fn(async () => {
        calls++;
        // The second slide render returns a non-PNG body: skip just that slide.
        if (calls === 2) return new Response('nope', { status: 200 });
        return new Response(fakePng(), { status: 200 });
      }),
    };
    const items = Array.from({ length: 8 }, (_, i) =>
      row({ id: i + 1, summaryText: `خبر مهم شمارهٔ ${i + 1} دربارهٔ اقتصاد.` })
    );

    const album = await renderRunAlbum({ browser, items, now: new Date(NOW) });

    expect(album!.slides).toHaveLength(1);
    expect(album!.slides[0].items).toHaveLength(4);
    expect(album!.skipped).toBe(1);
    expect(album!.error).toContain('validate');
  });

  it('renders full slides with the FIXED 2×2 template and numbers every slide', async () => {
    const browser = {
      quickAction: vi.fn(async (_a: string, _payload: Record<string, unknown>) =>
        new Response(fakePng(), { status: 200 })
      ),
    };
    const items = Array.from({ length: 6 }, (_, i) =>
      row({ id: i + 1, summaryText: `خبر مهم شمارهٔ ${i + 1} دربارهٔ اقتصاد.` })
    );

    await renderRunAlbum({ browser, items, now: new Date(NOW) });

    const firstHtml = String((browser.quickAction as ReturnType<typeof vi.fn>).mock.calls[0][1].html);
    const secondHtml = String((browser.quickAction as ReturnType<typeof vi.fn>).mock.calls[1][1].html);
    // A full slide always uses the fixed four-slot news board.
    expect(firstHtml).toContain('grid four');
    expect(firstHtml).toContain('اسلاید ۱ از ۲');
    expect(secondHtml).toContain('اسلاید ۲ از ۲');
    // The partial trailing slide keeps the same template and sections.
    expect(secondHtml).toContain('اخبار لحظه‌ای');
  });

  it('makes no Browser Run call when there is no news or no binding', async () => {
    const browser = { quickAction: vi.fn(async () => new Response(fakePng(), { status: 200 })) };
    expect(await renderRunAlbum({ browser, items: [] })).toBeNull();
    expect(await renderRunAlbum({ browser: undefined, items: [row({ id: 1 })] })).toBeNull();
    expect(browser.quickAction).not.toHaveBeenCalled();
  });

  it('works through the direct screenshot() binding shape as well', async () => {
    const screenshot = vi.fn(async () => new Response(fakePng(), { status: 200 }));
    const album = await renderRunAlbum({
      browser: { screenshot },
      items: [row({ id: 1, summaryText: 'خبر مهم دربارهٔ اقتصاد کشور.' })],
      now: new Date(NOW),
    });
    expect(album!.slides).toHaveLength(1);
    expect(screenshot).toHaveBeenCalledTimes(1);
  });
});

describe('buildAlbumCaption (the single album caption)', () => {
  const card = (id: number, title: string, channel: string) => ({
    id,
    channelUsername: channel,
    category: 'economy' as const,
    title,
    summary: 'خلاصهٔ خبر.',
  });

  it('summarises every slide in one numbered, plain-text caption', () => {
    const caption = buildAlbumCaption(
      [
        [card(1, 'بودجهٔ سال آینده تصویب شد', 'news_one'), card(2, 'عرضهٔ سهام جدید', 'news_two')],
        [card(3, 'عنوان سوم', 'news_three')],
      ],
      [{ id: 9, channelUsername: 'news_five', text: 'عنوان پنجم' }],
      0,
      new Date('2026-10-04T10:00:00.000Z')
    );

    expect(caption).toContain('📰 اخبار لحظه‌ای');
    expect(caption).toContain(`${faDigits(1)}) `);
    expect(caption).toContain('بودجهٔ سال آینده تصویب شد');
    expect(caption).toContain('عرضهٔ سهام جدید');
    expect(caption).toContain(`${faDigits(3)}) `);
    expect(caption).toContain('عنوان سوم');
    expect(caption).toContain('@news_three');
    expect(caption).toContain('🔎 سایر عناوین: عنوان پنجم');
    expect(caption).not.toContain('<');
    expect(caption.length).toBeLessThanOrEqual(1000);
  });

  it('reports the hidden items when there is no ticker', () => {
    const caption = buildAlbumCaption([[card(1, 'عنوان یک', 'ch')]], [], 7, new Date(NOW));
    expect(caption).toContain(`و ${faDigits(7)} خبر دیگر`);
  });

  it('folds whatever does not fit into the trailing count, never overflowing', () => {
    const slides = Array.from({ length: 10 }, (_, slide) =>
      Array.from({ length: 4 }, (_, i) =>
        card(slide * 4 + i + 1, `${'عنوان بسیار طولانی '.repeat(6)}${slide}-${i}`, `chan_${slide}`)
      )
    );
    const caption = buildAlbumCaption(slides, [], 3, new Date(NOW));

    expect(caption.length).toBeLessThanOrEqual(1000);
    expect(caption.split('\n')[0]).toContain('📰 اخبار لحظه‌ای');
    // Dropped headlines are counted, not silently lost, and the caption still
    // ends on a whole line rather than a mid-word cut.
    expect(caption).toMatch(/🔎 و [۰-۹]+ خبر دیگر$/);
  });
});

describe('buildAlbumCaptions', () => {
  const card = (id: number, title: string, channel: string) => ({
    id,
    channelUsername: channel,
    category: 'economy' as const,
    title,
    summary: 'خلاصهٔ خبر.',
  });

  it('puts the run header on the first slide and the overflow on the last', () => {
    const now = new Date('2026-10-04T10:00:00.000Z');
    const captions = buildAlbumCaptions(
      [
        [card(1, 'بودجهٔ سال آینده تصویب شد', 'news_one'), card(2, 'عرضهٔ سهام جدید', 'news_two')],
        [card(3, 'عنوان سوم', 'news_three'), card(4, 'عنوان چهارم', 'news_four')],
      ],
      [{ id: 5, channelUsername: 'news_five', text: 'عنوان پنجم' }],
      0,
      now
    );

    expect(captions).toHaveLength(2);
    // Slide 1: run header, then one headline + source pair per news item.
    expect(captions[0]).toContain('📰 اخبار لحظه‌ای');
    expect(captions[0]).toContain('بودجهٔ سال آینده تصویب شد');
    expect(captions[0]).toContain('منبع: @news_one');
    expect(captions[0]).toContain('منبع: @news_two');
    expect(captions[0]).not.toContain('سایر عناوین');
    // Slide 2 (last): its own items plus the overflow headlines.
    expect(captions[1]).not.toContain('اخبار لحظه‌ای');
    expect(captions[1]).toContain('منبع: @news_three');
    expect(captions[1]).toContain('🔎 سایر عناوین: عنوان پنجم');
  });

  it('folds the hidden overflow count into the last caption once', () => {
    const captions = buildAlbumCaptions([[card(1, 'عنوان یک', 'ch')]], [], 7, new Date(NOW));
    expect(captions[0]).toContain(`و ${faDigits(7)} خبر دیگر`);
    expect(captions[0].match(/و ۷ خبر دیگر/g)).toHaveLength(1);
  });

  it('keeps captions plain, brief and under the Telegram limit', () => {
    const longTitle = 'عنوان'.repeat(80);
    const captions = buildAlbumCaptions(
      [
        [
          card(1, longTitle, 'news_one'),
          card(2, 'عنوان دو', 'news_two'),
          card(3, 'عنوان سه', 'news_three'),
          card(4, 'عنوان چهار', 'news_four'),
        ],
      ],
      Array.from({ length: 8 }, (_, i) => ({
        id: 10 + i,
        channelUsername: 'ch',
        text: 'طولانی'.repeat(20),
      })),
      0,
      new Date(NOW)
    );
    for (const caption of captions) {
      expect(caption.length).toBeLessThanOrEqual(1000);
      expect(caption).not.toContain('<');
    }
    // Four headlines with their sources all survive on the one slide.
    expect(captions[0]).toContain('منبع: @news_four');
  });
});

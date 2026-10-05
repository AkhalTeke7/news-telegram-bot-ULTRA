import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { isPersian, verifyKeywords } from '../src/slideshow/enrich';
import { extractOgImage, fetchOgImage, resolveImageUrl } from '../src/slideshow/ogImage';
import { readPngSize, renderSlides } from '../src/slideshow/render';
import {
  buildSlideCaption,
  runSlideshowJob,
  selectSlideshowItems,
  slideItemKey,
} from '../src/slideshow/job';
import { browseCaption, slideshowKeyboard } from '../src/slideshow/browse';
import { canonicalUrl, fnv1a, storyFingerprint } from '../src/lib/hash';

/* ------------------------------------------------------------- fixtures -- */

/** Minimal valid 1x1 PNG, so readPngSize() has something real to parse. */
const PNG_1x1 = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x04, 0x38, 0x00, 0x00, 0x05, 0x46, 0x08, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);
const pngBuffer = (): ArrayBuffer => PNG_1x1.slice().buffer;

const noSleep = async () => {};

async function seedChannel(): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO channels (channel_username, channel_title, enabled)
     VALUES ('src_chan', 'منبع خبری', 1) RETURNING id`
  ).first<{ id: number }>();
  return row!.id;
}

async function seedMessage(
  channelId: number,
  opts: { id: number; title: string; summary: string; url: string; importance?: number }
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO messages
       (source_channel_id, telegram_message_id, message_text, message_date, source_url,
        summary_text, title, importance, category, summarized_at, filter_status)
     VALUES (?1, ?2, ?3, '2026-10-05T07:00:00Z', ?4, ?5, ?6, ?7, 'economy',
             '2026-10-05T07:05:00Z', 'passed')`
  )
    .bind(channelId, opts.id, opts.summary, opts.url, opts.summary, opts.title, opts.importance ?? 4)
    .run();
}

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM slideshow_sent`).run();
  await env.DB.prepare(`DELETE FROM messages`).run();
  await env.DB.prepare(`DELETE FROM channels`).run();
  await env.DB.prepare(`DELETE FROM llm_usage`).run();
});

/* ------------------------------------------------------------ og:image --- */

describe('og:image extraction', () => {
  it('reads og:image from the head', () => {
    const html = `<html><head><meta property="og:image" content="https://cdn.test/a.jpg"></head><body></body></html>`;
    expect(extractOgImage(html, 'https://news.test/x')).toBe('https://cdn.test/a.jpg');
  });

  it('resolves protocol-relative and root-relative urls', () => {
    expect(resolveImageUrl('//cdn.test/a.jpg', 'https://news.test/x')).toBe('https://cdn.test/a.jpg');
    expect(resolveImageUrl('/img/a.jpg', 'https://news.test/x')).toBe('https://news.test/img/a.jpg');
  });

  it('decodes &amp; in the url', () => {
    const html = `<meta property="og:image" content="https://cdn.test/a.jpg?w=1&amp;h=2">`;
    expect(extractOgImage(html, 'https://news.test/')).toBe('https://cdn.test/a.jpg?w=1&h=2');
  });

  it('falls back to twitter:image', () => {
    const html = `<head><meta name="twitter:image" content="https://cdn.test/t.jpg"></head>`;
    expect(extractOgImage(html, 'https://news.test/')).toBe('https://cdn.test/t.jpg');
  });

  it('rejects data: urls and unknown schemes', () => {
    expect(extractOgImage(`<meta property="og:image" content="data:image/png;base64,AA">`, 'https://n.test/')).toBeNull();
    expect(resolveImageUrl('javascript:alert(1)', 'https://n.test/')).toBeNull();
  });

  it('returns null when there is no image tag', () => {
    expect(extractOgImage('<html><head><title>x</title></head></html>', 'https://n.test/')).toBeNull();
  });

  it('never throws on a failing fetch', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('boom');
    };
    await expect(fetchOgImage('https://news.test/a', { fetchImpl })).resolves.toBeNull();
  });

  it('ignores non-html responses', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('{}', { headers: { 'content-type': 'application/json' } });
    await expect(fetchOgImage('https://news.test/a', { fetchImpl })).resolves.toBeNull();
  });

  it('extracts from a real-looking response', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('<html><head><meta property="og:image" content="/pic.png"></head>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    await expect(fetchOgImage('https://news.test/story', { fetchImpl })).resolves.toBe(
      'https://news.test/pic.png'
    );
  });
});

/* ------------------------------------------------------------- keywords -- */

describe('keyword verification', () => {
  it('keeps only keywords that appear verbatim', () => {
    const source = 'فدرال رزرو نرخ بهره را ثابت نگه داشت';
    expect(verifyKeywords(['فدرال رزرو', 'تورم', 'نرخ بهره'], source)).toEqual([
      'فدرال رزرو',
      'نرخ بهره',
    ]);
  });

  it('caps at four and drops duplicates', () => {
    const source = 'a bb ccc dddd eeeee ffffff';
    expect(verifyKeywords(['a', 'bb', 'bb', 'ccc', 'dddd', 'eeeee'], source)).toEqual([
      'bb',
      'ccc',
      'dddd',
      'eeeee',
    ]);
  });

  it('rejects phrases longer than four words and over-long strings', () => {
    const source = 'one two three four five and a very long keyword string here';
    expect(verifyKeywords(['one two three four five'], source)).toEqual([]);
    expect(verifyKeywords(['x'.repeat(50)], 'x'.repeat(50))).toEqual([]);
  });
});

describe('isPersian', () => {
  it('detects Persian and non-Persian text', () => {
    expect(isPersian('نرخ بهره آمریکا')).toBe(true);
    expect(isPersian('Fed holds rates steady')).toBe(false);
    // Persian with latin tickers and digits is still Persian.
    expect(isPersian('شاخص S&P 500 رشد کرد و بازار سبز شد')).toBe(true);
    expect(isPersian('12345 !!! ')).toBe(false);
  });
});

/* --------------------------------------------------------------- hashes -- */

describe('dedupe keys', () => {
  it('canonicalizes urls so tracking params do not create new stories', () => {
    expect(canonicalUrl('https://www.bbc.com/news/a1?utm_source=x&at_medium=rss#top')).toBe(
      'bbc.com/news/a1'
    );
    expect(canonicalUrl('https://bbc.com/news/a1/')).toBe('bbc.com/news/a1');
  });

  it('gives the same item key for the same article', () => {
    expect(slideItemKey('https://www.bbc.com/news/a1?utm_source=rss', 'x')).toBe(
      slideItemKey('https://bbc.com/news/a1', 'y')
    );
  });

  it('falls back to a title hash when there is no url', () => {
    expect(slideItemKey('', 'Fed holds')).toBe(`t:${fnv1a('fed holds')}`);
  });

  it('fingerprints the same story told in a different word order', () => {
    // Word ORDER and stop words are ignored; the significant words are sorted.
    expect(storyFingerprint('Fed raises interest rates sharply')).toBe(
      storyFingerprint('Interest rates: the Fed raises them sharply')
    );
    expect(storyFingerprint('OPEC boosts oil output')).not.toBe(
      storyFingerprint('Fed raises interest rates sharply')
    );
  });
});

/* ---------------------------------------------------------------- render -- */

describe('renderSlides', () => {
  it('parses png dimensions and rejects non-png bodies', () => {
    expect(readPngSize(pngBuffer())).toEqual({ width: 1080, height: 1350 });
    const notPng = new TextEncoder().encode('{"error":"nope"}');
    expect(readPngSize(notPng.buffer as ArrayBuffer)).toBeNull();
  });

  it('renders every page and reports the time spent', async () => {
    const browser = {
      quickAction: async () => new Response(pngBuffer(), { status: 200 }),
    };
    const out = await renderSlides({
      browser: browser as never,
      pages: [
        { html: '<b>1</b>', meta: 1 },
        { html: '<b>2</b>', meta: 2 },
      ],
      spacingMs: 0,
      sleepImpl: noSleep,
    });
    expect(out.slides).toHaveLength(2);
    expect(out.slides.map((s) => s.meta)).toEqual([1, 2]);
    expect(out.skipped).toBe(0);
    expect(out.rateLimited).toBe(false);
  });

  it('stops on a 429 instead of hammering Browser Run', async () => {
    let calls = 0;
    const browser = {
      quickAction: async () => {
        calls++;
        return calls === 1
          ? new Response(pngBuffer(), { status: 200 })
          : new Response('rate limited', { status: 429 });
      },
    };
    const out = await renderSlides({
      browser: browser as never,
      pages: [1, 2, 3, 4].map((n) => ({ html: `<b>${n}</b>`, meta: n })),
      spacingMs: 0,
      sleepImpl: noSleep,
    });
    expect(out.slides).toHaveLength(1);
    expect(out.rateLimited).toBe(true);
    expect(out.skipped).toBe(3);
    // 1 success + 1 rejection, then it gives up without calling again.
    expect(calls).toBe(2);
  });

  it('skips a slide that throws but keeps the rest', async () => {
    let calls = 0;
    const browser = {
      quickAction: async () => {
        calls++;
        if (calls === 1) throw new Error('screenshot exploded');
        return new Response(pngBuffer(), { status: 200 });
      },
    };
    const out = await renderSlides({
      browser: browser as never,
      pages: [1, 2].map((n) => ({ html: `<b>${n}</b>`, meta: n })),
      spacingMs: 0,
      sleepImpl: noSleep,
    });
    expect(out.slides).toHaveLength(1);
    expect(out.skipped).toBe(1);
    expect(out.error).toContain('screenshot exploded');
  });

  it('paces renders with the configured spacing', async () => {
    const waits: number[] = [];
    const browser = { quickAction: async () => new Response(pngBuffer(), { status: 200 }) };
    await renderSlides({
      browser: browser as never,
      pages: [1, 2, 3].map((n) => ({ html: '<b></b>', meta: n })),
      spacingMs: 10_500,
      sleepImpl: async (ms) => {
        waits.push(ms);
      },
    });
    // One gap BETWEEN each pair of renders, never before the first.
    expect(waits).toEqual([10_500, 10_500]);
  });

  it('reports a missing browser binding instead of throwing', async () => {
    const out = await renderSlides({ browser: undefined, pages: [{ html: '<b></b>', meta: 1 }] });
    expect(out.slides).toHaveLength(0);
    expect(out.error).toBe('browser_binding_missing');
  });
});

/* ------------------------------------------------------------ selection -- */

describe('selectSlideshowItems', () => {
  it('returns the most important unsent items', async () => {
    const channelId = await seedChannel();
    await seedMessage(channelId, {
      id: 1,
      title: 'خبر مهم',
      summary: 'خلاصهٔ خبر مهم',
      url: 'https://news.test/1',
      importance: 5,
    });
    await seedMessage(channelId, {
      id: 2,
      title: 'خبر معمولی',
      summary: 'خلاصهٔ خبر معمولی',
      url: 'https://news.test/2',
      importance: 3,
    });

    const items = await selectSlideshowItems(env.DB, 10);
    expect(items.map((i) => i.headline)).toEqual(['خبر مهم', 'خبر معمولی']);
    expect(items[0].sourceName).toBe('منبع خبری');
  });

  it('never re-sends an item recorded in slideshow_sent', async () => {
    const channelId = await seedChannel();
    await seedMessage(channelId, { id: 1, title: 'یک', summary: 'الف', url: 'https://news.test/1' });
    await seedMessage(channelId, { id: 2, title: 'دو', summary: 'ب', url: 'https://news.test/2' });

    const first = await selectSlideshowItems(env.DB, 10);
    await env.DB.prepare(`INSERT INTO slideshow_sent (item_key) VALUES (?1)`)
      .bind(first[0].key)
      .run();

    const second = await selectSlideshowItems(env.DB, 10);
    expect(second.map((i) => i.key)).not.toContain(first[0].key);
    expect(second).toHaveLength(1);
  });

  it('honours the limit', async () => {
    const channelId = await seedChannel();
    for (let i = 1; i <= 5; i++) {
      await seedMessage(channelId, {
        id: i,
        title: `خبر ${i}`,
        summary: `خلاصه ${i}`,
        url: `https://news.test/${i}`,
      });
    }
    expect(await selectSlideshowItems(env.DB, 3)).toHaveLength(3);
  });

  it('skips filtered and unsummarized rows', async () => {
    const channelId = await seedChannel();
    await env.DB.prepare(
      `INSERT INTO messages (source_channel_id, telegram_message_id, message_text, message_date,
                             source_url, summary_text, title, importance, summarized_at, filter_status)
       VALUES (?1, 10, 'x', '2026-10-05T07:00:00Z', 'https://n.test/ad', 'تبلیغ', 'تبلیغ', 5,
               '2026-10-05T07:00:00Z', 'filtered')`
    )
      .bind(channelId)
      .run();
    await env.DB.prepare(
      `INSERT INTO messages (source_channel_id, telegram_message_id, message_text, message_date, source_url)
       VALUES (?1, 11, 'raw', '2026-10-05T07:00:00Z', 'https://n.test/raw')`
    )
      .bind(channelId)
      .run();
    expect(await selectSlideshowItems(env.DB, 10)).toHaveLength(0);
  });
});

/* -------------------------------------------------------------- captions -- */

describe('captions and keyboard', () => {
  it('builds a short caption with the category emoji and counter', () => {
    const caption = buildSlideCaption(
      { headline: 'نرخ بهره ثابت ماند', sourceName: 'رویترز', category: { emoji: '💰' } },
      3,
      10
    );
    expect(caption).toContain('💰 نرخ بهره ثابت ماند');
    expect(caption).toContain('منبع: رویترز');
    expect(caption).toContain('3/10');
    // Telegram's hard cap is 1024.
    expect(caption.length).toBeLessThanOrEqual(1024);
  });

  it('truncates an absurdly long headline', () => {
    const caption = buildSlideCaption(
      { headline: 'ت'.repeat(2000), sourceName: 'س'.repeat(200), category: { emoji: '💰' } },
      1,
      1
    );
    expect(caption.length).toBeLessThanOrEqual(1024);
  });

  it('renders the navigation keyboard as ◀ قبلی | ۳/۱۰ | بعدی ▶', () => {
    const row = slideshowKeyboard(2, 10).inline_keyboard[0];
    expect(row.map((b) => b.text)).toEqual(['بعدی ▶', '۳/۱۰', '◀ قبلی']);
    expect(row.map((b) => b.callback_data)).toEqual(['ss:next', 'ss:noop', 'ss:prev']);
    for (const button of row) {
      expect((button.callback_data ?? '').length).toBeLessThanOrEqual(64);
    }
  });

  it('builds a browse caption with the link', () => {
    const caption = browseCaption(
      { fileId: 'f', title: 'عنوان', source: 'رویترز', link: 'https://n.test/1' },
      0,
      3
    );
    expect(caption).toContain('عنوان');
    expect(caption).toContain('۱/۳');
    expect(caption).toContain('https://n.test/1');
  });
});

/* ------------------------------------------------------------- full job -- */

describe('runSlideshowJob', () => {
  const baseEnv = () => ({
    ...env,
    TELEGRAM_BOT_TOKEN: 'T',
    TELEGRAM_DESTINATION_CHANNEL: '@mychannel',
    TIMEZONE: 'Asia/Tehran',
    BRAND_NAME: 'اخبار فوری',
    // No LLM keys: the job must still work, just without keywords/translation.
  });

  it('skips cleanly when there is nothing new', async () => {
    const result = await runSlideshowJob(
      { ...baseEnv(), BROWSER: { quickAction: async () => new Response(pngBuffer()) } } as never,
      { sleepImpl: noSleep, spacingMs: 0 }
    );
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('no_new_items');
  });

  it('refuses to run without a browser binding', async () => {
    const result = await runSlideshowJob({ ...baseEnv(), BROWSER: undefined } as never, {
      sleepImpl: noSleep,
    });
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('browser_binding_missing');
  });

  it('renders, sends one album and only then records the items', async () => {
    const channelId = await seedChannel();
    for (let i = 1; i <= 3; i++) {
      await seedMessage(channelId, {
        id: i,
        title: `خبر ${i}`,
        summary: `خلاصهٔ خبر شمارهٔ ${i} برای آزمون.`,
        url: `https://news.test/${i}`,
      });
    }

    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/sendMediaGroup')) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: [1, 2, 3].map((n) => ({
              message_id: 500 + n,
              date: 0,
              photo: [{ file_id: `file-${n}`, file_unique_id: `u${n}`, width: 1080, height: 1350 }],
            })),
          }),
          { headers: { 'content-type': 'application/json' } }
        );
      }
      // Article pages: give the first one an og:image.
      return new Response('<html><head><meta property="og:image" content="/p.jpg"></head>', {
        headers: { 'content-type': 'text/html' },
      });
    };

    const result = await runSlideshowJob(
      {
        ...baseEnv(),
        BROWSER: { quickAction: async () => new Response(pngBuffer(), { status: 200 }) },
      } as never,
      { sleepImpl: noSleep, spacingMs: 0, fetchImpl }
    );

    expect(result.status).toBe('success');
    expect(result.rendered).toBe(3);
    expect(result.sent).toBe(3);
    expect(result.withImage).toBe(3);

    // Exactly ONE album call, never one message per item.
    expect(calls.filter((c) => c.includes('/sendMediaGroup'))).toHaveLength(1);
    expect(calls.filter((c) => c.includes('/sendPhoto'))).toHaveLength(0);

    const rows = await env.DB.prepare(
      `SELECT item_key, file_id, message_id FROM slideshow_sent ORDER BY item_key`
    ).all<{ item_key: string; file_id: string; message_id: number }>();
    expect(rows.results).toHaveLength(3);
    // Each slide keeps its OWN file_id, which is what /slideshow pages through.
    expect(new Set(rows.results.map((r) => r.file_id))).toEqual(
      new Set(['file-1', 'file-2', 'file-3'])
    );

    // A second run has nothing left to send.
    const again = await runSlideshowJob(
      {
        ...baseEnv(),
        BROWSER: { quickAction: async () => new Response(pngBuffer(), { status: 200 }) },
      } as never,
      { sleepImpl: noSleep, spacingMs: 0, fetchImpl }
    );
    expect(again.reason).toBe('no_new_items');
  });

  it('marks NOTHING as sent when Telegram rejects the album', async () => {
    const channelId = await seedChannel();
    for (let i = 1; i <= 2; i++) {
      await seedMessage(channelId, {
        id: i,
        title: `خبر ${i}`,
        summary: `خلاصه ${i}`,
        url: `https://news.test/${i}`,
      });
    }

    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).includes('/sendMediaGroup')) {
        return new Response(JSON.stringify({ ok: false, description: 'CHAT_NOT_FOUND' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('<html><head></head>', { headers: { 'content-type': 'text/html' } });
    };

    const result = await runSlideshowJob(
      {
        ...baseEnv(),
        BROWSER: { quickAction: async () => new Response(pngBuffer(), { status: 200 }) },
      } as never,
      { sleepImpl: noSleep, spacingMs: 0, fetchImpl }
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toContain('CHAT_NOT_FOUND');
    expect(result.sent).toBe(0);
    const { results } = await env.DB.prepare(`SELECT item_key FROM slideshow_sent`).all();
    expect(results).toHaveLength(0);
  });

  it('uses sendPhoto when only one slide survived rendering', async () => {
    const channelId = await seedChannel();
    for (let i = 1; i <= 2; i++) {
      await seedMessage(channelId, {
        id: i,
        title: `خبر ${i}`,
        summary: `خلاصه ${i}`,
        url: `https://news.test/${i}`,
      });
    }

    let shots = 0;
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      if (String(input).includes('/sendPhoto')) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              message_id: 9,
              date: 0,
              photo: [{ file_id: 'solo', file_unique_id: 'u', width: 1080, height: 1350 }],
            },
          }),
          { headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('<html><head></head>', { headers: { 'content-type': 'text/html' } });
    };

    const result = await runSlideshowJob(
      {
        ...baseEnv(),
        BROWSER: {
          quickAction: async () => {
            shots++;
            return shots === 1
              ? new Response(pngBuffer(), { status: 200 })
              : new Response('nope', { status: 500 });
          },
        },
      } as never,
      { sleepImpl: noSleep, spacingMs: 0, fetchImpl }
    );

    expect(result.status).toBe('partial');
    expect(result.sent).toBe(1);
    expect(calls.filter((c) => c.includes('/sendPhoto'))).toHaveLength(1);
    const { results } = await env.DB.prepare(`SELECT item_key FROM slideshow_sent`).all();
    expect(results).toHaveLength(1);
  });

  it('respects SLIDESHOW_MAX_ITEMS and never exceeds 10', async () => {
    const channelId = await seedChannel();
    for (let i = 1; i <= 12; i++) {
      await seedMessage(channelId, {
        id: i,
        title: `خبر ${i}`,
        summary: `خلاصه ${i}`,
        url: `https://news.test/${i}`,
      });
    }

    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).includes('/sendMediaGroup')) {
        const body = (await (input as never as Request)) as unknown;
        void body;
        return new Response(
          JSON.stringify({
            ok: true,
            result: Array.from({ length: 10 }, (_, n) => ({ message_id: n, date: 0 })),
          }),
          { headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('<html><head></head>', { headers: { 'content-type': 'text/html' } });
    };

    const result = await runSlideshowJob(
      {
        ...baseEnv(),
        SLIDESHOW_MAX_ITEMS: '99', // clamped to the Telegram album limit
        BROWSER: { quickAction: async () => new Response(pngBuffer(), { status: 200 }) },
      } as never,
      { sleepImpl: noSleep, spacingMs: 0, fetchImpl }
    );

    expect(result.candidates).toBe(10);
    expect(result.sent).toBe(10);
  });
});

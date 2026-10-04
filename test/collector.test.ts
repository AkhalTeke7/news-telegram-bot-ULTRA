import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getChannelById, insertMessages, listEnabledChannels } from '../src/channels';
import { collectAll, collectChannel, DEFAULT_WINDOW_MS } from '../src/collector';
import { parsePreviewHtml, PreviewError } from '../src/telegramPreview';

const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const WINDOW_MS = DEFAULT_WINDOW_MS;

// Persian literals below are written as escapes on purpose: a raw ZWNJ or
// Persian glyph in source can be silently mangled by an editor or shell
// round-trip, which would make these assertions pass for the wrong reason.
const PERSIAN_NEWS = '\u06af\u0632\u0627\u0631\u0634 \u0634\u0645\u0627\u0631\u0647';
const PERSIAN_IMPORTANT = '\u062e\u0628\u0631 \u0645\u0647\u0645';

/** Minimal but realistic shape of a t.me/s/<channel> preview page. */
function previewHtml(
  posts: { id: number; minutesAgo: number; text?: string; extra?: string }[],
  channel = 'newsroom'
) {
  const body = posts
    .map(
      (p) => `
<div class="tgme_widget_message_wrap js-widget_message">
  <div class="tgme_widget_message js-widget_message" data-post="${channel}/${p.id}">
    <div class="tgme_widget_message_user"><a href="https://t.me/${channel}">News</a></div>
    <div class="tgme_widget_message_date"><time datetime="${new Date(
      NOW - p.minutesAgo * 60_000
    ).toISOString()}" class="time">10:00</time></div>
    <div class="tgme_widget_message_text js-message_text">${
      p.text ?? `${PERSIAN_NEWS} ${p.id}`
    }</div>
    ${p.extra ?? ''}
  </div>
</div>`
    )
    .join('\n');
  return `<!DOCTYPE html><html><body><div class="tgme_page_wrap">${body}</div></body></html>`;
}

const fakeFetch = (html: string, ok = true, status = 200) =>
  vi.fn(async () => {
    if (!ok) return new Response('nope', { status });
    return new Response(html, { status, headers: { 'content-type': 'text/html' } });
  }) as unknown as typeof fetch;

async function makeChannel(username: string, enabled = true): Promise<{ id: number }> {
  const res = await env.DB.prepare(
    `INSERT INTO channels (channel_username, channel_title, enabled) VALUES (?1, ?2, ?3)`
  )
    .bind(username, username, enabled ? 1 : 0)
    .run();
  return { id: Number(res.meta.last_row_id) };
}

async function messagesFor(channelId: number) {
  const { results } = await env.DB.prepare(
    `SELECT telegram_message_id, message_date, message_text, source_url
       FROM messages WHERE source_channel_id = ?1 ORDER BY telegram_message_id ASC`
  )
    .bind(channelId)
    .all<{
      telegram_message_id: number;
      message_date: string;
      message_text: string;
      source_url: string;
    }>();
  return results ?? [];
}

async function reset() {
  await env.DB.prepare(`DELETE FROM messages`).run();
  await env.DB.prepare(`DELETE FROM channels`).run();
  await env.DB.prepare(`DELETE FROM cron_runs`).run();
}

describe('migration 0002_messages', () => {
  beforeEach(reset);

  it('has every required column', async () => {
    const { results } = await env.DB.prepare(`PRAGMA table_info(messages)`).all<{
      name: string;
      type: string;
      notnull: number;
    }>();
    const cols = new Map(results.map((r: { name: string; notnull: number }) => [r.name, r]));
    for (const name of [
      'id',
      'source_channel_id',
      'telegram_message_id',
      'message_date',
      'message_text',
      'source_url',
      'created_at',
    ]) {
      expect(cols.has(name), `missing column ${name}`).toBe(true);
    }
    expect(cols.get('source_channel_id')!.notnull).toBe(1);
    expect(cols.get('telegram_message_id')!.notnull).toBe(1);
    expect(cols.get('message_date')!.notnull).toBe(1);
    expect(cols.get('source_url')!.notnull).toBe(1);
  });

  it('rejects a duplicate (source_channel_id, telegram_message_id)', async () => {
    const { id } = await makeChannel('dupchannel');
    const first = await insertMessages(env.DB, id, [
      { telegramMessageId: 7, messageDate: new Date(NOW).toISOString(), messageText: 'a', sourceUrl: 'u' },
    ]);
    expect(first.inserted).toBe(1);

    await expect(
      env.DB.prepare(
        `INSERT INTO messages (source_channel_id, telegram_message_id, message_date, source_url)
         VALUES (?1, ?2, ?3, ?4)`
      )
        .bind(id, 7, new Date(NOW).toISOString(), 'u')
        .run()
    ).rejects.toThrow(/UNIQUE/);
  });

  it('allows the same telegram_message_id in a different channel', async () => {
    const a = await makeChannel('channel_one');
    const b = await makeChannel('channel_two');
    const row = {
      telegramMessageId: 7,
      messageDate: new Date(NOW).toISOString(),
      messageText: 'a',
      sourceUrl: 'u',
    };
    expect((await insertMessages(env.DB, a.id, [row])).inserted).toBe(1);
    expect((await insertMessages(env.DB, b.id, [row])).inserted).toBe(1);
  });

  it('cascades message deletion when the channel is deleted', async () => {
    const { id } = await makeChannel('cascadechan');
    await insertMessages(env.DB, id, [
      { telegramMessageId: 1, messageDate: new Date(NOW).toISOString(), messageText: 'x', sourceUrl: 'u' },
    ]);
    await env.DB.prepare(`DELETE FROM channels WHERE id = ?1`).bind(id).run();
    const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages`).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it('enforces the foreign key on source_channel_id', async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO messages (source_channel_id, telegram_message_id, message_date, source_url)
         VALUES (?1, ?2, ?3, ?4)`
      )
        .bind(999999, 1, new Date(NOW).toISOString(), 'u')
        .run()
    ).rejects.toThrow(/FOREIGN KEY/);
  });
});

describe('preview parser', () => {
  it('extracts id, date, text and url', () => {
    const parsed = parsePreviewHtml(
      previewHtml([{ id: 42, minutesAgo: 5, text: PERSIAN_IMPORTANT }]),
      'newsroom'
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      channelUsername: 'newsroom',
      telegramMessageId: 42,
      messageDateMs: NOW - 5 * 60_000,
      messageText: PERSIAN_IMPORTANT,
      sourceUrl: 'https://t.me/newsroom/42',
    });
  });

  it('round-trips Persian text and ZWNJ byte-for-byte', () => {
    // Guards against source/transport encoding damage: these are escapes, so a
    // mangled fixture cannot silently agree with a mangled expectation.
    const raw = '\u067e\u06cc\u0627\u0645';
    const parsed = parsePreviewHtml(
      previewHtml([{ id: 1, minutesAgo: 1, text: `${raw} &#x200C; test` }]),
      'newsroom'
    );
    expect(parsed[0].messageText).toBe(`${raw} \u200c test`);
    // 4 Persian letters, a space, then U+200C ZERO WIDTH NON-JOINER.
    expect(parsed[0].messageText.codePointAt(5)).toBe(0x200c);
  });

  it('decodes HTML entities', () => {
    const parsed = parsePreviewHtml(
      previewHtml([{ id: 1, minutesAgo: 1, text: 'a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;' }]),
      'newsroom'
    );
    expect(parsed[0].messageText).toBe('a & b <c> "d" \'e\'');
  });

  it('handles a text block containing nested divs', () => {
    const parsed = parsePreviewHtml(
      previewHtml([
        {
          id: 5,
          minutesAgo: 2,
          text: 'outer<div class="tgme_widget_message_text_quote">inner</div>tail',
        },
      ]),
      'newsroom'
    );
    expect(parsed[0].messageText).toBe('outer\ninner\ntail');
  });

  it('returns empty text for media-only posts', () => {
    const parsed = parsePreviewHtml(
      previewHtml([
        {
          id: 9,
          minutesAgo: 3,
          text: '',
          extra: '<div class="tgme_widget_message_video_thumb"></div>',
        },
      ]),
      'newsroom'
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].messageText).toBe('');
  });

  it('ignores posts from other channels, bad ids and posts without a time element', () => {
    const iso = new Date(NOW).toISOString();
    const html = `
      <div data-post="otherchannel/10"><time datetime="${iso}"></time>
        <div class="tgme_widget_message_text">x</div></div>
      <div data-post="newsroom/notanumber"><time datetime="${iso}"></time></div>
      <div data-post="newsroom/11"><div class="tgme_widget_message_text">no time</div></div>
      <div data-post="newsroom/12"><time datetime="not-a-date"></time></div>`;
    expect(parsePreviewHtml(html, 'newsroom')).toEqual([]);
  });

  it('does not crash on empty or junk html', () => {
    expect(parsePreviewHtml('', 'newsroom')).toEqual([]);
    expect(parsePreviewHtml('<html><body>nothing</body></html>', 'newsroom')).toEqual([]);
    expect(parsePreviewHtml('data-post="newsroom/', 'newsroom')).toEqual([]);
  });

  it('de-duplicates repeated data-post ids', () => {
    const html = previewHtml([
      { id: 3, minutesAgo: 2 },
      { id: 3, minutesAgo: 2 },
    ]);
    expect(parsePreviewHtml(html, 'newsroom')).toHaveLength(1);
  });

  it('rejects an invalid username before making a request', async () => {
    const spy = vi.fn();
    const { fetchChannelPreview } = await import('../src/telegramPreview');
    await expect(
      fetchChannelPreview('../../evil', { fetchImpl: spy as unknown as typeof fetch })
    ).rejects.toBeInstanceOf(PreviewError);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('collectChannel', () => {
  beforeEach(reset);

  it('inserts new messages from the one-hour window', async () => {
    const { id } = await makeChannel('winchannel');
    const channel = (await listEnabledChannels(env.DB))[0];

    const result = await collectChannel(env.DB, channel, {
      now: NOW,
      fetchImpl: fakeFetch(previewHtml([{ id: 100, minutesAgo: 10 }], 'winchannel')),
    });

    expect(result).toMatchObject({ ok: true, fetched: 1, inserted: 1, duplicates: 0 });
    const rows = await messagesFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].telegram_message_id).toBe(100);
    expect(rows[0].source_url).toBe('https://t.me/winchannel/100');
  });

  it('rejects duplicate telegram messages on a second run', async () => {
    const { id } = await makeChannel('dupecheck');
    const channel = (await listEnabledChannels(env.DB))[0];
    const html = previewHtml([{ id: 200, minutesAgo: 20 }], 'dupecheck');

    const first = await collectChannel(env.DB, channel, { now: NOW, fetchImpl: fakeFetch(html) });
    const second = await collectChannel(env.DB, channel, { now: NOW, fetchImpl: fakeFetch(html) });

    expect(first.inserted).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.duplicates).toBe(1);
    expect(await messagesFor(id)).toHaveLength(1);
  });

  it('ignores messages older than one hour and keeps them out of the DB', async () => {
    const { id } = await makeChannel('oldchan');
    const channel = (await listEnabledChannels(env.DB))[0];

    const result = await collectChannel(env.DB, channel, {
      now: NOW,
      fetchImpl: fakeFetch(
        previewHtml(
          [
            { id: 300, minutesAgo: 59 },
            { id: 299, minutesAgo: 61 },
            { id: 298, minutesAgo: 600 },
          ],
          'oldchan'
        )
      ),
    });

    expect(result.inserted).toBe(1);
    expect(result.ignoredOutOfWindow).toBe(2);
    const rows = await messagesFor(id);
    expect(rows.map((r) => r.telegram_message_id)).toEqual([300]);
  });

  it('treats the window as inclusive at the one-hour boundary', async () => {
    const { id } = await makeChannel('edgechan');
    const channel = (await listEnabledChannels(env.DB))[0];

    await collectChannel(env.DB, channel, {
      now: NOW,
      fetchImpl: fakeFetch(
        previewHtml(
          [
            { id: 400, minutesAgo: 60 },
            { id: 399, minutesAgo: 61 },
          ],
          'edgechan'
        )
      ),
    });
    expect((await messagesFor(id)).map((r) => r.telegram_message_id)).toEqual([400]);
  });

  it('does not store future-dated posts', async () => {
    const { id } = await makeChannel('futurechan');
    const channel = (await listEnabledChannels(env.DB))[0];

    await collectChannel(env.DB, channel, {
      now: NOW,
      fetchImpl: fakeFetch(previewHtml([{ id: 500, minutesAgo: -30 }], 'futurechan')),
    });
    expect(await messagesFor(id)).toHaveLength(0);
  });

  it('updates last_checked_at and last_processed_message_id after success', async () => {
    const { id } = await makeChannel('statechan');
    const channel = (await listEnabledChannels(env.DB))[0];
    expect((await getChannelById(env.DB, id))!.lastCheckedAt).toBeNull();
    expect((await getChannelById(env.DB, id))!.lastProcessedMessageId).toBeNull();

    await collectChannel(env.DB, channel, {
      now: NOW,
      fetchImpl: fakeFetch(previewHtml([{ id: 610, minutesAgo: 5 }], 'statechan')),
    });

    const updated = (await getChannelById(env.DB, id))!;
    expect(updated.lastProcessedMessageId).toBe(610);
    expect(updated.lastCheckedAt).not.toBeNull();
    expect(Date.parse(updated.lastCheckedAt!)).toBeGreaterThan(0);
  });

  it('never moves last_processed_message_id backwards', async () => {
    const { id } = await makeChannel('rewindchan');
    const channel = (await listEnabledChannels(env.DB))[0];

    await collectChannel(env.DB, channel, {
      now: NOW,
      fetchImpl: fakeFetch(previewHtml([{ id: 900, minutesAgo: 5 }], 'rewindchan')),
    });
    await collectChannel(env.DB, channel, {
      now: NOW + 60_000,
      fetchImpl: fakeFetch(previewHtml([{ id: 901, minutesAgo: 130 }], 'rewindchan')),
    });

    expect((await getChannelById(env.DB, id))!.lastProcessedMessageId).toBe(900);
  });

  it('leaves processing state untouched when retrieval fails', async () => {
    const { id } = await makeChannel('failchan');
    const channel = (await listEnabledChannels(env.DB))[0];

    await expect(
      collectChannel(env.DB, channel, { now: NOW, fetchImpl: fakeFetch('', false, 502) })
    ).rejects.toBeInstanceOf(PreviewError);

    const after = (await getChannelById(env.DB, id))!;
    expect(after.lastCheckedAt).toBeNull();
    expect(after.lastProcessedMessageId).toBeNull();
  });

  it('leaves processing state untouched when the network throws', async () => {
    const { id } = await makeChannel('netfail');
    const channel = (await listEnabledChannels(env.DB))[0];
    const boom = (() => {
      throw new Error('connection reset');
    }) as unknown as typeof fetch;

    await expect(collectChannel(env.DB, channel, { now: NOW, fetchImpl: boom })).rejects.toThrow();
    const after = (await getChannelById(env.DB, id))!;
    expect(after.lastCheckedAt).toBeNull();
    expect(await messagesFor(id)).toHaveLength(0);
  });

  it('treats an empty preview as a successful check with zero posts', async () => {
    const { id } = await makeChannel('atomicchan');
    const channel = (await listEnabledChannels(env.DB))[0];

    await collectChannel(env.DB, channel, {
      now: NOW,
      fetchImpl: fakeFetch('<html><body>no posts here</body></html>'),
    });

    expect(await messagesFor(id)).toHaveLength(0);
    expect((await getChannelById(env.DB, id))!.lastCheckedAt).not.toBeNull();
  });

  it('never lets log output contain a session or token', async () => {
    const { id } = await makeChannel('logleak');
    const channel = (await listEnabledChannels(env.DB))[0];
    const result = await collectChannel(env.DB, channel, {
      now: NOW,
      fetchImpl: fakeFetch(previewHtml([{ id: 1, minutesAgo: 1 }], 'logleak')),
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/session|token|password/i);
    expect(await messagesFor(id)).toHaveLength(1);
  });
});

describe('collectAll', () => {
  beforeEach(reset);

  it('skips disabled channels entirely', async () => {
    const on = await makeChannel('enabledchan', true);
    await makeChannel('disabledchan', false);
    const urls: string[] = [];
    const spy = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(previewHtml([{ id: 1, minutesAgo: 2 }], 'enabledchan'));
    });

    const summary = await collectAll(env.DB, {
      now: NOW,
      fetchImpl: spy as unknown as typeof fetch,
    });

    expect(summary.enabledChannels).toBe(1);
    expect(summary.succeeded).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(urls[0]).toContain('enabledchan');
    expect(urls[0]).toContain('t.me/s/');
    expect(await messagesFor(on.id)).toHaveLength(1);
  });

  it('keeps processing other channels when one fails', async () => {
    const good = await makeChannel('goodchan', true);
    await makeChannel('badchan', true);
    await makeChannel('alsogood', true);

    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('badchan')) return new Response('down', { status: 500 });
      const name = url.includes('alsogood') ? 'alsogood' : 'goodchan';
      const body = previewHtml([{ id: name === 'goodchan' ? 700 : 701, minutesAgo: 3 }], name);
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;

    const summary = await collectAll(env.DB, { now: NOW, fetchImpl });

    expect(summary.enabledChannels).toBe(3);
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.results.find((r) => r.channel === 'badchan')).toMatchObject({
      ok: false,
      operation: 'collect-channel',
      error: 'HTTP 500 from channel preview.',
    });
    expect(summary.results.find((r) => r.channel === 'badchan')!.timestamp).toBeTruthy();
    expect(summary.results.find((r) => r.channel === 'goodchan')!.ok).toBe(true);

    expect(await messagesFor(good.id)).toHaveLength(1);

    const bad = (await env.DB.prepare(`SELECT id FROM channels WHERE channel_username = ?1`)
      .bind('badchan')
      .first<{ id: number }>())!;
    expect((await getChannelById(env.DB, bad.id))!.lastCheckedAt).toBeNull();
  });

  it('reports a window of exactly one hour', async () => {
    const summary = await collectAll(env.DB, { now: NOW, fetchImpl: fakeFetch(previewHtml([])) });
    expect(summary.windowMs).toBe(60 * 60 * 1000);
    expect(summary.windowStart).toBe(new Date(NOW - WINDOW_MS).toISOString());
  });

  it('is safe on an empty channel list', async () => {
    const summary = await collectAll(env.DB, { now: NOW, fetchImpl: fakeFetch('x') });
    expect(summary).toMatchObject({ enabledChannels: 0, succeeded: 0, failed: 0, inserted: 0 });
  });
});

describe('sql injection safety', () => {
  beforeEach(reset);

  it('treats a hostile source_channel_id as plain data', async () => {
    const { id } = await makeChannel('injchannel');
    const hostileId = '1 OR 1=1; DROP TABLE messages; --';

    await expect(
      env.DB.prepare(
        `INSERT INTO messages (source_channel_id, telegram_message_id, message_date, source_url)
         VALUES (?1, ?2, ?3, ?4)`
      )
        .bind(hostileId, 1, new Date(NOW).toISOString(), 'u')
        .run()
    ).rejects.toThrow(/FOREIGN KEY/);

    expect(await messagesFor(id)).toHaveLength(0);
    const tables = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'`
    ).all();
    expect(tables.results).toHaveLength(1);
  });

  it('does not let a hostile text value break out of the row', async () => {
    const { id } = await makeChannel('quotechan');
    const nasty = "'); DROP TABLE messages; --";
    await insertMessages(env.DB, id, [
      { telegramMessageId: 5, messageDate: new Date(NOW).toISOString(), messageText: nasty, sourceUrl: 'u' },
    ]);

    const rows = await messagesFor(id);
    expect(rows[0].message_text).toBe(nasty);
  });

  it('cannot be tricked into fetching a foreign host via the username', async () => {
    const spy = vi.fn();
    const { fetchChannelPreview } = await import('../src/telegramPreview');
    for (const bad of ['@evil', '../../evil', 'evil.example.com', 'a b', 'x'.repeat(64)]) {
      await expect(
        fetchChannelPreview(bad, { fetchImpl: spy as unknown as typeof fetch })
      ).rejects.toBeInstanceOf(PreviewError);
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

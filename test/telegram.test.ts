import { describe, expect, it } from 'vitest';
import {
  getChatByUsername,
  getMe,
  sendMessage,
  sendMediaGroup,
  sendRichMessage,
  TelegramError,
} from '../src/telegram';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('telegram bot api client', () => {
  it('calls getMe and returns the bot identity', async () => {
    let seenUrl = '';
    const fetchImpl: typeof fetch = async (input) => {
      seenUrl = String(input);
      return jsonResponse({ ok: true, result: { id: 1, username: 'mybot', first_name: 'B', is_bot: true } });
    };
    const me = await getMe({ token: 'T', fetchImpl, baseUrl: 'https://api.test' });
    expect(me.username).toBe('mybot');
    expect(seenUrl).toBe('https://api.test/botT/getMe');
  });

  it('resolves a public channel by @username', async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      expect(body).toEqual({ chat_id: '@somechannel' });
      return jsonResponse({
        ok: true,
        result: { id: -100123, title: 'اخبار', username: 'somechannel', type: 'channel' },
      });
    };
    const chat = await getChatByUsername({ token: 'T', fetchImpl }, 'somechannel');
    expect(chat.title).toBe('اخبار');
    expect(chat.type).toBe('channel');
  });

  it('sends HTML parse mode when a rich-text digest requests it', async () => {
    let body: Record<string, string> | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      body = JSON.parse(String((init as RequestInit).body)) as Record<string, string>;
      return jsonResponse({ ok: true, result: { message_id: 7, date: 1 } });
    };

    await sendMessage({
      token: 'T',
      chatId: '@somechannel',
      text: '📰 <b>عنوان</b>\n📝 جزئیات',
      parseMode: 'HTML',
      fetchImpl,
      baseUrl: 'https://api.test',
    });

    expect(body?.parse_mode).toBe('HTML');
    expect(body?.text).toContain('<b>عنوان</b>');
  });

  it('sends a structured RTL Rich Messages document', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
      return jsonResponse({ ok: true, result: { message_id: 8, date: 1 } });
    };

    await sendRichMessage({
      token: 'T',
      chatId: '@somechannel',
      richMessage: {
        html: '💻 <b>عنوان</b><br>📝 جزئیات',
        is_rtl: true,
        skip_entity_detection: true,
      },
      fetchImpl,
      baseUrl: 'https://api.test',
    });

    expect(body?.rich_message).toEqual({
      html: '💻 <b>عنوان</b><br>📝 جزئیات',
      is_rtl: true,
      skip_entity_detection: true,
    });
  });

  it('uploads in-memory Rich Message slideshow attachments without R2', async () => {
    let form: FormData | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      form = (init as RequestInit).body as FormData;
      return jsonResponse({ ok: true, result: { message_id: 9, date: 1 } });
    };

    await sendRichMessage({
      token: 'T',
      chatId: '@somechannel',
      richMessage: { html: '<tg-slideshow><img src="attach://slide0"/></tg-slideshow>' },
      attachments: [{ name: 'slide0', data: new Uint8Array([1, 2, 3]).buffer, filename: 'slide.png' }],
      fetchImpl,
    });

    expect(form?.get('chat_id')).toBe('@somechannel');
    expect(form?.get('rich_message')?.toString()).toContain('<tg-slideshow>');
    expect(form?.get('slide0')).toBeInstanceOf(File);
  });

  it('throws TelegramError(400) when the username is unknown', async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({ ok: false, description: 'Bad Request: chat not found' }, 400);
    await expect(getChatByUsername({ token: 'T', fetchImpl }, 'ghost')).rejects.toBeInstanceOf(
      TelegramError
    );
  });

  it('throws when the target is not a channel', async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({ ok: true, result: { id: 5, title: 'User', username: 'someone', type: 'user' } });
    await expect(getChatByUsername({ token: 'T', fetchImpl }, 'someone')).rejects.toThrow(/not a Telegram channel/);
  });

  it('propagates network failures (API layer maps them to 502)', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('network down');
    };
    await expect(getMe({ token: 'T', fetchImpl })).rejects.toThrow('network down');
  });
});

/* --------------------------------------------------------- media groups -- */

describe('sendMediaGroup', () => {
  const png = () => {
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    return bytes.buffer;
  };

  it('uploads the album as multipart attachments with one plain-text caption', async () => {
    let seenUrl = '';
    let seenForm: FormData | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      seenUrl = String(input);
      seenForm = (init as RequestInit).body as FormData;
      return jsonResponse({
        ok: true,
        result: [
          { message_id: 11, date: 1 },
          { message_id: 12, date: 1 },
        ],
      });
    };

    const messages = await sendMediaGroup({
      token: 'T',
      chatId: '@somechannel',
      media: [{ photo: png() }, { photo: png() }],
      caption: '📰 خبر یک',
      fetchImpl,
      baseUrl: 'https://api.test',
    });

    expect(seenUrl).toBe('https://api.test/botT/sendMediaGroup');
    expect(messages.map((m) => m.message_id)).toEqual([11, 12]);
    const media = JSON.parse(String(seenForm!.get('media'))) as {
      type: string;
      media: string;
      caption?: string;
    }[];
    // Exactly ONE caption, on the first photo: that is what makes Telegram
    // render the group as a single swipeable slideshow.
    expect(media).toEqual([
      { type: 'photo', media: 'attach://card0', caption: '📰 خبر یک' },
      { type: 'photo', media: 'attach://card1' },
    ]);
    expect(seenForm!.get('card0')).toBeInstanceOf(Blob);
    expect(seenForm!.get('card1')).toBeInstanceOf(Blob);
    // Plain captions only — no parse mode that could be rejected.
    expect(seenForm!.get('parse_mode')).toBeNull();
  });

  it('never captions more than the first photo, whatever the album size', async () => {
    let seenForm: FormData | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      seenForm = (init as RequestInit).body as FormData;
      return jsonResponse({
        ok: true,
        result: Array.from({ length: 10 }, (_, i) => ({ message_id: i + 1, date: 1 })),
      });
    };

    await sendMediaGroup({
      token: 'T',
      chatId: '@c',
      media: Array.from({ length: 10 }, () => ({ photo: png() })),
      caption: 'عنوان آلبوم',
      fetchImpl,
    });

    const media = JSON.parse(String(seenForm!.get('media'))) as { caption?: string }[];
    expect(media.filter((item) => item.caption !== undefined)).toHaveLength(1);
    expect(media[0].caption).toBe('عنوان آلبوم');
  });

  it('omits the caption entirely when it is blank, and clamps a long one', async () => {
    const forms: FormData[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      forms.push((init as RequestInit).body as FormData);
      return jsonResponse({
        ok: true,
        result: [
          { message_id: 1, date: 1 },
          { message_id: 2, date: 1 },
        ],
      });
    };

    await sendMediaGroup({
      token: 'T',
      chatId: '@c',
      media: [{ photo: png() }, { photo: png() }],
      caption: '   ',
      fetchImpl,
    });
    await sendMediaGroup({
      token: 'T',
      chatId: '@c',
      media: [{ photo: png() }, { photo: png() }],
      caption: 'x'.repeat(2000),
      fetchImpl,
    });

    const blank = JSON.parse(String(forms[0].get('media'))) as { caption?: string }[];
    expect(blank.every((item) => item.caption === undefined)).toBe(true);
    const long = JSON.parse(String(forms[1].get('media'))) as { caption?: string }[];
    expect(long[0].caption).toHaveLength(1024);
  });

  it('refuses albums outside the 2–10 item range', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ ok: true, result: [] });
    await expect(
      sendMediaGroup({ token: 'T', chatId: '@c', media: [{ photo: png() }], fetchImpl })
    ).rejects.toMatchObject({ name: 'TelegramError' });
    await expect(
      sendMediaGroup({
        token: 'T',
        chatId: '@c',
        media: Array.from({ length: 11 }, () => ({ photo: png() })),
        fetchImpl,
      })
    ).rejects.toMatchObject({ name: 'TelegramError' });
  });

  it('maps a 429 to the rate-limit error with the retry hint', async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse(
        { ok: false, description: 'Too Many Requests', parameters: { retry_after: 12 } },
        429
      );
    await expect(
      sendMediaGroup({ token: 'T', chatId: '@c', media: [{ photo: png() }, { photo: png() }], fetchImpl })
    ).rejects.toMatchObject({ name: 'TelegramRateLimitError', retryAfterSeconds: 12 });
  });
});

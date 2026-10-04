import { describe, expect, it } from 'vitest';
import { getChatByUsername, getMe, sendMessage, TelegramError } from '../src/telegram';

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

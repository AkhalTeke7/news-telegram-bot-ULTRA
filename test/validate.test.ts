import { describe, expect, it } from 'vitest';
import { parseChannelUsername } from '../src/validate';

describe('parseChannelUsername', () => {
  it('accepts a bare username and lowercases it', () => {
    expect(parseChannelUsername('TelegramNews')).toEqual({ ok: true, username: 'telegramnews' });
  });

  it('accepts an @-prefixed username', () => {
    expect(parseChannelUsername('@Telegram_News_1')).toEqual({ ok: true, username: 'telegram_news_1' });
  });

  it.each([
    ['t.me/NewsChannel', 'newschannel'],
    ['https://t.me/NewsChannel', 'newschannel'],
    ['https://t.me/NewsChannel/', 'newschannel'],
    ['http://telegram.me/NewsChannel', 'newschannel'],
    ['https://telegram.dog/NewsChannel', 'newschannel'],
    ['https://T.ME/NewsChannel', 'newschannel'],
    ['https://t.me/s/NewsChannel', 'newschannel'],
    ['https://t.me/NewsChannel?start=1', 'newschannel'],
    ['https://t.me/NewsChannel#p1', 'newschannel'],
  ])('accepts and normalizes %s', (input, expected) => {
    expect(parseChannelUsername(input)).toEqual({ ok: true, username: expected });
  });

  it('trims surrounding whitespace', () => {
    expect(parseChannelUsername('  @Newschannel \n')).toEqual({ ok: true, username: 'newschannel' });
  });

  it.each<[unknown, string]>([
    ['', 'empty'],
    ['   ', 'blank'],
    ['abc', 'too short'],
    ['1channel', 'must start with a letter'],
    ['news-channel', 'hyphen not allowed'],
    ['news channel', 'internal space'],
    ['@', 'at sign only'],
    ['https://example.com/channel', 'foreign host'],
    ['https://t.me/joinchat/AAAA', 'private invite'],
    ['https://t.me/+SecretHash', 'private invite plus'],
    ['https://t.me/1234567890', 'numeric id'],
    ['https://t.me/', 'no username'],
    ['https://t.me/s/', 'no username after s'],
    ['https://t.me/a/b', 'nested path'],
    ['javascript:alert(1)', 'bad scheme'],
    ['ftp://t.me/channel', 'bad scheme'],
    ['https://t.me/%E2%98%83', 'non-ascii username'],
    ['x'.repeat(300), 'over the length limit'],
    [42, 'non-string'],
    [null, 'null'],
    [undefined, 'undefined'],
    [{ a: 1 }, 'object'],
  ])('rejects %s (%s)', (input) => {
    const result = parseChannelUsername(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });
});

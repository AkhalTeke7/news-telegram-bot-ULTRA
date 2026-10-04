/**
 * Shared "add a public source channel" operation.
 *
 * Used by both the web admin panel (src/api.ts) and the Telegram admin
 * interface (src/telegramAdmin.ts) so channel validation, Telegram
 * verification and the duplicate rule exist exactly once.
 */

import { getChannelByUsername, insertChannel } from './channels';
import { getChatByUsername, TelegramError } from './telegram';
import type { Channel } from './types';
import { parseChannelUsername } from './validate';

export type AddChannelCode =
  | 'invalid'
  | 'duplicate'
  | 'not_public_channel'
  | 'telegram_unavailable'
  | 'added';

export interface AddChannelResult {
  code: AddChannelCode;
  /** Persian message, safe to show to an operator. */
  message: string;
  channel?: Channel;
}

export async function addSourceChannel(
  db: D1Database,
  opts: { token?: string; rawInput: unknown }
): Promise<AddChannelResult> {
  const parsed = parseChannelUsername(opts.rawInput);
  if (!parsed.ok) return { code: 'invalid', message: parsed.error };

  if (await getChannelByUsername(db, parsed.username)) {
    return { code: 'duplicate', message: 'این کانال قبلاً وجود دارد.' };
  }

  let title: string | null = null;
  if (opts.token) {
    try {
      const chat = await getChatByUsername({ token: opts.token }, parsed.username);
      title = chat.title;
    } catch (e) {
      if (e instanceof TelegramError && e.status === 400) {
        return { code: 'not_public_channel', message: 'کانال در تلگرام یافت نشد یا عمومی نیست.' };
      }
      return { code: 'telegram_unavailable', message: 'ارتباط با تلگرام برقرار نشد.' };
    }
  }

  const inserted = await insertChannel(db, parsed.username, title, true);
  if (!inserted) return { code: 'duplicate', message: 'این کانال قبلاً وجود دارد.' };

  return {
    code: 'added',
    message: '✅ کانال با موفقیت اضافه شد.',
    channel: inserted,
  };
}

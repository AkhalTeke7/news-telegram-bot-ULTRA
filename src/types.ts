export interface Env {
  DB: D1Database;
  /**
   * Cloudflare Browser Run binding. Optional: when it is absent the pipeline
   * still publishes every text digest and simply skips the single run image.
   */
  BROWSER?: import('./newsImage').BrowserBinding;
  /** Bot token from BotFather. Never exposed to the frontend. */
  TELEGRAM_BOT_TOKEN?: string;
  /** Single-owner admin password. Never exposed to the frontend. */
  ADMIN_PASSWORD: string;
  /** OpenCode Zen key. Wrangler secret only; never logged or persisted. */
  OPENCODE_API_KEY?: string;
  /**
   * Destination chat for Phase 4 publishing: "@channel_username" or a numeric
   * channel id. Server-side only — never exposed via API, UI, or the database.
   */
  TELEGRAM_DESTINATION_CHANNEL?: string;
  /** Numeric Telegram User.id allowed to administer the bot. Secret. */
  TELEGRAM_ADMIN_USER_ID?: string;
  /** X-Telegram-Bot-Api-Secret-Token shared with Telegram. Secret. */
  TELEGRAM_WEBHOOK_SECRET?: string;
  /** Optional bot username, used only to recognize /start@botname. */
  TELEGRAM_BOT_USERNAME?: string;
}

// Lets `cloudflare:test` type `env` without re-declaring the binding shape.
export type WorkerEnv = Env;
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}

export interface ChannelRow {
  id: number;
  channel_username: string;
  channel_title: string | null;
  enabled: number;
  last_checked_at: string | null;
  last_processed_message_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface Channel {
  id: number;
  channelUsername: string;
  channelTitle: string | null;
  enabled: boolean;
  lastCheckedAt: string | null;
  lastProcessedMessageId: number | null;
  createdAt: string;
  updatedAt: string;
}

export function toChannel(row: ChannelRow): Channel {
  return {
    id: row.id,
    channelUsername: row.channel_username,
    channelTitle: row.channel_title,
    enabled: row.enabled === 1,
    lastCheckedAt: row.last_checked_at,
    lastProcessedMessageId: row.last_processed_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

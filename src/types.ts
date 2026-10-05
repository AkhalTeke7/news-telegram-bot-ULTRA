export interface Env {
  DB: D1Database;
  /**
   * Cloudflare Browser Run binding. Optional: when it is absent the pipeline
   * still publishes every text digest and simply skips the single run image.
   */
  BROWSER?: import('./newsImage').BrowserBinding;
  /** Bot token from BotFather. Never exposed to the frontend. */
  TELEGRAM_BOT_TOKEN?: string;
  /** Optional Bale Business Bot credentials. Secrets only. */
  BALE_BOT_TOKEN?: string;
  BALE_DESTINATION_CHANNEL?: string;
  /** Single-owner admin password. Never exposed to the frontend. */
  ADMIN_PASSWORD: string;
  /**
   * OpenRouter API key (https://openrouter.ai). Preferred secret name for the
   * chat-completions provider. Wrangler secret only; never logged or persisted.
   */
  OPENROUTER_API_KEY?: string;
  /**
   * Legacy secret name from the OpenCode/Zen era. Still read as an alias for
   * OPENROUTER_API_KEY so existing deployments that stored an OpenRouter key
   * under this name keep working with no re-configuration.
   */
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
  /**
   * Optional tuning: minimum milliseconds between two OpenRouter chat
   * requests, keeping a run under the free tier's account-wide ~20
   * requests/minute cap. Default 3200. Plain var, not a secret.
   */
  AI_REQUEST_PACE_MS?: string;
  /**
   * Optional tuning: milliseconds to wait between two album card renders,
   * honoring the Browser Run free-tier limit of ~1 Quick Action per 10
   * seconds. Default 10500. Plain var, not a secret.
   */
  IMAGE_RENDER_SPACING_MS?: string;

  /* ------------------------------------------------- scheduled jobs (new) -- */

  /**
   * Workers KV. Holds the Forex Factory response cache and the 30-minute
   * /slideshow navigation sessions. Optional: without it the calendar job
   * simply calls the source every run and /slideshow is disabled, rather than
   * the Worker failing to boot.
   */
  KV?: KVNamespace;
  /**
   * R2 bucket for rendered slide PNGs. Optional and purely an archive: slides
   * are sent to Telegram from memory and the send never depends on R2.
   */
  MEDIA?: R2Bucket;

  /** IANA timezone for "today", local times and Jalali dates. Default Asia/Tehran. */
  TIMEZONE?: string;
  /** Brand name shown in the slide footer. Default «اخبار فوری». */
  BRAND_NAME?: string;

  /* ------------------------------------------------------- LLM providers -- */

  /** NVIDIA NIM key (starts `nvapi-`). Secret. */
  NVIDIA_API_KEY?: string;
  /** Model id for NVIDIA NIM, e.g. `meta/llama-3.3-70b-instruct`. */
  NVIDIA_MODEL?: string;
  /**
   * OpenCode Zen key. Deliberately NOT `OPENCODE_API_KEY`: that name is a
   * legacy alias for an OpenRouter key elsewhere in this repo.
   */
  OPENCODE_ZEN_API_KEY?: string;
  OPENCODE_ZEN_MODEL?: string;
  /** Kilo Gateway key. Secret. */
  KILO_API_KEY?: string;
  KILO_MODEL?: string;
  /** Explicit model for OpenRouter in the NEW jobs only. */
  OPENROUTER_MODEL?: string;
  /** Comma-separated attempt order, e.g. `nvidia,kilo,openrouter`. */
  LLM_PROVIDER_ORDER?: string;
  /** Max LLM calls per local day across all new jobs. Default 60. */
  LLM_DAILY_BUDGET?: string;

  /* ------------------------------------------------------------- jobs ----- */

  /** Minimum LLM score (0-10) required to send a breaking alert. Default 8. */
  BREAKING_MIN_SCORE?: string;
  /** Max breaking alerts per local day. Default 8. */
  BREAKING_DAILY_CAP?: string;
  /** Max slides per slideshow run. Default 10 (Telegram album maximum). */
  SLIDESHOW_MAX_ITEMS?: string;
  /**
   * Numeric Telegram User.id for admin-only commands. Alias of
   * TELEGRAM_ADMIN_USER_ID; whichever is set wins.
   */
  ADMIN_ID?: string;
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

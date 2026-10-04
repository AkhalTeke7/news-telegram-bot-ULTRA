# Telegram News Summarizer Bot

Persian (Farsi) RTL news bot on Cloudflare Workers. Every hour it reads public Telegram
source channels, summarizes the last hour of posts in Persian using **free OpenCode/Zen
models only**, and publishes the summaries to one destination Telegram channel.

No paid models, no MTProto, no external services, no OpenRouter.

## Pipeline

```
Cron (hourly, at :00 Tehran time)
  └─ collect   → GET https://t.me/s/<username>   → D1 `messages`   (1-hour window, deduped)
  └─ filter    → local advertisement filter      → filter_status    (no AI, no network)
  └─ summarize → POST https://opencode.ai/zen/v1/chat/completions → summary_text
  └─ publish   → POST https://api.telegram.org/bot<token>/sendMessage
```

Each stage is isolated: one failing channel, message, or model never stops the rest.
Failures are retried on the next hourly run because a message is only marked complete
after its work is persisted.

## Requirements

- Node.js 20+
- A Cloudflare account
- A Telegram bot that is **administrator of the destination channel**
- An OpenCode/Zen API key

## 1. D1 database

```bash
npx wrangler d1 create news-bot
```

Copy the returned `database_id` into the `d1_databases` entry in `wrangler.json` (the
binding the Worker code uses is `DB`), then apply the schema:

```bash
npx wrangler d1 migrations apply news-bot --remote   # production
npm run db:migrate:local                              # local
```

> Local safety: `wrangler dev` uses the local D1 state in `.wrangler/`. Never add
> `"remote": true` to a `d1_databases` entry — it makes local development read and write
> the production database. Keep exactly one D1 binding, the one named `DB`.

Migrations, in order:

| File | Adds |
|---|---|
| `0001_init.sql` | `channels`, `cron_runs` |
| `0002_messages.sql` | `messages` (UNIQUE per channel + telegram_message_id, FK cascade) |
| `0003_ai_summaries.sql` | `summary_text`, `summary_model`, `summarized_at`, `ai_settings` |
| `0004_publishing.sql` | `published_at`, `telegram_destination_message_id`, publish bookkeeping |
| `0005_cron_runs.sql` | hourly-run outcome columns, `last_publish_error_at` |
| `0006_telegram_admin.sql` | `telegram_admin_state` (short-lived D1 conversation state) |
| `0007_ad_filter.sql` | `messages.filter_status` / `filter_reason` / `filtered_at`, `cron_runs.messages_filtered` |

## 2. Telegram bot setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and keep the token.
2. Add the bot to the **destination** channel as an administrator with permission to post
   messages. Without this, `sendMessage` to a channel fails.
3. Source channels must be **public** (they need a `@username`) because they are read from
   the public web preview. The bot does not need to be a member of source channels.

## 3. Secrets

Never commit real values. Production secrets are set through Wrangler:

```bash
npx wrangler secret put ADMIN_PASSWORD                 # admin panel password
npx wrangler secret put TELEGRAM_BOT_TOKEN             # from BotFather
npx wrangler secret put OPENCODE_API_KEY               # https://opencode.ai
npx wrangler secret put TELEGRAM_DESTINATION_CHANNEL   # @your_channel or -1001234567890
npx wrangler secret put TELEGRAM_ADMIN_USER_ID         # numeric Telegram User.id
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET        # X-Telegram-Bot-Api-Secret-Token
```

| Variable | Secret | Purpose |
|---|---|---|
| `ADMIN_PASSWORD` | yes | Single-owner web admin login. Unlocks the session cookie. |
| `TELEGRAM_BOT_TOKEN` | yes | Bot API: verify added channels, publish summaries, serve the Telegram admin UI. |
| `OPENCODE_API_KEY` | yes | OpenCode/Zen chat completions. |
| `TELEGRAM_DESTINATION_CHANNEL` | yes (not a credential, kept out of git anyway) | Where summaries are published. |
| `TELEGRAM_ADMIN_USER_ID` | yes | Numeric Telegram `User.id` allowed to administer the bot over Telegram. |
| `TELEGRAM_WEBHOOK_SECRET` | yes | Value Telegram echoes back in `X-Telegram-Bot-Api-Secret-Token`; must be ≥16 chars. |

`TELEGRAM_DESTINATION_CHANNEL` accepts `@channel_username` or a numeric channel id such as
`-1001234567890`. It is read only in `src/publisher.ts` and is never returned by an API,
shown in the UI, or written to the database.

## Publishing format

Each source channel produces **one destination message** per run, in configured channel
order, containing that channel's news oldest → newest. There is no header; the channel and
the destination appear only once each, as publishing metadata in the footer:

```
امام جمعه مشهد اعلام کرد که مراسم این هفته برگزار می‌شود.

همزمان وزیر راه از باز شدن ۲۰ کیلومتر مسیر جدید خبر داد که درآمد سالانهٔ آن ۴۰ میلیارد تومان است.

منبع: @news1
@destination_channel
```

The publisher owns that metadata; the AI never writes it. The footer is produced by the
publisher from the real source channel and `TELEGRAM_DESTINATION_CHANNEL` (which is
normalized for display only — the actual `sendMessage` target is unchanged). A channel with
no publishable news sends nothing. Channels are never merged. The message contains only the
summaries and that footer — no post text, no message/database ids, no model name, no
filter data, and **no URLs** (Eitaa, `t.me`, `telegram.me`, `www.`, bare domains or any other
link is stripped before the AI ever sees it; see the filter section).

Only Telegram's 4096-character limit can split a channel's output; the length calculation
includes every summary, the blank lines and both footer lines. A summary is never cut to
fit — a new part is started, and each part repeats the same footer. A single summary too
long to fit alone is trimmed deterministically so the footer always survives.

Per-run safety bound: publishing spends whatever is left of the Workers **Free** limit of
50 subrequests per invocation, after reserving room for what earlier stages need — one
fetch per enabled source channel for collection, up to 20 for summarization, and
occasionally one for the model list. `publishMessageBudget(enabledChannels)` in
`src/publisher.ts` computes it and caps it at `MAX_MESSAGES_PER_RUN = 40`. There is **no**
per-channel or global row cap, so current-window news is never silently postponed. When the
bound is reached the remaining rows are recorded with the explicit `run_limit` category and
stay unpublished, so the next run continues with them in the same configured order (verified:
an 18-channel setup and a 200-item backlog both drain completely across runs, each item
delivered exactly once).

Items are marked `published_at` (with `telegram_destination_message_id`) only after Telegram
confirms each delivered message, so a failed or rate-limited part is retried next run
without duplicating what already went out.

## Advertisement filter

Before any OpenCode call, every collected post is scored locally by `src/adFilter.ts`.
It is pure, offline and deterministic — no AI, no DNS, no HTTP — so the same text always
gets the same verdict.

* Text is normalized first: Persian/Arabic digits → ASCII, Arabic letter variants folded,
  zero-width characters removed (zero-width spaces and ZWNJ become separators so
  `شرط‌بندی` matches `شرط بندی`), harakat stripped, punctuation and whitespace collapsed,
  English lowercased. URLs are scanned before punctuation is stripped so they still count.
* Signals are weighted: referral bait, gambling/casino promos, calls to action, discount
  offers, commercial contact details and promo-URLs. One centralized threshold decides:
  `ADVERTISEMENT_SCORE_THRESHOLD` in `src/adFilter.ts`.
* News wins ties. Bare commercial words (خرید، فروش، قیمت، بازار، محصول) are **not**
  signals, a lone URL is not a signal, and reportage wording (`پلیس`، `مسدود`، `بازداشت`،
  `قانون`، `police`، `arrested`…) only *lowers* the score. So «پلیس یک سایت شرط‌بندی را
  مسدود کرد» stays news while «سایت شرط بندی با بونوس و ثبت نام» is filtered.
* Verdicts are persisted in `messages.filter_status` (`pending` / `filtered` / `passed`,
  enforced by a CHECK constraint) with a short Persian `filter_reason`. A message is
  scored exactly once, and filtered messages are excluded from both summarization and
  publishing, so they never reach OpenCode and are never reconsidered on later runs.
* Before summarization the post body is also cleaned by `stripExternalIdentifiers()`:
  absolute URLs, `www.`, bare domains, shortened/tracking links, Telegram hosts
  (`t.me`, `telegram.me`, `telegram.dog`), Eitaa, social handles, invite/join links and
  QR destinations are removed, and any `@handle` other than the source channel's own
  identity is dropped. The source username is passed in explicitly as the single trusted
  identifier. Ordinary news content — names, organisations, places, numbers, percentages,
  dates and phone numbers — is left untouched, and the raw `message_text`/`source_url`
  stay in D1 for tracking and deduplication.
* No domain is ever fetched or resolved — external links are matched as text only.

## Telegram administration

The admin can manage everything from Telegram with the same bot that publishes the news.

### Authorization model

Only the numeric `User.id` in `TELEGRAM_ADMIN_USER_ID` is authorized. Usernames, first
names and chat titles are never trusted, and there is exactly one administrator in this
phase. Everyone else receives `دسترسی غیرمجاز است.` with no hint about the expected id.
The configured id is never echoed back in replies, errors or logs.

**Getting your numeric user id:** message [@userinfobot](https://t.me/userinfobot), or open
`https://api.telegram.org/bot<TOKEN>/getUpdates` (temporarily, before the webhook is set)
and read `message.from.id` from the update JSON. The value must be digits only.

**Choosing the webhook secret:** any random string of at least 16 characters, e.g.
`openssl rand -hex 24`. It is only ever compared, never logged.

### Bot commands and buttons

`/start` shows the menu: add channel, list channels, system status, AI model status, last
run, manual processing, cancel. Channel deletion and manual processing both require an
explicit confirmation button, and a pending confirmation expires after 10 minutes
(`telegram_admin_state` in D1 — Workers are stateless, so pending actions live in the
database and expire automatically).

### Manual processing

`📰 پردازش دستی` → `▶️ اجرای پردازش` runs the **same** `runNewsPipeline()` used by the
hourly Cron Trigger, so a manual run keeps the one-hour window, deduplication,
free-model-only policy, model rotation, summary/publish validation, Telegram rate-limit
handling, per-channel and per-message isolation, stage isolation, publishing limits and
cron bookkeeping. The webhook returns immediately and reports the outcome when finished.

### Webhook configuration (after deploying)

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d url="https://<your-worker-domain>/api/telegram/webhook" \
  -d secret_token="<same value as TELEGRAM_WEBHOOK_SECRET>" \
  -d allowed_updates='["message","callback_query"]'
```

`<your-worker-domain>` is your deployed Worker URL. The bot needs no special permissions
beyond posting, which it already has in the destination channel. Verify with
`getWebhookInfo`. Remove it again with
`curl -X POST "https://api.telegram.org/bot<TOKEN>/deleteWebhook"`.

For local development copy `.dev.vars.example` to `.dev.vars` (git-ignored) and fill in
placeholders/values.

## 4. Run locally

```bash
npm install
cp .dev.vars.example .dev.vars     # then edit .dev.vars
npm run db:migrate:local
npm run dev                        # http://127.0.0.1:8787
```

Other scripts:

```bash
npm test          # vitest (Workers runtime + D1)
npm run typecheck # tsc --noEmit
npm run build     # wrangler dry-run bundle into dist/
```

## 5. Deploy

After all development and QA are complete:

```bash
npx wrangler d1 migrations apply news-bot --remote
npx wrangler deploy
```

Then register the Telegram webhook once (values come from the two Telegram secrets):

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d url="https://<your-worker-domain>/api/telegram/webhook" \
  -d secret_token="<same value as TELEGRAM_WEBHOOK_SECRET>" \
  -d allowed_updates='["message","callback_query"]'
```

The Worker exposes the admin panel at `/` (Persian RTL), `GET /healthz`, the Telegram
webhook at `POST /api/telegram/webhook`, and an authenticated `GET /api/status`
diagnostics endpoint. Everything else under `/api` requires the admin session cookie.

## Admin API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | public liveness |
| POST | `/api/telegram/webhook` | Telegram updates; requires `X-Telegram-Bot-Api-Secret-Token` |
| POST | `/api/auth/login` | `{password}` → signed HttpOnly cookie |
| POST | `/api/auth/logout` | clears the cookie |
| GET | `/api/auth/session` | session probe |
| GET | `/api/channels` | list with per-channel counts |
| POST | `/api/channels` | `{username}` or `{url}`; 409 on duplicate |
| PATCH | `/api/channels/:id` | `{enabled: boolean}` |
| DELETE | `/api/channels/:id` | 204 |
| GET | `/api/status` | counts, timestamps, error categories (no secrets) |

Write endpoints require `content-type: application/json` and the session cookie
(`HttpOnly`, `Secure`, `SameSite=Strict`), which blocks CSRF.

## How free-model discovery works

1. `GET https://opencode.ai/zen/v1/models` (no key needed for this endpoint).
2. A model is usable **only** if the API says it is free:
   - **pricing metadata present** → free only when every discovered input/output price is `0`.
   - **no pricing, explicit `free: true`** → free.
   - **no pricing and no flag** → only ids ending in `-free`; everything else is excluded.
   A model with unknown pricing is never selected.
3. The free list is cached in `ai_settings` and refreshed at most once every 24 hours.
4. On `rate_limited`/`provider_error` the failed model is excluded, the list is refreshed
   immediately, and another free model is selected. If no free model is available the run
   stops and the messages stay unsummarized — there is no paid fallback anywhere.

## Hourly cron behaviour

**The automatic pipeline runs at the beginning of every Iranian hour** (`Asia/Tehran`).

Cloudflare's Cron Triggers are **UTC only** — the docs state "Cron Triggers execute on UTC
time" and the supported-syntax table has no timezone field, so `CRON_TZ`/`TZ=` prefixes are
**not** available. The schedule is therefore expressed in UTC and converted by hand:

| Iranian hour | UTC firing |
|---|---|
| 00:00 Tehran | 20:30 UTC (previous day) |
| 01:00 Tehran | 21:30 UTC |
| … | … |
| 23:00 Tehran | 19:30 UTC |

Iran is a fixed **UTC+03:30** with no daylight saving (abolished in 1401 SH / 2022), so
every Iranian hour boundary falls on a UTC `:30`. A single trigger covers all 24 hours:

```jsonc
"triggers": { "crons": ["30 * * * *"] }
```

There is exactly one automatic trigger, and manual Telegram processing is unaffected.

Timestamps are stored canonically in UTC (`cron_runs.ran_at`, `created_at`, …) and are
converted to `Asia/Tehran` only when displayed to the admin, using the runtime's IANA
timezone support (`Intl.DateTimeFormat` with `timeZone: 'Asia/Tehran'`), never a manual
"+3:30" addition. Admin screens and the hourly Telegram report show the Persian (Jalali)
date and local time, e.g. `زمان اجرا: ۱۴۰۴/۱۰/۲۶ - ۰۰:۰۰ به وقت تهران`.

Each run writes a `cron_runs` row (`status`, counters, duration, error summary) so the admin
panel can show real outcomes. Only posts inside the previous one hour are considered,
`UNIQUE (source_channel_id, telegram_message_id)` prevents duplicates, and a Telegram `429`
stops that run's publish pass instead of retry-looping, leaving the rest for the next hour.

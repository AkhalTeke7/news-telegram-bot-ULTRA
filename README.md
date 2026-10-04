# Persian News Bot for Telegram and Bale

Persian (Farsi) RTL news bot on Cloudflare Workers. Every two hours it collects news from public
Telegram channels and configured RSS feeds, filters advertisements, summarizes and ranks
stories with **free OpenRouter models only**, renders the run as a Vazirmatn HTML
screenshot with Cloudflare Browser Run (top-4 news as cards plus every remaining headline
in a one-line ticker), and publishes high-resolution images plus HTML-formatted text digests to
Telegram and, when configured, mirrors the same rich output to Bale. Digest headlines use the AI
topic category for a related emoji, and every story includes its title, summary details, and
available key points.

RSS sources currently include BBC Persian, Zoomit, Mobile.ir, and IRIB News. No paid
models, MTProto, or committed credentials are required. Chat completions run through
the OpenRouter API using only its free models.

## Pipeline

```
Cron (every two hours, at even Tehran hours)
  └─ collect   → Telegram previews + RSS feeds  → D1 `messages`   (2-hour window, deduped)
  └─ filter    → local advertisement filter      → filter_status    (no AI, no network)
  └─ summarize → POST https://openrouter.ai/api/v1/chat/completions → summary_text + title
  └─ rank      → one global AI comparison        → importance (1–5)
  └─ publish   → Browser Run HTML screenshot + Telegram/Bale sendPhoto (important news)
             └─ text digest → Telegram/Bale sendMessage
```

Each stage is isolated: one failing channel, message, or model never stops the rest.
Failures are retried on the next run (every two hours) because a message is only marked
complete after its work is persisted.

### Collection-only mode

The admin panel has a «فقط جمع‌آوری اخبار» switch. When it is on, the pipeline
shrinks to just the `collect` stage: the bot fetches and stores raw news but
never filters, summarizes, ranks or publishes anything — nothing is sent to the
destination channel. Raw messages stay in D1, so switching the mode back off lets
the normal pipeline pick everything up on the next run. The setting is persisted
in `ai_settings` (key `collection_only_mode`), not in code or secrets.

The panel also has manual test buttons wired to authenticated endpoints:

| Button | Endpoint | Effect |
| --- | --- | --- |
| 📥 جمع‌آوری فوری اخبار | `POST /api/pipeline/run` `{mode:"collect"}` | One forced collection-only run (this run only) |
| ⚙️ اجرای کامل پردازش | `POST /api/pipeline/run` `{mode:"process"}` | One forced full pipeline run, even in collection-only mode |
| 🧪 ارسال پیام آزمایشی | `POST /api/telegram/test-message` | Test message to the destination channel |
| 🖼 ارسال تصویر آزمایشی | `POST /api/telegram/test-image` | Test news image to the destination channel |

Calling `POST /api/pipeline/run` without a `mode` follows the stored setting.
The mode itself is read via `GET /api/settings` and changed via
`POST /api/settings` `{"collectionOnly": true|false}`.

## Requirements

- Node.js 20+
- A Cloudflare account
- A Telegram bot that is **administrator of the destination channel** (optional if only Bale is used)
- A Bale bot and destination channel (optional)
- An OpenRouter API key (https://openrouter.ai)
- A Cloudflare Browser binding for image generation

## 0. Install dependencies

```bash
npm install          # or: npm ci — installs exactly what package-lock.json pins
```

Do this in every fresh clone **before** any `wrangler` command that bundles code
(`deploy`, `dev`, `build`). `npx` fetches Wrangler itself on demand but never installs
the project's own dependencies (`hono`), so skipping this step fails the build with
`✘ [ERROR] Could not resolve "hono"` — see [Troubleshooting](#troubleshooting).

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
| `0008_title_importance.sql` | AI `title` and global `importance` (1–5) for ranking/image selection |
| `0009_ai_editorial_metadata.sql` | AI highlights, confidence, category, processing timestamp, and ranking indexes |
| `0010_rss_sources.sql` | Configurable BBC Persian, technology, and Iranian RSS source registry |
| `0011_rss_channel_metadata.sql` | Marks RSS-backed channels and stores their feed URLs |

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
npx wrangler secret put BALE_BOT_TOKEN                 # from Bale bot management
npx wrangler secret put OPENROUTER_API_KEY             # https://openrouter.ai
# (legacy name still honored: a key stored as OPENCODE_API_KEY keeps working)
npx wrangler secret put TELEGRAM_DESTINATION_CHANNEL   # @your_channel or -1001234567890
npx wrangler secret put BALE_DESTINATION_CHANNEL       # @channel or numeric chat id
npx wrangler secret put TELEGRAM_ADMIN_USER_ID         # numeric Telegram User.id
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET        # X-Telegram-Bot-Api-Secret-Token
```

| Variable | Secret | Purpose |
|---|---|---|
| `ADMIN_PASSWORD` | yes | Single-owner web admin login. Unlocks the session cookie. |
| `TELEGRAM_BOT_TOKEN` | yes | Telegram Bot API: verify channels, publish summaries, and serve the Telegram admin UI. |
| `BALE_BOT_TOKEN` | yes | Bale Business Bot API token used for Bale delivery. |
| `OPENROUTER_API_KEY` | yes | OpenRouter chat completions (free models only). Preferred secret name. |
| `OPENCODE_API_KEY` | legacy | Old secret name from the OpenCode era. Still read as an alias for `OPENROUTER_API_KEY`, so a key already stored under this name (e.g. an OpenRouter key saved as `OPENCODE_API_KEY`) works unchanged. |
| `TELEGRAM_DESTINATION_CHANNEL` | yes (configuration, kept server-side) | Telegram destination: `@channel` or numeric id. |
| `BALE_DESTINATION_CHANNEL` | yes (configuration, kept server-side) | Bale destination: `@channel` or numeric chat id. |
| `TELEGRAM_ADMIN_USER_ID` | yes | Numeric Telegram `User.id` allowed to administer the bot over Telegram. |
| `TELEGRAM_WEBHOOK_SECRET` | yes | Value Telegram echoes back in `X-Telegram-Bot-Api-Secret-Token`; must be ≥16 chars. |

`TELEGRAM_DESTINATION_CHANNEL` accepts `@channel_username` or a numeric channel id such as
`-1001234567890`. It is read only in `src/publisher.ts` and is never returned by an API,
shown in the UI, or written to the database.

## Bale delivery

Bale delivery mirrors the Telegram output through the official Bale Business Bot API at
`https://tapi.bale.ai/business/bot`: the single run image (`sendPhoto`, PNG multipart)
and every **delivered** text digest part (`sendMessage`). Add the Bale bot to the
destination channel with permission to post, then configure `BALE_BOT_TOKEN` and
`BALE_DESTINATION_CHANNEL` (both are required; without them publishing stays
Telegram-only).

The mirror is best-effort and fully isolated: a Bale failure is logged under the
`bale` operation with a safe reason and counted in the run report
(`publishing.bale.sent` / `failed`, shown as a «بیل: …» line in the Telegram manual-run
report), but never affects Telegram delivery or `published_at` state. Only parts Telegram
actually delivered are mirrored, so a later retry of an undelivered part cannot
duplicate on Bale. Bale calls carry a 15-second timeout so one slow request cannot
consume the invocation budget.

Bale credentials must never be placed in `wrangler.json`, committed to Git, or included
in `.dev.vars` committed files. Use `wrangler secret put` for tokens. Destination IDs
are also kept server-side to avoid exposing deployment configuration through the API.

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

## AI importance and channel image

After summaries are created, one global OpenRouter ranking request compares eligible news
across all enabled source channels and stores an `importance` score from 1 to 5. Score 1
means the item is not important enough for the visual; scores 2–5 are eligible. The
ranking is persisted in D1, so image selection is deterministic and independent of
channel order. Legacy rows with a null score remain eligible as a migration fallback.

When `BROWSER` is configured, publishing makes one Cloudflare Browser Run screenshot
request per pipeline run. The Worker builds a Persian RTL HTML/CSS frame with the top
four eligible items as cards (titles, summaries, source labels) and a horizontal
**ticker strip** below them carrying every remaining headline of the run — one brief
single-line entry per item, truncated at a word boundary, with a trailing
«و n خبر دیگر» line when more than eight remain. The footer credits every channel
visible in the image, cards and ticker alike. Browser Run rasterizes it at 2560×1440 with
high-contrast, larger card typography so the summary details remain readable when Telegram scales
the photo down;
the PNG is immediately sent to the destination with Telegram `sendPhoto` (and mirrored
to Bale when configured) and is not stored in D1 or R2. Image failure is isolated, so
the ordinary per-channel text digests still publish.

## Advertisement filter

Before any OpenRouter call, every collected post is scored locally by `src/adFilter.ts`.
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
  publishing, so they never reach OpenRouter and are never reconsidered on later runs.
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
run, manual processing, test message, free-model picker (`🧠 انتخاب مدل رایگان`), cancel. Channel deletion and manual processing both
require an explicit confirmation button, and a pending confirmation expires after 10
minutes (`telegram_admin_state` in D1 — Workers are stateless, so pending actions live in
the database and expire automatically).

### Test message

`/test` (or the `🧪 پیام آزمایشی` menu button, or the same button in the web admin panel)
sends one clearly-marked test message to the configured destination channel and reports
the outcome. It verifies the exact publish path — `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_DESTINATION_CHANNEL`, and the bot's admin rights in the destination channel —
without waiting for the scheduled cron run and without needing fresh news in the window.

The shared implementation is `sendTestMessage()` in `src/testMessage.ts`; the Telegram
admin interface and the authenticated `POST /api/telegram/test-message` endpoint both call
it.

### Image-only test

`/testimage` (or the `🖼 تصویر آزمایشی` menu button, or the same button in the web admin
panel) tests ONLY the image path, end to end, with **real** news:

- it reads the actual pending publishable rows from D1 (exactly what the next run would
  publish), renders them through Browser Run (top-4 cards + ticker) and sends just the
  PNG to the destination with `sendPhoto`;
- **nothing is marked published** — the next real run still publishes every row normally;
  no text digests are sent;
- when there is no pending news (or every row scored importance 1) it replies
  «خبری در انتظار انتشار نیست» and sends nothing;
- failure categories: `no_news`, `browser_missing`, `destination_not_configured`,
  `invalid_destination`, `token_missing`, `render_failed`, plus the shared Telegram
  categories (`rate_limited`, `network`, `telegram_error`).

The implementation is `sendTestImage()` in `src/testImage.ts`; the API equivalent is the
authenticated `POST /api/telegram/test-image` (200 with `{messageId, cards, ticker,
bytes}`, 404 for no news, 503 for missing configuration, 502/429 for Telegram failures). It never throws: every failure comes back as a safe Persian reason with a stable
category (`destination_not_configured`, `invalid_destination`, `token_missing`,
`rate_limited`, `network`, `telegram_error`). Telegram's own rejection description (e.g.
`Bad Request: chat not found`) is shown to the admin because it is the fastest way to spot
a bot that is not an administrator of the destination channel; the token and the
destination value are never echoed, logged, or written to the database.

### Manual processing

`📰 پردازش دستی` → `▶️ اجرای پردازش` runs the **same** `runNewsPipeline()` used by the
bi-hourly Cron Trigger, so a manual run keeps the two-hour window, deduplication,
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

Production deploy, in order. Sections 1–3 (D1 database, Telegram bot, secrets) must be
done once before the first deploy, and every fresh clone needs `npm install` first
(section 0).

```bash
# 1) Install dependencies — REQUIRED before deploy. Skipping this fails the build
#    with "Could not resolve hono" (see Troubleshooting).
npm install                              # or: npm ci for a clean lockfile install

# 2) Apply migrations to the remote (production) D1 database.
#    On later deploys only needed when new migrations were added.
npx wrangler d1 migrations apply news-bot --remote

# 3) Deploy the Worker. On success Wrangler prints the live URL, e.g.
#    https://news-telegram-bot.<your-subdomain>.workers.dev
npx wrangler deploy
```

> `npm run deploy` is equivalent to step 3 and safe to run from a fresh clone: its
> `predeploy` hook runs `npm install` first.

Optional checks before or after deploying:

```bash
npm run typecheck    # tsc --noEmit
npm run build        # wrangler deploy --dry-run — bundles into dist/, uploads nothing
curl https://<your-worker-domain>/healthz
```

### Register the Telegram webhook (once, after the first deploy)

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d url="https://<your-worker-domain>/api/telegram/webhook" \
  -d secret_token="<same value as TELEGRAM_WEBHOOK_SECRET>" \
  -d allowed_updates='["message","callback_query"]'
```

`<your-worker-domain>` is the URL Wrangler printed in step 3. Verify with
`getWebhookInfo`; re-run `setWebhook` only if the Worker URL changes.

### Endpoints after deploy

The Worker exposes the admin panel at `/` (Persian RTL), `GET /healthz`, the exact
renderer preview at `GET /preview/news-image`, the Telegram webhook at
`POST /api/telegram/webhook`, an authenticated `GET /api/status`
diagnostics endpoint, the processing-mode endpoints (`GET`/`POST /api/settings`)
and `POST /api/pipeline/run` for manual runs. Everything else under `/api`
requires the admin session cookie.

## Troubleshooting

### Build fails with `Could not resolve "hono"`

```
✘ [ERROR] Build failed with 1 error:

  ✘ [ERROR] Could not resolve "hono"

      src/api.ts:1:21:
        1 │ import { Hono } from 'hono';
```

**Cause:** `node_modules/` is missing or incomplete — the command ran before
`npm install`. `npx wrangler …` downloads Wrangler itself on demand, but it does **not**
install the dependencies declared in `package.json` (`hono` is a runtime dependency).
The `"alias"` suggestion in Wrangler's error output is a red herring here — do not add
an alias entry.

**Fix:**

```bash
npm install
npx wrangler deploy
```

If `node_modules/` exists but is stale or half-installed, do a clean reinstall:

```bash
rm -rf node_modules && npm ci
```

Also check that Node.js is ≥ 20 (`node --version`) and that you are in the repository
root next to `wrangler.json`. If you deploy through Cloudflare's Git integration or
another CI pipeline, make sure the build command installs dependencies
(`npm ci` or `npm install`) before `npx wrangler deploy`.

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
| POST | `/api/telegram/test-message` | sends a test message to the destination; `{messageId}` on success, 503/502/429 with a Persian reason otherwise (no secrets) |
| POST | `/api/telegram/test-image` | renders the real pending news and sends only the image; `{messageId, cards, ticker, bytes}` on success, 404 no news, 503 config, 502/429 Telegram |

Write endpoints require `content-type: application/json` and the session cookie
(`HttpOnly`, `Secure`, `SameSite=Strict`), which blocks CSRF.

## How free-model discovery works

1. `GET https://openrouter.ai/api/v1/models` (no key needed for this endpoint).
2. A model is usable **only** if the API says it is free:
   - **pricing metadata present** → free only when every discovered price is `0`. OpenRouter
     reports prices as strings (`"0"`), which are parsed; numbers are still accepted.
   - **no pricing, explicit `free: true`** → free.
   - **no pricing and no flag** → only ids ending in `:free` (OpenRouter's convention, e.g.
     `deepseek/deepseek-chat-v3-0324:free`) or the legacy `-free`; everything else is excluded.
   A model with unknown pricing is never selected.
3. The free list is cached in `ai_settings` and refreshed at most once every 24 hours.
4. Automatic selection is **preference-ordered**, not "first id in the list": `scoreModelId()`
   in `src/modelManager.ts` ranks well-known instruction-following free families (DeepSeek,
   Gemini Flash, Llama 3.3/4, Qwen, Mistral, GLM, Kimi …) above unknown or experimental free
   endpoints, and penalises `:auto` routers plus vision/code/guard variants. This is why a run
   no longer settles on something like `apodex/apodex-1.1-mini:free` and fails every item.
5. Rotation on failure:
   - `rate_limited` / `provider_error` → the model is abandoned **immediately** and the list is
     refreshed;
   - `invalid_response` / `timeout` / `network` → abandoned after `MAX_MODEL_FAILURES` (2)
     consecutive failures. A free endpoint that answers HTTP 200 with prose instead of JSON used
     to burn an entire run (20 identical `invalid_response` errors, zero rotation); it now costs
     at most two items.
   If no free model is available the run stops and the messages stay unsummarized — there is no
   paid fallback anywhere.

### Choosing the model by hand

The free list is also selectable:

- **Web panel** → section *«مدل هوش مصنوعی (رایگان)»*: a dropdown of every free model, plus
  *«به‌روزرسانی فهرست مدل‌ها»* (one OpenRouter request) and *«خودکار»*.
- **Telegram** → menu button *«🧠 انتخاب مدل رایگان»*: a paginated keyboard; tap a model to pin
  it, *«♻️ خودکار»* to go back to automatic selection.
- **API** → `GET /api/models` (add `?refresh=1` to re-query OpenRouter) and
  `POST /api/models { "model": "<id>" | null }`.

The pin is stored as `pinned_model` in `ai_settings`, wins over automatic selection, and
survives the 24h refresh. Guarantees that still hold: only ids proven free by discovery can be
pinned (`setPinnedModel()` refuses anything else), and if a pinned model fails inside a run the
pipeline rotates away from it **for that run only** — the pin itself is never silently
rewritten.

### Why a run can report "0 summarized, N errors"

Run reports (Telegram, web panel and `POST /api/pipeline/run`) now name the cause instead of a
bare count:

- `علت خطای خلاصه‌سازی: پاسخ نامعتبر مدل (20)` — the selected free model is not returning the
  JSON contract; pin a different model.
- `تصویر خبری: ارسال نشد — اتصال Browser Run تنظیم نشده است` — the `BROWSER` binding is missing,
  so no picture can be rendered.
- `تصویر خبری: ارسال نشد — خبر مناسبی برای تصویر نبود` — nothing publishable survived the
  filters (the image needs at least one summarized, unpublished, non-`importance=1` row).

Related fix: candidates the ranking model omits from its answer are now scored `2`, not `1`.
Importance `1` means "do not publish" and removes a row from the run image, so a lazy/partial
ranking answer used to silently produce an empty picture.

## Bi-hourly cron behaviour

**The automatic pipeline runs at the beginning of every other Iranian hour**
(`Asia/Tehran`).

Cloudflare's Cron Triggers are **UTC only** — the docs state "Cron Triggers execute on UTC
time" and the supported-syntax table has no timezone field, so `CRON_TZ`/`TZ=` prefixes are
**not** available. The schedule is therefore expressed in UTC and converted by hand:

| Iranian hour | UTC firing |
|---|---|
| 00:00 Tehran | 20:30 UTC (previous day) |
| 02:00 Tehran | 22:30 UTC (previous day) |
| … | … |
| 22:00 Tehran | 19:30 UTC |

Iran is a fixed **UTC+03:30** with no daylight saving (abolished in 1401 SH / 2022), so
every Iranian hour boundary falls on a UTC `:30`. A single trigger covers the whole day:

```jsonc
"triggers": { "crons": ["30 */2 * * *"] }
```

The collector's window is **two hours** (`DEFAULT_WINDOW_MS` in `src/collector.ts`) to
match: a one-hour window would silently miss the news posted during the skipped hour, and
the `UNIQUE (source_channel_id, telegram_message_id)` constraint keeps the wider window
from double-inserting.

There is exactly one automatic trigger, and manual Telegram processing is unaffected.

Timestamps are stored canonically in UTC (`cron_runs.ran_at`, `created_at`, …) and are
converted to `Asia/Tehran` only when displayed to the admin, using the runtime's IANA
timezone support (`Intl.DateTimeFormat` with `timeZone: 'Asia/Tehran'`), never a manual
"+3:30" addition. Admin screens and the Telegram run report show the Persian (Jalali)
date and local time, e.g. `زمان اجرا: ۱۴۰۴/۱۰/۲۶ - ۰۰:۰۰ به وقت تهران`.

Each run writes a `cron_runs` row (`status`, counters, duration, error summary) so the admin
panel can show real outcomes. Only posts inside the previous two hours are considered,
`UNIQUE (source_channel_id, telegram_message_id)` prevents duplicates, and a Telegram `429`
stops that run's publish pass instead of retry-looping, leaving the rest for the next hour.

# Task 5 — Scheduler wiring, `/status`, and the deploy checklist

Everything built in tasks 1–4 is now reachable from a single `scheduled()`
handler, plus an admin-only `/status` command that reports on it.

---

## 1. What changed

### 1.1 The bug this fixed

`src/index.ts` used to be:

```ts
async scheduled(controller, env, ctx) {
  ctx.waitUntil(runNewsPipeline(env.DB, env, { trigger: controller.cron }));
}
```

That was correct while `wrangler.json` had exactly **one** cron. With four
triggers, Cloudflare delivers all of them to the same handler, so the digest
pipeline would have run **every five minutes** — roughly 288 digests a day
instead of 12, and every one of them publishing to the channel.

Routing on `controller.cron` is therefore not a refactor; it is what keeps the
pre-existing feature correct.

### 1.2 `src/scheduler.ts` — the router

Single source of truth for cron → job:

| Cron (UTC) | Job | Tehran | Notes |
| --- | --- | --- | --- |
| `30 */2 * * *` | `pipeline` | every other hour, on the hour | untouched legacy digest |
| `*/5 * * * *`  | `breaking` | every 5 min | Task 3 |
| `30 4 * * *`   | `calendar` | **08:00** | Task 2 |
| `0 */3 * * *`  | `slideshow`| 03:30, 06:30, … | Task 1 |

Guarantees:

* **Unknown cron does nothing, loudly.** `routeCron()` returns `null` and
  `dispatchScheduled` logs `{"status":"unrouted_cron", ...}` to stderr. It does
  *not* fall through to a default job — a typo in `wrangler.json` must disable a
  feature visibly, not silently run the wrong one.
* **Whitespace tolerant.** `30  4 * * *` (double space) still routes.
* **One `ctx.waitUntil` per job**, not one shared promise, so the runtime keeps
  each job alive independently.
* **`runScheduledJob` never throws and never rejects.** It is handed straight to
  `waitUntil`, where a rejection would be an unhandled promise. Every path —
  including the error path — returns a `JobOutcome`.
* **Bookkeeping in `job_runs`** (`started_at`, `finished_at`, `duration_ms`,
  `status`, `detail`). `startJobRun`/`finishJobRun` swallow their own errors, so
  a broken D1 degrades the *reporting*, never the job.
* **`pipeline` is deliberately excluded from `job_runs`** — it has written its
  own `cron_runs` rows since long before this task, and double-logging would
  make both tables lie.

A test asserts `Object.keys(CRON_ROUTES)` is **exactly** `wrangler.json →
triggers.crons`. If someone adds a trigger without adding a route, CI fails.

### 1.3 `src/jobStatus.ts` — the `/status` command

Admin-only (the existing `isAdmin()` gate at the top of `handleMessage` covers
it; a non-admin gets the same generic `دسترسی غیرمجاز است.` as for any other
command). Example output:

```
📊 وضعیت کارهای زمان‌بندی‌شده
۱۴۰۴/۰۷/۱۳ ۱۲:۲۴

✅ اخبار فوری (هر ۵ دقیقه)
   آخرین اجرا: 3 دقیقه پیش · 1.2s
   feeds=7/7 items=118 candidates=4 scored=2 sent=1

❌ تقویم اقتصادی (روزانه ۰۸:۰۰)
   آخرین اجرا: 4 ساعت پیش · 0.9s
   events=0 analyzed=0 messages=0 reason=source_http_status_403

⚪️ اسلایدشو (هر ۳ ساعت)
   هنوز اجرا نشده است.

✅ خلاصهٔ خبری (هر ۲ ساعت)
   آخرین اجرا: 51 دقیقه پیش · 8.4s
   دریافت=37 منتشرشده=6 خطا=0

🔒 قفل‌های امروز:
   calendar: sent (12 events)

🚨 هشدارهای امروز: 3/8
🖼 اسلایدهای ارسال‌شده (از نیمه‌شب UTC): 10

🤖 ارائه‌دهنده‌های فعال: openrouter، nvidia
💳 بودجهٔ امروز: 11/60 مصرف شده
   openrouter: 9 فراخوانی، 1 خطا
   nvidia: 2 فراخوانی، 0 خطا

⏱ زمان‌بندی (UTC):
   30 */2 * * * — خلاصهٔ خبری
   */5 * * * * — اخبار فوری
   30 4 * * * — تقویم اقتصادی
   0 */3 * * * — اسلایدشو
```

Notes:

* Each icon is the job's **last** recorded status: `✅ success`, `⚠️ partial`,
  `⏭ skipped`, `❌ failed`, `⏳ running`, `⚪️ never run`.
* A `⏳` that is hours old means a job was killed mid-run (CPU limit, deploy
  during a run) — that is the signal to look at `wrangler tail`.
* Technical figures use Latin digits on purpose; the cron expressions and
  `detail` strings next to them are ASCII, and mixing scripts inside one number
  column is unreadable.
* **Every lookup is individually `try`/`catch`ed.** A missing table or a D1
  hiccup degrades one line, not the whole report. A status screen that cannot
  render is worse than useless.
* Output is capped at 4000 chars (Telegram's limit is 4096).

---

## 2. Deploy checklist

Run top to bottom on a clean account. Everything is `npx wrangler …`; nothing
here needs the dashboard.

### Step 0 — prerequisites

```bash
node -v            # >= 20
npx wrangler --version
npx wrangler login
npm install
```

### Step 1 — create the resources

```bash
# D1 (skip if the database already exists — this repo ships an id)
npx wrangler d1 create news-bot

# KV: Forex Factory cache + /slideshow navigation sessions
npx wrangler kv namespace create KV

# R2: archive of rendered slide PNGs (debug / re-send)
npx wrangler r2 bucket create news-bot-media
```

`kv namespace create` prints something like:

```
{ "binding": "KV", "id": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6" }
```

**Copy that `id` into `wrangler.json`**, replacing the placeholder:

```jsonc
"kv_namespaces": [
  { "binding": "KV", "id": "REPLACE_WITH_KV_NAMESPACE_ID" }   // ← paste here
]
```

`d1 create` likewise prints a `database_id`; the one in `wrangler.json`
(`cc0b1042-…`) belongs to the existing deployment — replace it if you are
standing up your own.

R2 and D1 are referenced by **name**, so no further edits are needed for them.

> Both `KV` and `MEDIA` are optional at runtime (`Env` types them as `?`). With
> no KV the calendar job calls the source directly and `/slideshow` paging is
> disabled; with no R2 slides are simply not archived. Neither prevents boot.

### Step 2 — migrations

```bash
npx wrangler d1 migrations list news-bot --remote    # see what is pending
npx wrangler d1 migrations apply news-bot --remote   # 0001 … 0012
```

`0012_scheduled_jobs.sql` is the one this work depends on. It creates
`job_claims`, `job_runs`, `slideshow_sent`, `breaking_seen`, `breaking_alerts`,
`llm_usage`. It is additive and uses `CREATE TABLE IF NOT EXISTS`, so it is safe
to re-apply.

Verify:

```bash
npx wrangler d1 execute news-bot --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

### Step 3 — secrets

Nothing below belongs in `wrangler.json`, in the repo, or in a log line.

**Required:**

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN          # BotFather
npx wrangler secret put TELEGRAM_DESTINATION_CHANNEL # @channel or -100…
npx wrangler secret put TELEGRAM_ADMIN_USER_ID      # numeric User.id, digits only
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET     # openssl rand -hex 24
npx wrangler secret put ADMIN_PASSWORD              # web UI
```

**At least one LLM provider** (the router tries them in order and falls through
on any failure; with none configured the jobs still send, just without analysis):

```bash
npx wrangler secret put OPENROUTER_API_KEY     # openrouter.ai
npx wrangler secret put NVIDIA_API_KEY         # nvapi-…  integrate.api.nvidia.com
npx wrangler secret put OPENCODE_ZEN_API_KEY   # opencode.ai/auth
npx wrangler secret put KILO_API_KEY           # api.kilo.ai
```

> `OPENCODE_ZEN_API_KEY`, **not** `OPENCODE_API_KEY`. The latter is an old alias
> for an OpenRouter key elsewhere in this repo and would be routed to the wrong
> base URL. See the review document.

**Optional tuning** (plain vars — put them in `wrangler.json → vars`, not
secrets):

| Name | Default | Purpose |
| --- | --- | --- |
| `TIMEZONE` | `Asia/Tehran` | "today", local times, Jalali dates |
| `BRAND_NAME` | `اخبار فوری` | slide footer |
| `BREAKING_MIN_SCORE` | `8` | alert threshold, 1–10 |
| `BREAKING_DAILY_CAP` | `8` | max alerts per local day |
| `SLIDESHOW_MAX_ITEMS` | `10` | **set to `5` on the free plan** — see quotas |
| `LLM_DAILY_BUDGET` | `60` | LLM calls per local day, all jobs |
| `LLM_PROVIDER_ORDER` | — | e.g. `nvidia,kilo,openrouter` |
| `AI_REQUEST_PACE_MS` | `3200` | spacing between LLM calls |
| `IMAGE_RENDER_SPACING_MS` | `10500` | Browser Run free tier: 1 action / 10 s |
| `TELEGRAM_BOT_USERNAME` | — | lets `/status@yourbot` work in groups |

Confirm what is set (names only, never values):

```bash
npx wrangler secret list
```

### Step 4 — pre-flight

```bash
npm run typecheck     # tsc --noEmit
npm test              # 25 files, 731 tests
npm run check:feeds   # every RSS source: reachable? fresh? how many items?
npm run build         # wrangler deploy --dry-run --outdir dist
```

`npm run build` must list all five bindings:

```
env.KV (…)              KV Namespace
env.DB (news-bot)       D1 Database
env.MEDIA (…)           R2 Bucket
env.BROWSER             Browser Run
env.TIMEZONE            Environment Variable
```

If `env.KV` still shows `REPLACE_WITH_KV_NAMESPACE_ID`, step 1 is incomplete.

### Step 5 — deploy

```bash
npx wrangler deploy
```

Then register the Telegram webhook (once, or after changing the secret):

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://news-telegram-bot.<subdomain>.workers.dev/api/telegram/webhook" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

### Step 6 — verify the crons registered

`wrangler deploy` echoes the schedules it uploaded. Confirm independently:

```bash
npx wrangler triggers deploy          # re-sync triggers without a code deploy
```

Dashboard: **Workers & Pages → news-telegram-bot → Settings → Triggers → Cron
Triggers**. You must see exactly four, and they must match `CRON_ROUTES`:

```
30 */2 * * *
*/5 * * * *
30 4 * * *
0 */3 * * *
```

> Cron Triggers are **UTC only** — there is no timezone field. `30 4 * * *` is
> 08:00 Tehran because Iran has been a fixed UTC+03:30 with no daylight saving
> since 2022. If you change `TIMEZONE` to a zone that *does* observe DST, the
> cron will not follow it; you must shift the expression yourself twice a year.
> This coupling is manual and is listed in the review.

### Step 7 — watch the first runs

```bash
npx wrangler tail --format pretty
```

Within five minutes you should see one line per breaking run:

```json
{"event":"scheduled","job":"breaking","cron":"*/5 * * * *","status":"success",
 "detail":"feeds=7/7 items=118 candidates=0 reason=no_candidates","durationMs":2104}
```

`"status":"unrouted_cron"` means `wrangler.json` and `src/scheduler.ts` have
drifted apart. Fix the route, not the symptom.

Then, in Telegram, send the bot `/status` from the admin account.

---

## 3. Testing each trigger without waiting for the clock

### Locally

```bash
npx wrangler dev --test-scheduled
```

and in another shell (the cron string must be URL-encoded):

```bash
curl "http://localhost:8787/__scheduled?cron=*%2F5+*+*+*+*"   # breaking
curl "http://localhost:8787/__scheduled?cron=30+4+*+*+*"      # calendar
curl "http://localhost:8787/__scheduled?cron=0+*%2F3+*+*+*"   # slideshow
curl "http://localhost:8787/__scheduled?cron=30+*%2F2+*+*+*"  # legacy digest
curl "http://localhost:8787/__scheduled?cron=0+0+*+*+*"       # → unrouted_cron
```

Put real values in `.dev.vars` first (copy `.dev.vars.example`). `wrangler dev`
uses a **local** D1 by default, so apply migrations locally too:

```bash
npm run db:migrate:local
```

### Against production

```bash
npx wrangler tail --format pretty &
# trigger the daily job once, out of band:
npx wrangler dev --remote --test-scheduled
```

### Re-running the daily calendar on purpose

The calendar job is protected by an atomic D1 claim, so the second run of a day
is a no-op by design. To force a genuine re-send (only ever do this knowingly):

```bash
npx wrangler d1 execute news-bot --remote \
  --command "DELETE FROM job_claims WHERE job='calendar' AND claim_date='2026-10-05'"
```

### Unit tests for this task

```bash
npx vitest run test/scheduler.test.ts
```

25 tests covering: every cron routes to its own job; the `wrangler.json` ⇄
`CRON_ROUTES` parity check; the specific regression that `*/5 * * * *` must not
be `pipeline`; unknown and malformed crons; one `waitUntil` per job; three jobs
staying independent when one throws; `job_runs` rows written for success,
failure and partial; the pipeline *not* being double-logged; and the `/status`
renderer across empty, failed, populated, no-provider and broken-D1 states.

---

## 4. Quota math before you deploy

Verified against the Cloudflare limits page (last updated 2026-09-05):

| | Workers Free | Workers Paid |
| --- | --- | --- |
| CPU per Cron Trigger | **10 ms** | 30 s (< 1 h interval) / 15 min (≥ 1 h) |
| Subrequests | 50/request | 10,000/request |
| Requests | 100,000/day | no limit |
| Cron Triggers per account | **5** | 250 |
| Simultaneous outgoing connections | 6 | 6 |
| Worker size | 64 MiB | 64 MiB |

What this project actually uses:

* **Cron triggers: 4 of the 5 free slots.** One spare.
* **Subrequests per run:** breaking ≈ 7 feeds + 1 LLM + ≤2 sends ≈ 10.
  Slideshow ≈ 10 og:image + 10 screenshots + 1 LLM + 1 album ≈ 22. Calendar ≈ 1
  source + 1 LLM + ~8 sends ≈ 10. All under 50.
* **Bundle: 726 KiB raw / 235 KiB gzip**, against a 64 MiB limit. The jump from
  480 KiB happened here: `scheduler.ts` is the first production module to reach
  `slideshow/job` → `slideTemplate` → `fontAssets`, which carries the two
  base64-embedded Vazirmatn woff2 files. That is intentional — the fonts cannot
  be fetched from the internet at render time.
* **CPU is the real free-tier constraint, not bandwidth.** 10 ms is enough for a
  `fetch`-and-forward Worker; it is *not* obviously enough to parse seven RSS
  feeds every five minutes or to assemble a 1080×1350 HTML document with two
  embedded fonts. Network waiting does not count toward CPU, but XML parsing and
  base64 string building do. **Plan on the paid tier** ($5/mo), which raises
  these crons to 30 s (breaking, every 5 min) and 15 min (slideshow, 3 h).
* **Browser Run free tier is 10 browser-minutes/day and 1 Quick Action / 10 s.**
  Eight slideshow runs × 10 slides ≈ 80 screenshots ≈ 6–7 of those 10 minutes,
  before the legacy digest renders anything. On the free plan set
  `SLIDESHOW_MAX_ITEMS="5"`.
* **LLM budget:** `LLM_DAILY_BUDGET=60` against 288 breaking runs/day. This only
  works because a run makes at most **one batched** call, and only when
  candidates survive the keyword filter, the dedupe and the daily cap. Most runs
  make zero.

---

## 5. Files

| File | Role |
| --- | --- |
| `src/scheduler.ts` | cron → job routing, isolation, `job_runs` bookkeeping |
| `src/jobStatus.ts` | `/status` report |
| `src/index.ts` | `scheduled()` delegates to `dispatchScheduled` |
| `src/telegramAdmin.ts` | `/status` branch, before the pending-state checks |
| `test/scheduler.test.ts` | 25 tests for the above |
| `docs/REVIEW.md` | the problem list — **read before deploying** |

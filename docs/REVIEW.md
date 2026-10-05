# Review — problems found, nothing fixed

**Status: nothing in this document has been changed.** You asked for the list
first. Every item below is a finding with a proposed fix and an estimate; tell
me which ones to do and I will do exactly those.

Scope: the whole Worker, not just the code written for tasks 1–5. Severity is
about *production impact*, not code tidiness.

Legend: 🔴 fix before deploying · 🟠 fix soon · 🟡 worth doing · ⚪️ informational.

---

## A. Hardcoded secrets

**Result: none found.** I checked for literal API keys, bot tokens
(`\d{8,10}:[A-Za-z0-9_-]{30,}`), `sk-…`, `nvapi-…`, and `key/token/secret/password = "…"`
across `src/`, `scripts/`, `*.json` and the docs. Clean. `.dev.vars` is
git-ignored, only `.dev.vars.example` is tracked, and it contains placeholders.
No `console.log` interpolates a token, key or secret.

### A1 ⚪️ `database_id` is committed in `wrangler.json`

`wrangler.json:42` carries `cc0b1042-6204-4958-add6-611cf461a864`.

This is **not** a vulnerability — D1 ids are account-scoped resource
identifiers, they grant nothing without Cloudflare credentials, and
Cloudflare's own docs tell you to commit them. I am listing it only so you know
it is deliberate. **No action proposed.**

### A2 🟡 `OPENCODE_API_KEY` means two different things

`src/openrouter.ts:159` — `resolveAiApiKey()` treats `OPENCODE_API_KEY` as a
**legacy alias for an OpenRouter key**. But `OPENCODE_API_KEY` is also the name
OpenCode Zen's own documentation tells users to use.

If someone follows the OpenCode docs and runs
`wrangler secret put OPENCODE_API_KEY` with a real Zen key, the legacy
summarizer will send that key to `openrouter.ai` and every summarization will
fail with 401 — while the `/status` screen still shows the provider as
"configured".

I avoided the collision when building task 4 by naming the new one
`OPENCODE_ZEN_API_KEY`, so **nothing is broken today**; this is a foot-gun, not
a bug.

*Proposed fix:* make `resolveAiApiKey` ignore `OPENCODE_API_KEY` when its value
does not look like an OpenRouter key (`sk-or-…`), and log a one-line warning
naming the right variable. ~15 min, no behaviour change for correct configs.

---

## B. Missing timeouts

The rule "every outbound fetch gets a timeout and a try/catch" holds for all
code written in tasks 1–5 (`src/lib/http.ts` is the only module allowed a raw
`fetch`, and `safeFetch` always sets `AbortSignal.timeout`). Three pre-existing
call sites do not follow it.

### B1 🔴 `src/rssCollector.ts:13` — RSS fetch with no timeout

```ts
const response = await (opts.fetchImpl ?? fetch)(source.feed_url, {
  headers: { accept: 'application/rss+xml, application/xml, text/xml' },
});
```

No `AbortSignal`. This runs inside the legacy digest pipeline, which is on the
`30 */2 * * *` cron, **and it is in a sequential `for` loop over every enabled
source**. One feed that accepts the connection and then never responds stalls
the whole collection until the runtime kills the invocation. There is a
`try`/`catch` around it, so the error is recorded — but only after the hang.

Also: there is no `Range`/size cap, so a very large feed is fully buffered into
a 128 MB isolate.

*Proposed fix:* route it through `safeFetch` from `src/lib/http.ts` (8 s
timeout, response-size cap, structured error) like `src/breaking/rss.ts`
already does. ~20 min including a test. **This is the one I would fix first.**

### B2 🟠 `src/telegram.ts:37` — the generic `call()` helper has no timeout

```ts
async function call<T>(opts, method, payload) {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${base}/bot${opts.token}/${method}`, { … });
```

Every *other* function in that file sets `AbortSignal.timeout(...)`; this one
does not, and it also does not wrap the fetch in a `try`/`catch`, so a network
error surfaces as a raw `TypeError` rather than a `TelegramError`. Callers that
branch on `error instanceof TelegramError` therefore take the wrong path.

Reach is limited: only `getMe()` and `getChatByUsername()` use it, and the only
production caller is `addSourceChannel` (admin "add channel", via the web API
and the bot). So the blast radius is a hung admin request, not a hung cron. It
is still a direct violation of the stated rule.

*Proposed fix:* give `call()` the same `AbortSignal.timeout` + `try`/`catch` +
`TelegramError(0, …)` wrapper the other eight call sites use. ~15 min.

### B3 🟡 `env.BROWSER.quickAction()` has no client-side timeout

`src/newsImage.ts:79`. Binding calls cannot take an `AbortSignal`, so we depend
entirely on Cloudflare's own 60 s browser timeout. We *do* pass
`gotoOptions.timeout` (`src/slideshow/render.ts:99`), which bounds page
navigation but not the surrounding RPC.

With 10 slides rendered sequentially, worst case is 10 × 60 s of wall clock in
one cron invocation.

*Proposed fix:* race each `quickAction` against a `Promise` that rejects after
e.g. 25 s, and treat a timeout as "this slide failed" (the job already handles
partial renders). ~30 min. Lower priority than it sounds because the render
loop is already spaced at 10.5 s and capped by `SLIDESHOW_MAX_ITEMS`.

---

## C. Duplicate-send risks

All three new jobs deliberately mark-after-confirm, which makes them
**at-least-once**: a send that succeeds at Telegram but fails on the way back
(timeout reading the response, invocation killed) will be re-sent next run. I
chose that over at-most-once because silently losing a breaking alert is worse
than occasionally repeating one — but you should know where the seams are.

### C1 🟠 Breaking news has no up-front claim

`src/breaking/job.ts:320–345`. The flow is *check `breaking_alerts` → send →
`INSERT OR IGNORE INTO breaking_alerts`*. Two overlapping invocations of the
5-minute cron (one slow run plus the next one starting) can both pass the check
for the same `story_key` and both send. The `INSERT OR IGNORE` then silently
collapses them into one row, so you cannot even tell from the database that it
happened.

The same read-then-write race applies to the daily cap check — two concurrent
runs both read "6 of 8 used" and both send.

*Proposed fix:* mirror the calendar job. `INSERT OR IGNORE INTO breaking_alerts
(story_key, …) VALUES (…)` **before** sending, treat `meta.changes === 0` as
"someone else owns this story", and on send failure `DELETE` the row so the
story stays eligible. That makes the dedupe atomic in D1 instead of advisory.
~1 h with tests. **The highest-value item in this section.**

### C2 🟡 Slideshow has the same shape

`src/slideshow/job.ts:378–414`. `markSlidesSent` runs only after
`sendMediaGroup` resolves. Same race, but the window is a 3-hour cron rather
than 5 minutes, so overlap is far less likely. The realistic failure is a
timeout *after* Telegram accepted the album: the next run re-sends the same ten
slides.

*Proposed fix:* same claim-then-send pattern, or accept it and document it. ~1 h.

### C3 🟡 Calendar fails closed and loses the rest of the day

`src/calendar/job.ts:234–256`. If message 3 of 5 fails, the job calls
`markClaimSent(… 'partial:2/5')` and returns. That is correct for *not*
duplicating messages 1–2, but it also means events 3–5 are never sent and there
is no retry — a single transient 429 silently drops most of the day's calendar.

*Proposed fix:* record the per-message index in the claim detail and let a later
run resume from it, or (simpler) retry once on `TelegramRateLimitError` after
`retry_after` seconds. ~45 min.

### C4 ⚪️ Cron overlap, for the record

Cloudflare does not guarantee that a cron invocation finishes before the next
one of the same schedule starts, and does not retry failed scheduled
invocations. So the risks above come from *overlap*, not from retries. On the
free plan the 10 ms CPU limit makes long-running overlap unlikely; on paid, a
breaking run has 30 s of CPU and the `*/5` interval is 300 s, so overlap is
still remote but no longer impossible.

---

## D. Timezone bugs

### D1 ⚪️ Fixed (found during this task)

`src/jobStatus.ts` counted slides with `WHERE sent_at >= '<Tehran date>T00:00:00Z'`
while the label said "since UTC midnight". Between 00:00 and 03:30 Tehran that
bound is in the future and the count reads 0. **Already corrected** (it now
builds the window from `now.toISOString()`), with a regression test. Listed for
completeness.

### D2 🟠 `TIMEZONE` and the cron expressions are coupled by hand

`wrangler.json` hard-codes `30 4 * * *` to mean 08:00 Tehran, and `TIMEZONE`
independently says `Asia/Tehran`. Cron Triggers are UTC-only with no timezone
field, so changing `TIMEZONE` to, say, `Europe/Berlin` would leave the calendar
firing at 06:30 local in summer and 05:30 in winter, while the job still filters
events for "today in Berlin". Nothing warns you.

Iran has had no daylight saving since 2022, so **today this is correct and
stable** — the risk is purely a future config change.

*Proposed fix (cheap):* a startup assertion, or a line in `/status` showing what
local time each cron actually corresponds to under the current `TIMEZONE`, so a
mismatch is visible. ~30 min.
*Proposed fix (thorough):* run the calendar job hourly and let the job itself
decide whether local time has passed 08:00 and the claim is unused. Removes the
coupling entirely, costs one more cron slot (you have one free). ~1 h.

### D3 🟡 Feed timestamps without an offset are assumed UTC

`src/breaking/rss.ts` parses `pubDate`/`updated` with `new Date(...)`. A feed
that emits a bare local timestamp (no `Z`, no offset) is read as UTC. The
45-minute freshness window then mis-judges that item — too old, or spuriously
fresh.

All seven configured feeds currently emit RFC-822 or ISO-8601 *with* an offset,
so this is latent, not active. It would bite when you add a feed.

*Proposed fix:* treat an offset-less timestamp as unknown and fall back to
"seen at" time instead of guessing. ~30 min.

### D4 ⚪️ Everything else is consistent

Every "which day is it" decision (`job_claims.claim_date`,
`breaking_alerts.local_date`, `llm_usage.local_date`, the calendar's event
filter) goes through `localDateKey(now, timeZone)` backed by `Intl`. No string
slicing of ISO timestamps anywhere in the new code. The Forex Factory feed's
`-04:00` New York offsets are converted via `Intl`, with a test pinning
`2026-10-07T20:00-04:00` → `2026-10-08 03:30` Tehran.

---

## E. Unhandled Telegram errors

### E1 🟠 `retry_after` is parsed but never honoured in the new jobs

`src/telegram.ts:103` defines `TelegramRateLimitError` with
`retryAfterSeconds`, and `src/publisher.ts` (legacy) does back off on it. The
three new jobs only stringify it:

```ts
error instanceof TelegramError ? `telegram_${error.status}` : describeError(error)
```

So a 429 is treated as a hard failure. Concretely: the calendar job marks the
day sent and drops the remaining events (see C3); the breaking job `break`s out
of its send loop.

This matters because four jobs now share one channel. Telegram allows roughly
20 messages/minute to the same channel, and the calendar job can emit ~8
messages back to back at 08:00 — right when the `*/5` breaking job may also
fire.

*Proposed fix:* in the send loops, catch `TelegramRateLimitError`, `await` the
advertised `retry_after` (capped, e.g. ≤ 30 s), and retry once. ~45 min.

### E2 🟡 No pacing between messages inside one job

The calendar job sends its messages in a tight `for` loop with no delay. Same
rate-limit exposure as E1, from the other direction.

*Proposed fix:* ~1 s spacing between sends, reusing the existing
`AI_REQUEST_PACE_MS`-style env knob. ~20 min.

### E3 ⚪️ The webhook path is correct

`handleWebhook` (`src/telegramAdmin.ts:1138`) verifies
`x-telegram-bot-api-secret-token` with a constant-time compare, rejects a
missing/short secret with 503, caps the body at 64 KB twice (header and actual
length), and dispatches via
`ctx.waitUntil(handleTelegramUpdate(...).catch(() => undefined))` — so a
throwing handler still returns 200 and Telegram does not enter a retry loop
that would re-process the same update. No change proposed.

### E4 ⚪️ Admin notifications are already best-effort

`notifyAdmin` in `src/calendar/job.ts` never throws and never affects the job
result. Correct as-is.

---

## F. Other things worth knowing

### F1 🟠 Nothing prunes `job_runs`

`breaking_seen` has a 6-hour retention sweep (`src/breaking/confirm.ts:101`).
Nothing else does. The 5-minute cron writes **288 `job_runs` rows per day**
(~105,000/year), and `cron_runs`, `llm_usage`, `breaking_alerts`,
`slideshow_sent` and `messages` all grow without bound.

No limit is near-term (D1 free is 5 GB), but `/status` runs a
`GROUP BY job MAX(id)` over that table on every invocation, and it gets slower
forever.

*Proposed fix:* a `DELETE FROM job_runs WHERE started_at < date('now','-14 days')`
at the end of each run, plus the equivalent for the others. ~30 min, one
migration for the supporting index.

### F2 🟠 R2 slide archive has no lifecycle rule

`archiveSlide` writes `slides/<key>.png` and nothing ever deletes them. At 8
slideshow runs/day × up to 10 slides × a few hundred KB, that is roughly
0.5–1 GB **per month**, against a 10 GB free allowance. It is a debug archive;
it should not grow forever.

*Proposed fix:* add an R2 lifecycle rule (dashboard or
`wrangler r2 bucket lifecycle add`) expiring `slides/` after 14 days. ~10 min,
no code change. I would just do this one in the console.

### F3 🔴 The free plan's 10 ms CPU limit is the real deployment risk

Confirmed against the Cloudflare limits page (updated 2026-09-05): **CPU time
per Cron Trigger is 10 ms on Workers Free**, 30 s on paid for intervals under an
hour. Network waiting does not count — but parsing seven RSS feeds, running the
keyword filter and fingerprinting every item, and building a 1080×1350 HTML
document with two base64-embedded woff2 fonts all do.

If this is deployed to a free account I expect intermittent
`Worker exceeded resource limits` (error 1102) on the breaking and slideshow
crons. It will look like flaky, unexplained failures.

*Proposed action:* no code change — use the $5/mo Workers Paid plan, or accept
degraded reliability and set `SLIDESHOW_MAX_ITEMS="5"` plus a shorter feed list.
This is a decision for you, not a patch.

### F4 🟡 Breaking-news cross-source confirmation is advisory, not required

Already flagged at the end of task 3 and still open: a single source with a
score ≥ 8 is enough to publish; confirmation by a second independent source only
adds +1/+2 to the score. One feed publishing a wrong headline can therefore
produce an alert.

*Proposed fix:* a `BREAKING_REQUIRE_CONFIRMATION` flag (default off) that
requires ≥ 2 independent groups unless the source is in a trusted allow-list
(e.g. `fed-press`). One-line change plus config. ~30 min. **This is the question
I asked at the end of task 3 and is still unanswered.**

### F5 ⚪️ Bundle grew from 480 KiB to 726 KiB (235 KiB gzip)

Because `src/scheduler.ts` is the first production module to reach the
base64-embedded Vazirmatn fonts. The limit is 64 MiB, so this is fine — noted so
it does not look like an accident.

---

## Suggested order, if you want one

1. **B1** — RSS fetch timeout (20 min). Real hang risk on an existing cron.
2. **F3** — decide free vs paid plan. Costs nothing to decide, changes everything.
3. **C1** — atomic claim for breaking alerts (1 h). The only genuine duplicate-send path with a short window.
4. **E1 + E2** — honour `retry_after`, pace sends (~1 h). Four jobs now share one channel.
5. **F2** — R2 lifecycle rule (10 min, console only).
6. **F1** — retention sweep (30 min).
7. **F4** — answer the confirmation question, then a 30 min change.
8. The rest (A2, B2, B3, C2, C3, D2, D3) as you see fit.

Items 1–4 are about three hours of work including tests. Tell me which to
start and I will not touch anything else.

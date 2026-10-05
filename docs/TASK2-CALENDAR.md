# Task 2 — Daily Forex Factory red-news list

Status: **implemented and unit-tested.** Not yet called by `scheduled()` —
that is Task 5. Includes Task 4's analysis module, which Task 3 also uses.

---

## Source

`https://nfs.faireconomy.media/ff_calendar_thisweek.json` — **the only
accepted source.** Verified live again on 2026-10-05: no auth, no rate-limit
headers, a flat JSON array.

There is **no HTML fallback and no synthesized data anywhere in this code
path.** If the feed is unreachable, returns a non-200, returns invalid JSON,
or changes shape, the job:

1. sends nothing to the channel,
2. releases its day-claim so a later cron firing can retry,
3. DMs the admin: `❌ دریافت تقویم اقتصادی ناموفق بود (source_http_status_403)`.

A real record, copied verbatim:

```json
{"title":"FOMC Meeting Minutes","country":"USD",
 "date":"2026-10-07T14:00:00-04:00","impact":"High","forecast":"","previous":""}
```

Two traps in that payload, both handled and both covered by tests:

* **`country` is a CURRENCY code** (`USD`, `EUR`, …) or the literal `"All"` —
  not an ISO country code.
* **`date` carries a New York offset** (`-04:00`), not UTC. It is parsed as an
  instant and converted with `Intl`. Slicing the string would put the
  21:30-Tehran FOMC minutes on the wrong day.

`forecast`/`previous` are strings, frequently `""`, and can contain a pipe
(`"3.00|3.3"`) or suffixes (`%`, `K`, `M`, `B`, `T`). They are printed
verbatim and never parsed as numbers.

## Timing

| | |
|---|---|
| Cron | `30 4 * * *` (UTC — Cloudflare crons are UTC-only, no timezone field) |
| Local | **08:00 Asia/Tehran**, every day |
| Why it's exact | Iran is a fixed UTC+03:30 with no DST |

⚠️ If you change `TIMEZONE` to a zone **with** daylight saving, the local send
time shifts by an hour across DST boundaries. That's a property of UTC crons,
not a bug — the event filtering stays correct either way.

## Exactly-once delivery

Not "the cron only fires once" — that's an assumption, not a guarantee. The
real mechanism:

```sql
INSERT OR IGNORE INTO job_claims (job, claim_date) VALUES ('calendar', '2026-10-09')
```

D1 applies that as one statement, so of N concurrent or retried invocations
exactly one sees `meta.changes == 1`. Everyone else returns `alreadyClaimed`
and sends nothing. There's a test that fires four overlapping runs and asserts
exactly one message.

| Failure point | Claim | Rationale |
|---|---|---|
| Source fetch failed | **released** | Nothing was sent; a retry is safe. |
| No red events today | kept as `skipped` | Don't re-check all day. |
| LLM analysis failed | kept | Plain list still ships. |
| Telegram failed / timed out | **kept** (`sent`) | Outcome unknown — Telegram may have delivered. Failing closed costs at most one missed day, visible in `/status`. Releasing could double-post. |

## Caching

KV, 6-hour TTL (`calendar:ff:thisweek`) ⇒ at most 4 origin hits/day. Because
the file covers the whole **week**, a cached copy also rides out a transient
outage — still real upstream data, never invented. There's a test for that.

## Message

```
🗓 رویدادهای مهم اقتصادی امروز
📅 ۱۷ مهر ۱۴۰۵
🔴 تعداد رویدادهای پراهمیت: ۲

🔴 ۱۶:۰۰ — 🇨🇦 دلار کانادا
📌 Employment Change
   پیش‌بینی: 9.0K | قبلی: -41.7K
   ↗️ اگر بالاتر از پیش‌بینی: …
   ↘️ اگر پایین‌تر از پیش‌بینی: …
   🎯 دارایی‌های متأثر: دلار کانادا، نفت
   📊 نوسان احتمالی: زیاد

⚠️ تحلیل صرفاً آموزشی و سناریومحور است و توصیه مالی نیست.
```

Times are Persian digits in local time, sorted by the true instant. Lists
longer than ~3500 characters split **on event boundaries**, never mid-event,
and every part carries the disclaimer because each part is independently
forwardable.

**Decision you may want to change:** event titles stay in their original
English (`Employment Change`, `FOMC Meeting Minutes`). Economic-calendar names
are effectively jargon that traders recognise, and translating them risks
mangling the identity of the release. Say the word and I'll run them through
the translator.

---

# Task 4 — Market-impact analysis (`src/analysis/marketImpact.ts`)

Shared by Task 2 and Task 3. One batched LLM call per run, zod-validated:

```ts
{ i, event, if_higher_than_forecast, if_lower_than_forecast,
  affected_assets: string[], volatility: 'low'|'medium'|'high', note }
```

Schema validation is necessary but **not sufficient** — a perfectly-shaped
reply can still say "gold will definitely rise". So every produced string is
then scanned by `assertScenarioLanguage()`, which rejects:

| Category | Examples caught |
|---|---|
| Certainty | `قطعاً`، `حتماً`، `بدون شک` |
| Advice | `بخرید`، `بفروشید`، `سیگنال`، `buy now` |
| Trade levels | `حد ضرر`، `حد سود`، `price target` |
| Directional claims | `will rise`, `guaranteed to fall` |
| Invented numbers | `طلا تا ۲۴۵۰ دلار` |

A rejected analysis is **dropped**, not repaired — that event prints its plain
line instead. Invented numbers are allowed only in breaking-news summaries,
which legitimately restate figures from the source headline.

Messages carrying analysis always end with, exactly:

> ⚠️ تحلیل صرفاً آموزشی و سناریومحور است و توصیه مالی نیست.

`withDisclaimer()` is idempotent, so it cannot be doubled.

**If the LLM fails for any reason, the plain list still ships.**
`analyzeCalendarEvents` returns an empty map rather than throwing — there's a
test that runs the whole job with zero provider keys.

---

## Testing

### 1. See the real message, right now (needs network, no account, no token)

```bash
npm run preview:calendar                     # today, Asia/Tehran
node scripts/preview-calendar.mjs 2026-10-09 # a specific local day
node scripts/preview-calendar.mjs 2026-10-09 Europe/London
node scripts/preview-calendar.mjs --file saved-feed.json 2026-10-09
```

It fetches the live feed and prints exactly what the bot would send. On a day
with no red events it tells you so and lists which days this week *do* have
them, with a ready-to-paste retry command.

> Heads up: **today (2026-10-05) has no high-impact events** in the live feed —
> the first are `BOJ Gov Ueda Speaks` on the 6th and `FOMC Meeting Minutes` on
> the 7th (21:30 Tehran). So a run today correctly sends nothing. Use
> `node scripts/preview-calendar.mjs 2026-10-07` to see a populated message.

If the source is ever blocked, the script prints the same refusal the job
would and exits non-zero.

### 2. Unit tests

```bash
npx vitest run test/calendar.test.ts     # 34 tests
npm test                                 # 661 total, all green
```

Covering, among others:

* the real payload shape, including `"All"` and `Holiday` rows;
* `-04:00` → Tehran conversion, including an evening NY event that rolls onto
  the **next** Tehran day;
* only `High` survives the filter;
* **four overlapping runs produce exactly one message**;
* a 403 releases the claim and a retry then succeeds;
* a Telegram failure does **not** release the claim;
* a day with no red events sends nothing and marks `skipped`;
* zero LLM keys still ships the plain list, without a disclaimer;
* every guardrail phrase above.

### 3. Against real Cloudflare

```bash
npm run db:migrate:remote      # adds job_claims / job_runs / llm_usage
npx wrangler tail
```

After Task 5 wires the cron:

```bash
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=30+4+*+*+*"
curl "http://localhost:8787/__scheduled?cron=30+4+*+*+*"   # second call must no-op
```

Inspect the claim:

```bash
npx wrangler d1 execute news-bot --remote \
  --command "SELECT job, claim_date, status, detail FROM job_claims ORDER BY claim_date DESC LIMIT 5"
```

To force a re-send while testing (the only safe way to do it):

```bash
npx wrangler d1 execute news-bot --remote \
  --command "DELETE FROM job_claims WHERE job='calendar' AND claim_date='2026-10-09'"
```

# Task 6 — security / bug-bounty writeup digest

A **second, separate** Telegram channel, in **English**, posting **once a day**:
bug-bounty writeups, new public exploits and technique-reference updates.

It shares nothing with the finance channel but the plumbing. No Persian, no
translation, no market analysis, no disclaimer — the bot only **selects,
dedupes and formats** text that already exists at the source.

The live source survey that produced this feed list is in
[`TASK6-SECURITY-FEEDS.md`](./TASK6-SECURITY-FEEDS.md). Read that first if you
want to know *why* HackerOne, Bugcrowd and YesWeHack are absent.

---

## 1. At a glance

| | |
| --- | --- |
| Cron | `30 16 * * *` UTC = **20:00 Asia/Tehran**, daily |
| Destination | `TELEGRAM_SECURITY_CHANNEL` secret — **unset ⇒ job publishes nothing** |
| Language | English only, verbatim from the source |
| LLM calls | **1 per day**, and the digest still publishes without it |
| Feeds | 6 |
| New table | `security_seen` (migration `0013`) |
| New files | `src/security/{sources,filter,select,job}.ts` |

---

## 2. Sources

Six feeds, all verified live on 2026-10-05. `kind` drives how each is treated:

| id | Source | kind | Cadence | Why |
| --- | --- | --- | --- | --- |
| `infosec-writeups` | InfoSec Write-ups | `writeup` | several/day | The reference source for this genre |
| `intigriti-blog` | Intigriti | `writeup` | ~weekly | Technical half only, corporate half excluded by URL path |
| `portswigger-research` | PortSwigger Research | `writeup` | 1–2/month | **Not on your original list.** Best-in-class research; delete the entry if unwanted |
| `exploit-db` | Exploit-DB | `exploit` | most days | PoC artifacts, titles only |
| `hacktricks` | HackTricks | `repo` | several/day | Commit log of the cheat-sheet wiki |
| `payloadsallthethings` | PayloadsAllTheThings | `repo` | ~monthly | Commit log |

The three genres are genuinely different and are rendered in **separate
sections**, because a 40-item list of `Merge pull request #861` would bury the
one writeup that the channel exists for.

Three platforms you asked for have **no usable feed** and were dropped on your
instruction — they are recorded in `REJECTED_SOURCES` with every URL that was
tried, so nobody re-adds them:

* **HackerOne** — `hacktivity.rss` redirects to a React SPA that renders only
  "Log in". Data exists solely behind an undocumented `POST /graphql`.
* **Bugcrowd** — `/blog/feed/` serves the marketing homepage; `/feed/` serves an
  Okta login.
* **YesWeHack** — `blog.yeswehack.com/feed/` redirects to HTML; `/blog/feed` 404s.

No HTML scraping was used anywhere, per your standing rule.

### Checking the feeds

```bash
npm run check:feeds
```

Now covers **both** groups (finance + security) and reports, per feed: HTTP
status, redirects, items parsed, age of the newest item, and how many items the
relevance filter would keep.

The dangerous failure is a feed that answers `200` while being dead, so the
check flags two cases loudly:

* `❌ EMPTY … the body is HTML, not a feed` — what Bugcrowd does.
* `⚠️ STALE` — newest item older than that source's own `staleHours`.

`staleHours` is **per source** (48h for InfoSec Write-ups, 1440h for
PortSwigger) because these cadences differ by two orders of magnitude; one
global threshold would either cry wolf or never fire. The field doubles as the
documented expected cadence.

---

## 3. Pipeline

```
6 feeds ──fetch (3 at a time, 10s timeout, 2 MB cap)
   │
   ├─ parse (RSS + Atom; Atom <content> is read because GitHub commit
   │         feeds have no <description>)
   │
   ├─ evaluate()        deterministic, free, no LLM
   │     1. title ≥ 8 chars
   │     2. link must not contain an excluded path fragment
   │     3. must not match a NOISE pattern
   │     4. must hit a SIGNAL term  ← writeup sources SKIP this
   │
   ├─ lookback 48h, per-source cap, global cap 24
   │
   ├─ security_seen  → drop anything already delivered
   │
   ├─ ONE LLM call: rank the writeups only, 1–6 of them, one sentence each
   │     └─ ungrounded output is discarded, never "fixed"
   │
   ├─ render → split at 3900 chars
   │
   └─ send → mark seen + mark claim sent + prune rows older than 45 days
```

### Why writeups skip the signal gate

A keyword gate on writeups is actively harmful: the best posts are titled *"The
moment it clicked"* or *"How I made $20,000 in one afternoon"*. Those are
exactly what the channel is for. The gate stays on for `exploit` and `repo`
sources, where titles are mechanical and a keyword is always present when the
item matters.

### The noise filter

`repo` feeds are roughly half housekeeping. `NOISE_PATTERNS` rejects merge
commits, `Run auto-merge schedule at minute 17`, `chore:`/`bump`/dependabot,
typo and grammar fixes, `Fix broken links`, sponsor/logo/badge edits, README and
CHANGELOG updates, and bare version tags.

Each pattern is anchored so it cannot eat real content. These are all **kept**,
and there are tests pinning every one of them:

* `Fixing broken access control in a GraphQL gateway` (contains "fix", "broken")
* `Add four-dot traversal bypass payloads for IIS` (contains "add")
* `RegEx BackTrack Limit + PostgreSQL Dollar Quoting`

For a kept `repo` commit, `extractReferencePath()` pulls the page that actually
changed, so the digest can say

> HackTricks: **pentesting-web/xs-search/performance-timing**

instead of the useless raw subject. GitHub truncates long commit subjects with
an ellipsis, so the extractor takes the **longest** path match across title and
body, not the first.

---

## 4. The one LLM call, and what stops it inventing things

The model is given a numbered list of candidate writeups (title + 320 chars of
context) and must return `{ items: [{ i, why, tags }] }`. It **ranks and
summarizes only**; it never writes a headline and never produces a link.

Four guards, all tested:

1. **zod** validates the shape. Anything else ⇒ the whole response is dropped.
2. **Out-of-range and duplicate `i`** are discarded — the model cannot
   hallucinate a seventh item into a list of six.
3. **`assertGrounded()`** — if the model's sentence cites a `CVE-YYYY-NNNNN`
   that does not appear in the source text, that entry is dropped. This is the
   single most common fabrication in security summaries.
4. **Tags** are lowercased and stripped to `[a-z0-9+#.-]`, max 3.

If the provider is down, out of budget, or returns garbage, `selectWriteups()`
returns `[]` and the job still publishes — a plain unframed list of titles and
links. **The digest never depends on the LLM.** Degrading to "titles only" is
strictly better than skipping a day.

Cost: one call per day, against the shared `LLM_DAILY_BUDGET` (default 60).

---

## 5. What a post looks like

```
🛡 Security Writeups — 5 Oct 2026

📝 WRITEUPS & RESEARCH

1. NAT64 SSRF Bypass in a Cloud Metadata Proxy
    The allowlist resolved the hostname once and trusted it; a NAT64
    address mapped back to 169.254.169.254.
    InfoSec Write-ups · #ssrf · #cloud

2. Exploiting insecure cookie policies for account takeover
    Chained a subdomain takeover with a loose cookie Domain attribute.
    Intigriti · #cookies

💥 NEW PUBLIC EXPLOITS

• [webapps] Krayin CRM 2.2.4 - IDOR

🔧 TECHNIQUE REFERENCE UPDATED

• HackTricks: pentesting-web/xs-search/performance-timing
```

Titles are hyperlinks (HTML parse mode, link preview disabled). Everything is
HTML-escaped, so a title containing `<script>` or `&` cannot break the message —
there is a test that feeds it a hostile title. A test also asserts the output
contains **no Persian characters at all**.

Over 3900 characters the digest splits at an **entry boundary** and repeats the
header with `(cont.)`.

---

## 6. Guarantees

### Exactly once a day

Same mechanism as the Forex Factory list: an atomic `INSERT OR IGNORE` claim on
`job_claims(job='security', claim_date=<local date>)` **before** any work. Three
concurrent invocations and a retry an hour later produce exactly one post.

### Never the same item twice

`security_seen(item_key)` where `item_key = fnv1a(canonicalUrl(link) + title)`.
Rows are written **only after Telegram confirms**, and pruned after 45 days.

`canonicalUrl` now also strips Medium's `?source=rss----…` and `?sk=` friend
link parameters, which previously made the same article look new on every fetch.
That fix benefits the breaking-news dedupe too.

An item that was fetched but **not selected** stays eligible — it can appear in
a later digest if nothing better turns up. Only *delivered* items are burned.

### Failure semantics

| Situation | Status | Effect |
| --- | --- | --- |
| `TELEGRAM_SECURITY_CHANNEL` unset | `skipped` `destination_or_token_missing` | nothing sent, claim released |
| All 6 feeds down | `failed` `all_feeds_failed` | claim **released** so a retry can run |
| 1 feed down | `partial` | still publishes from the other 5 |
| No candidates / all already posted | `skipped` | claim marked, no empty post |
| LLM fails | `success`, `selected=0` | plain list published |
| Telegram rejects | `failed` | claim marked **sent** (fail closed), and **zero** `security_seen` rows are written |

That last row is the deliberate trade: on a Telegram error the bot would rather
lose one day's digest than risk double-posting it.

### Destination is never guessed

`resolveSecurityDestination()` returns `null` when the secret is unset — it
**never falls back to the finance channel**. Accepted values:

* `@channel_username` matching `/^@[A-Za-z][A-Za-z0-9_]{4,31}$/`
* a numeric id, `-1001234567890`
* the literal `MAIN`, to deliberately reuse `TELEGRAM_DESTINATION_CHANNEL`

Anything else is rejected and the job skips.

---

## 7. Setup

```bash
# 1. The new table
npx wrangler d1 migrations apply news-bot --remote

# 2. Create the channel, add the bot as an administrator with "Post messages"

# 3. Point the bot at it
npx wrangler secret put TELEGRAM_SECURITY_CHANNEL     # e.g. @my_sec_digest

# 4. Ship the code and the 5th cron trigger
npx wrangler deploy
```

> ⚠️ **This is the 5th of 5 free-plan Cron Triggers.** The account allowance is
> now fully used. A sixth scheduled job needs either the $5/month Workers Paid
> plan or a shared trigger. `test/time.test.ts` fails if a 6th is added.

---

## 8. How to test it

**Unit tests** — 47 of them, no network:

```bash
npx vitest run test/security.test.ts
```

They cover the source list, every noise pattern, the signal gate, reference-path
extraction, Atom `<content>` parsing, the grounding guard, HTML escaping,
message splitting, destination parsing, and 14 end-to-end `runSecurityJob`
scenarios including every row of the failure table above.

**Are the feeds alive today?**

```bash
npm run check:feeds
```

**Fire the real job locally** (uses the real feeds, your real channel):

```bash
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=30+16+*+*+*"
```

**In production** — check it ran:

```bash
npx wrangler tail --format pretty
```

and send `/status` to the bot as the admin; the digest appears as
`دایجست امنیتی` with its last run time and outcome.

**Force a re-send** (the claim blocks a second run on the same local day):

```bash
npx wrangler d1 execute news-bot --remote \
  --command "DELETE FROM job_claims WHERE job='security' AND claim_date='2026-10-05'"
```

**Start over completely** (re-allow every item):

```bash
npx wrangler d1 execute news-bot --remote --command "DELETE FROM security_seen"
```

---

## 9. Tuning

All constants are at the top of `src/security/job.ts`:

| Constant | Default | Meaning |
| --- | --- | --- |
| `LOOKBACK_HOURS` | 48 | Older items are ignored. 48 ≫ 24 on purpose: it covers one missed run without losing a day of content |
| `MAX_CANDIDATES` | 24 | Cap before the LLM call |
| `MAX_WRITEUPS` | 6 | Entries in the writeup section |
| `MAX_EXPLOITS` | 6 | Entries in the exploit section |
| `MAX_REPO_UPDATES` | 5 | Entries in the reference section |
| `FEED_TIMEOUT_MS` | 10 000 | Per feed |
| `FEED_MAX_BYTES` | 2 000 000 | InfoSec Write-ups ships whole articles in `content:encoded` |
| `CONTEXT_CHARS` | 320 | Context per item given to the model |
| `SEEN_RETENTION_DAYS` | 45 | `security_seen` pruning |

To drop a source, set `enabled: false` in `src/security/sources.ts` — do not
delete the entry, the `id` is a foreign key into `security_seen`.

To move the post time, change `SECURITY_CRON` in `src/scheduler.ts` **and**
`triggers.crons` in `wrangler.json`; `test/config.test.ts` and
`test/time.test.ts` fail if the two ever disagree.

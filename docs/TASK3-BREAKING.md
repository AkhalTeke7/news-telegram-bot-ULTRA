# Task 3 — Breaking big-market news alerts

Status: **implemented and unit-tested.** Not yet called by `scheduled()` —
that is Task 5.

---

## Feed list — tested, with the broken ones dropped

Every URL below was fetched and inspected. ✅ feeds were re-verified live on
**2026-10-05 08:37 UTC** (BBC's newest item was 6 minutes old at the time).

| Source | URL | Verdict |
|---|---|---|
| BBC Business | `feeds.bbci.co.uk/news/business/rss.xml` | ✅ fresh |
| CNBC Top News | `cnbc.com/id/100003114/device/rss/rss.html` | ✅ fresh |
| WSJ Markets | `feeds.content.dowjones.io/public/rss/RSSMarketsMain` | ✅ fresh |
| Al Jazeera | `aljazeera.com/xml/rss/all.xml` | ✅ fresh |
| OilPrice.com | `oilprice.com/rss/main` | ✅ fresh — serves mojibake (`â€”`), repaired in the parser |
| Guardian Business | `theguardian.com/business/rss` | ✅ fresh — **301** to `/us/business/rss`, redirects followed |
| Federal Reserve | `federalreserve.gov/feeds/press_all.xml` | ✅ works — primary source, `weight: 2` |

**Dropped, and recorded in `REJECTED_SOURCES` so nobody re-adds them:**

| Source | Why |
|---|---|
| `feeds.reuters.com/reuters/businessNews` | Discontinued — Reuters retired its public RSS. |
| `investing.com/rss/news_285.rss` | **Returns HTTP 200 with a well-formed feed frozen at 2024-11-26.** The dangerous kind of broken: it looks healthy while silently never producing news. |

A test asserts those two URLs are absent from the live list.

## Pipeline

Ordered by cost. Stages 1–5 are free; only survivors reach the model.

```
1. fetch 7 feeds        bounded concurrency 3, 8s timeout each, failures isolated
2. freshness window     published < 45 min ago (undated items kept)
3. keyword pre-filter   pure string work, no LLM, no DB
4. cross-source         record sighting, count INDEPENDENT newsrooms (30 min)
5. dedupe + daily cap   already-alerted? cap reached?  → stop early
6. LLM scoring          ONE batched call, ≤6 stories
7. send                 score + confirmation bonus ≥ 8
8. record               only AFTER Telegram confirms
```

**Why the order matters:** at a 5-minute cadence a naive design makes 288 LLM
calls/day. Here the daily cap is checked *before any feed is even fetched*
(there's a test asserting `feedsOk === 0` in that case), and a run with no
keyword hits never touches the model at all.

### Stage 3 — keyword pre-filter

Weighted vocabulary, recall over precision: weight 3 for terms that alone
signal a market event (`fomc`, `rate cut`, `opec`, `sanctions`, `default`,
`cpi`, `nonfarm payrolls`, `declares war`…), 2 for asset and trade terms, 1
for verbs of violent change (`plunge`, `halts trading`) and urgency markers.
Headline matches count full, body matches half. A veto list kills sport,
celebrity and lifestyle outright.

### Stage 4 — cross-source confirmation

Stories are keyed by `storyFingerprint()` — significant words, lightly
stemmed, sorted — so word order and plural/tense differences don't split one
story in two. A real pair from 2026-10-05 that collapses to one key:

> BBC: *"G7 to release millions of barrels of oil after OPEC output cut"*
> CNBC: *"OPEC output cut prompts G7 oil release of millions of barrels"*

`UNIQUE (story_key, source_id)` stops a feed confirming itself by
republishing, and each source carries a `group` (newsroom owner) so two feeds
from the same publisher count once. Bonus: **+1** for 2 independent groups,
**+2** for 3+. Deliberately modest — confirmation *raises* confidence, it
doesn't manufacture it; a trivial story carried by five outlets still has to
clear the threshold on the model's own score.

### Stage 6 — LLM scoring

One batched call returning, per story, exactly the contract Task 3 specifies:

```json
{ "score": 0-10, "category": "...", "summary_fa": "...",
  "market_impact_fa": "...", "affected_assets": ["..."] }
```

zod-validated, then run through the same Task 4 guardrails (no certainty, no
advice, no trade levels, no invented numbers). The prompt states that only the
supplied feed text may be used and that anything unsupported must score low.

**There is no "send it unscored" fallback.** If every provider is down the run
sends nothing — an unvetted headline is precisely what the threshold exists to
stop. (This is the one place where the Task 4 "degrade to plain output" rule
deliberately does *not* apply, because here the LLM *is* the filter.)

## Limits

| Knob | Default | Env |
|---|---|---|
| Score threshold | 8 | `BREAKING_MIN_SCORE` |
| Alerts per day | 8 | `BREAKING_DAILY_CAP` |
| Alerts per run | 2 | constant — one noisy minute can't flood the channel |
| Stories per LLM call | 6 | constant |
| Freshness window | 45 min | constant |
| Confirmation window | 30 min | constant |
| Sighting retention | 6 h, pruned each run | constant |

## Alert format

```
🚨 🛢️ انرژی | ۱۲:۰۰

گروه هفت آزادسازی ذخایر نفتی را پس از کاهش تولید اوپک اعلام کرد.

📰 تیتر اصلی: G7 to release millions of barrels of oil after OPEC output cut

📉 اثر احتمالی بر بازار: در صورت تأیید، معمولاً فشار فروش روی نفت بیشتر می‌شود.
🎯 دارایی‌های متأثر: نفت، دلار کانادا

🔗 https://www.bbc.co.uk/news/articles/ck87zg8jnwngo
📡 منبع: BBC Business (+1 منبع مستقل دیگر)
⚖️ امتیاز اهمیت: 10/10

⚠️ تحلیل صرفاً آموزشی و سناریومحور است و توصیه مالی نیست.
```

---

## ⚠️ One decision I need from you

The spec says *"if unconfirmed, do not send."* I read that as **"work only
from real feed text, never from recalled or invented facts"** — which is
enforced in the prompt and the guardrails — rather than **"require 2+ sources
before any alert."**

So today a single reputable source (BBC, WSJ, or the Fed publishing itself)
scoring ≥8 **will** alert; a second source only adds a bonus.

The alternative is a hard rule: never alert on one source. That eliminates a
whole class of false positives, but it also means you're structurally last to
report any genuine scoop, and the Fed's own press release would be held back
waiting for a wire to copy it. **Tell me which you want** — it's a one-line
change plus a config flag.

---

## Testing

### 1. Check every feed is alive (needs network)

```bash
npm run check:feeds
```

Reports per feed: HTTP status, redirects, items parsed, age of the newest
item, and how many would pass the pre-filter right now. **Flags a feed that
returns 200 but is frozen** — that's how `investing.com` was caught. Exits
non-zero if anything is broken, so it works in CI.

### 2. Unit tests

```bash
npx vitest run test/breaking.test.ts   # 42 tests
npm test                               # 703 total, all green
```

Covering: RSS + Atom parsing, CDATA, numeric/hex entities, OilPrice mojibake,
missing dates (→ `null`, never "now"), freshness window, keyword hits and
vetoes, fingerprint matching on the real BBC/CNBC pair, self-confirmation
refusal, the 30-minute window, pruning, and the full job —

* alerts once on a confirmed high-scoring story, with score 9 + 1 bonus = 10;
* **never alerts twice** for the same story;
* silent below threshold; honours a configured threshold;
* daily cap checked **before** fetching anything;
* LLM down ⇒ nothing sent;
* an analysis saying *"buy oil now, it will definitely rise"* ⇒ dropped;
* one feed down ⇒ `partial`, still alerts;
* all feeds down ⇒ `failed`, nothing invented;
* Telegram rejects ⇒ **nothing recorded**, story stays eligible.

### 3. Live, after Task 5 wires the cron

```bash
npx wrangler tail
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"
```

```bash
# what the scan has been seeing
npx wrangler d1 execute news-bot --remote --command \
  "SELECT story_key, source_id, title, seen_at FROM breaking_seen ORDER BY seen_at DESC LIMIT 20"

# what actually went out
npx wrangler d1 execute news-bot --remote --command \
  "SELECT local_date, score, category, title FROM breaking_alerts ORDER BY sent_at DESC LIMIT 10"

# today's LLM spend
npx wrangler d1 execute news-bot --remote --command \
  "SELECT * FROM llm_usage ORDER BY local_date DESC LIMIT 10"
```

To rehearse without waiting for real news, temporarily set
`BREAKING_MIN_SCORE="4"` and watch what arrives — then put it back to 8.

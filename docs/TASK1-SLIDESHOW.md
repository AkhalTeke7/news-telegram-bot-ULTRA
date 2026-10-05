# Task 1 — News slideshow (white glass)

Status: **implemented and unit-tested.** Not yet called by `scheduled()` — that
is Task 5. Until then it runs on demand (see "Testing" below).

---

## What it does

Once per run (cron `0 */3 * * *` UTC, i.e. 03:30 / 06:30 / 09:30 … Tehran):

1. Picks **at most 10** summarized, non-advertising items that have never been
   sent as a slide (`messages` ⟕ `slideshow_sent`), most important first.
2. Translates the non-Persian ones to Persian — **one batched LLM call**.
3. Extracts **2–4 keywords per item** — **one batched LLM call**. A keyword is
   kept only if it occurs *verbatim* in that item's own text.
4. Resolves each article's `og:image` (one bounded fetch per item).
5. Renders one **1080×1350 PNG** per item through Browser Run.
6. Sends **one Telegram album** (`sendMediaGroup`, 2–10 photos, a **single**
   caption on the first photo; `sendPhoto` when only one slide survived).
7. **Only after Telegram confirms**, writes the items to `slideshow_sent` —
   together with each slide's `file_id`.
8. Optionally archives the PNGs to R2 (`MEDIA`), best effort.

Nothing in that list is allowed to take the run down:

| Failure | Behaviour |
| --- | --- |
| No LLM key / LLM error | No highlighting, no translation. Slides still ship. |
| No `og:image` | Gradient placeholder + big category emoji. |
| Browser Run 429 | Stops rendering, sends the slides already produced (`partial`). |
| A single screenshot throws | That slide is skipped, the rest ship. |
| Telegram rejects the album | **Nothing** is marked sent; the next run retries the same items. |
| R2 archive fails | Logged, ignored. |

## Files

| Path | Role |
| --- | --- |
| `src/slideshow/slideTemplate.ts` | The 1080×1350 HTML: gradient, glass card, `<mark>` highlighting, 4-line clamp, escaping. |
| `src/slideshow/fontAssets.ts` | Generated. Vazirmatn 400 + 700 as base64. Rebuild: `npm run build:fonts`. |
| `src/slideshow/ogImage.ts` | `og:image` / `twitter:image` extraction, head-only, 256 KB cap. |
| `src/slideshow/enrich.ts` | The two batched LLM calls + verbatim/Persian verification. |
| `src/slideshow/render.ts` | Browser Run screenshots, paced and rate-limit aware. |
| `src/slideshow/job.ts` | Orchestration, dedupe, send, mark-sent. |
| `src/slideshow/browse.ts` | Private-chat `/slideshow` browser. |
| `src/lib/hash.ts` | Dedupe keys (canonical URL, story fingerprint). |
| `src/lib/kv.ts` | Optional KV cache / session storage. |
| `scripts/preview-slide.mjs` | Local design preview — no Cloudflare account needed. |

## Design details worth knowing

**Fonts are embedded, never fetched.** `src/newsImage.ts` (the existing 4-up
album) loads Vazirmatn from Google/jsDelivr at render time. The slide template
does not: both weights are inlined as base64 data URLs, so a CDN outage or a
blocked egress cannot produce a slide in Times New Roman. Cost: ~132 KB of
base64 per slide HTML. Worker bundle is 480 KiB total (105 KiB gzipped).

**Highlighting is escape-then-match.** `highlight()` HTML-escapes the text
*first*, then finds the (escaped) keyword with `indexOf` and wraps it. Keywords
are applied longest-first and already-marked spans are never re-entered, so no
nesting and no injection. A keyword the model invented simply never matches.

**The 4-line summary is a hard guarantee**, not a hope: `-webkit-line-clamp: 4`
plus `overflow: hidden` on a fixed-height flex child. The headline clamps to 3.
Text is also character-clamped before it reaches the template.

**One caption per album — never one per photo.** Telegram renders a media
group as a single swipeable slideshow (arrows on desktop/web, swiping on
mobile) only while exactly one item carries a caption. The moment a second
photo has one, every client falls back to showing the photos as separate
captioned messages. So `buildSlideshowAlbumCaption()` merges the run into one
plain-text index (`📰 brand — date`, then `۱) {emoji} headline — 📡 source`
per slide) and `sendMediaGroup()` attaches it to `media[0]` only; the other
items are sent caption-free by construction. Headlines that would push the
caption past the 1024-character limit are folded into a trailing
«و n خبر دیگر». The per-slide counter still lives *on* the rendered slide
(`۳/۱۰`), and `buildSlideCaption()` is used for the lone-photo fallback.

**`/slideshow` costs no renders.** It pages through the *last album already
posted* using the Telegram `file_id` recorded at send time, via
`editMessageMedia`. One API call per button press, no Browser Run minutes, no
R2 reads. Session (message id + ordered file_ids + cursor) lives in KV with a
**30 minute TTL**. Private chats only — the channel never gets buttons.

## Budgets

Per 10-slide run, against the **Workers Free** caps:

| Resource | Used | Free limit |
| --- | --- | --- |
| Subrequests | ≈ 23 (10 article fetches + 10 screenshots + 2 LLM + 1 send) | 50 per invocation |
| Browser Run | 10 Quick Actions, paced ≥ 10 s apart ⇒ ~100 s wall clock | 1 req / 10 s, 10 min/day |
| LLM calls | 2 | `LLM_DAILY_BUDGET`, default 60/day |

⚠️ **Browser Run free tier is the real constraint.** 8 runs/day × 10 slides is
~80 screenshots ≈ 6–7 minutes of the 10 min/day free allowance, and that
allowance is shared with the existing `/testimage` album. If you stay on Free,
consider `SLIDESHOW_MAX_ITEMS="5"`.

⚠️ **Free plan CPU is 10 ms per request**; a paced 10-slide run is ~100 s of
*wall* time (mostly waiting, which does not count as CPU), but Browser Run
minutes and the 30 s/15 min cron CPU ceiling on Paid are the numbers to watch.

---

## Testing

### 1. Look at the design (no Cloudflare account, no network)

```bash
npm run preview:slide      # then open http://localhost:8080
```

Three deliberately awkward samples render in your own browser: a very long
headline, a summary well past the 4-line budget, a missing image, an English
source name, and overlapping keywords. `/slide/0` shows one slide at exactly
1080×1350 — the same HTML string Browser Run receives. `/raw/0` dumps the HTML.

Check: Persian letters are *joined* and read right-to-left, the yellow `<mark>`
highlights sit on real words, the summary never spills out of the card, the
footer shows `منبع: …`, the brand, and `۳/۱۰`.

### 2. Unit tests

```bash
npm test                      # 627 tests, all green
npx vitest run test/slideTemplate.test.ts test/slideshow.test.ts
```

Those two files cover: escaping/injection, keyword marking (longest-first, no
nesting, repeated occurrences), the clamp CSS, placeholder fallback, unsafe
image URLs, `og:image` extraction and resolution, PNG validation, 429 handling,
render pacing, dedupe keys, item selection, captions, the keyboard layout, and
the full job — including the two cases that matter most:

* Telegram rejects the album ⇒ **`slideshow_sent` stays empty**.
* A second run finds **nothing new** to send.

### 3. Dry run the bundle

```bash
npm run typecheck
npm run build                 # wrangler deploy --dry-run
```

### 4. End-to-end against real Cloudflare (optional, costs Browser Run minutes)

Prerequisites: `wrangler kv namespace create KV` and
`wrangler r2 bucket create news-bot-media`, put the returned KV id into
`wrangler.json`, then `npm run db:migrate:remote`.

The job is wired to a cron in Task 5. To fire it by hand before that, add a
temporary admin-only route or call `runSlideshowJob(env)` from
`src/index.ts`'s `scheduled()`. After Task 5 lands:

```bash
npx wrangler tail             # watch the run
# wait for the next 0 */3 * * * firing, or:
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=0+*/3+*+*+*"
```

Then in a **private chat** with the bot: `/slideshow` → `◀ قبلی | ۳/۱۰ | بعدی ▶`.

### 5. Verify the dedupe table

```bash
npx wrangler d1 execute news-bot --remote \
  --command "SELECT item_key, title, file_id, sent_at FROM slideshow_sent ORDER BY sent_at DESC LIMIT 10"
```

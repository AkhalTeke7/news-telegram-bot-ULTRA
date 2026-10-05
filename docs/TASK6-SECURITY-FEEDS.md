# Task 6 — security / bug-bounty writeup channel: source survey

**Status: survey complete and implemented.** This file is the *evidence* — what
was fetched, what it returned, and why each source was kept or dropped. The
implementation and how to test it live in
[`TASK6-SECURITY-DIGEST.md`](./TASK6-SECURITY-DIGEST.md).

Every URL below was fetched live on **2026-10-05**. Same rule as task 3: a source
that has no machine-readable feed does not get HTML-scraped, it gets reported.

---

## 1. What you asked for

> "how a bug was discovered and the actual exploit — the hunter's initial hunch,
> their testing process, and the exploitation method"

That is a **long-form narrative writeup**. It is worth being precise about this,
because only a minority of the nine sources you listed actually publish that
genre. The rest publish one of two different things:

* **Exploit artifacts** — a PoC file, no narrative (Exploit-DB).
* **Reference-material changes** — "this cheat-sheet page was edited"
  (PayloadsAllTheThings, HackTricks).

Both are useful; neither is a writeup. Mixing all three into one channel would
bury the writeups.

---

## 2. Survey results

| # | Source | Feed tried | Verdict |
|---|---|---|---|
| 1 | **HackerOne Hacktivity** | `hackerone.com/hacktivity.rss` | ❌ **No feed.** Silently redirects to `/hacktivity/overview`, a React SPA that renders nothing without JS and prompts for login. |
| 2 | **Bugcrowd Blog** | `www.bugcrowd.com/blog/feed/` | ❌ **No feed.** Redirects to the marketing homepage. |
| 2b | Bugcrowd (retry) | `www.bugcrowd.com/feed/` | ❌ Redirects to an **Okta OAuth login** (`login.hackers.bugcrowd.com`). |
| 3 | **Intigriti Blog** | `www.intigriti.com/blog/feed` | ✅ **Works.** Valid RSS, fresh (2026-09-29). |
| 4 | **YesWeHack Blog** | `blog.yeswehack.com/feed/` | ❌ Redirects to `www.yeswehack.com/blog` — a Next.js HTML page, not a feed. |
| 4b | YesWeHack (retry) | `www.yeswehack.com/blog/feed` | ❌ **404.** |
| 5 | **Medium – InfoSec Write-ups** | `infosecwriteups.com/feed` | ✅✅ **Works, and it is exactly the genre you described.** |
| 6 | **Exploit-DB** | `www.exploit-db.com/rss.xml` | ✅ Works, fresh (2026-10-01) — but see the caveat below. |
| 7 | **PayloadsAllTheThings** | `github.com/swisskyrepo/PayloadsAllTheThings/commits/master.atom` | ⚠️ Works, but it is a **commit log**. |
| 8 | **GitHub** | — | ❓ **Too vague to act on.** See §4. |
| 9 | **HackTricks** | `github.com/HackTricks-wiki/hacktricks/commits/master.atom` | ⚠️ Works, very active, but also a **commit log**, mostly bot-generated. |
| + | *(bonus)* **PortSwigger Research** | `portswigger.net/research/rss` | ✅ Works. Elite quality, low volume. Not on your list; strongly suggested. |

**Three of your nine have no usable feed at all** (HackerOne, Bugcrowd,
YesWeHack). That is the headline finding.

### 2.1 The one that is a perfect match

`https://infosecwriteups.com/feed` — the Medium "InfoSec Write-ups"
publication. Top item at time of checking:

> **"How I Tricked OpenClaw Into Attacking Its Own Network: A NAT64 SSRF Bypass"**
> … sections literally titled *"The moment it clicked"*, *"The guard's fatal
> shortcut"*, *"Building the lying address"*, with the vulnerable `case
> "rfc6052":` snippet and the crafted IPv6 literal.

Hunch → testing → exploitation, exactly as you described.

**Important technical consequence:** this feed embeds the **entire article body**
in `content:encoded`. The single item above was ~9 pages of text. A 10-item feed
pull is therefore megabytes, not kilobytes. That has real implications for the
Worker's 128 MB isolate, the free tier's 10 ms CPU, and LLM token cost — the
job will need to truncate hard before any analysis. Doable, but it is a
different cost profile from the finance feeds, which are title-plus-blurb.

### 2.2 The ones that work but are a different genre

* **Exploit-DB** — entries are one-line titles plus a link to a raw PoC:
  `[webapps] Krayin CRM 2.2.4 - IDOR`, `[remote] Teltonika_RutOS … command
  injection`. No narrative, no discovery story. Good for a "new public exploits"
  ticker; useless for "how they found it".
* **PayloadsAllTheThings** — the Atom feed is literally git commits. Recent
  entries: `Fix broken links`, `Update sponsors logo`, `Add Talordata sponsor`,
  `Merge pull request #861`. Perhaps one in five is substantive
  (`Add four-dot traversal bypass payloads to deep_traversal.txt`). Low volume —
  last commit 2026-08-27, roughly monthly.
* **HackTricks** — same shape, far busier (several commits/day). Substantive
  entries name the technique page, e.g. `Research Update Enhanced
  src/pentesting-web/client-side-template-injection-csti`. But every change
  produces both a bot commit and a merge commit, so roughly half of all items
  are duplicates of each other, plus noise like `Run auto-merge schedule at
  minute 17` and `Fix typo: DNS rebidding → DNS rebinding`.
* **Intigriti** — genuinely mixed. The feed interleaves corporate posts
  (`10 years of Intigriti`, `Intigriti named new provider for Adobe's Bug Bounty
  Program`) with real technical content (`Exploiting insecure cookie policies`,
  `Hacking AI customer service agents`, `Web fuzzing for hackers`). Helpfully,
  the URL path discriminates: `/researchers/blog/hacking-tools/` is the
  technical subset, `/blog/business-insights/` and `/blog/news/` are not. A
  path-based pre-filter would work well here and costs no LLM calls.

---

## 3. On the three with no feed

Per your standing instruction — never scrape HTML, stop and report instead — I
did not attempt to parse any of these pages.

* **HackerOne Hacktivity.** The web app is powered by an undocumented GraphQL
  endpoint (`POST hackerone.com/graphql`). It is not a published API, it is not
  covered by their API docs, it can change without notice, and automated
  querying is at best ToS-grey. I am not going to build on it without you
  explicitly asking.
* **Bugcrowd.** The blog is WordPress (`/wp-content/` paths are visible), so a
  feed almost certainly exists behind some path, but neither of the two
  conventional ones resolves — one redirects to marketing, one to an OAuth
  login. I can keep probing if you want.
* **YesWeHack.** Sanity CMS behind Next.js. No feed at the two conventional
  paths. They do publish genuinely good technical content (their Dojo challenge
  solutions are exactly your genre), so it is worth a second look if you want
  me to spend the time.

---

## 4. "GitHub" needs a definition

GitHub is not a source by itself. Plausible readings, all technically feasible:

1. **Security Advisories** — `github.com/advisories.atom`, or the GraphQL
   Security Advisory API. Structured CVE data; *not* writeups.
2. **A watchlist of specific repos** — PoC repos, tool releases. Needs a list.
3. **Trending security repos** — no official API; would require scraping. Ruled
   out by your own rule.
4. **Release notes** of chosen security tools — `…/releases.atom`. Clean and
   reliable, but it is release notes, not research.

Tell me which one you meant and I will verify it the same way.

---

## 5. Open design questions

Recorded here so they are not lost; they are being asked in chat.

1. What to do about the three feed-less platforms.
2. Whether the commit-log and exploit-artifact sources belong in this channel at
   all, or in a separate low-priority digest.
3. Language: these posts are deeply technical English, and **payloads, code and
   CVE identifiers must never be translated** — a translated payload is a broken
   payload. Proposal: Persian framing (why it matters, what the technique is),
   with the title, code blocks, payloads and asset names left verbatim.
4. Schedule. `wrangler.json` already uses **4 of the 5 cron triggers** the free
   plan allows. A dedicated trigger takes the last slot.
5. Destination: a new secret, e.g. `TELEGRAM_SECURITY_CHANNEL`, so this channel
   is independent of the finance channel. No code change to the existing
   publisher.

---

## 6. Reusable, if this goes ahead

The task-3 breaking-news machinery transfers almost directly:

* `src/breaking/rss.ts` — RSS **and** Atom parsing, already handles both
  (`<item>` and `<entry>`), with timeout, size cap and encoding repair.
* `src/lib/hash.ts` — `canonicalUrl`, `storyFingerprint` for dedupe.
* `src/lib/jobs.ts` — `job_runs` bookkeeping, daily claims, `/status` integration.
* `src/llm/` — the multi-provider router and daily budget.
* `scripts/check-feeds.mjs` — would be extended to cover the new list, including
  the "HTTP 200 but stale" check that caught Investing.com in task 3.

New work would be: a source list, a relevance filter (path-based for Intigriti,
keyword/LLM for the rest), a formatter that preserves code blocks, and a
`job_runs` entry. The existing finance channel would not be touched.

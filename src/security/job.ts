/**
 * TASK 6 — the daily security writeup digest.
 *
 * One post per day, in English, to its own channel. Pipeline:
 *
 *   1. fetch every enabled feed (bounded concurrency, timeout, size cap)
 *   2. deterministic relevance filter        -> filter.ts
 *   3. drop anything already posted          -> `security_seen` in D1
 *   4. ONE batched LLM call to rank and frame -> select.ts
 *   5. render, split at Telegram's limit, send
 *   6. record what was sent, only after Telegram confirms
 *
 * The once-per-day guarantee is the same atomic `job_claims` row the calendar
 * job uses: `INSERT OR IGNORE` on (job, local date), so concurrent or retried
 * invocations race on one row and exactly one wins.
 *
 * Nothing here is translated and nothing is paraphrased into the body: titles
 * and links are reproduced verbatim from the feed. The LLM only chooses what
 * to include and writes the single framing line under each entry.
 */

import { describeError, safeFetch } from '../lib/http';
import { canonicalUrl, fnv1a } from '../lib/hash';
import {
  claimDailyJob,
  markClaimSent,
  markClaimSkipped,
  releaseClaim,
  type JobStatus,
} from '../lib/jobs';
import { localDateKey, resolveTimeZone } from '../lib/jalali';
import { getSetting } from '../settings';
import { resolveDailyBudget } from '../llm/budget';
import { resolveProviders } from '../llm/providers';
import { resolveDestination } from '../publisher';
import { parseFeed, type FeedEntry } from '../breaking/rss';
import { sendMessage, TelegramError, type DestinationChat } from '../telegram';
import type { Env } from '../types';
import { evaluate, type FilterVerdict } from './filter';
import { enabledSecuritySources, type SecuritySource } from './sources';
import { selectWriteups, type SelectCandidate } from './select';

/** Per-feed network budget. */
const FEED_TIMEOUT_MS = 10_000;
const FEED_CONCURRENCY = 3;
/**
 * InfoSec Write-ups embeds whole articles in content:encoded, so a single
 * response can be megabytes. Cap the read: we only need titles and the first
 * paragraph, and a 128 MB isolate is not the place to buffer a book.
 */
const FEED_MAX_BYTES = 2_000_000;
/** How far back an item may have been published and still be new to us. */
const LOOKBACK_HOURS = 48;
/** Context handed to the model per item. Keeps one batched call affordable. */
const CONTEXT_CHARS = 2_000;
/** Enough candidates for the model to choose one rigorously evidenced report. */
const MAX_CANDIDATES = 16;
const MAX_WRITEUPS = 1;
/** Telegram hard limit is 4096; leave room for the footer. */
const MAX_MESSAGE_CHARS = 3900;
/** Rows older than this are pruned each run, so the table cannot grow forever. */
const SEEN_RETENTION_DAYS = 45;

export interface SecurityFeedHealth {
  id: string;
  ok: boolean;
  items: number;
  kept: number;
  error?: string;
}

export interface SecurityJobResult {
  status: JobStatus;
  /** Entries read across all feeds. */
  items: number;
  /** Entries that survived the relevance filter. */
  candidates: number;
  /** Entries new to `security_seen`. */
  fresh: number;
  /** Entries the model selected. */
  selected: number;
  /** Telegram messages delivered. */
  messages: number;
  /**
   * The rendered digest, exactly as it was (or would have been) sent. Always
   * populated when something was built, so the admin panel can show the
   * operator the post instead of a count.
   */
  preview?: string[];
  /** True when this run deliberately sent nothing (admin preview). */
  dryRun?: boolean;
  /** True when an admin override ran past an existing daily claim. */
  forced?: boolean;
  /** Whether a destination channel is configured at all. */
  destinationConfigured?: boolean;
  feedsOk: number;
  feedsFailed: number;
  claimDate: string;
  alreadyClaimed?: boolean;
  reason?: string;
  health: SecurityFeedHealth[];
}

export interface RunSecurityOptions {
  now?: Date;
  fetchImpl?: typeof fetch;
  /** Overrides the configured feed list. Tests only. */
  sources?: readonly SecuritySource[];
  /**
   * Admin override: run even if today's claim is already taken.
   *
   * The daily claim exists so the cron cannot double-post; an operator who
   * deliberately presses "force" in the hunt panel is a different situation,
   * and without this a failed morning run meant waiting 24 hours.
   */
  force?: boolean;
  /**
   * Build the digest and return it WITHOUT sending, claiming or recording
   * anything. The admin preview, and the only safe way to see what tonight's
   * post would look like.
   */
  dryRun?: boolean;
  /** Explicit destination, bypassing the stored setting and the secret. */
  destination?: DestinationChat | null;
}

interface Candidate {
  source: SecuritySource;
  entry: FeedEntry;
  key: string;
  verdict: FilterVerdict;
}

/** Stable identity for an article, so a re-titled post is still the same post. */
export function securityItemKey(link: string, title: string): string {
  const canonical = canonicalUrl(link);
  return fnv1a(canonical || title.toLowerCase().replace(/\s+/g, ' ').trim());
}

/** Fetches and parses one feed. Never throws. */
export async function loadSecuritySource(
  source: SecuritySource,
  fetchImpl?: typeof fetch
): Promise<{ entries: FeedEntry[]; health: SecurityFeedHealth }> {
  try {
    const res = await safeFetch(source.url, {
      headers: {
        accept:
          'application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.8',
        'user-agent': 'Mozilla/5.0 (compatible; SecurityDigestBot/1.0)',
      },
      timeoutMs: FEED_TIMEOUT_MS,
      maxBytes: FEED_MAX_BYTES,
      fetchImpl,
      redirect: 'follow',
    });
    if (!res.ok) {
      return {
        entries: [],
        health: { id: source.id, ok: false, items: 0, kept: 0, error: `http_${res.status}` },
      };
    }
    const entries = parseFeed(await res.text());
    return { entries, health: { id: source.id, ok: true, items: entries.length, kept: 0 } };
  } catch (error) {
    return {
      entries: [],
      health: {
        id: source.id,
        ok: false,
        items: 0,
        kept: 0,
        error: describeError(error, 60),
      },
    };
  }
}

async function loadAll(
  sources: readonly SecuritySource[],
  fetchImpl?: typeof fetch
): Promise<{ source: SecuritySource; entries: FeedEntry[]; health: SecurityFeedHealth }[]> {
  const out: { source: SecuritySource; entries: FeedEntry[]; health: SecurityFeedHealth }[] = [];
  for (let i = 0; i < sources.length; i += FEED_CONCURRENCY) {
    const batch = sources.slice(i, i + FEED_CONCURRENCY);
    const settled = await Promise.all(
      batch.map(async (source) => ({ source, ...(await loadSecuritySource(source, fetchImpl)) }))
    );
    out.push(...settled);
  }
  return out;
}

/** Items already delivered, so a long-lived article is posted exactly once. */
async function filterUnseen(db: D1Database, candidates: Candidate[]): Promise<Candidate[]> {
  if (candidates.length === 0) return [];
  const keys = candidates.map((candidate) => candidate.key);
  const placeholders = keys.map((_, i) => `?${i + 1}`).join(',');
  const { results } = await db
    .prepare(`SELECT item_key FROM security_seen WHERE item_key IN (${placeholders})`)
    .bind(...keys)
    .all<{ item_key: string }>();
  const seen = new Set((results ?? []).map((row) => row.item_key));
  return candidates.filter((candidate) => !seen.has(candidate.key));
}

async function markSeen(db: D1Database, candidates: readonly Candidate[]): Promise<void> {
  for (const candidate of candidates) {
    try {
      await db
        .prepare(
          `INSERT OR IGNORE INTO security_seen (item_key, source_id, title, link)
           VALUES (?1, ?2, ?3, ?4)`
        )
        .bind(
          candidate.key,
          candidate.source.id,
          candidate.entry.title.slice(0, 300),
          candidate.entry.link.slice(0, 500)
        )
        .run();
    } catch {
      // Bookkeeping must not fail a delivered digest.
    }
  }
}

async function pruneSeen(db: D1Database, now: Date): Promise<void> {
  try {
    const cutoff = new Date(now.getTime() - SEEN_RETENTION_DAYS * 86_400_000).toISOString();
    await db.prepare(`DELETE FROM security_seen WHERE seen_at < ?1`).bind(cutoff).run();
  } catch {
    // non-fatal
  }
}

/* ----------------------------------------------------------- rendering --- */

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** `5 Oct 2026` — plain, unambiguous, no locale surprises. */
export function digestDate(now: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone,
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export interface RenderedEntry {
  title: string;
  link: string;
  sourceName: string;
  why?: string;
  tags: string[];
  referencePath?: string;
}

export interface DigestSections {
  writeups: RenderedEntry[];
  exploits: RenderedEntry[];
  repoUpdates: RenderedEntry[];
}

/**
 * Renders the digest into one or more messages, each under Telegram's limit.
 *
 * Splitting happens at entry boundaries, never mid-entry, and every part
 * after the first repeats the header so a reader who sees only part 2 still
 * knows what they are looking at.
 */
export function buildDigestMessages(
  sections: DigestSections,
  dateLabel: string
): string[] {
  const header = `🛡 <b>Security Writeups</b> — ${escapeHtml(dateLabel)}`;
  const blocks: string[] = [];

  if (sections.writeups.length > 0) {
    blocks.push('<b>📝 WRITEUPS &amp; RESEARCH</b>');
    sections.writeups.forEach((entry, index) => {
      const lines = [`${index + 1}. <a href="${encodeURI(entry.link)}">${escapeHtml(entry.title)}</a>`];
      if (entry.why) lines.push(`    ${escapeHtml(entry.why)}`);
      const meta = [entry.sourceName, ...entry.tags.map((tag) => `#${tag}`)].join(' · ');
      lines.push(`    <i>${escapeHtml(meta)}</i>`);
      blocks.push(lines.join('\n'));
    });
  }

  if (sections.exploits.length > 0) {
    blocks.push('<b>💥 NEW PUBLIC EXPLOITS</b>');
    for (const entry of sections.exploits) {
      blocks.push(`• <a href="${encodeURI(entry.link)}">${escapeHtml(entry.title)}</a>`);
    }
  }

  if (sections.repoUpdates.length > 0) {
    blocks.push('<b>🔧 TECHNIQUE REFERENCE UPDATED</b>');
    for (const entry of sections.repoUpdates) {
      const label = entry.referencePath ?? entry.title;
      blocks.push(
        `• ${escapeHtml(entry.sourceName)}: <a href="${encodeURI(entry.link)}">${escapeHtml(label)}</a>`
      );
    }
  }

  if (blocks.length === 0) return [];

  const messages: string[] = [];
  let current = header;
  for (const block of blocks) {
    const candidate = `${current}\n\n${block}`;
    if (candidate.length > MAX_MESSAGE_CHARS) {
      messages.push(current);
      current = `${header} <i>(cont.)</i>\n\n${block}`;
    } else {
      current = candidate;
    }
  }
  messages.push(current);
  return messages;
}

/* ----------------------------------------------------------------- job --- */

const cap = (entries: Candidate[], limit: number): Candidate[] => entries.slice(0, limit);

/** Keeps items published recently, or undated ones (dedupe catches repeats). */
function withinLookback(entry: FeedEntry, now: Date): boolean {
  if (!entry.publishedAt) return true;
  const age = now.getTime() - entry.publishedAt.getTime();
  return age >= -10 * 60_000 && age <= LOOKBACK_HOURS * 3_600_000;
}

export async function runSecurityJob(
  env: Env,
  opts: RunSecurityOptions = {}
): Promise<SecurityJobResult> {
  const now = opts.now ?? new Date();
  const timeZone = resolveTimeZone(env.TIMEZONE);
  const today = localDateKey(now, timeZone);

  const base: SecurityJobResult = {
    status: 'skipped',
    items: 0,
    candidates: 0,
    fresh: 0,
    selected: 0,
    messages: 0,
    feedsOk: 0,
    feedsFailed: 0,
    claimDate: today,
    health: [],
  };

  const dryRun = opts.dryRun === true;
  const destination =
    opts.destination !== undefined ? opts.destination : await loadSecurityDestination(env);
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  base.destinationConfigured = Boolean(destination);
  base.dryRun = dryRun || undefined;

  // A preview needs neither a destination nor a token: showing an operator
  // WHY nothing is being posted is the whole point of the admin panel.
  if ((!destination || !token) && !dryRun) {
    return { ...base, reason: 'destination_or_token_missing' };
  }

  // --- once per day --------------------------------------------------------
  // A dry run never touches the claim: previewing today's digest must not
  // consume today's single send.
  let claim: Awaited<ReturnType<typeof claimDailyJob>> = { won: true, date: today };
  if (!dryRun) {
    try {
      claim = await claimDailyJob(env.DB, 'security', timeZone, now);
    } catch (error) {
      return { ...base, status: 'failed', reason: `claim: ${describeError(error, 80)}` };
    }
    if (!claim.won) {
      if (!opts.force) {
        return {
          ...base,
          alreadyClaimed: true,
          reason: `already_${claim.existingStatus ?? 'claimed'}`,
        };
      }
      // Forced: keep going on the existing claim row, and say so in the result.
      base.alreadyClaimed = true;
      base.forced = true;
    }
  }

  // --- 1. fetch ------------------------------------------------------------
  const sources = opts.sources ?? enabledSecuritySources();
  const loaded = await loadAll(sources, opts.fetchImpl);
  const health = loaded.map((entry) => entry.health);
  base.health = health;
  base.feedsOk = health.filter((entry) => entry.ok).length;
  base.feedsFailed = health.length - base.feedsOk;
  base.items = health.reduce((sum, entry) => sum + entry.items, 0);

  if (base.feedsOk === 0) {
    if (!dryRun) await releaseClaim(env.DB, 'security', claim.date);
    return { ...base, status: 'failed', reason: 'all_feeds_failed' };
  }

  // --- 2. filter -----------------------------------------------------------
  const byKind: Record<string, Candidate[]> = { writeup: [], exploit: [], repo: [] };
  const seenKeys = new Set<string>();

  for (const { source, entries, health: feedHealth } of loaded) {
    let kept = 0;
    for (const entry of entries) {
      if (kept >= source.maxItems) break;
      if (!withinLookback(entry, now)) continue;
      const verdict = evaluate(entry, source);
      if (!verdict.keep) continue;

      const key = securityItemKey(entry.link, entry.title);
      if (seenKeys.has(key)) continue; // same URL twice within one run
      seenKeys.add(key);

      byKind[source.kind].push({ source, entry, key, verdict });
      kept += 1;
    }
    feedHealth.kept = kept;
  }

  // Only narrative writeups can prove that their author both found and exploited
  // a real bug. PoC indexes and reference-repository commits are intentionally
  // excluded, even when their titles contain vulnerability keywords.
  const allCandidates = cap(byKind.writeup, MAX_CANDIDATES);
  base.candidates = allCandidates.length;

  if (allCandidates.length === 0) {
    if (!dryRun) await markClaimSkipped(env.DB, 'security', claim.date, 'no_candidates');
    return { ...base, reason: 'no_candidates' };
  }

  // --- 3. dedupe against what we already posted ----------------------------
  let fresh: Candidate[];
  try {
    fresh = await filterUnseen(env.DB, allCandidates);
  } catch (error) {
    if (!dryRun) await releaseClaim(env.DB, 'security', claim.date);
    return { ...base, status: 'failed', reason: `dedupe: ${describeError(error, 60)}` };
  }
  base.fresh = fresh.length;

  if (fresh.length === 0) {
    if (!dryRun) await markClaimSkipped(env.DB, 'security', claim.date, 'all_already_posted');
    return { ...base, reason: 'all_already_posted' };
  }

  // --- 4. one batched LLM call to rank and frame the narrative items -------
  const writeupCandidates = fresh.filter((candidate) => candidate.source.kind === 'writeup');
  const selectCandidates: SelectCandidate[] = writeupCandidates.map((candidate) => ({
    title: candidate.entry.title,
    sourceName: candidate.source.name,
    context: candidate.entry.description.slice(0, CONTEXT_CHARS),
  }));

  const providers = resolveProviders(env);
  const selections =
    selectCandidates.length > 0 && providers.length > 0
      ? await selectWriteups(selectCandidates, {
          providers,
          budget: {
            db: env.DB,
            localDate: today,
            dailyLimit: resolveDailyBudget(env.LLM_DAILY_BUDGET),
          },
          fetchImpl: opts.fetchImpl,
          limit: MAX_WRITEUPS,
        })
      : [];
  base.selected = selections.length;

  // Fail closed. Without model-verified, verbatim discovery and exploitation
  // evidence, posting nothing is safer than publishing another generic digest.
  if (selections.length === 0) {
    if (!dryRun) await markClaimSkipped(env.DB, 'security', claim.date, 'no_verified_exploited_bug');
    return { ...base, reason: 'no_verified_exploited_bug' };
  }

  const chosenWriteups: RenderedEntry[] = selections.map((selection) => {
    const candidate = writeupCandidates[selection.index];
    return {
      title: candidate.entry.title,
      link: candidate.entry.link,
      sourceName: candidate.source.name,
      why: selection.why,
      tags: selection.tags,
    };
  });

  const sections: DigestSections = {
    writeups: chosenWriteups,
    exploits: [],
    repoUpdates: [],
  };

  const messages = buildDigestMessages(sections, digestDate(now, timeZone));
  if (messages.length === 0) {
    if (!dryRun) await markClaimSkipped(env.DB, 'security', claim.date, 'nothing_to_render');
    return { ...base, reason: 'nothing_to_render' };
  }
  base.preview = messages;

  // A preview stops here: nothing is sent, nothing is marked seen, and the
  // items stay eligible for the real run tonight.
  if (dryRun) {
    return { ...base, status: 'skipped', reason: 'dry_run' };
  }

  // Unreachable for a real run (the guard above the claim already returned),
  // but it is what tells the compiler the send below has a target.
  if (!destination || !token) {
    return { ...base, reason: 'destination_or_token_missing' };
  }

  // --- 5. send -------------------------------------------------------------
  let sent = 0;
  for (const text of messages) {
    try {
      await sendMessage({
        token,
        chatId: destination,
        text,
        parseMode: 'HTML',
        disableLinkPreview: true,
        fetchImpl: opts.fetchImpl,
      });
      sent += 1;
    } catch (error) {
      const reason =
        error instanceof TelegramError ? `telegram_${error.status}` : describeError(error, 60);
      // Part of the digest may already be in the channel. Fail closed: mark
      // sent and record what went out, rather than risk re-posting it all.
      await markClaimSent(env.DB, 'security', claim.date, `partial:${sent}/${messages.length}`);
      if (sent > 0) await markSeen(env.DB, deliveredCandidates(fresh, sections));
      return { ...base, status: 'failed', messages: sent, reason };
    }
  }

  // --- 6. record, only now -------------------------------------------------
  await markSeen(env.DB, deliveredCandidates(fresh, sections));
  await markClaimSent(env.DB, 'security', claim.date, `${sent} message(s)`);
  await pruneSeen(env.DB, now);

  return {
    ...base,
    status: base.feedsFailed > 0 ? 'partial' : 'success',
    messages: sent,
  };
}

/** The candidates actually rendered into the digest, by link. */
function deliveredCandidates(
  fresh: readonly Candidate[],
  sections: DigestSections
): Candidate[] {
  const links = new Set(
    [...sections.writeups, ...sections.exploits, ...sections.repoUpdates].map((entry) => entry.link)
  );
  return fresh.filter((candidate) => links.has(candidate.entry.link));
}

/**
 * Destination for THIS channel.
 *
 * Falls back to the main channel only if explicitly pointed there, so a
 * missing secret means "do not publish" rather than "dump security writeups
 * into the Persian finance channel".
 */
/**
 * Settings key holding a security channel configured from the admin panel.
 *
 * The secret stays the deployment-level answer; this is the runtime one, so an
 * operator can point the hunt digest at a channel without a redeploy. The
 * stored value wins when both exist, because it is the one somebody set most
 * recently and can see in the UI.
 */
export const SECURITY_CHANNEL_SETTING = 'security_channel';

/** Validates and normalizes a channel the operator typed. */
export function normalizeSecurityChannel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  if (value === 'MAIN') return 'MAIN';
  const withAt = /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(value) ? `@${value}` : value;
  return isValidChannel(withAt) ? withAt : null;
}

/**
 * The destination actually used by a run: the stored setting first, then the
 * `TELEGRAM_SECURITY_CHANNEL` secret. Never throws — a settings-table hiccup
 * degrades to the secret rather than cancelling the digest.
 */
export async function loadSecurityDestination(env: Env): Promise<DestinationChat | null> {
  let stored: string | null = null;
  try {
    stored = await getSetting(env.DB, SECURITY_CHANNEL_SETTING);
  } catch {
    stored = null;
  }
  if (stored) {
    const normalized = normalizeSecurityChannel(stored);
    if (normalized) {
      return normalized === 'MAIN'
        ? resolveDestination(env)
        : (normalized as DestinationChat);
    }
  }
  return resolveSecurityDestination(env);
}

export function resolveSecurityDestination(env: Env): DestinationChat | null {
  const raw = env.TELEGRAM_SECURITY_CHANNEL?.trim();
  if (!raw) return null;
  if (raw === 'MAIN') return resolveDestination(env);
  return isValidChannel(raw) ? (raw as DestinationChat) : null;
}

const isValidChannel = (value: string): boolean =>
  /^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(value) || /^-?\d{1,20}$/.test(value);


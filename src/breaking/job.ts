/**
 * TASK 3 — breaking big-market news alerts. Runs every 5 minutes.
 *
 * Pipeline:
 *   1. fetch every enabled RSS feed (bounded concurrency, each with a timeout)
 *   2. keep items published inside the freshness window
 *   3. keyword pre-filter                                  — no LLM, no DB
 *   4. record a sighting per (story, source) and count INDEPENDENT newsrooms
 *   5. drop stories already alerted; stop at the daily cap
 *   6. ONE batched LLM scoring call for what is left
 *   7. send alerts whose (LLM score + confirmation bonus) >= threshold
 *   8. record each alert only AFTER Telegram confirms
 *
 * Cost control is the reason for that order. Stages 1-5 are free; only what
 * survives them reaches the model, and never more than `MAX_LLM_CANDIDATES`
 * stories in a single call.
 *
 * Nothing here invents news. The alert text is the feed's own headline plus
 * a Persian summary the model must derive from that same text, and the
 * source link is always included so a reader can check it.
 */

import { withDisclaimer } from '../analysis/marketImpact';
import { describeError, safeFetch } from '../lib/http';
import { localDateKey, localTimeFa, resolveTimeZone } from '../lib/jalali';
import { resolveDailyBudget } from '../llm/budget';
import { resolveProviders } from '../llm/providers';
import { resolveDestination } from '../publisher';
import { sendMessage, TelegramError, type DestinationChat } from '../telegram';
import type { Env } from '../types';
import {
  alertsSentToday,
  alreadyAlerted,
  confirmationBonus,
  confirmingSourceIds,
  pruneSightings,
  recordAlert,
  recordSighting,
  storyKeyFor,
} from './confirm';
import { DEFAULT_PREFILTER_THRESHOLD, prefilter } from './filter';
import { parseFeed, recentEntries, type FeedEntry } from './rss';
import { CATEGORY_LABELS, scoreStories, type ScoredStory } from './score';
import { enabledSources, type BreakingSource } from './sources';

export const DEFAULT_MIN_SCORE = 8;
export const DEFAULT_DAILY_CAP = 8;
/** Items newer than this are considered "breaking". */
export const FRESHNESS_WINDOW_MINUTES = 45;
/** Hard ceiling on how many stories one LLM call may be asked to score. */
export const MAX_LLM_CANDIDATES = 6;
/** Alerts sent in a single run, so one noisy minute cannot flood the channel. */
export const MAX_ALERTS_PER_RUN = 2;
const FEED_TIMEOUT_MS = 8_000;
/** Workers allow 6 simultaneous outgoing connections. */
const FEED_CONCURRENCY = 3;

export interface FeedHealth {
  id: string;
  ok: boolean;
  items: number;
  error?: string;
}

export interface BreakingJobResult {
  status: 'success' | 'skipped' | 'partial' | 'failed';
  /** Feeds that answered with a parseable document. */
  feedsOk: number;
  feedsFailed: number;
  /** Items seen across all feeds, after the freshness window. */
  items: number;
  /** Items that passed the keyword pre-filter. */
  candidates: number;
  /** Candidates actually scored by the LLM. */
  scored: number;
  /** Alerts delivered. */
  sent: number;
  health: FeedHealth[];
  reason?: string;
}

function readInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

export interface Candidate {
  source: BreakingSource;
  entry: FeedEntry;
  storyKey: string;
  prefilterScore: number;
  confirmations: number;
}

/** Fetches and parses one feed. Never throws. */
export async function loadSource(
  source: BreakingSource,
  fetchImpl?: typeof fetch
): Promise<{ entries: FeedEntry[]; health: FeedHealth }> {
  try {
    const res = await safeFetch(source.url, {
      headers: {
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
        'user-agent': 'Mozilla/5.0 (compatible; NewsBreakingBot/1.0)',
      },
      timeoutMs: FEED_TIMEOUT_MS,
      fetchImpl,
      // Guardian answers 301 to /us/business/rss.
      redirect: 'follow',
    });
    if (!res.ok) {
      return { entries: [], health: { id: source.id, ok: false, items: 0, error: `http_${res.status}` } };
    }
    const entries = parseFeed(await res.text());
    return { entries, health: { id: source.id, ok: true, items: entries.length } };
  } catch (error) {
    return {
      entries: [],
      health: { id: source.id, ok: false, items: 0, error: describeError(error, 60) },
    };
  }
}

/** Runs `loadSource` over all feeds with bounded concurrency. */
async function loadAllSources(
  sources: readonly BreakingSource[],
  fetchImpl?: typeof fetch
): Promise<{ source: BreakingSource; entries: FeedEntry[]; health: FeedHealth }[]> {
  const out: { source: BreakingSource; entries: FeedEntry[]; health: FeedHealth }[] = [];
  for (let i = 0; i < sources.length; i += FEED_CONCURRENCY) {
    const batch = sources.slice(i, i + FEED_CONCURRENCY);
    const settled = await Promise.all(
      batch.map(async (source) => ({ source, ...(await loadSource(source, fetchImpl)) }))
    );
    out.push(...settled);
  }
  return out;
}

/** 🚨 alert text. Plain text, no parse mode, link always included. */
export function formatAlert(
  story: ScoredStory,
  candidate: Candidate,
  finalScore: number,
  timeFa: string
): string {
  const category = CATEGORY_LABELS[story.category];
  const lines = [
    `🚨 ${category.emoji} ${category.label} | ${timeFa}`,
    '',
    story.summaryFa,
    '',
    `📰 تیتر اصلی: ${candidate.entry.title}`,
    '',
    `📉 اثر احتمالی بر بازار: ${story.marketImpactFa}`,
    `🎯 دارایی‌های متأثر: ${story.affectedAssets.join('، ')}`,
    '',
    `🔗 ${candidate.entry.link}`,
    `📡 منبع: ${candidate.source.name}${
      candidate.confirmations > 1 ? ` (+${candidate.confirmations - 1} منبع مستقل دیگر)` : ''
    }`,
    `⚖️ امتیاز اهمیت: ${Math.round(finalScore)}/10`,
  ];
  return withDisclaimer(lines.join('\n'));
}

export interface RunBreakingOptions {
  now?: Date;
  fetchImpl?: typeof fetch;
  sources?: readonly BreakingSource[];
}

/**
 * Runs one breaking-news scan. Never throws.
 */
export async function runBreakingJob(
  env: Env,
  opts: RunBreakingOptions = {}
): Promise<BreakingJobResult> {
  const now = opts.now ?? new Date();
  const timeZone = resolveTimeZone(env.TIMEZONE);
  const localDate = localDateKey(now, timeZone);
  const minScore = readInt(env.BREAKING_MIN_SCORE, DEFAULT_MIN_SCORE, 1, 10);
  const dailyCap = readInt(env.BREAKING_DAILY_CAP, DEFAULT_DAILY_CAP, 0, 50);

  const base: BreakingJobResult = {
    status: 'skipped',
    feedsOk: 0,
    feedsFailed: 0,
    items: 0,
    candidates: 0,
    scored: 0,
    sent: 0,
    health: [],
  };

  const destination = resolveDestination(env);
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!destination || !token) return { ...base, reason: 'destination_or_token_missing' };

  // --- cheap gate: are we even allowed to send anything today? -----------
  const sentToday = await alertsSentToday(env.DB, localDate);
  if (sentToday >= dailyCap) {
    return { ...base, reason: `daily_cap_reached_${sentToday}/${dailyCap}` };
  }

  // --- 1-2. fetch and freshness-filter ------------------------------------
  const sources = opts.sources ?? enabledSources();
  const loaded = await loadAllSources(sources, opts.fetchImpl);
  base.health = loaded.map((entry) => entry.health);
  base.feedsOk = base.health.filter((h) => h.ok).length;
  base.feedsFailed = base.health.length - base.feedsOk;

  if (base.feedsOk === 0) {
    // Every feed is down: report, do not guess.
    return { ...base, status: 'failed', reason: 'all_feeds_failed' };
  }

  // --- 3. keyword pre-filter ----------------------------------------------
  const candidates: Candidate[] = [];
  const seenKeys = new Set<string>();

  for (const { source, entries } of loaded) {
    const fresh = recentEntries(entries, now, FRESHNESS_WINDOW_MINUTES);
    base.items += fresh.length;

    for (const entry of fresh) {
      const verdict = prefilter(entry.title, entry.description, DEFAULT_PREFILTER_THRESHOLD);
      if (!verdict.passed) continue;

      const storyKey = storyKeyFor(entry.title);
      // 4. a sighting is recorded for EVERY matching source, including ones
      //    whose copy of the story we will not use as the primary.
      await recordSighting(env.DB, storyKey, source.id, entry.title, entry.link);

      if (seenKeys.has(storyKey)) continue;
      seenKeys.add(storyKey);
      candidates.push({
        source,
        entry,
        storyKey,
        // A primary source (a central bank publishing itself) starts higher.
        prefilterScore: verdict.score + (source.weight - 1),
        confirmations: 1,
      });
    }
  }
  base.candidates = candidates.length;
  if (candidates.length === 0) {
    await pruneSightings(env.DB, now);
    return { ...base, status: 'success', reason: 'no_candidates' };
  }

  // --- 4. count INDEPENDENT newsrooms -------------------------------------
  const groupOf = new Map(sources.map((source) => [source.id, source.group]));
  for (const candidate of candidates) {
    const ids = await confirmingSourceIds(env.DB, candidate.storyKey, now);
    const groups = new Set(ids.map((id) => groupOf.get(id) ?? id));
    candidate.confirmations = Math.max(1, groups.size);
  }

  // --- 5. drop anything already alerted, then rank ------------------------
  const fresh: Candidate[] = [];
  for (const candidate of candidates) {
    if (await alreadyAlerted(env.DB, candidate.storyKey)) continue;
    fresh.push(candidate);
  }
  if (fresh.length === 0) {
    await pruneSightings(env.DB, now);
    return { ...base, status: 'success', reason: 'all_already_alerted' };
  }

  const ranked = fresh
    .sort(
      (a, b) =>
        b.prefilterScore + confirmationBonus(b.confirmations) -
        (a.prefilterScore + confirmationBonus(a.confirmations))
    )
    .slice(0, MAX_LLM_CANDIDATES);

  // --- 6. ONE batched LLM call --------------------------------------------
  const scored = await scoreStories(
    ranked.map((candidate) => ({
      title: candidate.entry.title,
      description: candidate.entry.description,
      sourceName: candidate.source.name,
      confirmations: candidate.confirmations,
    })),
    {
      providers: resolveProviders(env),
      budget: { db: env.DB, localDate, dailyLimit: resolveDailyBudget(env.LLM_DAILY_BUDGET) },
      fetchImpl: opts.fetchImpl,
    }
  );
  base.scored = scored.length;

  if (scored.length === 0) {
    await pruneSightings(env.DB, now);
    // No score => no alert. We never fall back to "send it unscored": an
    // unvetted headline is exactly what the threshold exists to stop.
    return { ...base, status: 'success', reason: 'no_scored_stories' };
  }

  // --- 7. threshold, cap, send --------------------------------------------
  const timeFa = localTimeFa(now, timeZone);
  let remaining = Math.min(dailyCap - sentToday, MAX_ALERTS_PER_RUN);
  let sent = 0;
  let failure: string | undefined;

  const passing = scored
    .map((story) => ({
      story,
      candidate: ranked[story.index],
      finalScore: story.score + confirmationBonus(ranked[story.index].confirmations),
    }))
    .filter((entry) => entry.candidate && entry.finalScore >= minScore)
    .sort((a, b) => b.finalScore - a.finalScore);

  for (const { story, candidate, finalScore } of passing) {
    if (remaining <= 0) break;
    try {
      const message = await sendMessage({
        token,
        chatId: destination as DestinationChat,
        text: formatAlert(story, candidate, finalScore, timeFa),
        disableLinkPreview: true,
        fetchImpl: opts.fetchImpl,
      });
      // Recorded only now, so a failed send leaves the story eligible.
      await recordAlert(env.DB, {
        storyKey: candidate.storyKey,
        title: candidate.entry.title,
        score: finalScore,
        category: story.category,
        localDate,
        messageId: message.message_id,
      });
      sent++;
      remaining--;
    } catch (error) {
      failure =
        error instanceof TelegramError ? `telegram_${error.status}` : describeError(error, 60);
      break;
    }
  }

  base.sent = sent;
  await pruneSightings(env.DB, now);

  if (failure && sent === 0) return { ...base, status: 'failed', reason: failure };
  if (failure) return { ...base, status: 'partial', reason: failure };
  return {
    ...base,
    status: base.feedsFailed > 0 ? 'partial' : 'success',
    ...(sent === 0 ? { reason: 'below_threshold' } : {}),
  };
}

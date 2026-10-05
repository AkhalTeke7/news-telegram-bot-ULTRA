/**
 * Everything the HUNT panel needs to answer one question: *why is the security
 * digest not posting?*
 *
 * The job itself is deliberately silent — it runs once a day inside
 * `scheduled()`, returns a result nobody reads and, when the channel secret is
 * missing, skips with `destination_or_token_missing` and leaves no trace an
 * operator would ever see. That is the actual failure mode this module exists
 * for: it surfaces the configuration, the daily claim, the last run, the live
 * health of every feed and a dry-run preview of tonight's post, through the
 * admin session that already protects the rest of `/api`.
 *
 * Secrets rule, unchanged from the rest of the project: the destination is
 * never echoed back in full. The panel gets a masked form and a boolean.
 */

import { getLastJobRuns, type JobRunRecord } from '../lib/jobs';
import { localDateKey, resolveTimeZone } from '../lib/jalali';
import { configuredProviderIds } from '../llm/providers';
import { getSetting, setSetting } from '../settings';
import { SECURITY_CRON } from '../scheduler';
import type { Env } from '../types';
import { evaluate } from './filter';
import {
  loadSecuritySource,
  loadSecurityDestination,
  normalizeSecurityChannel,
  resolveSecurityDestination,
  securityItemKey,
  SECURITY_CHANNEL_SETTING,
} from './job';
import { enabledSecuritySources, REJECTED_SOURCES, SECURITY_SOURCES } from './sources';

/** How many delivered items the panel lists. */
const RECENT_LIMIT = 25;

/**
 * `@my_sec_channel` -> `@my…nel`.
 *
 * Enough for an operator to recognize the channel they configured, not enough
 * for the response to leak deployment configuration.
 */
export function maskChannel(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = value.trim();
  if (raw.length <= 6) return `${raw.slice(0, 2)}…`;
  return `${raw.slice(0, 3)}…${raw.slice(-3)}`;
}

export interface SecurityFeedProbe {
  id: string;
  name: string;
  kind: string;
  /** Host only — the panel links to the source without echoing query strings. */
  host: string;
  enabled: boolean;
  ok: boolean;
  items: number;
  /** Items that survive the relevance filter right now. */
  kept: number;
  /** Items that are new to `security_seen`. */
  fresh: number;
  newestAgeHours: number | null;
  stale: boolean;
  staleHours: number;
  error?: string;
  /** Up to three current headlines, so the operator sees real data. */
  samples: { title: string; link: string; kept: boolean }[];
}

export interface SecurityOverview {
  destination: {
    configured: boolean;
    /** Where the value came from: the panel, the secret, or nowhere. */
    source: 'setting' | 'secret' | null;
    masked: string | null;
    botTokenConfigured: boolean;
  };
  schedule: { cron: string; description: string };
  llm: { providers: string[]; configured: boolean };
  lastRun: JobRunRecord | null;
  claim: { date: string; status: string | null; detail: string | null };
  seen: { total: number; last24h: number };
  recent: { title: string; link: string; sourceId: string; seenAt: string }[];
  sources: {
    id: string;
    name: string;
    kind: string;
    host: string;
    enabled: boolean;
    maxItems: number;
    staleHours: number;
  }[];
  rejected: { name: string; reason: string }[];
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 40);
  }
};

/** Reads the stored channel (panel-configured), never the secret. */
export async function getStoredSecurityChannel(db: D1Database): Promise<string | null> {
  try {
    return await getSetting(db, SECURITY_CHANNEL_SETTING);
  } catch {
    return null;
  }
}

/**
 * Stores (or clears) the channel the digest posts to.
 *
 * Returns `false` for a value that is not a channel, so the caller can answer
 * 400 instead of writing a destination that will silently never resolve.
 */
export async function setStoredSecurityChannel(
  db: D1Database,
  raw: unknown
): Promise<{ ok: boolean; value: string | null }> {
  if (raw === null || raw === '' || raw === undefined) {
    await setSetting(db, SECURITY_CHANNEL_SETTING, null);
    return { ok: true, value: null };
  }
  const normalized = normalizeSecurityChannel(raw);
  if (!normalized) return { ok: false, value: null };
  await setSetting(db, SECURITY_CHANNEL_SETTING, normalized);
  return { ok: true, value: normalized };
}

/** Everything the panel shows before the operator presses anything. */
export async function buildSecurityOverview(
  env: Env,
  opts: { now?: Date } = {}
): Promise<SecurityOverview> {
  const now = opts.now ?? new Date();
  const timeZone = resolveTimeZone(env.TIMEZONE);
  const today = localDateKey(now, timeZone);

  const stored = await getStoredSecurityChannel(env.DB);
  const secret = resolveSecurityDestination(env);
  const effective = await loadSecurityDestination(env);
  const source: 'setting' | 'secret' | null = stored ? 'setting' : secret ? 'secret' : null;

  let lastRun: JobRunRecord | null = null;
  try {
    lastRun = (await getLastJobRuns(env.DB)).get('security') ?? null;
  } catch {
    lastRun = null;
  }

  let claim = { date: today, status: null as string | null, detail: null as string | null };
  try {
    const row = await env.DB.prepare(
      `SELECT status, detail FROM job_claims WHERE job = 'security' AND claim_date = ?1`
    )
      .bind(today)
      .first<{ status: string; detail: string | null }>();
    if (row) claim = { date: today, status: row.status, detail: row.detail };
  } catch {
    /* a missing claim row is the normal case before 20:00 */
  }

  let seen = { total: 0, last24h: 0 };
  let recent: SecurityOverview['recent'] = [];
  try {
    const counts = await env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN seen_at >= ?1 THEN 1 ELSE 0 END) AS recent
         FROM security_seen`
    )
      .bind(new Date(now.getTime() - 86_400_000).toISOString())
      .first<{ total: number; recent: number | null }>();
    seen = { total: counts?.total ?? 0, last24h: counts?.recent ?? 0 };

    const { results } = await env.DB.prepare(
      `SELECT title, link, source_id, seen_at
         FROM security_seen ORDER BY seen_at DESC LIMIT ?1`
    )
      .bind(RECENT_LIMIT)
      .all<{ title: string; link: string; source_id: string; seen_at: string }>();
    recent = (results ?? []).map((row) => ({
      title: row.title,
      link: row.link,
      sourceId: row.source_id,
      seenAt: row.seen_at,
    }));
  } catch {
    /* table missing (un-migrated deployment) degrades to zeros */
  }

  const providers = configuredProviderIds(env);

  return {
    destination: {
      configured: Boolean(effective),
      source,
      masked: maskChannel(stored ?? secret),
      botTokenConfigured: Boolean(env.TELEGRAM_BOT_TOKEN?.trim()),
    },
    schedule: { cron: SECURITY_CRON, description: 'daily, 20:00 Asia/Tehran' },
    llm: { providers, configured: providers.length > 0 },
    lastRun,
    claim,
    seen,
    recent,
    sources: SECURITY_SOURCES.map((entry) => ({
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      host: hostOf(entry.url),
      enabled: entry.enabled,
      maxItems: entry.maxItems,
      staleHours: entry.staleHours,
    })),
    rejected: REJECTED_SOURCES.map((entry) => ({ name: entry.name, reason: entry.reason })),
  };
}

/**
 * Fetches every enabled feed right now and reports what the digest would make
 * of it — HTTP result, items parsed, items kept by the filter, items not yet
 * posted, and how old the newest entry is.
 *
 * This is the one check that distinguishes "the job is broken" from "the feed
 * is dead", which is otherwise invisible from outside Cloudflare.
 */
export async function probeSecurityFeeds(
  env: Env,
  opts: { now?: Date; fetchImpl?: typeof fetch } = {}
): Promise<SecurityFeedProbe[]> {
  const now = opts.now ?? new Date();
  const sources = enabledSecuritySources();

  const loaded = await Promise.all(
    sources.map(async (source) => ({
      source,
      ...(await loadSecuritySource(source, opts.fetchImpl)),
    }))
  );

  const probes: SecurityFeedProbe[] = [];
  for (const { source, entries, health } of loaded) {
    const keptEntries = entries.filter((entry) => evaluate(entry, source).keep);
    const keys = keptEntries.map((entry) => securityItemKey(entry.link, entry.title));

    let freshCount = keys.length;
    if (keys.length > 0) {
      try {
        const placeholders = keys.map((_, i) => `?${i + 1}`).join(',');
        const { results } = await env.DB.prepare(
          `SELECT item_key FROM security_seen WHERE item_key IN (${placeholders})`
        )
          .bind(...keys)
          .all<{ item_key: string }>();
        freshCount = keys.length - (results ?? []).length;
      } catch {
        /* keep the optimistic count */
      }
    }

    const newest = entries
      .map((entry) => entry.publishedAt?.getTime() ?? null)
      .filter((value): value is number => value !== null)
      .sort((a, b) => b - a)[0];
    const newestAgeHours =
      newest === undefined ? null : Math.max(0, Math.round(((now.getTime() - newest) / 3_600_000) * 10) / 10);

    probes.push({
      id: source.id,
      name: source.name,
      kind: source.kind,
      host: hostOf(source.url),
      enabled: source.enabled,
      ok: health.ok,
      items: health.items,
      kept: keptEntries.length,
      fresh: freshCount,
      newestAgeHours,
      stale: newestAgeHours !== null && newestAgeHours > source.staleHours,
      staleHours: source.staleHours,
      ...(health.error ? { error: health.error } : {}),
      samples: entries.slice(0, 3).map((entry) => ({
        title: entry.title.slice(0, 160),
        link: entry.link.slice(0, 400),
        kept: evaluate(entry, source).keep,
      })),
    });
  }

  return probes;
}

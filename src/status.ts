/**
 * Operational diagnostics for the admin panel.
 *
 * Everything returned here is a count, a timestamp, or an error *category*.
 * No secret value, no destination identifier, and no message text is exposed.
 */

import { getCronSummary, getLastCronRun, type CronRunRow } from './cronRuns';
import { COLLECTION_ONLY_SETTING } from './processingMode';
import { getSetting } from './settings';

const HOUR_MS = 60 * 60 * 1000;

export interface ChannelStats {
  messages: number;
  summarized: number;
  published: number;
  pending: number;
}

export interface StatusReport {
  generatedAt: string;
  channels: {
    total: number;
    enabled: number;
    disabled: number;
    lastCheckedAt: string | null;
  };
  cron: {
    lastRun: CronRunRow | null;
    runs24h: number;
    failedRuns24h: number;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
  };
  messages: {
    total: number;
    collectedLastHour: number;
    filteredAdvertisements: number;
    pendingFilter: number;
    summarizedLastHour: number;
    publishedLastHour: number;
    waitingSummarization: number;
    waitingPublishing: number;
    lastCollectedAt: string | null;
    lastSummarizedAt: string | null;
    lastPublishedAt: string | null;
  };
  ai: {
    model: string | null;
    freeModelsCached: number;
    lastModelRefreshAt: string | null;
    lastModelFailure: string | null;
  };
  publishing: {
    destinationConfigured: boolean;
  };
  processing: {
    /** True = the hourly run only collects raw news; nothing is summarized or published. */
    collectionOnly: boolean;
  };
  recentErrors: { category: string; count: number; latestAt: string | null }[];
}

export async function getChannelStats(db: D1Database): Promise<Map<number, ChannelStats>> {
  const { results } = await db
    .prepare(
      `SELECT c.id,
              COUNT(m.id) AS messages,
              SUM(CASE WHEN m.summarized_at IS NOT NULL THEN 1 ELSE 0 END) AS summarized,
              SUM(CASE WHEN m.published_at IS NOT NULL THEN 1 ELSE 0 END) AS published
         FROM channels c
         LEFT JOIN messages m ON m.source_channel_id = c.id
        GROUP BY c.id`
    )
    .all<{ id: number; messages: number; summarized: number | null; published: number | null }>();

  const stats = new Map<number, ChannelStats>();
  for (const row of results ?? []) {
    const messages = Number(row.messages ?? 0);
    const summarized = Number(row.summarized ?? 0);
    const published = Number(row.published ?? 0);
    stats.set(row.id, {
      messages,
      summarized,
      published,
      pending: Math.max(0, messages - published),
    });
  }
  return stats;
}

export async function getStatusReport(
  db: D1Database,
  opts: { destinationConfigured: boolean; now?: number } = { destinationConfigured: false }
): Promise<StatusReport> {
  const now = opts.now ?? Date.now();
  const hourAgo = new Date(now - HOUR_MS).toISOString();

  const [channels, lastRun, cron, messageCounts, latest, ai] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled,
              MAX(last_checked_at) AS last_checked
         FROM channels`
    ).first<{ total: number; enabled: number | null; last_checked: string | null }>(),
    getLastCronRun(db),
    getCronSummary(db, hourAgo),
    db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN created_at >= ?1 THEN 1 ELSE 0 END) AS collected_1h,
              SUM(CASE WHEN filter_status = 'filtered' THEN 1 ELSE 0 END) AS filtered,
              SUM(CASE WHEN filter_status = 'pending' THEN 1 ELSE 0 END) AS pending_filter,
              SUM(CASE WHEN summarized_at IS NOT NULL AND summarized_at >= ?1 THEN 1 ELSE 0 END) AS summarized_1h,
              SUM(CASE WHEN published_at IS NOT NULL AND published_at >= ?1 THEN 1 ELSE 0 END) AS published_1h,
              SUM(CASE WHEN summarized_at IS NULL AND TRIM(COALESCE(message_text, '')) <> '' THEN 1 ELSE 0 END) AS waiting_summary,
              SUM(CASE WHEN summarized_at IS NOT NULL AND published_at IS NULL THEN 1 ELSE 0 END) AS waiting_publish,
              MAX(created_at) AS last_collected,
              MAX(summarized_at) AS last_summarized,
              MAX(published_at) AS last_published
         FROM messages`
    )
      .bind(hourAgo)
      .first<{
        total: number;
        collected_1h: number | null;
        filtered: number | null;
        pending_filter: number | null;
        summarized_1h: number | null;
        published_1h: number | null;
        waiting_summary: number | null;
        waiting_publish: number | null;
        last_collected: string | null;
        last_summarized: string | null;
        last_published: string | null;
      }>(),
    db.prepare(`SELECT MAX(message_date) AS last_message_date FROM messages`).first<{
      last_message_date: string | null;
    }>(),
    Promise.all([
      getSetting(db, 'selected_model'),
      getSetting(db, 'free_models'),
      getSetting(db, 'free_models_refreshed_at'),
      getSetting(db, 'last_model_failure'),
      getSetting(db, COLLECTION_ONLY_SETTING),
    ]),
  ]);

  const { results: errorRows } = await db
    .prepare(
      `SELECT last_publish_error AS category, COUNT(*) AS count, MAX(last_publish_error_at) AS latest
         FROM messages
        WHERE published_at IS NULL AND last_publish_error IS NOT NULL
        GROUP BY last_publish_error
        ORDER BY count DESC
        LIMIT 10`
    )
    .all<{ category: string; count: number; latest: string | null }>();

  return {
    generatedAt: new Date(now).toISOString(),
    channels: {
      total: Number(channels?.total ?? 0),
      enabled: Number(channels?.enabled ?? 0),
      disabled: Math.max(0, Number(channels?.total ?? 0) - Number(channels?.enabled ?? 0)),
      lastCheckedAt: channels?.last_checked ?? null,
    },
    cron: {
      lastRun,
      runs24h: cron.runs24h,
      failedRuns24h: cron.failedRuns24h,
      lastSuccessAt: cron.lastSuccessAt,
      lastFailureAt: cron.lastFailureAt,
    },
    messages: {
      total: Number(messageCounts?.total ?? 0),
      collectedLastHour: Number(messageCounts?.collected_1h ?? 0),
      filteredAdvertisements: Number(messageCounts?.filtered ?? 0),
      pendingFilter: Number(messageCounts?.pending_filter ?? 0),
      summarizedLastHour: Number(messageCounts?.summarized_1h ?? 0),
      publishedLastHour: Number(messageCounts?.published_1h ?? 0),
      waitingSummarization: Number(messageCounts?.waiting_summary ?? 0),
      waitingPublishing: Number(messageCounts?.waiting_publish ?? 0),
      lastCollectedAt: messageCounts?.last_collected ?? latest?.last_message_date ?? null,
      lastSummarizedAt: messageCounts?.last_summarized ?? null,
      lastPublishedAt: messageCounts?.last_published ?? null,
    },
    ai: {
      model: ai[0],
      freeModelsCached: parseCount(ai[1]),
      lastModelRefreshAt: ai[2],
      lastModelFailure: ai[3],
    },
    publishing: { destinationConfigured: opts.destinationConfigured },
    processing: { collectionOnly: ai[4] === '1' },
    recentErrors: (errorRows ?? []).map((r) => ({
      category: r.category,
      count: Number(r.count),
      latestAt: r.latest,
    })),
  };
}

function parseCount(raw: string | null): number {
  if (!raw) return 0;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

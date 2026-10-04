/**
 * Global importance ranking.
 *
 * Runs once per pipeline run, after summarization and before publishing. It
 * takes every valid candidate from EVERY enabled source channel, asks the model
 * to compare them together, and stores an importance score (1-5) per row.
 *
 * Channel identity is deliberately NOT sent to the model: ranking must depend on
 * news value alone, never on channel order or on how many posts a channel
 * happened to publish. A channel with zero posts simply contributes no
 * candidates.
 */

import { resolveFreeModel, recordModelFailure } from './modelManager';
import { rankNewsItems, AiError, type FetchOptions } from './opencode';
import type { RankCandidate, RankedItem } from './opencode';

export interface RankCandidateRow extends RankCandidate {
  channelId: number;
}

export interface RankReport {
  candidates: number;
  ranked: number;
  /** Rows that received an importance score above 1. */
  important: number;
  model: string | null;
  error?: string;
}

export interface RankOptions extends FetchOptions {
  apiKey?: string;
  /** Upper bound on how many rows are sent in the single ranking request. */
  limit?: number;
  now?: number;
}

/** One ranking request per run; bounded so the prompt stays a sane size. */
export const RANK_CANDIDATE_LIMIT = 40;

/**
 * Every publishable candidate across all channels, regardless of how many posts
 * each channel contributed. Rows without a summary are excluded by the query.
 */
export async function selectRankCandidates(
  db: D1Database,
  opts: { limit?: number } = {}
): Promise<RankCandidateRow[]> {
  const { results } = await db
    .prepare(
      `SELECT m.id, m.source_channel_id, COALESCE(m.title, '') AS title, m.summary_text
         FROM messages m
         JOIN channels c ON c.id = m.source_channel_id
        WHERE c.enabled = 1
          AND m.filter_status <> 'filtered'
          AND m.summarized_at IS NOT NULL
          AND m.published_at IS NULL
          AND TRIM(COALESCE(m.summary_text, '')) <> ''
        ORDER BY m.message_date ASC, m.id ASC
        LIMIT ?1`
    )
    .bind(opts.limit ?? RANK_CANDIDATE_LIMIT)
    .all<{ id: number; source_channel_id: number; title: string; summary_text: string }>();

  return (results ?? []).map((r) => ({
    id: r.id,
    channelId: r.source_channel_id,
    title: r.title ?? '',
    summary: r.summary_text,
  }));
}

/**
 * Persists one score. Only importance is written; publish state, summary and
 * title are never touched here.
 */
export async function markImportance(
  db: D1Database,
  messageId: number,
  importance: number
): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE messages SET importance = ?1 WHERE id = ?2`)
    .bind(importance, messageId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Ranks all candidates in one request and stores the result.
 *
 * Never throws: a ranking failure leaves every importance value untouched and is
 * reported, so publishing (and therefore no news is lost) continues.
 */
export async function runImportanceRanking(
  db: D1Database,
  opts: RankOptions = {}
): Promise<RankReport> {
  const rows = await selectRankCandidates(db, { limit: opts.limit });
  const report: RankReport = {
    candidates: rows.length,
    ranked: 0,
    important: 0,
    model: null,
  };
  if (rows.length === 0) return report;

  if (!opts.apiKey) {
    report.error = 'config_missing';
    return report;
  }

  let ranked: RankedItem[] | null = null;
  const excluded: string[] = [];

  for (let attempt = 0; attempt < 3 && ranked === null; attempt++) {
    const { model } = await resolveFreeModel(db, {
      fetchImpl: opts.fetchImpl,
      baseUrl: opts.baseUrl,
      now: opts.now,
      forceRefresh: attempt > 0,
      exclude: excluded,
    });
    if (!model) {
      report.error = report.error ?? 'no_free_model';
      return report;
    }
    report.model = model;

    try {
      ranked = await rankNewsItems({
        apiKey: opts.apiKey,
        model,
        items: rows,
        fetchImpl: opts.fetchImpl,
        baseUrl: opts.baseUrl,
      });
    } catch (error) {
      const category = error instanceof AiError ? error.category : 'unexpected';
      report.error = category;
      // Rotate away from a failing model, but only among proven-free models.
      if (category === 'rate_limited' || category === 'provider_error') {
        await recordModelFailure(db, model, category, opts.now ?? Date.now());
        excluded.push(model);
        continue;
      }
      return report;
    }
  }

  if (!ranked) {
    report.error = report.error ?? 'ranking_failed';
    return report;
  }

  for (const item of ranked) {
    if (await markImportance(db, item.id, item.importance)) {
      report.ranked++;
      if (item.importance > 1) report.important++;
    }
  }
  return report;
}
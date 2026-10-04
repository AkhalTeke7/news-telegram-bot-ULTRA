/**
 * Selects which FREE OpenRouter model to use, caches the live list in D1 for 24h,
 * and rotates to a different free model when the current one fails.
 *
 * Invariants:
 *  - only models proven free by discoverFreeModels() are ever selected
 *  - a failed model is excluded from the immediate retry
 *  - when no free model is available, the caller gets `null` (never a paid model)
 */

import { discoverFreeModels, MODEL_REFRESH_INTERVAL_MS, type ModelDiscovery } from './openrouter';
import { getSetting, setSetting } from './settings';

export const KEY_SELECTED_MODEL = 'selected_model';
export const KEY_FREE_MODELS = 'free_models';
export const KEY_REFRESHED_AT = 'free_models_refreshed_at';
export const KEY_LAST_FAILURE = 'last_model_failure';

export interface ResolveOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  now?: number;
  /** Bypass the 24h cache (used after a provider failure). */
  forceRefresh?: boolean;
  /** Model ids that must not be chosen (e.g. the one that just failed). */
  exclude?: string[];
}

export interface ResolveResult {
  model: string | null;
  discovery: ModelDiscovery | null;
  rotated: boolean;
  reason: 'selected' | 'refreshed-24h' | 'forced' | 'unavailable' | 'replaced' | 'excluded';
}

export async function resolveFreeModel(
  db: D1Database,
  opts: ResolveOptions = {}
): Promise<ResolveResult> {
  const now = opts.now ?? Date.now();
  const exclude = new Set(opts.exclude ?? []);

  const [cachedModels, refreshedAtRaw, selected] = await Promise.all([
    getSetting(db, KEY_FREE_MODELS),
    getSetting(db, KEY_REFRESHED_AT),
    getSetting(db, KEY_SELECTED_MODEL),
  ]);

  const refreshedAt = refreshedAtRaw ? Date.parse(refreshedAtRaw) : Number.NaN;
  const cacheFresh =
    Number.isFinite(refreshedAt) && now - refreshedAt < MODEL_REFRESH_INTERVAL_MS;

  let freeModels = parseList(cachedModels);
  let discovery: ModelDiscovery | null = null;
  let reason: ResolveResult['reason'] = 'selected';

  if (opts.forceRefresh) {
    reason = 'forced';
  } else if (!cacheFresh) {
    reason = 'refreshed-24h';
  }

  if (!cacheFresh || opts.forceRefresh) {
    try {
      discovery = await discoverFreeModels({ fetchImpl: opts.fetchImpl, baseUrl: opts.baseUrl });
      freeModels = discovery.freeModels;
      await persistDiscovery(db, freeModels, now);
    } catch (e) {
      // A failed refresh must not erase a usable cached list.
      console.error(
        JSON.stringify({
          event: 'model-discovery',
          operation: 'refresh',
          status: 'error',
          category: e instanceof Error ? e.name : 'unknown',
          message: e instanceof Error ? e.message : String(e),
          usingCached: freeModels.length > 0,
          timestamp: new Date(now).toISOString(),
        })
      );
      if (freeModels.length === 0) {
        return { model: null, discovery: null, rotated: false, reason: 'unavailable' };
      }
    }
  }

  const available = freeModels.filter((id) => !exclude.has(id));

  if (selected && available.includes(selected)) {
    return { model: selected, discovery, rotated: false, reason };
  }

  if (available.length === 0) {
    // Explicitly refuse to fall back to anything not proven free.
    await setSetting(db, KEY_SELECTED_MODEL, null);
    return { model: null, discovery, rotated: false, reason: 'unavailable' };
  }

  const next = available[0];
  await setSetting(db, KEY_SELECTED_MODEL, next);
  return {
    model: next,
    discovery,
    rotated: selected !== null && selected !== next,
    reason: reason === 'selected' ? (selected ? 'replaced' : 'selected') : reason,
  };
}

export async function recordModelFailure(
  db: D1Database,
  model: string,
  category: string,
  now = Date.now()
): Promise<void> {
  // Category only — never the provider response body or credentials.
  await setSetting(db, KEY_LAST_FAILURE, `${model}:${category}:${now}`);
}

async function persistDiscovery(db: D1Database, freeModels: string[], now: number): Promise<void> {
  await setSetting(db, KEY_FREE_MODELS, JSON.stringify(freeModels));
  await setSetting(db, KEY_REFRESHED_AT, new Date(now).toISOString());
}

function parseList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
  } catch {
    return [];
  }
}

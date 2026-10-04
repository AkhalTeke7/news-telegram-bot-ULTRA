/**
 * Selects which FREE OpenRouter model to use, caches the live list in D1 for 24h,
 * and rotates to a different free model when the current one fails.
 *
 * Invariants:
 *  - only models proven free by discoverFreeModels() are ever selected
 *  - a failed model is excluded from the immediate retry
 *  - when no free model is available, the caller gets `null` (never a paid model)
 *  - an admin can PIN one free model by hand (`pinned_model`); the pin wins over
 *    automatic selection and survives the 24h refresh. A pinned model that keeps
 *    failing inside a single run is still rotated away from for that run only,
 *    so one dead model can never block the whole pipeline.
 *
 * Automatic selection is no longer "whatever the provider listed first": free
 * ids are scored by `scoreModelId()` so well-known, instruction-following
 * families win over unknown/experimental free endpoints (the reason runs used
 * to pick something like `apodex/apodex-1.1-mini:free` and fail every item).
 */

import { discoverFreeModels, MODEL_REFRESH_INTERVAL_MS, type ModelDiscovery } from './openrouter';
import { getSetting, setSetting } from './settings';

export const KEY_SELECTED_MODEL = 'selected_model';
export const KEY_FREE_MODELS = 'free_models';
export const KEY_REFRESHED_AT = 'free_models_refreshed_at';
export const KEY_LAST_FAILURE = 'last_model_failure';
/** Admin-chosen model id. Empty/absent means fully automatic selection. */
export const KEY_PINNED_MODEL = 'pinned_model';

export interface ResolveOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  now?: number;
  /** Bypass the 24h cache (used after a provider failure). */
  forceRefresh?: boolean;
  /** Model ids that must not be chosen (e.g. the one that just failed). */
  exclude?: string[];
  /** Ignore the admin pin (used when the pinned model just failed). */
  ignorePin?: boolean;
}

export interface ResolveResult {
  model: string | null;
  discovery: ModelDiscovery | null;
  rotated: boolean;
  reason:
    | 'selected'
    | 'refreshed-24h'
    | 'forced'
    | 'unavailable'
    | 'replaced'
    | 'excluded'
    | 'pinned';
  /** True when the returned model comes from the admin pin. */
  pinned?: boolean;
}

/**
 * Preference score for a free model id. Higher is better.
 *
 * Only affects AUTOMATIC selection; a pinned model always wins regardless of
 * score, and nothing here can make a non-free model selectable.
 */
export function scoreModelId(id: string): number {
  const value = id.toLowerCase();
  let score = 0;

  // Known-good instruction-following families on OpenRouter's free tier.
  const families: [RegExp, number][] = [
    [/deepseek.*(v3|chat|r1)/, 100],
    [/^google\/gemini-2\.\d+-flash/, 95],
    [/^google\/gemini/, 80],
    [/llama-3\.3-70b/, 90],
    [/llama-4/, 85],
    [/^meta-llama\//, 70],
    [/qwen.*(2\.5|3).*(72b|32b|235b|instruct)/, 85],
    [/^qwen\//, 65],
    [/mistral.*(small|nemo|large)/, 60],
    [/^mistralai\//, 55],
    [/^openai\//, 60],
    [/^anthropic\//, 60],
    [/^nvidia\/.*nemotron/, 50],
    [/^microsoft\/phi/, 40],
    [/^z-ai\/glm/, 55],
    [/^moonshotai\/kimi/, 55],
  ];
  for (const [re, points] of families) {
    if (re.test(value)) {
      score = Math.max(score, points);
    }
  }

  // Penalties: endpoints that are usually unusable for strict-JSON work.
  if (/(^|\/)(auto|router)(:|$)/.test(value)) score -= 60;
  if (/\b(1b|1\.5b|2b|3b|mini|tiny|nano|small-?3?b)\b/.test(value)) score -= 15;
  if (/(preview|experimental|exp|alpha|beta|rc\d*)/.test(value)) score -= 10;
  if (/(vision|image|audio|video|embed|rerank|coder|code|math|guard|moderation)/.test(value)) {
    score -= 25;
  }

  return score;
}

/**
 * Orders free model ids best-first. Ties keep the provider's original order, so
 * a list the caller already trusts is never shuffled arbitrarily.
 */
export function rankFreeModels(models: readonly string[]): string[] {
  return models
    .map((id, index) => ({ id, index, score: scoreModelId(id) }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .map((entry) => entry.id);
}

export async function resolveFreeModel(
  db: D1Database,
  opts: ResolveOptions = {}
): Promise<ResolveResult> {
  const now = opts.now ?? Date.now();
  const exclude = new Set(opts.exclude ?? []);

  const [cachedModels, refreshedAtRaw, selected, pinnedRaw] = await Promise.all([
    getSetting(db, KEY_FREE_MODELS),
    getSetting(db, KEY_REFRESHED_AT),
    getSetting(db, KEY_SELECTED_MODEL),
    getSetting(db, KEY_PINNED_MODEL),
  ]);

  const pinned = (pinnedRaw ?? '').trim() || null;

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

  // The admin pin wins over everything except an explicit exclusion (the pinned
  // model just failed in this run) or disappearing from the free list.
  if (!opts.ignorePin && pinned && !exclude.has(pinned) && freeModels.includes(pinned)) {
    if (selected !== pinned) await setSetting(db, KEY_SELECTED_MODEL, pinned);
    return {
      model: pinned,
      discovery,
      rotated: selected !== null && selected !== pinned,
      reason: 'pinned',
      pinned: true,
    };
  }

  const available = rankFreeModels(freeModels.filter((id) => !exclude.has(id)));

  if (selected && available.includes(selected) && selected !== pinned) {
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

/* --------------------------------------------------------- admin controls -- */

export interface FreeModelCatalog {
  /** Free model ids, best-first (same ordering automatic selection uses). */
  models: string[];
  /** Model currently in use (pinned or automatically selected). */
  selected: string | null;
  /** Admin pin, or null when selection is automatic. */
  pinned: string | null;
  refreshedAt: string | null;
  /** Last recorded failure, as `model:category:timestamp`. */
  lastFailure: string | null;
}

/**
 * Reads the free-model catalog for the admin interfaces.
 *
 * `refresh: true` re-queries OpenRouter; otherwise the cached list is returned
 * untouched, so merely opening a settings screen never spends a subrequest.
 */
export async function getFreeModelCatalog(
  db: D1Database,
  opts: { refresh?: boolean; fetchImpl?: typeof fetch; baseUrl?: string; now?: number } = {}
): Promise<FreeModelCatalog> {
  const now = opts.now ?? Date.now();

  if (opts.refresh) {
    const discovery = await discoverFreeModels({
      fetchImpl: opts.fetchImpl,
      baseUrl: opts.baseUrl,
    });
    await persistDiscovery(db, discovery.freeModels, now);
  }

  const [models, refreshedAt, selected, pinned, lastFailure] = await Promise.all([
    getSetting(db, KEY_FREE_MODELS),
    getSetting(db, KEY_REFRESHED_AT),
    getSetting(db, KEY_SELECTED_MODEL),
    getSetting(db, KEY_PINNED_MODEL),
    getSetting(db, KEY_LAST_FAILURE),
  ]);

  return {
    models: rankFreeModels(parseList(models)),
    selected: selected ?? null,
    pinned: (pinned ?? '').trim() || null,
    refreshedAt: refreshedAt ?? null,
    lastFailure: lastFailure ?? null,
  };
}

export type PinOutcome = 'pinned' | 'cleared' | 'unknown_model';

/**
 * Pins one free model by hand, or clears the pin (`model === null`) to go back
 * to automatic selection.
 *
 * A model that is not in the cached free list is REFUSED: the free-only rule is
 * never bypassed by admin input.
 */
export async function setPinnedModel(
  db: D1Database,
  model: string | null
): Promise<PinOutcome> {
  if (model === null || model.trim() === '') {
    await setSetting(db, KEY_PINNED_MODEL, null);
    return 'cleared';
  }

  const candidate = model.trim();
  const free = parseList(await getSetting(db, KEY_FREE_MODELS));
  if (!free.includes(candidate)) return 'unknown_model';

  await setSetting(db, KEY_PINNED_MODEL, candidate);
  await setSetting(db, KEY_SELECTED_MODEL, candidate);
  return 'pinned';
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

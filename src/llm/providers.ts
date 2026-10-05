/**
 * Multi-provider LLM registry.
 *
 * All four providers speak the OpenAI chat-completions wire format, so the
 * only per-provider differences are the base URL, the secret name and the
 * default model id. Keeping them in one table means adding a fifth provider is
 * a data change, not a code change.
 *
 * Base URLs verified against each vendor's current documentation:
 *   - OpenRouter    https://openrouter.ai/api/v1
 *   - NVIDIA NIM    https://integrate.api.nvidia.com/v1        (keys start `nvapi-`)
 *   - OpenCode Zen  https://opencode.ai/zen/v1
 *   - Kilo Gateway  https://api.kilo.ai/api/gateway
 *
 * IMPORTANT naming note: this repository already used `OPENCODE_API_KEY` as a
 * LEGACY ALIAS for an OpenRouter key (see `resolveAiApiKey` in openrouter.ts).
 * A real OpenCode Zen key therefore must NOT go in that variable or the old
 * code would send it to OpenRouter and every existing summarization would fail
 * with HTTP 401. The OpenCode Zen key gets its own name, `OPENCODE_ZEN_API_KEY`.
 */

import type { Env } from '../types';

export type ProviderId = 'openrouter' | 'nvidia' | 'opencode' | 'kilo';

export interface ProviderSpec {
  id: ProviderId;
  label: string;
  baseUrl: string;
  /** Reads the provider's key out of the environment. */
  readKey: (env: Env) => string | undefined;
  /** Reads an operator-supplied model override. */
  readModel: (env: Env) => string | undefined;
  /** Used when no override is configured. */
  defaultModel: string;
  /**
   * Whether to send `response_format: {type:'json_object'}`. Harmless where
   * supported and skipped where a model would 400 on it; the client also
   * retries once without it, so this is an optimization rather than a
   * correctness requirement.
   */
  supportsJsonMode: boolean;
}

export const PROVIDER_SPECS: Record<ProviderId, ProviderSpec> = {
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    // Keeps the legacy alias working exactly as the existing pipeline expects.
    readKey: (env) => env.OPENROUTER_API_KEY?.trim() || env.OPENCODE_API_KEY?.trim() || undefined,
    readModel: (env) => env.OPENROUTER_MODEL?.trim() || undefined,
    defaultModel: 'deepseek/deepseek-chat-v3-0324:free',
    supportsJsonMode: true,
  },
  nvidia: {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    readKey: (env) => env.NVIDIA_API_KEY?.trim() || undefined,
    readModel: (env) => env.NVIDIA_MODEL?.trim() || undefined,
    defaultModel: 'meta/llama-3.3-70b-instruct',
    supportsJsonMode: false,
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode Zen',
    baseUrl: 'https://opencode.ai/zen/v1',
    readKey: (env) => env.OPENCODE_ZEN_API_KEY?.trim() || undefined,
    readModel: (env) => env.OPENCODE_ZEN_MODEL?.trim() || undefined,
    defaultModel: 'big-pickle',
    supportsJsonMode: false,
  },
  kilo: {
    id: 'kilo',
    label: 'Kilo Gateway',
    baseUrl: 'https://api.kilo.ai/api/gateway',
    readKey: (env) => env.KILO_API_KEY?.trim() || undefined,
    readModel: (env) => env.KILO_MODEL?.trim() || undefined,
    defaultModel: 'google/gemini-2.5-flash',
    supportsJsonMode: true,
  },
};

/** Default attempt order: cheapest/most-generous free tiers first. */
export const DEFAULT_PROVIDER_ORDER: ProviderId[] = ['nvidia', 'opencode', 'kilo', 'openrouter'];

export interface ResolvedProvider {
  id: ProviderId;
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  supportsJsonMode: boolean;
}

function isProviderId(value: string): value is ProviderId {
  return value === 'openrouter' || value === 'nvidia' || value === 'opencode' || value === 'kilo';
}

/** Parses LLM_PROVIDER_ORDER, ignoring unknown entries. */
export function parseProviderOrder(raw: string | undefined): ProviderId[] {
  const ids = (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(isProviderId);
  if (ids.length === 0) return DEFAULT_PROVIDER_ORDER;
  // Append any provider the operator forgot, so a typo never silently
  // disables a configured key.
  return [...new Set([...ids, ...DEFAULT_PROVIDER_ORDER])];
}

/**
 * The ordered fallback chain of providers that actually have a key.
 *
 * Returns [] when nothing is configured; callers must treat that as "no
 * analysis available" and still deliver the plain message.
 */
export function resolveProviders(env: Env): ResolvedProvider[] {
  const order = parseProviderOrder(env.LLM_PROVIDER_ORDER);
  const out: ResolvedProvider[] = [];
  for (const id of order) {
    const spec = PROVIDER_SPECS[id];
    const apiKey = spec.readKey(env);
    if (!apiKey) continue;
    out.push({
      id: spec.id,
      label: spec.label,
      baseUrl: spec.baseUrl,
      apiKey,
      model: spec.readModel(env) ?? spec.defaultModel,
      supportsJsonMode: spec.supportsJsonMode,
    });
  }
  return out;
}

/** Provider ids that have a key configured — safe to show in /status. */
export function configuredProviderIds(env: Env): ProviderId[] {
  return resolveProviders(env).map((p) => p.id);
}

/**
 * One LLM entry point for every new job: send a prompt, get back a value that
 * has already been validated with zod.
 *
 * Guarantees the callers rely on:
 *  - every request is bounded by a timeout (via `safeFetch`) and wrapped in
 *    try/catch, so a hung provider cannot stall a cron invocation;
 *  - the chain falls through to the next configured provider on transport
 *    errors, 401/403, 429 and malformed output, so one dead key does not take
 *    the feature down;
 *  - the caller NEVER sees unvalidated model output. `chatJson` returns
 *    `T` parsed by the supplied schema, or throws. There is no "trust the
 *    model" path anywhere in this codebase;
 *  - a daily budget is enforced before any request leaves, so free tiers are
 *    not blown through in the first hour of the day.
 */

import { HttpError, describeError, safeFetch, type Schema } from '../lib/http';
import { repairTruncatedJson } from '../openrouter';
import { recordLlmCall, remainingLlmBudget } from './budget';
import type { ResolvedProvider } from './providers';

export const DEFAULT_LLM_TIMEOUT_MS = 30_000;

export type LlmFailure =
  | 'no_provider'
  | 'budget_exhausted'
  | 'all_providers_failed';

export class LlmError extends Error {
  constructor(
    readonly failure: LlmFailure,
    message: string,
    /** Per-provider reasons, already short and secret-free. */
    readonly attempts: string[] = []
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface ChatJsonOptions<T> {
  providers: readonly ResolvedProvider[];
  system: string;
  user: string;
  schema: Schema<T>;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** Budget bookkeeping. Omit to skip budgeting entirely (tests). */
  budget?: { db: D1Database; localDate: string; dailyLimit: number };
  fetchImpl?: typeof fetch;
}

export interface ChatJsonResult<T> {
  data: T;
  provider: string;
  model: string;
}

/** Pulls the assistant text out of an OpenAI-compatible reply. */
function readContent(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as Record<string, unknown> | undefined;
  if (!first) return null;

  const message = first.message as Record<string, unknown> | undefined;
  if (message) {
    const content = message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((part) =>
          part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string'
            ? String((part as Record<string, unknown>).text)
            : ''
        )
        .join('');
    }
  }
  return typeof first.text === 'string' ? first.text : null;
}

/**
 * Extracts the first JSON value from a model reply.
 *
 * Models wrap JSON in prose and code fences, and free models frequently hit
 * the token cap mid-object. `repairTruncatedJson` (already battle-tested in
 * this repo for the summarizer) handles the truncated case; everything else is
 * a plain slice between the first opener and the last closer.
 */
export function extractJson(content: string): unknown {
  const cleaned = content
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  const objStart = cleaned.indexOf('{');
  const arrStart = cleaned.indexOf('[');
  const start =
    objStart === -1 ? arrStart : arrStart === -1 ? objStart : Math.min(objStart, arrStart);
  if (start === -1) return null;

  const opener = cleaned[start];
  const closer = opener === '{' ? '}' : ']';
  const end = cleaned.lastIndexOf(closer);

  if (end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      // fall through to the truncation repair
    }
  }
  return repairTruncatedJson(cleaned.slice(start));
}

interface AttemptOutcome {
  ok: boolean;
  /** Short reason for the run log; never contains the key or the prompt. */
  reason: string;
  content?: string;
}

async function callProvider(
  provider: ResolvedProvider,
  opts: ChatJsonOptions<unknown>,
  useJsonMode: boolean
): Promise<AttemptOutcome> {
  const body: Record<string, unknown> = {
    model: provider.model,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 900,
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.user },
    ],
  };
  if (useJsonMode) body.response_format = { type: 'json_object' };

  let res: Response;
  try {
    res = await safeFetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${provider.apiKey}`,
        'x-title': 'news-telegram-bot',
      },
      body: JSON.stringify(body),
      timeoutMs: opts.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
      fetchImpl: opts.fetchImpl,
    });
  } catch (error) {
    // safeFetch already normalized timeout vs network.
    return { ok: false, reason: describeError(error, 80) };
  }

  if (res.status === 400 && useJsonMode) {
    // Some models reject response_format. One retry without it, then give up
    // on this provider.
    return callProvider(provider, opts, false);
  }
  if (!res.ok) {
    return { ok: false, reason: `http_${res.status}` };
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return { ok: false, reason: 'non_json_response' };
  }

  const content = readContent(payload);
  if (!content || !content.trim()) return { ok: false, reason: 'empty_content' };
  return { ok: true, reason: 'ok', content };
}

/**
 * Runs the prompt against the provider chain and returns schema-validated data.
 *
 * Callers must be prepared for this to throw: every feature that uses an LLM
 * in this project degrades to a non-AI output rather than failing the job.
 */
export async function chatJson<T>(opts: ChatJsonOptions<T>): Promise<ChatJsonResult<T>> {
  if (opts.providers.length === 0) {
    throw new LlmError('no_provider', 'No LLM provider is configured.');
  }

  if (opts.budget) {
    const remaining = await remainingLlmBudget(
      opts.budget.db,
      opts.budget.localDate,
      opts.budget.dailyLimit
    );
    if (remaining <= 0) {
      throw new LlmError('budget_exhausted', 'Daily LLM call budget is exhausted.');
    }
  }

  const attempts: string[] = [];

  for (const provider of opts.providers) {
    const outcome = await callProvider(
      provider,
      opts as ChatJsonOptions<unknown>,
      provider.supportsJsonMode
    );

    if (opts.budget) {
      await recordLlmCall(opts.budget.db, opts.budget.localDate, provider.id, outcome.ok);
    }

    if (!outcome.ok) {
      attempts.push(`${provider.id}:${outcome.reason}`);
      continue;
    }

    const extracted = extractJson(outcome.content ?? '');
    if (extracted === null || extracted === undefined) {
      attempts.push(`${provider.id}:no_json`);
      continue;
    }

    const parsed = opts.schema.safeParse(extracted);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      attempts.push(`${provider.id}:schema_${issue?.path.join('.') || 'root'}`);
      continue;
    }

    return { data: parsed.data, provider: provider.id, model: provider.model };
  }

  throw new LlmError(
    'all_providers_failed',
    `Every configured provider failed: ${attempts.join(', ')}`,
    attempts
  );
}

/** Re-exported so job modules need only one import for error handling. */
export { HttpError };

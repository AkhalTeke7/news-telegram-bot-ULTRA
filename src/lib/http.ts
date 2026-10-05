/**
 * The ONE outbound-fetch helper for every new job (slideshow, calendar,
 * breaking news, market impact).
 *
 * Project rule: every outbound fetch has a timeout and a try/catch. Rather
 * than repeating `AbortSignal.timeout` + try/catch at ~15 call sites and
 * hoping none is forgotten, all of them go through here. A missing timeout is
 * therefore impossible by construction: `timeoutMs` has a default and the raw
 * `fetch` is never called directly outside this module.
 *
 * Nothing here ever logs or echoes a URL's credentials: callers pass headers
 * separately and only `HttpError.status` / a short reason is surfaced.
 */

import type { ZodType, ZodTypeDef } from 'zod';

/**
 * A zod schema whose INPUT is `unknown`.
 *
 * Plain `ZodType<T>` defaults its Input parameter to `T`, which breaks
 * inference for schemas that transform (e.g. a union that normalizes a bare
 * array into `{ items: [...] }`). Parsing always starts from unknown JSON, so
 * this alias is the honest signature.
 */
export type Schema<T> = ZodType<T, ZodTypeDef, unknown>;

/** Default ceiling for a single outbound request. */
export const DEFAULT_TIMEOUT_MS = 10_000;
/** Hard ceiling so a caller can never disable the timeout by passing a huge value. */
export const MAX_TIMEOUT_MS = 60_000;
/** Refuse to buffer a hostile/runaway body. Feeds and JSON here are far smaller. */
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

export type HttpFailure =
  | 'timeout'
  | 'network'
  | 'http_status'
  | 'too_large'
  | 'invalid_json'
  | 'invalid_shape';

export class HttpError extends Error {
  constructor(
    readonly failure: HttpFailure,
    message: string,
    /** HTTP status when one was received; 0 otherwise. */
    readonly status = 0
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface SafeFetchOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  /** Bounded by MAX_TIMEOUT_MS. Defaults to DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
  /** Forwarded to fetch; `follow` is the platform default. */
  redirect?: 'follow' | 'manual' | 'error';
}

function reason(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timed out';
    return error.message;
  }
  return String(error);
}

/**
 * Performs one bounded request and returns the raw Response.
 *
 * Throws HttpError('timeout' | 'network') instead of letting a transport
 * rejection escape, so callers only ever deal with one error type.
 */
export async function safeFetch(url: string, opts: SafeFetchOptions = {}): Promise<Response> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = Math.min(Math.max(1, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS);

  try {
    return await doFetch(url, {
      method: opts.method ?? 'GET',
      headers: opts.headers,
      body: opts.body,
      redirect: opts.redirect,
      // The single place a timeout is attached. Never remove.
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const text = reason(error);
    throw new HttpError(text === 'timed out' ? 'timeout' : 'network', `request failed: ${text}`);
  }
}

/** Reads a response body as text with a byte ceiling. */
async function readBounded(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError('too_large', `response too large (${declared} bytes)`, res.status);
  }
  let text: string;
  try {
    text = await res.text();
  } catch (error) {
    throw new HttpError('network', `reading body failed: ${reason(error)}`, res.status);
  }
  if (text.length > maxBytes) {
    throw new HttpError('too_large', `response too large (${text.length} chars)`, res.status);
  }
  return text;
}

/** Bounded GET/POST returning text, failing on a non-2xx status. */
export async function fetchText(url: string, opts: SafeFetchOptions = {}): Promise<string> {
  const res = await safeFetch(url, opts);
  if (!res.ok) {
    throw new HttpError('http_status', `HTTP ${res.status}`, res.status);
  }
  return readBounded(res, opts.maxBytes ?? DEFAULT_MAX_BYTES);
}

/**
 * Bounded request whose body is parsed as JSON and then validated with zod.
 *
 * Validation is mandatory, not optional: every piece of external data in this
 * project (Forex Factory, LLM replies, Telegram responses) must come back
 * through a schema, so a shape change upstream becomes a clean typed failure
 * instead of an undefined-property crash at 4 a.m.
 */
export async function fetchJson<T>(
  url: string,
  schema: Schema<T>,
  opts: SafeFetchOptions = {}
): Promise<T> {
  const text = await fetchText(url, {
    ...opts,
    headers: { accept: 'application/json', ...opts.headers },
  });
  return parseJsonWith(text, schema);
}

/** Parses a JSON string and validates it, mapping both failures to HttpError. */
export function parseJsonWith<T>(text: string, schema: Schema<T>): T {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new HttpError('invalid_json', 'response was not valid JSON');
  }
  const result = schema.safeParse(payload);
  if (!result.success) {
    // Only the path/code is surfaced; the raw payload may contain news text we
    // do not want in logs.
    const first = result.error.issues[0];
    const path = first?.path.join('.') || '(root)';
    throw new HttpError('invalid_shape', `unexpected shape at ${path}: ${first?.code ?? 'invalid'}`);
  }
  return result.data;
}

/** Short, secret-free description of any error, safe to log or store. */
export function describeError(error: unknown, limit = 160): string {
  if (error instanceof HttpError) return `${error.failure}: ${error.message}`.slice(0, limit);
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, limit);
  return String(error).slice(0, limit);
}

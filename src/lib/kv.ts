/**
 * Thin, always-safe wrapper around Workers KV.
 *
 * Two rules the rest of the code depends on:
 *  1. KV is OPTIONAL. The binding may be missing (a fresh checkout, a local
 *     `wrangler dev` without the namespace created yet). Every helper degrades
 *     to "cache miss" instead of throwing, so a missing namespace can never
 *     take a cron job down.
 *  2. Values are validated with zod on the way OUT. A cached value is external
 *     data as far as this Worker is concerned: it may have been written by an
 *     older deploy with a different shape.
 */

import type { Schema } from './http';

export interface KvCacheEntry<T> {
  value: T;
  /** Unix seconds when the entry was written. */
  cachedAt: number;
}

/** Reads and validates a cached JSON value. Any problem yields null. */
export async function kvGetJson<T>(
  kv: KVNamespace | undefined,
  key: string,
  schema: Schema<T>
): Promise<T | null> {
  if (!kv) return null;
  try {
    const raw = await kv.get(key, 'text');
    if (!raw) return null;
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    // Unparseable or unavailable cache behaves exactly like a miss.
    return null;
  }
}

/** Writes a JSON value with a TTL. Returns false when it could not be stored. */
export async function kvPutJson(
  kv: KVNamespace | undefined,
  key: string,
  value: unknown,
  ttlSeconds: number
): Promise<boolean> {
  if (!kv) return false;
  try {
    // KV rejects expirationTtl below 60 seconds.
    await kv.put(key, JSON.stringify(value), { expirationTtl: Math.max(60, Math.floor(ttlSeconds)) });
    return true;
  } catch {
    return false;
  }
}

/** Deletes a key, ignoring every failure. */
export async function kvDelete(kv: KVNamespace | undefined, key: string): Promise<void> {
  if (!kv) return;
  try {
    await kv.delete(key);
  } catch {
    /* best effort */
  }
}

/**
 * Cache-aside helper: return the cached value, otherwise produce a fresh one
 * and store it.
 *
 * `stale` is handed back when the loader throws AND a cached value exists,
 * which is what keeps the daily calendar job alive through a brief upstream
 * outage. When there is no cache and the loader throws, the error propagates —
 * callers must decide whether to report "source unavailable" to the user.
 */
export async function kvCached<T>(
  kv: KVNamespace | undefined,
  key: string,
  schema: Schema<T>,
  ttlSeconds: number,
  loader: () => Promise<T>
): Promise<{ value: T; source: 'cache' | 'origin' }> {
  const cached = await kvGetJson(kv, key, schema);
  if (cached !== null) return { value: cached, source: 'cache' };

  const value = await loader();
  await kvPutJson(kv, key, value, ttlSeconds);
  return { value, source: 'origin' };
}

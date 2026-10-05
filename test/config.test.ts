import { describe, expect, it } from 'vitest';
import wranglerConfig from '../wrangler.json';

describe('wrangler config', () => {
  it('declares every cron trigger (UTC-only; Iran is UTC+03:30, so :30 UTC == :00 Tehran)', () => {
    expect(wranglerConfig.triggers.crons).toEqual([
      '30 */2 * * *', // news digest pipeline (pre-existing)
      '*/5 * * * *', // breaking-news scan
      '30 4 * * *', // Forex Factory daily list -> 08:00 Asia/Tehran
      '0 */3 * * *', // slideshow
      '30 16 * * *', // security writeup digest -> 20:00 Asia/Tehran
    ]);
  });

  it('binds KV and the browser without requiring R2 or leaking ids into vars', () => {
    expect(wranglerConfig.kv_namespaces[0].binding).toBe('KV');
    expect('r2_buckets' in wranglerConfig).toBe(false);
    expect(wranglerConfig.browser.binding).toBe('BROWSER');
    expect(wranglerConfig.vars.TIMEZONE).toBe('Asia/Tehran');
  });

  it('binds D1 with a migrations dir and keeps secrets out of config', () => {
    const db = wranglerConfig.d1_databases[0];
    expect(db.binding).toBe('DB');
    expect(db.migrations_dir).toBe('migrations');

    const raw = JSON.stringify(wranglerConfig);
    expect(raw).not.toContain('ADMIN_PASSWORD');
    expect(raw).not.toContain('TELEGRAM_BOT_TOKEN');
  });

  it('points main at src/index.ts', () => {
    expect(wranglerConfig.main).toBe('src/index.ts');
  });

  it('declares exactly one D1 binding named DB', () => {
    // Guards against a duplicate binding pointing local dev at production D1.
    expect(wranglerConfig.d1_databases).toHaveLength(1);
    expect(wranglerConfig.d1_databases[0].binding).toBe('DB');
  });

  it('never marks a D1 binding as remote', () => {
    const raw = JSON.stringify(wranglerConfig);
    expect(raw).not.toContain('news_bot');
    expect(raw).not.toMatch(/"remote"\s*:\s*true/);
  });
});

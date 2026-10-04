import { describe, expect, it } from 'vitest';
import wranglerConfig from '../wrangler.json';

describe('wrangler config', () => {
  it('declares the hourly cron trigger (start of each Iranian hour)', () => {
    // Cloudflare cron is UTC-only; Iran is UTC+03:30, so :30 UTC == :00 Tehran.
    expect(wranglerConfig.triggers.crons).toEqual(['30 * * * *']);
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

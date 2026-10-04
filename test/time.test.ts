import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import wranglerConfig from '../wrangler.json';
import { runNewsPipeline } from '../src/pipeline';
import {
  formatTehranDateTime,
  formatTehranDateTimeOrDash,
  TEHRAN_TIME_ZONE,
  TEHRAN_UTC_OFFSET_MINUTES,
  tehranParts,
  timeZoneOffsetMinutes,
} from '../src/time';
import type { Env } from '../src/types';

function testEnv(): Env {
  return { DB: env.DB, ADMIN_PASSWORD: 'tz-test-password' } as Env;
}

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM messages`).run();
  await env.DB.prepare(`DELETE FROM channels`).run();
  await env.DB.prepare(`DELETE FROM cron_runs`).run();
  await env.DB.prepare(`DELETE FROM ai_settings`).run();
});

/**
 * Cloudflare Cron Triggers are UTC-only ("Cron Triggers execute on UTC time")
 * and support no timezone field. Iran is a fixed UTC+03:30 with no DST, so every
 * Iranian hour boundary falls on a UTC :30 — hence a single "30 * * * *" trigger
 * equals "at the start of every Iranian hour".
 */
const CRON = wranglerConfig.triggers.crons;

describe('cron schedule', () => {
  it('is the single trigger that starts every other Iranian hour', () => {
    expect(CRON).toEqual(['30 */2 * * *']);
  });

  it('creates exactly one bi-hourly trigger (no duplicates)', () => {
    expect(CRON).toHaveLength(1);
    expect(CRON.filter((c) => /^30 \*\/2 \* \* \*$/.test(c))).toHaveLength(1);
  });

  it('uses only UTC cron syntax Cloudflare supports', () => {
    for (const expr of CRON) {
      expect(expr).toMatch(/^[0-9*/,\-A-Za-z]+ [0-9*/,\-A-Za-z]+ [0-9*/,\-LW]+ [0-9*/,\-A-Za-z]+ [0-9*/,\-L#]+$/);
      // No timezone prefix (CRON_TZ=/TZ=) — unsupported by Cloudflare.
      expect(expr).not.toMatch(/CRON_TZ|^TZ=/);
    }
  });

  it('maps every UTC firing to the start of an Iranian hour', () => {
    // Walk a full day of UTC :30 firings and assert Tehran is exactly on the hour.
    for (let utcHour = 0; utcHour < 24; utcHour++) {
      const instant = new Date(Date.UTC(2026, 0, 15, utcHour, 30, 0));
      const tehran = tehranParts(instant)!;
      expect(tehran.minute, `UTC ${utcHour}:30 -> Tehran`).toBe(0);
      // Tehran is UTC+03:30, so an hour boundary lands 30 minutes later.
      expect(tehran.hour).toBe((utcHour + 4) % 24);
    }
  });

  it('agrees with the documented fixed offset', () => {
    for (const month of [0, 2, 3, 6, 9, 11]) {
      const instant = new Date(Date.UTC(2026, month, 15, 12, 0, 0));
      expect(timeZoneOffsetMinutes(instant, TEHRAN_TIME_ZONE)).toBe(TEHRAN_UTC_OFFSET_MINUTES);
    }
  });
});

describe('Tehran timestamp rendering', () => {
  it('converts a fixed UTC instant to the next Tehran midnight', () => {
    const tehran = tehranParts('2026-01-15T20:30:00.000Z')!;
    expect(tehran).toEqual({ year: 2026, month: 1, day: 16, hour: 0, minute: 0 });
  });

  it('does not display a UTC timestamp as Tehran time', () => {
    // 12:00Z is 15:30 Tehran — showing "12:00" would be the bug.
    const rendered = formatTehranDateTime('2026-01-15T12:00:00.000Z')!;
    expect(rendered).toContain('۱۵:۳۰');
    expect(rendered).not.toBe(formatTehranDateTime('2026-01-15T15:30:00.000Z'));
  });

  it('renders a Persian (Jalali) date and 24-hour time', () => {
    const rendered = formatTehranDateTime('2026-01-15T20:30:00.000Z')!;
    // 26 Dey 1404, 00:00 Tehran.
    expect(rendered).toContain('۱۴۰۴');
    expect(rendered).toContain('۱۰');
    expect(rendered).toContain('۲۶');
    expect(rendered).toContain('۰۰:۰۰');
    expect(rendered).toContain('-');
    expect(rendered).not.toMatch(/[0-9]/); // Persian digits only
  });

  it('shifts the date correctly across the UTC day boundary', () => {
    // 21:30Z on 15 July is 01:00 on 16 July in Tehran.
    expect(tehranParts('2026-07-15T21:30:00.000Z')).toEqual({
      year: 2026,
      month: 7,
      day: 16,
      hour: 1,
      minute: 0,
    });
    // 18:30Z on 15 July is still 22:00 on 15 July in Tehran.
    expect(tehranParts('2026-07-15T18:30:00.000Z')).toEqual({
      year: 2026,
      month: 7,
      day: 15,
      hour: 22,
      minute: 0,
    });
  });

  it('returns a dash for missing or invalid input', () => {
    expect(formatTehranDateTime(null)).toBeNull();
    expect(formatTehranDateTimeOrDash(null)).toBe('—');
    expect(formatTehranDateTimeOrDash('not-a-date')).toBe('—');
    expect(formatTehranDateTime(undefined)).toBeNull();
  });
});

describe('canonical timestamps stay UTC', () => {
  it('stores ran_at as UTC ISO while rendering Tehran time for the admin', async () => {
    // A run that started at 20:30 UTC is 00:00 Tehran the next day.
    const startedAtIso = '2026-07-15T20:30:00.000Z';

    await env.DB.prepare(
      `INSERT INTO cron_runs (trigger_name, ran_at, status, finished_at)
       VALUES ('cron', ?1, 'success', ?1)`
    )
      .bind(startedAtIso)
      .run();

    const row = await env.DB.prepare(
      `SELECT ran_at FROM cron_runs ORDER BY id DESC LIMIT 1`
    ).first<{ ran_at: string }>();

    // Canonical storage is untouched: still UTC, still ISO-8601 with Z.
    expect(row?.ran_at).toBe(startedAtIso);
    expect(row?.ran_at.endsWith('Z')).toBe(true);
    expect(new Date(row!.ran_at).toISOString()).toBe(startedAtIso);

    // Only the presentation layer converts, and it converts to Tehran.
    const shown = formatTehranDateTimeOrDash(row!.ran_at);
    expect(shown).not.toBe('—');
    // 20:30 UTC + 03:30 = 00:00 Tehran on the FOLLOWING day.
    expect(shown).toContain('۰۰:۰۰');
    // The raw UTC clock time must never be presented as if it were Tehran time.
    expect(shown).not.toContain('۲۰:۳۰');
    // fa-IR renders the Jalali calendar: 2026-07-16 Tehran is 1405/04/25, and
    // the day must have rolled forward from the 15th (1405/04/24).
    expect(shown).toContain('۱۴۰۵');
    expect(shown).toContain('۲۵');
    expect(shown).not.toContain('۲۴');
  });

  it('keeps every stored timestamp column in UTC', async () => {
    const ch = await env.DB
      .prepare(`INSERT INTO channels (channel_username, enabled) VALUES ('tz_probe_chan', 1)`)
      .run();
    await env.DB.prepare(
      `INSERT INTO messages (source_channel_id, telegram_message_id, message_date, message_text, source_url)
       VALUES (?1, 1, '2026-07-15T20:30:00.000Z', 'body', 'https://t.me/tz_probe_chan/1')`
    )
      .bind(Number(ch.meta.last_row_id))
      .run();

    const row = await env.DB.prepare(
      `SELECT message_date, created_at FROM messages ORDER BY id DESC LIMIT 1`
    ).first<{ message_date: string; created_at: string }>();

    expect(row?.message_date).toBe('2026-07-15T20:30:00.000Z');
    expect(row?.created_at.endsWith('Z')).toBe(true);
  });
});

describe('manual processing is independent of the cron schedule', () => {
  it('runs the same pipeline through the manual trigger without touching cron config', async () => {
    const outcome = await runNewsPipeline(env.DB, testEnv(), {
      trigger: 'manual',
      log: false,
    });

    // The manual path is labelled 'manual' and is not tied to any cron firing.
    expect(outcome.trigger).toBe('manual');
    expect(CRON).toEqual(['30 */2 * * *']);
    expect(CRON).toHaveLength(1);

    // Bookkeeping still records which trigger produced the run.
    const row = await env.DB.prepare(
      `SELECT trigger_name FROM cron_runs ORDER BY id DESC LIMIT 1`
    ).first<{ trigger_name: string }>();
    expect(row?.trigger_name).toBe('manual');
  });
});

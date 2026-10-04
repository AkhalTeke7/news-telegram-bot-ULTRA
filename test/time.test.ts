import { describe, expect, it } from 'vitest';
import wranglerConfig from '../wrangler.json';
import {
  formatTehranDateTime,
  formatTehranDateTimeOrDash,
  TEHRAN_TIME_ZONE,
  TEHRAN_UTC_OFFSET_MINUTES,
  tehranParts,
  timeZoneOffsetMinutes,
} from '../src/time';

/**
 * Cloudflare Cron Triggers are UTC-only ("Cron Triggers execute on UTC time")
 * and support no timezone field. Iran is a fixed UTC+03:30 with no DST, so every
 * Iranian hour boundary falls on a UTC :30 — hence a single "30 * * * *" trigger
 * equals "at the start of every Iranian hour".
 */
const CRON = wranglerConfig.triggers.crons;

describe('cron schedule', () => {
  it('is the single trigger that starts each Iranian hour', () => {
    expect(CRON).toEqual(['30 * * * *']);
  });

  it('creates exactly one hourly trigger (no duplicates)', () => {
    expect(CRON).toHaveLength(1);
    expect(CRON.filter((c) => /^30 \* \* \* \*$/.test(c))).toHaveLength(1);
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

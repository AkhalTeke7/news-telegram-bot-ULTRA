/**
 * Time helpers for admin-facing timestamps.
 *
 * Database timestamps stay canonical UTC (unchanged). Conversion happens only at
 * display time, using the runtime's IANA timezone support rather than adding a
 * fixed number of hours, so the output follows `Asia/Tehran` exactly.
 */

export const TEHRAN_TIME_ZONE = 'Asia/Tehran';

/**
 * Iran abolished daylight saving in 2022 (1401 SH); the offset is a constant
 * UTC+03:30. Kept as documentation and asserted in tests — the actual
 * conversion below never uses this number.
 */
export const TEHRAN_UTC_OFFSET_MINUTES = 210;

function toDate(input: Date | string | number): Date | null {
  const date = input instanceof Date ? input : new Date(input);
  return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * Offset of `timeZone` from UTC at the given instant, in minutes, computed from
 * the runtime's timezone data (so it would follow any future rule change).
 */
export function timeZoneOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second')
  );
  return Math.round((asUtc - date.getTime()) / 60000);
}

/** Calendar fields of an instant as seen in `Asia/Tehran`. */
export function tehranParts(
  input: Date | string | number
): { year: number; month: number; day: number; hour: number; minute: number } | null {
  const date = toDate(input);
  if (!date) return null;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TEHRAN_TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
  };
}

/**
 * Persian (Jalali) date and 24-hour time in Tehran, e.g. `۱۴۰۴/۱۰/۲۶ - ۰۰:۰۰`.
 * Date and time are formatted separately and joined explicitly, so the result
 * does not depend on the locale's own separator characters.
 * Returns null for missing/invalid input so callers can print their own dash.
 */
export function formatTehranDateTime(input: Date | string | number | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const date = toDate(input);
  if (!date) return null;

  const datePart = new Intl.DateTimeFormat('fa-IR', {
    timeZone: TEHRAN_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(date)
    // Keep only Persian/ASCII digits and the date separators.
    .replace(/[^۰-۹0-9/-]/g, '');

  const timePart = new Intl.DateTimeFormat('fa-IR', {
    timeZone: TEHRAN_TIME_ZONE,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  })
    .format(date)
    .replace(/[^۰-۹0-9:]/g, '');

  if (!datePart || !timePart) return null;
  return `${datePart} - ${timePart}`;
}

/** Same, with a placeholder for unknown timestamps. */
export function formatTehranDateTimeOrDash(input: Date | string | number | null | undefined): string {
  return formatTehranDateTime(input) ?? '—';
}

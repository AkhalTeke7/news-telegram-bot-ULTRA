/**
 * Timezone-aware Jalali (Persian) date/time formatting.
 *
 * Differences from the existing `src/time.ts` (which stays untouched):
 *  - the timezone is a PARAMETER (env TIMEZONE, default Asia/Tehran) instead of
 *    being hardcoded to Asia/Tehran;
 *  - output is the Persian calendar via `Intl` with `-u-ca-persian`, in Persian
 *    digits, which is what the slides and the calendar message need.
 *
 * Everything is derived from the runtime's IANA timezone database through
 * `Intl`. No offset is ever added by hand, so DST rules (Iran has none today,
 * but New York — which Forex Factory timestamps use — very much does) are
 * always correct.
 */

export const DEFAULT_TIME_ZONE = 'Asia/Tehran';

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/** Converts ASCII digits in a string to Persian digits. */
export function toPersianDigits(value: string | number): string {
  return String(value).replace(/[0-9]/g, (d) => PERSIAN_DIGITS[Number(d)]);
}

/**
 * Validates an IANA timezone id, falling back to Asia/Tehran.
 *
 * A bad TIMEZONE value must never throw inside a cron job; it degrades to the
 * documented default and the job still runs.
 */
export function resolveTimeZone(raw: string | undefined | null): string {
  const value = (raw ?? '').trim();
  if (!value) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return value;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Gregorian calendar fields of an instant as seen in `timeZone`. */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
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
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

/**
 * Local civil date key `YYYY-MM-DD` in `timeZone`.
 *
 * This is the "which day is it for the user" primitive. Both the once-per-day
 * claim key and the "events for today" filter use it, so a cron that fires at
 * 04:30 UTC and a retry that fires at 04:35 UTC agree on the same day.
 */
export function localDateKey(date: Date, timeZone: string): string {
  const { year, month, day } = zonedParts(date, timeZone);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Local `HH:MM` (24h) in `timeZone`, ASCII digits. */
export function localTimeHm(date: Date, timeZone: string): string {
  const { hour, minute } = zonedParts(date, timeZone);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(hour)}:${pad(minute)}`;
}

/** Local `HH:MM` in Persian digits, for user-facing output. */
export function localTimeFa(date: Date, timeZone: string): string {
  return toPersianDigits(localTimeHm(date, timeZone));
}

/**
 * Jalali date in Persian digits, e.g. «۱۴ مهر ۱۴۰۵».
 *
 * Uses the `fa-IR-u-ca-persian` locale so month names and the year are the
 * real Persian calendar, not a Gregorian date written in Persian digits.
 */
export function jalaliDate(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
      timeZone,
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }).format(date);
  } catch {
    // An exotic runtime without the Persian calendar must not break a render.
    return toPersianDigits(localDateKey(date, timeZone));
  }
}

/** Compact Jalali date `۱۴۰۵/۰۷/۱۴`, used where space is tight. */
export function jalaliDateNumeric(date: Date, timeZone: string): string {
  try {
    const formatted = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
    return formatted;
  } catch {
    return toPersianDigits(localDateKey(date, timeZone));
  }
}

/** «۱۴ مهر ۱۴۰۵ — ۱۴:۳۰» for the slide header. */
export function jalaliDateTime(date: Date, timeZone: string): string {
  return `${jalaliDate(date, timeZone)} — ${localTimeFa(date, timeZone)}`;
}

/**
 * Offset of `timeZone` from UTC at `date`, in minutes.
 *
 * Needed to document the cron conversion and to assert in tests that the
 * configured UTC cron really lands on the intended local time.
 */
export function timeZoneOffsetMinutes(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** True when both instants fall on the same civil day in `timeZone`. */
export function isSameLocalDay(a: Date, b: Date, timeZone: string): boolean {
  return localDateKey(a, timeZone) === localDateKey(b, timeZone);
}

import { formatDate, parseDate } from './dates';

/**
 * Business-day calendar (pure, offline, no calendar libraries).
 *
 * A business day is every calendar day that is NOT
 *  - a Saturday or Sunday, and NOT
 *  - a Japanese public holiday (国民の祝日, 振替休日 or 国民の休日).
 *
 * Japanese public holidays are computed from the statutory rules
 * (Act on National Holidays): fixed dates, nth-Monday holidays
 * (Happy Monday system), the two astronomical equinoxes (table below),
 * substitute holidays (振替休日 — a holiday on Sunday shifts the day off to
 * the next non-holiday weekday) and sandwich days (国民の休日 — a weekday
 * between two holidays becomes a holiday itself).
 *
 * The rules are the modern set (Feb 23 Emperor's Birthday etc.); the
 * equinox table is exact for 2022–2035 and falls back to Mar 20 / Sep 23
 * outside that range. The 2020–2021 Olympic one-off date moves are NOT
 * modeled.
 */

const MS_PER_DAY = 86_400_000;

/** Day-of-month of the vernal equinox (JST) by year; default 20. */
const VERNAL_EQUINOX_DAY: Record<number, number> = {
  2022: 21, 2023: 21, 2024: 20, 2025: 20, 2026: 20, 2027: 21,
  2028: 20, 2029: 20, 2030: 20, 2031: 21, 2032: 20, 2033: 20,
  2034: 20, 2035: 21,
};

/** Day-of-month of the autumnal equinox (JST) by year; default 23. */
const AUTUMNAL_EQUINOX_DAY: Record<number, number> = {
  2022: 23, 2023: 23, 2024: 22, 2025: 23, 2026: 23, 2027: 23,
  2028: 22, 2029: 23, 2030: 23, 2031: 23, 2032: 22, 2033: 23,
  2034: 23, 2035: 23,
};

function epochOfUtc(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day) / MS_PER_DAY;
}

/** Epoch day of the nth Monday of a month (Happy Monday system). */
function nthMonday(year: number, month: number, nth: number): number {
  const first = epochOfUtc(year, month, 1);
  const dowOfFirst = new Date(first * MS_PER_DAY).getUTCDay(); // 0 = Sunday
  const firstMonday = 1 + ((1 - dowOfFirst + 7) % 7);
  return first + (firstMonday - 1) + (nth - 1) * 7;
}

/** Computed holiday sets per year (deterministic — cache is invisible). */
const holidaysByYear = new Map<number, Set<number>>();

/** All non-working Japanese public holidays of one year as epoch days. */
export function japanHolidaysOf(year: number): Set<number> {
  const cached = holidaysByYear.get(year);
  if (cached !== undefined) return cached;

  const base: number[] = [
    epochOfUtc(year, 1, 1), // New Year's Day
    nthMonday(year, 1, 2), // Coming of Age Day
    epochOfUtc(year, 2, 11), // Foundation Day
    epochOfUtc(year, 2, 23), // Emperor's Birthday
    epochOfUtc(year, 3, VERNAL_EQUINOX_DAY[year] ?? 20), // Vernal Equinox
    epochOfUtc(year, 4, 29), // Showa Day
    epochOfUtc(year, 5, 3), // Constitution Memorial Day
    epochOfUtc(year, 5, 4), // Greenery Day
    epochOfUtc(year, 5, 5), // Children's Day
    nthMonday(year, 7, 3), // Marine Day
    epochOfUtc(year, 8, 11), // Mountain Day
    nthMonday(year, 9, 3), // Respect for the Aged Day
    epochOfUtc(year, 9, AUTUMNAL_EQUINOX_DAY[year] ?? 23), // Autumnal Equinox
    nthMonday(year, 10, 2), // Sports Day
    epochOfUtc(year, 11, 3), // Culture Day
    epochOfUtc(year, 11, 23), // Labour Thanksgiving Day
  ];
  const holidays = new Set(base);

  // 国民の休日: a weekday between two holidays becomes a holiday itself.
  for (const day of base) {
    const between = day - 1;
    if (
      !holidays.has(between) &&
      holidays.has(day - 2) &&
      holidays.has(day) &&
      !isWeekend(between)
    ) {
      holidays.add(between);
    }
  }

  // 振替休日: a holiday falling on Sunday shifts the day off to the next
  // day that is neither a holiday nor a Sunday.
  for (const day of [...holidays]) {
    if (new Date(day * MS_PER_DAY).getUTCDay() !== 0) continue;
    let cursor = day + 1;
    while (holidays.has(cursor) || new Date(cursor * MS_PER_DAY).getUTCDay() === 0) cursor += 1;
    holidays.add(cursor);
  }

  holidaysByYear.set(year, holidays);
  return holidays;
}

/** Saturday or Sunday. */
export function isWeekend(epochDay: number): boolean {
  const dow = new Date(epochDay * MS_PER_DAY).getUTCDay();
  return dow === 0 || dow === 6;
}

/** Japanese public holiday (incl. substitute and sandwich holidays). */
export function isJapanHoliday(epochDay: number): boolean {
  const year = new Date(epochDay * MS_PER_DAY).getUTCFullYear();
  return japanHolidaysOf(year).has(epochDay);
}

/** Weekend or Japanese public holiday — never a working day. */
export function isNonWorkingCalendarDay(epochDay: number): boolean {
  return isWeekend(epochDay) || isJapanHoliday(epochDay);
}

/** Date-string variant; invalid dates return false (parse errors surface elsewhere). */
export function isNonWorkingDate(date: string): boolean {
  const epoch = parseDate(date);
  return epoch !== null && isNonWorkingCalendarDay(epoch);
}

/** The next business day strictly after `epochDay` (bounded defensively at ~1.5 years). */
export function nextBusinessDayEpoch(epochDay: number): number {
  let cursor = epochDay + 1;
  for (let guard = 0; guard < 550; guard++) {
    if (!isNonWorkingCalendarDay(cursor)) return cursor;
    cursor += 1;
  }
  return cursor;
}

/**
 * Business-day check for a "YYYY-MM-DD" string: weekends and Japanese
 * public holidays are always excluded, plus any extra (e.g. company)
 * holidays from the caller's list.
 */
export function isBusinessDate(date: string, extraHolidays: readonly string[] = []): boolean {
  if (isNonWorkingDate(date)) return false;
  return !extraHolidays.includes(date);
}

/** Convenience for tests / display: the holiday as "YYYY-MM-DD" strings of a year. */
export function japanHolidayDatesOf(year: number): string[] {
  return [...japanHolidaysOf(year)].sort().map((epoch) => formatDate(epoch));
}

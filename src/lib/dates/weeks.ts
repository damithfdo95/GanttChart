import { addDays, formatDate, parseDate } from './dates';

/**
 * ISO-8601 week helpers (pure; no clock, no browser APIs). A week runs
 * Monday → Sunday; week 1 is the week containing the first Thursday of the
 * year. Dates are "YYYY-MM-DD" strings and epoch-day numbers, matching the
 * rest of the date library (UTC-anchored, deterministic).
 */

const MS_PER_DAY = 86_400_000;

/** ISO week key "YYYY-Www" (e.g. "2026-W37"). */
export type IsoWeekKey = string;

/**
 * The ISO week number (1–53) of a UTC epoch day, per ISO-8601: the week
 * containing the first Thursday of the year is week 1.
 */
export function isoWeekNumber(epochDays: number): number {
  const d = new Date(epochDays * MS_PER_DAY);
  // Thursday of the current week (ISO weeks start Monday).
  const thursday = addDays(epochDays, 3 - ((d.getUTCDay() + 6) % 7));
  const thursdayDate = new Date(thursday * MS_PER_DAY);
  const thursdayYear = thursdayDate.getUTCFullYear();
  // Day-of-year of that Thursday (1-based).
  const startOfYear = Date.UTC(thursdayYear, 0, 1) / MS_PER_DAY;
  const dayOfYear = thursday - startOfYear + 1;
  return Math.ceil(dayOfYear / 7);
}

/** The ISO week year of a UTC epoch day (may differ from the calendar year). */
export function isoWeekYear(epochDays: number): number {
  const d = new Date(epochDays * MS_PER_DAY);
  const thursday = addDays(epochDays, 3 - ((d.getUTCDay() + 6) % 7));
  return new Date(thursday * MS_PER_DAY).getUTCFullYear();
}

/** The ISO week key "YYYY-Www" of a "YYYY-MM-DD" date string ('' when invalid). */
export function isoWeekKey(date: string): IsoWeekKey {
  const epoch = parseDate(date);
  if (epoch === null) return '';
  const year = isoWeekYear(epoch);
  const week = isoWeekNumber(epoch);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** The Monday (start) of the ISO week containing the given epoch day. */
export function isoWeekStart(epochDays: number): number {
  const d = new Date(epochDays * MS_PER_DAY);
  const mondayOffset = (d.getUTCDay() + 6) % 7; // 0 = Monday … 6 = Sunday
  return addDays(epochDays, -mondayOffset);
}

/**
 * The inclusive Monday→Sunday range of the ISO week containing `date`
 * ("YYYY-MM-DD"). Returns null when the date is invalid.
 */
export function getIsoWeekRange(date: string): { start: string; end: string } | null {
  const epoch = parseDate(date);
  if (epoch === null) return null;
  const monday = isoWeekStart(epoch);
  return { start: formatDate(monday), end: formatDate(addDays(monday, 6)) };
}

/**
 * The inclusive Monday→Sunday range of the ISO week (year, weekNumber).
 * Returns null when the week number is out of range (1–53).
 */
export function getIsoWeekRangeByNumber(year: number, weekNumber: number): { start: string; end: string } | null {
  if (weekNumber < 1 || weekNumber > 53) return null;
  // Jan 4 is always in week 1 (it is the first week containing a Thursday).
  const jan4 = Date.UTC(year, 0, 4) / MS_PER_DAY;
  const mondayOfWeek1 = isoWeekStart(jan4);
  const monday = addDays(mondayOfWeek1, (weekNumber - 1) * 7);
  return { start: formatDate(monday), end: formatDate(addDays(monday, 6)) };
}

/** The ISO week key of a (year, weekNumber) pair; '' when out of range. */
export function isoWeekKeyOf(year: number, weekNumber: number): IsoWeekKey {
  const range = getIsoWeekRangeByNumber(year, weekNumber);
  return range === null ? '' : isoWeekKey(range.start);
}
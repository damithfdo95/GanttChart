import type { Language } from '../../types';
import { pad2 } from '../formatting/format';

/**
 * Pure date helpers for multi-day planning (V2 §5). Dates are "YYYY-MM-DD"
 * strings; internally they are UTC epoch-day numbers so arithmetic is
 * deterministic and free of timezone/DST effects. Built on native Date only —
 * no calendar libraries, fully offline.
 */

const MS_PER_DAY = 86_400_000;

/** Default application timezone (dates and "today" are anchored here). */
export const DEFAULT_TIME_ZONE = 'Asia/Tokyo';

/** "YYYY-MM-DD" → UTC epoch day number; null when malformed or not a real calendar date. */
export function parseDate(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return null;
  // Day 0 of the following month is the last day of this month.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return null;
  return Math.floor(Date.UTC(year, month - 1, day) / MS_PER_DAY);
}

/** UTC epoch day number → "YYYY-MM-DD". */
export function formatDate(epochDays: number): string {
  const d = new Date(epochDays * MS_PER_DAY);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function addDays(epochDays: number, days: number): number {
  return epochDays + days;
}

/**
 * Today's date in the default timezone (Asia/Tokyo) as an epoch day number.
 * Impure (reads the clock) — used only at the UI/storage boundary,
 * never inside calculation functions.
 */
export function todayEpochDays(): number {
  try {
    // en-CA with 2-digit fields yields "YYYY-MM-DD" in the target timezone.
    const ymd = new Intl.DateTimeFormat('en-CA', {
      timeZone: DEFAULT_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const epoch = parseDate(ymd);
    if (epoch !== null) return epoch;
  } catch {
    // fall through to the local-clock fallback
  }
  const now = new Date();
  return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / MS_PER_DAY);
}

/**
 * Minutes since midnight (fractional, seconds included) of `at` in the
 * default timezone (Asia/Tokyo) — the time-of-day counterpart of
 * todayEpochDays(), so "today" and "now" always describe the same moment
 * regardless of the machine's timezone. Impure only through its default
 * argument; used at the UI boundary.
 */
export function nowMinutesOfDay(at: Date = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: DEFAULT_TIME_ZONE,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at);
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
    const hour = get('hour') % 24;
    const minute = get('minute');
    const second = get('second');
    if (Number.isFinite(hour) && Number.isFinite(minute) && Number.isFinite(second)) {
      return hour * 60 + minute + second / 60;
    }
  } catch {
    // fall through to the local-clock fallback
  }
  return at.getHours() * 60 + at.getMinutes() + at.getSeconds() / 60;
}

/** Short weekday name via built-in Intl (offline); deterministic UTC. */
export function weekdayShort(epochDays: number, lang: Language): string {
  const d = new Date(epochDays * MS_PER_DAY);
  return new Intl.DateTimeFormat(lang === 'ja' ? 'ja-JP' : 'en-US', {
    weekday: 'short',
    timeZone: 'UTC',
  }).format(d);
}

/**
 * Locale-aware display date. English: "Oct 5, 2026 (Thu)".
 * Japanese: "2026年10月5日（木）". Deterministic UTC — no timezone drift.
 */
export function formatDateDisplay(epochDays: number, lang: Language): string {
  const d = new Date(epochDays * MS_PER_DAY);
  const weekday = weekdayShort(epochDays, lang);
  if (lang === 'ja') {
    return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日（${weekday}）`;
  }
  const date = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(d);
  return `${date} (${weekday})`;
}

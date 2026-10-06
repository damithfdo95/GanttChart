import { afterEach, describe, expect, it, vi } from 'vitest';
import { addDays, formatDate, formatDateDisplay, nowMinutesOfDay, parseDate, todayEpochDays, weekdayShort } from '../lib/dates/dates';

describe('parseDate', () => {
  it('parses valid YYYY-MM-DD dates', () => {
    expect(parseDate('2026-09-17')).not.toBeNull();
    expect(parseDate('2024-02-29')).not.toBeNull(); // leap year
    expect(parseDate('2000-01-01')).not.toBeNull();
  });

  it('rejects malformed strings', () => {
    expect(parseDate('2026-9-17')).toBeNull(); // missing zero padding
    expect(parseDate('17/09/2026')).toBeNull();
    expect(parseDate('')).toBeNull();
    expect(parseDate('abc')).toBeNull();
    expect(parseDate('2026-09-17T00:00')).toBeNull();
  });

  it('rejects non-existent calendar dates', () => {
    expect(parseDate('2026-13-01')).toBeNull(); // month out of range
    expect(parseDate('2026-00-10')).toBeNull();
    expect(parseDate('2026-09-31')).toBeNull(); // September has 30 days
    expect(parseDate('2026-02-30')).toBeNull();
    expect(parseDate('2026-02-29')).toBeNull(); // 2026 is not a leap year
    expect(parseDate('2026-09-00')).toBeNull();
  });

  it('orders dates numerically', () => {
    expect(parseDate('2026-09-17')!).toBeGreaterThan(parseDate('2026-09-16')!);
    expect(parseDate('2027-01-01')!).toBeGreaterThan(parseDate('2026-12-31')!);
  });
});

describe('formatDate', () => {
  it('round-trips with parseDate', () => {
    for (const date of ['2026-09-17', '2024-02-29', '1999-12-31', '2000-06-15']) {
      expect(formatDate(parseDate(date)!)).toBe(date);
    }
  });
});

describe('addDays', () => {
  it('rolls over months and years deterministically', () => {
    expect(formatDate(addDays(parseDate('2026-09-30')!, 1))).toBe('2026-10-01');
    expect(formatDate(addDays(parseDate('2026-12-31')!, 1))).toBe('2027-01-01');
    expect(formatDate(addDays(parseDate('2024-02-28')!, 1))).toBe('2024-02-29');
    expect(formatDate(addDays(parseDate('2026-02-28')!, 1))).toBe('2026-03-01');
  });
});

describe('weekdayShort / formatDateDisplay', () => {
  it('returns deterministic weekday names via built-in Intl (offline)', () => {
    expect(weekdayShort(parseDate('1970-01-01')!, 'en')).toBe('Thu'); // Unix epoch
    expect(weekdayShort(parseDate('2024-01-01')!, 'en')).toBe('Mon');
    expect(weekdayShort(parseDate('2026-09-17')!, 'en')).toBe('Thu');
    expect(weekdayShort(parseDate('1970-01-01')!, 'ja')).toBe('木');
  });

  it('formatDateDisplay is locale-aware (en: "Oct 5, 2026", ja: "2026年10月5日")', () => {
    expect(formatDateDisplay(parseDate('2026-10-05')!, 'en')).toBe('Oct 5, 2026 (Mon)');
    expect(formatDateDisplay(parseDate('2026-10-05')!, 'ja')).toBe('2026年10月5日（月）');
    expect(formatDateDisplay(parseDate('2026-09-17')!, 'en')).toBe('Sep 17, 2026 (Thu)');
  });
});

describe('today/now share the Asia/Tokyo timezone', () => {
  // Node re-reads process.env.TZ on change; accessed via globalThis because
  // the project does not ship Node type definitions.
  const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
  const originalTz = env.TZ;
  afterEach(() => {
    env.TZ = originalTz;
    vi.useRealTimers();
  });

  it('reports the Tokyo date and Tokyo time-of-day on a machine in another timezone', () => {
    for (const tz of ['Asia/Tokyo', 'Asia/Colombo', 'Europe/London', 'America/New_York']) {
      env.TZ = tz;
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-06T16:00:00Z')); // 01:00 JST on Oct 7
      expect(formatDate(todayEpochDays())).toBe('2026-10-07');
      expect(nowMinutesOfDay()).toBe(60);
      vi.useRealTimers();
    }
  });

  it('keeps seconds as a fraction and handles midnight as 0', () => {
    expect(nowMinutesOfDay(new Date('2026-10-06T15:00:30Z'))).toBe(0.5); // 00:00:30 JST
    expect(nowMinutesOfDay(new Date('2026-10-06T08:30:00Z'))).toBe(17 * 60 + 30); // 17:30 JST
  });
});

import { describe, expect, it } from 'vitest';
import {
  coversDate,
  dayAfter,
  dayBefore,
  exclusiveEndOf,
  halfOpenToInclusive,
  inclusiveEndOf,
  inclusiveToHalfOpen,
  isTeamDate,
  periodIntersection,
  periodsOverlap,
} from '../../shared/teamDates';

describe('isTeamDate', () => {
  it('accepts real calendar dates', () => {
    expect(isTeamDate('2026-11-05')).toBe(true);
    expect(isTeamDate('2024-02-29')).toBe(true); // leap year
  });

  it('rejects malformed and impossible dates', () => {
    expect(isTeamDate('2026-13-01')).toBe(false);
    expect(isTeamDate('2026-02-30')).toBe(false);
    expect(isTeamDate('2023-02-29')).toBe(false); // not a leap year
    expect(isTeamDate('2026/11/05')).toBe(false);
    expect(isTeamDate('')).toBe(false);
    expect(isTeamDate(42)).toBe(false);
    expect(isTeamDate(null)).toBe(false);
  });
});

describe('dayBefore / dayAfter', () => {
  it('steps across month and year boundaries', () => {
    expect(dayBefore('2026-12-01')).toBe('2026-11-30');
    expect(dayAfter('2026-11-30')).toBe('2026-12-01');
    expect(dayBefore('2026-01-01')).toBe('2025-12-31');
    expect(dayAfter('2025-12-31')).toBe('2026-01-01');
  });

  it('handles leap days', () => {
    expect(dayBefore('2024-03-01')).toBe('2024-02-29');
    expect(dayAfter('2024-02-28')).toBe('2024-02-29');
    expect(dayAfter('2023-02-28')).toBe('2023-03-01');
  });
});

describe('exclusive/inclusive conversion', () => {
  it('round-trips a period', () => {
    const half = inclusiveToHalfOpen('2026-12-01', '2026-12-14');
    expect(half).toEqual({ start: '2026-12-01', end: '2026-12-15' });
    expect(halfOpenToInclusive(half.start, half.end)).toEqual({ start: '2026-12-01', end: '2026-12-14' });
  });

  it('passes open-ended ends through unchanged', () => {
    expect(exclusiveEndOf(undefined)).toBeUndefined();
    expect(inclusiveEndOf(undefined)).toBeUndefined();
    expect(inclusiveToHalfOpen('2026-01-01', undefined)).toEqual({ start: '2026-01-01', end: undefined });
    expect(halfOpenToInclusive('2026-01-01', undefined)).toEqual({ start: '2026-01-01', end: undefined });
  });

  it('matches the spec example: 1–14 December stored as [12-01, 12-15)', () => {
    expect(exclusiveEndOf('2026-12-14')).toBe('2026-12-15');
    expect(inclusiveEndOf('2026-12-15')).toBe('2026-12-14');
  });
});

describe('coversDate', () => {
  it('includes the start, excludes the end', () => {
    expect(coversDate('2026-12-01', '2026-12-15', '2026-12-01')).toBe(true);
    expect(coversDate('2026-12-01', '2026-12-15', '2026-12-14')).toBe(true);
    expect(coversDate('2026-12-01', '2026-12-15', '2026-12-15')).toBe(false);
    expect(coversDate('2026-12-01', '2026-12-15', '2026-11-30')).toBe(false);
  });

  it('treats an undefined end as open-ended', () => {
    expect(coversDate('2026-01-01', undefined, '2099-01-01')).toBe(true);
    expect(coversDate('2026-01-01', undefined, '2025-12-31')).toBe(false);
  });
});

describe('periodsOverlap', () => {
  it('detects overlap and adjacency', () => {
    expect(periodsOverlap('2026-12-01', '2026-12-15', '2026-12-10', '2027-01-01')).toBe(true);
    expect(periodsOverlap('2026-12-01', '2026-12-15', '2026-12-15', '2027-01-01')).toBe(false); // adjacent, not overlapping
    expect(periodsOverlap('2026-12-01', undefined, '2027-06-01', '2027-07-01')).toBe(true); // open-ended
    expect(periodsOverlap('2026-12-01', '2026-12-15', '2026-11-01', '2026-12-01')).toBe(false);
  });
});

describe('periodIntersection', () => {
  it('returns the overlapping part', () => {
    expect(periodIntersection('2026-12-01', '2026-12-15', '2026-12-10', undefined)).toEqual({ start: '2026-12-10', end: '2026-12-15' });
  });

  it('returns null when disjoint', () => {
    expect(periodIntersection('2026-12-01', '2026-12-15', '2026-12-15', '2027-01-01')).toBeNull();
  });

  it('keeps an open end open', () => {
    expect(periodIntersection('2026-12-01', undefined, '2026-12-01', undefined)).toEqual({ start: '2026-12-01', end: undefined });
  });
});

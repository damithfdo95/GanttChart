import { describe, expect, it } from 'vitest';
import {
  calculateProductiveHours,
  calculateRequiredHours,
  calculateRequiredTesters,
  calculateTeamCapacity,
  lunchOverlapMinutes,
  overlapMinutes,
} from '../lib/calculations/capacity';

const LUNCH = { start: 12 * 60, end: 13 * 60 };

describe('calculateTeamCapacity (§10)', () => {
  it('8 testers × 4 cases/h = 32 cases/h', () => {
    expect(calculateTeamCapacity(8, 4)).toBe(32);
  });

  it('4 testers × 4 cases/h = 16 cases/h', () => {
    expect(calculateTeamCapacity(4, 4)).toBe(16);
  });
});

describe('overlapMinutes', () => {
  it('partial overlap counts only the intersection', () => {
    expect(overlapMinutes(11 * 60, 13 * 60, 12 * 60, 14 * 60)).toBe(60);
  });

  it('no overlap returns 0', () => {
    expect(overlapMinutes(13 * 60, 15 * 60, 11 * 60, 12 * 60)).toBe(0);
  });

  it('lunch fully inside window counts fully', () => {
    expect(lunchOverlapMinutes(9 * 60, 17 * 60, LUNCH)).toBe(60);
  });

  it('lunch fully outside window counts 0', () => {
    expect(lunchOverlapMinutes(13 * 60, 17 * 60, LUNCH)).toBe(0);
  });
});

describe('calculateProductiveHours (lunch deduction)', () => {
  it('09:00–17:30 with 1h lunch = 7.5h', () => {
    expect(calculateProductiveHours(9 * 60, 17 * 60 + 30, LUNCH)).toBe(7.5);
  });

  it('window not overlapping lunch is not reduced', () => {
    expect(calculateProductiveHours(13 * 60, 17 * 60, LUNCH)).toBe(4);
  });

  it('returns 0 when end <= start', () => {
    expect(calculateProductiveHours(10 * 60, 9 * 60, LUNCH)).toBe(0);
    expect(calculateProductiveHours(9 * 60, 9 * 60, LUNCH)).toBe(0);
  });
});

describe('calculateRequiredHours (§12)', () => {
  it('36 cases / 32 per hour = 1.125 hours', () => {
    expect(calculateRequiredHours(36, 32)).toBe(1.125);
  });

  it('returns null for zero capacity (no division by zero)', () => {
    expect(calculateRequiredHours(36, 0)).toBeNull();
  });
});

describe('calculateRequiredTesters (§11 rounding)', () => {
  it('36 / (4 × 4) = 2.25 → 3 testers', () => {
    expect(calculateRequiredTesters(36, 4, 4)).toBe(3);
  });

  it('exact fit does not round up', () => {
    // 32 / (4 × 2) = 4 exactly
    expect(calculateRequiredTesters(32, 4, 2)).toBe(4);
  });

  it('one case over the boundary rounds up', () => {
    // 33 / (4 × 2) = 4.125 → 5
    expect(calculateRequiredTesters(33, 4, 2)).toBe(5);
  });

  it('returns null when the window has no productive time', () => {
    expect(calculateRequiredTesters(36, 4, 0)).toBeNull();
  });
});

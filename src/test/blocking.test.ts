import { describe, expect, it } from 'vitest';
import type { BlockingEvent } from '../types';
import {
  calculateAvailableCapacityCases,
  calculateEffectiveElapsedMinutes,
  calculateLostCapacityCases,
  calculateTesterUtilization,
  sumBlockingMinutes,
  sumBlockingMinutesByCategory,
} from '../lib/calculations/blocking';

function event(date: string, category: BlockingEvent['category'], minutes: number, id = date + category): BlockingEvent {
  return { id, date, category, minutes, note: '' };
}

describe('sumBlockingMinutes', () => {
  const events = [event('2026-09-29', 'BUILD', 30, 'e1'), event('2026-09-29', 'ENVIRONMENT', 45, 'e2'), event('2026-09-28', 'BUILD', 60, 'e3')];

  it('totals all events', () => {
    expect(sumBlockingMinutes(events)).toBe(135);
  });

  it('filters by date', () => {
    expect(sumBlockingMinutes(events, '2026-09-29')).toBe(75);
    expect(sumBlockingMinutes(events, '2026-09-30')).toBe(0);
  });

  it('ignores negative minutes defensively', () => {
    expect(sumBlockingMinutes([event('2026-09-29', 'OTHER', -10, 'neg')])).toBe(0);
  });
});

describe('sumBlockingMinutesByCategory', () => {
  it('groups by category with a date scope', () => {
    const events = [event('2026-09-29', 'BUILD', 30, 'e1'), event('2026-09-29', 'ENVIRONMENT', 45, 'e2'), event('2026-09-28', 'BUILD', 60, 'e3')];
    const byCategory = sumBlockingMinutesByCategory(events, '2026-09-29');
    expect(byCategory.BUILD).toBe(30);
    expect(byCategory.ENVIRONMENT).toBe(45);
    expect(byCategory.TEST_DATA).toBe(0);
    expect(byCategory.REQUIREMENT).toBe(0);
    expect(byCategory.SYSTEM_ISSUE).toBe(0);
    expect(byCategory.OTHER).toBe(0);
  });

  it('totals per category across all dates when unscoped', () => {
    const byCategory = sumBlockingMinutesByCategory([event('2026-09-29', 'BUILD', 30, 'e1'), event('2026-09-28', 'BUILD', 60, 'e3')]);
    expect(byCategory.BUILD).toBe(90);
  });
});

describe('effective QA time', () => {
  it('subtracts unavailable time from productive elapsed time', () => {
    expect(calculateEffectiveElapsedMinutes(240, 75)).toBe(165);
  });

  it('clamps at zero when unavailable exceeds elapsed', () => {
    expect(calculateEffectiveElapsedMinutes(100, 300)).toBe(0);
  });

  it('returns 0 before start', () => {
    expect(calculateEffectiveElapsedMinutes(0, 30)).toBe(0);
  });
});

describe('lost and available capacity', () => {
  it('lost capacity = unavailable hours × team hourly capacity', () => {
    expect(calculateLostCapacityCases(60, 32)).toBeCloseTo(32, 10);
    expect(calculateLostCapacityCases(30, 8)).toBeCloseTo(4, 10);
  });

  it('available capacity = effective hours × team hourly capacity', () => {
    expect(calculateAvailableCapacityCases(120, 32)).toBeCloseTo(64, 10);
  });

  it('zero unavailable time or capacity yields 0', () => {
    expect(calculateLostCapacityCases(0, 32)).toBe(0);
    expect(calculateLostCapacityCases(60, 0)).toBe(0);
    expect(calculateAvailableCapacityCases(0, 32)).toBe(0);
  });
});

describe('calculateTesterUtilization', () => {
  it('is the unblocked share of productive time', () => {
    expect(calculateTesterUtilization(240, 60)).toBeCloseTo(0.75, 10);
  });

  it('is null with zero elapsed time (no division by zero)', () => {
    expect(calculateTesterUtilization(0, 60)).toBeNull();
  });

  it('clamps to 0 when fully blocked and 1 when unblocked', () => {
    expect(calculateTesterUtilization(240, 240)).toBe(0);
    expect(calculateTesterUtilization(240, 0)).toBe(1);
  });
});

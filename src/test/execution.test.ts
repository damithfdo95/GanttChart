import { describe, expect, it } from 'vitest';
import {
  calculateActualRate,
  calculateProjectedActualFinish,
  calculateScheduleVariance,
} from '../lib/calculations/execution';

const LUNCH = { start: 12 * 60, end: 13 * 60 };

describe('calculateActualRate (§15)', () => {
  it('completed cases / productive elapsed hours', () => {
    expect(calculateActualRate(48, 3)).toBe(16);
  });

  it('zero completed still yields a rate when time has elapsed', () => {
    expect(calculateActualRate(0, 3)).toBe(0);
  });

  it('returns null with zero elapsed time (no division by zero)', () => {
    expect(calculateActualRate(10, 0)).toBeNull();
  });
});

describe('calculateProjectedActualFinish', () => {
  it('projects from now using the actual rate, skipping lunch', () => {
    // now 11:00, 45 remaining at 30/h → 90 productive minutes → 13:30
    expect(calculateProjectedActualFinish(11 * 60, 45, 30, LUNCH)).toBe(13 * 60 + 30);
  });

  it('no lunch skip when work stays before lunch', () => {
    // now 11:00, 30 remaining at 60/h → 30 minutes → 11:30
    expect(calculateProjectedActualFinish(11 * 60, 30, 60, LUNCH)).toBe(11 * 60 + 30);
  });

  it('returns null when the rate is unavailable', () => {
    expect(calculateProjectedActualFinish(11 * 60, 45, null, LUNCH)).toBeNull();
  });

  it('returns null when nothing remains', () => {
    expect(calculateProjectedActualFinish(11 * 60, 0, 30, LUNCH)).toBeNull();
  });
});

describe('calculateScheduleVariance', () => {
  it('positive when projected to finish ahead of target', () => {
    expect(calculateScheduleVariance(15 * 60, 17 * 60)).toBe(120);
  });

  it('negative when projected to finish after target', () => {
    expect(calculateScheduleVariance(17 * 60 + 42, 17 * 60)).toBe(-42);
  });

  it('null when no projection is available', () => {
    expect(calculateScheduleVariance(null, 17 * 60)).toBeNull();
  });
});

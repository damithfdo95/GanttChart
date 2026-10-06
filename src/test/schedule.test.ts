import { describe, expect, it } from 'vitest';
import {
  calculateBuffer,
  calculateExpectedFinish,
  calculateExpectedProgress,
  calculateProductiveElapsedTime,
  calculateScheduleStatus,
} from '../lib/calculations/schedule';
import type { QaInputs } from '../types';

const LUNCH = { start: 12 * 60, end: 13 * 60 };

describe('calculateExpectedFinish (§13)', () => {
  it('13:00 + 1.125h → 14:07 (floored display)', () => {
    const finish = calculateExpectedFinish(13 * 60, 1.125 * 60, LUNCH);
    expect(Math.floor(finish)).toBe(14 * 60 + 7);
  });

  it('skips lunch when work overlaps it: 11:30 + 90min → 14:00', () => {
    expect(calculateExpectedFinish(11 * 60 + 30, 90, LUNCH)).toBe(14 * 60);
  });

  it('finishes before lunch without skipping: 11:00 + 30min → 11:30', () => {
    expect(calculateExpectedFinish(11 * 60, 30, LUNCH)).toBe(11 * 60 + 30);
  });

  it('starting inside lunch jumps to lunch end first', () => {
    // 12:30 + 30min → 13:00 + 30min = 13:30
    expect(calculateExpectedFinish(12 * 60 + 30, 30, LUNCH)).toBe(13 * 60 + 30);
  });

  it('starting after lunch does not jump', () => {
    expect(calculateExpectedFinish(14 * 60, 60, LUNCH)).toBe(15 * 60);
  });

  it('can cross midnight (single-day model keeps counting)', () => {
    expect(calculateExpectedFinish(23 * 60, 120, LUNCH)).toBe(25 * 60);
  });
});

describe('calculateProductiveElapsedTime (§14–§15)', () => {
  it('is 0 before start', () => {
    expect(calculateProductiveElapsedTime(8 * 60, 9 * 60, LUNCH)).toBe(0);
  });

  it('is 0 exactly at start', () => {
    expect(calculateProductiveElapsedTime(9 * 60, 9 * 60, LUNCH)).toBe(0);
  });

  it('during lunch, caps at the morning end', () => {
    // now 12:30, start 09:00 → 3h productive (lunch minutes not counted)
    expect(calculateProductiveElapsedTime(12 * 60 + 30, 9 * 60, LUNCH)).toBe(3 * 60);
  });

  it('after lunch, subtracts the full lunch duration', () => {
    // now 14:00, start 09:00 → 5h wall clock − 1h lunch = 4h productive
    expect(calculateProductiveElapsedTime(14 * 60, 9 * 60, LUNCH)).toBe(4 * 60);
  });
});

describe('calculateExpectedProgress', () => {
  it('capacity × elapsed hours', () => {
    expect(calculateExpectedProgress(120, 16, 1)).toBe(16);
  });

  it('capped at total cases', () => {
    expect(calculateExpectedProgress(120, 16, 10)).toBe(120);
  });

  it('0 when there is nothing to do', () => {
    expect(calculateExpectedProgress(0, 16, 1)).toBe(0);
  });
});

describe('calculateScheduleStatus (§16)', () => {
  const base: QaInputs = {
    totalCases: 120,
    currentTesters: 4,
    startTime: 9 * 60,
    targetFinish: 17 * 60 + 30,
    lunchStart: 12 * 60,
    lunchEnd: 13 * 60,
    perHourPerTester: 4,
    casesCompleted: 0,
    // V2 planning fields — irrelevant to the single-day status engine.
    startDate: '2026-09-14',
    targetCompletionDate: null,
    targetCompletionTime: null,
    planningRows: [],
  };

  it('NOT_STARTED before start with no progress', () => {
    expect(calculateScheduleStatus(base, 8 * 60)).toBe('NOT_STARTED');
  });

  it('COMPLETED takes priority over other states', () => {
    const done = { ...base, casesCompleted: 120 };
    // Even deep into the evening, all cases done means COMPLETED.
    expect(calculateScheduleStatus(done, 16 * 60)).toBe('COMPLETED');
  });

  it('COMPLETED when total cases is 0 (nothing to do)', () => {
    expect(calculateScheduleStatus({ ...base, totalCases: 0 }, 10 * 60)).toBe('COMPLETED');
  });

  it('ON_SCHEDULE when within tolerance', () => {
    // 10:00 → 1h elapsed × 16 cases/h = 16 expected; tolerance ≈ 1.33
    expect(calculateScheduleStatus({ ...base, casesCompleted: 16 }, 10 * 60)).toBe('ON_SCHEDULE');
  });

  it('tolerance band prevents flicker between states', () => {
    expect(calculateScheduleStatus({ ...base, casesCompleted: 15 }, 10 * 60)).toBe('ON_SCHEDULE');
    expect(calculateScheduleStatus({ ...base, casesCompleted: 17 }, 10 * 60)).toBe('ON_SCHEDULE');
  });

  it('AHEAD beyond tolerance', () => {
    expect(calculateScheduleStatus({ ...base, casesCompleted: 25 }, 10 * 60)).toBe('AHEAD');
  });

  it('DELAYED beyond tolerance', () => {
    expect(calculateScheduleStatus({ ...base, casesCompleted: 5 }, 10 * 60)).toBe('DELAYED');
  });

  it('progress made before start counts as AHEAD, not NOT_STARTED', () => {
    expect(calculateScheduleStatus({ ...base, casesCompleted: 10 }, 8 * 60)).toBe('AHEAD');
  });

  // Deadline-dominant behavior (deadlineBufferMinutes from the multi-day
  // capacity projection): DELAYED only when the deadline is genuinely at
  // risk; a safe deadline never shows a pace-based red Delayed.
  it('behind pace + negative deadline buffer → DELAYED (deadline at risk)', () => {
    expect(calculateScheduleStatus({ ...base, casesCompleted: 5 }, 10 * 60, undefined, -120)).toBe('DELAYED');
  });

  it('behind pace + positive deadline buffer → ON_SCHEDULE (deadline achievable)', () => {
    expect(calculateScheduleStatus({ ...base, casesCompleted: 5 }, 10 * 60, undefined, 90)).toBe('ON_SCHEDULE');
  });

  it('behind pace + zero deadline buffer → ON_SCHEDULE (exactly on target)', () => {
    expect(calculateScheduleStatus({ ...base, casesCompleted: 5 }, 10 * 60, undefined, 0)).toBe('ON_SCHEDULE');
  });

  it('ahead pace + positive deadline buffer → AHEAD', () => {
    expect(calculateScheduleStatus({ ...base, casesCompleted: 25 }, 10 * 60, undefined, 90)).toBe('AHEAD');
  });

  it('on pace + negative deadline buffer → DELAYED (capacity misses the deadline)', () => {
    expect(calculateScheduleStatus({ ...base, casesCompleted: 16 }, 10 * 60, undefined, -1)).toBe('DELAYED');
  });

  it('behind pace + null deadline buffer → DELAYED (legacy pace behavior, no deadline set)', () => {
    expect(calculateScheduleStatus({ ...base, casesCompleted: 5 }, 10 * 60, undefined, null)).toBe('DELAYED');
  });

  it('behind pace + undefined deadline buffer → DELAYED (legacy pace behavior)', () => {
    expect(calculateScheduleStatus({ ...base, casesCompleted: 5 }, 10 * 60)).toBe('DELAYED');
  });
});

describe('calculateBuffer', () => {
  it('positive buffer: 17:00 − 14:07:30 = 2h 52.5m', () => {
    expect(calculateBuffer(14 * 60 + 7.5, 17 * 60)).toBeCloseTo(172.5);
  });

  it('negative buffer (delay): 17:42 target 17:00 = −42m', () => {
    expect(calculateBuffer(17 * 60 + 42, 17 * 60)).toBe(-42);
  });

  it('zero buffer exactly on target', () => {
    expect(calculateBuffer(17 * 60, 17 * 60)).toBe(0);
  });
});

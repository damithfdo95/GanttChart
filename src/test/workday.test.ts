import { describe, expect, it } from 'vitest';
import type { PlanningRow } from '../types';
import {
  WORK_DAY_END,
  WORK_DAY_START,
  WORK_LUNCH,
  WORK_MINUTES_PER_DAY,
  WORK_PRODUCTIVE_HOURS,
  EXACT_PROJECTION_BUSINESS_DAYS,
  advanceOverWorkDays,
  calculateWorkdayProjection,
  workingEpochDays,
  workdayProductiveHours,
} from '../lib/calculations/workday';
import { parseDate } from '../lib/dates/dates';
import { nextBusinessDayEpoch } from '../lib/dates/businessDays';

// A Monday–Friday week (all business days — no weekend/holiday effects;
// the business-day calendar is covered separately in businessDays.test.ts).
const D1 = '2026-10-05';
const D2 = '2026-10-06';
const D3 = '2026-10-07';
const D4 = '2026-10-08';
const D5 = '2026-10-09';

function row(date: string, nonWorkingDay = false): PlanningRow {
  return { id: `row-${date}`, date, plannedTesters: 8, absentTesters: 0, nonWorkingDay, note: '' };
}

describe('fixed workday constants', () => {
  it('work day is 9:00–17:30 with a 12:00–13:00 lunch', () => {
    expect(WORK_DAY_START).toBe(9 * 60);
    expect(WORK_DAY_END).toBe(17 * 60 + 30);
    expect(WORK_LUNCH).toEqual({ start: 12 * 60, end: 13 * 60 });
  });

  it('yields 7.5 productive hours (450 minutes) per day', () => {
    expect(WORK_MINUTES_PER_DAY).toBe(450);
    expect(WORK_PRODUCTIVE_HOURS).toBe(7.5);
  });
});

describe('plan start time', () => {
  it('shrinks the productive hours of a later start (end and lunch stay fixed)', () => {
    expect(workdayProductiveHours(9 * 60)).toBe(7.5);
    expect(workdayProductiveHours(10 * 60)).toBe(6.5);
    expect(workdayProductiveHours(11 * 60)).toBe(5.5);
    expect(workdayProductiveHours(12 * 60)).toBe(4.5); // lunch consumed first
  });

  it('advances each working day from the plan start time', () => {
    const days = workingEpochDays([row(D1), row(D2)], D1);
    // 10:00 start → 390 productive minutes per day; 420 minutes → day 1 full,
    // 30 remaining on day 2 → 10:30.
    expect(advanceOverWorkDays(420, days, D1, 10 * 60)).toEqual({
      epochDay: parseDate(D2),
      time: 10 * 60 + 30,
    });
  });

  it('reduces capacity and raises required testers for a later plan start', () => {
    const base = {
      totalCases: 240,
      currentTesters: 8,
      perHourPerTester: 4,
      planningRows: [row(D1), row(D2), row(D3)],
      startDate: D1,
      endDate: D3,
    };
    const at9 = calculateWorkdayProjection({ ...base, planStartTime: 9 * 60 });
    const at10 = calculateWorkdayProjection({ ...base, planStartTime: 10 * 60 });
    expect(at9.productiveHours).toBe(22.5);
    expect(at10.productiveHours).toBe(19.5); // 3 days × 6.5h
    expect(at9.requiredTesters).toBe(3); // 240 / (4 × 7.5 × 3) = 2.67
    expect(at10.requiredTesters).toBe(4); // 240 / (4 × 6.5 × 3) = 3.08
    // 240 cases / 32 per hour = 7.5h = 450 min: at 9:00 exactly one day (17:30);
    // at 10:00 the 390-minute day overflows into day 2 (10:00 + 60 min).
    expect(at9.expectedFinish).toEqual({ epochDay: parseDate(D1), time: WORK_DAY_END });
    expect(at10.expectedFinish).toEqual({ epochDay: parseDate(D2), time: 11 * 60 });
  });

  it('defaults to the fixed 9:00 start when no plan start is given', () => {
    const result = calculateWorkdayProjection({
      totalCases: 240,
      currentTesters: 8,
      perHourPerTester: 4,
      planningRows: [row(D1)],
      startDate: D1,
      endDate: D1,
    });
    expect(result.productiveHours).toBe(7.5);
    expect(result.expectedFinish).toEqual({ epochDay: parseDate(D1), time: WORK_DAY_END });
  });
});

describe('workingEpochDays', () => {
  it('lists working rows on/after the start date in order', () => {
    const days = workingEpochDays([row(D1), row(D2), row(D3)], D1);
    expect(days).toEqual([parseDate(D1), parseDate(D2), parseDate(D3)]);
  });

  it('skips non-working days and rows before the start date', () => {
    const days = workingEpochDays([row(D1), row(D2, true), row(D3)], D2);
    expect(days).toEqual([parseDate(D3)]);
  });
});

describe('advanceOverWorkDays', () => {
  const days = workingEpochDays([row(D1), row(D2), row(D3)], D1);

  it('finishes intraday on the first day, skipping lunch', () => {
    // 5 productive hours: 9:00–12:00 + 13:00–15:00.
    expect(advanceOverWorkDays(5 * 60, days, D1)).toEqual({ epochDay: parseDate(D1), time: 15 * 60 });
  });

  it('wraps to the next working day when the day is full', () => {
    // Day 1 is fully consumed; the remaining 60 minutes run 9:00–10:00 on day 2.
    expect(advanceOverWorkDays(WORK_MINUTES_PER_DAY + 60, days, D1)).toEqual({
      epochDay: parseDate(D2),
      time: 10 * 60,
    });
  });

  it('ends exactly at 17:30 when a day is exactly full', () => {
    expect(advanceOverWorkDays(WORK_MINUTES_PER_DAY, days, D1)).toEqual({
      epochDay: parseDate(D1),
      time: WORK_DAY_END,
    });
  });

  it('continues on consecutive business days beyond the listed rows', () => {
    expect(advanceOverWorkDays(3 * WORK_MINUTES_PER_DAY + 30, days, D1)).toEqual({
      epochDay: parseDate(D4),
      time: 9 * 60 + 30,
    });
  });

  it('returns 9:00 on the start date when no work is required', () => {
    expect(advanceOverWorkDays(0, days, D1)).toEqual({ epochDay: parseDate(D1), time: WORK_DAY_START });
  });

  it('returns null when work remains but no working day exists', () => {
    expect(advanceOverWorkDays(60, [], D1)).toBeNull();
  });
});

describe('calculateWorkdayProjection', () => {
  it('computes required minutes, expected finish, buffer and testers between start and end dates', () => {
    // 8 testers × 4 cases/h = 32/h; 240 cases → 7.5h = 450 min → exactly day 1.
    const result = calculateWorkdayProjection({
      totalCases: 240,
      currentTesters: 8,
      perHourPerTester: 4,
      planningRows: [row(D1), row(D2), row(D3)],
      startDate: D1,
      endDate: D3,
    });
    expect(result.requiredMinutes).toBe(450);
    expect(result.expectedFinish).toEqual({ epochDay: parseDate(D1), time: WORK_DAY_END });
    expect(result.workingDaysToTarget).toBe(3);
    expect(result.productiveHours).toBe(22.5);
    expect(result.bufferMinutes).toBe(2 * 1440); // two full days of slack
    expect(result.requiredTesters).toBe(3); // 240 / (4 × 7.5 × 3) = 2.67 → 3
  });

  it('spans multiple working days and reports a negative buffer when overrun', () => {
    // 32/h × 7.5h = 240/day; 480 cases → 2 full days → finish 17:30 on day 2.
    const result = calculateWorkdayProjection({
      totalCases: 480,
      currentTesters: 8,
      perHourPerTester: 4,
      planningRows: [row(D1), row(D2, true), row(D3)],
      startDate: D1,
      endDate: D3,
    });
    expect(result.expectedFinish).toEqual({ epochDay: parseDate(D3), time: WORK_DAY_END });
    // End date D3 17:30 vs finish D3 17:30 → zero buffer.
    expect(result.bufferMinutes).toBe(0);
    expect(result.requiredTesters).toBe(8);
  });

  it('excludes non-working days between start and end', () => {
    const result = calculateWorkdayProjection({
      totalCases: 60,
      currentTesters: 8,
      perHourPerTester: 4,
      planningRows: [row(D1), row(D2, true), row(D3)],
      startDate: D1,
      endDate: D3,
    });
    expect(result.workingDaysToTarget).toBe(2);
    expect(result.productiveHours).toBe(15);
  });

  it('returns nulls when there is no end date', () => {
    const result = calculateWorkdayProjection({
      totalCases: 60,
      currentTesters: 8,
      perHourPerTester: 4,
      planningRows: [row(D1)],
      startDate: D1,
      endDate: null,
    });
    expect(result.workingDaysToTarget).toBeNull();
    expect(result.productiveHours).toBeNull();
    expect(result.bufferMinutes).toBeNull();
    expect(result.requiredTesters).toBeNull();
    expect(result.requiredMinutes).toBe(112.5);
    expect(result.expectedFinish).toEqual({ epochDay: parseDate(D1), time: 10 * 60 + 52.5 });
  });

  it('returns null required minutes when capacity is not positive', () => {
    const result = calculateWorkdayProjection({
      totalCases: 60,
      currentTesters: 0,
      perHourPerTester: 4,
      planningRows: [row(D1)],
      startDate: D1,
      endDate: D1,
    });
    expect(result.requiredMinutes).toBeNull();
    expect(result.expectedFinish).toBeNull();
  });

  it('requires zero testers when there is nothing to do', () => {
    const result = calculateWorkdayProjection({
      totalCases: 0,
      currentTesters: 8,
      perHourPerTester: 4,
      planningRows: [row(D1), row(D2)],
      startDate: D1,
      endDate: D2,
    });
    expect(result.requiredTesters).toBe(0);
    expect(result.expectedFinish).toEqual({ epochDay: parseDate(D1), time: WORK_DAY_START });
  });
});

describe('remaining-work projection from NOW (anchored)', () => {
  const rows = [row(D1), row(D2), row(D3)];

  it('counts only the remaining cases (completed work is not re-planned)', () => {
    const result = calculateWorkdayProjection({
      totalCases: 240,
      casesCompleted: 160,
      currentTesters: 8,
      perHourPerTester: 4,
      planningRows: rows,
      startDate: D1,
      endDate: D3,
      planStartTime: 9 * 60,
    });
    // 80 remaining / 32 per hour = 150 min → D1 11:30 (through the lunch rule: 9:00 + 150 = 11:30).
    expect(result.requiredMinutes).toBe(150);
    expect(result.expectedFinish).toEqual({ epochDay: parseDate(D1), time: 11 * 60 + 30 });
    expect(result.requiredTesters).toBe(1); // 80 / (4 × 22.5) = 0.89
  });

  it('anchors at today: finishes never land in the past', () => {
    const result = calculateWorkdayProjection({
      totalCases: 240,
      casesCompleted: 160, // 80 remaining → 150 productive minutes
      currentTesters: 8,
      perHourPerTester: 4,
      planningRows: rows,
      startDate: D1,
      endDate: D3,
      planStartTime: 9 * 60,
      anchor: { epochDay: parseDate(D2) ?? 0, timeOfDay: 10 * 60 },
    });
    // From D2 10:00: 150 min → 12:00 (120), lunch, 13:00 + 30 → 13:30 — NOT D1 11:30.
    expect(result.expectedFinish).toEqual({ epochDay: parseDate(D2), time: 13 * 60 + 30 });
    // The window excludes past days: D2 counts only its remaining 6.5h, D3 full 7.5h.
    expect(result.workingDaysToTarget).toBe(2);
    expect(result.productiveHours).toBeCloseTo(14, 10);
    expect(result.requiredTesters).toBe(2); // ceil(80 / (4 × 14))
  });

  it('an anchor past the 17:30 work end rolls to the next working day', () => {
    const result = calculateWorkdayProjection({
      totalCases: 240,
      casesCompleted: 160,
      currentTesters: 8,
      perHourPerTester: 4,
      planningRows: rows,
      startDate: D1,
      endDate: D3,
      planStartTime: 9 * 60,
      anchor: { epochDay: parseDate(D1) ?? 0, timeOfDay: 18 * 60 },
    });
    expect(result.expectedFinish).toEqual({ epochDay: parseDate(D2), time: 11 * 60 + 30 });
    expect(result.workingDaysToTarget).toBe(2); // D1 has no time left
  });

  it('an anchor before the work start uses the full anchor day', () => {
    const result = calculateWorkdayProjection({
      totalCases: 240,
      casesCompleted: 160,
      currentTesters: 8,
      perHourPerTester: 4,
      planningRows: rows,
      startDate: D1,
      endDate: D3,
      planStartTime: 9 * 60,
      anchor: { epochDay: parseDate(D1) ?? 0, timeOfDay: 7 * 60 },
    });
    expect(result.expectedFinish).toEqual({ epochDay: parseDate(D1), time: 11 * 60 + 30 });
    expect(result.productiveHours).toBeCloseTo(22.5, 10);
  });

  it('an anchor on a non-working day starts at the next working day', () => {
    const offRows = [row(D1), row(D2, true), row(D3)];
    const result = calculateWorkdayProjection({
      totalCases: 240,
      casesCompleted: 160,
      currentTesters: 8,
      perHourPerTester: 4,
      planningRows: offRows,
      startDate: D1,
      endDate: D3,
      planStartTime: 9 * 60,
      anchor: { epochDay: parseDate(D2) ?? 0, timeOfDay: 10 * 60 },
    });
    expect(result.expectedFinish).toEqual({ epochDay: parseDate(D3), time: 11 * 60 + 30 });
    expect(result.workingDaysToTarget).toBe(1); // only D3 remains in the window
  });

  it('zero remaining work finishes at the anchor (now)', () => {
    const result = calculateWorkdayProjection({
      totalCases: 240,
      casesCompleted: 240,
      currentTesters: 8,
      perHourPerTester: 4,
      planningRows: rows,
      startDate: D1,
      endDate: D3,
      planStartTime: 9 * 60,
      anchor: { epochDay: parseDate(D2) ?? 0, timeOfDay: 14 * 60 },
    });
    expect(result.requiredMinutes).toBe(0);
    expect(result.expectedFinish).toEqual({ epochDay: parseDate(D2), time: 14 * 60 });
    expect(result.requiredTesters).toBe(0);
  });

  it('an anchor after all listed working days extends past the plan', () => {
    const result = calculateWorkdayProjection({
      totalCases: 240,
      casesCompleted: 160,
      currentTesters: 8,
      perHourPerTester: 4,
      planningRows: rows,
      startDate: D1,
      endDate: D3,
      planStartTime: 9 * 60,
      anchor: { epochDay: parseDate(D3) ?? 0, timeOfDay: 16 * 60 },
    });
    // Only 90 min left on D3 (16:00→17:30): the remaining 150 min overflow
    // into the next business day (D4) at 9:00 + 60 = 10:00.
    expect(result.expectedFinish).toEqual({ epochDay: parseDate(D4), time: 10 * 60 });
  });
});

describe('workday projection with a five-day plan', () => {
  it('finishes at end of day on the last working day before the end date', () => {
    // 2 testers × 5/h = 10/h; 300 cases → 30h = exactly 4 working days
    // (D4 is OFF), finishing 17:30 on D5.
    const rows = [row(D1), row(D2), row(D3), row(D4, true), row(D5)];
    const result = calculateWorkdayProjection({
      totalCases: 300,
      currentTesters: 2,
      perHourPerTester: 5,
      planningRows: rows,
      startDate: D1,
      endDate: D5,
    });
    expect(result.expectedFinish).toEqual({ epochDay: parseDate(D5), time: WORK_DAY_END });
    expect(result.workingDaysToTarget).toBe(4);
    expect(result.requiredTesters).toBe(2); // 300 / (5 × 7.5 × 4) = 2
  });
});


describe('projection horizon (no UI freeze on absurd inputs)', () => {
  const start = parseDate(D1)!;
  const DAY = WORK_MINUTES_PER_DAY;

  /** Naive day-by-day reference walk (the pre-horizon behavior). */
  function referenceFinishDay(fullDaysAfterFirst: number): number {
    let epoch = start;
    for (let i = 0; i < fullDaysAfterFirst; i++) epoch = nextBusinessDayEpoch(epoch);
    return epoch;
  }

  it('stays exact (holidays included) inside the exact horizon', () => {
    const days = EXACT_PROJECTION_BUSINESS_DAYS - 1;
    const finish = advanceOverWorkDays(DAY * days + 60, [start], D1);
    expect(finish?.epochDay).toBe(referenceFinishDay(days));
    expect(finish?.time).toBe(10 * 60);
  });

  it('returns quickly with a far-future finish for huge workloads', () => {
    const t = performance.now();
    // 10M cases at 0.5 cases/h with one tester: previously ~0.5 s per call.
    const finish = advanceOverWorkDays((10_000_000 / 0.5) * 60, [start], D1);
    expect(performance.now() - t).toBeLessThan(100);
    expect(finish).not.toBeNull();
    expect(finish!.epochDay - start).toBeGreaterThan(EXACT_PROJECTION_BUSINESS_DAYS);
  });

  it('keeps the deadline buffer negative so the status stays Delayed', () => {
    const result = calculateWorkdayProjection({
      totalCases: 1_000_000,
      currentTesters: 1,
      perHourPerTester: 0.01,
      planningRows: [row(D1)],
      startDate: D1,
      endDate: D5,
    });
    expect(result.expectedFinish).not.toBeNull();
    expect(result.bufferMinutes).not.toBeNull();
    expect(result.bufferMinutes!).toBeLessThan(0);
  });

  it('gives up (null) only beyond the Date-safe limit', () => {
    expect(advanceOverWorkDays(Number.MAX_SAFE_INTEGER, [start], D1)).toBeNull();
  });
});

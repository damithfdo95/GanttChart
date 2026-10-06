import { describe, expect, it } from 'vitest';
import {
  calculateCumulativeCapacityByDay,
  calculateDailyAvailableTesters,
  calculateDailyCapacity,
  calculateExtraDaysNeeded,
  calculateMultiDayProjection,
  calculateProjectedCompletionDateTime,
  calculateRecommendedTestersForTarget,
  calculateRemainingCasesByDay,
  calculateShortage,
  calculateTargetVariance,
  calculateTypicalDailyCapacity,
  countWorkingDays,
} from '../lib/calculations/planning';
import type { PlanningRow } from '../types';

// Work window 09:00–17:30 with a 12:00–13:00 lunch → 7.5 productive hours/day.
const WORK_START = 9 * 60;
const WORK_END = 17 * 60 + 30;
const LUNCH_START = 12 * 60;
const LUNCH_END = 13 * 60;
const PRODUCTIVE_HOURS = 7.5;

let seq = 0;
function row(date: string, plannedTesters: number, absentTesters = 0, nonWorkingDay = false, note = ''): PlanningRow {
  seq += 1;
  return { id: `r${seq}`, date, plannedTesters, absentTesters, nonWorkingDay, note };
}

const D1 = '2026-09-14';
const D2 = '2026-09-15';
const D3 = '2026-09-16';
const D4 = '2026-09-17';
const D5 = '2026-09-18';

describe('calculateDailyAvailableTesters (absences)', () => {
  it('absences reduce available testers correctly', () => {
    expect(calculateDailyAvailableTesters(5, 2)).toBe(3);
  });

  it('absences greater than planned clamp to 0, never negative', () => {
    expect(calculateDailyAvailableTesters(2, 5)).toBe(0);
  });

  it('zero staffing yields 0', () => {
    expect(calculateDailyAvailableTesters(0, 0)).toBe(0);
  });
});

describe('calculateDailyCapacity', () => {
  it('available × perHour × productiveHours', () => {
    expect(calculateDailyCapacity(3, 4, 7.5)).toBe(90);
  });

  it('zero available testers yields 0 capacity (zero-capacity day)', () => {
    expect(calculateDailyCapacity(0, 4, 7.5)).toBe(0);
  });

  it('zero productive hours yields 0 capacity', () => {
    expect(calculateDailyCapacity(3, 4, 0)).toBe(0);
  });
});

describe('calculateCumulativeCapacityByDay', () => {
  it('computes per-day and cumulative capacity with absences and a non-working day', () => {
    const rows = calculateCumulativeCapacityByDay([row(D1, 4), row(D2, 2, 1), row(D3, 3, 0, true)], 4, PRODUCTIVE_HOURS);
    expect(rows.map((r) => r.dailyCapacity)).toEqual([120, 30, 0]);
    expect(rows.map((r) => r.cumulativeCapacity)).toEqual([120, 150, 150]);
    expect(rows[1].availableTesters).toBe(1);
    expect(rows[2].effectiveTesters).toBe(0);
  });

  it('cumulative capacity is monotonic non-decreasing', () => {
    const rows = calculateCumulativeCapacityByDay(
      [row(D1, 1), row(D2, 5, 4), row(D3, 2), row(D4, 0), row(D5, 9)],
      3,
      PRODUCTIVE_HOURS,
    );
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].cumulativeCapacity).toBeGreaterThanOrEqual(rows[i - 1].cumulativeCapacity);
    }
  });

  it('non-working days always contribute 0 capacity', () => {
    const rows = calculateCumulativeCapacityByDay([row(D1, 10, 0, true)], 4, PRODUCTIVE_HOURS);
    expect(rows[0].dailyCapacity).toBe(0);
    expect(rows[0].cumulativeCapacity).toBe(0);
  });
});

describe('calculateRemainingCasesByDay', () => {
  it('tracks remaining cases after each day', () => {
    const capacityRows = calculateCumulativeCapacityByDay([row(D1, 4), row(D2, 2, 1), row(D3, 3, 0, true)], 4, PRODUCTIVE_HOURS);
    const remaining = calculateRemainingCasesByDay(200, capacityRows);
    expect(remaining.map((r) => r.remainingCases)).toEqual([80, 50, 50]);
  });

  it('may go below zero internally (UI clamps for display)', () => {
    const capacityRows = calculateCumulativeCapacityByDay([row(D1, 4)], 4, PRODUCTIVE_HOURS);
    const remaining = calculateRemainingCasesByDay(100, capacityRows);
    expect(remaining[0].remainingCases).toBe(-20);
  });
});

describe('calculateProjectedCompletionDateTime', () => {
  it('projects completion on a later day with intraday time', () => {
    // caps [30, 60, 90]; 120 cases → day 3, 30 left at 12/h → 2.5h → 11:30
    const rows = calculateCumulativeCapacityByDay([row(D1, 1), row(D2, 2), row(D3, 3)], 4, PRODUCTIVE_HOURS);
    const completion = calculateProjectedCompletionDateTime(120, rows, WORK_START, LUNCH_START, LUNCH_END, WORK_END);
    expect(completion).not.toBeNull();
    expect(completion!.dayIndex).toBe(2);
    expect(completion!.date).toBe(D3);
    expect(completion!.time).toBe(11 * 60 + 30);
  });

  it('excludes lunch when the intraday finish crosses it', () => {
    // 2 testers → 8/h; 56 cases → 7 productive hours → 09:00→12:00, jump to 13:00, +4h → 17:00
    const rows = calculateCumulativeCapacityByDay([row(D1, 2)], 4, PRODUCTIVE_HOURS);
    const completion = calculateProjectedCompletionDateTime(56, rows, WORK_START, LUNCH_START, LUNCH_END, WORK_END);
    expect(completion!.time).toBe(17 * 60);
  });

  it('exact full-day finish lands at work end', () => {
    const rows = calculateCumulativeCapacityByDay([row(D1, 2)], 4, PRODUCTIVE_HOURS);
    const completion = calculateProjectedCompletionDateTime(60, rows, WORK_START, LUNCH_START, LUNCH_END, WORK_END);
    expect(completion!.time).toBe(WORK_END);
  });

  it('returns null when the plan is insufficient (incomplete plan)', () => {
    const rows = calculateCumulativeCapacityByDay([row(D1, 2)], 4, PRODUCTIVE_HOURS);
    expect(calculateProjectedCompletionDateTime(61, rows, WORK_START, LUNCH_START, LUNCH_END, WORK_END)).toBeNull();
  });

  it('returns day 0 at work start when there is nothing to do', () => {
    const rows = calculateCumulativeCapacityByDay([row(D1, 2)], 4, PRODUCTIVE_HOURS);
    const completion = calculateProjectedCompletionDateTime(0, rows, WORK_START, LUNCH_START, LUNCH_END, WORK_END);
    expect(completion!.dayIndex).toBe(0);
    expect(completion!.time).toBe(WORK_START);
  });

  it('skips a non-working day and completes on the next one', () => {
    const rows = calculateCumulativeCapacityByDay([row(D1, 4, 0, true), row(D2, 4)], 4, PRODUCTIVE_HOURS);
    const completion = calculateProjectedCompletionDateTime(120, rows, WORK_START, LUNCH_START, LUNCH_END, WORK_END);
    expect(completion!.dayIndex).toBe(1);
    expect(completion!.time).toBe(WORK_END);
  });

  it('returns null with no rows at all', () => {
    expect(calculateProjectedCompletionDateTime(10, [], WORK_START, LUNCH_START, LUNCH_END, WORK_END)).toBeNull();
  });
});

describe('calculateShortage', () => {
  it('positive when capacity is short', () => {
    expect(calculateShortage(61, 60)).toBe(1);
  });

  it('clamped to 0 when capacity is sufficient', () => {
    expect(calculateShortage(50, 60)).toBe(0);
  });
});

describe('calculateExtraDaysNeeded', () => {
  it('0 when there is no shortage', () => {
    expect(calculateExtraDaysNeeded(0, 30)).toBe(0);
  });

  it('rounds up to whole days', () => {
    expect(calculateExtraDaysNeeded(24, 32)).toBe(1);
    expect(calculateExtraDaysNeeded(61, 30)).toBe(3);
  });

  it('unbounded when no positive reference capacity exists', () => {
    expect(calculateExtraDaysNeeded(10, 0)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('calculateRecommendedTestersForTarget', () => {
  it('recommends uniform staffing across working days', () => {
    // 360 / (4 × 7.5 × 2) = 6 exactly
    expect(calculateRecommendedTestersForTarget(360, 2, 4, 7.5)).toBe(6);
  });

  it('rounds up above the exact fit', () => {
    expect(calculateRecommendedTestersForTarget(361, 2, 4, 7.5)).toBe(7);
  });

  it('0 when nothing remains', () => {
    expect(calculateRecommendedTestersForTarget(0, 2, 4, 7.5)).toBe(0);
  });

  it('null when there are no working days', () => {
    expect(calculateRecommendedTestersForTarget(100, 0, 4, 7.5)).toBeNull();
  });
});

describe('countWorkingDays', () => {
  it('counts working rows up to the target date (holiday exclusion)', () => {
    const rows = [row(D1, 1), row(D2, 1, 0, true), row(D3, 1), row(D4, 1)];
    expect(countWorkingDays(rows, D3)).toBe(2);
    expect(countWorkingDays(rows, D4)).toBe(3);
    expect(countWorkingDays(rows, D2)).toBe(1);
  });

  it('0 when the target date is invalid', () => {
    expect(countWorkingDays([row(D1, 1)], 'not-a-date')).toBe(0);
  });
});

describe('calculateTypicalDailyCapacity', () => {
  it('averages positive daily capacities', () => {
    const rows = calculateCumulativeCapacityByDay([row(D1, 4), row(D2, 2, 1), row(D3, 3, 0, true)], 4, PRODUCTIVE_HOURS);
    expect(calculateTypicalDailyCapacity(rows)).toBe(75);
  });

  it('0 when every day has zero capacity', () => {
    const rows = calculateCumulativeCapacityByDay([row(D1, 1, 0, true), row(D2, 2, 2)], 4, PRODUCTIVE_HOURS);
    expect(calculateTypicalDailyCapacity(rows)).toBe(0);
  });
});

describe('calculateTargetVariance', () => {
  it('positive when projected finishes before the target', () => {
    const variance = calculateTargetVariance({ dayIndex: 1, date: D2, time: 11 * 60 + 30 }, D2, WORK_END);
    expect(variance).toBe(WORK_END - (11 * 60 + 30));
  });

  it('negative when projected finishes after the target day', () => {
    const variance = calculateTargetVariance({ dayIndex: 2, date: D3, time: 11 * 60 + 30 }, D2, WORK_END);
    expect(variance).toBe(WORK_END - (11 * 60 + 30) - 1440);
  });
});

describe('calculateMultiDayProjection (composition)', () => {
  it('composes capacity, completion, variance and recommendation', () => {
    const projection = calculateMultiDayProjection({
      casesRemaining: 140,
      planningRows: [row(D1, 4), row(D2, 2, 1), row(D3, 3)],
      perHourPerTester: 4,
      workStartTime: WORK_START,
      workEndTime: WORK_END,
      lunch: { start: LUNCH_START, end: LUNCH_END },
      targetCompletionDate: D3,
      targetCompletionTime: WORK_END,
    });
    // caps [120, 30, 90]; 140 → completes day 2: 20 left at 4/h → 5h → 15:00
    expect(projection.totalPlannedCapacity).toBe(240);
    expect(projection.shortage).toBe(0);
    expect(projection.projectedCompletion!.dayIndex).toBe(1);
    expect(projection.projectedCompletion!.time).toBe(15 * 60);
    // target D3 17:30 vs projected D2 15:00 → one day + 2.5h ahead
    expect(projection.targetVarianceMinutes).toBe(1440 + 150);
    // working days up to D3 = 3 → 140 / (4 × 7.5 × 3) = 1.56 → 2 testers
    expect(projection.recommendedTesters).toBe(2);
  });

  it('reports shortage, extra days and null completion when insufficient', () => {
    const projection = calculateMultiDayProjection({
      casesRemaining: 300,
      planningRows: [row(D1, 4), row(D2, 2, 1), row(D3, 3)],
      perHourPerTester: 4,
      workStartTime: WORK_START,
      workEndTime: WORK_END,
      lunch: { start: LUNCH_START, end: LUNCH_END },
      targetCompletionDate: null,
      targetCompletionTime: null,
    });
    expect(projection.projectedCompletion).toBeNull();
    expect(projection.shortage).toBe(300 - 240);
    // typical = (120 + 30 + 90) / 3 = 80 → ceil(60 / 80) = 1
    expect(projection.extraDaysNeeded).toBe(1);
    expect(projection.recommendedTesters).toBeNull();
    expect(projection.targetVarianceMinutes).toBeNull();
  });
});

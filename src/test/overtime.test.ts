import { describe, expect, it } from 'vitest';
import type { AppState, PlanningRow, QaInputs } from '../types';
import {
  MAX_DAILY_OVERTIME_MINUTES,
  WORK_DAY_END,
  advanceOverWorkDays,
  calculateWorkdayProjection,
  clampOvertimeMinutes,
  excludedEpochDays,
  workdayProductiveHours,
  workingEpochDays,
} from '../lib/calculations/workday';
import { calculateMultiDayProjection } from '../lib/calculations/planning';
import { buildRecoveryBaseline } from '../lib/calculations/recovery';
import { validateInputs } from '../lib/validation/validate';
import { normalizeQaInputs } from '../lib/storage/storage';
import { parseDate } from '../lib/dates/dates';

const MON = '2026-10-05';
const TUE = '2026-10-06';
const WED = '2026-10-07';

function row(date: string, nonWorkingDay = false): PlanningRow {
  return { id: date, date, plannedTesters: 5, absentTesters: 0, nonWorkingDay, note: '' };
}

function epoch(date: string): number {
  return parseDate(date)!;
}

function baseInputs(overrides: Partial<QaInputs> = {}): QaInputs {
  return normalizeQaInputs({
    totalCases: 187,
    currentTesters: 5,
    startTime: 9 * 60,
    targetFinish: 17 * 60 + 30,
    lunchStart: 12 * 60,
    lunchEnd: 13 * 60,
    perHourPerTester: 4,
    casesCompleted: 0,
    startDate: MON,
    targetCompletionDate: TUE,
    targetCompletionTime: null,
    planningRows: [row(MON), row(TUE)],
    ...overrides,
  });
}

describe('overtime helpers', () => {
  it('extends the productive day and clamps to 0–180', () => {
    expect(workdayProductiveHours(9 * 60)).toBe(7.5);
    expect(workdayProductiveHours(9 * 60, 60)).toBe(8.5);
    expect(workdayProductiveHours(9 * 60, 120)).toBe(9.5);
    expect(workdayProductiveHours(9 * 60, MAX_DAILY_OVERTIME_MINUTES)).toBe(10.5);
    expect(workdayProductiveHours(9 * 60, 999)).toBe(10.5); // clamped
    expect(workdayProductiveHours(9 * 60, -50)).toBe(7.5); // clamped to 0
    expect(clampOvertimeMinutes(undefined)).toBe(0);
    expect(clampOvertimeMinutes(Number.NaN)).toBe(0);
    expect(clampOvertimeMinutes(200)).toBe(MAX_DAILY_OVERTIME_MINUTES);
    expect(clampOvertimeMinutes(90.4)).toBe(90);
  });

  it('normalizeQaInputs backfills the overtime field to 0', () => {
    const normalized = normalizeQaInputs(baseInputs());
    expect(normalized.dailyOvertimeMinutes).toBe(0);
    expect(normalizeQaInputs(baseInputs({ dailyOvertimeMinutes: 45 })).dailyOvertimeMinutes).toBe(45);
  });

  it('validates the 0–180 range with a localized error', () => {
    expect(validateInputs(baseInputs({ dailyOvertimeMinutes: 0 })).errors.dailyOvertimeMinutes).toBeUndefined();
    expect(validateInputs(baseInputs({ dailyOvertimeMinutes: 180 })).errors.dailyOvertimeMinutes).toBeUndefined();
    expect(validateInputs(baseInputs({ dailyOvertimeMinutes: 181 })).errors.dailyOvertimeMinutes).toBe('errors.dailyOvertimeRange');
    expect(validateInputs(baseInputs({ dailyOvertimeMinutes: -15 })).errors.dailyOvertimeMinutes).toBe('errors.dailyOvertimeRange');
  });
});

describe('advanceOverWorkDays with overtime', () => {
  const days = workingEpochDays([row(MON)], MON);

  it('lets work finish on the same day inside the overtime window', () => {
    // 8h of work: without OT the day holds 7.5h → next day 9:30; with 60 min
    // OT the window is 9.5h → same day at 18:00.
    expect(advanceOverWorkDays(8 * 60, days, MON)).toEqual({ epochDay: epoch(TUE), time: 9 * 60 + 30 });
    expect(advanceOverWorkDays(8 * 60, days, MON, 9 * 60, undefined, 60)).toEqual({ epochDay: epoch(MON), time: 18 * 60 });
  });

  it('the user scenario: 187 cases, 5 testers × 4/h, anchored Monday 10:30', () => {
    // 187 / 20 = 9h21m needed. Monday from 10:30 holds 6h.
    const anchor = { epochDay: epoch(MON), timeOfDay: 10 * 60 + 30 };
    const rows = workingEpochDays([row(MON), row(TUE)], MON);
    const minutes = (187 / (5 * 4)) * 60;

    // No overtime: 6h today + 3h21m Tuesday (over lunch) → Tue 13:21.
    expect(advanceOverWorkDays(minutes, rows, MON, 9 * 60, anchor)).toEqual({ epochDay: epoch(TUE), time: 13 * 60 + 21 });
    // 120 min OT: 8h today → 81 min left → Tue 10:21.
    expect(advanceOverWorkDays(minutes, rows, MON, 9 * 60, anchor, 120)).toEqual({ epochDay: epoch(TUE), time: 10 * 60 + 21 });
    // 180 min OT: 9h today → 21 min left → Tue 9:21.
    expect(advanceOverWorkDays(minutes, rows, MON, 9 * 60, anchor, 180)).toEqual({ epochDay: epoch(TUE), time: 9 * 60 + 21 });
  });
});

describe('implicit anchor day (today without a planning row)', () => {
  it('counts today’s remaining window when today is a business day with no row', () => {
    const rows = workingEpochDays([row(TUE)], MON); // only Tuesday is listed
    const anchor = { epochDay: epoch(MON), timeOfDay: 10 * 60 }; // Monday 10:00
    // 561 min needed; Monday from 10:00 holds 6.5h (390) → 171 on Tuesday.
    const minutes = (187 / (5 * 4)) * 60;
    expect(advanceOverWorkDays(minutes, rows, MON, 9 * 60, anchor)).toEqual({ epochDay: epoch(TUE), time: 11 * 60 + 51 });
  });

  it('never resurrects a day explicitly flagged non-working', () => {
    const offDays = excludedEpochDays([row(MON, true), row(TUE)]);
    expect(offDays).toEqual([epoch(MON)]);
    const anchor = { epochDay: epoch(MON), timeOfDay: 10 * 60 };
    const rows = workingEpochDays([row(MON, true), row(TUE)], MON);
    // Monday is flagged OFF: work starts Tuesday with the full day.
    const minutes = (187 / (5 * 4)) * 60; // 561 min
    expect(advanceOverWorkDays(minutes, rows, MON, 9 * 60, anchor, 0, offDays)).toEqual({
      epochDay: epoch(WED),
      time: 10 * 60 + 51, // 561 − 450 (Tuesday) → 111 on Wednesday
    });
  });
});

describe('calculateWorkdayProjection with overtime', () => {
  it('keeps the buffer measured against the 17:30 deadline', () => {
    const anchor = { epochDay: epoch(MON), timeOfDay: 9 * 60 };
    // 8h of work (160 cases / 20 per hour): with 60 min OT it finishes
    // Monday 18:00 — one day before the Tuesday deadline — but the buffer
    // counts only up to 17:30, so it is 30 min "behind" the same-day marker.
    const result = calculateWorkdayProjection({
      totalCases: 160,
      currentTesters: 5,
      perHourPerTester: 4,
      planningRows: [row(MON), row(TUE)],
      startDate: MON,
      endDate: TUE,
      anchor,
      dailyOvertimeMinutes: 60,
    });
    expect(result.expectedFinish).toEqual({ epochDay: epoch(MON), time: 18 * 60 });
    expect(result.productiveHours).toBeCloseTo(8.5 + 8.5, 10); // Mon (9:00→18:30) + Tue
    expect(result.workingDaysToTarget).toBe(2);
    // Deadline Tuesday 17:30 vs finish Monday 18:00 → one day minus 30 min.
    expect(result.bufferMinutes).toBe(1440 - 30);
  });

  it('an anchored projection on an unlisted business day counts today (no rows at all)', () => {
    const anchor = { epochDay: epoch(MON), timeOfDay: 10 * 60 };
    const result = calculateWorkdayProjection({
      totalCases: 20,
      currentTesters: 5,
      perHourPerTester: 4,
      planningRows: [row(WED)], // only Wednesday is listed
      startDate: WED,
      endDate: null,
      anchor,
    });
    // 20 cases / 20 per hour = 1h → fits today from 10:00 (implicit day).
    expect(result.expectedFinish).toEqual({ epochDay: epoch(MON), time: 11 * 60 });
  });
});

describe('multi-day projection with overtime', () => {
  it('raises daily capacity and allows completion past 17:30', () => {
    // 2 testers × 4/h = 8 cases/h; 80 cases remaining.
    const planningRows = [{ ...row(MON), plannedTesters: 2 }, { ...row(TUE), plannedTesters: 2 }];
    const base = {
      casesRemaining: 80,
      planningRows,
      perHourPerTester: 4,
      workStartTime: 9 * 60,
      workEndTime: WORK_DAY_END,
      lunch: { start: 12 * 60, end: 13 * 60 },
      targetCompletionDate: TUE,
      targetCompletionTime: null,
    } as const;

    // Base hours: Monday holds 60 cases → 20 left → Tuesday 11:30, shortage 0
    // across the two days but 20 cases of one-day shortage.
    const noOt = calculateMultiDayProjection({ ...base });
    expect(noOt.rows[0].dailyCapacity).toBeCloseTo(60, 10);
    expect(noOt.projectedCompletion).toEqual({ dayIndex: 1, date: TUE, time: 11 * 60 + 30 });

    // 180 min OT: Monday holds 84 cases ≥ 80 → completes Monday at 20:00 —
    // past 17:30, only possible because of overtime.
    const withOt = calculateMultiDayProjection({ ...base, dailyOvertimeMinutes: 180 });
    expect(withOt.rows[0].dailyCapacity).toBeCloseTo(84, 10);
    expect(withOt.shortage).toBe(0);
    expect(withOt.projectedCompletion).toEqual({ dayIndex: 0, date: MON, time: 20 * 60 });
    expect(withOt.projectedCompletion!.time).toBeGreaterThan(WORK_DAY_END);
  });
});

describe('recovery baseline honors real overtime', () => {
  it('extends the effective target and remaining time by the configured overtime', () => {
    const baseline = buildRecoveryBaseline(baseInputs({ dailyOvertimeMinutes: 60 }), 9 * 60, 0);
    expect(baseline.targetFinish).toBe(WORK_DAY_END + 60);
    expect(baseline.productiveRemainingMinutes).toBeCloseTo(8.5 * 60, 10); // 9:00→18:30 minus lunch
  });
});

describe('state-level wiring', () => {
  it('the projection input accepts the overtime field and stays pure', () => {
    const state: AppState = { ...baseInputs(), dailyOvertimeMinutes: 30 } as AppState;
    const a = calculateWorkdayProjection({
      totalCases: state.totalCases,
      casesCompleted: state.casesCompleted,
      currentTesters: state.currentTesters,
      perHourPerTester: state.perHourPerTester,
      planningRows: state.planningRows,
      startDate: state.startDate,
      endDate: state.targetCompletionDate,
      planStartTime: state.startTime,
      anchor: { epochDay: epoch(MON), timeOfDay: 9 * 60 },
      dailyOvertimeMinutes: state.dailyOvertimeMinutes,
    });
    const b = calculateWorkdayProjection({
      totalCases: state.totalCases,
      casesCompleted: state.casesCompleted,
      currentTesters: state.currentTesters,
      perHourPerTester: state.perHourPerTester,
      planningRows: state.planningRows,
      startDate: state.startDate,
      endDate: state.targetCompletionDate,
      planStartTime: state.startTime,
      anchor: { epochDay: epoch(MON), timeOfDay: 9 * 60 },
      dailyOvertimeMinutes: 0,
    });
    // With 30 min OT the Monday window is 8h → 561−480 = 81 min Tuesday;
    // without OT it is 7.5h → 111 min Tuesday.
    expect(a.expectedFinish).toEqual({ epochDay: epoch(TUE), time: 10 * 60 + 21 });
    expect(b.expectedFinish).toEqual({ epochDay: epoch(TUE), time: 10 * 60 + 51 });
  });
});

import { describe, expect, it } from 'vitest';
import type { DailyActualSnapshot, DailyTargetOverride, PlanningRow } from '../types';
import { calculateCurrentGap, calculateDailyGaps, generateDailyPlan } from '../lib/calculations/dailyPlan';

// 2 testers × 2 cases/h × 9h = 36 cases/day.
const DATES = ['2026-09-14', '2026-09-15', '2026-09-16'];

function rows(dates: string[], plannedTesters = 2): PlanningRow[] {
  return dates.map((date) => ({
    id: date,
    date,
    plannedTesters,
    absentTesters: 0,
    nonWorkingDay: false,
    note: '',
  }));
}

describe('generateDailyPlan', () => {
  it('AUTO rows follow the capacity engine and cap at total cases', () => {
    const plan = generateDailyPlan(rows(DATES), 2, 9, 60, 1, []);
    expect(plan).toHaveLength(3);
    expect(plan[0].plannedExecute).toBe(36);
    expect(plan[1].plannedExecute).toBe(24); // capped: 60 − 36
    expect(plan[2].plannedExecute).toBe(0);
    expect(plan.map((r) => r.mode)).toEqual(['AUTO', 'AUTO', 'AUTO']);
    expect(plan[1].cumulativeExecute).toBe(60);
  });

  it('derives the pass plan with the target pass rate', () => {
    const plan = generateDailyPlan(rows(DATES), 2, 9, 60, 0.9, []);
    expect(plan[0].plannedPass).toBeCloseTo(32.4, 10);
    expect(plan[1].cumulativePass).toBeCloseTo(54, 10);
  });

  it('non-working days plan zero', () => {
    const plan = generateDailyPlan(
      [{ ...rows(['2026-09-14'])[0], nonWorkingDay: true }, ...rows(['2026-09-15'])],
      2,
      9,
      100,
      1,
      [],
    );
    expect(plan[0].plannedExecute).toBe(0);
    expect(plan[1].plannedExecute).toBe(36); // one working day of capacity, capped at total
  });

  it('MANUAL overrides are authoritative and survive parameter changes', () => {
    const overrides: DailyTargetOverride[] = [{ id: 'o1', date: '2026-09-15', plannedExecute: 10, plannedPass: 8 }];
    const before = generateDailyPlan(rows(DATES), 2, 9, 100, 1, overrides);
    expect(before[1].mode).toBe('MANUAL');
    expect(before[1].plannedExecute).toBe(10);
    expect(before[1].plannedPass).toBe(8);
    expect(before[2].cumulativeExecute).toBe(82); // 36 + 10 + 36

    // Testers/rate change: AUTO rows recompute, the manual row does not move.
    const after = generateDailyPlan(rows(DATES), 4, 9, 100, 1, overrides);
    expect(after[1].plannedExecute).toBe(10);
    expect(after[1].plannedPass).toBe(8);
    expect(after[0].plannedExecute).toBe(72);
  });

  it('manual rows count toward the cumulative plan', () => {
    const overrides: DailyTargetOverride[] = [{ id: 'o1', date: '2026-09-14', plannedExecute: 50, plannedPass: 45 }];
    const plan = generateDailyPlan(rows(DATES), 2, 9, 100, 1, overrides);
    expect(plan[0].cumulativeExecute).toBe(50);
    expect(plan[0].cumulativePass).toBe(45);
    expect(plan[1].plannedExecute).toBe(36); // AUTO continues after the manual total
  });
});

describe('calculateDailyGaps', () => {
  const plan = () => generateDailyPlan(rows(DATES), 2, 9, 90, 1, []);
  const TODAY = '2026-09-15';

  it('uses the live cumulative actuals for today', () => {
    const gaps = calculateDailyGaps(plan(), [], TODAY, 50, 45);
    const todayRow = gaps[1];
    expect(todayRow.isToday).toBe(true);
    expect(todayRow.actualExecuteCum).toBe(50);
    expect(todayRow.executeGap).toBe(50 - 72); // planned cum 36 + 36
    expect(todayRow.executeAchievementPct).toBeCloseTo((50 / 72) * 100, 10);
  });

  it('uses stored snapshots for past days and null for future days', () => {
    const actuals: DailyActualSnapshot[] = [{ id: 'a1', date: '2026-09-14', executed: 30, passed: 28 }];
    const gaps = calculateDailyGaps(plan(), actuals, TODAY, 50, 45);
    expect(gaps[0].actualExecuteCum).toBe(30);
    expect(gaps[0].executeGap).toBe(30 - 36);
    expect(gaps[0].passGap).toBe(28 - 36);
    expect(gaps[2].actualExecuteCum).toBeNull();
    expect(gaps[2].executeGap).toBeNull();
    expect(gaps[2].executeAchievementPct).toBeNull();
  });

  it('past days without a snapshot have no actuals', () => {
    const gaps = calculateDailyGaps(plan(), [], TODAY, 50, 45);
    expect(gaps[0].actualExecuteCum).toBeNull();
    expect(gaps[0].executeGap).toBeNull();
  });

  it('achievement is null when the planned denominator is zero', () => {
    const gaps = calculateDailyGaps(generateDailyPlan(rows(['2026-09-15']), 0, 9, 0, 1, []), [], '2026-09-15', 0, 0);
    expect(gaps[0].executeAchievementPct).toBeNull();
  });
});

describe('calculateCurrentGap', () => {
  const TODAY = '2026-09-15';

  it('compares planned-to-date against the live actuals', () => {
    const plan = generateDailyPlan(rows(DATES), 2, 9, 90, 0.9, []);
    const gap = calculateCurrentGap(plan, TODAY, 90, 40, 35);
    expect(gap.plannedExecuteToDate).toBe(72);
    expect(gap.plannedPassToDate).toBeCloseTo(64.8, 10);
    expect(gap.executeGap).toBe(40 - 72);
    expect(gap.passGap).toBeCloseTo(35 - 64.8, 10);
    expect(gap.executeAchievementPct).toBeCloseTo((40 / 72) * 100, 10);
    expect(gap.plannedProgressRatio).toBeCloseTo(72 / 90, 10);
  });

  it('planned-to-date stops at the last row on or before today', () => {
    const plan = generateDailyPlan(rows(DATES), 2, 9, 90, 1, []);
    const gap = calculateCurrentGap(plan, '2026-09-16', 90, 90, 90);
    expect(gap.plannedExecuteToDate).toBe(90);
    expect(gap.executeGap).toBe(0);
  });

  it('zero planned-to-date yields null achievement but a numeric gap', () => {
    const gap = calculateCurrentGap(
      generateDailyPlan(rows(['2026-09-20']), 2, 9, 90, 1, []),
      '2026-09-15', // today is before all plan rows
      90,
      5,
      5,
    );
    expect(gap.plannedExecuteToDate).toBe(0);
    expect(gap.executeGap).toBe(5);
    expect(gap.executeAchievementPct).toBeNull();
    expect(gap.plannedProgressRatio).toBe(0);
  });

  it('planned progress ratio is null without total cases', () => {
    const gap = calculateCurrentGap(generateDailyPlan(rows(DATES), 2, 9, 0, 1, []), TODAY, 0, 0, 0);
    expect(gap.plannedProgressRatio).toBeNull();
  });
});

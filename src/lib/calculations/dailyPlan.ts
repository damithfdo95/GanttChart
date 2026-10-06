import type { DailyActualSnapshot, DailyTargetOverride, PlanningRow } from '../../types';
import { calculateCumulativeCapacityByDay } from './planning';
import type { DayWindowsContext } from './workday';

/**
 * Level 2 §3–§4: automatic daily execution/pass plan generation and
 * plan-vs-actual gap analysis. Pure functions only — no clock, no React,
 * no storage. AUTO rows are derived from the existing capacity engine;
 * MANUAL rows come from stored overrides and survive every recalculation.
 */

export type DailyPlanMode = 'AUTO' | 'MANUAL';

/** One generated daily plan row (never persisted — always derived). */
export interface DailyPlanRow {
  date: string;
  nonWorkingDay: boolean;
  mode: DailyPlanMode;
  /** Cases planned to execute that day. */
  plannedExecute: number;
  /** Cases planned to pass that day (plannedExecute × targetPassRate for AUTO). */
  plannedPass: number;
  /** Running planned execute total including this day. */
  cumulativeExecute: number;
  /** Running planned pass total including this day. */
  cumulativePass: number;
}

/**
 * Generate the cumulative daily execution/pass plan.
 *
 * AUTO rows: plannedExecute = min(daily capacity from the existing engine,
 * cases still unplanned); non-working days plan 0. MANUAL rows: the stored
 * override values are authoritative and are never overwritten — changing
 * testers, rates, hours or lunch recomputes AUTO rows only. With a
 * `dayWindows` context (V7) each day's capacity uses its own effective
 * window; without it the uniform `productiveHours` applies (previous
 * behavior).
 */
export function generateDailyPlan(
  planningRows: PlanningRow[],
  perHourPerTester: number,
  productiveHours: number,
  totalCases: number,
  targetPassRate: number,
  overrides: DailyTargetOverride[],
  dayWindows?: DayWindowsContext,
): DailyPlanRow[] {
  const overrideByDate = new Map(overrides.map((o) => [o.date, o]));
  const capacityRows = calculateCumulativeCapacityByDay(planningRows, perHourPerTester, productiveHours, dayWindows);
  let cumulativeExecute = 0;
  let cumulativePass = 0;
  return capacityRows.map((row) => {
    const override = overrideByDate.get(row.date);
    let mode: DailyPlanMode;
    let plannedExecute: number;
    let plannedPass: number;
    if (override !== undefined) {
      mode = 'MANUAL';
      plannedExecute = Math.max(0, override.plannedExecute);
      plannedPass = Math.max(0, override.plannedPass);
    } else {
      mode = 'AUTO';
      const unplanned = Math.max(0, totalCases - cumulativeExecute);
      plannedExecute = Math.min(row.dailyCapacity, unplanned);
      plannedPass = plannedExecute * targetPassRate;
    }
    cumulativeExecute += plannedExecute;
    cumulativePass += plannedPass;
    return {
      date: row.date,
      nonWorkingDay: row.nonWorkingDay,
      mode,
      plannedExecute,
      plannedPass,
      cumulativeExecute,
      cumulativePass,
    };
  });
}

/** Per-day plan vs actual comparison row. Actuals are null when unknown. */
export interface DailyGapRow {
  date: string;
  isToday: boolean;
  plannedExecuteCum: number;
  plannedPassCum: number;
  /** Live cumulative executed total on today; snapshot on past days; null otherwise. */
  actualExecuteCum: number | null;
  actualPassCum: number | null;
  /** actual − planned; positive = ahead, 0 = on plan, negative = behind. */
  executeGap: number | null;
  passGap: number | null;
  /** actual / planned × 100; null when planned or actual is unknown/zero-denominator. */
  executeAchievementPct: number | null;
  passAchievementPct: number | null;
}

function achievementPct(actual: number | null, planned: number): number | null {
  if (actual === null || planned <= 0) return null;
  return (actual / planned) * 100;
}

/**
 * Compare the plan against actuals per day (Level 2 §4).
 * - Today: the live cumulative casesCompleted/casesPassed are the actuals.
 * - Past days: the stored end-of-day snapshots (null when never recorded).
 * - Future days: no actuals yet (null).
 */
export function calculateDailyGaps(
  planRows: DailyPlanRow[],
  actuals: DailyActualSnapshot[],
  today: string,
  liveExecuted: number,
  livePassed: number,
): DailyGapRow[] {
  const snapshotByDate = new Map(actuals.map((a) => [a.date, a]));
  return planRows.map((row) => {
    let actualExecuteCum: number | null;
    let actualPassCum: number | null;
    if (row.date === today) {
      actualExecuteCum = liveExecuted;
      actualPassCum = livePassed;
    } else if (row.date < today) {
      const snapshot = snapshotByDate.get(row.date);
      actualExecuteCum = snapshot ? snapshot.executed : null;
      actualPassCum = snapshot ? snapshot.passed : null;
    } else {
      actualExecuteCum = null;
      actualPassCum = null;
    }
    return {
      date: row.date,
      isToday: row.date === today,
      plannedExecuteCum: row.cumulativeExecute,
      plannedPassCum: row.cumulativePass,
      actualExecuteCum,
      actualPassCum,
      executeGap: actualExecuteCum === null ? null : actualExecuteCum - row.cumulativeExecute,
      passGap: actualPassCum === null ? null : actualPassCum - row.cumulativePass,
      executeAchievementPct: achievementPct(actualExecuteCum, row.cumulativeExecute),
      passAchievementPct: achievementPct(actualPassCum, row.cumulativePass),
    };
  });
}

/** Current plan-vs-actual summary (Dashboard + Daily Progress view). */
export interface CurrentGapSummary {
  plannedExecuteToDate: number;
  plannedPassToDate: number;
  actualExecuted: number;
  actualPassed: number;
  executeGap: number;
  passGap: number;
  executeAchievementPct: number | null;
  passAchievementPct: number | null;
  /** plannedExecuteToDate / totalCases clamped to 0–1; null when totalCases is 0. */
  plannedProgressRatio: number | null;
}

/**
 * Today's gap summary: planned-to-date (all plan rows up to and including
 * today) vs the live cumulative actuals.
 */
export function calculateCurrentGap(
  planRows: DailyPlanRow[],
  today: string,
  totalCases: number,
  liveExecuted: number,
  livePassed: number,
): CurrentGapSummary {
  let plannedExecuteToDate = 0;
  let plannedPassToDate = 0;
  for (const row of planRows) {
    if (row.date <= today) {
      plannedExecuteToDate = row.cumulativeExecute;
      plannedPassToDate = row.cumulativePass;
    }
  }
  return {
    plannedExecuteToDate,
    plannedPassToDate,
    actualExecuted: liveExecuted,
    actualPassed: livePassed,
    executeGap: liveExecuted - plannedExecuteToDate,
    passGap: livePassed - plannedPassToDate,
    executeAchievementPct: achievementPct(liveExecuted, plannedExecuteToDate),
    passAchievementPct: achievementPct(livePassed, plannedPassToDate),
    plannedProgressRatio: totalCases > 0 ? Math.max(0, Math.min(1, plannedExecuteToDate / totalCases)) : null,
  };
}

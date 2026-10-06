import type { LunchWindow, MinutesOfDay, PlanningRow } from '../../types';
import { calculateProductiveHours } from './capacity';
import { advanceThroughLunch } from './schedule';
import { parseDate } from '../dates/dates';
import { isNonWorkingDate } from '../dates/businessDays';
import { clampOvertimeMinutes, NO_LUNCH, type DayWindow, type DayWindowsContext } from './workday';

/**
 * Pure multi-day planning engine (V2). All functions are deterministic and
 * independently unit-testable: no Date.now(), no hidden state, no React.
 *
 * Conventions:
 * - availableTesters = max(0, planned − absent), clamped, never negative.
 * - A day is non-working when its planning row says so OR when it falls on
 *   a Saturday, Sunday or Japanese public holiday (business-day calendar).
 *   Non-working days always contribute 0 capacity (effectiveTesters = 0).
 * - Cumulative capacity is monotonic non-decreasing by construction.
 * - remainingCases may go below 0 internally; the UI clamps for display.
 * - Intraday completion times advance over productive time only (lunch excluded).
 * - V7: when a per-day window context is supplied (or a row carries its own
 *   overrides), each day's productive hours come from its OWN effective
 *   window (row start/end+OT/interval), not the project-wide uniform value.
 */

/** Staffing after absences; clamped so it can never be negative. */
export function calculateDailyAvailableTesters(plannedTesters: number, absentTesters: number): number {
  return Math.max(0, plannedTesters - absentTesters);
}

/** Cases one day can process: availableTesters × perHour × productiveHours. */
export function calculateDailyCapacity(availableTesters: number, perHourPerTester: number, productiveHours: number): number {
  if (availableTesters <= 0 || perHourPerTester <= 0 || productiveHours <= 0) return 0;
  return availableTesters * perHourPerTester * productiveHours;
}

/** Per-day capacity projection row. */
export interface DailyCapacityRow {
  dayIndex: number;
  date: string;
  plannedTesters: number;
  absentTesters: number;
  availableTesters: number;
  /** 0 on non-working days — the exclusion rule for holidays/off days. */
  effectiveTesters: number;
  /**
   * Effective non-working flag: the row's own flag OR the business-day
   * calendar (Saturday, Sunday, Japanese public holiday).
   */
  nonWorkingDay: boolean;
  /** The day's EFFECTIVE productive hours (V7 per-day window; uniform otherwise). */
  productiveHours: number;
  dailyCapacity: number;
  cumulativeCapacity: number;
}

/** Per-day projection including remaining cases. */
export interface DailyProjectionRow extends DailyCapacityRow {
  /** Cases left after this day; may be negative internally (UI clamps display). */
  remainingCases: number;
}

/**
 * Build the per-day capacity table: availability per day (clamped), effective
 * testers (0 on non-working days — the row's flag or the business-day
 * calendar: weekends and Japanese public holidays), daily capacity and the
 * running cumulative. With a `dayWindows` context each day's productive
 * hours come from its own effective window (V7); without it the uniform
 * scalar `productiveHours` is used for every day (previous behavior).
 */
export function calculateCumulativeCapacityByDay(
  rows: PlanningRow[],
  perHourPerTester: number,
  productiveHours: number,
  dayWindows?: DayWindowsContext,
): DailyCapacityRow[] {
  let cumulative = 0;
  return rows.map((row, index) => {
    const availableTesters = calculateDailyAvailableTesters(row.plannedTesters, row.absentTesters);
    const nonWorkingDay = row.nonWorkingDay || isNonWorkingDate(row.date);
    const effectiveTesters = nonWorkingDay ? 0 : availableTesters;
    const window =
      dayWindows !== undefined
        ? dayWindows.byDay.get(parseDate(row.date) ?? -1) ?? dayWindows.default
        : null;
    const rowProductiveHours = window !== null
      ? calculateProductiveHours(window.start, window.end, window.lunch)
      : productiveHours;
    const dailyCapacity = calculateDailyCapacity(effectiveTesters, perHourPerTester, rowProductiveHours);
    cumulative += dailyCapacity;
    return {
      dayIndex: index,
      date: row.date,
      plannedTesters: row.plannedTesters,
      absentTesters: row.absentTesters,
      availableTesters,
      effectiveTesters,
      nonWorkingDay,
      productiveHours: rowProductiveHours,
      dailyCapacity,
      cumulativeCapacity: cumulative,
    };
  });
}

/** Fill in remaining cases after each day (totalCases − cumulative). */
export function calculateRemainingCasesByDay(totalCases: number, dailyRows: DailyCapacityRow[]): DailyProjectionRow[] {
  return dailyRows.map((row) => ({ ...row, remainingCases: totalCases - row.cumulativeCapacity }));
}

/** Projected completion: first day where cumulative capacity reaches total cases. */
export interface ProjectedCompletionResult {
  dayIndex: number;
  date: string;
  /** Intraday finish as minutes-of-day over productive time (lunch excluded). */
  time: MinutesOfDay;
}

export function calculateProjectedCompletionDateTime(
  totalCases: number,
  dailyRows: DailyCapacityRow[],
  workStartTime: MinutesOfDay,
  lunchStart: MinutesOfDay,
  lunchEnd: MinutesOfDay,
  workEndTime: MinutesOfDay,
  windows?: DayWindow[],
): ProjectedCompletionResult | null {
  if (dailyRows.length === 0) return null;
  if (totalCases <= 0) {
    return { dayIndex: 0, date: dailyRows[0].date, time: workStartTime };
  }
  const lunch: LunchWindow = { start: lunchStart, end: lunchEnd };
  let previousCumulative = 0;
  for (let i = 0; i < dailyRows.length; i++) {
    const row = dailyRows[i];
    if (row.cumulativeCapacity >= totalCases) {
      if (row.dailyCapacity <= 0) return null; // defensive; unreachable when totalCases > 0
      // Team hourly rate = dailyCapacity / productiveHours (capacity = rate × hours);
      // with a V7 per-day window that day's own start/lunch/hours drive the
      // intraday finish time.
      const win = windows?.[i];
      const rowHours = win !== undefined ? calculateProductiveHours(win.start, win.end, win.lunch) : undefined;
      const hoursPerDay = rowHours ?? calculateProductiveHours(workStartTime, workEndTime, lunch);
      const winStart = win?.start ?? workStartTime;
      const winLunch = win?.lunch ?? lunch;
      const remainingInDay = totalCases - previousCumulative;
      const hours = Math.min(hoursPerDay, (remainingInDay / row.dailyCapacity) * hoursPerDay);
      const time = advanceThroughLunch(winStart, hours * 60, winLunch);
      return { dayIndex: row.dayIndex, date: row.date, time };
    }
    previousCumulative = row.cumulativeCapacity;
  }
  return null; // insufficient capacity across all listed rows
}

/** Cases the plan cannot cover; clamped to 0 when capacity is sufficient. */
export function calculateShortage(totalCases: number, totalPlannedCapacity: number): number {
  return Math.max(0, totalCases - totalPlannedCapacity);
}

/**
 * Cumulative daily capacity of all planned days on or before the deadline
 * date (non-working days already contribute 0). Null when the deadline is
 * absent — the "before the deadline" reference for explanations.
 */
export function calculateCapacityByDeadline(dailyRows: DailyCapacityRow[], targetCompletionDate: string): number | null {
  const limit = parseDate(targetCompletionDate);
  if (limit === null) return null;
  let capacity = 0;
  for (const row of dailyRows) {
    const d = parseDate(row.date);
    if (d !== null && d <= limit) capacity += row.dailyCapacity;
  }
  return capacity;
}

/**
 * Whole extra days needed to cover a shortage at a typical daily team
 * capacity. Returns 0 when there is no shortage and Number.POSITIVE_INFINITY
 * when no positive reference capacity exists (the composition layer converts
 * that to null for display).
 */
export function calculateExtraDaysNeeded(shortage: number, typicalDailyTeamCapacity: number): number {
  if (shortage <= 0) return 0;
  if (typicalDailyTeamCapacity <= 0) return Number.POSITIVE_INFINITY;
  return Math.ceil(shortage / typicalDailyTeamCapacity);
}

/** Average of positive daily capacities — the "typical day" reference. */
export function calculateTypicalDailyCapacity(dailyRows: DailyCapacityRow[]): number {
  const positive = dailyRows.filter((row) => row.dailyCapacity > 0);
  if (positive.length === 0) return 0;
  return positive.reduce((sum, row) => sum + row.dailyCapacity, 0) / positive.length;
}

/**
 * Uniform staffing recommendation to finish totalCasesRemaining within
 * remainingWorkingDays full working days. Null when it cannot be computed
 * (no working days / invalid rates); 0 when nothing remains.
 */
export function calculateRecommendedTestersForTarget(
  totalCasesRemaining: number,
  remainingWorkingDays: number,
  perHourPerTester: number,
  productiveHours: number,
): number | null {
  if (perHourPerTester <= 0 || productiveHours <= 0) return null;
  if (totalCasesRemaining <= 0) return 0;
  if (remainingWorkingDays <= 0) return null;
  return Math.ceil(totalCasesRemaining / (perHourPerTester * productiveHours * remainingWorkingDays));
}

/**
 * Working planning rows dated on or before upToAndIncluding. A row on a
 * weekend or Japanese public holiday is never a working day, regardless of
 * its own flag.
 */
export function countWorkingDays(rows: PlanningRow[], upToAndIncluding: string): number {
  const limit = parseDate(upToAndIncluding);
  if (limit === null) return 0;
  let count = 0;
  for (const row of rows) {
    const d = parseDate(row.date);
    if (d !== null && d <= limit && !row.nonWorkingDay && !isNonWorkingDate(row.date)) count += 1;
  }
  return count;
}

/** Combine a YYYY-MM-DD date with a minutes-of-day time into absolute minutes. */
export function toAbsoluteMinutes(date: string, time: MinutesOfDay): number | null {
  const d = parseDate(date);
  if (d === null) return null;
  return d * 1440 + time;
}

/** Variance vs target in minutes: positive = projected finishes before target. */
export function calculateTargetVariance(
  projected: ProjectedCompletionResult,
  targetDate: string,
  targetTime: MinutesOfDay,
): number | null {
  const target = toAbsoluteMinutes(targetDate, targetTime);
  const projectedAbs = toAbsoluteMinutes(projected.date, projected.time);
  if (target === null || projectedAbs === null) return null;
  return target - projectedAbs;
}

/** Raw inputs for the composed multi-day projection. */
export interface MultiDayProjectionInput {
  casesRemaining: number;
  planningRows: PlanningRow[];
  perHourPerTester: number;
  workStartTime: MinutesOfDay;
  workEndTime: MinutesOfDay;
  lunch: LunchWindow;
  targetCompletionDate: string | null;
  targetCompletionTime: MinutesOfDay | null;
  /** Fixed daily overtime minutes: every day runs to workEndTime + overtime (default 0). */
  dailyOvertimeMinutes?: number | null;
}

/** Composed multi-day projection result (all derived, never persisted). */
export interface MultiDayProjectionResult {
  rows: DailyProjectionRow[];
  totalPlannedCapacity: number;
  shortage: number;
  /** Null when no positive reference day exists (i.e. unbounded). */
  extraDaysNeeded: number | null;
  projectedCompletion: ProjectedCompletionResult | null;
  /** Positive = projected before target; null when not comparable. */
  targetVarianceMinutes: number | null;
  recommendedTesters: number | null;
  /** Capacity achievable by the deadline date; null when no target date. */
  capacityByDeadline: number | null;
  /** Cases the deadline capacity cannot cover; null when no target date. */
  shortageByDeadline: number | null;
}

/** Compose the full multi-day projection from raw inputs (pure). */
export function calculateMultiDayProjection(input: MultiDayProjectionInput): MultiDayProjectionResult {
  const ot = clampOvertimeMinutes(input.dailyOvertimeMinutes);
  const workEndTime = input.workEndTime + ot;
  const productiveHours = calculateProductiveHours(input.workStartTime, workEndTime, input.lunch);
  // V7: build the per-day window context — each planning row may override
  // its own start/end/overtime/interval; everything else uses the project
  // window. Rows without any override produce exactly the default window,
  // so pre-V7 data projects identically.
  const defaults: DayWindow = { start: input.workStartTime, end: workEndTime, lunch: input.lunch };
  const windows: DayWindow[] = input.planningRows.map((row) => ({
    start: row.startTime ?? defaults.start,
    end: (row.endTime ?? input.workEndTime) + clampOvertimeMinutes(row.overtimeMinutes ?? ot),
    lunch: row.intervalEnabled === false ? NO_LUNCH : defaults.lunch,
  }));
  const dayWindows: DayWindowsContext = {
    byDay: new Map<number, DayWindow>(
      input.planningRows.map((row, i) => [parseDate(row.date) ?? -1, windows[i]] as const),
    ),
    default: defaults,
  };
  const capacityRows = calculateCumulativeCapacityByDay(input.planningRows, input.perHourPerTester, productiveHours, dayWindows);
  const rows = calculateRemainingCasesByDay(input.casesRemaining, capacityRows);
  const totalPlannedCapacity = capacityRows.length > 0 ? capacityRows[capacityRows.length - 1].cumulativeCapacity : 0;
  const shortage = calculateShortage(input.casesRemaining, totalPlannedCapacity);
  const projectedCompletion = calculateProjectedCompletionDateTime(
    input.casesRemaining,
    capacityRows,
    input.workStartTime,
    input.lunch.start,
    input.lunch.end,
    workEndTime,
    windows,
  );
  const typical = calculateTypicalDailyCapacity(capacityRows);
  const extraDaysNeeded = shortage > 0 && typical <= 0 ? null : calculateExtraDaysNeeded(shortage, typical);
  const targetVarianceMinutes =
    projectedCompletion !== null && input.targetCompletionDate !== null
      ? calculateTargetVariance(projectedCompletion, input.targetCompletionDate, input.targetCompletionTime ?? input.workEndTime)
      : null;
  const workingDays = input.targetCompletionDate !== null ? countWorkingDays(input.planningRows, input.targetCompletionDate) : 0;
  const recommendedTesters = calculateRecommendedTestersForTarget(
    input.casesRemaining,
    workingDays,
    input.perHourPerTester,
    productiveHours,
  );
  const capacityByDeadline =
    input.targetCompletionDate === null ? null : calculateCapacityByDeadline(capacityRows, input.targetCompletionDate);
  const shortageByDeadline = capacityByDeadline === null ? null : calculateShortage(input.casesRemaining, capacityByDeadline);
  return {
    rows,
    totalPlannedCapacity,
    shortage,
    extraDaysNeeded,
    projectedCompletion,
    targetVarianceMinutes,
    recommendedTesters,
    capacityByDeadline,
    shortageByDeadline,
  };
}

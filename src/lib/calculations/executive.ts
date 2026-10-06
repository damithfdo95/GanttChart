import type { LunchWindow, MinutesOfDay, QaInputs, ScheduleStatus } from '../../types';
import { formatDate } from '../dates/dates';
import { calculateProductiveHours } from './capacity';
import { calculateProductiveElapsedTime, calculateScheduleStatus } from './schedule';
import { calculateActualRate, calculateExecutionCounts, calculateProjectedActualFinish, calculateScheduleVariance } from './execution';
import {
  WORK_DAY_END,
  WORK_LUNCH,
  clampOvertimeMinutes,
  calculateWorkdayProjection,
  workingEpochDays,
  dayWindowsFromRows,
  projectDayWindowDefaults,
} from './workday';
import { effectiveTodayWindow } from './dailyExecuted';

/**
 * Level 2 §1: executive summary. One composed, pure view model so the QA
 * situation is understandable within ~5 seconds. Every value reuses the
 * existing calculation engine — no business math is duplicated here.
 */
export interface ExecutiveSummary {
  totalCases: number;
  casesCompleted: number;
  casesRemaining: number;
  /** completed / total as 0–1; null when totalCases is 0. */
  progressRatio: number | null;
  /** Cases actually executed by QA (excludes SPO-assigned, V6.3). */
  qaTested: number;
  /** Cases transferred to the SPO side (V6.3). */
  spoAssigned: number;
  /** QA Tested / Total as 0–1; null when totalCases is 0 (V6.3). */
  qaTestedRatio: number | null;
  /** V6.4 granular breakdown (read-only, derived from the canonical fields). */
  pass: number;
  fail: number;
  notApplicable: number;
  blocked: number;
  retest: number;
  questioned: number;
  currentTesters: number;
  requiredTesters: number | null;
  /** Actual throughput (casesCompleted / productive elapsed hours). */
  currentRatePerHour: number | null;
  /** Throughput needed to finish the remaining cases by the target. */
  requiredRatePerHour: number | null;
  expectedFinish: MinutesOfDay | null;
  projectedFinish: MinutesOfDay | null;
  targetFinish: MinutesOfDay;
  /** target − projected in minutes; positive = projected to finish early. */
  varianceMinutes: number | null;
  status: ScheduleStatus;
}

/**
 * Required cases/hour: remaining cases divided by the productive hours left
 * between now and the target finish. Null when nothing remains or no
 * productive time is left.
 */
export function calculateRequiredRatePerHour(
  remainingCases: number,
  start: MinutesOfDay,
  target: MinutesOfDay,
  lunch: LunchWindow,
  now: MinutesOfDay,
): number | null {
  if (remainingCases <= 0) return null;
  const from = Math.max(now, start);
  if (target <= from) return null;
  const hours = calculateProductiveHours(from, target, lunch);
  if (hours <= 0) return null;
  return remainingCases / hours;
}

/**
 * Compose the executive summary from the shared project inputs. The whole
 * calculation uses the workday model: every day runs from the per-project
 * Plan Start Time (inputs.startTime, default 9:00) to the fixed 17:30 end
 * with the 12:00–13:00 lunch — V7: planning rows may override their own
 * window, and today's pace uses today's EFFECTIVE window (today's execution
 * entry when one exists). Required testers and the expected finish project
 * the REMAINING work; when `todayEpochDay` is supplied the projection
 * anchors at NOW (today's leftover time counts, finishes never land in the
 * past), otherwise it uses the schedule view anchored at the first working
 * day. The pace-based intraday figures (actual rate, projected finish,
 * variance) always reference today's 17:30 work end.
 */
export function calculateExecutiveSummary(
  inputs: QaInputs,
  now: MinutesOfDay,
  todayEpochDay?: number,
): ExecutiveSummary {
  const lunch: LunchWindow = WORK_LUNCH;
  const ot = clampOvertimeMinutes(inputs.dailyOvertimeMinutes);
  const anchor = todayEpochDay === undefined ? undefined : { epochDay: todayEpochDay, timeOfDay: now };
  const today = todayEpochDay === undefined ? null : formatDate(todayEpochDay);
  const todayWindow = today === null ? null : effectiveTodayWindow(inputs, today);

  const workdayProjection = calculateWorkdayProjection({
    totalCases: inputs.totalCases,
    casesCompleted: inputs.casesCompleted,
    currentTesters: inputs.currentTesters,
    perHourPerTester: inputs.perHourPerTester,
    planningRows: inputs.planningRows,
    startDate: inputs.startDate,
    endDate: inputs.targetCompletionDate,
    planStartTime: inputs.startTime,
    anchor,
    dailyOvertimeMinutes: ot,
    dayWindows: dayWindowsFromRows(inputs.planningRows, projectDayWindowDefaults(inputs)),
  });
  const workingDays = workingEpochDays(inputs.planningRows, inputs.startDate);
  const expectedFinishDay = workdayProjection.expectedFinish;
  // Day-offset compound clock: "HH:mm (+Nd)" relative to the anchor (or the
  // first working day in the schedule view).
  const compoundBaseDay = anchor !== undefined ? anchor.epochDay : workingDays.length > 0 ? workingDays[0] : null;
  const expectedFinish =
    expectedFinishDay === null || compoundBaseDay === null
      ? null
      : (expectedFinishDay.epochDay - compoundBaseDay) * 1440 + expectedFinishDay.time;

  const paceStart = todayWindow?.start ?? inputs.startTime;
  const paceLunch = todayWindow?.lunch ?? lunch;
  const productiveElapsedMinutes = calculateProductiveElapsedTime(now, paceStart, paceLunch);
  const actualRate = calculateActualRate(inputs.casesCompleted, productiveElapsedMinutes / 60);
  const remainingCases = Math.max(0, inputs.totalCases - inputs.casesCompleted);
  const projectedFinish = calculateProjectedActualFinish(now, remainingCases, actualRate, paceLunch);
  // Variance stays measured against the 17:30 deadline — an overtime-aided
  // pace shows as a reduced delay (or "overtime required"), never as a moved
  // target. The REQUIRED rate may use the overtime-extended window because
  // the team genuinely has those hours available.
  const varianceMinutes = calculateScheduleVariance(projectedFinish, WORK_DAY_END);
  const executionCounts = calculateExecutionCounts(inputs);

  return {
    totalCases: inputs.totalCases,
    casesCompleted: inputs.casesCompleted,
    casesRemaining: remainingCases,
    progressRatio: inputs.totalCases > 0 ? Math.min(1, inputs.casesCompleted / inputs.totalCases) : null,
    qaTested: executionCounts.qaTested,
    spoAssigned: executionCounts.spoAssigned,
    qaTestedRatio: executionCounts.qaTestedRatio,
    pass: executionCounts.pass,
    fail: executionCounts.fail,
    notApplicable: executionCounts.notApplicable,
    blocked: executionCounts.blocked,
    retest: executionCounts.retest,
    questioned: executionCounts.questioned,
    currentTesters: inputs.currentTesters,
    requiredTesters: workdayProjection.requiredTesters,
    currentRatePerHour: actualRate,
    requiredRatePerHour: calculateRequiredRatePerHour(remainingCases, paceStart, WORK_DAY_END + ot, paceLunch, now),
    expectedFinish,
    projectedFinish,
    targetFinish: WORK_DAY_END,
    varianceMinutes,
    status: calculateScheduleStatus(
      inputs,
      now,
      todayWindow === null ? undefined : { start: paceStart, lunch: paceLunch },
      workdayProjection.bufferMinutes,
    ),
  };
}

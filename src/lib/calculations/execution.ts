import type { LunchWindow, MinutesOfDay, QaInputs } from '../../types';
import { advanceThroughLunch } from './schedule';

/**
 * SPO Assigned / QA Tested / QA Completed execution counts (V6.3) with the
 * V6.4 granular status breakdown.
 *
 * Single source of truth: casesCompleted is the QA-responsibility completed
 * count (it already drives every existing remaining/progress calculation),
 * and spoAssigned is the subset of it that was transferred to the SPO side:
 *
 *   QA Tested     = casesCompleted − spoAssigned   (actually executed by QA)
 *   QA Completed  = casesCompleted                 (tested + transferred)
 *   Remaining     = totalCases − casesCompleted
 *
 * Composition (V6.4): casesCompleted = Pass + Fail + N/A + SPO対応, so
 * QA Tested = Pass + Fail + N/A. Blocked / Retest / 質問中 are
 * informational open-status tallies — they never change QA Completed,
 * Remaining or any schedule calculation, and may overlap each other.
 * SPO cases are never counted as QA-tested and never merged into Pass.
 */
export interface ExecutionCounts {
  totalCases: number;
  /** Cases actually executed by QA (Pass + Fail + NA …; excludes SPO). */
  qaTested: number;
  /** Cases transferred to the SPO side (environment inaccessible to QA). */
  spoAssigned: number;
  /** QA-responsibility completed count: QA Tested + SPO Assigned. */
  qaCompleted: number;
  /** Cases still open from the QA responsibility perspective. */
  remaining: number;
  /** QA Completed / Total Cases as 0–1; null when totalCases is 0. */
  qaCompletedRatio: number | null;
  /** QA Tested / Total Cases as 0–1; null when totalCases is 0. */
  qaTestedRatio: number | null;
  // ---- V6.4 granular breakdown (derived from the canonical fields) ----
  /** Passed cases (casesPassed). */
  pass: number;
  /** Failed cases (casesFailed) — tested AND completed. */
  fail: number;
  /** N/A / 実施不可項目 cases (casesNotApplicable) — tested AND completed. */
  notApplicable: number;
  /** Blocked cases (casesBlocked) — informational, NOT completed. */
  blocked: number;
  /** Retest cases (casesRetest) — informational, NOT completed. */
  retest: number;
  /** 質問中 cases (casesQuestioned) — informational, NOT completed. */
  questioned: number;
}

/** Derive the QA-tested / SPO-assigned / QA-completed figures from the canonical inputs. */
export function calculateExecutionCounts(
  inputs: Pick<
    QaInputs,
    | 'totalCases'
    | 'casesCompleted'
    | 'spoAssigned'
    | 'casesPassed'
    | 'casesFailed'
    | 'casesNotApplicable'
    | 'casesBlocked'
    | 'casesRetest'
    | 'casesQuestioned'
  >,
): ExecutionCounts {
  const spoAssigned = Math.max(0, inputs.spoAssigned ?? 0);
  const qaCompleted = Math.max(0, inputs.casesCompleted);
  const qaTested = Math.max(0, qaCompleted - spoAssigned);
  const remaining = Math.max(0, inputs.totalCases - qaCompleted);
  return {
    totalCases: inputs.totalCases,
    qaTested,
    spoAssigned,
    qaCompleted,
    remaining,
    qaCompletedRatio: inputs.totalCases > 0 ? Math.min(1, qaCompleted / inputs.totalCases) : null,
    qaTestedRatio: inputs.totalCases > 0 ? Math.min(1, qaTested / inputs.totalCases) : null,
    pass: Math.max(0, inputs.casesPassed ?? 0),
    fail: Math.max(0, inputs.casesFailed ?? 0),
    notApplicable: Math.max(0, inputs.casesNotApplicable ?? 0),
    blocked: Math.max(0, inputs.casesBlocked ?? 0),
    retest: Math.max(0, inputs.casesRetest ?? 0),
    questioned: Math.max(0, inputs.casesQuestioned ?? 0),
  };
}

// ---- V6.4 granular input composition -----------------------------------------

/** The seven granular execution-status counts edited in the UI. */
export interface GranularExecutionStatus {
  pass: number;
  fail: number;
  notApplicable: number;
  spo: number;
  /** Informational open-status tallies — never part of completion. */
  blocked: number;
  retest: number;
  questioned: number;
}

/** Canonical fields written by the granular editor. */
export type GranularExecutionPatch = Pick<
  QaInputs,
  | 'casesCompleted'
  | 'casesPassed'
  | 'casesFailed'
  | 'casesNotApplicable'
  | 'spoAssigned'
  | 'casesBlocked'
  | 'casesRetest'
  | 'casesQuestioned'
>;

function nonNegativeInt(value: number): number {
  return Math.max(0, Math.round(value));
}

/** Read the granular status counts from canonical inputs (for UI display). */
export function granularFromInputs(
  inputs: Pick<
    QaInputs,
    'casesPassed' | 'casesFailed' | 'casesNotApplicable' | 'spoAssigned' | 'casesBlocked' | 'casesRetest' | 'casesQuestioned'
  >,
): GranularExecutionStatus {
  return {
    pass: nonNegativeInt(inputs.casesPassed ?? 0),
    fail: nonNegativeInt(inputs.casesFailed ?? 0),
    notApplicable: nonNegativeInt(inputs.casesNotApplicable ?? 0),
    spo: nonNegativeInt(inputs.spoAssigned ?? 0),
    blocked: nonNegativeInt(inputs.casesBlocked ?? 0),
    retest: nonNegativeInt(inputs.casesRetest ?? 0),
    questioned: nonNegativeInt(inputs.casesQuestioned ?? 0),
  };
}

/**
 * Compose granular inputs into the canonical raw fields — the single
 * transformation used by every granular editor (Dashboard, Daily Progress):
 *
 *   casesCompleted = Pass + Fail + N/A + SPO対応
 *
 * Pure; clamps each count to a non-negative integer. The existing engine
 * keeps consuming casesCompleted exactly as before.
 */
export function composeGranularExecution(status: GranularExecutionStatus): GranularExecutionPatch {
  const pass = nonNegativeInt(status.pass);
  const fail = nonNegativeInt(status.fail);
  const notApplicable = nonNegativeInt(status.notApplicable);
  const spo = nonNegativeInt(status.spo);
  return {
    casesCompleted: pass + fail + notApplicable + spo,
    casesPassed: pass,
    casesFailed: fail,
    casesNotApplicable: notApplicable,
    spoAssigned: spo,
    casesBlocked: nonNegativeInt(status.blocked),
    casesRetest: nonNegativeInt(status.retest),
    casesQuestioned: nonNegativeInt(status.questioned),
  };
}

/**
 * Actual team throughput: casesCompleted / productive elapsed hours (§15).
 * Lunch is already excluded from the elapsed hours by the caller.
 * Returns null while no productive time has elapsed (prevents division by zero).
 */
export function calculateActualRate(casesCompleted: number, productiveElapsedHours: number): number | null {
  if (productiveElapsedHours <= 0) return null;
  return casesCompleted / productiveElapsedHours;
}

/**
 * Projected finish from the current pace: now advanced by
 * (remainingCases / actualRate) productive minutes, skipping lunch.
 * Returns null when the rate is unavailable or nothing remains.
 */
export function calculateProjectedActualFinish(
  now: MinutesOfDay,
  remainingCases: number,
  actualRatePerHour: number | null,
  lunch: LunchWindow,
): number | null {
  if (actualRatePerHour === null || actualRatePerHour <= 0 || remainingCases <= 0) return null;
  return advanceThroughLunch(now, (remainingCases / actualRatePerHour) * 60, lunch);
}

/**
 * Schedule variance in minutes: target − projected actual finish.
 * Positive = projected to finish ahead of target, negative = behind.
 * Returns null when no projection is available yet.
 */
export function calculateScheduleVariance(projectedFinish: number | null, targetFinish: MinutesOfDay): number | null {
  if (projectedFinish === null) return null;
  return targetFinish - projectedFinish;
}

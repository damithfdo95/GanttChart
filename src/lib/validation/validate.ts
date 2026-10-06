import type { MultiDayPlanningInputs, QaInputs, QaFieldName } from '../../types';
import type { TranslationKey } from '../../i18n';
import { parseDate } from '../dates/dates';
import { parseTimeToMinutes } from '../formatting/format';
import { MAX_DAILY_OVERTIME_MINUTES } from '../calculations/workday';

/** Sanity upper bounds — far above any real QA project, low enough to keep the engine responsive. */
export const MAX_TOTAL_CASES = 1_000_000;
export const MAX_TESTERS = 1_000;

export type FieldErrors = Partial<Record<QaFieldName, TranslationKey>>;

export interface ValidationOutcome {
  isValid: boolean;
  errors: FieldErrors;
}

/**
 * Input validation (§24). Errors are i18n keys rendered inline next to the
 * offending field. Rules:
 * - 0 <= Total Cases <= MAX_TOTAL_CASES
 * - 1 <= Testers <= MAX_TESTERS
 * - Productivity > 0
 * - 0 <= Completed Cases <= Total Cases
 * - 0 <= Passed Cases <= Completed Cases (Level 2; default 0)
 * - 0 < Target Pass Rate <= 1 (Level 2; default 1)
 * - Target Finish >= Start Time
 * - Lunch End > Lunch Start (when lunch is set; an empty lunch —
 *   lunchEnd === lunchStart, e.g. both 0 — means "no lunch" and is valid)
 * - Lunch sits inside the work window
 * - SPO Assigned: 0 <= spoAssigned <= casesCompleted (V6.3)
 * - Granular status counts (V6.4): Fail / N/A / Blocked / Retest / 質問中
 *   each >= 0, and Pass + Fail + N/A + SPO <= casesCompleted
 */
export function validateInputs(inputs: QaInputs): ValidationOutcome {
  const errors: FieldErrors = {};

  if (!Number.isFinite(inputs.totalCases) || inputs.totalCases < 0) {
    errors.totalCases = 'errors.totalCasesMin';
  } else if (inputs.totalCases > MAX_TOTAL_CASES) {
    errors.totalCases = 'errors.totalCasesMax';
  }
  if (!Number.isFinite(inputs.currentTesters) || inputs.currentTesters < 1) {
    errors.currentTesters = 'errors.testersMin';
  } else if (inputs.currentTesters > MAX_TESTERS) {
    errors.currentTesters = 'errors.testersMax';
  }
  if (!Number.isFinite(inputs.perHourPerTester) || inputs.perHourPerTester <= 0) {
    errors.perHourPerTester = 'errors.productivityPositive';
  }
  // Fixed daily overtime: 0–180 minutes (optional; default 0).
  const dailyOvertimeMinutes = inputs.dailyOvertimeMinutes ?? 0;
  if (!Number.isFinite(dailyOvertimeMinutes) || dailyOvertimeMinutes < 0 || dailyOvertimeMinutes > MAX_DAILY_OVERTIME_MINUTES) {
    errors.dailyOvertimeMinutes = 'errors.dailyOvertimeRange';
  }
  if (!Number.isFinite(inputs.casesCompleted) || inputs.casesCompleted < 0) {
    errors.casesCompleted = 'errors.completedMin';
  } else if (inputs.casesCompleted > inputs.totalCases) {
    errors.casesCompleted = 'errors.completedExceeds';
  }
  // Level 2 fields: optional (defaults 0 / 1) so pre-V5 payloads stay valid.
  const casesPassed = inputs.casesPassed ?? 0;
  if (!Number.isFinite(casesPassed) || casesPassed < 0) {
    errors.casesPassed = 'errors.passedMin';
  } else if (casesPassed > inputs.casesCompleted) {
    errors.casesPassed = 'errors.passedExceedsCompleted';
  }
  // SPO-assigned cases (V6.3): part of casesCompleted (QA-responsibility
  // completed), never QA-tested. 0 <= spoAssigned <= casesCompleted, and
  // Pass cannot exceed the actually QA-tested remainder.
  const spoAssigned = inputs.spoAssigned ?? 0;
  if (!Number.isFinite(spoAssigned) || spoAssigned < 0) {
    errors.spoAssigned = 'errors.spoMin';
  } else if (spoAssigned > inputs.casesCompleted) {
    errors.spoAssigned = 'errors.spoExceedsCompleted';
  } else if (
    errors.casesPassed === undefined &&
    casesPassed > inputs.casesCompleted - spoAssigned
  ) {
    errors.casesPassed = 'errors.passedExceedsTested';
  }
  // V6.4 granular status counts: each must be finite and >= 0. Blocked /
  // Retest / 質問中 are independent informational open-status tallies — they
  // may overlap, so no upper bound or total is enforced for them.
  const casesFailed = inputs.casesFailed ?? 0;
  const casesNotApplicable = inputs.casesNotApplicable ?? 0;
  const casesBlocked = inputs.casesBlocked ?? 0;
  const casesRetest = inputs.casesRetest ?? 0;
  const casesQuestioned = inputs.casesQuestioned ?? 0;
  if (!Number.isFinite(casesFailed) || casesFailed < 0) {
    errors.casesFailed = 'errors.statusCountMin';
  }
  if (!Number.isFinite(casesNotApplicable) || casesNotApplicable < 0) {
    errors.casesNotApplicable = 'errors.statusCountMin';
  }
  if (!Number.isFinite(casesBlocked) || casesBlocked < 0) {
    errors.casesBlocked = 'errors.statusCountMin';
  }
  if (!Number.isFinite(casesRetest) || casesRetest < 0) {
    errors.casesRetest = 'errors.statusCountMin';
  }
  if (!Number.isFinite(casesQuestioned) || casesQuestioned < 0) {
    errors.casesQuestioned = 'errors.statusCountMin';
  }
  // Composition: the completed categories can never exceed casesCompleted.
  if (
    errors.casesCompleted === undefined &&
    casesPassed + casesFailed + casesNotApplicable + spoAssigned > inputs.casesCompleted
  ) {
    errors.casesCompleted = 'errors.statusCountsExceedCompleted';
  }
  const targetPassRate = inputs.targetPassRate ?? 1;
  if (!Number.isFinite(targetPassRate) || targetPassRate <= 0 || targetPassRate > 1) {
    errors.targetPassRate = 'errors.passRateRange';
  }
  if (inputs.targetFinish < inputs.startTime) {
    errors.targetFinish = 'errors.targetBeforeStart';
    errors.startTime = 'errors.targetBeforeStart';
  }
  // An empty lunch (start === end) means "no lunch" and is always valid;
  // only an inverted window (end < start) is rejected.
  if (inputs.lunchEnd < inputs.lunchStart) {
    errors.lunchEnd = 'errors.lunchOrder';
  }
  if (inputs.lunchEnd > inputs.lunchStart) {
    if (inputs.lunchStart < inputs.startTime || inputs.lunchEnd > inputs.targetFinish) {
      errors.lunchStart = 'errors.lunchWindow';
    }
    // The Plan Start Time must leave room for the (fixed) lunch break.
    if (inputs.startTime > inputs.lunchStart) {
      errors.startTime = 'errors.startAfterLunch';
    }
  }

  return { isValid: Object.keys(errors).length === 0, errors };
}

/** Per-row planning validation flags (V2). */
export interface PlanningRowErrors {
  /** Not a valid YYYY-MM-DD calendar date. */
  dateInvalid?: boolean;
  /** Not strictly after the previous row's date. */
  dateOrder?: boolean;
  /** plannedTesters is negative or not a finite number. */
  plannedTestersInvalid?: boolean;
  /** absentTesters is negative or not a finite number. */
  absentTestersInvalid?: boolean;
}

export interface PlanningValidation {
  isValid: boolean;
  /** Parallel to planningRows. */
  rowErrors: PlanningRowErrors[];
  targetDateInvalid: boolean;
  targetTimeInvalid: boolean;
}

/**
 * Multi-day planning validation (V2 §10). Two required rules are guaranteed
 * structurally by the calculation engine instead of being checked here:
 * availableTesters can never be negative (clamped by
 * calculateDailyAvailableTesters), and non-working days always yield 0 daily
 * capacity (effectiveTesters = 0 in calculateCumulativeCapacityByDay).
 */
export function validatePlanning(inputs: MultiDayPlanningInputs): PlanningValidation {
  let isValid = true;
  const rowErrors: PlanningRowErrors[] = [];
  let previous: number | null = null;
  for (const row of inputs.planningRows) {
    const errors: PlanningRowErrors = {};
    const epoch = parseDate(row.date);
    if (epoch === null) {
      errors.dateInvalid = true;
    } else {
      if (previous !== null && epoch <= previous) errors.dateOrder = true;
      previous = epoch;
    }
    if (!Number.isFinite(row.plannedTesters) || row.plannedTesters < 0) errors.plannedTestersInvalid = true;
    if (!Number.isFinite(row.absentTesters) || row.absentTesters < 0) errors.absentTestersInvalid = true;
    if (errors.dateInvalid || errors.dateOrder || errors.plannedTestersInvalid || errors.absentTestersInvalid) {
      isValid = false;
    }
    rowErrors.push(errors);
  }
  const targetDateInvalid = inputs.targetCompletionDate !== null && parseDate(inputs.targetCompletionDate) === null;
  const targetTimeInvalid = inputs.targetCompletionTime !== null && parseTimeToMinutes(inputs.targetCompletionTime) === null;
  if (targetDateInvalid || targetTimeInvalid) isValid = false;
  return { isValid, rowErrors, targetDateInvalid, targetTimeInvalid };
}

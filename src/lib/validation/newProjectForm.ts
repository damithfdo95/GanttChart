import type { ProjectLifecycleStatus, QaInputs } from '../../types';
import { formatDate, parseDate } from '../dates/dates';
import { isNonWorkingCalendarDay, nextBusinessDayEpoch } from '../dates/businessDays';
import { generateId } from '../id';
import { defaultMilestones, normalizeQaInputs } from '../storage/storage';
import { validateInputs } from './validate';
import { WORK_DAY_END, WORK_DAY_START, WORK_LUNCH } from '../calculations/workday';
import { parseTimeToMinutes } from '../formatting/format';
import type { TranslationKey } from '../../i18n';

/**
 * V6.2 — New Project form model, validation and canonical input building.
 * All functions are pure and independently testable. The form NEVER holds a
 * second copy of project state: buildProjectInputsFromForm produces the
 * canonical QaInputs (the single source of truth) consumed by the existing
 * engine, planning, dashboard and recovery analysis.
 *
 * Validation reuses the existing rules wherever possible: the semantic
 * stage runs the standard validateInputs() on the built inputs, so the form
 * can never accept a project the rest of the application would reject.
 */

/** Maximum accepted project name length. */
export const PROJECT_NAME_MAX_LENGTH = 120;

export interface NewProjectForm {
  /** Single name; written to both nameEn and nameJa (refinable later). */
  name: string;
  description: string;
  /** Free-text owner of a project made before Stage 8D (kept so the model stays complete); new projects use ownerMemberId. */
  owner: string;
  /** The owner as a Team Member (profile id from the directory); '' = no owner. */
  ownerMemberId: string;
  /** Lifecycle status; default "todo" = Scheduled (created, not started). */
  status: ProjectLifecycleStatus;
  totalCases: string;
  currentTesters: string;
  perHourPerTester: string;
  /** Fixed daily overtime minutes (0–180) as a string for the input field. */
  dailyOvertime: string;
  /** Daily window: "HH:mm" start and end (V7). */
  startTime: string;
  endTime: string;
  /** Lunch interval taken every day (V7); default true. */
  intervalEnabled: boolean;
  /** Target pass rate in percent (e.g. "100"). */
  targetPassRate: string;
  /** YYYY-MM-DD */
  startDate: string;
  /** YYYY-MM-DD (may be later than startDate for multi-day projects) */
  targetDate: string;
}

export type NewProjectFormErrors = Partial<Record<keyof NewProjectForm, TranslationKey>>;

export interface NewProjectValidation {
  isValid: boolean;
  errors: NewProjectFormErrors;
  /** The canonical inputs when every field parses; null otherwise. */
  inputs: QaInputs | null;
}

/**
 * Defaults derived from the existing DEMO_STATE configuration (§20):
 * 8 testers, 4 cases/hour/tester, 100% pass target, status Scheduled.
 * Total cases have no default — they are required input. The daily work
 * window is the fixed workday model (9:00–17:30, lunch 12:00–13:00).
 */
export function defaultNewProjectForm(startDate: string): NewProjectForm {
  return {
    name: '',
    description: '',
    owner: '',
    ownerMemberId: '',
    status: 'todo',
    totalCases: '',
    currentTesters: '8',
    perHourPerTester: '4',
    dailyOvertime: '0',
    startTime: '09:00',
    endTime: '17:30',
    intervalEnabled: true,
    targetPassRate: '100',
    startDate,
    targetDate: startDate,
  };
}

function parseWholeNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n;
}

function parsePositiveNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * One planning row per BUSINESS day from start to target (inclusive).
 * Weekends and Japanese public holidays are never planned — a start (or
 * target) on a non-working day snaps to the next business day.
 */
export function buildPlanningRows(startDate: string, targetDate: string, testers: number): QaInputs['planningRows'] {
  const start = parseDate(startDate);
  const target = parseDate(targetDate);
  const lastDay = start !== null && target !== null && target >= start ? target : start;
  const rows: QaInputs['planningRows'] = [];
  if (start === null) return rows;
  for (
    let epoch = start;
    lastDay !== null && epoch <= lastDay;
    epoch = nextBusinessDayEpoch(epoch)
  ) {
    if (isNonWorkingCalendarDay(epoch)) continue; // defensive; nextBusinessDayEpoch already skips
    rows.push({
      id: generateId(),
      date: formatDate(epoch),
      plannedTesters: Math.max(1, testers),
      absentTesters: 0,
      nonWorkingDay: false,
      note: '',
    });
  }
  return rows;
}

/**
 * Build the canonical project inputs from a form. Assumes the form passed
 * validation (callers use validateNewProjectForm first); unparsable values
 * fall back to neutral defaults so the function stays total.
 */
export function buildProjectInputsFromForm(form: NewProjectForm): QaInputs {
  const totalCases = parseWholeNumber(form.totalCases) ?? 0;
  // Parsed values pass through unclamped so the shared validateInputs()
  // stage flags out-of-range values (e.g. 0 testers) with the standard
  // localized errors instead of silently rewriting user input.
  const testers = parseWholeNumber(form.currentTesters) ?? 1;
  const rate = parsePositiveNumber(form.perHourPerTester) ?? 1;
  const overtimeMinutes = parseWholeNumber(form.dailyOvertime) ?? 0;
  const passRatePct = parsePositiveNumber(form.targetPassRate) ?? 100;
  const startTime = parseTimeToMinutes(form.startTime) ?? WORK_DAY_START;
  const endTime = parseTimeToMinutes(form.endTime) ?? WORK_DAY_END;
  return normalizeQaInputs({
    totalCases,
    currentTesters: testers,
    startTime,
    targetFinish: endTime,
    lunchStart: WORK_LUNCH.start,
    lunchEnd: WORK_LUNCH.end,
    perHourPerTester: rate,
    dailyOvertimeMinutes: overtimeMinutes,
    intervalEnabled: form.intervalEnabled,
    casesCompleted: 0,
    casesPassed: 0,
    spoAssigned: 0,
    casesFailed: 0,
    casesNotApplicable: 0,
    casesBlocked: 0,
    casesRetest: 0,
    casesQuestioned: 0,
    targetPassRate: passRatePct / 100,
    dailyTargetOverrides: [],
    dailyActuals: [],
    blockingEvents: [],
    milestones: defaultMilestones(),
    startDate: form.startDate,
    targetCompletionDate: form.targetDate,
    targetCompletionTime: null,
    planningRows: buildPlanningRows(form.startDate, form.targetDate, testers),
  });
}

/**
 * Validate the form. Stage 1 checks parsing/required fields; stage 2 builds
 * the canonical inputs and runs the EXISTING validateInputs() on them, so
 * lunch windows, target-before-start and all other shared rules behave
 * exactly like everywhere else in the application.
 */
export function validateNewProjectForm(form: NewProjectForm): NewProjectValidation {
  const errors: NewProjectFormErrors = {};

  // ---- Stage 1: required / parse ------------------------------------------
  const name = form.name.trim();
  if (name === '') errors.name = 'errors.projectNameRequired';
  else if (name.length > PROJECT_NAME_MAX_LENGTH) errors.name = 'errors.projectNameTooLong';

  if (form.totalCases.trim() === '') errors.totalCases = 'errors.totalCasesRequired';
  else if (parseWholeNumber(form.totalCases) === null) errors.totalCases = 'errors.numberInvalid';

  if (parseWholeNumber(form.currentTesters) === null) errors.currentTesters = 'errors.numberInvalid';
  if (parsePositiveNumber(form.perHourPerTester) === null) errors.perHourPerTester = 'errors.numberInvalid';

  // Daily overtime: optional-looking field with a hard 0–180 range (the same
  // shared rule the Dashboard INPUT section enforces).
  const overtimeMinutes = parseWholeNumber(form.dailyOvertime);
  if (overtimeMinutes === null || overtimeMinutes < 0 || overtimeMinutes > 180) {
    errors.dailyOvertime = 'errors.dailyOvertimeRange';
  }

  // V7 daily window: both times must parse and the start must precede the end.
  const startTimeMinutes = parseTimeToMinutes(form.startTime);
  const endTimeMinutes = parseTimeToMinutes(form.endTime);
  if (startTimeMinutes === null) errors.startTime = 'errors.timeInvalid';
  if (endTimeMinutes === null) errors.endTime = 'errors.timeInvalid';
  if (startTimeMinutes !== null && endTimeMinutes !== null && startTimeMinutes >= endTimeMinutes) {
    errors.endTime = 'errors.windowOrder';
  }

  const passRate = parseWholeNumber(form.targetPassRate);
  if (passRate === null || passRate < 1 || passRate > 100) errors.targetPassRate = 'errors.passRateRange';

  if (form.startDate.trim() === '') errors.startDate = 'errors.dateRequired';
  else if (parseDate(form.startDate) === null) errors.startDate = 'errors.dateInvalid';
  if (form.targetDate.trim() === '') errors.targetDate = 'errors.dateRequired';
  else if (parseDate(form.targetDate) === null) errors.targetDate = 'errors.dateInvalid';
  if (errors.startDate === undefined && errors.targetDate === undefined) {
    const start = parseDate(form.startDate);
    const target = parseDate(form.targetDate);
    if (start !== null && target !== null && target < start) errors.targetDate = 'errors.targetDateBeforeStart';
  }

  const inputs = buildProjectInputsFromForm(form);

  // ---- Stage 2: existing semantic rules on the canonical inputs ----------
  const semantic = validateInputs(inputs);
  if (semantic.errors.totalCases !== undefined && errors.totalCases === undefined) {
    errors.totalCases = semantic.errors.totalCases;
  }
  if (semantic.errors.currentTesters !== undefined && errors.currentTesters === undefined) {
    errors.currentTesters = semantic.errors.currentTesters;
  }
  if (semantic.errors.perHourPerTester !== undefined && errors.perHourPerTester === undefined) {
    errors.perHourPerTester = semantic.errors.perHourPerTester;
  }
  if (semantic.errors.targetPassRate !== undefined && errors.targetPassRate === undefined) {
    errors.targetPassRate = semantic.errors.targetPassRate;
  }

  const hasErrors = Object.keys(errors).length > 0;
  return { isValid: !hasErrors, errors, inputs: hasErrors ? null : inputs };
}

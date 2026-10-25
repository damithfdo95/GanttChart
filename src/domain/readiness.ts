import type { BugTicket, CaseExecutionEvent, CaseResult, ProjectRecord, RcsMember, TestCase, TestScope, TesterProjectAssignment } from '../types';
import { daysBetween, projectMetrics, projectRiskSignals } from './qaMetrics';
import { isProjectOverdue, projectPlanningStatus, projectProgress, projectProjection } from './projects/selectors';
import { actualTesterCountForDate, assignedTesterCountForProject } from './testerCapacity';
import { assessDetailedCoverage, isCaseDerivedAggregateStale, reconcileDailyExecution } from './executionReconciliation';
import { dailyDetailedSummary } from './testManagement';
import { defaultQaPolicy, isDefaultQaPolicy, type QaPolicy } from '../../shared/qaPolicy';

/**
 * Release readiness: a rule-based, explainable assessment of one project - Ready, At Risk or Blocked - that always carries the
 * reasons behind it. There is deliberately NO numeric score.
 *
 * Precedence: any blocking reason => Blocked; else any warning => At Risk; else Ready. Informational reasons never change the state.
 *
 * Everything is derived from data already persisted in the app (never a live TestRail or JIRA request) and from selectors that already
 * exist (schedule / planning status, risk signals and thresholds, staffing counts, coverage and reconciliation); nothing here
 * recalculates a schedule or invents a threshold. It is read-only and deterministic: the business date and clock are INJECTED.
 *
 * What is, and is not, "Blocked" is the QA team's POLICY (an explicit input; `defaultQaPolicy()` reproduces the original behavior):
 *  - By default: an UNRESOLVED defect of a release-blocking severity (Critical, status Open / In Progress) blocks. Severity is never
 *    guessed from text. A blocking-severity ticket with no recorded status is only a warning (it may already be resolved).
 *  - By default NOT blocking: failed or blocked test cases (At Risk; a team may choose Blocked), an overdue project with testing left
 *    (release completion is not defined as mandatory anywhere in the model), partial detailed coverage and aggregate-vs-detail
 *    differences (data quality, never release risk).
 * A policy changes a reason's SEVERITY (and so the state), never its code. No rule requires any particular kind of QA work to exist.
 */

export type ReadinessState = 'ready' | 'atRisk' | 'blocked';
export type ReadinessSeverity = 'info' | 'warning' | 'blocking';
export type ReadinessCategory = 'execution' | 'defects' | 'coverage' | 'staffing' | 'schedule' | 'dataQuality';
/** `evaluated`: the state is the full assessment. Others: the lifecycle says readiness is not (yet) the question. */
export type ReadinessApplicability = 'evaluated' | 'notStarted' | 'onHold' | 'completed';

export type ReadinessCode =
  | 'critical_defect_open'
  | 'critical_defect_status_unknown'
  | 'blocked_cases_open'
  | 'project_overdue'
  | 'projected_finish_late'
  | 'capacity_shortage'
  | 'execution_incomplete'
  | 'test_failures_open'
  | 'no_recent_activity'
  | 'no_execution_today'
  | 'no_execution_data'
  | 'insufficient_plan_data'
  | 'staffing_gap'
  | 'actual_below_planned'
  | 'detailed_coverage_partial'
  | 'case_aggregate_stale'
  | 'reconciliation_difference'
  | 'completed_exceeds_planned'
  | 'no_target_date'
  | 'no_defect_data'
  | 'not_started';

export interface ReadinessReason {
  /** Stable machine-readable id (never a translated label). */
  code: ReadinessCode;
  severity: ReadinessSeverity;
  category: ReadinessCategory;
  /** i18n key of the sentence; `metadata` fills its placeholders. No translated text lives in the domain. */
  messageKey: `readiness.reason.${ReadinessCode}`;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface ReadinessMetrics {
  /** completed / planned, from the existing execution metrics (null without a total). */
  progress: number | null;
  failed: number;
  blocked: number;
  remaining: number;
  /** Whole days the projected finish is after the planned end date (null when not late or not comparable). */
  daysLate: number | null;
  planned: number;
  assigned: number;
  actualToday: number | null;
  /** planned - assigned (positive: positions not assigned yet). */
  staffingGap: number;
}

export interface ReleaseReadiness {
  state: ReadinessState;
  applicability: ReadinessApplicability;
  /** True when the QA policy in force differs from the default (the UI then says which policy produced the state). */
  policyCustom: boolean;
  /** Deterministically ordered, de-duplicated. */
  reasons: ReadinessReason[];
  metrics: ReadinessMetrics;
}

export interface ReadinessInput {
  project: ProjectRecord;
  scopes?: readonly TestScope[];
  cases?: readonly TestCase[];
  caseResults?: readonly CaseResult[];
  caseExecution?: readonly CaseExecutionEvent[];
  /** Defaults to the project's own recorded tickets. Always filtered to this project. */
  tickets?: readonly BugTicket[];
  assignments?: readonly TesterProjectAssignment[];
  members?: readonly RcsMember[];
  /** The business date (YYYY-MM-DD). Injected: the selector never reads the clock. */
  today: string;
  /** The current instant (ISO), injected, for the existing "no recent update" rule. */
  nowIso: string;
  /** The QA team's policy. Explicit input - never read from global state. Omitted = the default policy. */
  policy?: QaPolicy;
}

const SEVERITY_RANK: Record<ReadinessSeverity, number> = { blocking: 0, warning: 1, info: 2 };

/** Display order: blockers, execution blockers, schedule, completeness / failures, staffing, coverage and data quality. */
const ORDER: Record<ReadinessCode, number> = {
  critical_defect_open: 1,
  critical_defect_status_unknown: 2,
  blocked_cases_open: 3,
  project_overdue: 4,
  projected_finish_late: 5,
  capacity_shortage: 6,
  execution_incomplete: 7,
  test_failures_open: 8,
  no_recent_activity: 9,
  no_execution_today: 9.5,
  no_execution_data: 10,
  insufficient_plan_data: 11,
  staffing_gap: 12,
  actual_below_planned: 13,
  detailed_coverage_partial: 14,
  case_aggregate_stale: 15,
  reconciliation_difference: 16,
  completed_exceeds_planned: 17,
  no_target_date: 18,
  no_defect_data: 19,
  not_started: 20,
};

/** Every reason code, in display order (for completeness checks and analytics). */
export const READINESS_CODES = (Object.keys(ORDER) as ReadinessCode[]).sort((x, y) => ORDER[x] - ORDER[y]);

const reason = (code: ReadinessCode, severity: ReadinessSeverity, category: ReadinessCategory, metadata?: ReadinessReason['metadata']): ReadinessReason => ({
  code,
  severity,
  category,
  messageKey: `readiness.reason.${code}`,
  ...(metadata === undefined ? {} : { metadata }),
});

/** The one central readiness selector. Pure and deterministic; it never mutates its inputs. */
export function evaluateReleaseReadiness(input: ReadinessInput): ReleaseReadiness {
  const { project, today } = input;
  const policy = input.policy ?? defaultQaPolicy();
  const policyCustom = !isDefaultQaPolicy(policy);
  const assignments = input.assignments ?? [];
  const progress = projectProgress(project);
  const m = projectMetrics(project);
  const planned = project.inputs.currentTesters;
  const assigned = assignedTesterCountForProject(assignments, project.projectId, today, input.members ?? []);
  const actualToday = actualTesterCountForDate(project.inputs.dailyExecuted ?? [], today);
  const metrics: ReadinessMetrics = { progress: progress.ratio, failed: m.failed, blocked: m.blocked, remaining: progress.remaining, daysLate: null, planned, assigned, actualToday, staffingGap: planned - assigned };

  // Lifecycle: paused and finished projects are not asked "is it ready to ship?" (their lifecycle is the answer).
  if (project.status === 'onHold') return { state: 'ready', applicability: 'onHold', policyCustom, reasons: [], metrics };
  if (project.status === 'done') return { state: 'ready', applicability: 'completed', policyCustom, reasons: [], metrics };
  const notStarted = project.status === 'todo';

  const reasons: ReadinessReason[] = [];
  const add = (r: ReadinessReason): void => {
    if (!reasons.some((x) => x.code === r.code)) reasons.push(r);
  };

  // ---- defects: this project's recorded tickets only ----
  const tickets = (input.tickets ?? project.inputs.bugTickets ?? []).filter((x) => x.projectId === project.projectId);
  const critical = tickets.filter((x) => x.severity !== undefined && (policy.blockingDefectSeverities as readonly string[]).includes(x.severity));
  const unresolved = new Set<string>(policy.unresolvedDefectStatuses);
  const criticalOpen = critical.filter((x) => x.status !== undefined && unresolved.has(x.status));
  const criticalUnknown = critical.filter((x) => x.status === undefined);
  if (criticalOpen.length > 0) add(reason('critical_defect_open', policy.defectsAction === 'blocked' ? 'blocking' : 'warning', 'defects', { count: criticalOpen.length, tickets: criticalOpen.slice(0, 3).map((x) => x.ticketKey ?? x.title).join(', '), severities: policy.blockingDefectSeverities.join(' + '), statuses: policy.unresolvedDefectStatuses.join(' / ') }));
  if (criticalUnknown.length > 0) add(reason('critical_defect_status_unknown', 'warning', 'defects', { count: criticalUnknown.length }));
  if (tickets.length === 0) add(reason('no_defect_data', 'info', 'defects'));

  // ---- schedule and execution: existing selectors and thresholds ----
  const signals = projectRiskSignals(project, { today, nowIso: input.nowIso, assignments });
  const overdue = isProjectOverdue(project, today) && progress.remaining > 0;
  const planning = projectPlanningStatus(project);
  const projection = projectProjection(project);
  const target = project.inputs.targetCompletionDate;
  let daysLate: number | null = null;
  if (target !== null && projection.projectedCompletion !== null) {
    const late = daysBetween(target, projection.projectedCompletion.date);
    daysLate = late > 0 ? late : null;
  }
  metrics.daysLate = daysLate;

  if (overdue) add(reason('project_overdue', 'warning', 'schedule', { remaining: progress.remaining, daysOverdue: daysBetween(target as string, today) }));
  else if (planning === 'capacityShortage') add(reason('capacity_shortage', 'warning', 'schedule', { shortage: projection.shortageByDeadline ?? 0, remaining: progress.remaining }));
  else if (planning === 'atRisk') add(reason('projected_finish_late', 'warning', 'schedule', { daysLate, planned: target, projected: projection.projectedCompletion?.date ?? null }));
  if (target === null && !notStarted && progress.remaining > 0) add(reason('no_target_date', 'info', 'dataQuality'));

  const dueSoon = signals.find((s) => s.code === 'due_soon_much_remaining');
  if (dueSoon !== undefined && !overdue) add(reason('execution_incomplete', 'warning', 'execution', { remaining: progress.remaining, daysLeft: dueSoon.value ?? null }));
  const blockedSeverity: ReadinessSeverity = policy.blockedCases === 'blocked' ? 'blocking' : policy.blockedCases === 'info' ? 'info' : 'warning';
  if (m.blocked > 0) add(reason('blocked_cases_open', blockedSeverity, 'execution', { count: m.blocked }));
  if (m.failed > 0) add(reason('test_failures_open', policy.failedCases === 'blocked' ? 'blocking' : 'warning', 'execution', { count: m.failed }));
  const idle = signals.find((s) => s.code === 'no_recent_activity');
  if (idle !== undefined) add(reason('no_recent_activity', 'warning', 'execution', { days: idle.value ?? null }));
  if (signals.some((s) => s.code === 'completed_exceeds_planned')) add(reason('completed_exceeds_planned', 'info', 'dataQuality'));

  // ---- insufficient evidence (never "Ready" by silence) ----
  if (!notStarted) {
    if (project.inputs.totalCases <= 0) add(reason('insufficient_plan_data', 'warning', 'dataQuality'));
    else if (project.inputs.startDate <= today && (project.inputs.dailyExecuted ?? []).length === 0 && project.inputs.casesCompleted <= 0 && progress.remaining > 0) add(reason('no_execution_data', policy.missingExecution === 'info' ? 'info' : 'warning', 'dataQuality'));
  }

  // ---- staffing: a warning only when it is part of a schedule / capacity problem ----
  if (assigned < planned) {
    const scheduleRisk = reasons.some((r) => r.category === 'schedule' || r.code === 'execution_incomplete');
    const gapSeverity: ReadinessSeverity = policy.staffingGap === 'alwaysAtRisk' ? 'warning' : policy.staffingGap === 'informational' ? 'info' : scheduleRisk ? 'warning' : 'info';
    add(reason('staffing_gap', gapSeverity, 'staffing', { planned, assigned, gap: planned - assigned }));
  }
  if (actualToday !== null && actualToday < planned) add(reason('actual_below_planned', 'info', 'staffing', { planned, actual: actualToday }));

  // ---- detailed coverage and reconciliation: observability, not release risk ----
  const scopes = input.scopes ?? [];
  const cases = input.cases ?? [];
  const events = (input.caseExecution ?? []).filter((e) => e.projectId === project.projectId);
  if (events.length > 0) {
    const coverage = assessDetailedCoverage({ date: today, projectId: project.projectId, scopes, cases, events, results: input.caseResults ?? [] });
    if (coverage.state === 'partial') add(reason('detailed_coverage_partial', 'info', 'coverage'));
    const saved = (project.inputs.dailyExecuted ?? []).find((e) => e.date === today) ?? null;
    if (saved !== null) {
      const summary = dailyDetailedSummary({ date: today, projectId: project.projectId, scopes, cases, events });
      if (isCaseDerivedAggregateStale(saved, summary)) add(reason('case_aggregate_stale', 'info', 'dataQuality'));
      else if (coverage.state === 'complete' && reconcileDailyExecution({ date: today, today, savedDaily: saved, summary, coverage, isSv: true }).state === 'difference') add(reason('reconciliation_difference', 'info', 'dataQuality'));
    }
  }
  // A planned working day today with nothing recorded yet: something for the supervisor to chase, never a readiness state on its own.
  if (!notStarted && progress.remaining > 0 && project.inputs.planningRows.some((r) => r.date === today && !r.nonWorkingDay) && actualToday === null && (project.inputs.dailyExecuted ?? []).length > 0) add(reason('no_execution_today', 'info', 'execution'));
  if (notStarted) add(reason('not_started', 'info', 'schedule'));

  reasons.sort((a, b) => ORDER[a.code] - ORDER[b.code] || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.code.localeCompare(b.code));
  const state: ReadinessState = reasons.some((r) => r.severity === 'blocking') ? 'blocked' : reasons.some((r) => r.severity === 'warning') ? 'atRisk' : 'ready';
  return { state, applicability: notStarted ? 'notStarted' : 'evaluated', policyCustom, reasons, metrics };
}

/**
 * Informational reasons that are still the supervisor's to chase today (they never change the state): a planned day with nothing
 * recorded, an out-of-date case-derived aggregate, a staffing gap or a lower turnout. Reuses the readiness reasons - no second engine.
 */
export const ATTENTION_INFO_CODES: readonly ReadinessCode[] = ['no_execution_today', 'case_aggregate_stale', 'staffing_gap', 'actual_below_planned'];

export function attentionItems(r: ReleaseReadiness): ReadinessReason[] {
  return r.reasons.filter((x) => x.severity === 'info' && ATTENTION_INFO_CODES.includes(x.code));
}

/** Readiness is management information: a Tester (whose view of tickets, scopes and counts is restricted) does not get it. */
export function canViewReadiness(access: { isTester: boolean }): boolean {
  return !access.isTester;
}

/** What to show in a badge: the state, or the lifecycle label when readiness is not the question and nothing was found. */
export function readinessBadgeKey(r: ReleaseReadiness): 'blocked' | 'atRisk' | 'ready' | 'notStarted' | 'onHold' | 'completed' {
  if (r.applicability === 'evaluated') return r.state;
  if (r.applicability !== 'notStarted') return r.applicability;
  return r.reasons.some((x) => x.severity !== 'info') ? r.state : 'notStarted';
}

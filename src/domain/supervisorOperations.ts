import { businessDate } from '../../shared/businessTime';
import { defaultQaPolicy, type QaPolicy } from '../../shared/qaPolicy';
import type { BugTicket, CaseExecutionEvent, CaseResult, DailyExecutionEntry, ProjectRecord, RcsMember, TestCase, TestScope, TesterProjectAssignment } from '../types';
import { evaluateReleaseReadiness, ATTENTION_INFO_CODES, type ReadinessCode, type ReadinessReason, type ReadinessSeverity, type ReleaseReadiness } from './readiness';
import { projectPlanningStatus, projectProjection } from './projects/selectors';
import { personKey, actualTesterCountForDate } from './testerCapacity';
import { entryCompletedCases } from '../lib/calculations/dailyExecuted';
import { dailyDetailedSummary, eventBusinessDate, sortEventsAscending, type DailyDetailedSummary } from './testManagement';
import { workTypeOf, workMixOfProject, type WorkMixRow, type WorkTypeKey } from './qaWork';
import { QA_WORK_TYPES } from '../../shared/qaPolicy';
import { executionSourceOf, type ExecutionSource } from './executionSource';

/**
 * The supervisor's daily operating view, derived ENTIRELY from state the app already holds (nothing is stored, nothing is fetched).
 * One workspace is one QA team: this never aggregates across teams.
 *
 * Time semantics, kept explicit:
 *  - DAY data follows `selectedDate`: the saved Daily Execution, the case-execution history of that Tokyo business day, the actual
 *    testers, the day's changes.
 *  - CURRENT data is "now", whatever date is selected: release readiness, open tickets, assignments, the schedule forecast.
 *    The result says which is which (`selectedDate` / `isHistorical`) so the screen can label current sections.
 *
 * Units are never mixed: test cases, JIRA tickets, execution events, unique cases and testers are separate fields.
 */

export interface SupervisorOpsInput {
  projects: readonly ProjectRecord[];
  scopes: readonly TestScope[];
  cases: readonly TestCase[];
  caseResults?: readonly CaseResult[];
  caseExecution?: readonly CaseExecutionEvent[];
  assignments?: readonly TesterProjectAssignment[];
  members?: readonly RcsMember[];
  /** Defaults to each project's own recorded tickets. */
  tickets?: readonly BugTicket[];
  policy?: QaPolicy;
  /** The business day the day-based sections describe (YYYY-MM-DD). */
  selectedDate: string;
  /** The current business day (injected; the selector reads no clock). */
  today: string;
  nowIso: string;
}

export type AttentionCategory = 'defect' | 'schedule' | 'execution' | 'staffing' | 'dataQuality';
export type AttentionPriority = 1 | 2 | 3;

/** One thing for the supervisor to look at, taken from a readiness reason (there is no second risk engine). */
export interface SupervisorAttentionItem {
  projectId: string;
  /** The project record id (for navigation) and its display name. */
  projectRecordId: string;
  projectName: string;
  reasonCode: ReadinessCode;
  severity: ReadinessSeverity;
  category: AttentionCategory;
  /** 1 blocking; 2 schedule / execution / defect risk; 3 staffing, operational and data-quality notes. */
  priority: AttentionPriority;
  reason: ReadinessReason;
}

const CATEGORY_OF: Record<ReadinessCode, AttentionCategory> = {
  critical_defect_open: 'defect',
  critical_defect_status_unknown: 'defect',
  blocked_cases_open: 'execution',
  project_overdue: 'schedule',
  projected_finish_late: 'schedule',
  capacity_shortage: 'schedule',
  execution_incomplete: 'execution',
  test_failures_open: 'execution',
  no_recent_activity: 'execution',
  no_execution_today: 'execution',
  no_execution_data: 'execution',
  insufficient_plan_data: 'dataQuality',
  staffing_gap: 'staffing',
  actual_below_planned: 'staffing',
  detailed_coverage_partial: 'dataQuality',
  case_aggregate_stale: 'dataQuality',
  reconciliation_difference: 'dataQuality',
  completed_exceeds_planned: 'dataQuality',
  no_target_date: 'dataQuality',
  no_defect_data: 'defect',
  not_started: 'schedule',
};
const CATEGORY_RANK: Record<AttentionCategory, number> = { defect: 0, schedule: 1, execution: 2, staffing: 3, dataQuality: 4 };
const SEVERITY_RANK: Record<ReadinessSeverity, number> = { blocking: 0, warning: 1, info: 2 };

function priorityOf(r: ReadinessReason, category: AttentionCategory): AttentionPriority {
  if (r.severity === 'blocking') return 1;
  if (r.severity === 'warning' && category !== 'staffing' && category !== 'dataQuality') return 2;
  return 3;
}

export interface WorkTypeDay {
  workType: WorkTypeKey;
  scopes: number;
  /** Detailed case history of the day for the scopes of this work type (unique cases and events are different numbers). */
  uniqueCasesExecuted: number;
  executionEvents: number;
  passed: number;
  failed: number;
  blocked: number;
}

export interface ProjectDayOps {
  projectRecordId: string;
  projectId: string;
  projectName: string;
  status: ProjectRecord['status'];
  /** Counts for the work of the project's active scopes, by work type (current structure). */
  workMix: WorkMixRow[];
  workTypes: WorkTypeKey[];
  /** CURRENT release readiness (never historical). */
  readiness: ReleaseReadiness;
  staffing: { planned: number; assigned: number; actual: number | null; gap: number };
  /** The SAVED daily aggregate of the selected date (the authority), project level. */
  saved: { executed: number; passed: number; failed: number; blocked: number; source: ExecutionSource; testers: number } | null;
  /** The detailed case history of the selected date, shown beside the saved figures, never replacing them. */
  detailed: DailyDetailedSummary;
  detailedByWorkType: WorkTypeDay[];
  schedule: { plannedEnd: string | null; projectedFinish: string | null; state: 'onTrack' | 'late' | 'completed' | 'noTarget' | 'onHold'; daysLate: number | null };
  /** CURRENT recorded tickets: units are tickets, not test cases. */
  tickets: { criticalUnresolved: number; openOrInProgress: number; statusUnknownCritical: number };
  /** The project had execution on the selected day (it is listed even if no longer an active project). */
  hadExecution: boolean;
}

export interface TesterAllocation {
  key: string;
  name: string;
  assignments: Array<{ projectId: string; projectName: string; scopeId: string | null; workType: WorkTypeKey | null }>;
  /** Selected day, factual: execution events and unique cases attributed to this person (stable member identity only). */
  eventsToday: number;
  uniqueCasesToday: number;
  /** Cases tested on the day from the person's own Performance record, when one exists. */
  recordedCasesToday: number | null;
  noExecutionRecorded: boolean;
}

export interface DailyChanges {
  /** Cases whose very first execution event is on the selected day. */
  casesFirstExecuted: number;
  passEvents: number;
  failEvents: number;
  blockedEvents: number;
  retestRaised: number;
  /** Cases whose final status of the day differs from the status they had before the day. */
  casesStatusChanged: number;
  casesNewlyPassed: number;
  casesNewlyFailed: number;
  /** Critical tickets recorded (created) on the day. */
  criticalTicketsRecorded: number;
}

export interface DayMetrics {
  date: string;
  uniqueCasesExecuted: number;
  failedCases: number;
  savedExecuted: number;
  actualTesters: number;
}

export interface SupervisorDailySummary {
  activeProjects: number;
  readyProjects: number;
  atRiskProjects: number;
  blockedProjects: number;
  plannedTesters: number;
  /** Distinct people assigned across active projects (one person on two projects counts once). */
  assignedTesters: number;
  /** Sum of the projects' actual testers on the day (head counts recorded per project). */
  actualTesters: number;
  /** Distinct people with recorded execution on the day (stable identities). */
  testersWithExecution: number;
  execution: { savedExecuted: number; savedPassed: number; savedFailed: number; savedBlocked: number; uniqueCasesExecuted: number; executionEvents: number };
  workTypeBreakdown: Array<{ workType: WorkTypeKey; cases: number; scopes: number }>;
  attentionItems: SupervisorAttentionItem[];
}

export interface SupervisorDailyOperations {
  selectedDate: string;
  today: string;
  isHistorical: boolean;
  summary: SupervisorDailySummary;
  /** Active projects plus any project that had execution on the day, in a stable order. */
  projects: ProjectDayOps[];
  /** Projects needing attention, rule-based: readiness state, then schedule risk, critical defects, failures, name. */
  projectRanking: string[];
  allocation: TesterAllocation[];
  changes: DailyChanges;
  /** Compared with the most recent earlier day that has any recorded activity (null when there is none). */
  comparison: { previous: DayMetrics; current: DayMetrics } | null;
  failures: { failedToday: number; blockedToday: number; items: Array<{ projectId: string; projectName: string; scopeName: string; key: string; title: string; status: 'fail' | 'blocked' }>; topScopes: Array<{ scopeId: string; scopeName: string; failed: number }> };
}

const ACTIVE: ReadonlySet<string> = new Set(['ongoing', 'extended']);
const nameOf = (p: ProjectRecord): string => (p.nameEn !== '' ? p.nameEn : p.nameJa) || p.projectId;

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Project inclusion rule: the default operating set is the ACTIVE projects (Ongoing / Extended). A project in any other state
 * (planned, on hold, completed) appears only for a day on which it actually had execution (a saved entry or case events).
 */
function included(p: ProjectRecord, date: string, events: readonly CaseExecutionEvent[]): boolean {
  if (ACTIVE.has(p.status)) return true;
  if ((p.inputs.dailyExecuted ?? []).some((e) => e.date === date)) return true;
  return events.some((e) => e.projectId === p.projectId && eventBusinessDate(e) === date);
}

export function buildSupervisorDailyOperations(input: SupervisorOpsInput): SupervisorDailyOperations {
  const policy = input.policy ?? defaultQaPolicy();
  const events = input.caseExecution ?? [];
  const assignments = input.assignments ?? [];
  const members = input.members ?? [];
  const { selectedDate, today } = input;
  const selected = input.projects.filter((p) => included(p, selectedDate, events));

  const unresolved = new Set<string>(policy.unresolvedDefectStatuses);
  const blockingSev = new Set<string>(policy.blockingDefectSeverities);

  const projects: ProjectDayOps[] = selected.map((project) => {
    const readiness = evaluateReleaseReadiness({ project, scopes: input.scopes, cases: input.cases, caseResults: input.caseResults ?? [], caseExecution: events, assignments, members, ...(input.tickets === undefined ? {} : { tickets: input.tickets }), policy, today, nowIso: input.nowIso });
    const entry = (project.inputs.dailyExecuted ?? []).find((e) => e.date === selectedDate) ?? null;
    const mine = events.filter((e) => e.projectId === project.projectId);
    const detailed = dailyDetailedSummary({ date: selectedDate, projectId: project.projectId, scopes: input.scopes, cases: input.cases, events: mine, fallbackTotal: project.inputs.totalCases });
    const scopes = input.scopes.filter((s) => s.projectId === project.projectId && s.status === 'active');
    const byType = new Map<WorkTypeKey, WorkTypeDay>();
    for (const scope of scopes) {
      const key = workTypeOf(scope);
      const d = dailyDetailedSummary({ date: selectedDate, projectId: project.projectId, scopeId: scope.id, scopes: input.scopes, cases: input.cases, events: mine });
      const row = byType.get(key) ?? { workType: key, scopes: 0, uniqueCasesExecuted: 0, executionEvents: 0, passed: 0, failed: 0, blocked: 0 };
      row.scopes += 1;
      row.uniqueCasesExecuted += d.uniqueCasesExecuted;
      row.executionEvents += d.eventCount;
      row.passed += d.passed;
      row.failed += d.failed;
      row.blocked += d.blocked;
      byType.set(key, row);
    }
    const order: WorkTypeKey[] = [...QA_WORK_TYPES, 'unspecified'];
    const detailedByWorkType = order.flatMap((k) => (byType.has(k) ? [byType.get(k) as WorkTypeDay] : []));
    const mix = workMixOfProject(project.projectId, input.scopes, input.cases);

    const planning = projectPlanningStatus(project);
    const projection = projectProjection(project);
    const late = readiness.reasons.some((r) => r.code === 'project_overdue' || r.code === 'projected_finish_late' || r.code === 'capacity_shortage');
    const schedule: ProjectDayOps['schedule'] = {
      plannedEnd: project.inputs.targetCompletionDate,
      projectedFinish: projection.projectedCompletion?.date ?? null,
      state: project.status === 'onHold' ? 'onHold' : planning === 'completed' ? 'completed' : planning === 'noTarget' ? 'noTarget' : late ? 'late' : 'onTrack',
      daysLate: readiness.metrics.daysLate,
    };
    const tickets = (input.tickets ?? project.inputs.bugTickets ?? []).filter((t) => t.projectId === project.projectId);
    return {
      projectRecordId: project.id,
      projectId: project.projectId,
      projectName: nameOf(project),
      status: project.status,
      workMix: mix,
      workTypes: mix.map((m) => m.workType),
      readiness,
      staffing: { planned: readiness.metrics.planned, assigned: readiness.metrics.assigned, actual: actualTesterCountForDate(project.inputs.dailyExecuted ?? [], selectedDate), gap: readiness.metrics.staffingGap },
      saved: entry === null ? null : { executed: entryCompletedCases(entry), passed: entry.pass, failed: entry.fail, blocked: entry.blocked, source: executionSourceOf(entry), testers: entry.testers },
      detailed,
      detailedByWorkType,
      schedule,
      tickets: {
        criticalUnresolved: tickets.filter((t) => t.severity !== undefined && blockingSev.has(t.severity) && t.status !== undefined && unresolved.has(t.status)).length,
        openOrInProgress: tickets.filter((t) => t.status === 'Open' || t.status === 'In Progress').length,
        statusUnknownCritical: tickets.filter((t) => t.severity !== undefined && blockingSev.has(t.severity) && t.status === undefined).length,
      },
      hadExecution: entry !== null || detailed.eventCount > 0,
    };
  });

  // ---- Needs Attention: readiness reasons of the ACTIVE projects, reused as they are (already de-duplicated by the readiness rules) ----
  const attention: SupervisorAttentionItem[] = [];
  for (const p of projects) {
    if (!ACTIVE.has(p.status)) continue;
    for (const r of p.readiness.reasons) {
      const category = CATEGORY_OF[r.code];
      const wanted = r.severity !== 'info' || ATTENTION_INFO_CODES.includes(r.code);
      if (!wanted) continue;
      attention.push({ projectId: p.projectId, projectRecordId: p.projectRecordId, projectName: p.projectName, reasonCode: r.code, severity: r.severity, category, priority: priorityOf(r, category), reason: r });
    }
  }
  attention.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category] || a.projectName.localeCompare(b.projectName) || a.projectId.localeCompare(b.projectId) || a.reasonCode.localeCompare(b.reasonCode));

  const active = projects.filter((p) => ACTIVE.has(p.status));
  const stateOf = (p: ProjectDayOps): ReleaseReadiness['state'] => p.readiness.state;
  const stateRank = { blocked: 0, atRisk: 1, ready: 2 } as const;
  const projectRanking = [...active]
    .sort((a, b) => stateRank[stateOf(a)] - stateRank[stateOf(b)] || Number(b.schedule.state === 'late') - Number(a.schedule.state === 'late') || b.tickets.criticalUnresolved - a.tickets.criticalUnresolved || b.readiness.metrics.failed - a.readiness.metrics.failed || a.projectName.localeCompare(b.projectName) || a.projectId.localeCompare(b.projectId))
    .map((p) => p.projectId);

  // ---- people ----
  const activeIds = new Set(active.map((p) => p.projectId));
  const byKey = new Map<string, TesterAllocation>();
  const memberById = new Map(members.map((m) => [m.id, m] as const));
  const currentAssignments = assignments.filter((a) => a.active && a.startDate <= today && (a.endDate === undefined || a.endDate >= today) && activeIds.has(a.projectId));
  const dayEvents = events.filter((e) => eventBusinessDate(e) === selectedDate && activeIds.has(e.projectId));
  for (const a of currentAssignments) {
    const key = personKey(a, members);
    if (key === null) continue;
    const memberId = key.startsWith('m:') ? key.slice(2) : undefined;
    const project = active.find((p) => p.projectId === a.projectId);
    const scope = a.scopeId === undefined ? undefined : input.scopes.find((s) => s.id === a.scopeId);
    const own = byKey.get(key) ?? { key, name: (memberId === undefined ? undefined : memberById.get(memberId)?.name) ?? a.testerName ?? key, assignments: [], eventsToday: 0, uniqueCasesToday: 0, recordedCasesToday: null, noExecutionRecorded: true };
    own.assignments.push({ projectId: a.projectId, projectName: project?.projectName ?? a.projectId, scopeId: a.scopeId ?? null, workType: scope === undefined ? null : workTypeOf(scope) });
    byKey.set(key, own);
  }
  for (const entryOwner of byKey.values()) {
    const memberId = entryOwner.key.startsWith('m:') ? entryOwner.key.slice(2) : null;
    if (memberId !== null) {
      const mineEvents = dayEvents.filter((e) => e.executedByMemberId === memberId);
      entryOwner.eventsToday = mineEvents.length;
      entryOwner.uniqueCasesToday = new Set(mineEvents.map((e) => e.testCaseId)).size;
      const recorded = selected.flatMap((p) => p.inputs.testerDailyPerformance ?? []).filter((r) => r.date === selectedDate && r.memberId === memberId);
      entryOwner.recordedCasesToday = recorded.length === 0 ? null : recorded.reduce((s, r) => s + r.casesTested, 0);
    }
    entryOwner.noExecutionRecorded = entryOwner.eventsToday === 0 && (entryOwner.recordedCasesToday ?? 0) === 0;
    entryOwner.assignments.sort((x, y) => x.projectName.localeCompare(y.projectName) || String(x.scopeId).localeCompare(String(y.scopeId)));
  }
  const allocation = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  const activeToday = new Set<string>();
  for (const e of dayEvents) if (e.executedByMemberId !== undefined) activeToday.add(`m:${e.executedByMemberId}`);
  for (const a of allocation) if ((a.recordedCasesToday ?? 0) > 0) activeToday.add(a.key);

  // ---- what changed on the selected day (immutable case history) ----
  const asc = sortEventsAscending(events.filter((e) => activeIds.has(e.projectId) || selected.some((p) => p.projectId === e.projectId)));
  const firstEver = new Map<string, string>();
  for (const e of asc) if (!firstEver.has(e.testCaseId)) firstEver.set(e.testCaseId, eventBusinessDate(e));
  const finalToday = new Map<string, string>();
  const before = new Map<string, string>();
  for (const e of asc) {
    const d = eventBusinessDate(e);
    if (d < selectedDate) before.set(e.testCaseId, e.status);
    else if (d === selectedDate) finalToday.set(e.testCaseId, e.status);
  }
  const todaysEvents = asc.filter((e) => eventBusinessDate(e) === selectedDate);
  let statusChanged = 0;
  let newlyPassed = 0;
  let newlyFailed = 0;
  for (const [caseId, status] of finalToday) {
    const prev = before.get(caseId) ?? 'notStarted';
    if (status !== prev) statusChanged += 1;
    if (status === 'pass' && prev !== 'pass') newlyPassed += 1;
    if (status === 'fail' && prev !== 'fail') newlyFailed += 1;
  }
  const criticalRecorded = selected.flatMap((p) => (input.tickets ?? p.inputs.bugTickets ?? []).filter((t) => t.projectId === p.projectId)).filter((t) => t.severity === 'Critical' && t.createdAt === selectedDate).length;
  const changes: DailyChanges = {
    casesFirstExecuted: [...finalToday.keys()].filter((id) => firstEver.get(id) === selectedDate).length,
    passEvents: todaysEvents.filter((e) => e.status === 'pass').length,
    failEvents: todaysEvents.filter((e) => e.status === 'fail').length,
    blockedEvents: todaysEvents.filter((e) => e.status === 'blocked').length,
    retestRaised: todaysEvents.filter((e) => e.retest === true).length,
    casesStatusChanged: statusChanged,
    casesNewlyPassed: newlyPassed,
    casesNewlyFailed: newlyFailed,
    criticalTicketsRecorded: criticalRecorded,
  };

  // ---- day comparison: the most recent earlier day with any recorded activity (only day-based figures) ----
  const metricsFor = (date: string): DayMetrics => {
    let unique = 0;
    let failed = 0;
    let savedExecuted = 0;
    let actual = 0;
    for (const p of projects) {
      const d = dailyDetailedSummary({ date, projectId: p.projectId, scopes: input.scopes, cases: input.cases, events: events.filter((e) => e.projectId === p.projectId) });
      unique += d.uniqueCasesExecuted;
      failed += d.failed;
      const entry = (inputsOf(p, input.projects).dailyExecuted ?? []).find((e) => e.date === date);
      if (entry !== undefined) {
        savedExecuted += entryCompletedCases(entry);
        actual += entry.testers;
      }
    }
    return { date, uniqueCasesExecuted: unique, failedCases: failed, savedExecuted, actualTesters: actual };
  };
  const activityDates = new Set<string>();
  for (const p of selected) for (const e of p.inputs.dailyExecuted ?? []) activityDates.add(e.date);
  for (const e of events) if (selected.some((p) => p.projectId === e.projectId)) activityDates.add(eventBusinessDate(e));
  const previousDate = [...activityDates].filter((d) => d < selectedDate && d >= addDays(selectedDate, -14)).sort().pop() ?? null;
  const comparison = previousDate === null ? null : { previous: metricsFor(previousDate), current: metricsFor(selectedDate) };

  // ---- failures of the selected day (final status of the day) ----
  const caseById = new Map(input.cases.map((c) => [c.id, c] as const));
  const scopeById = new Map(input.scopes.map((s) => [s.id, s] as const));
  const failureItems: SupervisorDailyOperations['failures']['items'] = [];
  const failedPerScope = new Map<string, number>();
  for (const [caseId, status] of finalToday) {
    if (status !== 'fail' && status !== 'blocked') continue;
    const tc = caseById.get(caseId);
    if (tc === undefined) continue;
    const project = selected.find((p) => p.projectId === tc.projectId);
    if (project === undefined) continue;
    failureItems.push({ projectId: tc.projectId, projectName: nameOf(project), scopeName: scopeById.get(tc.scopeId)?.name ?? '', key: tc.key, title: tc.title, status });
    if (status === 'fail') failedPerScope.set(tc.scopeId, (failedPerScope.get(tc.scopeId) ?? 0) + 1);
  }
  failureItems.sort((a, b) => Number(b.status === 'fail') - Number(a.status === 'fail') || a.projectName.localeCompare(b.projectName) || a.key.localeCompare(b.key));
  const topScopes = [...failedPerScope.entries()].map(([scopeId, failed]) => ({ scopeId, scopeName: scopeById.get(scopeId)?.name ?? '', failed })).sort((a, b) => b.failed - a.failed || a.scopeName.localeCompare(b.scopeName)).slice(0, 3);

  // ---- summary ----
  const assignedUnique = new Set<string>();
  for (const a of currentAssignments) {
    const key = personKey(a, members);
    if (key !== null) assignedUnique.add(key);
  }
  const mixTotals = new Map<WorkTypeKey, { workType: WorkTypeKey; cases: number; scopes: number }>();
  for (const p of active) for (const m of p.workMix) {
    const row = mixTotals.get(m.workType) ?? { workType: m.workType, cases: 0, scopes: 0 };
    row.cases += m.cases;
    row.scopes += m.scopes;
    mixTotals.set(m.workType, row);
  }
  const typeOrder: WorkTypeKey[] = [...QA_WORK_TYPES, 'unspecified'];
  const summary: SupervisorDailySummary = {
    activeProjects: active.length,
    readyProjects: active.filter((p) => p.readiness.state === 'ready' && p.readiness.applicability === 'evaluated').length,
    atRiskProjects: active.filter((p) => p.readiness.state === 'atRisk').length,
    blockedProjects: active.filter((p) => p.readiness.state === 'blocked').length,
    plannedTesters: active.reduce((s, p) => s + p.staffing.planned, 0),
    assignedTesters: assignedUnique.size,
    actualTesters: active.reduce((s, p) => s + (p.staffing.actual ?? 0), 0),
    testersWithExecution: activeToday.size,
    execution: {
      savedExecuted: projects.reduce((s, p) => s + (p.saved?.executed ?? 0), 0),
      savedPassed: projects.reduce((s, p) => s + (p.saved?.passed ?? 0), 0),
      savedFailed: projects.reduce((s, p) => s + (p.saved?.failed ?? 0), 0),
      savedBlocked: projects.reduce((s, p) => s + (p.saved?.blocked ?? 0), 0),
      uniqueCasesExecuted: projects.reduce((s, p) => s + p.detailed.uniqueCasesExecuted, 0),
      executionEvents: projects.reduce((s, p) => s + p.detailed.eventCount, 0),
    },
    workTypeBreakdown: typeOrder.flatMap((k) => (mixTotals.has(k) ? [mixTotals.get(k) as { workType: WorkTypeKey; cases: number; scopes: number }] : [])),
    attentionItems: attention,
  };

  return {
    selectedDate,
    today,
    isHistorical: selectedDate !== today,
    summary,
    projects: projects.sort((a, b) => a.projectName.localeCompare(b.projectName) || a.projectId.localeCompare(b.projectId)),
    projectRanking,
    allocation,
    changes,
    comparison,
    failures: { failedToday: failureItems.filter((f) => f.status === 'fail').length, blockedToday: failureItems.filter((f) => f.status === 'blocked').length, items: failureItems.slice(0, 10), topScopes },
  };
}

function inputsOf(p: ProjectDayOps, all: readonly ProjectRecord[]): ProjectRecord['inputs'] {
  return (all.find((x) => x.projectId === p.projectId) as ProjectRecord).inputs;
}

/** The current business day, for callers that need to default the date (the selector itself never reads a clock). */
export const currentBusinessDay = (): string => businessDate();

export type { DailyExecutionEntry };

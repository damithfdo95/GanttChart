import type {
  AppState,
  AttendanceRecord,
  AttendanceStatus,
  BugTicket,
  DailyActualSnapshot,
  DailyReport,
  IdentityAuditEntry,
  Language,
  ProgressRules,
  ProjectRecord,
  QaInputs,
  RcsMember,
  TesterDailyPerformance,
  TesterProjectAssignment,
  TesterReview,
} from '../../types';
import { t } from '../../i18n';
import { nameHistoryEntryLabel } from '../../domain/members';
import {
  attendanceIdentityState,
  ticketIdentityState,
  type IdentityState,
} from '../../domain/identityResolution';
import { calculateCumulativeCapacityByDay, type MultiDayProjectionResult } from '../calculations/planning';
import { dayWindowsFromRows, projectDayWindowDefaults, workdayProductiveHours } from '../calculations/workday';
import { buildExecutionHistory } from '../calculations/history';
import {
  aggregateTesterPerformance,
  getTesterProjectBreakdown,
  type TesterPerformanceRow,
} from '../calculations/testerPerformance';
import { calculateActivityProgress, DEFAULT_PROGRESS_RULES, percentRatio } from '../reporting/progress';
import { isAttending } from '../reporting/sections';
import { projectPlanningStatus, projectDisplayName } from '../../domain/projects';
import type { XlsxCell, XlsxSheet } from './xlsx';
import { buildManagementReportRow, riskStatusLabel, type ManagementReportRow } from './management';
/** Export filters (date range, team, attendance status). */

export interface ExportFilters {
  dateFrom: string | null;
  dateTo: string | null;
  team: string | null;
  status: AttendanceStatus | null;
}

export const EMPTY_FILTERS: ExportFilters = { dateFrom: null, dateTo: null, team: null, status: null };

function dateInRange(date: string, filters: ExportFilters): boolean {
  if (filters.dateFrom !== null && date < filters.dateFrom) return false;
  if (filters.dateTo !== null && date > filters.dateTo) return false;
  return true;
}

export function filterAttendanceRecords(records: AttendanceRecord[], filters: ExportFilters): AttendanceRecord[] {
  return records.filter(
    (r) =>
      dateInRange(r.date, filters) &&
      (filters.team === null || r.team === filters.team) &&
      (filters.status === null || r.status === filters.status),
  );
}

export function filterReports(reports: DailyReport[], filters: ExportFilters): DailyReport[] {
  return reports.filter((r) => dateInRange(r.reportDate, filters));
}

// ---- Sheet builders (headers localized in the UI language) -------------------

const PLANNING_STATUS_KEY: Record<
  string,
  'status.onTrack' | 'status.atRisk' | 'status.capacityShortage' | 'status.completed' | 'plan.noTargetSet' | 'status.onHold'
> = {
  onTrack: 'status.onTrack',
  atRisk: 'status.atRisk',
  capacityShortage: 'status.capacityShortage',
  completed: 'status.completed',
  noTarget: 'plan.noTargetSet',
  onHold: 'status.onHold',
};

const LIFECYCLE_STATUS_KEY: Record<
  ProjectRecord['status'],
  'overall.todo' | 'overall.ongoing' | 'overall.extended' | 'overall.onHold' | 'overall.done'
> = {
  todo: 'overall.todo',
  ongoing: 'overall.ongoing',
  extended: 'overall.extended',
  onHold: 'overall.onHold',
  done: 'overall.done',
};

/** Project portfolio export: lifecycle + planning status + completion metadata. */
export function projectsSheet(lang: Language, projects: ProjectRecord[]): XlsxSheet {
  return {
    name: t(lang, 'dataset.projects'),
    headers: [
      t(lang, 'columns.projectId'),
      t(lang, 'columns.name'),
      t(lang, 'overall.lifecycleStatus'),
      t(lang, 'overall.planningStatus'),
      t(lang, 'columns.team'),
      t(lang, 'columns.date'),
      t(lang, 'dashboard.deadline'),
      t(lang, 'columns.totalCases'),
      t(lang, 'columns.completedCases'),
      t(lang, 'columns.spoAssigned'),
      t(lang, 'columns.pass'),
      t(lang, 'fields.casesFailed'),
      t(lang, 'columns.notApplicable'),
      t(lang, 'columns.blocked'),
      t(lang, 'fields.casesRetest'),
      t(lang, 'fields.casesQuestioned'),
      t(lang, 'metrics.qaTested'),
      t(lang, 'overall.progress'),
      t(lang, 'columns.remaining'),
      t(lang, 'overall.testers'),
      t(lang, 'overall.capacity'),
      t(lang, 'overall.updated'),
      t(lang, 'overall.completedAt'),
    ],
    rows: projects.map((project) => {
      const total = project.inputs.totalCases;
      const completed = project.inputs.casesCompleted;
      const spoAssigned = project.inputs.spoAssigned ?? 0;
      const qaTested = Math.max(0, completed - spoAssigned);
      const ratio = total > 0 ? completed / total : null;
      const capacity = project.inputs.currentTesters * project.inputs.perHourPerTester * workdayProductiveHours(project.inputs.startTime, project.inputs.dailyOvertimeMinutes);
      return [
        project.projectId,
        project.nameEn !== '' ? project.nameEn : project.nameJa,
        t(lang, LIFECYCLE_STATUS_KEY[project.status]),
        t(lang, PLANNING_STATUS_KEY[projectPlanningStatus(project)]),
        project.team,
        { kind: 'date', value: project.inputs.startDate },
        project.inputs.targetCompletionDate === null ? t(lang, 'report.dueDateNone') : { kind: 'date', value: project.inputs.targetCompletionDate },
        total,
        completed,
        spoAssigned,
        project.inputs.casesPassed ?? 0,
        project.inputs.casesFailed ?? 0,
        project.inputs.casesNotApplicable ?? 0,
        project.inputs.casesBlocked ?? 0,
        project.inputs.casesRetest ?? 0,
        project.inputs.casesQuestioned ?? 0,
        qaTested,
        ratio === null ? '—' : { kind: 'percent', value: ratio },
        Math.max(0, total - completed),
        project.inputs.currentTesters,
        Math.round(capacity * 100) / 100,
        project.updatedAt,
        project.completedAt ?? '',
      ];
    }),
  };
}

export function attendanceSheet(
  lang: Language,
  records: AttendanceRecord[],
  members: readonly RcsMember[] = [],
): XlsxSheet {
  const memberById = new Map(members.map((member) => [member.id, member]));
  return {
    name: t(lang, 'dataset.attendance'),
    headers: [
      t(lang, 'columns.date'),
      t(lang, 'columns.member'),
      t(lang, 'attendance.memberIdColumn'),
      t(lang, 'attendance.memberNameColumn'),
      t(lang, 'columns.team'),
      t(lang, 'columns.status'),
      t(lang, 'columns.workingStart'),
      t(lang, 'columns.workingEnd'),
      t(lang, 'columns.leaveType'),
      t(lang, 'columns.comment'),
      t(lang, 'columns.attending'),
      t(lang, 'identity.stateColumn'),
    ],
    rows: records.map((r) => [
      { kind: 'date', value: r.date },
      r.memberName,
      r.memberId ?? '',
      r.memberId !== undefined ? memberById.get(r.memberId)?.name ?? '' : '',
      r.team,
      r.status,
      r.workingStart ?? '',
      r.workingEnd ?? '',
      r.leaveType ?? '',
      r.comment,
      isAttending(r.status) ? t(lang, 'common.yes') : t(lang, 'common.no'),
      identityStateLabel(lang, attendanceIdentityState(r, members)),
    ]),
  };
}

export function reportsSheet(lang: Language, reports: DailyReport[]): XlsxSheet {
  return {
    name: t(lang, 'dataset.reports'),
    headers: [
      t(lang, 'columns.date'),
      t(lang, 'columns.projectId'),
      t(lang, 'columns.language'),
      t(lang, 'columns.status'),
      t(lang, 'columns.finalizedAt'),
      t(lang, 'columns.finalizedBy'),
      t(lang, 'columns.item'),
    ],
    rows: reports.map((r) => [
      { kind: 'date', value: r.reportDate },
      r.projectId ?? '',
      r.language,
      r.status === 'FINALIZED' ? t(lang, 'dailyReport.statusFinalized') : t(lang, 'dailyReport.statusDraft'),
      r.finalizedAt ?? '',
      r.finalizedBy ?? '',
      r.revisionOf !== null ? t(lang, 'dailyReport.revision', { date: r.reportDate }) : '',
    ]),
  };
}

export function dailyProgressSheet(
  lang: Language,
  reports: DailyReport[],
  rules: ProgressRules = DEFAULT_PROGRESS_RULES,
): XlsxSheet {
  const rows: XlsxCell[][] = [];
  for (const report of reports) {
    if (report.status !== 'FINALIZED' || report.snapshot === null) continue;
    for (const activity of report.snapshot.activities) {
      if (!activity.included) continue;
      const progress = calculateActivityProgress(activity, rules);
      rows.push([
        { kind: 'date', value: report.reportDate },
        activity.name,
        percentRatio(progress.workingPct),
        progress.workingCount,
        progress.workingDenom,
        percentRatio(progress.completePct),
        progress.completeCount,
        progress.completeDenom,
        activity.casesPassed ?? 0,
        activity.casesFailed ?? 0,
        activity.notApplicableCases,
        activity.blockedCases,
        activity.spoAssigned ?? 0,
        activity.casesRetest ?? 0,
        activity.casesQuestioned ?? 0,
        activity.dueDate === null ? t(lang, 'report.dueDateNone') : { kind: 'date', value: activity.dueDate },
      ]);
    }
  }
  return {
    name: t(lang, 'dataset.progress'),
    headers: [
      t(lang, 'columns.date'),
      t(lang, 'columns.name'),
      t(lang, 'columns.workingPct'),
      t(lang, 'columns.started'),
      t(lang, 'columns.workingEligible'),
      t(lang, 'columns.completePct'),
      t(lang, 'columns.completedCases'),
      t(lang, 'columns.totalCases'),
      t(lang, 'columns.pass'),
      t(lang, 'fields.casesFailed'),
      t(lang, 'columns.notApplicable'),
      t(lang, 'columns.blocked'),
      t(lang, 'columns.spoAssigned'),
      t(lang, 'fields.casesRetest'),
      t(lang, 'fields.casesQuestioned'),
      t(lang, 'columns.dueDate'),
    ],
    rows,
  };
}

export function executionLogsSheet(lang: Language, reports: DailyReport[]): XlsxSheet {
  const rows: XlsxCell[][] = [];
  for (const report of reports) {
    if (report.status !== 'FINALIZED' || report.snapshot === null) continue;
    for (const activity of report.snapshot.activities) {
      rows.push([
        { kind: 'date', value: report.reportDate },
        activity.name,
        activity.memberCount,
        activity.completedCases,
        activity.spoAssigned ?? 0,
        activity.casesPassed ?? 0,
        activity.casesFailed ?? 0,
        activity.notApplicableCases,
        activity.blockedCases,
        activity.casesRetest ?? 0,
        activity.casesQuestioned ?? 0,
        activity.workingStatus,
      ]);
    }
  }
  return {
    name: t(lang, 'dataset.executionLogs'),
    headers: [
      t(lang, 'columns.date'),
      t(lang, 'columns.name'),
      t(lang, 'columns.memberCount'),
      t(lang, 'columns.completedCases'),
      t(lang, 'columns.spoAssigned'),
      t(lang, 'columns.pass'),
      t(lang, 'fields.casesFailed'),
      t(lang, 'columns.notApplicable'),
      t(lang, 'columns.blocked'),
      t(lang, 'fields.casesRetest'),
      t(lang, 'fields.casesQuestioned'),
      t(lang, 'columns.workingStatus'),
    ],
    rows,
  };
}

/**
 * V6.5 §18: Execution History sheet — daily snapshots with the granular
 * seven-status breakdown. Historical accuracy: values that were never
 * recorded (pre-V6.5 snapshots) export as the "not available" marker, never
 * as a false zero. Derived values (QA Tested / QA Completed / Remaining)
 * use the existing execution logic on the recorded aggregates.
 */
export function executionHistorySheet(
  lang: Language,
  snapshots: DailyActualSnapshot[],
  totalCases: number,
): XlsxSheet {
  const history = buildExecutionHistory(snapshots, totalCases);
  return {
    name: t(lang, 'dataset.executionHistory'),
    headers: [
      t(lang, 'columns.date'),
      t(lang, 'columns.pass'),
      t(lang, 'fields.casesFailed'),
      t(lang, 'fields.casesNotApplicable'),
      t(lang, 'columns.spoAssigned'),
      t(lang, 'metrics.qaTested'),
      t(lang, 'metrics.qaCompleted'),
      t(lang, 'dashboard.remainingCases'),
      t(lang, 'fields.casesBlocked'),
      t(lang, 'fields.casesRetest'),
      t(lang, 'fields.casesQuestioned'),
    ],
    rows: history.map((row) => [
      { kind: 'date', value: row.date },
      row.pass,
      row.fail ?? '—',
      row.notApplicable ?? '—',
      row.spo ?? '—',
      row.qaTested,
      row.qaCompleted,
      row.remaining,
      row.blocked ?? '—',
      row.retest ?? '—',
      row.questioned ?? '—',
    ]),
  };
}

export function wbsSheet(lang: Language, inputs: QaInputs): XlsxSheet {  return {
    name: t(lang, 'dataset.wbs'),
    headers: [
      t(lang, 'columns.date'),
      t(lang, 'columns.plannedTesters'),
      t(lang, 'columns.absentTesters'),
      t(lang, 'columns.availableTesters'),
      t(lang, 'columns.nonWorkingDay'),
      t(lang, 'columns.note'),
    ],
    rows: inputs.planningRows.map((r) => [
      { kind: 'date', value: r.date },
      r.plannedTesters,
      r.absentTesters,
      Math.max(0, r.plannedTesters - r.absentTesters),
      r.nonWorkingDay ? t(lang, 'common.yes') : t(lang, 'common.no'),
      r.note,
    ]),
  };
}

export function capacitySheet(lang: Language, inputs: QaInputs): XlsxSheet {
  const productiveHours = workdayProductiveHours(inputs.startTime, inputs.dailyOvertimeMinutes);
  const daily = calculateCumulativeCapacityByDay(
    inputs.planningRows,
    inputs.perHourPerTester,
    productiveHours,
    dayWindowsFromRows(inputs.planningRows, projectDayWindowDefaults(inputs)),
  );
  const casesRemaining = Math.max(0, inputs.totalCases - inputs.casesCompleted);
  return {
    name: t(lang, 'dataset.capacity'),
    headers: [
      t(lang, 'columns.date'),
      t(lang, 'columns.plannedTesters'),
      t(lang, 'columns.absentTesters'),
      t(lang, 'columns.availableTesters'),
      t(lang, 'columns.dailyCapacity'),
      t(lang, 'columns.cumulativeCapacity'),
      t(lang, 'columns.remaining'),
    ],
    rows: daily.map((row) => [
      { kind: 'date', value: row.date },
      row.plannedTesters,
      row.absentTesters,
      row.availableTesters,
      Math.round(row.dailyCapacity * 100) / 100,
      Math.round(row.cumulativeCapacity * 100) / 100,
      Math.max(0, Math.round((casesRemaining - row.cumulativeCapacity) * 100) / 100),
    ]),
  };
}

export function overtimeSheet(lang: Language, inputs: QaInputs): XlsxSheet {
  const productiveHours = workdayProductiveHours(inputs.startTime, inputs.dailyOvertimeMinutes);
  const daily = calculateCumulativeCapacityByDay(
    inputs.planningRows,
    inputs.perHourPerTester,
    productiveHours,
    dayWindowsFromRows(inputs.planningRows, projectDayWindowDefaults(inputs)),
  );
  const casesRemaining = Math.max(0, inputs.totalCases - inputs.casesCompleted);
  const rows: XlsxCell[][] = [];
  let previousCumulative = 0;
  for (const row of daily) {
    const remainingAtStart = Math.max(0, casesRemaining - previousCumulative);
    const shortage = Math.max(0, remainingAtStart - row.dailyCapacity);
    const personHours = inputs.perHourPerTester > 0 ? shortage / inputs.perHourPerTester : null;
    const perTester = personHours !== null && row.availableTesters > 0 ? personHours / row.availableTesters : null;
    rows.push([
      { kind: 'date', value: row.date },
      row.availableTesters,
      Math.round(row.dailyCapacity * 100) / 100,
      Math.round(remainingAtStart * 100) / 100,
      Math.round(shortage * 100) / 100,
      personHours === null ? null : Math.round(personHours * 100) / 100,
      perTester === null ? null : Math.round(perTester * 100) / 100,
    ]);
    previousCumulative = row.cumulativeCapacity;
  }
  return {
    name: t(lang, 'dataset.overtime'),
    headers: [
      t(lang, 'columns.date'),
      t(lang, 'columns.availableTesters'),
      t(lang, 'columns.dailyCapacity'),
      t(lang, 'columns.remaining'),
      t(lang, 'dashboard.capacityShortage'),
      t(lang, 'mgmt.totalOt'),
      t(lang, 'mgmt.requiredOt'),
    ],
    rows,
  };
}

export function summarySheet(lang: Language, state: AppState, projection: MultiDayProjectionResult): XlsxSheet {
  const mgmt = buildManagementReportRow(state, projection);
  return {
    name: t(lang, 'dataset.summary'),
    headers: [t(lang, 'columns.item'), t(lang, 'columns.value')],
    rows: [
      [t(lang, 'mgmt.project'), mgmt.project],
      [t(lang, 'fields.totalCases'), state.totalCases],
      [t(lang, 'fields.casesCompleted'), state.casesCompleted],
      [t(lang, 'fields.casesPassed'), state.casesPassed ?? 0],
      [t(lang, 'fields.casesFailed'), state.casesFailed ?? 0],
      [t(lang, 'fields.casesNotApplicable'), state.casesNotApplicable ?? 0],
      [t(lang, 'metrics.spoAssigned'), state.spoAssigned ?? 0],
      [t(lang, 'fields.casesBlocked'), state.casesBlocked ?? 0],
      [t(lang, 'fields.casesRetest'), state.casesRetest ?? 0],
      [t(lang, 'fields.casesQuestioned'), state.casesQuestioned ?? 0],
      [t(lang, 'metrics.qaTested'), Math.max(0, state.casesCompleted - (state.spoAssigned ?? 0))],
      [t(lang, 'mgmt.remainingTestCases'), mgmt.remainingTestCases],
      [t(lang, 'mgmt.currentTesters'), mgmt.currentTesters],
      [t(lang, 'mgmt.requiredTesters'), mgmt.requiredTesters ?? '—'],
      [t(lang, 'mgmt.capacityGap'), mgmt.capacityGap ?? '—'],
      [t(lang, 'mgmt.predictedFinish'), mgmt.predictedFinishEpoch === null ? '—' : { kind: 'date', value: formatEpoch(mgmt.predictedFinishEpoch) }],
      [t(lang, 'mgmt.totalOt'), mgmt.totalOtPersonHours ?? '—'],
      [t(lang, 'mgmt.riskStatus'), riskStatusLabel(lang, mgmt.riskStatus)],
    ],
  };
}

export function managementSheet(lang: Language, row: ManagementReportRow): XlsxSheet {
  return {
    name: t(lang, 'reports.management'),
    headers: [
      t(lang, 'mgmt.project'),
      t(lang, 'mgmt.dueDate'),
      t(lang, 'mgmt.remainingTestCases'),
      t(lang, 'mgmt.currentTesters'),
      t(lang, 'mgmt.requiredTesters'),
      t(lang, 'mgmt.capacityGap'),
      t(lang, 'mgmt.predictedFinish'),
      t(lang, 'mgmt.requiredOt'),
      t(lang, 'mgmt.totalOt'),
      t(lang, 'mgmt.riskStatus'),
    ],
    rows: [
      [
        row.project,
        row.dueDate === null ? t(lang, 'report.dueDateNone') : { kind: 'date', value: row.dueDate },
        row.remainingTestCases,
        row.currentTesters,
        row.requiredTesters ?? '—',
        row.capacityGap ?? '—',
        row.predictedFinishEpoch === null ? '—' : { kind: 'date', value: formatEpoch(row.predictedFinishEpoch) },
        row.requiredOtPerTesterPerDay === null ? '—' : Math.round(row.requiredOtPerTesterPerDay * 100) / 100,
        row.totalOtPersonHours === null ? '—' : Math.round(row.totalOtPersonHours * 100) / 100,
        riskStatusLabel(lang, row.riskStatus),
      ],
    ],
  };
}

function formatEpoch(epochDays: number): string {
  const d = new Date(epochDays * 86_400_000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// ---- V6.6: Bug tickets & tester performance sheets ---------------------------

function projectNameResolver(lang: Language, projects: readonly ProjectRecord[]): (projectId: string) => string {
  const names = new Map(projects.map((p) => [p.projectId, projectDisplayName(p, lang)]));
  return (projectId: string): string => names.get(projectId) ?? projectId;
}

function bugSeverityLabel(lang: Language, severity: BugTicket['severity']): string {
  if (severity === undefined) return '';
  switch (severity) {
    case 'Critical':
      return t(lang, 'severity.critical');
    case 'Major':
      return t(lang, 'severity.major');
    case 'Minor':
      return t(lang, 'severity.minor');
    default:
      return t(lang, 'severity.trivial');
  }
}

function bugStatusLabel(lang: Language, status: BugTicket['status']): string {
  if (status === undefined) return '';
  switch (status) {
    case 'Open':
      return t(lang, 'bugStatus.open');
    case 'In Progress':
      return t(lang, 'bugStatus.inProgress');
    case 'Resolved':
      return t(lang, 'bugStatus.resolved');
    case 'Closed':
      return t(lang, 'bugStatus.closed');
    case 'Rejected':
      return t(lang, 'bugStatus.rejected');
    default:
      return t(lang, 'bugStatus.duplicate');
  }
}

/** V6.6 §24: Bug Tickets sheet — one row per recorded JIRA ticket. */
export function bugTicketsSheet(
  lang: Language,
  tickets: readonly BugTicket[],
  projects: readonly ProjectRecord[],
  members: readonly RcsMember[] = [],
): XlsxSheet {
  const nameOf = projectNameResolver(lang, projects);
  const memberById = new Map(members.map((member) => [member.id, member]));
  return {
    name: t(lang, 'dataset.bugTickets'),
    headers: [
      t(lang, 'tickets.project'),
      t(lang, 'tickets.ticketKey'),
      t(lang, 'tickets.titleField'),
      t(lang, 'tickets.url'),
      t(lang, 'tickets.createdDate'),
      t(lang, 'tickets.reporter'),
      t(lang, 'tickets.reporterMemberIdColumn'),
      t(lang, 'tickets.reporterNameColumn'),
      t(lang, 'tickets.severity'),
      t(lang, 'tickets.statusField'),
      t(lang, 'tickets.memo'),
      t(lang, 'identity.stateColumn'),
    ],
    rows: tickets.map((ticket) => [
      nameOf(ticket.projectId),
      ticket.ticketKey ?? '',
      ticket.title,
      ticket.url,
      { kind: 'date', value: ticket.createdAt },
      ticket.reportedBy,
      ticket.reporterMemberId ?? '',
      ticket.reporterMemberId !== undefined ? memberById.get(ticket.reporterMemberId)?.name ?? '' : '',
      ticket.severity === undefined ? '' : bugSeverityLabel(lang, ticket.severity),
      ticket.status === undefined ? '' : bugStatusLabel(lang, ticket.status),
      ticket.memo ?? '',
      identityStateLabel(lang, ticketIdentityState(ticket, members)),
    ]),
  };
}

/** V6.6 §24 / V6.8 §25: Tester Performance sheet — objective per-tester evidence. */
export function testerPerformanceSheet(
  lang: Language,
  rows: readonly TesterPerformanceRow[],
  projects: readonly ProjectRecord[],
  periodLabel: string,
): XlsxSheet {
  const nameOf = projectNameResolver(lang, projects);
  return {
    name: t(lang, 'dataset.testerPerformance'),
    headers: [
      t(lang, 'performance.period'),
      t(lang, 'performance.tester'),
      t(lang, 'members.memberId'),
      t(lang, 'columns.team'),
      t(lang, 'performance.projectsCount'),
      t(lang, 'performance.activeDays'),
      t(lang, 'performance.casesTestedField'),
      t(lang, 'columns.pass'),
      t(lang, 'fields.casesFailed'),
      t(lang, 'columns.notApplicable'),
      t(lang, 'columns.blocked'),
      t(lang, 'fields.casesRetest'),
      t(lang, 'fields.casesQuestioned'),
      t(lang, 'columns.spoAssigned'),
      t(lang, 'performance.bugsFound'),
      t(lang, 'performance.avgPerDay'),
      t(lang, 'performance.executionSource'),
    ],
    rows: rows.map((row) => [
      periodLabel,
      row.testerName,
      row.memberId ?? '',
      row.team,
      row.projectIds.map(nameOf).join(' / '),
      row.activeDays,
      row.casesTested,
      row.casesPassed,
      row.casesFailed,
      row.casesNotApplicable,
      row.casesBlocked,
      row.casesRetest,
      row.casesQuestioned,
      row.casesSpoAssigned,
      row.bugsFound,
      Math.round(row.averageCasesPerDay * 100) / 100,
      // V6.9-B §20/§34: provenance — every execution source of the row,
      // joined (never ranked; manual overrides are visible).
      row.sources.join(' / '),
    ]),
  };
}

/** V6.6 §24 / V6.8 §25: Tester Daily Detail sheet — raw daily execution evidence. */
export function testerDailyDetailSheet(
  lang: Language,
  records: readonly TesterDailyPerformance[],
  tickets: readonly BugTicket[],
  projects: readonly ProjectRecord[],
): XlsxSheet {
  const nameOf = projectNameResolver(lang, projects);
  const bugsByProjectTesterDate = new Map<string, number>();
  for (const ticket of tickets) {
    const key = `${ticket.projectId}\u0000${ticket.reportedBy.trim()}\u0000${ticket.createdAt}`;
    bugsByProjectTesterDate.set(key, (bugsByProjectTesterDate.get(key) ?? 0) + 1);
  }
  const sorted = [...records].sort(
    (a, b) => a.date.localeCompare(b.date) || a.testerName.localeCompare(b.testerName) || a.projectId.localeCompare(b.projectId),
  );
  return {
    name: t(lang, 'dataset.testerDailyDetail'),
    headers: [
      t(lang, 'columns.date'),
      t(lang, 'performance.tester'),
      t(lang, 'members.memberId'),
      t(lang, 'performance.projectScope'),
      t(lang, 'performance.casesTestedField'),
      t(lang, 'columns.pass'),
      t(lang, 'fields.casesFailed'),
      t(lang, 'columns.notApplicable'),
      t(lang, 'columns.blocked'),
      t(lang, 'fields.casesRetest'),
      t(lang, 'fields.casesQuestioned'),
      t(lang, 'columns.spoAssigned'),
      t(lang, 'performance.bugsFound'),
    ],
    rows: sorted.map((record) => {
      const key = `${record.projectId}\u0000${record.testerName.trim()}\u0000${record.date}`;
      return [
        { kind: 'date', value: record.date },
        record.testerName,
        record.memberId ?? '',
        nameOf(record.projectId),
        record.casesTested,
        record.casesPassed ?? 0,
        record.casesFailed ?? 0,
        record.casesNotApplicable ?? 0,
        record.casesBlocked ?? 0,
        record.casesRetest ?? 0,
        record.casesQuestioned ?? 0,
        record.casesSpoAssigned ?? 0,
        bugsByProjectTesterDate.get(key) ?? 0,
      ];
    }),
  };
}

/** V6.6 helper: aggregate all-time tester performance for exports. */
export function allTimeTesterPerformanceRows(
  records: readonly TesterDailyPerformance[],
  tickets: readonly BugTicket[],
): TesterPerformanceRow[] {
  return aggregateTesterPerformance(records, tickets);
}

// ---- V6.8: RCS member master & assignment sheets -------------------------------

/** Localized label of an identity state (V6.9-B §34). */
function identityStateLabel(lang: Language, state: IdentityState): string {
  switch (state) {
    case 'linked':
      return t(lang, 'identity.stateLinked');
    case 'resolved':
      return t(lang, 'identity.stateResolved');
    case 'ambiguous':
      return t(lang, 'identity.stateAmbiguous');
    default:
      return t(lang, 'identity.stateUnmatched');
  }
}

/** V6.9-B §30/§34: Identity Resolution Audit sheet — the append-only decision log. */
export function identityAuditSheet(
  lang: Language,
  entries: readonly IdentityAuditEntry[],
  members: readonly RcsMember[],
): XlsxSheet {
  const memberById = new Map(members.map((member) => [member.id, member]));
  const sorted = [...entries].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return {
    name: t(lang, 'dataset.identityAudit'),
    headers: [
      t(lang, 'identity.timestampColumn'),
      t(lang, 'identity.recordTypeColumn'),
      t(lang, 'identity.recordIdColumn'),
      t(lang, 'identity.recordDateColumn'),
      t(lang, 'identity.recordedNameColumn'),
      t(lang, 'identity.memberIdColumn'),
      t(lang, 'identity.memberNameColumn'),
      t(lang, 'identity.methodColumn'),
      t(lang, 'identity.previousStateColumn'),
      t(lang, 'identity.newStateColumn'),
    ],
    rows: sorted.map((entry) => [
      entry.timestamp,
      entry.recordType === 'attendance' ? t(lang, 'identityResolution.attendance') : t(lang, 'identityResolution.ticket'),
      entry.recordId,
      entry.recordDate ?? '',
      entry.recordedName,
      entry.resolvedMemberId ?? '',
      entry.resolvedMemberId !== undefined ? memberById.get(entry.resolvedMemberId)?.name ?? '' : '',
      entry.method === 'bulk' ? t(lang, 'identity.methodBulk') : t(lang, 'identity.methodManual'),
      identityStateLabel(lang, entry.previousState === 'ambiguous' ? 'ambiguous' : 'unmatched'),
      entry.resolvedMemberId !== undefined
        ? t(lang, 'identity.stateLinked')
        : t(lang, 'identity.stateKeptUnresolved'),
    ]),
  };
}

/** V6.8 §25 / V6.9-A §30: RCS Members sheet — the stable roster with identity data and name history. */
export function rcsMembersSheet(lang: Language, members: readonly RcsMember[]): XlsxSheet {
  const sorted = [...members].sort((a, b) => a.id.localeCompare(b.id));
  return {
    name: t(lang, 'dataset.rcsMembers'),
    headers: [
      t(lang, 'members.memberId'),
      t(lang, 'members.name'),
      t(lang, 'columns.team'),
      t(lang, 'members.role'),
      t(lang, 'members.startDate'),
      t(lang, 'members.endDate'),
      t(lang, 'members.status'),
      t(lang, 'members.nameHistory'),
    ],
    rows: sorted.map((member) => [
      member.id,
      member.name,
      member.team,
      member.role,
      { kind: 'date', value: member.startDate },
      member.endDate === undefined ? '' : { kind: 'date', value: member.endDate },
      member.active ? t(lang, 'members.active') : t(lang, 'members.inactive'),
      (member.nameHistory ?? []).map((entry) => nameHistoryEntryLabel(entry)).join(' / '),
    ]),
  };
}

/** V6.8 §25: Tester Assignments sheet — identity-based roster per project. */
export function testerAssignmentsSheet(
  lang: Language,
  assignments: readonly TesterProjectAssignment[],
  members: readonly RcsMember[],
  projects: readonly ProjectRecord[],
): XlsxSheet {
  const nameOf = projectNameResolver(lang, projects);
  const memberById = new Map(members.map((member) => [member.id, member]));
  const sorted = [...assignments].sort(
    (a, b) =>
      a.projectId.localeCompare(b.projectId) ||
      a.startDate.localeCompare(b.startDate) ||
      (a.memberId ?? a.testerName ?? '').localeCompare(b.memberId ?? b.testerName ?? ''),
  );
  return {
    name: t(lang, 'dataset.testerAssignments'),
    headers: [
      t(lang, 'tickets.project'),
      t(lang, 'members.memberId'),
      t(lang, 'members.name'),
      t(lang, 'columns.team'),
      t(lang, 'members.role'),
      t(lang, 'performance.assignmentStartDate'),
      t(lang, 'performance.assignmentEndDate'),
      t(lang, 'members.status'),
    ],
    rows: sorted.map((assignment) => {
      const member = assignment.memberId !== undefined ? memberById.get(assignment.memberId) : undefined;
      return [
        nameOf(assignment.projectId),
        assignment.memberId ?? '',
        member?.name ?? assignment.testerName ?? '',
        member?.team ?? assignment.team ?? '',
        member?.role ?? '',
        { kind: 'date', value: assignment.startDate },
        assignment.endDate === undefined ? '' : { kind: 'date', value: assignment.endDate },
        assignment.active ? t(lang, 'performance.assignmentActive') : t(lang, 'performance.assignmentInactive'),
      ];
    }),
  };
}

// ---- V6.7: Tester Review sheet ---------------------------------------------------

/** Human-readable review period label ("H2 2026", "2026-09", "a ~ b"). */
export function reviewPeriodLabel(review: Pick<TesterReview, 'periodType' | 'periodStart' | 'periodEnd'>): string {
  switch (review.periodType) {
    case 'month':
      return review.periodStart.slice(0, 7);
    case 'h1':
      return `H1 ${review.periodStart.slice(0, 4)}`;
    case 'h2':
      return `H2 ${review.periodStart.slice(0, 4)}`;
    case 'year':
      return review.periodStart.slice(0, 4);
    default:
      return `${review.periodStart} ~ ${review.periodEnd}`;
  }
}

/**
 * V6.7 §27 / V6.8 §25: Tester Review sheet — one row per saved review, with
 * the objective metrics recalculated from the evidence chain for the
 * review's period (never stored values). Supervisor notes travel verbatim.
 */
export function testerReviewsSheet(
  lang: Language,
  reviews: readonly TesterReview[],
  records: readonly TesterDailyPerformance[],
  tickets: readonly BugTicket[],
  projects: readonly ProjectRecord[],
  members: readonly RcsMember[] = [],
): XlsxSheet {
  const nameOf = projectNameResolver(lang, projects);
  return {
    name: t(lang, 'dataset.testerReviews'),
    headers: [
      t(lang, 'review.period'),
      t(lang, 'performance.tester'),
      t(lang, 'members.memberId'),
      t(lang, 'review.status'),
      t(lang, 'performance.projectsCount'),
      t(lang, 'performance.activeDays'),
      t(lang, 'performance.casesTestedField'),
      t(lang, 'performance.avgPerDay'),
      t(lang, 'columns.pass'),
      t(lang, 'fields.casesFailed'),
      t(lang, 'columns.notApplicable'),
      t(lang, 'columns.blocked'),
      t(lang, 'fields.casesRetest'),
      t(lang, 'fields.casesQuestioned'),
      t(lang, 'columns.spoAssigned'),
      t(lang, 'performance.bugsFound'),
      t(lang, 'performance.bugDiscoveryRate'),
      t(lang, 'review.summary'),
      t(lang, 'review.strengths'),
      t(lang, 'review.improvement'),
      t(lang, 'review.supervisorNotes'),
      t(lang, 'columns.date') + ' (created)',
      t(lang, 'columns.date') + ' (updated)',
    ],
    rows: [...reviews]
      .sort(
        (a, b) =>
          a.periodStart.localeCompare(b.periodStart) || a.testerName.localeCompare(b.testerName),
      )
      .map((review) => {
        const options = { range: { start: review.periodStart, end: review.periodEnd }, members };
        const key = review.memberId ?? review.testerName.trim();
        const row = aggregateTesterPerformance(records, tickets, options).find(
          (candidate) => (candidate.memberId ?? candidate.testerName) === key,
        );
        const breakdown = getTesterProjectBreakdown(records, tickets, review.memberId ?? review.testerName, options);
        return [
          reviewPeriodLabel(review),
          review.testerName,
          review.memberId ?? '',
          review.status === 'completed' ? t(lang, 'review.completed') : t(lang, 'review.draft'),
          breakdown.map((entry) => nameOf(entry.projectId)).join(' / '),
          row?.activeDays ?? 0,
          row?.casesTested ?? 0,
          row === undefined || row.activeDays === 0 ? 0 : Math.round(row.averageCasesPerDay * 100) / 100,
          row?.casesPassed ?? 0,
          row?.casesFailed ?? 0,
          row?.casesNotApplicable ?? 0,
          row?.casesBlocked ?? 0,
          row?.casesRetest ?? 0,
          row?.casesQuestioned ?? 0,
          row?.casesSpoAssigned ?? 0,
          row?.bugsFound ?? 0,
          row?.bugDiscoveryRate === null || row?.bugDiscoveryRate === undefined
            ? '—'
            : Math.round(row.bugDiscoveryRate * 100) / 100,
          review.summaryNote ?? '',
          review.strengthsNote ?? '',
          review.improvementNote ?? '',
          review.supervisorNote ?? '',
          { kind: 'date', value: review.createdAt.slice(0, 10) },
          { kind: 'date', value: review.updatedAt.slice(0, 10) },
        ];
      }),
  };
}

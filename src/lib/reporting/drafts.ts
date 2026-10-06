import type {
  AppState,
  AttendanceRecord,
  DailyReport,
  DailyTopic,
  Language,
  ReportActivity,
} from '../../types';
import { generateId } from '../id';
import { resolveBilingualName, t } from '../../i18n';

/** Pure daily-report lifecycle helpers (no React, no storage). */

export function findDraft(reports: DailyReport[], date: string): DailyReport | undefined {
  return reports.find((r) => r.reportDate === date && r.status === 'DRAFT');
}

export function newDraft(
  date: string,
  language: Language,
  createdBy: string,
  nowIso: string,
  projectId: string | null = null,
): DailyReport {
  return {
    id: generateId(),
    reportDate: date,
    language,
    status: 'DRAFT',
    projectId,
    revisionOf: null,
    jiraUrl: null,
    activities: [],
    nextDay: [],
    morningSchedule: [],
    morningPreviewText: '',
    previewText: '',
    createdBy,
    createdAt: nowIso,
    updatedAt: nowIso,
    finalizedAt: null,
    finalizedBy: null,
    snapshot: null,
  };
}

/**
 * Finalize: freeze a snapshot of attendance, topics and the report-owned
 * activity/next-day data so the historical report never recalculates. The
 * project reference (stable Project ID) is preserved in the snapshot, along
 * with the displayed project names inside the activity copies.
 */
export function finalizeReport(
  report: DailyReport,
  attendance: AttendanceRecord[],
  topics: DailyTopic[],
  supervisor: string,
  nowIso: string,
): DailyReport {
  return {
    ...report,
    status: 'FINALIZED',
    finalizedAt: nowIso,
    finalizedBy: supervisor,
    updatedAt: nowIso,
    snapshot: {
      language: report.language,
      projectId: report.projectId,
      jiraUrl: report.jiraUrl,
      activities: report.activities.map((a) => ({ ...a })),
      attendance: attendance.map((r) => ({ ...r })),
      topics: topics.map((tp) => ({ ...tp })),
      nextDay: report.nextDay.map((n) => ({ ...n })),
      morningSchedule: (report.morningSchedule ?? []).map((n) => ({ ...n })),
      morningPreviewText: report.morningPreviewText ?? '',
    },
  };
}

/** A revised version starts as an editable copy of a finalized report. */
export function createRevision(report: DailyReport, nowIso: string): DailyReport {
  const source = report.snapshot ?? {
    language: report.language,
    projectId: report.projectId,
    jiraUrl: report.jiraUrl,
    activities: report.activities,
    attendance: [],
    topics: [],
    nextDay: report.nextDay,
  };
  return {
    id: generateId(),
    reportDate: report.reportDate,
    language: source.language,
    status: 'DRAFT',
    projectId: source.projectId ?? null,
    revisionOf: report.id,
    jiraUrl: source.jiraUrl,
    activities: source.activities.map((a) => ({ ...a, id: generateId() })),
    nextDay: source.nextDay.map((n) => ({ ...n, id: generateId() })),
    morningSchedule: (source.morningSchedule ?? []).map((n) => ({ ...n, id: generateId() })),
    morningPreviewText: report.morningPreviewText ?? '',
    previewText: report.previewText,
    createdBy: report.finalizedBy ?? report.createdBy,
    createdAt: nowIso,
    updatedAt: nowIso,
    finalizedAt: null,
    finalizedBy: null,
    snapshot: null,
  };
}

/**
 * Auto-seed report activities from the live QA plan state. Only the tester
 * count is taken from the planning row for the selected date. Everything is
 * copied — later edits never touch the original plan data.
 *
 * Input consolidation: when a daily execution ENTRY exists for the report
 * date, the day's status counts (Pass/Fail/N-A/SPO/Blocked/Retest/
 * Questioned) and the actual tester count are seeded from THAT entry (the
 * canonical input, Dashboard → Today's Execution) instead of the
 * cumulative projection fields. The progress counts (completed/started)
 * stay cumulative — the report's progress percentages are calculated
 * against them. Projects without an entry for the date keep the legacy
 * cumulative seeding.
 */
export function seedAutoActivities(language: Language, state: AppState, date: string): ReportActivity[] {
  const planningRow = state.planningRows.find((row) => row.date === date);
  const entry = (state.dailyExecuted ?? []).find((row) => row.date === date);
  const available = entry !== undefined
    ? Math.max(0, entry.testers)
    : planningRow
      ? Math.max(0, planningRow.plannedTesters - planningRow.absentTesters)
      : state.currentTesters;
  const remaining = Math.max(0, state.totalCases - state.casesCompleted);
  if (remaining <= 0 && state.totalCases <= 0) return [];
  const name =
    resolveBilingualName(language, { nameEn: state.projectNameEn, nameJa: state.projectNameJa }) ||
    t(language, 'app.title');
  const workingStatus =
    state.casesCompleted >= state.totalCases && state.totalCases > 0
      ? t(language, 'status.completed')
      : state.casesCompleted > 0
        ? t(language, 'status.working')
        : t(language, 'status.notStarted');
  return [
    {
      id: generateId(),
      source: 'AUTO',
      name,
      memberCount: available,
      completedCases: state.casesCompleted,
      workingStatus,
      included: true,
      totalCases: state.totalCases,
      workingEligibleCases: state.totalCases,
      startedCases: state.casesCompleted,
      blockedCases: entry !== undefined ? entry.blocked : state.casesBlocked ?? 0,
      notApplicableCases: entry !== undefined ? entry.notApplicable : state.casesNotApplicable ?? 0,
      spoAssigned: entry !== undefined ? entry.spo : state.spoAssigned ?? 0,
      casesPassed: entry !== undefined ? entry.pass : state.casesPassed ?? 0,
      casesFailed: entry !== undefined ? entry.fail : state.casesFailed ?? 0,
      casesRetest: entry !== undefined ? entry.retest : state.casesRetest ?? 0,
      casesQuestioned: entry !== undefined ? entry.questioned : state.casesQuestioned ?? 0,
      dueDate: state.targetCompletionDate,
    },
  ];
}

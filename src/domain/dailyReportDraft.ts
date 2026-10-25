import type { Language, ProjectRecord, ReportActivity, ReportStaffing } from '../types';
import type { AppState } from '../types';
import { entryCompletedCases } from '../lib/calculations/dailyExecuted';
import { seedAutoActivities } from '../lib/reporting/drafts';
import { buildSupervisorDailyOperations, type ProjectDayOps, type SupervisorAttentionItem, type SupervisorOpsInput } from './supervisorOperations';
import type { ReadinessReason } from './readiness';
import { resolveBilingualName } from '../i18n';

/**
 * Daily Report preparation: ONE pure mapping from the workspace's operational data into the sections of the existing Daily Report
 * (staffing facts, activities, topics). The Command Center previews it and the Daily Report composer starts from it, so there is a
 * single generator. It is deterministic, read-only, makes no network call, and never saves anything: a report is only written when
 * the supervisor explicitly applies the draft, and a finalized report is never touched.
 *
 * Time semantics:
 *  - TODAY (selected date == current business day): current operational topics are allowed (open critical defect, late forecast, a
 *    staffing gap) because they are the supervisor's end-of-day reality.
 *  - A HISTORICAL date: only day-specific facts become the draft (that day's saved execution, actual testers, case history). Current
 *    readiness, tickets, assignments and the forecast are NOT historical, so they are returned separately as `currentContext` and
 *    never become draft content.
 */

export interface DailyReportDraftInput extends SupervisorOpsInput {
  /** The report language (activity names follow it). */
  language: Language;
}

export type PreparedTopicSource =
  | { kind: 'readiness'; reason: ReadinessReason }
  | { kind: 'dayFailures'; count: number }
  | { kind: 'dayBlocked'; count: number };

export interface PreparedTopic {
  projectId: string;
  projectName: string;
  severity: 'blocking' | 'warning';
  /** `day`: a fact of the selected day. `current`: the present state (today's report only). */
  scope: 'day' | 'current';
  /** Stable code (a readiness reason code, or day_failures / day_blocked). */
  code: string;
  source: PreparedTopicSource;
}

export type DraftGap = 'noActivity' | 'noStaffing' | 'noTopics';

export interface PreparedDailyReportDraft {
  date: string;
  isHistorical: boolean;
  language: Language;
  /** Staffing facts - not formal attendance. Historical days carry the actual testers only (planned / assigned are current-state). */
  staffing: ReportStaffing;
  /** Ready for the existing report model: one AUTO activity per project that had work on the date. */
  activities: ReportActivity[];
  topics: PreparedTopic[];
  /** Historical drafts only: the present-state attention items, shown for context and never inserted into the draft. */
  currentContext: SupervisorAttentionItem[];
  /** Plain completeness facts (no score). */
  missing: DraftGap[];
}

const PRESENT_ONLY_DUPLICATES: ReadonlySet<string> = new Set(['test_failures_open', 'blocked_cases_open']);

/** The state the existing activity seeding reads, as of the report date (the cumulative progress up to that day, never "today's"). */
function asOfState(project: ProjectRecord, date: string): AppState {
  const entries = project.inputs.dailyExecuted ?? [];
  const upTo = entries.filter((e) => e.date <= date);
  const completed = entries.length === 0 ? project.inputs.casesCompleted : upTo.reduce((sum, e) => sum + entryCompletedCases(e), 0);
  return { ...project.inputs, casesCompleted: completed, projectNameEn: project.nameEn, projectNameJa: project.nameJa } as unknown as AppState;
}

export function prepareDailyReportDraft(input: DailyReportDraftInput): PreparedDailyReportDraft {
  const ops = buildSupervisorDailyOperations(input);
  const { language, selectedDate } = input;
  const worked = ops.projects.filter((p) => p.hadExecution);
  const byId = new Map(input.projects.map((p) => [p.projectId, p] as const));
  // Names follow the REPORT language, never the UI's (a Japanese report must not carry an English project name).
  const nameIn = (projectId: string, fallback: string): string => {
    const r = byId.get(projectId);
    return r === undefined ? fallback : resolveBilingualName(language, { nameEn: r.nameEn, nameJa: r.nameJa }) || fallback;
  };

  const activities: ReportActivity[] = worked.flatMap((p: ProjectDayOps) => {
    const record = byId.get(p.projectId) as ProjectRecord;
    const [seeded] = seedAutoActivities(language, asOfState(record, selectedDate), selectedDate);
    if (seeded === undefined) return [];
    // Types come from what was actually executed that day; today's report may fall back to the project's current structure.
    const executedTypes = p.detailedByWorkType.filter((d) => d.uniqueCasesExecuted > 0).map((d) => d.workType as string);
    const types = executedTypes.length > 0 ? executedTypes : ops.isHistorical ? [] : p.workTypes.map((w) => w as string);
    return [
      {
        ...seeded,
        ...(types.length > 0 ? { workTypes: types } : {}),
        ...(!ops.isHistorical && types.includes('verification') ? { ticketCount: p.tickets.openOrInProgress } : {}),
      },
    ];
  });

  const actuals = worked.map((p) => p.staffing.actual).filter((n): n is number => n !== null);
  const staffing: ReportStaffing = {
    planned: ops.isHistorical ? null : ops.summary.plannedTesters,
    assigned: ops.isHistorical ? null : ops.summary.assignedTesters,
    actual: actuals.length === 0 ? null : actuals.reduce((a, b) => a + b, 0),
  };

  const topics: PreparedTopic[] = [];
  for (const p of worked) {
    if ((p.saved?.failed ?? 0) > 0) topics.push({ projectId: p.projectId, projectName: nameIn(p.projectId, p.projectName), severity: 'warning', scope: 'day', code: 'day_failures', source: { kind: 'dayFailures', count: p.saved?.failed ?? 0 } });
    if ((p.saved?.blocked ?? 0) > 0) topics.push({ projectId: p.projectId, projectName: nameIn(p.projectId, p.projectName), severity: 'warning', scope: 'day', code: 'day_blocked', source: { kind: 'dayBlocked', count: p.saved?.blocked ?? 0 } });
  }
  const attention = ops.summary.attentionItems.filter((a) => a.severity !== 'info' && !PRESENT_ONLY_DUPLICATES.has(a.reasonCode));
  if (!ops.isHistorical) {
    for (const a of attention) topics.push({ projectId: a.projectId, projectName: nameIn(a.projectId, a.projectName), severity: a.severity === 'blocking' ? 'blocking' : 'warning', scope: 'current', code: a.reasonCode, source: { kind: 'readiness', reason: a.reason } });
  }
  topics.sort((a, b) => Number(b.severity === 'blocking') - Number(a.severity === 'blocking') || a.projectName.localeCompare(b.projectName) || a.code.localeCompare(b.code));

  const missing: DraftGap[] = [];
  if (activities.length === 0) missing.push('noActivity');
  if (staffing.planned === null && staffing.assigned === null && staffing.actual === null) missing.push('noStaffing');
  if (topics.length === 0) missing.push('noTopics');

  return { date: selectedDate, isHistorical: ops.isHistorical, language, staffing, activities, topics, currentContext: ops.isHistorical ? attention.map((a) => ({ ...a, projectName: nameIn(a.projectId, a.projectName) })) : [], missing };
}

export type DailyReportDateState = 'none' | 'draft' | 'finalized';

/** What exists for a date: nothing, an editable draft, or a finalized snapshot (which is never regenerated or overwritten). */
export function reportStateForDate(reports: ReadonlyArray<{ reportDate: string; status: 'DRAFT' | 'FINALIZED' | string }>, date: string): DailyReportDateState {
  // An editable draft (including a revision of a finalized report) is what the supervisor continues; a finalized report alone is read-only.
  if (reports.some((r) => r.reportDate === date && r.status === 'DRAFT')) return 'draft';
  if (reports.some((r) => r.reportDate === date && r.status === 'FINALIZED')) return 'finalized';
  return 'none';
}

export type DailyReportDeliveryState = 'none' | 'draft' | 'finalizedNotPublished' | 'finalizedPublished';

/**
 * Where a date's report stands for the supervisor: nothing, a draft (including a revision), finalized but not yet delivered, or
 * finalized and published. Finalized is NOT published. When a date has several finalized versions (revisions), the latest one decides.
 */
export function reportDeliveryStateForDate(
  reports: ReadonlyArray<{ reportDate: string; status: string; finalizedAt?: string | null; createdAt?: string; publicationStatus?: unknown }>,
  date: string,
): DailyReportDeliveryState {
  const state = reportStateForDate(reports, date);
  if (state !== 'finalized') return state;
  const latest = reports
    .filter((r) => r.reportDate === date && r.status === 'FINALIZED')
    .sort((a, b) => (b.finalizedAt ?? b.createdAt ?? '').localeCompare(a.finalizedAt ?? a.createdAt ?? ''))[0];
  return latest !== undefined && latest.publicationStatus === 'published' ? 'finalizedPublished' : 'finalizedNotPublished';
}

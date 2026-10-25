import type { AttendanceRecord, AttendanceStatus, DailyTopic, Language, NextDayItem, ProgressRules, ReportActivity, ReportStaffing, RcsMember } from '../../types';
import { t } from '../../i18n';
import { calculateActivityProgress, formatPercent } from './progress';

/**
 * Section renderers for the daily report. Everything is produced from
 * translation templates with {variables} in the report language — which is
 * independent of the UI language. Data comes from report-owned records
 * (live draft data or a finalized snapshot), never recalculated from live
 * plan state.
 */

/** Statuses that count as attending for the "x/y members attending" summary. */
const ATTENDING_STATUSES: readonly AttendanceStatus[] = ['PRESENT', 'LATE', 'HALF_DAY'];

export function isAttending(status: AttendanceStatus): boolean {
  return ATTENDING_STATUSES.includes(status);
}

/**
 * Overall attending/total pair across every team (team display was removed —
 * only the RCS side remains). Total is the ACTIVE roster size (or the record
 * count when more rows exist — external people / legacy full rosters).
 */
export function overallAttendingTotal(
  records: readonly AttendanceRecord[],
  members: readonly RcsMember[] = [],
): { attending: number; total: number } {
  const total = Math.max(members.filter((m) => m.active).length, records.length);
  const absent = records.filter((r) => !isAttending(r.status)).length;
  return { attending: Math.max(0, total - absent), total };
}

/**
 * "7/8 members attending" — a single overall line (team display was removed
 * from the UI; per-team lines are no longer rendered).
 *
 * Attendance input is absence-only: records exist for absences (and legacy
 * explicit-attendance rows), and members WITHOUT a record attend by default.
 * Returns '' when there is no roster and no records (nothing to report).
 */
export function renderAttendanceSection(lang: Language, records: AttendanceRecord[], members: readonly RcsMember[] = []): string {
  const { attending, total } = overallAttendingTotal(records, members);
  if (total === 0) return '';
  return t(lang, 'report.attendanceOverallLine', { attending, total });
}

/** "Planned 8 · Assigned 7 · Actual 6" - the staffing facts, labelled as staffing (never as attendance). Empty when nothing is known. */
export function renderStaffingLine(lang: Language, staffing: ReportStaffing | undefined): string {
  if (staffing === undefined) return '';
  const parts = [
    staffing.planned === null ? null : t(lang, 'report.staffingPlanned', { n: staffing.planned }),
    staffing.assigned === null ? null : t(lang, 'report.staffingAssigned', { n: staffing.assigned }),
    staffing.actual === null ? null : t(lang, 'report.staffingActual', { n: staffing.actual }),
  ].filter((x): x is string => x !== null);
  return parts.length === 0 ? '' : `${t(lang, 'report.staffingLabel')}: ${parts.join(' · ')}`;
}

const WORK_TYPE_ORDER = ['regression', 'sanity', 'adhoc', 'verification'];

function activityLine(lang: Language, a: ReportActivity): string {
  const base = t(lang, 'report.activityLine', { count: a.memberCount, name: a.name });
  if (a.ticketCount === undefined) return base;
  // A Verification activity: test cases and JIRA tickets are different units and are shown as such.
  const cases = (a.casesPassed ?? 0) + (a.casesFailed ?? 0) + a.notApplicableCases + (a.spoAssigned ?? 0);
  return `${base} (${t(lang, 'report.activityUnits', { cases, tickets: a.ticketCount })})`;
}

/**
 * "8: Android 4.1.0 R-can Sanity test" lines for included activities. Activities that were PREPARED with QA work types are grouped under
 * a work-type heading (from the keys frozen in the activity, so a later change to a scope never re-groups a saved report); older
 * activities render exactly as before.
 */
export function renderActivitiesSection(lang: Language, activities: ReportActivity[]): string {
  const included = activities.filter((a) => a.included);
  if (!included.some((a) => a.workTypes !== undefined)) return included.map((a) => t(lang, 'report.activityLine', { count: a.memberCount, name: a.name })).join('\n');
  const groups = new Map<string, { label: string; rank: number; lines: string[] }>();
  for (const a of included) {
    const types = a.workTypes !== undefined && a.workTypes.length > 0 ? a.workTypes : ['unspecified'];
    const key = types.join('+');
    const label = types.map((w) => t(lang, `qa.workType.${w}` as Parameters<typeof t>[1])).join(' / ');
    const rank = Math.min(...types.map((w) => (WORK_TYPE_ORDER.includes(w) ? WORK_TYPE_ORDER.indexOf(w) : WORK_TYPE_ORDER.length)));
    const g = groups.get(key) ?? { label, rank, lines: [] };
    g.lines.push(`- ${activityLine(lang, a)}`);
    groups.set(key, g);
  }
  return [...groups.values()]
    .sort((x, y) => x.rank - y.rank || x.label.localeCompare(y.label))
    .map((g) => `${g.label}\n${g.lines.join('\n')}`)
    .join('\n\n');
}

/** Title + blank line + multiline description blocks. */
export function renderTopicsSection(_lang: Language, topics: DailyTopic[]): string {
  const ordered = [...topics].sort((a, b) => a.displayOrder - b.displayOrder);
  return ordered.map((topic) => `${topic.title}\n\n${topic.description}`).join('\n\n');
}

/** "10/5" style short due date; null → localized "None". */
export function formatDueDateShort(lang: Language, dueDate: string | null): string {
  if (dueDate === null) return t(lang, 'report.dueDateNone');
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueDate);
  if (!m) return dueDate;
  return `${Number(m[2])}/${Number(m[3])}`;
}

/** Per-activity progress blocks in the SPO format. */
export function renderProgressSection(lang: Language, activities: ReportActivity[], rules: ProgressRules): string {
  return activities
    .filter((a) => a.included)
    .map((a) => {
      const progress = calculateActivityProgress(a, rules);
      const lines = [
        t(lang, 'report.progressWorkingLine', {
          pct: formatPercent(progress.workingPct),
          count: progress.workingCount,
          denom: progress.workingDenom,
        }),
        t(lang, 'report.progressCompleteLine', {
          pct: formatPercent(progress.completePct),
          count: progress.completeCount,
          denom: progress.completeDenom,
        }),
        // V6.5 §13: QA Tested shown only when it differs from Completed
        // (i.e. SPO > 0) — otherwise the complete line already covers it.
        ...((a.spoAssigned ?? 0) > 0
          ? [
              t(lang, 'report.progressQaTestedLine', {
                count: Math.max(0, a.completedCases - (a.spoAssigned ?? 0)),
              }),
            ]
          : []),
        // Status lines appear only when the corresponding value is > 0
        // (V6.4); reports without them keep the original format.
        ...(a.casesFailed !== undefined && a.casesFailed > 0
          ? [t(lang, 'report.progressFailLine', { count: a.casesFailed })]
          : []),
        ...(a.notApplicableCases > 0
          ? [t(lang, 'report.progressNotApplicableLine', { count: a.notApplicableCases })]
          : []),
        ...(a.spoAssigned !== undefined && a.spoAssigned > 0
          ? [t(lang, 'report.progressSpoLine', { count: a.spoAssigned })]
          : []),
        ...(a.blockedCases > 0
          ? [t(lang, 'report.progressBlockedLine', { count: a.blockedCases })]
          : []),
        ...(a.casesRetest !== undefined && a.casesRetest > 0
          ? [t(lang, 'report.progressRetestLine', { count: a.casesRetest })]
          : []),
        ...(a.casesQuestioned !== undefined && a.casesQuestioned > 0
          ? [t(lang, 'report.progressQuestionedLine', { count: a.casesQuestioned })]
          : []),
        t(lang, 'report.progressDueLine', { due: formatDueDateShort(lang, a.dueDate) }),
      ].join('\n');
      return `${a.name}\n\n${lines}`;
    })
    .join('\n\n');
}

export function renderNextDaySection(_lang: Language, items: NextDayItem[]): string {
  return items.map((item) => item.text).join('\n');
}

/** Placeholder values for the report template, in report language. */
export interface ReportSectionsInput {
  language: Language;
  activities: ReportActivity[];
  attendance: AttendanceRecord[];
  /** Member roster for absence-aware attendance totals (optional, legacy-compatible). */
  members?: RcsMember[];
  topics: DailyTopic[];
  nextDay: NextDayItem[];
  jiraUrl: string;
  rules: ProgressRules;
  /** The rendered Execution Summary block (see lib/reporting/execution.ts); empty when not supplied. */
  executionSummary?: string;
  /** Staffing facts (Planned / Assigned / Actual): added under the Attendance heading as their own line. */
  staffing?: ReportStaffing;
}

/** All {placeholders} consumed by the default report templates. */
export function buildReportSections(input: ReportSectionsInput): Record<string, string> {
  const { language } = input;
  return {
    active_test_names: input.activities
      .filter((a) => a.included)
      .map((a) => a.name)
      .join('\n'),
    // The formal attendance line stays as it is; the staffing facts are a separate, clearly labelled line beneath it.
    attendance: [renderAttendanceSection(language, input.attendance, input.members ?? []), renderStaffingLine(language, input.staffing)].filter((x) => x !== '').join('\n'),
    activities: renderActivitiesSection(language, input.activities),
    topics: renderTopicsSection(language, input.topics),
    progress: renderProgressSection(language, input.activities, input.rules),
    execution_summary: input.executionSummary ?? '',
    jira_url: input.jiraUrl,
    next_business_day: renderNextDaySection(language, input.nextDay),
  };
}

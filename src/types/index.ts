/** UI language. Japanese is the default (§20); supported locales: "ja", "en". */
export type Language = 'en' | 'ja';

/**
 * Optional bilingual name for user-generated entities (projects, tasks).
 * Both parts are free text as entered; when only one exists it is shown in
 * either language (see resolveBilingualName).
 */
export interface BilingualName {
  nameEn?: string;
  nameJa?: string;
}

/** Schedule health states (§16). COMPLETED has priority over other states. */
export type ScheduleStatus = 'NOT_STARTED' | 'ON_SCHEDULE' | 'AHEAD' | 'DELAYED' | 'COMPLETED';

/**
 * Minutes since midnight. Clock-time fields hold 0–1439; derived finish times
 * (expected/projected) may exceed 1440 and are displayed with a "(+Nd)" day
 * annotation instead of wrapping.
 */
export type MinutesOfDay = number;

/** Daily lunch break window in minutes since midnight. */
export interface LunchWindow {
  start: MinutesOfDay;
  end: MinutesOfDay;
}

/**
 * One day in the multi-day staffing plan (V2). Dates are "YYYY-MM-DD".
 * availableTesters is always derived (max(0, planned − absent)) and never
 * stored, keeping persisted data minimal and duplication-free.
 *
 * V7 per-day plan window overrides: every field is optional so pre-V7 rows
 * keep working — an unset field falls back to the project-level default
 * (QaInputs.startTime, the fixed 17:30 end, QaInputs.dailyOvertimeMinutes,
 * QaInputs.intervalEnabled). The PLAN is entered at project creation and
 * edited here; daily EXECUTION lives in DailyExecutionEntry.
 */
export interface PlanningRow {
  id: string;
  date: string;
  plannedTesters: number;
  absentTesters: number;
  nonWorkingDay: boolean;
  note: string;
  /** Planned start time override (minutes of day); undefined = project default. */
  startTime?: MinutesOfDay;
  /** Planned end time BEFORE overtime (minutes of day); undefined = 17:30. */
  endTime?: MinutesOfDay;
  /** Per-day overtime minutes override (0–180); undefined = project default. */
  overtimeMinutes?: number;
  /** Lunch interval taken this day (V7); undefined = project default (true). */
  intervalEnabled?: boolean;
}

/** Partial update for a planning row; the id is never patchable. */
export type PlanningRowPatch = Partial<Omit<PlanningRow, 'id'>>;

/**
 * Multi-day planning inputs (V2). Flattened into QaInputs for persistence.
 * targetCompletionTime is an optional "HH:mm" string; the intraday model
 * stays minutes-of-day and is parsed at the calculation boundary.
 */
export interface MultiDayPlanningInputs {
  /** Mirrors planningRows[0].date; changing it shifts the whole plan. */
  startDate: string;
  targetCompletionDate: string | null;
  targetCompletionTime: string | null;
  planningRows: PlanningRow[];
}

/** Raw user inputs — the only values persisted and imported/exported (§21). */
export interface QaInputs extends MultiDayPlanningInputs {
  totalCases: number;
  currentTesters: number;
  startTime: MinutesOfDay;
  targetFinish: MinutesOfDay;
  lunchStart: MinutesOfDay;
  lunchEnd: MinutesOfDay;
  perHourPerTester: number;
  /**
   * Daily overtime minutes (fixed, applied to every day — including today):
   * each day's productive window becomes Plan Start → 17:30 + overtime.
   * Deadline comparisons stay at 17:30, so overtime shows as reduced delay.
   * Optional so every pre-overtime payload stays valid; normalized to 0 on
   * load/import.
   */
  dailyOvertimeMinutes?: number;
  casesCompleted: number;
  /**
   * Level 2 (QA management): cumulative passed cases. Optional so every
   * pre-Level-2 payload stays valid; normalized to 0 on load/import.
   */
  casesPassed?: number;
  /**
   * SPO-assigned cases: QA could not execute them (environment/account/
   * device/resource unavailable) and responsibility was transferred to the
   * SPO side. NOT tested by QA, but counted as completed from the QA
   * responsibility perspective — i.e. they are part of casesCompleted.
   * Optional so every pre-V6.3 payload stays valid; normalized to 0 on
   * load/import.
   */
  spoAssigned?: number;
  /**
   * Failed cases (V6.4): executed by QA with a Fail result. Tested AND
   * completed — part of casesCompleted. Optional; normalized to 0.
   */
  casesFailed?: number;
  /**
   * N/A cases / 実施不可項目 (V6.4): not applicable execution results.
   * Tested AND completed — part of casesCompleted. Optional; normalized to 0.
   */
  casesNotApplicable?: number;
  /**
   * Blocked cases (V6.4): informational open-status tally. NOT completed,
   * never added to casesCompleted or Remaining. Optional; normalized to 0.
   */
  casesBlocked?: number;
  /**
   * Retest cases (V6.4): informational open-status tally. NOT completed,
   * never added to casesCompleted or Remaining. Optional; normalized to 0.
   */
  casesRetest?: number;
  /**
   * 質問中 cases (V6.4): informational open-status tally. NOT completed,
   * never added to casesCompleted or Remaining. Optional; normalized to 0.
   */
  casesQuestioned?: number;
  /**
   * Lunch interval (V7): true = the fixed 12:00–13:00 interval is deducted
   * from every day's productive window; false = the interval is not taken
   * (the whole window is productive). Optional so every pre-V7 payload stays
   * valid; normalized to true on load/import (the previous fixed behavior).
   */
  intervalEnabled?: boolean;
  /**
   * Daily executed entries (V7) — the single source of truth for ACTUAL
   * execution: one entry per day with the actual time window, actual tester
   * count and that day's status counts. The legacy cumulative fields
   * (casesCompleted, casesPassed, …) become a maintained projection:
   * syncActualsFromDailyExecuted recomputes them as Σ entries, and
   * dailyActuals snapshots are regenerated as cumulative-at-end-of-day.
   * Optional; normalized to [] (then migrated) on load/import.
   */
  dailyExecuted?: DailyExecutionEntry[];
  /** Target pass rate (0–1) used to derive the daily pass plan; default 1. */
  targetPassRate?: number;
  /** Manual per-day overrides of the generated daily plan; keyed by date. */
  dailyTargetOverrides?: DailyTargetOverride[];
  /** End-of-day cumulative actual snapshots for trend/gap analysis. */
  dailyActuals?: DailyActualSnapshot[];
  /** QA blocking / unavailable-time events. */
  blockingEvents?: BlockingEvent[];
  /** Configurable milestones with automatic reach detection. */
  milestones?: Milestone[];
  /**
   * JIRA bug tickets recorded for this project (V6.6). Project-scoped —
   * each record also carries the owning stable Project ID. Optional so
   * every pre-V6.6 payload stays valid; normalized to [] on load/import.
   * Bug counts are always derived (bugTickets.length), never stored.
   */
  bugTickets?: BugTicket[];
  /**
   * Tester-level daily execution records (V6.6). The existing execution
   * model is project-level, so tester performance cannot be derived from
   * it; these records are the single manual source for tester analytics.
   * Optional; normalized to [] on load/import.
   */
  testerDailyPerformance?: TesterDailyPerformance[];
}

// ---- RCS member master & identity-based execution (V6.8) ----

/**
 * One historical name of an RCS member (V6.9-A). Old records keep their
 * originally recorded display name; this entry lets such a name be resolved
 * back to the stable member id WITHOUT rewriting history. Dates are optional
 * inclusive "YYYY-MM-DD" bounds describing when the name was in use.
 */
export interface RcsMemberNameHistory {
  name: string;
  fromDate?: string;
  toDate?: string;
}

/**
 * One RCS member in the workspace-level member master (V6.8). `id` is the
 * PERMANENT identity ("USER0003") — it never changes when the member is
 * edited, renamed or deactivated; `name` is display data only. No
 * execution/attendance/performance data lives here (those belong to their
 * own domain models).
 *
 * V6.9-A: `nameHistory` holds previous names so legacy records recorded
 * under an old name resolve to the same stable identity. It never replaces
 * the current name.
 */
export interface RcsMember {
  id: string;
  /** Display name (user text; may change — the id stays stable). */
  name: string;
  team: string;
  role: string;
  /** "YYYY-MM-DD" (required, inclusive). */
  startDate: string;
  /** "YYYY-MM-DD" (optional, inclusive; undefined = open-ended). */
  endDate?: string;
  active: boolean;
  /** Previous names (V6.9-A); absent on pre-V6.9 data. */
  nameHistory?: RcsMemberNameHistory[];
}

/** Initial RCS member master seed (V6.8 §3) — stable ids, seeded once. */
export const SEED_RCS_MEMBERS: readonly RcsMember[] = [
  { id: 'USER0001', name: 'Tokunaga Hiroshi', team: 'RCS', role: 'SV', startDate: '2026-07-01', active: true },
  { id: 'USER0002', name: 'Damith Fernando', team: 'RCS', role: 'SV', startDate: '2026-07-01', active: true },
  { id: 'USER0003', name: 'Yamauchi Kentaro', team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true },
  { id: 'USER0004', name: 'Kobayashi Masashi', team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true },
  { id: 'USER0005', name: 'Osaki Kazuki', team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true },
  { id: 'USER0006', name: 'Iwabuchi Mika', team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true },
  { id: 'USER0007', name: 'Niizeki Keitaro', team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true },
  { id: 'USER0008', name: 'Anno Masahiro', team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true },
];

// ---- Bug tracking & tester performance (V6.6) ----

/**
 * How a TesterDailyPerformance record came to exist (V6.7 §10):
 * - automatic: derived from tester-attributed execution data
 * - assisted: derived from project totals + tester assignment (equal-split
 *   proposal confirmed/adjusted by the supervisor)
 * - manual: entered by hand in the V6.6 form
 * - manualOverride: a supervisor corrected an automatic/assisted record;
 *   synchronization never overwrites it afterwards
 * Legacy records without the field keep it undefined (unknown → shown as
 * manual by default; historical data is never rewritten).
 */
export type PerformanceRecordSource = 'automatic' | 'assisted' | 'manual' | 'manualOverride';

export const PERFORMANCE_RECORD_SOURCES: readonly PerformanceRecordSource[] = [
  'automatic',
  'assisted',
  'manual',
  'manualOverride',
] as const;

/** JIRA bug severity (manually recorded; optional per ticket). */
export type BugSeverity = 'Critical' | 'Major' | 'Minor' | 'Trivial';

export const BUG_SEVERITIES: readonly BugSeverity[] = ['Critical', 'Major', 'Minor', 'Trivial'] as const;

/** JIRA bug workflow status (manually recorded; no JIRA API in V6.6). */
export type BugStatus = 'Open' | 'In Progress' | 'Resolved' | 'Closed' | 'Rejected' | 'Duplicate';

export const BUG_STATUSES: readonly BugStatus[] = [
  'Open',
  'In Progress',
  'Resolved',
  'Closed',
  'Rejected',
  'Duplicate',
] as const;

/** Audit trail of a manual identity resolution (V6.9-A §25). The application
 * has no login system, so no username is invented — only the fact that a
 * human made the decision, when, and (optionally) to which member.
 */
export interface IdentityResolutionAudit {
  method: 'manual';
  /** Target member when resolved; undefined = deliberately kept unresolved. */
  memberId?: string;
  /** ISO timestamp of the manual decision. */
  resolvedAt: string;
}

/**
 * One append-oriented identity-resolution audit entry (V6.9-B §29). Entries
 * are never rewritten — a member rename never destroys historical audit
 * information (the recorded name is preserved verbatim).
 *
 * V6.9-B extends the entry so AUTOMATED attribution resolutions are auditable
 * too: `method` may record how a raw attribution resolved (memberId /
 * externalId / currentName / historicalName / context) with a `confidence`,
 * alongside the original manual/bulk decisions. Pre-V6.9-B entries (method
 * manual/bulk, no confidence) stay valid unchanged.
 */
export interface IdentityAuditEntry {
  id: string;
  /** ISO timestamp of the decision. */
  timestamp: string;
  recordType: 'attendance' | 'execution' | 'bugTicket' | 'review';
  recordId: string;
  /** The record's own date when known (attendance date / ticket createdAt). */
  recordDate?: string;
  /** The originally recorded display name — historical truth. */
  recordedName: string;
  /** Identity state before the decision. */
  previousState: 'unmatched' | 'ambiguous';
  /** Target member when resolved; undefined = kept unresolved. */
  resolvedMemberId?: string;
  /**
   * How the decision was made: a human decision (manual / bulk) or the
   * evidence that resolved an automated attribution (V6.9-B).
   */
  method: 'manual' | 'bulk' | 'memberId' | 'externalId' | 'currentName' | 'historicalName' | 'context' | 'unresolved';
  /** Where the decision came from. */
  source: 'identityCenter' | 'bulkResolution' | 'attributionResolution';
  /** Resolution confidence (V6.9-B); absent on manual/bulk decisions. */
  confidence?: AttributionConfidence;
}

/** Confidence of an attribution resolution (V6.9-B §4). */
export type AttributionConfidence = 'high' | 'medium' | 'low' | 'ambiguous';

/**
 * Mapping between the internal member identity and an external system
 * account (V6.9-B §7 — data-model readiness only, NO API integration).
 * The internal `memberId` stays the single source of truth: external
 * identities are lookup aids for future systems such as JIRA, never the
 * primary identity key.
 */
export interface ExternalIdentity {
  /** Record id (append/edit handle); not the external id itself. */
  id: string;
  /** External system, e.g. "jira". Open for future providers. */
  provider: string;
  /** The account id in the external system (e.g. a JIRA username). */
  externalId: string;
  /** The internal member this account belongs to — the source of truth. */
  memberId: string;
  /** Optional account display name in the external system (display only). */
  displayName?: string;
  /** False once the mapping was retired; history is never deleted. */
  active: boolean;
  /** ISO timestamp when the mapping was linked. */
  linkedAt: string;
}

/** Providers the data model is prepared for (V6.9-B: JIRA only). */
export const EXTERNAL_IDENTITY_PROVIDERS: readonly string[] = ['jira'];

/**
 * One JIRA bug/ticket recorded for a project. `createdAt` is the JIRA
 * "Created Date" as a "YYYY-MM-DD" string (same convention as all other
 * dates in the app). `projectId` is the stable human-readable Project ID
 * ("PRJ-001") — identical to DailyReport.projectId.
 *
 * V6.9-A: `reporterMemberId` is the stable reporter identity when the
 * reporter is an RCS member (or was confidently migrated); `reportedBy`
 * keeps the original recorded display name for history and external
 * reporters. `identityResolution` records a manual resolution decision.
 */
export interface BugTicket {
  id: string;
  projectId: string;
  /** JIRA ticket key, e.g. "ABC-123"; recommended but optional. */
  ticketKey?: string;
  /** Bug title (required). */
  title: string;
  /** JIRA URL (required, clickable; opens in a new tab). */
  url: string;
  /** "YYYY-MM-DD" (required). */
  createdAt: string;
  /** Tester/reporter who discovered the bug (required). */
  reportedBy: string;
  /** Stable RCS reporter identity (V6.9-A); absent on legacy/external reporters. */
  reporterMemberId?: string;
  severity?: BugSeverity;
  status?: BugStatus;
  memo?: string;
  /** Manual identity-resolution audit (V6.9-A); absent unless a human decided. */
  identityResolution?: IdentityResolutionAudit;
}

/**
 * One tester's execution on one day in one project. `casesTested` is the
 * authoritative total executed by that tester that day; the status fields
 * are optional informational tallies following the existing V6.4/V6.5
 * semantics (Pass/Fail/N-A/SPO are completed categories; Blocked/Retest/
 * Questioned are open-status overlays) — they are NEVER summed or forced
 * to equal casesTested (§13: no double counting, no reinterpretation).
 */
export interface TesterDailyPerformance {
  id: string;
  /** "YYYY-MM-DD" (required). */
  date: string;
  /** Tester/member name (required; matches AttendanceRecord.memberName style). */
  testerName: string;
  team?: string;
  /** Stable owning Project ID ("PRJ-001"). */
  projectId: string;
  /** Total cases executed by this tester on this day (required, >= 0). */
  casesTested: number;
  casesPassed?: number;
  casesFailed?: number;
  casesNotApplicable?: number;
  casesBlocked?: number;
  casesRetest?: number;
  casesQuestioned?: number;
  casesSpoAssigned?: number;
  /**
   * How this record was created (V6.7 §10). Absent on legacy records —
   * historical data is never rewritten merely to populate this field.
   */
  source?: PerformanceRecordSource;
  /**
   * Stable RCS member identity (V6.8). Absent on pre-V6.8 records — they
   * keep working through their testerName (legacy-compatible data).
   */
  memberId?: string;
}

export type QaFieldName = keyof QaInputs;

/** Persisted application state: raw inputs + UI language. No derived data (§21). */
export interface AppState extends QaInputs {
  language: Language;
  /** Optional bilingual project name (user text, never machine-translated). */
  projectNameEn: string;
  projectNameJa: string;
  /** Level 2 presentation mode; default "operator". Preserved on project switch. */
  dashboardView?: DashboardView;
}

// ---- Level 2: QA management dashboard (V5) ----

/** Presentation modes: live execution (operator) vs reporting (manager). */
export type DashboardView = 'operator' | 'manager';

/** QA blocking categories for unavailable-time tracking (Level 2 §5). */
export type BlockingCategory = 'ENVIRONMENT' | 'BUILD' | 'TEST_DATA' | 'REQUIREMENT' | 'SYSTEM_ISSUE' | 'OTHER';

export const BLOCKING_CATEGORIES: readonly BlockingCategory[] = [
  'ENVIRONMENT',
  'BUILD',
  'TEST_DATA',
  'REQUIREMENT',
  'SYSTEM_ISSUE',
  'OTHER',
] as const;

/** One QA blocking event: unavailable time on a date, with a category. */
export interface BlockingEvent {
  id: string;
  /** YYYY-MM-DD */
  date: string;
  category: BlockingCategory;
  /** Unavailable minutes; > 0. */
  minutes: number;
  note: string;
}

/**
 * Manual override of one generated daily-plan row (Level 2 §3). The presence
 * of an entry for a date marks that row MANUAL; values survive every
 * recalculation and project-parameter change.
 */
export interface DailyTargetOverride {
  id: string;
  /** YYYY-MM-DD — must match a planning-row date. */
  date: string;
  plannedExecute: number;
  plannedPass: number;
}

/**
 * End-of-day actual snapshot: cumulative executed/passed totals frozen at the
 * end of a day, for trend charts and per-day gap analysis. The live
 * casesCompleted/casesPassed fields remain the single authoritative actuals.
 *
 * V6.5: optional granular execution fields preserve the full seven-status
 * breakdown at snapshot time. Legacy snapshots without them load unchanged —
 * missing granular values are NEVER inferred from the old aggregates.
 *
 * V7: with dailyExecuted entries present, snapshots are a DERIVED projection
 * (regenerated as the cumulative totals at the end of each entry's day); the
 * entries are the source of truth. Legacy snapshots without entries stay
 * authoritative until migrated.
 */
export interface DailyActualSnapshot {
  id: string;
  /** YYYY-MM-DD */
  date: string;
  executed: number;
  passed: number;
  /** Granular Pass at snapshot time (V6.5); falls back to `passed` for legacy. */
  casesPassed?: number;
  casesFailed?: number;
  casesNotApplicable?: number;
  spoAssigned?: number;
  casesBlocked?: number;
  casesRetest?: number;
  casesQuestioned?: number;
}

/**
 * One day's ACTUAL execution (V7) — entered daily on the Dashboard
 * ("Today's Execution"), one entry per date (past days editable).
 *
 * Status counts are FOR THAT DAY (not cumulative): Pass/Fail/N/A/SPO are
 * completed categories (their sum is the day's completed cases), while
 * Blocked/Retest/Questioned are informational open-status tallies.
 * `uncategorizedCompleted` covers completed cases that fit no status —
 * seeded by migration for legacy snapshots and freely editable by hand.
 */
export interface DailyExecutionEntry {
  id: string;
  /** YYYY-MM-DD; one entry per date. */
  date: string;
  /** Actual start time (minutes of day); null = not recorded. */
  startTime: number | null;
  /** Actual end time before overtime (minutes of day); null = not recorded. */
  endTime: number | null;
  /** Actual overtime minutes that day (0–180). */
  overtimeMinutes: number;
  /** Whether the lunch interval was actually taken. */
  intervalEnabled: boolean;
  /** Actual tester count that day. */
  testers: number;
  pass: number;
  fail: number;
  notApplicable: number;
  spo: number;
  /** Informational open-status tallies — never part of completion. */
  blocked: number;
  retest: number;
  questioned: number;
  /** Completed cases that fit no status (migration seed; hand-editable). */
  uncategorizedCompleted?: number;
  note: string;
}

export type MilestoneType = 'EXECUTE' | 'PASS';

/** Configurable progress milestone with automatic reach detection (Level 2 §7). */
export interface Milestone {
  id: string;
  /** Free-text label; empty means "use the default Execute/Pass N% label". */
  name: string;
  type: MilestoneType;
  /** 0 < targetPct <= 100. */
  targetPct: number;
  /** Planned date "YYYY-MM-DD" (optional). */
  plannedDate: string | null;
  /** Planned time "HH:mm" (optional; midnight when null). */
  plannedTime: string | null;
  /** ISO timestamp set automatically when the milestone is reached. */
  actualAt: string | null;
}

// ---- Daily Report module (V3) ----

export type AttendanceStatus = 'PRESENT' | 'ABSENT' | 'PAID_LEAVE' | 'HALF_DAY' | 'LATE' | 'OTHER';

export const ATTENDANCE_STATUSES: readonly AttendanceStatus[] = [
  'PRESENT',
  'ABSENT',
  'PAID_LEAVE',
  'HALF_DAY',
  'LATE',
  'OTHER',
] as const;

/**
 * Statuses that mark a member as NOT attending. Daily attendance input is
 * absence-only: a member with NO record for a date is attending by
 * default, so these are the only statuses the editor offers for new rows
 * (legacy explicit-attendance rows keep their recorded value).
 */
export const NON_ATTENDING_STATUSES: readonly AttendanceStatus[] = ['ABSENT', 'PAID_LEAVE', 'OTHER'] as const;

/**
 * One attendance record. `memberName` is the originally recorded display
 * name (historical truth — never rewritten). V6.9-A adds `memberId`, the
 * stable RCS identity when the record belongs to a member (or was
 * confidently migrated); `identityResolution` records a manual resolution.
 */
export interface AttendanceRecord {
  id: string;
  date: string;
  memberName: string;
  /** Stable RCS member identity (V6.9-A); absent on legacy records. */
  memberId?: string;
  team: string;
  status: AttendanceStatus;
  workingStart: string | null;
  workingEnd: string | null;
  leaveType: string | null;
  comment: string;
  /** Manual identity-resolution audit (V6.9-A); absent unless a human decided. */
  identityResolution?: IdentityResolutionAudit;
}

/**
 * One report activity line ("8: Android 4.1.0 R-can Sanity test"). Activities
 * are report-owned copies: display edits never touch the original plan data.
 * Progress values are stored explicitly (different denominators allowed) so
 * finalized reports never recalculate.
 */
export interface ReportActivity {
  id: string;
  source: 'AUTO' | 'MANUAL';
  name: string;
  memberCount: number;
  completedCases: number;
  workingStatus: string;
  included: boolean;
  totalCases: number;
  workingEligibleCases: number;
  startedCases: number;
  blockedCases: number;
  notApplicableCases: number;
  /** SPO対応 cases (V6.3): transferred to SPO because QA cannot execute them. Optional for legacy data. */
  spoAssigned?: number;
  /** Passed cases (V6.4). Optional for legacy activity data; defaults to 0. */
  casesPassed?: number;
  /** Failed cases (V6.4). Optional for legacy activity data; defaults to 0. */
  casesFailed?: number;
  /** Retest cases (V6.4): informational open-status tally. Optional; defaults to 0. */
  casesRetest?: number;
  /** 質問中 cases (V6.4): informational open-status tally. Optional; defaults to 0. */
  casesQuestioned?: number;
  dueDate: string | null;
}

export interface DailyTopic {
  id: string;
  reportDate: string;
  title: string;
  description: string;
  displayOrder: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface NextDayItem {
  id: string;
  text: string;
  /** SUGGESTED/MANUAL: EOD next-day items; AUTO: morning-report plan-seeded schedule items. */
  source: 'SUGGESTED' | 'MANUAL' | 'AUTO';
}

export type DailyReportStatus = 'DRAFT' | 'FINALIZED';

/** Frozen copy of every input the report was generated from. */
export interface DailyReportSnapshot {
  language: Language;
  /** Project reference by stable Project ID (name snapshots live in activities). */
  projectId: string | null;
  jiraUrl: string | null;
  activities: ReportActivity[];
  attendance: AttendanceRecord[];
  topics: DailyTopic[];
  nextDay: NextDayItem[];
  /** Morning-report schedule items (optional — pre-morning-report data stays valid). */
  morningSchedule?: NextDayItem[];
  /** Morning-report preview text (optional — pre-morning-report data stays valid). */
  morningPreviewText?: string;
}

export interface DailyReport {
  id: string;
  reportDate: string;
  /** Report language — independent from the UI language. */
  language: Language;
  status: DailyReportStatus;
  /** Stable Project ID this report was created for (null = unknown/legacy). */
  projectId: string | null;
  /** Id of the report this one revises (version chain). */
  revisionOf: string | null;
  jiraUrl: string | null;
  activities: ReportActivity[];
  nextDay: NextDayItem[];
  /** Morning-report schedule items (optional — pre-morning-report data stays valid). */
  morningSchedule?: NextDayItem[];
  /** Morning-report preview text (optional — pre-morning-report data stays valid). */
  morningPreviewText?: string;
  previewText: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
  finalizedBy: string | null;
  snapshot: DailyReportSnapshot | null;
}

export type ProgressDenominator = 'totalCases' | 'workingEligibleCases';

export interface ProgressRules {
  working: ProgressDenominator;
  complete: ProgressDenominator;
}

/** Automatic daily backup configuration (Settings; optional for old data). */
export interface AutoBackupSettings {
  /** Master switch — the backup runs on the first app start of a new day. */
  enabled: boolean;
  /** Display name of the chosen folder (informational; the handle lives in IndexedDB). */
  folderName: string | null;
  /** GanttChart's own dated backup files older than this are pruned on write. */
  retentionDays: number;
}

export interface ReportSettings {
  teams: string[];
  holidays: string[];
  supervisorName: string;
  projectJiraUrl: string;
  templates: Record<Language, string>;
  progressRules: ProgressRules;
  /** Automatic daily backup (optional — normalized with defaults on load). */
  autoBackup?: AutoBackupSettings;
}

export interface ReportsState {
  schemaVersion: number;
  settings: ReportSettings;
  attendance: AttendanceRecord[];
  topics: DailyTopic[];
  reports: DailyReport[];
  /** Project portfolio (V4). Optional in old persisted data — normalized on load. */
  projects: ProjectRecord[];
  /** Project currently loaded into the Dashboard/Gantt editing state. */
  activeProjectId: string | null;
  /**
   * Tester→project assignments (V6.7). Workspace-level because a tester's
   * assignment history can span every project. Optional so every pre-V6.7
   * payload stays valid; normalized to [] on load/import.
   */
  testerAssignments?: TesterProjectAssignment[];
  /**
   * Supervisor bonus-review records (V6.7). Workspace-level because an
   * H1/H2/yearly review spans multiple projects. Optional; normalized to [].
   */
  reviews?: TesterReview[];
  /**
   * RCS member master (V6.8). Workspace-level roster with stable member
   * ids. Absent in every pre-V6.8 payload — normalized by seeding the
   * initial member set exactly once (an intentionally emptied roster is
   * preserved as empty, never re-seeded).
   */
  rcsMembers?: RcsMember[];
  /**
   * Append-oriented identity-resolution audit log (V6.9-B §29). Entries are
   * only ever appended — never rewritten or pruned by renames/migrations.
   * Optional so every pre-V6.9-B payload stays valid; normalized to [].
   */
  identityAuditLog?: IdentityAuditEntry[];
  /**
   * External-identity mappings (V6.9-B §7): internal memberId ↔ external
   * system accounts (e.g. JIRA). Data-model readiness only — no API calls.
   * The memberId remains the source of truth. Optional so every pre-V6.9-B
   * payload stays valid; normalized to [] on load.
   */
  externalIdentities?: ExternalIdentity[];
}

// ---- Tester assignments & QA review workspace (V6.7) ----

/**
 * One tester's assignment to one project for a date period (V6.7 Part A).
 * Workspace-level (not project-scoped) so assignment history survives
 * project switches and spans the whole portfolio. endDate is open-ended
 * when undefined. `active` lets a supervisor retire an assignment without
 * losing its historical record.
 *
 * V6.8 identity: `memberId` is the stable identity (RcsMember.id) used by
 * every new record. `testerName` is preserved legacy-compatible data for
 * pre-V6.8 records that could not be confidently migrated — new records
 * set memberId (and may snapshot testerName for display).
 */
export interface TesterProjectAssignment {
  id: string;
  /** Stable owning Project ID ("PRJ-001") — same convention as BugTicket. */
  projectId: string;
  /** Stable RCS member identity (V6.8) — required for new records. */
  memberId?: string;
  /** Legacy V6.7 free-text tester name — kept for unmigrated records. */
  testerName?: string;
  team?: string;
  /** "YYYY-MM-DD" (required, inclusive). */
  startDate: string;
  /** "YYYY-MM-DD" (optional, inclusive; undefined = open-ended). */
  endDate?: string;
  active: boolean;
}

/** Review period kinds supported by the review workspace (V6.7 §18). */
export type ReviewPeriodType = 'month' | 'h1' | 'h2' | 'year' | 'custom';

export const REVIEW_PERIOD_TYPES: readonly ReviewPeriodType[] = ['month', 'h1', 'h2', 'year', 'custom'] as const;

export type ReviewStatus = 'draft' | 'completed';

export const REVIEW_STATUSES: readonly ReviewStatus[] = ['draft', 'completed'] as const;

/**
 * One supervisor review of one tester for one period (V6.7 Part B).
 * Objective metrics are NEVER stored here — they are recalculated from the
 * evidence chain on demand (reproducibility, §34). Only supervisor-entered
 * notes and status are persisted. Each (tester, period) review is stored
 * independently, so H1 and H2 never overwrite each other (§24).
 */
export interface TesterReview {
  id: string;
  /** Stable RCS member identity (V6.8); legacy reviews keep testerName only. */
  memberId?: string;
  testerName: string;
  periodType: ReviewPeriodType;
  /** Inclusive "YYYY-MM-DD" period bounds (required). */
  periodStart: string;
  periodEnd: string;
  status: ReviewStatus;
  summaryNote?: string;
  strengthsNote?: string;
  improvementNote?: string;
  supervisorNote?: string;
  createdAt: string;
  updatedAt: string;
}

// ---- Project portfolio (V4) ----

/**
 * User-set workflow status — independent from the calculated planning status.
 * - todo: scheduled, not started
 * - ongoing: work in progress
 * - extended: the schedule/deadline was officially extended; still active
 * - onHold: work paused (no capacity, no deadline pressure)
 * - done: finished
 */
export type ProjectLifecycleStatus = 'todo' | 'ongoing' | 'extended' | 'onHold' | 'done';

/** One lifecycle transition entry (audit trail for reporting). */
export interface ProjectStatusChange {
  status: ProjectLifecycleStatus;
  changedAt: string;
}

/**
 * One portfolio project. `inputs` mirrors QaInputs so every calculation
 * reuses the existing pure engine unchanged. `projectId` is the stable,
 * human-readable identifier ("PRJ-001") — it never changes when the name
 * changes and survives backup/restore; `id` is the internal record key.
 */
export interface ProjectRecord {
  id: string;
  projectId: string;
  nameEn: string;
  nameJa: string;
  team: string;
  status: ProjectLifecycleStatus;
  statusHistory: ProjectStatusChange[];
  completedAt: string | null;
  completedBy: string | null;
  createdAt: string;
  updatedAt: string;
  inputs: QaInputs;
  /** Optional free-text description (V6.2). Metadata only — never used in calculations. */
  description?: string;
  /** Optional project owner (V6.2). Metadata only. */
  owner?: string;
}

import type {
  AttendanceRecord,
  AutoBackupSettings,
  DailyReport,
  DailyTopic,
  ExternalIdentity,
  IdentityAuditEntry,
  ProjectRecord,
  ProjectStatusChange,
  QaInputs,
  RcsMember,
  RcsMemberNameHistory,
  ReportSettings,
  ReportsState,
  TesterProjectAssignment,
  TesterReview,
} from '../../types';
import { ATTENDANCE_STATUSES, REVIEW_PERIOD_TYPES, REVIEW_STATUSES } from '../../types';
import { checkCycle } from '../../../shared/qaRules';
import { DEFAULT_REPORT_TEMPLATES } from '../reporting/template';
import { DEFAULT_PROGRESS_RULES } from '../reporting/progress';
import { hasRecoveryPayload, stashCorruptedRaw } from './corruption';
import { isBlockingEvent, isBugTicket, isDailyActualSnapshot, isDailyTargetOverride, isIdentityResolutionAudit, isMilestone, isPlanningRow, isTesterDailyPerformance, normalizeQaInputs } from './storage';
import { ensureProjectIds } from '../../domain/projects/migrations';
import { migrateAssignmentsToMembers } from '../../domain/assignments';
import { seedRcsMembers } from '../../domain/members';
import { migrateAttendanceIdentity, migrateProjectBugTickets } from '../../domain/identityResolution';

/** Versioned localStorage key for the daily-report module (V3). */
export const REPORTS_STORAGE_KEY = 'ganttchart.reports.v1';

export const REPORTS_SCHEMA_VERSION = 1;

const PROJECT_LIFECYCLE_STATUSES: readonly string[] = ['todo', 'ongoing', 'extended', 'onHold', 'done'];

/** Default automatic-backup configuration (disabled until the user opts in). */
export const DEFAULT_AUTO_BACKUP_SETTINGS: AutoBackupSettings = {
  enabled: false,
  folderName: null,
  retentionDays: 30,
};

/** Suggested default teams (configurable from Settings). */
export const DEFAULT_REPORT_SETTINGS: ReportSettings = {
  teams: ['PrV', 'RCS'],
  holidays: [],
  supervisorName: '',
  projectJiraUrl: '',
  templates: { en: DEFAULT_REPORT_TEMPLATES.en, ja: DEFAULT_REPORT_TEMPLATES.ja },
  progressRules: { ...DEFAULT_PROGRESS_RULES },
  autoBackup: { ...DEFAULT_AUTO_BACKUP_SETTINGS },
};

export function defaultReportsState(): ReportsState {
  return {
    schemaVersion: REPORTS_SCHEMA_VERSION,
    settings: {
      teams: [...DEFAULT_REPORT_SETTINGS.teams],
      holidays: [],
      supervisorName: '',
      projectJiraUrl: '',
      templates: { en: DEFAULT_REPORT_TEMPLATES.en, ja: DEFAULT_REPORT_TEMPLATES.ja },
      progressRules: { ...DEFAULT_PROGRESS_RULES },
      autoBackup: { ...DEFAULT_AUTO_BACKUP_SETTINGS },
    },
    attendance: [],
    topics: [],
    reports: [],
    projects: [],
    activeProjectId: null,
    testerAssignments: [],
    reviews: [],
    rcsMembers: seedRcsMembers(),
    identityAuditLog: [],
    externalIdentities: [],
    cycles: [],
  };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

/** Shape guard for one member name-history entry (V6.9-A §4). */
export function isRcsMemberNameHistory(v: unknown): v is RcsMemberNameHistory {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.name === 'string' &&
    (r.fromDate === undefined || r.fromDate === '' || typeof r.fromDate === 'string') &&
    (r.toDate === undefined || r.toDate === '' || typeof r.toDate === 'string')
  );
}

const IDENTITY_AUDIT_METHODS: readonly string[] = [
  'manual', 'bulk', 'memberId', 'externalId', 'currentName', 'historicalName', 'context', 'unresolved',
];
const IDENTITY_AUDIT_SOURCES: readonly string[] = ['identityCenter', 'bulkResolution', 'attributionResolution'];
const IDENTITY_AUDIT_CONFIDENCES: readonly string[] = ['high', 'medium', 'low', 'ambiguous'];

/** Shape guard for one identity-resolution audit entry (V6.9-B §29). */
export function isIdentityAuditEntry(v: unknown): v is IdentityAuditEntry {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.timestamp === 'string' &&
    (r.recordType === 'attendance' || r.recordType === 'bugTicket' || r.recordType === 'execution' || r.recordType === 'review') &&
    typeof r.recordId === 'string' &&
    (r.recordDate === undefined || r.recordDate === '' || typeof r.recordDate === 'string') &&
    typeof r.recordedName === 'string' &&
    (r.previousState === 'unmatched' || r.previousState === 'ambiguous') &&
    (r.resolvedMemberId === undefined || typeof r.resolvedMemberId === 'string') &&
    typeof r.method === 'string' &&
    IDENTITY_AUDIT_METHODS.includes(r.method) &&
    typeof r.source === 'string' &&
    IDENTITY_AUDIT_SOURCES.includes(r.source) &&
    (r.confidence === undefined || (typeof r.confidence === 'string' && IDENTITY_AUDIT_CONFIDENCES.includes(r.confidence)))
  );
}

/** Shape guard for one external-identity mapping (V6.9-B §7). */
export function isExternalIdentity(v: unknown): v is ExternalIdentity {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.provider === 'string' &&
    r.provider !== '' &&
    typeof r.externalId === 'string' &&
    r.externalId !== '' &&
    typeof r.memberId === 'string' &&
    r.memberId !== '' &&
    (r.displayName === undefined || r.displayName === '' || typeof r.displayName === 'string') &&
    typeof r.active === 'boolean' &&
    typeof r.linkedAt === 'string'
  );
}

function isAttendanceRecord(v: unknown): v is AttendanceRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.date === 'string' &&
    typeof r.memberName === 'string' &&
    // V6.9-A stable member identity is optional so pre-V6.9 data stays valid.
    (r.memberId === undefined || typeof r.memberId === 'string') &&
    typeof r.team === 'string' &&
    typeof r.status === 'string' &&
    (ATTENDANCE_STATUSES as readonly string[]).includes(r.status) &&
    isStringOrNull(r.workingStart) &&
    isStringOrNull(r.workingEnd) &&
    isStringOrNull(r.leaveType) &&
    typeof r.comment === 'string' &&
    (r.identityResolution === undefined || isIdentityResolutionAudit(r.identityResolution))
  );
}

function isDailyTopic(v: unknown): v is DailyTopic {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.reportDate === 'string' &&
    typeof r.title === 'string' &&
    typeof r.description === 'string' &&
    isFiniteNumber(r.displayOrder) &&
    typeof r.createdBy === 'string' &&
    typeof r.createdAt === 'string' &&
    typeof r.updatedAt === 'string'
  );
}

function isReportActivity(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    (r.source === 'AUTO' || r.source === 'MANUAL') &&
    typeof r.name === 'string' &&
    isFiniteNumber(r.memberCount) &&
    isFiniteNumber(r.completedCases) &&
    typeof r.workingStatus === 'string' &&
    typeof r.included === 'boolean' &&
    isFiniteNumber(r.totalCases) &&
    isFiniteNumber(r.workingEligibleCases) &&
    isFiniteNumber(r.startedCases) &&
    isFiniteNumber(r.blockedCases) &&
    isFiniteNumber(r.notApplicableCases) &&
    (r.spoAssigned === undefined || isFiniteNumber(r.spoAssigned)) &&
    (r.casesPassed === undefined || isFiniteNumber(r.casesPassed)) &&
    (r.casesFailed === undefined || isFiniteNumber(r.casesFailed)) &&
    (r.casesRetest === undefined || isFiniteNumber(r.casesRetest)) &&
    (r.casesQuestioned === undefined || isFiniteNumber(r.casesQuestioned)) &&
    (r.dueDate === null || typeof r.dueDate === 'string')
  );
}

function isNextDayItem(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.text === 'string' &&
    (r.source === 'SUGGESTED' || r.source === 'MANUAL' || r.source === 'AUTO')
  );
}

function isDailyReport(v: unknown): v is DailyReport {  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  if (
    typeof r.id !== 'string' ||
    typeof r.reportDate !== 'string' ||
    (r.language !== 'en' && r.language !== 'ja') ||
    (r.status !== 'DRAFT' && r.status !== 'FINALIZED') ||
    (r.projectId !== undefined && r.projectId !== null && typeof r.projectId !== 'string') ||
    (r.revisionOf !== null && typeof r.revisionOf !== 'string') ||
    (r.jiraUrl !== null && typeof r.jiraUrl !== 'string') ||
    !Array.isArray(r.activities) ||
    !r.activities.every(isReportActivity) ||
    !Array.isArray(r.nextDay) ||
    !r.nextDay.every(isNextDayItem) ||
    // Morning-report fields are optional so pre-morning-report data stays valid.
    (r.morningSchedule !== undefined && !(Array.isArray(r.morningSchedule) && r.morningSchedule.every(isNextDayItem))) ||
    (r.morningPreviewText !== undefined && typeof r.morningPreviewText !== 'string') ||
    typeof r.previewText !== 'string' ||
    typeof r.createdBy !== 'string' ||
    typeof r.createdAt !== 'string' ||
    typeof r.updatedAt !== 'string' ||
    (r.finalizedAt !== null && typeof r.finalizedAt !== 'string') ||
    (r.finalizedBy !== null && typeof r.finalizedBy !== 'string')
  ) {
    return false;
  }
  if (r.snapshot === null) return true;
  const s = r.snapshot as Record<string, unknown>;
  return (
    (s.language === 'en' || s.language === 'ja') &&
    (s.projectId === undefined || s.projectId === null || typeof s.projectId === 'string') &&
    (s.jiraUrl === null || typeof s.jiraUrl === 'string') &&
    Array.isArray(s.activities) &&
    s.activities.every(isReportActivity) &&
    Array.isArray(s.attendance) &&
    s.attendance.every(isAttendanceRecord) &&
    Array.isArray(s.topics) &&
    s.topics.every(isDailyTopic) &&
    Array.isArray(s.nextDay) &&
    s.nextDay.every(isNextDayItem) &&
    (s.morningSchedule === undefined || (Array.isArray(s.morningSchedule) && s.morningSchedule.every(isNextDayItem))) &&
    (s.morningPreviewText === undefined || typeof s.morningPreviewText === 'string')
  );
}

function isReportSettings(v: unknown): v is ReportSettings {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  const templates = s.templates as Record<string, unknown> | undefined;
  const rules = s.progressRules as Record<string, unknown> | undefined;
  return (
    Array.isArray(s.teams) &&
    s.teams.every((team: unknown) => typeof team === 'string') &&
    Array.isArray(s.holidays) &&
    s.holidays.every((h: unknown) => typeof h === 'string') &&
    typeof s.supervisorName === 'string' &&
    typeof s.projectJiraUrl === 'string' &&
    typeof templates === 'object' &&
    templates !== null &&
    typeof templates.en === 'string' &&
    typeof templates.ja === 'string' &&
    typeof rules === 'object' &&
    rules !== null &&
    (rules.working === 'totalCases' || rules.working === 'workingEligibleCases') &&
    (rules.complete === 'totalCases' || rules.complete === 'workingEligibleCases')
  );
}

/**
 * Sanitize the optional automatic-backup settings: a missing or malformed
 * value becomes the disabled default (self-healing, never rejects the whole
 * settings object — a backup misconfiguration must not lock the user out).
 */
function normalizeAutoBackupSettings(v: unknown): AutoBackupSettings {
  if (typeof v !== 'object' || v === null) return { ...DEFAULT_AUTO_BACKUP_SETTINGS };
  const s = v as Record<string, unknown>;
  const retention =
    typeof s.retentionDays === 'number' && Number.isFinite(s.retentionDays) && Number.isInteger(s.retentionDays)
      ? Math.min(365, Math.max(1, s.retentionDays))
      : DEFAULT_AUTO_BACKUP_SETTINGS.retentionDays;
  return {
    enabled: s.enabled === true,
    folderName: s.folderName === null || typeof s.folderName === 'undefined' ? null : typeof s.folderName === 'string' ? s.folderName : null,
    retentionDays: retention,
  };
}

function isQaInputsShape(v: unknown): v is QaInputs {
  if (typeof v !== 'object' || v === null) return false;
  const q = v as Record<string, unknown>;
  return (
    isFiniteNumber(q.totalCases) &&
    isFiniteNumber(q.currentTesters) &&
    isFiniteNumber(q.startTime) &&
    isFiniteNumber(q.targetFinish) &&
    isFiniteNumber(q.lunchStart) &&
    isFiniteNumber(q.lunchEnd) &&
    isFiniteNumber(q.perHourPerTester) &&
    isFiniteNumber(q.casesCompleted) &&
    typeof q.startDate === 'string' &&
    (q.targetCompletionDate === null || typeof q.targetCompletionDate === 'string') &&
    (q.targetCompletionTime === null || typeof q.targetCompletionTime === 'string') &&
    Array.isArray(q.planningRows) &&
    q.planningRows.length > 0 &&
    q.planningRows.every((row: unknown) => isPlanningRow(row)) &&
    // Level 2 fields are optional so pre-V5 projects and backups stay valid.
    (q.casesPassed === undefined || isFiniteNumber(q.casesPassed)) &&
    (q.spoAssigned === undefined || isFiniteNumber(q.spoAssigned)) &&
    (q.casesFailed === undefined || isFiniteNumber(q.casesFailed)) &&
    (q.casesNotApplicable === undefined || isFiniteNumber(q.casesNotApplicable)) &&
    (q.casesBlocked === undefined || isFiniteNumber(q.casesBlocked)) &&
    (q.casesRetest === undefined || isFiniteNumber(q.casesRetest)) &&
    (q.casesQuestioned === undefined || isFiniteNumber(q.casesQuestioned)) &&
    (q.targetPassRate === undefined || isFiniteNumber(q.targetPassRate)) &&
    (q.dailyTargetOverrides === undefined ||
      (Array.isArray(q.dailyTargetOverrides) && q.dailyTargetOverrides.every(isDailyTargetOverride))) &&
    (q.dailyActuals === undefined || (Array.isArray(q.dailyActuals) && q.dailyActuals.every(isDailyActualSnapshot))) &&
    (q.blockingEvents === undefined || (Array.isArray(q.blockingEvents) && q.blockingEvents.every(isBlockingEvent))) &&
    (q.milestones === undefined || (Array.isArray(q.milestones) && q.milestones.every(isMilestone))) &&
    // V6.6 fields are optional so pre-V6.6 projects and backups stay valid.
    (q.bugTickets === undefined || (Array.isArray(q.bugTickets) && q.bugTickets.every(isBugTicket))) &&
    (q.testerDailyPerformance === undefined ||
      (Array.isArray(q.testerDailyPerformance) && q.testerDailyPerformance.every(isTesterDailyPerformance)))
  );
}

function isProjectStatusChange(v: unknown): v is ProjectStatusChange {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return PROJECT_LIFECYCLE_STATUSES.includes(String(r.status)) && typeof r.changedAt === 'string';
}

const REVIEW_PERIOD_TYPE_SET = new Set<string>(REVIEW_PERIOD_TYPES);
const REVIEW_STATUS_SET = new Set<string>(REVIEW_STATUSES);

/** Shape guard for persisted/imported tester assignments (V6.7/V6.8). */
export function isTesterProjectAssignment(v: unknown): v is TesterProjectAssignment {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.projectId === 'string' &&
    // V6.8: identity is memberId; testerName is legacy-compatible data.
    // Either may be absent, but at least one must be a string.
    (r.memberId === undefined || typeof r.memberId === 'string') &&
    (r.testerName === undefined || typeof r.testerName === 'string') &&
    (r.userId === undefined || typeof r.userId === 'string') &&
    (r.memberId !== undefined || r.testerName !== undefined) &&
    (r.team === undefined || typeof r.team === 'string') &&
    typeof r.startDate === 'string' &&
    (r.endDate === undefined || typeof r.endDate === 'string') &&
    typeof r.active === 'boolean'
  );
}

/** Shape guard for persisted/imported tester reviews (V6.7/V6.8). */
export function isTesterReview(v: unknown): v is TesterReview {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    (r.memberId === undefined || typeof r.memberId === 'string') &&
    typeof r.testerName === 'string' &&
    typeof r.periodType === 'string' &&
    REVIEW_PERIOD_TYPE_SET.has(r.periodType) &&
    typeof r.periodStart === 'string' &&
    typeof r.periodEnd === 'string' &&
    typeof r.status === 'string' &&
    REVIEW_STATUS_SET.has(r.status) &&
    (r.summaryNote === undefined || typeof r.summaryNote === 'string') &&
    (r.strengthsNote === undefined || typeof r.strengthsNote === 'string') &&
    (r.improvementNote === undefined || typeof r.improvementNote === 'string') &&
    (r.supervisorNote === undefined || typeof r.supervisorNote === 'string') &&
    typeof r.createdAt === 'string' &&
    typeof r.updatedAt === 'string'
  );
}

/** Shape guard for persisted/imported RCS members (V6.8, V6.9-A). */
export function isRcsMember(v: unknown): v is RcsMember {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.name === 'string' &&
    typeof r.team === 'string' &&
    typeof r.role === 'string' &&
    typeof r.startDate === 'string' &&
    (r.endDate === undefined || typeof r.endDate === 'string') &&
    typeof r.active === 'boolean' &&
    // V6.9-A name history is optional so pre-V6.9 data stays valid.
    (r.nameHistory === undefined || (Array.isArray(r.nameHistory) && r.nameHistory.every(isRcsMemberNameHistory)))
  );
}

function isProjectRecord(v: unknown): v is ProjectRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    // projectId is optional here so pre-V4.1 persisted data still validates;
    // normalizeReportsState backfills stable IDs on load.
    (r.projectId === undefined || typeof r.projectId === 'string') &&
    typeof r.nameEn === 'string' &&
    typeof r.nameJa === 'string' &&
    typeof r.team === 'string' &&
    PROJECT_LIFECYCLE_STATUSES.includes(String(r.status)) &&
    Array.isArray(r.statusHistory) &&
    r.statusHistory.every((h: unknown) => isProjectStatusChange(h)) &&
    (r.completedAt === null || typeof r.completedAt === 'string') &&
    (r.completedBy === null || typeof r.completedBy === 'string') &&
    typeof r.createdAt === 'string' &&
    typeof r.updatedAt === 'string' &&
    (r.cycleId === undefined || r.cycleId === null || typeof r.cycleId === 'string') &&
    isQaInputsShape(r.inputs)
  );
}

/** Shape guard for persisted/imported daily reports (V6.3 project backup). */
export function isDailyReportGuard(v: unknown): v is DailyReport {
  return isDailyReport(v);
}

/** Shape guard for persisted/imported project records (V6.3 project backup). */
export function isProjectRecordGuard(v: unknown): v is ProjectRecord {
  return isProjectRecord(v);
}

export function isReportsState(v: unknown): v is ReportsState {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    s.schemaVersion === REPORTS_SCHEMA_VERSION &&
    isReportSettings(s.settings) &&
    Array.isArray(s.attendance) &&
    s.attendance.every(isAttendanceRecord) &&
    Array.isArray(s.topics) &&
    s.topics.every(isDailyTopic) &&
    Array.isArray(s.reports) &&
    s.reports.every(isDailyReport) &&
    // V4 portfolio fields are optional so pre-V4 data and backups stay valid.
    (s.projects === undefined || (Array.isArray(s.projects) && s.projects.every(isProjectRecord))) &&
    (s.activeProjectId === undefined || s.activeProjectId === null || typeof s.activeProjectId === 'string') &&
    // V6.7 workspace-level fields are optional so pre-V6.7 data stays valid.
    (s.testerAssignments === undefined ||
      (Array.isArray(s.testerAssignments) && s.testerAssignments.every(isTesterProjectAssignment))) &&
    (s.reviews === undefined || (Array.isArray(s.reviews) && s.reviews.every(isTesterReview))) &&
    // V6.8 member master is optional so pre-V6.8 data stays valid.
    (s.rcsMembers === undefined || (Array.isArray(s.rcsMembers) && s.rcsMembers.every(isRcsMember))) &&
    // V6.9-B identity audit log is optional so pre-V6.9-B data stays valid.
    (s.identityAuditLog === undefined || (Array.isArray(s.identityAuditLog) && s.identityAuditLog.every(isIdentityAuditEntry))) &&
    // V6.9-B external-identity mappings are optional so pre-V6.9-B data stays valid.
    (s.externalIdentities === undefined || (Array.isArray(s.externalIdentities) && s.externalIdentities.every(isExternalIdentity))) &&
    // Stage 8A test cycles are optional so every earlier payload and backup stays valid.
    (s.cycles === undefined || (Array.isArray(s.cycles) && s.cycles.every((c) => checkCycle(c).ok)))
  );
}

/**
 * Fill in V4/V4.1/V5/V6.7/V6.8/V6.9-A defaults so older persisted data keeps
 * working (documented migration).
 *
 * V6.8 steps (§11/§12 — conservative, non-destructive):
 * 1. Seed the RCS member master exactly once (only when the field is
 *    absent — an intentionally emptied roster is preserved as empty).
 * 2. Migrate legacy testerName assignments to memberId identity when the
 *    name matches exactly one member. Unmatched and ambiguous records are
 *    preserved verbatim; nothing is deleted or guessed.
 *
 * V6.9-A steps (§12/§19 — same conservative rules):
 * 3. Migrate legacy attendance records (memberName → memberId) and bug
 *    tickets (reportedBy → reporterMemberId) when the name resolves to
 *    exactly one member (current name or name history). Unmatched and
 *    ambiguous records are preserved verbatim; manual resolutions are
 *    never overwritten. Idempotent: already-migrated records are skipped.
 */
export function normalizeReportsState(state: ReportsState): ReportsState {
  const rcsMembers = state.rcsMembers ?? seedRcsMembers();
  const migration = migrateAssignmentsToMembers((state.testerAssignments ?? []).filter(isTesterProjectAssignment), rcsMembers);
  const attendanceMigration = migrateAttendanceIdentity(state.attendance, rcsMembers);
  const projectsMigration = migrateProjectBugTickets(
    ensureProjectIds(state.projects ?? []).map((project) => ({
      ...project,
      inputs: normalizeQaInputs(project.inputs),
    })),
    rcsMembers,
  );
  return {
    ...state,
    settings: {
      ...state.settings,
      autoBackup: normalizeAutoBackupSettings(state.settings.autoBackup),
    },
    projects: projectsMigration.projects,
    activeProjectId: state.activeProjectId ?? null,
    attendance: attendanceMigration.attendance,
    testerAssignments: migration.assignments,
    reviews: (state.reviews ?? []).filter(isTesterReview),
    rcsMembers: rcsMembers.filter(isRcsMember),
    // V6.9-B: the audit log is append-only — normalization only filters
    // invalid entries, never rewrites or prunes valid history.
    identityAuditLog: (state.identityAuditLog ?? []).filter(isIdentityAuditEntry),
    // V6.9-B: external identities are lookup aids — malformed entries are
    // filtered (never repaired) and valid mappings pass through unchanged.
    externalIdentities: (state.externalIdentities ?? []).filter(isExternalIdentity),
    // Stage 8A: malformed cycles are filtered (never repaired); valid ones pass through unchanged.
    cycles: (state.cycles ?? []).filter((c) => checkCycle(c).ok),
  };
}

export function loadReportsState(): ReportsState {
  try {
    const raw = window.localStorage.getItem(REPORTS_STORAGE_KEY);
    if (raw !== null) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (isReportsState(parsed)) return normalizeReportsState(parsed);
      } catch {
        // fall through to defaults
      }
      // Preserve the unreadable payload before resetting (V6.3 §22).
      if (!hasRecoveryPayload(REPORTS_STORAGE_KEY)) stashCorruptedRaw(REPORTS_STORAGE_KEY, raw);
    }
  } catch {
    // fall through to defaults
  }
  return defaultReportsState();
}

/**
 * Persist the reports state. Returns false when the write failed; the
 * in-memory state is kept either way (V6.3 §3).
 */
export function saveReportsState(state: ReportsState): boolean {
  try {
    window.localStorage.setItem(REPORTS_STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    // localStorage may be unavailable; the app keeps running in-memory
    return false;
  }
}

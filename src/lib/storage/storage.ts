import type {
  AppState,
  BlockingEvent,
  BugTicket,
  DailyActualSnapshot,
  DailyExecutionEntry,
  DailyTargetOverride,
  IdentityResolutionAudit,
  Milestone,
  MultiDayPlanningInputs,
  PlanningRow,
  QaInputs,
  TesterDailyPerformance,
} from '../../types';
import { BLOCKING_CATEGORIES, BUG_SEVERITIES, BUG_STATUSES, PERFORMANCE_RECORD_SOURCES } from '../../types';
import { formatDate, todayEpochDays } from '../dates/dates';
import { generateId } from '../id';
import { minutesToTimeInput } from '../formatting/format';
import { migrateDailyExecuted, syncActualsFromDailyExecuted } from '../calculations/dailyExecuted';
import { hasRecoveryPayload, stashCorruptedRaw } from './corruption';

/** Versioned localStorage keys (§21, V2 §8). */
export const STORAGE_KEY = 'ganttchart.v2';
export const LEGACY_STORAGE_KEY = 'ganttchart.v1';

/** Storage schema version. Bump on breaking changes. */
export const STORAGE_SCHEMA_VERSION = 2;

/** Pre-V2 (v1) shape, used as the source for forward migration. */
export type LegacyAppState = Omit<AppState, keyof MultiDayPlanningInputs | 'projectNameEn' | 'projectNameJa'>;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isPlanningRow(v: unknown): v is PlanningRow {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.date === 'string' &&
    isFiniteNumber(r.plannedTesters) &&
    isFiniteNumber(r.absentTesters) &&
    typeof r.nonWorkingDay === 'boolean' &&
    typeof r.note === 'string'
  );
}

export { isPlanningRow };

// ---- Level 2 (V5) shape checks — every field optional for backward compatibility ----

const BLOCKING_CATEGORY_SET = new Set<string>(BLOCKING_CATEGORIES);

export function isBlockingEvent(v: unknown): v is BlockingEvent {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.date === 'string' &&
    typeof r.category === 'string' &&
    BLOCKING_CATEGORY_SET.has(r.category) &&
    isFiniteNumber(r.minutes) &&
    typeof r.note === 'string'
  );
}

export function isDailyTargetOverride(v: unknown): v is DailyTargetOverride {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.date === 'string' &&
    isFiniteNumber(r.plannedExecute) &&
    isFiniteNumber(r.plannedPass)
  );
}

export function isDailyActualSnapshot(v: unknown): v is DailyActualSnapshot {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.date === 'string' &&
    isFiniteNumber(r.executed) &&
    isFiniteNumber(r.passed) &&
    // V6.5 granular snapshot fields are optional so pre-V6.5 snapshots stay valid.
    (r.casesPassed === undefined || isFiniteNumber(r.casesPassed)) &&
    (r.casesFailed === undefined || isFiniteNumber(r.casesFailed)) &&
    (r.casesNotApplicable === undefined || isFiniteNumber(r.casesNotApplicable)) &&
    (r.spoAssigned === undefined || isFiniteNumber(r.spoAssigned)) &&
    (r.casesBlocked === undefined || isFiniteNumber(r.casesBlocked)) &&
    (r.casesRetest === undefined || isFiniteNumber(r.casesRetest)) &&
    (r.casesQuestioned === undefined || isFiniteNumber(r.casesQuestioned))
  );
}

export function isMilestone(v: unknown): v is Milestone {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.name === 'string' &&
    (r.type === 'EXECUTE' || r.type === 'PASS') &&
    isFiniteNumber(r.targetPct) &&
    (r.plannedDate === null || typeof r.plannedDate === 'string') &&
    (r.plannedTime === null || typeof r.plannedTime === 'string') &&
    (r.actualAt === null || typeof r.actualAt === 'string')
  );
}

const BUG_SEVERITY_SET = new Set<string>(BUG_SEVERITIES);
const BUG_STATUS_SET = new Set<string>(BUG_STATUSES);
const PERFORMANCE_SOURCE_SET = new Set<string>(PERFORMANCE_RECORD_SOURCES);

/** Shape guard for a manual identity-resolution audit (V6.9-A §25). */
export function isIdentityResolutionAudit(v: unknown): v is IdentityResolutionAudit {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    r.method === 'manual' &&
    (r.memberId === undefined || typeof r.memberId === 'string') &&
    typeof r.resolvedAt === 'string'
  );
}

/** Shape guard for persisted/imported bug tickets (V6.6, V6.9-A). */
export function isBugTicket(v: unknown): v is BugTicket {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.projectId === 'string' &&
    (r.ticketKey === undefined || typeof r.ticketKey === 'string') &&
    typeof r.title === 'string' &&
    typeof r.url === 'string' &&
    typeof r.createdAt === 'string' &&
    typeof r.reportedBy === 'string' &&
    // V6.9-A stable reporter identity is optional so pre-V6.9 data stays valid.
    (r.reporterMemberId === undefined || typeof r.reporterMemberId === 'string') &&
    (r.severity === undefined || (typeof r.severity === 'string' && BUG_SEVERITY_SET.has(r.severity))) &&
    (r.status === undefined || (typeof r.status === 'string' && BUG_STATUS_SET.has(r.status))) &&
    (r.memo === undefined || typeof r.memo === 'string') &&
    (r.identityResolution === undefined || isIdentityResolutionAudit(r.identityResolution))
  );
}

function isNonNegativeNumber(v: unknown): v is number {
  return isFiniteNumber(v) && v >= 0;
}

/** Shape guard for persisted/imported tester daily records (V6.6). */
export function isTesterDailyPerformance(v: unknown): v is TesterDailyPerformance {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.date === 'string' &&
    typeof r.testerName === 'string' &&
    (r.team === undefined || typeof r.team === 'string') &&
    typeof r.projectId === 'string' &&
    isNonNegativeNumber(r.casesTested) &&
    (r.casesPassed === undefined || isNonNegativeNumber(r.casesPassed)) &&
    (r.casesFailed === undefined || isNonNegativeNumber(r.casesFailed)) &&
    (r.casesNotApplicable === undefined || isNonNegativeNumber(r.casesNotApplicable)) &&
    (r.casesBlocked === undefined || isNonNegativeNumber(r.casesBlocked)) &&
    (r.casesRetest === undefined || isNonNegativeNumber(r.casesRetest)) &&
    (r.casesQuestioned === undefined || isNonNegativeNumber(r.casesQuestioned)) &&
    (r.casesSpoAssigned === undefined || isNonNegativeNumber(r.casesSpoAssigned)) &&
    // V6.7 source is optional so pre-V6.7 records stay valid (never rewritten).
    (r.source === undefined || (typeof r.source === 'string' && PERFORMANCE_SOURCE_SET.has(r.source))) &&
    // V6.8 stable member identity is optional so pre-V6.8 records stay valid.
    (r.memberId === undefined || typeof r.memberId === 'string')
  );
}

/** Shape guard for persisted/imported daily execution entries (V7). */
export function isDailyExecutionEntry(v: unknown): v is DailyExecutionEntry {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.date === 'string' &&
    (r.startTime === null || r.startTime === undefined || isFiniteNumber(r.startTime)) &&
    (r.endTime === null || r.endTime === undefined || isFiniteNumber(r.endTime)) &&
    isFiniteNumber(r.overtimeMinutes) &&
    typeof r.intervalEnabled === 'boolean' &&
    isFiniteNumber(r.testers) &&
    isFiniteNumber(r.pass) &&
    isFiniteNumber(r.fail) &&
    isFiniteNumber(r.notApplicable) &&
    isFiniteNumber(r.spo) &&
    isFiniteNumber(r.blocked) &&
    isFiniteNumber(r.retest) &&
    isFiniteNumber(r.questioned) &&
    (r.uncategorizedCompleted === undefined || isFiniteNumber(r.uncategorizedCompleted)) &&
    typeof r.note === 'string'
  );
}

/** Default milestone set seeded for new/normalized projects (Level 2 §7). */
export function defaultMilestones(): Milestone[] {
  const make = (type: 'EXECUTE' | 'PASS', targetPct: number): Milestone => ({
    id: generateId(),
    name: '',
    type,
    targetPct,
    plannedDate: null,
    plannedTime: null,
    actualAt: null,
  });
  return [
    make('EXECUTE', 50),
    make('EXECUTE', 80),
    make('EXECUTE', 100),
    make('PASS', 50),
    make('PASS', 80),
    make('PASS', 100),
  ];
}

/**
 * Backfill Level 2 defaults so any pre-Level-2 payload (stored state,
 * imported file, project record) keeps working unchanged. Invalid values
 * are left in place for the validation layer to flag — this only fills
 * missing fields. Exception (V6.6): malformed bug-ticket / tester-daily
 * records are dropped rather than half-loaded, so the UI never renders a
 * record it cannot edit safely. This is a PURE BACKFILL — it never
 * migrates actuals or recomputes anything (use normalizeQaInputsForLoad
 * at state boundaries for that).
 */
export function normalizeQaInputs<T extends QaInputs>(inputs: T): T {
  return {
    ...inputs,
    intervalEnabled: inputs.intervalEnabled ?? true,
    dailyOvertimeMinutes: inputs.dailyOvertimeMinutes ?? 0,
    casesPassed: inputs.casesPassed ?? 0,
    spoAssigned: inputs.spoAssigned ?? 0,
    casesFailed: inputs.casesFailed ?? 0,
    casesNotApplicable: inputs.casesNotApplicable ?? 0,
    casesBlocked: inputs.casesBlocked ?? 0,
    casesRetest: inputs.casesRetest ?? 0,
    casesQuestioned: inputs.casesQuestioned ?? 0,
    targetPassRate: inputs.targetPassRate ?? 1,
    dailyTargetOverrides: inputs.dailyTargetOverrides ?? [],
    dailyActuals: inputs.dailyActuals ?? [],
    blockingEvents: inputs.blockingEvents ?? [],
    milestones: inputs.milestones ?? defaultMilestones(),
    bugTickets: (inputs.bugTickets ?? []).filter(isBugTicket),
    testerDailyPerformance: (inputs.testerDailyPerformance ?? []).filter(isTesterDailyPerformance),
    dailyExecuted: inputs.dailyExecuted === undefined ? undefined : inputs.dailyExecuted.filter(isDailyExecutionEntry),
  };
}

/**
 * The full V7 load-time pipeline for project inputs: backfill defaults →
 * migrate legacy actuals (cumulative fields ± snapshots → per-day entries,
 * invariant-preserving, legacy snapshots kept verbatim) → for payloads that
 * ALREADY carry dailyExecuted, sync the canonical cumulative fields as
 * Σ entries and regenerate the end-of-day snapshots. Used at every real
 * state boundary (load, import, backup restore, project activation).
 * Idempotent; invalid values stay visible to the validation layer when no
 * migration applies.
 */
export function normalizeQaInputsForLoad<T extends QaInputs>(inputs: T): T {
  const normalized = normalizeQaInputs(inputs);
  if (normalized.dailyExecuted === undefined) {
    return migrateDailyExecuted(normalized, formatDate(todayEpochDays()));
  }
  return syncActualsFromDailyExecuted(normalized);
}

function validLevel2QaInputs(s: Record<string, unknown>): boolean {
  return (
    (s.dailyOvertimeMinutes === undefined || isFiniteNumber(s.dailyOvertimeMinutes)) &&
    (s.casesPassed === undefined || isFiniteNumber(s.casesPassed)) &&
    (s.spoAssigned === undefined || isFiniteNumber(s.spoAssigned)) &&
    (s.casesFailed === undefined || isFiniteNumber(s.casesFailed)) &&
    (s.casesNotApplicable === undefined || isFiniteNumber(s.casesNotApplicable)) &&
    (s.casesBlocked === undefined || isFiniteNumber(s.casesBlocked)) &&
    (s.casesRetest === undefined || isFiniteNumber(s.casesRetest)) &&
    (s.casesQuestioned === undefined || isFiniteNumber(s.casesQuestioned)) &&
    (s.targetPassRate === undefined || isFiniteNumber(s.targetPassRate)) &&
    (s.dailyTargetOverrides === undefined ||
      (Array.isArray(s.dailyTargetOverrides) && s.dailyTargetOverrides.every(isDailyTargetOverride))) &&
    (s.dailyActuals === undefined || (Array.isArray(s.dailyActuals) && s.dailyActuals.every(isDailyActualSnapshot))) &&
    (s.dailyExecuted === undefined || (Array.isArray(s.dailyExecuted) && s.dailyExecuted.every(isDailyExecutionEntry))) &&
    (s.blockingEvents === undefined || (Array.isArray(s.blockingEvents) && s.blockingEvents.every(isBlockingEvent))) &&
    (s.milestones === undefined || (Array.isArray(s.milestones) && s.milestones.every(isMilestone))) &&
    (s.bugTickets === undefined || (Array.isArray(s.bugTickets) && s.bugTickets.every(isBugTicket))) &&
    (s.testerDailyPerformance === undefined ||
      (Array.isArray(s.testerDailyPerformance) && s.testerDailyPerformance.every(isTesterDailyPerformance)))
  );
}

function validDashboardView(v: unknown): boolean {
  return v === undefined || v === 'operator' || v === 'manager';
}

/** Local shape check for persisted/imported V2 state. */
export function isAppState(v: unknown): v is AppState {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    isFiniteNumber(s.totalCases) &&
    isFiniteNumber(s.currentTesters) &&
    isFiniteNumber(s.startTime) &&
    isFiniteNumber(s.targetFinish) &&
    isFiniteNumber(s.lunchStart) &&
    isFiniteNumber(s.lunchEnd) &&
    isFiniteNumber(s.perHourPerTester) &&
    isFiniteNumber(s.casesCompleted) &&
    (s.language === 'ja' || s.language === 'en') &&
    typeof s.startDate === 'string' &&
    (s.targetCompletionDate === null || typeof s.targetCompletionDate === 'string') &&
    (s.targetCompletionTime === null || typeof s.targetCompletionTime === 'string') &&
    // Optional bilingual project names (absent in pre-i18n-v3 states).
    (s.projectNameEn === undefined || typeof s.projectNameEn === 'string') &&
    (s.projectNameJa === undefined || typeof s.projectNameJa === 'string') &&
    Array.isArray(s.planningRows) &&
    s.planningRows.length > 0 &&
    s.planningRows.every((row: unknown) => isPlanningRow(row)) &&
    validLevel2QaInputs(s) &&
    validDashboardView(s.dashboardView)
  );
}

/** Fill in defaults for optional fields so older payloads stay renderable. */
export function normalizeAppState(state: AppState): AppState {
  return {
    ...normalizeQaInputsForLoad(state),
    projectNameEn: typeof state.projectNameEn === 'string' ? state.projectNameEn : '',
    projectNameJa: typeof state.projectNameJa === 'string' ? state.projectNameJa : '',
    dashboardView: state.dashboardView ?? 'operator',
  };
}

/** v1 shape check for migration sources. */
export function isLegacyAppState(v: unknown): v is LegacyAppState {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    isFiniteNumber(s.totalCases) &&
    isFiniteNumber(s.currentTesters) &&
    isFiniteNumber(s.startTime) &&
    isFiniteNumber(s.targetFinish) &&
    isFiniteNumber(s.lunchStart) &&
    isFiniteNumber(s.lunchEnd) &&
    isFiniteNumber(s.perHourPerTester) &&
    isFiniteNumber(s.casesCompleted) &&
    (s.language === 'ja' || s.language === 'en')
  );
}

function createDemoPlanning(): MultiDayPlanningInputs {
  const start = todayEpochDays();
  return {
    startDate: formatDate(start),
    targetCompletionDate: formatDate(start + 4),
    targetCompletionTime: null,
    planningRows: [
      { id: generateId(), date: formatDate(start), plannedTesters: 2, absentTesters: 0, nonWorkingDay: false, note: '' },
      { id: generateId(), date: formatDate(start + 1), plannedTesters: 2, absentTesters: 1, nonWorkingDay: false, note: '' },
      { id: generateId(), date: formatDate(start + 2), plannedTesters: 3, absentTesters: 0, nonWorkingDay: false, note: '' },
      { id: generateId(), date: formatDate(start + 3), plannedTesters: 3, absentTesters: 0, nonWorkingDay: false, note: '' },
      { id: generateId(), date: formatDate(start + 4), plannedTesters: 3, absentTesters: 0, nonWorkingDay: true, note: '' },
    ],
  };
}

/**
 * Default demo data on first load (§26): 36 cases, 8 testers, the fixed
 * workday model (9:00–17:30, lunch 12:00–13:00), 4 cases/h/tester,
 * 15 completed (11 passed). Japanese is the default language (§20).
 * Level 2 fields seed the standard milestone set. Kept in its raw legacy
 * shape (no dailyExecuted) — loadState/resetToDemo run it through
 * normalizeAppState so the app always sees the migrated V7 form.
 */
export const DEMO_STATE: AppState = {
  totalCases: 36,
  currentTesters: 8,
  startTime: 9 * 60, // 9:00 (fixed workday)
  targetFinish: 17 * 60 + 30, // 17:30
  lunchStart: 12 * 60, // 12:00
  lunchEnd: 13 * 60, // 13:00
  perHourPerTester: 4,
  casesCompleted: 15,
  casesPassed: 11,
  spoAssigned: 0,
  casesFailed: 0,
  casesNotApplicable: 0,
  casesBlocked: 0,
  casesRetest: 0,
  casesQuestioned: 0,
  targetPassRate: 1,
  dailyTargetOverrides: [],
  dailyActuals: [],
  blockingEvents: [],
  milestones: defaultMilestones(),
  bugTickets: [],
  testerDailyPerformance: [],
  dashboardView: 'operator',
  language: 'ja',
  projectNameEn: 'Login Regression Suite',
  projectNameJa: 'ログイン回帰テスト',
  ...createDemoPlanning(),
};

/**
 * Forward-migrate a v1 state to v2: keep every v1 field and seed a minimal
 * single-day plan derived from the existing inputs (start today, staffing =
 * current testers, target = today at the v1 target finish time).
 */
export function migrateLegacyState(legacy: LegacyAppState): AppState {
  const today = formatDate(todayEpochDays());
  return normalizeAppState({
    ...legacy,
    projectNameEn: '',
    projectNameJa: '',
    startDate: today,
    targetCompletionDate: today,
    targetCompletionTime: minutesToTimeInput(legacy.targetFinish),
    planningRows: [
      { id: generateId(), date: today, plannedTesters: legacy.currentTesters, absentTesters: 0, nonWorkingDay: false, note: '' },
    ],
  } as AppState);
}

/**
 * Load persisted state (V2 key first). Falls back to migrating the V1 key
 * forward, then to demo defaults. Invalid payloads are preserved under a
 * recovery key before any fallback (V6.3 §22). All data stays on the machine.
 */
export function loadState(): AppState {
  try {
    const rawV2 = window.localStorage.getItem(STORAGE_KEY);
    if (rawV2 !== null) {
      try {
        const parsed: unknown = JSON.parse(rawV2);
        if (isAppState(parsed)) return normalizeAppState(parsed);
      } catch {
        // fall through to legacy migration / demo defaults
      }
      if (!hasRecoveryPayload(STORAGE_KEY)) stashCorruptedRaw(STORAGE_KEY, rawV2);
    }
  } catch {
    // fall through to legacy migration / demo defaults
  }
  try {
    const rawV1 = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (rawV1 !== null) {
      let legacyValid = false;
      try {
        const parsed: unknown = JSON.parse(rawV1);
        if (isLegacyAppState(parsed)) {
          legacyValid = true;
          const migrated = migrateLegacyState(parsed);
          // Only retire the v1 key once the migrated copy is durably written —
          // a failed write (quota/blocked storage) must keep the original
          // data so the migration simply retries on the next load.
          if (saveState(migrated)) {
            try {
              window.localStorage.removeItem(LEGACY_STORAGE_KEY);
            } catch {
              // keep the old key if removal fails; harmless
            }
          }
          return migrated;
        }
      } catch {
        // fall through to demo defaults
      }
      if (!legacyValid && !hasRecoveryPayload(LEGACY_STORAGE_KEY)) {
        stashCorruptedRaw(LEGACY_STORAGE_KEY, rawV1);
      }
    }
  } catch {
    // fall through to demo defaults
  }
  return normalizeAppState({ ...DEMO_STATE });
}

/**
 * Persist raw inputs + language only — no derived metrics (§21).
 * Returns false when the write failed (e.g. blocked storage); the caller
 * keeps the in-memory state either way (V6.3 §3).
 */
export function saveState(state: AppState): boolean {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    // localStorage may be unavailable (blocked storage); the app keeps
    // running in-memory and stays fully functional.
    return false;
  }
}

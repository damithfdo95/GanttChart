import { cleanTotal } from './testManagement/totals';
import { eventBusinessDate, type DailyDetailedSummary } from './testManagement/executionHistory';
import { withExecutionProvenance, executionSourceOf, type ExecutionSource } from './executionSource';
import type { CaseExecutionEvent, CaseResult, DailyExecutionEntry, TestCase, TestScope } from '../types';

/**
 * Controlled reconciliation of the SAVED daily aggregate with the detailed case history (Phase 6).
 *
 * Nothing here is automatic: partial detailed coverage may be COMPARED, but only demonstrably complete coverage may become the saved
 * aggregate, and only through an explicit, confirmed action. The saved Daily Execution stays the one authority every report reads.
 *
 * What a saved day means (audited in `lib/calculations/dailyExecuted.ts`): `entryCompletedCases` = Pass + Fail + N/A + SPO
 * (+ uncategorized). Blocked / Retest / Question are "informational open-status tallies - never part of completion". So the saved
 * "executed" is the number of cases that reached a COMPLETED terminal status, which is exactly a case-history day's
 * passed + failed + na + spo - NOT uniqueCasesExecuted (that also counts Blocked and In Progress cases).
 */

export type DetailedCoverageState = 'none' | 'partial' | 'complete';
export type ReconciliationState = 'notComparable' | 'match' | 'difference';

export type CoverageReason =
  | 'noScopes'
  | 'noRegisteredCases'
  | 'noHistoryYet'
  | 'dateBeforeHistory'
  | 'scopeTotalMissing'
  | 'registeredMismatch'
  | 'caseOutsideScope'
  | 'eventsOutsideRegistered'
  | 'resultsWithoutHistory'
  | 'scopeNotComplete';

export interface ScopeCoverage {
  scopeId: string;
  state: DetailedCoverageState;
  reasons: CoverageReason[];
  total: number | null;
  registered: number;
}

export interface DetailedCoverage {
  state: DetailedCoverageState;
  reasons: CoverageReason[];
  scopes: ScopeCoverage[];
}

export interface CoverageInput {
  date: string;
  projectId: string;
  /** Limit to one scope (its own eligibility); omit for the project level. */
  scopeId?: string | null;
  scopes: readonly Pick<TestScope, 'id' | 'projectId' | 'status' | 'totalTestCases'>[];
  cases: readonly Pick<TestCase, 'id' | 'projectId' | 'scopeId' | 'status'>[];
  events: readonly CaseExecutionEvent[];
  /** Current results - used ONLY as an integrity check (a recorded result that has no history), never to rebuild a past day. */
  results?: readonly Pick<CaseResult, 'testCaseId' | 'status'>[];
}

/**
 * Is the detailed history of this date demonstrably complete? Deliberately strict; anything unproven is `partial`.
 *
 * A scope is COMPLETE only when ALL hold: it has an authoritative total (a typed whole number above zero); its registered (active)
 * cases number exactly that total; every registered case belongs to this project and scope; no execution event of the date sits on
 * a case that is not registered (an archived / removed case means the inventory is not what the total describes); no registered
 * case carries a recorded result that has no history at all (it was executed before history began); and the date is not before the
 * first recorded event. The PROJECT is complete only when EVERY active scope is complete (never averaged).
 * `none`: nothing to compare - no registered cases, or no history at or before the date.
 */
export function assessDetailedCoverage(input: CoverageInput): DetailedCoverage {
  const only = input.scopeId ?? null;
  const scopes = input.scopes.filter((s) => s.projectId === input.projectId && s.status === 'active' && (only === null || s.id === only));
  if (scopes.length === 0) return { state: 'none', reasons: ['noScopes'], scopes: [] };
  const scopeIds = new Set(scopes.map((s) => s.id));
  const mineEvents = input.events.filter((e) => e.projectId === input.projectId && scopeIds.has(e.scopeId));
  const first = mineEvents.length === 0 ? null : mineEvents.map(eventBusinessDate).sort()[0] ?? null;

  const out: ScopeCoverage[] = scopes.map((s) => {
    const inScope = input.cases.filter((c) => c.scopeId === s.id && c.status === 'active');
    const registeredIds = new Set(inScope.filter((c) => c.projectId === s.projectId).map((c) => c.id));
    const total = cleanTotal(s.totalTestCases);
    const reasons: CoverageReason[] = [];
    if (inScope.length === 0) return { scopeId: s.id, state: 'none' as const, reasons: ['noRegisteredCases' as const], total, registered: 0 };
    if (inScope.some((c) => c.projectId !== s.projectId)) reasons.push('caseOutsideScope');
    if (total === null || total === 0) reasons.push('scopeTotalMissing');
    else if (registeredIds.size !== total) reasons.push('registeredMismatch');
    const ofScopeDay = mineEvents.filter((e) => e.scopeId === s.id && eventBusinessDate(e) === input.date);
    if (ofScopeDay.some((e) => !registeredIds.has(e.testCaseId))) reasons.push('eventsOutsideRegistered');
    if (input.results !== undefined) {
      const withHistory = new Set(mineEvents.map((e) => e.testCaseId));
      if (input.results.some((r) => registeredIds.has(r.testCaseId) && r.status !== 'notStarted' && !withHistory.has(r.testCaseId))) reasons.push('resultsWithoutHistory');
    }
    return { scopeId: s.id, state: reasons.length === 0 ? ('complete' as const) : ('partial' as const), reasons, total, registered: registeredIds.size };
  });

  // Events of the date on scopes that are no longer active (archived) are history this total cannot describe.
  const strayDay = only === null && input.events.some((e) => e.projectId === input.projectId && !scopeIds.has(e.scopeId) && eventBusinessDate(e) === input.date);
  if (strayDay) for (const sc of out) if (sc.state === 'complete') { sc.state = 'partial'; sc.reasons.push('eventsOutsideRegistered'); }
  if (first === null) return { state: 'none', reasons: ['noHistoryYet'], scopes: out };
  if (input.date < first) return { state: 'none', reasons: ['dateBeforeHistory'], scopes: out };
  if (out.every((s) => s.state === 'none')) return { state: 'none', reasons: ['noRegisteredCases'], scopes: out };
  if (out.every((s) => s.state === 'complete')) return { state: 'complete', reasons: [], scopes: out };
  const reasons = [...new Set(out.flatMap((s) => s.reasons))];
  return { state: 'partial', reasons: only === null && out.length > 1 ? ['scopeNotComplete', ...reasons] : reasons, scopes: out };
}

/** The saved-daily fields and the detailed fields that mean the same thing, side by side. */
export interface ReconMetrics {
  /** Saved: Pass + Fail + N/A + SPO (+ uncategorized). Detailed: passed + failed + na + spo (the completed statuses). */
  executed: number;
  passed: number;
  failed: number;
  notApplicable: number;
  spo: number;
  blocked: number;
}

export const savedMetrics = (e: Pick<DailyExecutionEntry, 'pass' | 'fail' | 'notApplicable' | 'spo' | 'blocked' | 'uncategorizedCompleted'>): ReconMetrics => ({
  executed: e.pass + e.fail + e.notApplicable + e.spo + (e.uncategorizedCompleted ?? 0),
  passed: e.pass,
  failed: e.fail,
  notApplicable: e.notApplicable,
  spo: e.spo,
  blocked: e.blocked,
});

export const detailedMetrics = (s: Pick<DailyDetailedSummary, 'passed' | 'failed' | 'na' | 'spo' | 'blocked'>): ReconMetrics => ({
  executed: s.passed + s.failed + s.na + s.spo,
  passed: s.passed,
  failed: s.failed,
  notApplicable: s.na,
  spo: s.spo,
  blocked: s.blocked,
});

const KEYS = ['executed', 'passed', 'failed', 'notApplicable', 'spo', 'blocked'] as const;

export type AdoptionReason = CoverageReason | 'notPermitted' | 'noSavedEntry' | 'invalidDate' | 'futureDate' | 'projectLevelOnly' | 'alreadyUpToDate';

export interface Reconciliation {
  coverage: DetailedCoverageState;
  coverageReasons: CoverageReason[];
  state: ReconciliationState;
  saved: ReconMetrics | null;
  detailed: ReconMetrics | null;
  /** saved - detailed per comparable metric (null when either side is missing). */
  differences: Record<(typeof KEYS)[number], number | null>;
  savedSource: ExecutionSource | null;
  canAdopt: boolean;
  /** Why it cannot be adopted (empty when it can). */
  reasons: AdoptionReason[];
  /** A case-derived saved day whose figures no longer equal the current detailed ones. */
  stale: boolean;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The reconciliation of one date. Coverage and reconciliation are separate facts: coverage `partial` with state `match` is possible
 * and still cannot be adopted. `canAdopt` is the DOMAIN eligibility plus the caller's authority flag (`isSv`); the UI re-checks the
 * same helper and the server separately limits who may write a day.
 */
export function reconcileDailyExecution(input: {
  date: string;
  today: string;
  savedDaily: DailyExecutionEntry | null;
  summary: DailyDetailedSummary;
  coverage: DetailedCoverage;
  isSv: boolean;
  /** Reconciliation is project level: the saved day cannot be stored per scope. */
  level?: 'project' | 'scope';
}): Reconciliation {
  const { savedDaily, summary, coverage } = input;
  const saved = savedDaily === null ? null : savedMetrics(savedDaily);
  const detailed = coverage.state === 'none' ? null : detailedMetrics(summary);
  const differences = Object.fromEntries(KEYS.map((k) => [k, saved === null || detailed === null ? null : saved[k] - detailed[k]])) as Reconciliation['differences'];
  const state: ReconciliationState = saved === null || detailed === null ? 'notComparable' : KEYS.every((k) => differences[k] === 0) ? 'match' : 'difference';
  const savedSource = savedDaily === null ? null : executionSourceOf(savedDaily);
  const stale = savedSource === 'caseExecution' && detailed !== null && state === 'difference';

  const reasons: AdoptionReason[] = [];
  if (!input.isSv) reasons.push('notPermitted');
  if (!ISO_DATE.test(input.date) || Number.isNaN(Date.parse(input.date))) reasons.push('invalidDate');
  else if (input.date > input.today) reasons.push('futureDate');
  if ((input.level ?? 'project') === 'scope') reasons.push('projectLevelOnly');
  if (coverage.state !== 'complete') reasons.push(...(coverage.reasons.length > 0 ? coverage.reasons : (['noRegisteredCases'] as CoverageReason[])));
  if (savedDaily === null) reasons.push('noSavedEntry');
  if (savedDaily !== null && savedSource === 'caseExecution' && state === 'match') reasons.push('alreadyUpToDate');
  return { coverage: coverage.state, coverageReasons: coverage.reasons, state, saved, detailed, differences, savedSource, canAdopt: reasons.length === 0, reasons, stale };
}

/** Domain eligibility in one word, for callers that only need the answer. */
export const canAdoptDetailedExecution = (r: Reconciliation): boolean => r.canAdopt;

/** Is a case-derived saved day out of date against today's detailed figures? Compares the comparable metrics, never timestamps. */
export function isCaseDerivedAggregateStale(savedEntry: DailyExecutionEntry | null, summary: DailyDetailedSummary): boolean {
  if (savedEntry === null || executionSourceOf(savedEntry) !== 'caseExecution') return false;
  const a = savedMetrics(savedEntry);
  const b = detailedMetrics(summary);
  return KEYS.some((k) => a[k] !== b[k]);
}

/**
 * THE mapping from the detailed summary to the saved day (documented, single place). Only semantically equal fields move:
 *   pass <- passed, fail <- failed, notApplicable <- na, spo <- spo, blocked <- blocked (each case's FINAL status of the day);
 *   uncategorizedCompleted <- 0 (every completed case is categorized now; leaving it would double count "executed").
 * Never mapped: Execution Events (not cases), registered / total counts, In Progress (no saved field), Retest and Question (kept as
 * they were), and the time window, note and tester count (kept). The source becomes `caseExecution`, stamped now.
 */
export function dailyEntryFromDetailedSummary(existing: DailyExecutionEntry, summary: Pick<DailyDetailedSummary, 'passed' | 'failed' | 'na' | 'spo' | 'blocked'>, nowIso: string): DailyExecutionEntry {
  const next: DailyExecutionEntry = {
    ...existing,
    pass: summary.passed,
    fail: summary.failed,
    notApplicable: summary.na,
    spo: summary.spo,
    blocked: summary.blocked,
  };
  if (existing.uncategorizedCompleted !== undefined) next.uncategorizedCompleted = 0;
  return withExecutionProvenance(next, 'caseExecution', nowIso);
}

/**
 * A lightweight, deterministic fingerprint of what an adoption preview showed: the date, the coverage state, the comparable counts,
 * the event count and the latest relevant event time. For UI consistency (stale-preview protection), not security.
 */
export function detailedFingerprint(input: { date: string; coverage: DetailedCoverageState; summary: DailyDetailedSummary; events: readonly Pick<CaseExecutionEvent, 'executedAt' | 'projectId'>[]; projectId: string }): string {
  const m = detailedMetrics(input.summary);
  const latest = input.events.filter((e) => e.projectId === input.projectId).reduce((max, e) => (e.executedAt > max ? e.executedAt : max), '');
  return [input.date, input.coverage, m.executed, m.passed, m.failed, m.notApplicable, m.spo, m.blocked, input.summary.eventCount, latest].join('|');
}

/**
 * Confirming an adoption: the values shown in the preview must still be what the current history says. Otherwise nothing is written
 * and the caller refreshes the preview ("Detailed execution changed. Review the updated values before adopting.").
 */
export function resolveAdoptionConfirmation(input: { previewFingerprint: string; currentFingerprint: string; currentEntry: DailyExecutionEntry | null }): { ok: true; entry: DailyExecutionEntry } | { ok: false; reason: 'changed' | 'unavailable' } {
  if (input.currentEntry === null) return { ok: false, reason: 'unavailable' };
  if (input.previewFingerprint !== input.currentFingerprint) return { ok: false, reason: 'changed' };
  return { ok: true, entry: input.currentEntry };
}

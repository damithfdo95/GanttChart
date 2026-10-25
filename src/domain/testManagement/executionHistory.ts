import { businessDate } from '../../../shared/businessTime';
import { caseExecutionTestRailId, type CaseExecutionEvent, type CaseResult, type CaseStatus, type TestCase, type TestScope } from '../../../shared/testManagement';
import type { DailyExecutionEntry } from '../../types';

/**
 * Append-only execution history of test cases (Phase 4).
 *
 * `CaseResult` is the mutable CURRENT/LATEST projection every screen still reads. Each time a status is set - by hand or by the
 * TestRail sync - ONE event is appended here as well. Events are facts: nothing in the app edits or deletes one; correcting a
 * result is a newer event. Nothing is invented for results recorded before this existed (history simply starts empty).
 */

export interface EventContext {
  /** The signed-in account (null in plain local use - never a made-up user). */
  actor: string | null;
  /** The actor's Team Member, when known. */
  memberId?: string;
  /** ISO time of the action. */
  now: string;
  /** A fresh unique id (injected so this module stays pure). */
  newId: () => string;
}

/**
 * The event a result change represents, or null when it was not an execution. A new event is appended when the STATUS changed
 * (including back to Not Started, so the latest event always agrees with the current result) or when the Retest flag was newly
 * raised. Memo / device / OS / ticket / question-only edits do not append: they are not a new execution. When a status change
 * carries a memo or ticket in the same save, the event keeps them.
 */
export function eventForResultChange(prev: CaseResult | undefined, next: CaseResult, tc: Pick<TestCase, 'id' | 'projectId' | 'scopeId'>, ctx: EventContext): CaseExecutionEvent | null {
  const prevStatus: CaseStatus = prev?.status ?? 'notStarted';
  const statusChanged = next.status !== prevStatus;
  const retestRaised = next.retest && !(prev?.retest ?? false);
  if (!statusChanged && !retestRaised) return null;
  return {
    id: ctx.newId(),
    projectId: tc.projectId,
    scopeId: tc.scopeId,
    testCaseId: tc.id,
    status: next.status,
    executedAt: ctx.now,
    executedByUserId: ctx.actor,
    ...(ctx.memberId === undefined ? {} : { executedByMemberId: ctx.memberId }),
    source: 'manual',
    ...(next.retest ? { retest: true } : {}),
    ...(next.question ? { question: true } : {}),
    ...(next.memo === undefined ? {} : { memo: next.memo }),
    ...(next.device === undefined ? {} : { device: next.device }),
    ...(next.os === undefined ? {} : { os: next.os }),
    ...(next.ticketRef === undefined ? {} : { ticketRef: next.ticketRef }),
  };
}

/** An event from one TestRail result. Idempotent id: the same result is the same event, however often it is synced. */
export function testRailExecutionEvent(
  tc: Pick<TestCase, 'id' | 'projectId' | 'scopeId'>,
  result: { id: number; runId: number; statusId: number | null; createdOn: number; comment?: string; defects?: string },
  status: CaseStatus,
  memberId: string | undefined,
): CaseExecutionEvent {
  const memo = result.comment !== undefined && result.comment.trim() !== '' ? result.comment.trim().slice(0, 500) : undefined;
  const ticketRef = result.defects !== undefined && result.defects.trim() !== '' ? result.defects.trim().slice(0, 80) : undefined;
  return {
    id: caseExecutionTestRailId(result.runId, result.id),
    projectId: tc.projectId,
    scopeId: tc.scopeId,
    testCaseId: tc.id,
    status,
    // The result's own created_on (unix seconds), never the moment of the fetch.
    executedAt: new Date(result.createdOn * 1000).toISOString(),
    executedByUserId: null,
    ...(memberId === undefined ? {} : { executedByMemberId: memberId }),
    source: 'testrail',
    ...(memo === undefined ? {} : { memo }),
    ...(ticketRef === undefined ? {} : { ticketRef }),
    sourceRef: { provider: 'testrail', runId: result.runId, resultId: result.id },
  };
}

/** Append events; an id that already exists is skipped (never rewritten). Returns the SAME array when nothing is new. */
export function appendExecutionEvents(history: readonly CaseExecutionEvent[], events: readonly CaseExecutionEvent[]): CaseExecutionEvent[] {
  const known = new Set(history.map((e) => e.id));
  const fresh: CaseExecutionEvent[] = [];
  for (const e of events) {
    if (known.has(e.id)) continue;
    known.add(e.id);
    fresh.push(e);
  }
  return fresh.length === 0 ? (history as CaseExecutionEvent[]) : [...history, ...fresh];
}

/** Oldest first; ties keep their recorded order. */
export function sortEventsAscending(events: readonly CaseExecutionEvent[]): CaseExecutionEvent[] {
  return events.map((e, i) => ({ e, i })).sort((a, b) => (a.e.executedAt < b.e.executedAt ? -1 : a.e.executedAt > b.e.executedAt ? 1 : a.i - b.i)).map((x) => x.e);
}

/** Newest first - the order the history view shows. */
export function eventsForCase(events: readonly CaseExecutionEvent[], testCaseId: string): CaseExecutionEvent[] {
  return sortEventsAscending(events.filter((e) => e.testCaseId === testCaseId)).reverse();
}

/** The status the history says a case has NOW (its latest event), or null when it has no history. */
export function latestStatusFromHistory(events: readonly CaseExecutionEvent[], testCaseId: string): CaseStatus | null {
  return eventsForCase(events, testCaseId)[0]?.status ?? null;
}

/** The business date (Asia/Tokyo) an event belongs to - the ONE date rule every daily derivation uses. */
export function eventBusinessDate(e: Pick<CaseExecutionEvent, 'executedAt'>): string {
  return businessDate(new Date(e.executedAt));
}

/** The events of one business date, oldest first. */
function eventsOfDate(events: readonly CaseExecutionEvent[], date: string): CaseExecutionEvent[] {
  return sortEventsAscending(events.filter((e) => eventBusinessDate(e) === date));
}

/** Each case's FINAL status of the day: its latest event of that date wins. Built from the events only, never from the current result. */
function finalStatusByCase(dayEvents: readonly CaseExecutionEvent[]): Map<string, CaseStatus> {
  const finalByCase = new Map<string, CaseStatus>();
  for (const e of dayEvents) finalByCase.set(e.testCaseId, e.status);
  return finalByCase;
}

export interface StatusCounts {
  passed: number;
  failed: number;
  blocked: number;
  inProgress: number;
  na: number;
  spo: number;
}

const emptyCounts = (): StatusCounts => ({ passed: 0, failed: 0, blocked: 0, inProgress: 0, na: 0, spo: 0 });

/** Count final statuses. A case that ended the day as Not Started (reset) is not an executed case and is left out. */
function countFinals(finals: ReadonlyMap<string, CaseStatus>, include: (caseId: string) => boolean = () => true): { unique: number; counts: StatusCounts } {
  const counts = emptyCounts();
  let unique = 0;
  for (const [caseId, status] of finals) {
    if (status === 'notStarted' || !include(caseId)) continue;
    unique += 1;
    if (status === 'pass') counts.passed += 1;
    else if (status === 'fail') counts.failed += 1;
    else if (status === 'blocked') counts.blocked += 1;
    else if (status === 'inProgress') counts.inProgress += 1;
    else if (status === 'na') counts.na += 1;
    else if (status === 'spo') counts.spo += 1;
  }
  return { unique, counts };
}

export interface DailyCaseExecution extends StatusCounts {
  date: string;
  /** Every event of the date (a case run three times counts three). */
  events: number;
  /** Distinct cases with at least one execution event that day (final status other than Not Started). */
  uniqueCasesExecuted: number;
}

/**
 * What the detailed case history says about ONE business date (Asia/Tokyo), read-only - it never writes the daily aggregate.
 * Rule: events are grouped by case, and the LATEST event of the date is that case's final status for the day. A case that ends
 * the day as Not Started (reset) is not counted as executed. Event count and unique-case count are different numbers on purpose.
 */
export function dailyCaseExecution(events: readonly CaseExecutionEvent[], projectId: string, date: string): DailyCaseExecution {
  const ofDay = eventsOfDate(events.filter((e) => e.projectId === projectId), date);
  const { unique, counts } = countFinals(finalStatusByCase(ofDay));
  return { date, events: ofDay.length, uniqueCasesExecuted: unique, ...counts };
}

export interface DailyDetailedSummary extends StatusCounts {
  date: string;
  /** The scope this summary is limited to, or null for the whole project. */
  scopeId: string | null;
  /** Execution Events: every event of the date. NOT a number of cases. */
  eventCount: number;
  /** Unique Cases Executed: cases whose final state of the day is not Not Started. The status counts add up to THIS, never to eventCount. */
  uniqueCasesExecuted: number;
  /** Event-based source breakdown (a case with both sources the same day is not forced into one bucket). */
  manualEvents: number;
  testrailEvents: number;
  /** Registered detailed cases (active cases of active scopes) - optional detail, NOT the scope total. */
  registeredCases: number;
  /** The authoritative total (scope: its own; project: the sum of the scope totals, else the fallback); null when not set. */
  scopeTotalCases: number | null;
  /** Registered cases with any execution event, ever. */
  casesWithHistory: number;
  /** Registered cases whose final status on the date counts as executed (the numerator of executedVsRegistered). */
  executedRegisteredCases: number;
  coverage: {
    /** registered / scope total (null without a total) */
    registeredVsScope: number | null;
    /** unique registered cases executed on the date / registered (null without registered cases) */
    executedVsRegistered: number | null;
  };
  /** The business date of the first recorded event of this scope set (history before it is not recorded), or null. */
  firstEventDate: string | null;
}

export interface DailySummaryInput {
  date: string;
  projectId: string;
  /** Limit to one scope; omit (or null) for the whole project. */
  scopeId?: string | null;
  scopes: readonly Pick<TestScope, 'id' | 'projectId' | 'status' | 'totalTestCases'>[];
  cases: readonly Pick<TestCase, 'id' | 'projectId' | 'scopeId' | 'status'>[];
  events: readonly CaseExecutionEvent[];
  /** Only these scopes are looked at (what a Tester may read). Omit for everything the caller holds. */
  visibleScopeIds?: ReadonlySet<string>;
  /** The project's own Total, used only when no scope carries one. */
  fallbackTotal?: number | null;
}

/**
 * The complete detailed-execution summary of one date for a project or one scope, rebuilt ENTIRELY from `caseExecution` events
 * (the current CaseResult is never read: it may be newer than the date). Aggregation is by stable case id, so a case is never counted
 * twice across scopes. Read-only: nothing here writes the saved Daily Execution.
 */
export function dailyDetailedSummary(input: DailySummaryInput): DailyDetailedSummary {
  const scopeId = input.scopeId ?? null;
  const scopes = input.scopes.filter((sc) => sc.projectId === input.projectId && (scopeId === null || sc.id === scopeId) && (input.visibleScopeIds === undefined || input.visibleScopeIds.has(sc.id)));
  const scopeIds = new Set(scopes.map((sc) => sc.id));
  const activeScopeIds = new Set(scopes.filter((sc) => sc.status === 'active').map((sc) => sc.id));
  const registered = new Set(input.cases.filter((c) => c.projectId === input.projectId && c.status === 'active' && activeScopeIds.has(c.scopeId)).map((c) => c.id));
  const mine = input.events.filter((e) => e.projectId === input.projectId && scopeIds.has(e.scopeId));
  const ofDay = eventsOfDate(mine, input.date);
  const { unique, counts } = countFinals(finalStatusByCase(ofDay));
  const executedRegistered = countFinals(finalStatusByCase(ofDay), (id) => registered.has(id)).unique;

  const totals = scopes.filter((sc) => sc.status === 'active').map((sc) => sc.totalTestCases).filter((v): v is number => typeof v === 'number');
  const scopeTotalCases = totals.length > 0 ? totals.reduce((a, b) => a + b, 0) : scopeId === null ? (input.fallbackTotal ?? null) : null;
  const first = mine.length === 0 ? null : eventBusinessDate(sortEventsAscending(mine)[0] as CaseExecutionEvent);

  return {
    date: input.date,
    scopeId,
    eventCount: ofDay.length,
    uniqueCasesExecuted: unique,
    ...counts,
    manualEvents: ofDay.filter((e) => e.source === 'manual').length,
    testrailEvents: ofDay.filter((e) => e.source === 'testrail').length,
    registeredCases: registered.size,
    scopeTotalCases,
    executedRegisteredCases: executedRegistered,
    casesWithHistory: new Set(mine.filter((e) => registered.has(e.testCaseId)).map((e) => e.testCaseId)).size,
    coverage: {
      registeredVsScope: scopeTotalCases !== null && scopeTotalCases > 0 ? registered.size / scopeTotalCases : null,
      executedVsRegistered: registered.size > 0 ? executedRegistered / registered.size : null,
    },
    firstEventDate: first,
  };
}

export interface ComparedMetric {
  comparable: boolean;
  saved: number | null;
  detailed: number | null;
  /** saved - detailed (positive: the saved aggregate is higher); null when not comparable or either side is missing. */
  difference: number | null;
}

export interface DailyExecutionComparison {
  hasSaved: boolean;
  hasDetailed: boolean;
  /** Saved executed (Pass + Fail + N/A + SPO + uncategorized) vs Unique Cases Executed (any final status except Not Started). */
  executed: ComparedMetric;
  /** Saved executed vs the detailed cases that reached a completed status (Pass + Fail + N/A + SPO): the stricter like-for-like. */
  completed: ComparedMetric;
  passed: ComparedMetric;
  failed: ComparedMetric;
  blocked: ComparedMetric;
  /** In Progress exists only in the detailed history (the saved aggregate has no such count); never mapped onto anything. */
  inProgress: ComparedMetric;
  /** The saved day figures the detailed history cannot reproduce. */
  notComparable: readonly ('inProgress' | 'retest' | 'questioned')[];
  relation: 'savedHigher' | 'detailedHigher' | 'equal' | 'unknown';
}

const metric = (saved: number | null, detailed: number | null, comparable = true): ComparedMetric => ({
  comparable,
  saved,
  detailed,
  difference: comparable && saved !== null && detailed !== null ? saved - detailed : null,
});

/**
 * Pure, informational comparison of the SAVED daily aggregate with the case-history summary. It explains nothing and reconciles
 * nothing: a difference is not corruption (the detailed cases may cover only part of the scope, some work may be tracked only in
 * aggregate, TestRail's day figure may include cases not registered here, repeated runs are events but not extra cases).
 */
export function compareDailyExecution(input: {
  savedDaily: Pick<DailyExecutionEntry, 'pass' | 'fail' | 'notApplicable' | 'spo' | 'blocked' | 'uncategorizedCompleted'> | null;
  caseDerived: Pick<DailyDetailedSummary, 'uniqueCasesExecuted' | 'passed' | 'failed' | 'blocked' | 'inProgress' | 'na' | 'spo' | 'eventCount'> | null;
}): DailyExecutionComparison {
  const saved = input.savedDaily;
  const d = input.caseDerived !== null && input.caseDerived.eventCount > 0 ? input.caseDerived : null;
  const savedExecuted = saved === null ? null : saved.pass + saved.fail + saved.notApplicable + saved.spo + (saved.uncategorizedCompleted ?? 0);
  const executed = metric(savedExecuted, d === null ? null : d.uniqueCasesExecuted);
  return {
    hasSaved: saved !== null,
    hasDetailed: d !== null,
    executed,
    completed: metric(savedExecuted, d === null ? null : d.passed + d.failed + d.na + d.spo),
    passed: metric(saved === null ? null : saved.pass, d === null ? null : d.passed),
    failed: metric(saved === null ? null : saved.fail, d === null ? null : d.failed),
    blocked: metric(saved === null ? null : saved.blocked, d === null ? null : d.blocked),
    inProgress: metric(null, d === null ? null : d.inProgress, false),
    notComparable: ['inProgress', 'retest', 'questioned'],
    relation: executed.difference === null ? 'unknown' : executed.difference > 0 ? 'savedHigher' : executed.difference < 0 ? 'detailedHigher' : 'equal',
  };
}

export interface ExecutionCoverage {
  /** The authoritative scope/project Total Test Cases. */
  total: number;
  /** Registered detailed cases (optional detail, not the Total). */
  registered: number;
  /** Registered cases with at least one execution event ever. */
  withHistory: number;
  /** Distinct registered cases executed on the date (null when no date was asked for). */
  executedOnDate: number | null;
}

/** Registered vs executed vs total, kept apart: registered cases are never read as full-project coverage. */
export function executionCoverage(input: { total: number; cases: readonly Pick<TestCase, 'id' | 'projectId' | 'status'>[]; events: readonly CaseExecutionEvent[]; projectId: string; date?: string }): ExecutionCoverage {
  const active = input.cases.filter((c) => c.projectId === input.projectId && c.status === 'active');
  const ids = new Set(active.map((c) => c.id));
  const withHistory = new Set(input.events.filter((e) => ids.has(e.testCaseId)).map((e) => e.testCaseId)).size;
  const executedOnDate =
    input.date === undefined
      ? null
      : dailyCaseExecution(input.events.filter((e) => ids.has(e.testCaseId)), input.projectId, input.date).uniqueCasesExecuted;
  return { total: input.total, registered: active.length, withHistory, executedOnDate };
}

/** Who did it, as a name: the Team Member (stable identity) first, then the account; a TestRail event with no linked person is a dash. */
export function eventActorLabel(e: Pick<CaseExecutionEvent, 'executedByMemberId' | 'executedByUserId'>, members: ReadonlyArray<{ id: string; name: string }>, userName: (userId: string) => string): string {
  if (e.executedByMemberId !== undefined) {
    const m = members.find((x) => x.id === e.executedByMemberId);
    if (m !== undefined) return m.name;
  }
  return e.executedByUserId === undefined || e.executedByUserId === null ? '—' : userName(e.executedByUserId);
}

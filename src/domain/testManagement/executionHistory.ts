import { businessDate } from '../../../shared/businessTime';
import { caseExecutionTestRailId, type CaseExecutionEvent, type CaseResult, type CaseStatus, type TestCase } from '../../../shared/testManagement';

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

export interface DailyCaseExecution {
  date: string;
  /** Every event of the date (a case run three times counts three). */
  events: number;
  /** Distinct cases with at least one execution event that day. */
  uniqueCasesExecuted: number;
  passed: number;
  failed: number;
  blocked: number;
  inProgress: number;
  na: number;
  spo: number;
}

/**
 * What the detailed case history says about ONE business date (Asia/Tokyo), read-only - it never writes the daily aggregate.
 * Rule: events are grouped by case, and the LATEST event of the date is that case's final status for the day. A case that ends
 * the day as Not Started (reset) is not counted as executed. Event count and unique-case count are different numbers on purpose.
 */
export function dailyCaseExecution(events: readonly CaseExecutionEvent[], projectId: string, date: string): DailyCaseExecution {
  const ofDay = sortEventsAscending(events.filter((e) => e.projectId === projectId && businessDate(new Date(e.executedAt)) === date));
  const finalByCase = new Map<string, CaseStatus>();
  for (const e of ofDay) finalByCase.set(e.testCaseId, e.status);
  const out: DailyCaseExecution = { date, events: ofDay.length, uniqueCasesExecuted: 0, passed: 0, failed: 0, blocked: 0, inProgress: 0, na: 0, spo: 0 };
  for (const status of finalByCase.values()) {
    if (status === 'notStarted') continue;
    out.uniqueCasesExecuted += 1;
    if (status === 'pass') out.passed += 1;
    else if (status === 'fail') out.failed += 1;
    else if (status === 'blocked') out.blocked += 1;
    else if (status === 'inProgress') out.inProgress += 1;
    else if (status === 'na') out.na += 1;
    else if (status === 'spo') out.spo += 1;
  }
  return out;
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

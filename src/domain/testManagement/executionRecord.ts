import { applyResultPatch, upsertResult, type CaseExecutionEvent, type CaseResult, type ResultPatch, type TestCase, type TestManagementState } from './index';
import { appendExecutionEvents, eventForResultChange, type EventContext } from './executionHistory';

type CaseRef = Pick<TestCase, 'id' | 'projectId' | 'scopeId'>;

/**
 * One manual result change: the current `CaseResult` and the history event are produced by the SAME action, so they always agree.
 * Nothing changes (same state object back) when the patch changes nothing. A memo/device/OS/ticket/question-only edit updates the
 * result but appends no event - it is not a new execution.
 */
export function applyManualResult(tm: TestManagementState, tc: CaseRef, patch: ResultPatch, ctx: EventContext): TestManagementState {
  const prev = tm.caseResults.find((r) => r.testCaseId === tc.id);
  const next = applyResultPatch(prev, tc, patch, ctx.actor, ctx.now);
  if (next === null) return tm;
  const event = eventForResultChange(prev, next, tc, ctx);
  return { ...tm, caseResults: upsertResult(tm.caseResults, next), caseExecutions: event === null ? tm.caseExecutions : appendExecutionEvents(tm.caseExecutions ?? [], [event]) };
}

export interface TestRailResultWrite {
  testCase: CaseRef;
  status: CaseResult['status'];
  memo?: string;
  ticketRef?: string;
}

/**
 * A confirmed TestRail sync: update the current results and append the events (already carrying their TestRail result ids, so a
 * repeat appends nothing) in one write. Same state object back when nothing is new.
 */
export function applyTestRailSyncToState(tm: TestManagementState, writes: readonly TestRailResultWrite[], events: readonly CaseExecutionEvent[], actor: string | null, now: string): TestManagementState {
  let results = tm.caseResults;
  for (const w of writes) {
    const prev = results.find((r) => r.testCaseId === w.testCase.id);
    const next = applyResultPatch(prev, w.testCase, { status: w.status, ...(w.memo === undefined ? {} : { memo: w.memo }), ...(w.ticketRef === undefined ? {} : { ticketRef: w.ticketRef }) }, actor, now);
    if (next !== null) results = upsertResult(results, next);
  }
  const before = tm.caseExecutions ?? [];
  const history = appendExecutionEvents(before, events);
  return results === tm.caseResults && history === before ? tm : { ...tm, caseResults: results, caseExecutions: history };
}

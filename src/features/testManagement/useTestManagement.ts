import { useCallback, useEffect, useMemo, useState } from 'react';
import { useReportsStateCtx } from '../../app/state-contexts';
import { useTenant } from '../../app/tenant-context';
import { businessDate } from '../../../shared/businessTime';
import type { PeopleDirectory } from '../../domain/people';
import { resultsByCase, type CaseExecutionEvent, type ResultPatch, type TestCase, type TestManagementState } from '../../domain/testManagement';
import { applyManualResult, applyTestRailSyncToState, type TestRailResultWrite } from '../../domain/testManagement/executionRecord';
import { generateId } from '../../lib/id';
import type { TesterDto } from '../../../shared/tenancy';

/** Scopes, cases and results of the workspace, the index of results by case, and the actions that change them. */
export function useTestManagement() {
  const reports = useReportsStateCtx();
  const { principal } = useTenant();
  const scopes = reports.state.scopes ?? [];
  const testCases = reports.state.testCases ?? [];
  const caseResults = reports.state.caseResults ?? [];
  const byCase = useMemo(() => resultsByCase(caseResults), [caseResults]);
  const caseExecutions = reports.state.caseExecutions ?? [];
  const state: TestManagementState = useMemo(() => ({ scopes, testCases, caseResults, caseExecutions }), [scopes, testCases, caseResults, caseExecutions]);
  const actor = principal?.userId ?? null;
  // The actor's Team Member (stable identity) when the account is linked to one; never guessed from a name.
  const members = reports.state.rcsMembers ?? [];
  const actorMemberId = actor === null ? undefined : members.find((m) => m.userId === actor)?.id;

  /**
   * Change one case's current result. Nothing is written when nothing changes. The same action appends ONE manual execution event
   * (a status change, or a newly raised Retest) so the history and the current result always agree.
   */
  const patchResult = useCallback(
    (tc: Pick<TestCase, 'id' | 'projectId' | 'scopeId'>, patch: ResultPatch): void => {
      reports.updateTestManagement((tm) => applyManualResult(tm, tc, patch, { actor, ...(actorMemberId === undefined ? {} : { memberId: actorMemberId }), now: new Date().toISOString(), newId: () => `evt_${generateId()}` }));
    },
    [reports, actor, actorMemberId],
  );

  /**
   * Confirmed TestRail sync: update the current results and append the TestRail events in ONE write (the events carry their own
   * TestRail result ids, so a repeat adds nothing). Does not go through patchResult: those results are not manual executions.
   */
  const applyTestRailSync = useCallback(
    (patches: readonly TestRailResultWrite[], events: readonly CaseExecutionEvent[]): void => {
      reports.updateTestManagement((tm) => applyTestRailSyncToState(tm, patches, events, actor, new Date().toISOString()));
    },
    [reports, actor],
  );

  return { reports, state, scopes, testCases, caseResults, caseExecutions, byCase, patchResult, applyTestRailSync, actor, update: reports.updateTestManagement };
}

/**
 * Who is who, for showing names. The roster profiles linked to accounts always; the account list too when the signed-in SV can read
 * it. Everything the screens print about a person goes through domain/people.ts, never through an id.
 */
export function usePeopleDirectory(accounts: readonly TesterDto[] | null): PeopleDirectory {
  const { principal } = useTenant();
  const reports = useReportsStateCtx();
  const members = reports.state.rcsMembers ?? [];
  return useMemo(
    () => ({
      members,
      self: principal === null ? null : { userId: principal.userId, displayName: principal.displayName, email: principal.email },
      ...(accounts === null ? {} : { accounts }),
    }),
    [members, principal, accounts],
  );
}

/** Today in the business time zone, refreshed when the window regains focus (a screen left open overnight). */
export function useBusinessToday(): string {
  const [today, setToday] = useState(businessDate());
  useEffect(() => {
    const refresh = (): void => setToday(businessDate());
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);
  return today;
}

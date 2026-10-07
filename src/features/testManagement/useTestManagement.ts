import { useCallback, useEffect, useMemo, useState } from 'react';
import { useReportsStateCtx } from '../../app/state-contexts';
import { useTenant } from '../../app/tenant-context';
import { businessDate } from '../../../shared/businessTime';
import type { PeopleDirectory } from '../../domain/people';
import { applyResultPatch, resultsByCase, upsertResult, type CaseResult, type ResultPatch, type TestCase, type TestManagementState } from '../../domain/testManagement';
import type { TesterDto } from '../../../shared/tenancy';

/** Scopes, cases and results of the workspace, the index of results by case, and the actions that change them. */
export function useTestManagement() {
  const reports = useReportsStateCtx();
  const { principal } = useTenant();
  const scopes = reports.state.scopes ?? [];
  const testCases = reports.state.testCases ?? [];
  const caseResults = reports.state.caseResults ?? [];
  const byCase = useMemo(() => resultsByCase(caseResults), [caseResults]);
  const state: TestManagementState = useMemo(() => ({ scopes, testCases, caseResults }), [scopes, testCases, caseResults]);
  const actor = principal?.userId ?? null;

  /** Change one case's current result. Nothing is written when nothing changes. */
  const patchResult = useCallback(
    (tc: Pick<TestCase, 'id' | 'projectId' | 'scopeId'>, patch: ResultPatch): void => {
      reports.updateTestManagement((tm) => {
        const prev = tm.caseResults.find((r) => r.testCaseId === tc.id);
        const next: CaseResult | null = applyResultPatch(prev, tc, patch, actor, new Date().toISOString());
        return next === null ? tm : { ...tm, caseResults: upsertResult(tm.caseResults, next) };
      });
    },
    [reports, actor],
  );

  return { reports, state, scopes, testCases, caseResults, byCase, patchResult, actor, update: reports.updateTestManagement };
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

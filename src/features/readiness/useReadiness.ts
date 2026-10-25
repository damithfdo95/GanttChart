import { useMemo } from 'react';
import { useReportsStateCtx } from '../../app/state-contexts';
import { businessDate } from '../../../shared/businessTime';
import { resolveQaPolicy } from '../../../shared/qaPolicy';
import { evaluateReleaseReadiness, type ReleaseReadiness } from '../../domain/readiness';
import type { ProjectRecord } from '../../types';

/**
 * Release readiness of the given projects, derived from the current workspace state (nothing is stored; it recalculates whenever the
 * underlying data changes). One selector, called here with the business date; components never compute readiness themselves.
 */
export function useReadiness(projects: readonly ProjectRecord[]): ReadonlyMap<string, ReleaseReadiness> {
  const { state } = useReportsStateCtx();
  const today = businessDate();
  return useMemo(() => {
    const nowIso = new Date().toISOString();
    const map = new Map<string, ReleaseReadiness>();
    for (const project of projects) {
      map.set(
        project.id,
        evaluateReleaseReadiness({
          project,
          scopes: state.scopes ?? [],
          cases: state.testCases ?? [],
          caseResults: state.caseResults ?? [],
          caseExecution: state.caseExecutions ?? [],
          assignments: state.testerAssignments ?? [],
          members: state.rcsMembers ?? [],
          policy: resolveQaPolicy(state.settings.qaPolicy),
          today,
          nowIso,
        }),
      );
    }
    return map;
  }, [projects, state.scopes, state.testCases, state.caseResults, state.caseExecutions, state.testerAssignments, state.rcsMembers, state.settings.qaPolicy, today]);
}

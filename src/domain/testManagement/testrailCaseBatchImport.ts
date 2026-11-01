import type { TestRailCaseRow } from '../../../shared/testrail';
import { newTestCase, type TestManagementState } from './index';
import { planTestRailCaseImport } from './testrailCases';

export interface TestRailCaseBatch {
  scopeId: string;
  cases: readonly TestRailCaseRow[];
}

export interface TestRailCaseBatchResult {
  state: TestManagementState;
  imported: number;
  error: string | null;
}

/** Import several fetched TestRail suites as one pure transaction. */
export function importTestRailCaseBatches(
  state: TestManagementState,
  projectId: string,
  batches: readonly TestRailCaseBatch[],
  now: string,
): TestRailCaseBatchResult {
  let acc = state;
  let imported = 0;

  for (const batch of batches) {
    const scope = acc.scopes.find((candidate) => candidate.id === batch.scopeId && candidate.projectId === projectId);
    if (scope === undefined) return { state, imported: 0, error: 'scope_not_found' };
    const plan = planTestRailCaseImport(batch.cases, acc.testCases, projectId, scope.code ?? '');
    const baseOrder = acc.testCases.filter((testCase) => testCase.scopeId === scope.id).reduce((max, testCase) => Math.max(max, testCase.order), 0);

    for (const [index, row] of plan.commitRows.entries()) {
      const made = newTestCase(
        acc,
        scope.id,
        {
          title: row.title,
          priority: row.priority,
          ...(row.type === undefined ? {} : { type: row.type }),
          testrailCaseId: row.testrailCaseId,
        },
        now,
        {
          reservedKeys: acc.testCases.filter((testCase) => testCase.projectId === projectId).map((testCase) => testCase.key),
          order: baseOrder + (index + 1) * 10,
        },
      );
      if (!made.ok) return { state, imported: 0, error: made.error };
      acc = { ...acc, testCases: [...acc.testCases, made.value] };
      imported += 1;
    }
  }

  return { state: acc, imported, error: null };
}

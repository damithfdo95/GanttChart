import { QA_WORK_TYPES, type QaWorkType } from '../../shared/qaPolicy';
import type { TestCase, TestScope } from '../types';

/**
 * QA work types describe the kind of work a scope is (Regression, Sanity, Adhoc, Verification). They are categorization aids: a team
 * may use any mix of them, or none, and no rule requires one to exist. Scopes older than the field are "unspecified"; nothing is
 * guessed from a scope's name.
 *
 * Today one workspace is one QA team (Organization > QA Team > Project > Scope > Case: only the lower three exist as data). The
 * team / organization layers and any cross-team view are future work and intentionally absent here.
 */
export type WorkTypeKey = QaWorkType | 'unspecified';

export function workTypeOf(scope: Pick<TestScope, 'workType'>): WorkTypeKey {
  return scope.workType ?? 'unspecified';
}

export interface WorkMixRow {
  workType: WorkTypeKey;
  scopes: number;
  /** Cases of this kind of work: the scopes' authoritative totals where typed, else their registered cases. */
  cases: number;
}

/** The current QA work of one project by work type: active scopes only; types with no scope are left out. */
export function workMixOfProject(projectId: string, scopes: readonly TestScope[], cases: readonly Pick<TestCase, 'scopeId' | 'status'>[]): WorkMixRow[] {
  const order: WorkTypeKey[] = [...QA_WORK_TYPES, 'unspecified'];
  const rows = new Map<WorkTypeKey, WorkMixRow>();
  for (const scope of scopes) {
    if (scope.projectId !== projectId || scope.status !== 'active') continue;
    const key = workTypeOf(scope);
    const registered = cases.filter((c) => c.scopeId === scope.id && c.status === 'active').length;
    const row = rows.get(key) ?? { workType: key, scopes: 0, cases: 0 };
    row.scopes += 1;
    row.cases += typeof scope.totalTestCases === 'number' ? scope.totalTestCases : registered;
    rows.set(key, row);
  }
  return order.flatMap((k) => (rows.has(k) ? [rows.get(k) as WorkMixRow] : []));
}

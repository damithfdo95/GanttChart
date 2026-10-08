import { TOTAL_TEST_CASES_MAX, type TestCase, type TestScope } from '../../../shared/testManagement';
import type { ProjectRecord } from '../../types';

/**
 * Authoritative Total Test Cases (Stage 8D).
 *
 * Three different numbers are kept apart, on purpose:
 *
 *   Total Test Cases      the business/planning size, TYPED by an SV. Authoritative for the whole system.
 *   Registered Test Cases the number of ACTIVE detailed Test Case records (Stage 8C). Counted, never typed.
 *   Detailed coverage     what the registered cases show (completed / registered). A drill-down, never the overall progress.
 *
 * Ownership of the Total (one rule, no two editable numbers that can disagree):
 *   - a Scope owns `totalTestCases`;
 *   - when ANY active scope of a project has one, the project Total is the SUM of its active scopes' totals (a scope without a total
 *     counts as 0 and is reported as "missing");
 *   - otherwise the project keeps the figure it always had (`inputs.totalCases`), so every project from before Stage 8D is unchanged.
 *
 * `inputs.totalCases` is where the rest of the application (Dashboard, Gantt, Cycles, Daily Report, exports, ...) already reads the
 * Total, so when the project Total is derived the sum is MIRRORED into it by `reconcileProjectTotals`. Nothing else is derived from
 * the number of registered cases.
 */

export type TotalSource = 'scopes' | 'project';

export interface ScopeTotals {
  scope: TestScope;
  /** The typed Total of the scope, or null when it has none. */
  total: number | null;
  /** Active registered cases of the scope. */
  registered: number;
  /** True when more cases are registered than the Total allows (needs the SV's attention; nothing is changed). */
  overRegistered: boolean;
}

export interface ProjectTotals {
  /** The authoritative project Total. */
  total: number;
  source: TotalSource;
  /** Active registered cases over the project's active scopes. */
  registered: number;
  /** Active scopes of the project. */
  activeScopes: number;
  /** Active scopes that have no typed Total (only meaningful when source is 'scopes'). */
  scopesWithoutTotal: number;
  /** Registered > Total, at the project level (source 'project') or at any scope (source 'scopes'). */
  overRegistered: boolean;
  scopes: ScopeTotals[];
}

/** Accept only a whole number in range; everything else is "no total". */
export function cleanTotal(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= TOTAL_TEST_CASES_MAX ? value : null;
}

/** Parse what a person typed: '' means "not set" (undefined); a whole number >= 0 is a Total; anything else is invalid (null). */
export function parseTotalInput(raw: string): number | undefined | null {
  const text = raw.normalize('NFKC').trim();
  if (text === '') return undefined;
  if (!/^\d{1,7}$/.test(text)) return null;
  return cleanTotal(Number(text));
}

export function projectTotals(project: Pick<ProjectRecord, 'projectId' | 'inputs'>, scopes: readonly TestScope[], cases: readonly TestCase[]): ProjectTotals {
  const mine = scopes.filter((s) => s.projectId === project.projectId && s.status === 'active');
  const activeIds = new Set(mine.map((s) => s.id));
  const registeredByScope = new Map<string, number>();
  let registered = 0;
  for (const c of cases) {
    if (c.projectId !== project.projectId || c.status !== 'active' || !activeIds.has(c.scopeId)) continue;
    registered += 1;
    registeredByScope.set(c.scopeId, (registeredByScope.get(c.scopeId) ?? 0) + 1);
  }
  const rows: ScopeTotals[] = mine
    .map((scope) => {
      const total = cleanTotal(scope.totalTestCases);
      const reg = registeredByScope.get(scope.id) ?? 0;
      return { scope, total, registered: reg, overRegistered: total !== null && reg > total };
    })
    .sort((a, b) => a.scope.order - b.scope.order || a.scope.name.localeCompare(b.scope.name));
  const declared = rows.filter((r) => r.total !== null);
  if (declared.length > 0) {
    return {
      total: declared.reduce((sum, r) => sum + (r.total as number), 0),
      source: 'scopes',
      registered,
      activeScopes: rows.length,
      scopesWithoutTotal: rows.length - declared.length,
      overRegistered: rows.some((r) => r.overRegistered),
      scopes: rows,
    };
  }
  const own = Math.max(0, Math.floor(Number(project.inputs.totalCases) || 0));
  return { total: own, source: 'project', registered, activeScopes: rows.length, scopesWithoutTotal: rows.length, overRegistered: registered > own, scopes: rows };
}

/** "137 active Test Cases are registered, but Total Test Cases is set to 134": the numbers behind the warning, or null. */
export function registeredWarning(totals: ProjectTotals): { registered: number; total: number } | null {
  return totals.overRegistered ? { registered: totals.registered, total: totals.total } : null;
}

/**
 * Detailed coverage of the registered cases: completed / registered (null when none are registered). It describes the registered cases
 * only; it is NOT the overall progress of the scope or project.
 */
export function detailedCoverage(completed: number, registered: number): number | null {
  return registered <= 0 ? null : Math.min(1, completed / registered);
}

/**
 * Keep each project's stored Total equal to its derived one. Returns the SAME array when nothing differs (so callers can skip the
 * write). Only projects whose Total comes from scopes are touched; all others are returned unchanged by reference.
 */
export function reconcileProjectTotals(projects: readonly ProjectRecord[], scopes: readonly TestScope[], cases: readonly TestCase[], nowIso: string): ProjectRecord[] {
  let changed = false;
  const next = projects.map((p) => {
    const totals = projectTotals(p, scopes, cases);
    if (totals.source !== 'scopes' || p.inputs.totalCases === totals.total) return p;
    changed = true;
    return { ...p, inputs: { ...p.inputs, totalCases: totals.total }, updatedAt: nowIso };
  });
  return changed ? next : (projects as ProjectRecord[]);
}

/** The Total the active project's editing surface should hold, or null when the project's own figure applies. */
export function derivedTotalFor(project: Pick<ProjectRecord, 'projectId' | 'inputs'> | undefined, scopes: readonly TestScope[], cases: readonly TestCase[]): number | null {
  if (project === undefined) return null;
  const totals = projectTotals(project, scopes, cases);
  return totals.source === 'scopes' ? totals.total : null;
}

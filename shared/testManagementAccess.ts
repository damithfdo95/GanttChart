import { isAssignedToScope } from './testManagement';

/**
 * What a Tester may READ of Test Management (Stage 8C). The server applies it to every snapshot, catch-up, live change and export, so
 * hiding things in the screens is never what protects them.
 *
 *  - SV: everything of their own workspace (not handled here: they are not filtered).
 *  - Tester: a scope only while it is ACTIVE and an assignment applies to them today; that scope's ACTIVE test cases; the results of
 *    that scope. A scope-level assignment names its scope; an assignment without a scope (every assignment made before Stage 8C) covers
 *    every active scope of its project. No assignment, no definitions and no results.
 */

type Obj = Record<string, unknown>;

function parse(json: string | undefined): Obj | null {
  if (json === undefined) return null;
  try {
    const v: unknown = JSON.parse(json);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null;
  } catch {
    return null;
  }
}

export const TM_KINDS: ReadonlySet<string> = new Set(['scope', 'testCase', 'caseResult']);

/** The ids of the scopes this account may read today. */
export function authorizedScopeIds(assignmentJson: readonly string[], scopeJson: readonly string[], userId: string, today: string): Set<string> {
  const assignments = assignmentJson.map(parse).filter((o): o is Obj => o !== null && o.userId === userId);
  const out = new Set<string>();
  if (assignments.length === 0) return out;
  for (const j of scopeJson) {
    const s = parse(j);
    if (s === null || typeof s.id !== 'string' || typeof s.projectId !== 'string' || s.status !== 'active') continue;
    if (isAssignedToScope(assignments, userId, s.projectId, s.id, today)) out.add(s.id);
  }
  return out;
}

/** May a Tester holding `authorized` receive this record? Records of other kinds are not this module's business (true). */
export function testerMaySee(item: { kind: string; id: string; json?: string }, authorized: ReadonlySet<string>, userId?: string): boolean {
  // Assignments of ACCOUNTS name scopes and people: a Tester receives their own only. Older name/roster assignments are unchanged.
  if (item.kind === 'assignment' && item.json !== undefined) {
    const a = parse(item.json);
    return a === null || typeof a.userId !== 'string' || a.userId === userId;
  }
  if (!TM_KINDS.has(item.kind)) return true;
  if (item.json === undefined) return true; // a deletion carries no content; it names an opaque id the Tester cannot use
  const o = parse(item.json);
  if (o === null) return false;
  if (item.kind === 'scope') return authorized.has(item.id);
  if (typeof o.scopeId !== 'string' || !authorized.has(o.scopeId)) return false;
  return item.kind === 'caseResult' || o.status === 'active';
}

export function filterForTester<T extends { kind: string; id: string; json?: string }>(items: readonly T[], authorized: ReadonlySet<string>, userId?: string): T[] {
  return items.filter((i) => testerMaySee(i, authorized, userId));
}

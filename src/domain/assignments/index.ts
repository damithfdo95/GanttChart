import type { RcsMember, TesterProjectAssignment } from '../../types';
import { generateId } from '../../lib/id';
import { resolveMemberIdentity } from '../members';

/**
 * Tester→project assignment operations (V6.7 Part A, identity-based in
 * V6.8). Pure array helpers — callers apply the result through the
 * reports-state actions so persistence stays centralized. Assignments live
 * at workspace level (ReportsState) because a tester's assignment history
 * spans the whole portfolio.
 *
 * V6.8: the identity of the assigned tester is `memberId` (RcsMember.id).
 * `testerName` remains as legacy-compatible data for pre-V6.8 records.
 */

export interface AssignmentInput {
  projectId: string;
  /** Stable RCS member identity (V6.8). */
  memberId?: string;
  /** Display-name snapshot / legacy value. */
  testerName?: string;
  team?: string;
  startDate: string;
  endDate?: string;
  active: boolean;
}

/** Create an assignment with a generated id (caller binds it to the project). */
export function createTesterAssignment(input: AssignmentInput): TesterProjectAssignment {
  return { id: generateId(), ...input };
}

/** Add or replace an assignment by id (id must not collide). */
export function upsertTesterAssignment(
  assignments: readonly TesterProjectAssignment[],
  assignment: TesterProjectAssignment,
): TesterProjectAssignment[] {
  const index = assignments.findIndex((a) => a.id === assignment.id);
  if (index === -1) return [...assignments, assignment];
  const copy = [...assignments];
  copy[index] = assignment;
  return copy;
}

/** Patch one assignment by id; unknown ids leave the array unchanged. */
export function updateTesterAssignment(
  assignments: readonly TesterProjectAssignment[],
  id: string,
  patch: Partial<Omit<TesterProjectAssignment, 'id'>>,
): TesterProjectAssignment[] {
  return assignments.map((assignment) => (assignment.id === id ? { ...assignment, ...patch } : assignment));
}

/** Remove one assignment by id. */
export function removeTesterAssignment(
  assignments: readonly TesterProjectAssignment[],
  id: string,
): TesterProjectAssignment[] {
  return assignments.filter((assignment) => assignment.id !== id);
}

/** All assignments for one project (chronological by start date, then identity). */
export function getAssignmentsForProject(
  assignments: readonly TesterProjectAssignment[],
  projectId: string,
): TesterProjectAssignment[] {
  return assignments
    .filter((assignment) => assignment.projectId === projectId)
    .sort(
      (a, b) =>
        a.startDate.localeCompare(b.startDate) ||
        (a.memberId ?? a.testerName ?? '').localeCompare(b.memberId ?? b.testerName ?? ''),
    );
}

// ---- Legacy assignment migration (V6.8 §11) ------------------------------------

export interface AssignmentMigrationResult {
  assignments: TesterProjectAssignment[];
  /** Assignments confidently matched to exactly one member. */
  resolved: TesterProjectAssignment[];
  /** Assignments whose testerName matches no member — legacy data preserved. */
  unmatched: TesterProjectAssignment[];
  /** Assignments whose testerName matches multiple members — flagged, never guessed. */
  ambiguous: TesterProjectAssignment[];
}

/**
 * Migrate legacy testerName-based assignments to memberId identity (V6.8 §11):
 *
 * 1. memberId already set → untouched (idempotent).
 * 2. testerName resolves to exactly one member (current name or name
 *    history — the centralized V6.9-A resolver) → memberId is set; the
 *    legacy testerName and every other field are preserved verbatim.
 * 3. no match → the record is preserved unchanged (no member is invented).
 * 4. multiple matches → the record is preserved unchanged and flagged for
 *    manual resolution — the wrong member is never silently assigned.
 *
 * Pure and non-destructive: it only ever ADDS a memberId, never rewrites
 * values, ids or removes records.
 */
export function migrateAssignmentsToMembers(
  assignments: readonly TesterProjectAssignment[],
  members: readonly RcsMember[],
): AssignmentMigrationResult {
  const resolved: TesterProjectAssignment[] = [];
  const unmatched: TesterProjectAssignment[] = [];
  const ambiguous: TesterProjectAssignment[] = [];
  const next: TesterProjectAssignment[] = assignments.map((assignment) => {
    if (assignment.memberId !== undefined && assignment.memberId !== '') return assignment;
    const legacyName = (assignment.testerName ?? '').trim();
    if (legacyName === '') return assignment;
    const resolution = resolveMemberIdentity(legacyName, members);
    if (resolution.status === 'resolved') {
      const migrated = { ...assignment, memberId: resolution.memberId };
      resolved.push(migrated);
      return migrated;
    }
    if (resolution.status === 'unmatched') unmatched.push(assignment);
    else ambiguous.push(assignment);
    return assignment;
  });
  return { assignments: next, resolved, unmatched, ambiguous };
}

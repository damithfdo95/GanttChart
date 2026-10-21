/**
 * TestRail run → tester assignment planning (pure domain — no UI, no i18n, no
 * clock, no storage, no network).
 *
 * A TestRail run's tests each carry `assignedToId` (a TestRail user id). The
 * SV importing a plan as scopes usually wants the SAME testers visible on
 * the scopes in GanttChart — the Testers column of the Scopes tab and the
 * Overview tab read GanttChart's own `TesterProjectAssignment` records, which
 * a scope import never created (the gap this module closes).
 *
 * Resolution rule (the established `linkTestRailMembers` identity rule):
 * a TestRail user matches a Team Member by email (lower-case compare).
 * Unmatched TestRail users are REPORTED, never guessed — the SV assigns
 * them by hand (a wrong automatic assignment would corrupt the identity
 * chain: performance records, reviews and the Tester's read access all key
 * off the assignment).
 *
 * Everything here is pure: the caller fetches the run's tests and the user
 * list, this module decides what they MEAN.
 */

import type { TestRailTestRow, TestRailUser } from '../../../shared/testrail';
import type { ExternalIdentity, RcsMember, TesterProjectAssignment } from '../../types';
import { generateId } from '../../lib/id';

/** One TestRail user who runs tests in the imported runs but matched no Team Member. */
export interface UnmatchedTestRailTester {
  /** TestRail user id (the identity TestRail knows). */
  testrailUserId: number;
  /** The TestRail display name (best-effort label for the SV). */
  name: string;
  /** How many of the run's tests are assigned to this user. */
  tests: number;
}

export interface TestRailAssignmentPlan {
  /** Ready-to-commit assignments, one per matched Team Member (deduplicated). */
  assignments: TesterProjectAssignment[];
  /** TestRail users that matched no Team Member (the SV assigns them by hand). */
  unmatched: UnmatchedTestRailTester[];
}

/**
 * Resolve one TestRail user to a Team Member. Rule 1 (an ACTIVE external
 * identity with provider 'testrail' and the user's TestRail id) always wins
 * — the SV's explicit link; rule 2 is a unique email match (lower-case,
 * the linkTestRailMembers rule). Undefined = unmatched, never guessed.
 */
export function resolveTestRailMember(
  testrailUserId: number,
  users: readonly TestRailUser[],
  members: readonly RcsMember[],
  externalIdentities: readonly ExternalIdentity[] = [],
): RcsMember | undefined {
  const memberById = new Map(members.map((m) => [m.id, m] as const));
  const linkedMemberId = externalIdentities
    .find((e) => e.active && e.provider === 'testrail' && e.externalId === String(testrailUserId))?.memberId;
  if (linkedMemberId !== undefined) return memberById.get(linkedMemberId);
  const user = users.find((u) => u.id === testrailUserId);
  const email = user?.email;
  if (email === undefined || email === '') return undefined;
  const member = members.find((m) => m.active && m.email !== undefined && m.email.toLowerCase() === email.toLowerCase());
  return member;
}

/**
 * Plan the tester assignments for the runs being imported as scopes.
 *
 * - One assignment per matched Team Member per SCOPE (a member assigned to
 *   two imported scopes gets two scope-level assignments — the same shape
 *   the Scopes tab's own assign flow creates).
 * `existing` assignments of the same (memberId, scopeId) are skipped:
 *   re-importing a plan never duplicates an assignment.
 * - `today` is the assignment start date (the business today of the caller).
 * - Unmatched TestRail users are aggregated across runs (tests summed).
 */
export function planTestRailAssignments(
  testsByRunId: ReadonlyMap<number, readonly TestRailTestRow[]>,
  users: readonly TestRailUser[],
  members: readonly RcsMember[],
  projectId: string,
  scopeIdsByRunId: ReadonlyMap<number, string>,
  existing: readonly TesterProjectAssignment[],
  today: string,
  externalIdentities: readonly ExternalIdentity[] = [],
): TestRailAssignmentPlan {
  const usersById = new Map(users.map((u) => [u.id, u] as const));
  const memberByEmail = new Map(
    members
      .filter((m) => m.active && m.email !== undefined && m.email !== '')
      .map((m) => [(m.email as string).toLowerCase(), m] as const),
  );
  // ACTIVE testrail identity links by TestRail user id (stringified).
  const memberByTestrailId = new Map(
    externalIdentities
      .filter((e) => e.active && e.provider === 'testrail')
      .map((e) => [e.externalId, e.memberId] as const),
  );
  const memberById = new Map(members.map((m) => [m.id, m] as const));

  // (memberId, scopeId) already assigned — never duplicated.
  const existingKeys = new Set(
    existing
      .filter((a) => a.active && a.projectId === projectId && a.memberId !== undefined && a.scopeId !== undefined)
      .map((a) => `${a.memberId}::${a.scopeId}`),
  );

  const unmatchedByUser = new Map<number, UnmatchedTestRailTester>();
  const planned = new Map<string, TesterProjectAssignment>();

  for (const [runId, tests] of testsByRunId) {
    const scopeId = scopeIdsByRunId.get(runId);
    if (scopeId === undefined) continue;
    for (const test of tests) {
      if (test.assignedToId === null) continue; // unassigned tests carry no tester
      const user = usersById.get(test.assignedToId);
      // Rule 1: the SV's explicit link (external identity) always wins;
      // rule 2: a unique email match.
      const linkedMemberId = memberByTestrailId.get(String(test.assignedToId));
      const member =
        linkedMemberId !== undefined
          ? memberById.get(linkedMemberId)
          : user?.email !== undefined && user.email !== ''
            ? memberByEmail.get(user.email.toLowerCase())
            : undefined;
      if (member === undefined) {
        const acc = unmatchedByUser.get(test.assignedToId);
        if (acc === undefined) {
          unmatchedByUser.set(test.assignedToId, {
            testrailUserId: test.assignedToId,
            name: user?.name ?? `User #${test.assignedToId}`,
            tests: 1,
          });
        } else {
          acc.tests += 1;
        }
        continue;
      }
      const key = `${member.id}::${scopeId}`;
      if (existingKeys.has(key)) continue; // already assigned — nothing to do
      if (!planned.has(key)) {
        planned.set(key, {
          id: generateId(),
          projectId,
          memberId: member.id,
          testerName: member.name,
          ...(member.team !== '' && member.team !== undefined ? { team: member.team } : {}),
          scopeId,
          startDate: today,
          active: true,
        });
      }
    }
  }

  return {
    assignments: [...planned.values()],
    unmatched: [...unmatchedByUser.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

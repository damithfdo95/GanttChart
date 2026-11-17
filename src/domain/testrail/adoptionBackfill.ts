import type { ExternalIdentity, ProjectRecord, RcsMember, TesterDailyPerformance } from '../../types';
import { adoptRecordsIntoMember } from '../performance';

/**
 * One-time / idempotent backfill: heal tester records that were written
 * BEFORE a TestRail user was linked to a Team Member (or before the
 * adoption existed at all).
 *
 * For every ACTIVE 'testrail' external identity (the SV's explicit link),
 * records recorded under the link's display name — or the linked member's
 * own registered name — and still carrying no memberId are adopted into
 * the member's stable identity. Records already linked to another member
 * are never touched, and a name claimed by TWO members is never guessed.
 *
 * Pure: returns the healed projects (same reference when nothing changed)
 * so the caller can apply it once at boot and persistence stays
 * centralized. Safe to run on every boot — the second run is a no-op.
 */
export function backfillTestRailMemberAdoption(
  projects: readonly ProjectRecord[],
  members: readonly RcsMember[],
  externalIdentities: readonly ExternalIdentity[],
): ProjectRecord[] {
  const claims = testRailAdoptionClaims(members, externalIdentities);
  if (claims.size === 0) return projects as ProjectRecord[];

  let changed = false;
  const healed = projects.map((project) => {
    const records = project.inputs.testerDailyPerformance ?? [];
    const next = adoptRecordsByClaims(records, claims);
    if (next === records) return project;
    changed = true;
    return { ...project, inputs: { ...project.inputs, testerDailyPerformance: next } };
  });
  return changed ? healed : (projects as ProjectRecord[]);
}

/**
 * The name → memberId map an adoption may safely claim: for every ACTIVE
 * 'testrail' external identity, the link's display name and the linked
 * member's registered name; when NO testrail links exist at all, every
 * member's registered name (pre-link fetches used the member's real name
 * when the email matched). A name claimed by two members is ambiguous and
 * claimed by NO ONE (never guessed, §5).
 */
export function testRailAdoptionClaims(
  members: readonly RcsMember[],
  externalIdentities: readonly ExternalIdentity[],
): Map<string, string> {
  const memberById = new Map(members.map((m) => [m.id, m] as const));
  // Collect each member's claimable names: the member's own name plus every
  // ACTIVE testrail link's display name pointing at that member.
  const namesByMember = new Map<string, Set<string>>();
  for (const identity of externalIdentities) {
    if (!identity.active || identity.provider !== 'testrail') continue;
    const member = memberById.get(identity.memberId);
    if (member === undefined) continue;
    let names = namesByMember.get(member.id);
    if (names === undefined) {
      names = new Set<string>();
      namesByMember.set(member.id, names);
    }
    if (identity.displayName !== undefined && identity.displayName.trim() !== '') names.add(identity.displayName);
  }
  if (namesByMember.size === 0) {
    // No testrail links at all: still adopt records recorded under a
    // member's own registered name (the pre-link fetches used the member's
    // real name when the email matched).
    for (const member of members) {
      if (member.name.trim() === '') continue;
      let names = namesByMember.get(member.id);
      if (names === undefined) {
        names = new Set<string>();
        namesByMember.set(member.id, names);
      }
      names.add(member.name);
    }
  } else {
    for (const [memberId, names] of namesByMember) {
      const member = memberById.get(memberId);
      if (member !== undefined && member.name.trim() !== '') names.add(member.name);
    }
  }
  // A name claimed by two members is ambiguous — never guessed (§5).
  const claimed = new Map<string, string>();
  for (const [memberId, names] of namesByMember) {
    for (const name of names) {
      const key = name.trim().toLowerCase();
      if (key === '') continue;
      const owner = claimed.get(key);
      if (owner === undefined) claimed.set(key, memberId);
      else if (owner !== memberId) claimed.delete(key); // ambiguous → no one gets it
    }
  }
  return claimed;
}

/**
 * Adopt unlinked records by a precomputed claim map (name → memberId).
 * Reference-stable: the SAME array reference when nothing changes, so
 * callers can detect "nothing to heal" without deep comparison.
 */
export function adoptRecordsByClaims(
  records: readonly TesterDailyPerformance[],
  claims: ReadonlyMap<string, string>,
): TesterDailyPerformance[] {
  if (claims.size === 0) return records as TesterDailyPerformance[];
  let next = records as TesterDailyPerformance[];
  for (const [name, memberId] of claims) {
    next = adoptRecordsIntoMember(next, [name], memberId);
  }
  return next;
}

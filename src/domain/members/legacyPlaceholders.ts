import type { AttendanceRecord, ProjectRecord, RcsMember, TesterProjectAssignment, TesterReview } from '../../types';
import { hasMemberReferences, memberReferenceScope } from '../identityResolution';

/**
 * The default roster that EVERY workspace used to be created with (versions 6.8 to 8B): eight placeholder people with ids USER0001 to
 * USER0008. Nothing creates them any more, and an empty roster is valid. This module exists only to recognise them in data that was
 * already saved, so an SV can retire them safely.
 *
 * Provenance is deterministic: a member is a legacy placeholder only if it is EXACTLY one of the original eight (id, name, team, role,
 * start date, no end date, no name history, no account link). A person with the same name who was added later has a different id; a
 * placeholder an SV edited (renamed, linked to an account, given a name history) no longer matches and is left alone. Nothing here
 * ever guesses an identity or turns a placeholder into an authenticated account.
 */
export const LEGACY_PLACEHOLDER_MEMBERS: readonly RcsMember[] = [
  { id: 'USER0001', name: 'Tokunaga Hiroshi', team: 'RCS', role: 'SV', startDate: '2026-07-01', active: true },
  { id: 'USER0002', name: 'Damith Fernando', team: 'RCS', role: 'SV', startDate: '2026-07-01', active: true },
  { id: 'USER0003', name: 'Yamauchi Kentaro', team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true },
  { id: 'USER0004', name: 'Kobayashi Masashi', team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true },
  { id: 'USER0005', name: 'Osaki Kazuki', team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true },
  { id: 'USER0006', name: 'Iwabuchi Mika', team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true },
  { id: 'USER0007', name: 'Niizeki Keitaro', team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true },
  { id: 'USER0008', name: 'Anno Masahiro', team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true },
];

/** Is this member exactly one of the original placeholders (activity does not matter: `active` may have been switched off)? */
export function isLegacyPlaceholder(member: RcsMember): boolean {
  const original = LEGACY_PLACEHOLDER_MEMBERS.find((m) => m.id === member.id);
  return (
    original !== undefined &&
    member.name === original.name &&
    member.team === original.team &&
    member.role === original.role &&
    member.startDate === original.startDate &&
    member.endDate === undefined &&
    member.userId === undefined &&
    (member.nameHistory === undefined || member.nameHistory.length === 0)
  );
}

export interface PlaceholderCleanupPlan {
  /** Placeholders nothing refers to: removed. */
  remove: string[];
  /** Placeholders that history refers to (attendance, assignments, tickets, performance, reviews): kept, but no longer active. */
  retire: string[];
}

/** What a cleanup would do. Pure: nothing is changed until the SV confirms. */
export function planPlaceholderCleanup(
  members: readonly RcsMember[],
  scope: { attendance: readonly AttendanceRecord[]; testerAssignments?: readonly TesterProjectAssignment[]; projects: readonly ProjectRecord[]; reviews?: readonly TesterReview[] },
): PlaceholderCleanupPlan {
  const refs = memberReferenceScope(scope);
  const plan: PlaceholderCleanupPlan = { remove: [], retire: [] };
  for (const m of members) {
    if (!isLegacyPlaceholder(m)) continue;
    if (hasMemberReferences(m.id, refs)) {
      if (m.active) plan.retire.push(m.id); // an already retired one needs nothing
    } else {
      plan.remove.push(m.id);
    }
  }
  return plan;
}

/** Apply a plan: unreferenced placeholders disappear, referenced ones become inactive (so no selector offers them) and stay for history. */
export function applyPlaceholderCleanup(members: readonly RcsMember[], plan: PlaceholderCleanupPlan): RcsMember[] {
  const remove = new Set(plan.remove);
  const retire = new Set(plan.retire);
  return members.filter((m) => !remove.has(m.id)).map((m) => (retire.has(m.id) ? { ...m, active: false } : m));
}

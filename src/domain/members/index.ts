import type { AttendanceRecord, RcsMember, RcsMemberNameHistory, TesterProjectAssignment, TesterReview } from '../../types';
import { LEGACY_PLACEHOLDER_MEMBERS } from './legacyPlaceholders';

/**
 * RCS member master operations (V6.8) and the centralized identity resolver
 * (V6.9-A). Pure array helpers — callers apply the result through the
 * reports-state actions so persistence stays centralized. The member master
 * lives at workspace level (ReportsState).
 *
 * Identity rules (§5):
 * - RcsMember.id is the permanent identity; name is display data.
 * - Ids are never regenerated on edit; array index is never an identity.
 * - New ids never collide with existing ones.
 * - V6.9-A: a recorded name resolves to a member through the current name
 *   OR the member's name history — never by guessing among multiple
 *   candidates.
 */

/**
 * TEST FIXTURE ONLY: a ready-made roster for unit tests. The application never creates a roster (an empty roster is valid, and real
 * people are added through Team Members); a test in stage8cCleanup.test.ts fails if application code starts using this again.
 */
export function seedRcsMembers(): RcsMember[] {
  return LEGACY_PLACEHOLDER_MEMBERS.map((member) => ({ ...member }));
}

/** Add or replace a member by id (the id is the identity — it is never changed here). */
export function upsertRcsMember(members: readonly RcsMember[], member: RcsMember): RcsMember[] {
  const index = members.findIndex((m) => m.id === member.id);
  if (index === -1) return [...members, member];
  const copy = [...members];
  // The link to the person's account (Stage 8B) belongs to the server: an edit of the profile can never drop or change it.
  const userId = members[index].userId;
  copy[index] = userId === undefined ? member : { ...member, userId };
  return copy;
}

/**
 * Trim name-history entries and drop empty ones / empty date strings
 * (V6.9-A). Pure helper used when saving a member so persisted history
 * stays canonical without rewriting names.
 */
export function normalizeMemberNameHistory(history: readonly RcsMemberNameHistory[]): RcsMemberNameHistory[] {
  return history
    .map((entry) => ({
      name: entry.name.trim(),
      ...(entry.fromDate !== undefined && entry.fromDate !== '' ? { fromDate: entry.fromDate } : {}),
      ...(entry.toDate !== undefined && entry.toDate !== '' ? { toDate: entry.toDate } : {}),
    }))
    .filter((entry) => entry.name !== '');
}

/**
 * Readable one-line representation of one history entry for tables and
 * exports: "Yamauchi Kentaro (2026-07-01–2026-09-30)".
 */
export function nameHistoryEntryLabel(entry: RcsMemberNameHistory): string {
  const from = entry.fromDate ?? '';
  const to = entry.toDate ?? '';
  const range = from === '' && to === '' ? '' : ` (${from}${to !== '' ? `–${to}` : from !== '' ? '–' : ''})`;
  return `${entry.name}${range}`;
}

/** Remove one member by id (historical records keep their own copies). */
export function removeRcsMember(members: readonly RcsMember[], id: string): RcsMember[] {
  return members.filter((member) => member.id !== id);
}

/** Find a member by its stable id. */
export function findMemberById(members: readonly RcsMember[], id: string): RcsMember | undefined {
  return members.find((member) => member.id === id);
}

/** All members whose current name matches exactly (trimmed) — used for migration ambiguity detection. */
export function findMembersByName(members: readonly RcsMember[], name: string): RcsMember[] {
  const trimmed = name.trim();
  return members.filter((member) => member.name.trim() === trimmed);
}

/** All members with the given name in their name history (trimmed exact match). */
export function findMembersByHistoricalName(members: readonly RcsMember[], name: string): RcsMember[] {
  const trimmed = name.trim();
  return members.filter((member) =>
    (member.nameHistory ?? []).some((entry) => entry.name.trim() === trimmed),
  );
}

/** The single member matching the name exactly, when exactly one exists (never a guess). */
export function findUniqueMemberByName(members: readonly RcsMember[], name: string): RcsMember | undefined {
  const matches = findMembersByName(members, name);
  return matches.length === 1 ? matches[0] : undefined;
}

// ---- Centralized identity resolver (V6.9-A §9, V6.9-B §4–§8) ---------------------
//
// The single name-matching algorithm used by attendance, tickets,
// assignments, performance and reviews. Never duplicated, never guessing.
//
// V6.9-B adds date awareness: when the caller provides the record's own
// date, historical-name candidates whose name-history range does not cover
// that date are excluded from resolution (narrowing only — a narrowed
// unique match is a SUGGESTION requiring explicit confirmation, never an
// automatic resolution).

/** How a candidate's matching name relates to the record date. */
export type IdentityDateMatch = 'valid' | 'outsideRange' | 'unrestricted';

/** One candidate member with the evidence that suggested it. */
export interface MemberIdentityCandidate {
  memberId: string;
  /** The member's current display name. */
  name: string;
  /** The name that matched (current name or a historical alias). */
  matchedName: string;
  matchType: 'current' | 'historical';
  dateMatch: IdentityDateMatch;
}

/**
 * Date-aware match of one name-history entry against a record date (§6):
 * fromDate <= recordDate <= toDate, with open-ended bounds when a side is
 * missing; entries without any range are unrestricted. ISO (YYYY-MM-DD)
 * string comparison — no timezone-dependent behavior.
 */
export function nameHistoryDateMatch(
  entry: Pick<RcsMemberNameHistory, 'fromDate' | 'toDate'>,
  recordDate: string | undefined,
): IdentityDateMatch {
  const hasFrom = entry.fromDate !== undefined && entry.fromDate !== '';
  const hasTo = entry.toDate !== undefined && entry.toDate !== '';
  if (!hasFrom && !hasTo) return 'unrestricted';
  if (recordDate === undefined || recordDate === '') return 'unrestricted'; // no date → no filtering
  if (hasFrom && recordDate < entry.fromDate!) return 'outsideRange';
  if (hasTo && recordDate > entry.toDate!) return 'outsideRange';
  return 'valid';
}

const DATE_MATCH_RANK: Record<IdentityDateMatch, number> = { valid: 2, unrestricted: 1, outsideRange: 0 };

/** Detailed resolution result with candidate evidence (V6.9-B §8). */
export type MemberIdentityResolutionDetailed =
  | {
      status: 'resolved';
      memberId: string;
      matchedBy: 'currentName' | 'nameHistory';
      dateMatch: IdentityDateMatch;
      candidates: MemberIdentityCandidate[];
    }
  | { status: 'unmatched'; name: string; candidates: MemberIdentityCandidate[] }
  | { status: 'ambiguous'; name: string; candidateMemberIds: string[]; candidates: MemberIdentityCandidate[] }
  | {
      /** Unique only after date narrowing — requires explicit confirmation (§7). */
      status: 'suggested';
      name: string;
      memberId: string;
      matchedBy: 'currentName' | 'nameHistory';
      dateMatch: IdentityDateMatch;
      candidates: MemberIdentityCandidate[];
    };

function collectCandidates(
  trimmed: string,
  members: readonly RcsMember[],
  recordDate: string | undefined,
): MemberIdentityCandidate[] {
  const byMember = new Map<string, MemberIdentityCandidate>();
  const offer = (candidate: MemberIdentityCandidate): void => {
    const existing = byMember.get(candidate.memberId);
    // Keep each member's strongest evidence (current-name match or the
    // best-dated history match).
    if (existing === undefined || DATE_MATCH_RANK[candidate.dateMatch] > DATE_MATCH_RANK[existing.dateMatch]) {
      byMember.set(candidate.memberId, candidate);
    }
  };
  for (const member of members) {
    if (member.name.trim() === trimmed) {
      offer({ memberId: member.id, name: member.name, matchedName: member.name, matchType: 'current', dateMatch: 'unrestricted' });
    }
    for (const entry of member.nameHistory ?? []) {
      if (entry.name.trim() === trimmed) {
        offer({
          memberId: member.id,
          name: member.name,
          matchedName: entry.name,
          matchType: 'historical',
          dateMatch: nameHistoryDateMatch(entry, recordDate),
        });
      }
    }
  }
  return [...byMember.values()].sort((a, b) => a.memberId.localeCompare(b.memberId));
}

/**
 * The date-aware identity resolver (V6.9-B §5–§8):
 *
 * 1. collects every member matched by current name or name history
 * 2. narrows historical candidates by the record date when one is given
 * 3. exactly one in-range candidate → resolved (or SUGGESTED when date
 *    narrowing changed the outcome — explicit confirmation required)
 * 4. multiple in-range candidates → ambiguous (never guessed)
 * 5. no in-range candidate → unmatched (out-of-range candidates are kept
 *    as evidence for display)
 *
 * Without a record date this is exactly the V6.9-A resolver.
 */
export function resolveMemberIdentityDetailed(
  name: string,
  members: readonly RcsMember[],
  recordDate?: string,
): MemberIdentityResolutionDetailed {
  const trimmed = name.trim();
  const candidates = collectCandidates(trimmed, members, recordDate);
  if (trimmed === '' || candidates.length === 0) {
    return { status: 'unmatched', name: trimmed, candidates };
  }
  const inRange = candidates.filter((candidate) => candidate.dateMatch !== 'outsideRange');
  if (inRange.length === 0) {
    return { status: 'unmatched', name: trimmed, candidates };
  }
  if (inRange.length > 1) {
    return {
      status: 'ambiguous',
      name: trimmed,
      candidateMemberIds: inRange.map((candidate) => candidate.memberId),
      candidates,
    };
  }
  const unique = inRange[0];
  const base = {
    memberId: unique.memberId,
    matchedBy: unique.matchType === 'current' ? ('currentName' as const) : ('nameHistory' as const),
    dateMatch: unique.dateMatch,
    candidates,
  };
  // When other candidates were excluded only by the date filter, the unique
  // match is a suggestion — never an automatic resolution (§7).
  if (candidates.length > 1) {
    return { status: 'suggested', name: trimmed, ...base };
  }
  return { status: 'resolved', ...base };
}

/** Structured result of resolving a recorded name against the member master. */
export type MemberIdentityResolution =
  | { status: 'resolved'; memberId: string; matchedBy: 'currentName' | 'nameHistory' }
  | { status: 'unmatched'; name: string }
  | { status: 'ambiguous'; name: string; candidateMemberIds: string[] };

/**
 * Resolve a recorded name to a stable member identity (V6.9-A §9, V6.9-B
 * date-aware): exact current-name or historical-name match (trimmed,
 * case-sensitive — the established V6.8 comparison rules), narrowed by the
 * record date when one is provided. Unique → resolved; none → unmatched;
 * multiple → ambiguous (NEVER guessed). A match that is unique only because
 * of date narrowing is NOT auto-resolved here — use
 * resolveMemberIdentityDetailed for the suggestion workflow.
 */
export function resolveMemberIdentity(
  name: string,
  members: readonly RcsMember[],
  recordDate?: string,
): MemberIdentityResolution {
  const detailed = resolveMemberIdentityDetailed(name, members, recordDate);
  switch (detailed.status) {
    case 'resolved':
      return { status: 'resolved', memberId: detailed.memberId, matchedBy: detailed.matchedBy };
    case 'ambiguous':
      return { status: 'ambiguous', name: detailed.name, candidateMemberIds: detailed.candidateMemberIds };
    default:
      // unmatched, and suggested (unique only after date narrowing —
      // conservative: not auto-applied)
      return { status: 'unmatched', name: detailed.name };
  }
}

/** Members available for new assignments / new daily execution (§9). */
export function activeMembers(members: readonly RcsMember[]): RcsMember[] {
  return members.filter((member) => member.active);
}

/**
 * Next free member id in the USER000N series ("USER0009", "USER0010", …) that
 * does not collide with any existing id — never based on array index.
 */
export function nextMemberId(members: readonly RcsMember[]): string {
  let max = 0;
  for (const member of members) {
    const match = /^USER(\d+)$/.exec(member.id);
    if (match !== null) max = Math.max(max, Number(match[1]));
  }
  let candidate = max + 1;
  const existing = new Set(members.map((member) => member.id));
  while (existing.has(`USER${String(candidate).padStart(4, '0')}`)) candidate += 1;
  return `USER${String(candidate).padStart(4, '0')}`;
}

// ---- Identity resolution (§5/§15, V6.9-A §9/§14) --------------------------------
//
// Every identity-bearing record carries an optional memberId. Records
// without one are legacy name-based data; they keep working as-is. At
// QUERY time (never by rewriting data) a legacy name is resolved to a
// member id only when it matches exactly one member (current name or name
// history) — the same conservative rule used for migration. Unmatched
// names stay name-keyed; ambiguous names are never guessed.

/** Anything that carries an optional memberId, a legacy testerName and an optional record date. */
interface IdentityBearer {
  memberId?: string;
  testerName: string;
  /** The record's own date — enables date-aware history resolution (V6.9-B). */
  date?: string;
}

/** A bug ticket's reporter identity: stable id first, legacy name as data. */
export interface ReporterBearer {
  /** Stable RCS reporter identity (V6.9-A); absent on legacy/external tickets. */
  reporterMemberId?: string;
  /** Original recorded reporter name (required). */
  reportedBy: string;
  /** The ticket's creation date — enables date-aware history resolution (V6.9-B). */
  createdAt?: string;
}

/**
 * The canonical identity key of a tester-bearing record: memberId when
 * present (explicit linkage always wins, §5), else a unique exact name
 * match in the member master (current name or date-valid name history),
 * else the trimmed name itself.
 */
export function testerIdentityKey(source: IdentityBearer, members: readonly RcsMember[]): string {
  if (source.memberId !== undefined && source.memberId !== '') return source.memberId;
  const resolution = resolveMemberIdentity(source.testerName, members, source.date);
  return resolution.status === 'resolved' ? resolution.memberId : source.testerName.trim();
}

/**
 * The canonical identity key of a bug-ticket reporter: reporterMemberId
 * when present, else a unique name match in the member master (current
 * name or date-valid name history), else the name.
 */
export function reporterIdentityKey(source: ReporterBearer, members: readonly RcsMember[]): string {
  if (source.reporterMemberId !== undefined && source.reporterMemberId !== '') return source.reporterMemberId;
  const resolution = resolveMemberIdentity(source.reportedBy, members, source.createdAt);
  return resolution.status === 'resolved' ? resolution.memberId : source.reportedBy.trim();
}

/**
 * The canonical identity key of an attendance record: memberId when
 * present, else a unique name match (current or date-valid history), else
 * the trimmed memberName. Used by attendance consistency and attendance-aware
 * allocation so both sides of every comparison share one algorithm.
 */
export function attendanceIdentityKey(
  record: Pick<AttendanceRecord, 'memberId' | 'memberName' | 'date'>,
  members: readonly RcsMember[],
): string {
  if (record.memberId !== undefined && record.memberId !== '') return record.memberId;
  const resolution = resolveMemberIdentity(record.memberName, members, record.date);
  return resolution.status === 'resolved' ? resolution.memberId : record.memberName.trim();
}

/**
 * The display name for an identity key: the member's current name when the
 * key is a member id, else the key itself (legacy name).
 */
export function identityDisplayName(key: string, members: readonly RcsMember[]): string {
  const member = findMemberById(members, key);
  return member !== undefined ? member.name : key;
}

/** A member's current display name ("Yamauchi K." — display data only). */
export function getMemberDisplayName(member: RcsMember): string {
  return member.name;
}

/** A member's full identity label ("USER0003 — Yamauchi K." — id + display). */
export function getMemberIdentityLabel(member: RcsMember): string {
  return `${member.id} — ${member.name}`;
}

/** True when the record's identity key equals the given key. */
export function matchesTesterIdentity(
  source: IdentityBearer,
  key: string,
  members: readonly RcsMember[],
): boolean {
  return testerIdentityKey(source, members) === key;
}

/** An assignment's identity key: memberId, else a unique name match, else the legacy name. */
export function assignmentIdentityKey(
  assignment: Pick<TesterProjectAssignment, 'memberId' | 'testerName'>,
  members: readonly RcsMember[],
): string {
  return testerIdentityKey(
    { memberId: assignment.memberId, testerName: assignment.testerName ?? '' },
    members,
  );
}

/** A review's identity key: memberId, else a unique name match, else the legacy name. */
export function reviewIdentityKey(review: TesterReview, members: readonly RcsMember[]): string {
  return testerIdentityKey(review, members);
}

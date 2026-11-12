/**
 * Team Management backfill (TM-00 Phase 1, TM-004 migration design).
 *
 * Creates the initial `team` and PRIMARY `teamMembership` records from the
 * workspace's existing free-text team labels (`RcsMember.team` and
 * `ReportSettings.teams`). Pure and idempotent: running it twice produces
 * the same records, and it never touches anything else — no member, project,
 * assignment or attendance record is modified.
 *
 * The result is a PLAN (records to put). The SV previews it in a dialog and
 * confirms once; the actual write is an ordinary commit with the reason
 * `team-backfill`, so it is revisioned, auditable and rollback-safe like
 * every other change.
 */

import type { TeamMembershipRecord, TeamRecord } from './teamRules';
import { exclusiveEndOf } from './teamDates';

/**
 * The member fields the backfill reads. Structural: the app's `RcsMember`
 * satisfies it, and the module stays free of `src/` imports (the Worker
 * imports `shared/` too).
 */
export interface BackfillMember {
  id: string;
  name: string;
  team: string;
  /** "YYYY-MM-DD" (inclusive). */
  startDate: string;
  /** "YYYY-MM-DD" (inclusive; undefined = open-ended). */
  endDate?: string;
  active: boolean;
}

export interface TeamBackfillInput {
  /** The workspace's existing member profiles. */
  members: readonly BackfillMember[];
  /** The settings team labels (the SV's current list). */
  teamLabels: readonly string[];
  /** ISO timestamp stamped on created records. */
  now: string;
  /** Who created the records (display name or email of the acting SV). */
  createdBy: string;
}

export interface TeamBackfillPlan {
  /** New team records, one per distinct label (existing teams are matched by code or name). */
  teams: TeamRecord[];
  /** New PRIMARY memberships, one per member that has a team label and none yet. */
  memberships: TeamMembershipRecord[];
  /** Labels that could not be matched to a member (informational). */
  unmatchedLabels: string[];
  /** Members without a team label (informational — they get no membership). */
  membersWithoutTeam: string[];
}

/** Normalize a label for matching: trimmed, collapsed whitespace, case-insensitive. */
function labelKey(label: string): string {
  return label.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** A team code from a label: upper-cased, non-alphanumerics dropped, at most 12 chars. */
function codeOf(label: string): string {
  const code = label
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(0, 12);
  return code === '' ? 'TEAM' : code;
}

/**
 * Plan the backfill. Existing teams are matched by code (case-insensitive)
 * or name (normalized); a label with no match creates a new team. Every
 * member with a team label gets one open-ended PRIMARY membership starting
 * at the member's `startDate` — but ONLY if the member has no PRIMARY
 * membership yet (in `existingMemberships`), which makes the plan idempotent.
 */
export function planTeamBackfill(input: TeamBackfillInput, existingTeams: readonly TeamRecord[], existingMemberships: readonly TeamMembershipRecord[]): TeamBackfillPlan {
  const { members, teamLabels, now, createdBy } = input;

  // Index existing teams by code and normalized name.
  const byCode = new Map<string, TeamRecord>();
  const byName = new Map<string, TeamRecord>();
  for (const t of existingTeams) {
    byCode.set(labelKey(t.code), t);
    byName.set(labelKey(t.name), t);
  }

  // The labels that matter: the settings list plus every label actually used
  // by a member (a member's label wins over a stale settings entry).
  const usedLabels = new Set<string>();
  for (const m of members) {
    const label = (m.team ?? '').trim();
    if (label !== '') usedLabels.add(label);
  }
  for (const label of teamLabels) {
    if (label.trim() !== '') usedLabels.add(label.trim());
  }

  // Resolve each label to an existing or new team: a normalized-name match
  // first, then a derived-code match (the label's code may already exist).
  const teams = new Map<string, TeamRecord>(); // label (as typed first) -> team
  const newTeams: TeamRecord[] = [];
  const usedCodes = new Set<string>(existingTeams.map((t) => labelKey(t.code)));
  for (const label of usedLabels) {
    const key = labelKey(label);
    const derivedCode = codeOf(label);
    const existing = byName.get(key) ?? byCode.get(labelKey(derivedCode));
    if (existing !== undefined) {
      teams.set(label, existing);
      continue;
    }
    let code = derivedCode;
    let suffix = 2;
    while (usedCodes.has(labelKey(code))) {
      code = `${derivedCode}${suffix}`;
      suffix += 1;
    }
    usedCodes.add(labelKey(code));
    const team: TeamRecord = {
      id: `TEAM-${code}`,
      name: label,
      code,
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    };
    newTeams.push(team);
    teams.set(label, team);
    byName.set(key, team);
  }

  // One PRIMARY membership per member with a label and no PRIMARY yet.
  const hasPrimary = new Set<string>();
  for (const m of existingMemberships) {
    if (m.membershipKind === 'PRIMARY') hasPrimary.add(m.memberId);
  }
  const memberships: TeamMembershipRecord[] = [];
  const membersWithoutTeam: string[] = [];
  let seq = 1;
  for (const m of members) {
    const label = (m.team ?? '').trim();
    if (label === '') {
      membersWithoutTeam.push(m.name);
      continue;
    }
    if (hasPrimary.has(m.id)) continue;
    const team = teams.get(label);
    if (team === undefined) continue; // cannot happen: every used label resolves
    memberships.push({
      id: `TMB-${String(seq).padStart(4, '0')}`,
      memberId: m.id,
      teamId: team.id,
      membershipKind: 'PRIMARY',
      durationType: 'PERMANENT',
      effectiveFrom: m.startDate,
      // A member's endDate is INCLUSIVE; the membership end is EXCLUSIVE.
      effectiveTo: exclusiveEndOf(m.endDate),
      status: m.active ? 'ACTIVE' : 'ENDED',
      reason: 'Initial team backfill',
      createdBy,
      createdAt: now,
    });
    seq += 1;
  }

  // Informational: settings labels no member uses (the SV may want to prune them).
  const unmatchedLabels = teamLabels.filter((l) => l.trim() !== '' && !members.some((m) => labelKey(m.team ?? '') === labelKey(l)));

  return { teams: newTeams, memberships, unmatchedLabels, membersWithoutTeam };
}

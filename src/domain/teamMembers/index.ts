import type { UserDto } from '../../../shared/tenancy';
import type { RcsMember } from '../../types';

export * from './directory';

/**
 * Team Members: one person = one registry account (who they are and may do) + one roster profile (what the QA data refers
 * to). The two are linked by the account's stable id, set by the server. Nothing here guesses a link from names or emails;
 * the one convenience, `nameSuggestions`, only offers candidates for an SV to confirm.
 */

export interface MemberRow {
  user: UserDto;
  /** The roster profile linked to this account, or null (an account that predates profiles, or whose profile was removed). */
  profile: RcsMember | null;
}

/** Every account with its linked profile. */
export function memberRows(users: readonly UserDto[], members: readonly RcsMember[]): MemberRow[] {
  const byUser = new Map<string, RcsMember>();
  for (const m of members) if (m.userId !== undefined) byUser.set(m.userId, m);
  return users.map((user) => ({ user, profile: byUser.get(user.id) ?? null }));
}

/** Roster entries that belong to no account (older data). They stay as they are until an SV links them. */
export function rosterOnly(members: readonly RcsMember[]): RcsMember[] {
  return members.filter((m) => m.userId === undefined);
}

const norm = (s: string): string => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Roster-only entries whose name equals this account's display name (exactly, after normalising case and spaces). A hint for
 * the SV, never a link: names are not identity.
 */
export function nameSuggestions(user: UserDto, roster: readonly RcsMember[]): RcsMember[] {
  if (user.displayName === null) return [];
  const name = norm(user.displayName);
  if (name === '') return [];
  return roster.filter((m) => norm(m.name) === name);
}

/** SVs that could receive the ownership: enabled, same workspace (the list the server gave), not the Owner. */
export function ownershipCandidates(users: readonly UserDto[]): UserDto[] {
  return users.filter((u) => u.role === 'admin' && !u.isOwner && u.status !== 'disabled');
}

export interface MemberCounts {
  svs: number;
  testers: number;
  disabled: number;
}

export function memberCounts(users: readonly UserDto[]): MemberCounts {
  return {
    svs: users.filter((u) => u.role === 'admin').length,
    testers: users.filter((u) => u.role === 'user').length,
    disabled: users.filter((u) => u.status === 'disabled').length,
  };
}

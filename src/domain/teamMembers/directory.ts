import { memberRoleOf, type MemberRole } from '../../../shared/members';
import type { UserDto } from '../../../shared/tenancy';
import type { Language, RcsMember } from '../../types';
import { memberLabel } from '../people';
import { t } from '../../i18n';

/**
 * The Team Member directory (Stage 8D): the workspace's ONE list of people. Every dropdown that asks "which person?" is built from it,
 * so a person is always the same profile (stable internal id, never shown) whatever screen picks them.
 *
 * A profile may or may not be linked to a login account. Both appear in dropdowns - the business assignment does not need a login - but
 * only a LINKED, enabled account can sign in and record results; the options say which is which in words.
 */

export type MemberState = 'active' | 'removed';

/** A profile is in active use unless it was removed (`active` false) or its end date has passed. */
export function isActiveMember(member: Pick<RcsMember, 'active' | 'endDate'>, today: string): boolean {
  if (member.active === false) return false;
  return member.endDate === undefined || member.endDate === '' || member.endDate >= today;
}

export const memberState = (member: Pick<RcsMember, 'active' | 'endDate'>, today: string): MemberState => (isActiveMember(member, today) ? 'active' : 'removed');

/** SV / Tester for a profile, or null for an older free-text role ("Test Engineer"), which is shown as written and never guessed. */
export const intendedRoleOf = (member: Pick<RcsMember, 'role'>): MemberRole | null => memberRoleOf(member.role);

export const isLinked = (member: Pick<RcsMember, 'userId'>): boolean => typeof member.userId === 'string' && member.userId !== '';

export interface SelectOptions {
  /** Only profiles whose intended role is this one. Profiles with an older free-text role are never offered for a role-specific pick. */
  role?: MemberRole;
  /** Today's business date (YYYY-MM-DD). */
  today: string;
  /** Keep these profiles even if removed (an existing record must stay displayable and selectable while it is being edited). */
  keep?: readonly string[];
}

/** The profiles a person may be picked from: active ones, optionally of one role, in name order. Removed profiles are not offered. */
export function selectableMembers(members: readonly RcsMember[], options: SelectOptions): RcsMember[] {
  const keep = new Set(options.keep ?? []);
  return members
    .filter((m) => keep.has(m.id) || (isActiveMember(m, options.today) && (options.role === undefined || intendedRoleOf(m) === options.role)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface PersonOption {
  /** The stable profile id: the dropdown VALUE, never its label. */
  memberId: string;
  /** The linked account id, or null while the profile has no account. */
  userId: string | null;
  /** The visible text: display name, then email, then "Former member". Never an id. */
  label: string;
  linked: boolean;
  removed: boolean;
}

/** Dropdown options for a set of profiles. The label never contains an id; linked state is a separate flag the screen words itself. */
export function personOptions(lang: Language, members: readonly RcsMember[], today: string): PersonOption[] {
  return members.map((m) => ({
    memberId: m.id,
    userId: isLinked(m) ? (m.userId as string) : null,
    label: optionLabel(lang, m),
    linked: isLinked(m),
    removed: !isActiveMember(m, today),
  }));
}

/** Display name, else the profile's email, else "Former member" (an id-like name counts as missing). */
export function optionLabel(lang: Language, m: Pick<RcsMember, 'name' | 'email'>): string {
  const byName = memberLabel(lang, m);
  if (byName !== t(lang, 'people.former')) return byName;
  return m.email !== undefined && m.email !== '' ? m.email : byName;
}

/** The option text with the account state in words: "Hana Sato" / "Taro Tanaka (no login yet)". */
export function personOptionText(lang: Language, option: PersonOption): string {
  if (option.removed) return `${option.label} (${t(lang, 'dir.removed')})`;
  return option.linked ? option.label : `${option.label} (${t(lang, 'dir.noLoginYet')})`;
}

// ---- the directory table --------------------------------------------------------

export interface DirectoryRow {
  /** React key; never shown. */
  key: string;
  member: RcsMember | null;
  /** The linked account (null for a profile without one, or when accounts cannot be listed - Local storage). */
  user: UserDto | null;
  /** An account that has no profile yet (older data): shown so an SV can give it one. */
  orphanAccount: boolean;
}

/** Profiles first (with their account, if linked), then accounts that have no profile. */
export function directoryRows(members: readonly RcsMember[], users: readonly UserDto[] | null): DirectoryRow[] {
  const byUser = new Map((users ?? []).map((u) => [u.id, u]));
  const linkedUsers = new Set<string>();
  const rows: DirectoryRow[] = members.map((member) => {
    const user = member.userId === undefined ? null : (byUser.get(member.userId) ?? null);
    if (user !== null) linkedUsers.add(user.id);
    return { key: `m:${member.id}`, member, user, orphanAccount: false };
  });
  for (const user of users ?? []) if (!linkedUsers.has(user.id)) rows.push({ key: `u:${user.id}`, member: null, user, orphanAccount: true });
  return rows;
}

/** Normalise what a person typed as an email for comparison with stored ones (the server does the real check). */
export function normalizeMemberEmail(raw: string): string | null {
  const e = raw.normalize('NFKC').trim().toLowerCase();
  return /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z0-9-]{2,}$/.test(e) && e.length <= 254 ? e : null;
}

/** Is this email already carried by another profile (Local storage; Web storage is checked by the server too)? */
export function emailTaken(members: readonly RcsMember[], email: string, exceptId?: string): boolean {
  return members.some((m) => m.id !== exceptId && m.email === email);
}

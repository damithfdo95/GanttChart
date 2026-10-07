import { t } from '../../i18n';
import type { Language, RcsMember } from '../../types';

/**
 * The ONE way a person is shown to a human. Internal identifiers (account ids "usr_...", roster ids "USER0001", workspace ids) are
 * plumbing: they are never a name and are never shown as one. The order is always
 *
 *   display name  ->  organization email  ->  a neutral word ("Former member")
 *
 * and a value that merely LOOKS like an internal id is treated as missing, so even a roster entry that was named after its id cannot
 * leak it. Developer tools and logs may still print ids; ordinary screens, exports and confirmations must not.
 */

/** Looks like something the system generated for itself rather than something a person is called. */
const TECHNICAL_ID = /^(usr|ten|res|tc|scp|cyc|asg|prj)[_-][\w-]{4,}$|^user\d{2,}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeTechnicalId(value: string): boolean {
  return TECHNICAL_ID.test(value.trim());
}

function usable(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v === '' || looksLikeTechnicalId(v) ? null : v;
}

export interface PersonInfo {
  displayName?: string | null;
  /** A roster profile's name. */
  name?: string | null;
  email?: string | null;
}

/** The visible label of a person; `fallback` is already translated. */
export function personLabelOf(info: PersonInfo | null | undefined, fallback: string): string {
  if (info === null || info === undefined) return fallback;
  return usable(info.displayName) ?? usable(info.name) ?? usable(info.email) ?? fallback;
}

/** The same, with the neutral word in the given language. */
export function personLabel(lang: Language, info: PersonInfo | null | undefined): string {
  return personLabelOf(info, t(lang, 'people.former'));
}

/** A roster profile as a person ("Hana Sato"), never its id. */
export function memberLabel(lang: Language, member: Pick<RcsMember, 'name'> | null | undefined): string {
  return personLabel(lang, member === null || member === undefined ? null : { name: member.name });
}

export interface PeopleDirectory {
  /** Roster profiles (each may be linked to an account by `userId`). */
  members: readonly Pick<RcsMember, 'id' | 'name' | 'userId'>[];
  /** The signed-in person, if known. */
  self?: { userId: string | null; displayName: string | null; email: string } | null;
  /** Accounts the signed-in SV can list (display name and email), if available. */
  accounts?: readonly { id: string; displayName: string | null; email: string }[];
}

/** Resolve a stored account id (an assignment's or a result's actor) to a person's label. Unknown accounts become "Former member". */
export function userLabel(lang: Language, userId: string | null | undefined, directory: PeopleDirectory): string {
  if (userId === null || userId === undefined || userId === '') return t(lang, 'people.former');
  const account = directory.accounts?.find((a) => a.id === userId);
  if (account !== undefined) return personLabel(lang, { displayName: account.displayName, email: account.email });
  if (directory.self?.userId === userId) return personLabel(lang, { displayName: directory.self.displayName, email: directory.self.email });
  const member = directory.members.find((m) => m.userId === userId);
  if (member !== undefined) return personLabel(lang, { name: member.name });
  return t(lang, 'people.former');
}

/** A roster member id (as stored on tickets, attendance, performance) resolved to a name; unknown ids become "Former member". */
export function rosterLabel(lang: Language, memberId: string | null | undefined, members: readonly Pick<RcsMember, 'id' | 'name'>[]): string {
  const m = memberId === null || memberId === undefined ? undefined : members.find((x) => x.id === memberId);
  return m === undefined ? t(lang, 'people.former') : memberLabel(lang, m);
}

/** "A, B +2" for a list of labels (a compact human form for many assigned people). */
export function compactNames(labels: readonly string[], max = 3): string {
  const unique = [...new Set(labels)];
  if (unique.length <= max) return unique.join(', ');
  return `${unique.slice(0, max).join(', ')} +${unique.length - max}`;
}

/**
 * Team Members (Stage 8D): the workspace's one people directory.
 *
 * A Team Member PROFILE (the `member` record, an RcsMember) is a person of this workspace: a stable internal id (USER0001, never shown),
 * a display name, an optional email, an intended role (SV / Tester) and a lifecycle (active / removed). An ACCOUNT is a registry login
 * identity (usr_..., email, role, status). They are separate: a profile may exist without an account (unlinked), and an account is linked
 * to at most one profile, by `member.userId`, set by the SERVER only. Display names never link anything.
 *
 * Plain TypeScript with no dependencies: the same rules run in the browser (before saving) and in the Worker (before a commit is accepted).
 */

import { normalizeEmail } from './tenancy';

export type MemberRoleWord = 'SV' | 'Tester';
export type MemberRole = 'sv' | 'tester';

/** "SV" / "Tester" (any case; the older free-text roles are neither): the intended role of a profile, or null. */
export function memberRoleOf(role: unknown): MemberRole | null {
  if (typeof role !== 'string') return null;
  const r = role.normalize('NFKC').trim().toLowerCase();
  return r === 'sv' ? 'sv' : r === 'tester' ? 'tester' : null;
}

export const memberRoleWord = (role: MemberRole): MemberRoleWord => (role === 'sv' ? 'SV' : 'Tester');

/** Internal account role for an intended role: SV -> admin, Tester -> user. */
export const accountRoleOf = (role: MemberRole): 'admin' | 'user' => (role === 'sv' ? 'admin' : 'user');

type Obj = Record<string, unknown>;

function parse(json: string | null): Obj | null {
  if (json === null) return null;
  try {
    const v: unknown = JSON.parse(json);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null;
  } catch {
    return null;
  }
}

export interface MemberCommitInput {
  puts: ReadonlyArray<{ kind: string; id: string; json: string }>;
  deletes: ReadonlyArray<{ kind: string; id: string }>;
  view: { get(kind: string, id: string): string | null; list?(kind: string): Array<{ id: string; json: string }> };
}

/**
 * Rules for changes to Team Member profiles that arrive as ordinary commits (an SV editing the roster). Returns a short machine-readable
 * reason or null. Everything that touches an ACCOUNT's identity goes through the server's own endpoints, so a commit cannot do it:
 *
 *  - an email is stored in its normalised form and is unique among the workspace's profiles;
 *  - a LINKED profile's email, intended role and active state belong to its account (they change only through the API);
 *  - a linked profile is never deleted (its history and attribution stay).
 */
export function memberCommitError(input: MemberCommitInput): string | null {
  const { puts, deletes, view } = input;
  const touches = puts.some((p) => p.kind === 'member') || deletes.some((d) => d.kind === 'member');
  if (!touches) return null;

  const incoming = new Map<string, Obj>();
  for (const p of puts) {
    if (p.kind !== 'member') continue;
    const next = parse(p.json);
    if (next !== null) incoming.set(p.id, next);
  }

  for (const [id, next] of incoming) {
    const prev = parse(view.get('member', id));
    if (next.email !== undefined) {
      if (typeof next.email !== 'string' || normalizeEmail(next.email) !== next.email) return 'member_invalid_email';
    }
    const prevLinked = prev !== null && typeof prev.userId === 'string' && prev.userId !== '';
    if (prevLinked) {
      if ((prev.email ?? null) !== (next.email ?? null)) return 'member_email_locked';
      if (prev.role !== next.role) return 'member_role_requires_api';
      if ((prev.active !== false) !== (next.active !== false)) return 'member_status_requires_api';
    }
    if (typeof next.email === 'string' && (prev === null || prev.email !== next.email)) {
      for (const r of view.list?.('member') ?? []) {
        if (r.id === id) continue;
        const other = incoming.get(r.id) ?? parse(r.json);
        if (other !== null && other.email === next.email) return 'member_email_taken';
      }
      for (const [otherId, other] of incoming) if (otherId !== id && other.email === next.email) return 'member_email_taken';
    }
  }

  for (const d of deletes) {
    if (d.kind !== 'member') continue;
    const prev = parse(view.get('member', d.id));
    if (prev !== null && typeof prev.userId === 'string' && prev.userId !== '') return 'member_linked_cannot_delete';
  }
  return null;
}

/** The profile in `members` that carries this normalised email (at most one, by the rule above), or undefined. */
export function memberWithEmail<T extends { email?: string }>(members: readonly T[], email: string): T | undefined {
  return members.find((m) => m.email === email);
}

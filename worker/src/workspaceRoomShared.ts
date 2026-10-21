/**
 * Pure helpers, types and constants shared by WorkspaceRoom (the per-tenant
 * Durable Object). Extracted from workspaceRoom.ts so the object file holds
 * only the class itself. Everything here is environment-free and side-effect
 * free.
 */

import { checkNotification, audienceIncludes, type Recipient } from '../../shared/notifications';
import { SV_ONLY_KINDS } from '../../shared/testerRules';
import type { Role } from '../../shared/protocol';

/** A Team Member profile as the Worker reads it (the fields it needs to decide; never the whole record). */
export interface MemberInfo {
  id: string;
  name: string;
  email?: string;
  /** The word stored on the profile ("SV" / "Tester", or an older free-text role). */
  role: string;
  active: boolean;
  userId?: string;
}

export type LinkError = 'member_not_found' | 'member_already_linked' | 'account_already_linked' | 'member_inactive' | 'member_email_mismatch' | 'member_email_taken' | 'archived' | 'failed';
export type LinkResult = { ok: true; memberId: string; created: boolean; assignments: number } | { ok: false; error: LinkError };

export function toMemberInfo(id: string, o: Record<string, unknown>): MemberInfo {
  return {
    id,
    name: typeof o.name === 'string' ? o.name : '',
    ...(typeof o.email === 'string' ? { email: o.email } : {}),
    role: typeof o.role === 'string' ? o.role : '',
    active: o.active !== false,
    ...(typeof o.userId === 'string' && o.userId !== '' ? { userId: o.userId } : {}),
  };
}

/**
 * A Tester receives the roster (names, for showing who did what) but NOT other people's email addresses: the email belongs to the
 * directory an SV manages. Their own profile keeps its email.
 */
export function redactMemberEmail<T extends { kind: string; json?: string }>(item: T, userId: string): T {
  if (item.kind !== 'member' || item.json === undefined) return item;
  try {
    const o = JSON.parse(item.json) as Record<string, unknown>;
    if (o.email === undefined || (userId !== '' && o.userId === userId)) return item;
    const { email: _email, ...rest } = o;
    return { ...item, json: JSON.stringify(rest) };
  } catch {
    return item;
  }
}

/** The date (business time) of the last housekeeping run: it runs at most once a day. */
export const RETENTION_FLAG = 'retention-last-run';

/** Does this stored definition address this person (and is it on)? Unreadable definitions reach nobody. */
export function definitionReaches(json: string | undefined, who: Recipient): boolean {
  if (json === undefined) return false;
  try {
    const c = checkNotification(JSON.parse(json));
    return c.ok && c.value.enabled && audienceIncludes(c.value.audience, who);
  } catch {
    return false;
  }
}

/** The parts of a Team Member profile that follow its login account, and so are not undone by restoring an older revision. */
export const ACCOUNT_FIELDS = ['userId', 'email', 'role', 'active', 'endDate', 'removedAt'] as const;

/** Per-connection state that survives hibernation (limit: 16 KB). */
export interface Attachment {
  email: string;
  userId: string;
  tenantId: string;
  role: Role;
  /** Set by the client's hello; commits before it are refused. */
  clientId: string | null;
  /** End of the Access session (ms epoch); null for the local dev identity. */
  expiresAt: number | null;
}

export const IDENTITY_EMAIL_HEADER = 'x-gc-verified-email';
export const IDENTITY_ROLE_HEADER = 'x-gc-verified-role';
export const IDENTITY_EXPIRES_HEADER = 'x-gc-verified-exp';
export const IDENTITY_USER_HEADER = 'x-gc-user';
export const TENANT_HEADER = 'x-gc-tenant';
export const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Default history retention. Kept at 30 days (not longer) so the full-record
 * history stays far below the Workers Free 5 GB storage cap even with heavy use.
 */
export const DEFAULT_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 365;
/** Above this database size the alarm prunes harder (Workers Free storage cap is 5 GB). */
export const SIZE_GUARD_BYTES = 2 * 1024 * 1024 * 1024;
export const SIZE_GUARD_RETENTION_DAYS = 7;
export const WS_CLOSE_UNSUPPORTED_DATA = 1003;
export const WS_CLOSE_MESSAGE_TOO_BIG = 1009;
/** The instance that served the pre-tenant (Stage 4) single workspace. */
export const LEGACY_WORKSPACE_NAME = 'workspace';
export const FROZEN_FLAG = 'frozen';

export function isExpired(attachment: Attachment): boolean {
  return attachment.expiresAt !== null && Date.now() > attachment.expiresAt;
}

/** What a Tester receives: everything except the SV-only kinds (reviews, identity logs, reports, topics). */
export function visibleTo<T extends { kind: string }>(role: Role, items: T[]): T[] {
  return role === 'admin' ? items : items.filter((i) => !SV_ONLY_KINDS.has(i.kind));
}

export function isRole(value: string | null): value is Role {
  return value === 'admin' || value === 'editor' || value === 'viewer';
}

export interface WorkspaceState {
  revision: number;
  hash: string;
  counts: Record<string, number>;
  hasData: boolean;
  frozen: boolean;
}

export type ImportInput = {
  /** Client-generated; repeating an import with the same id never applies it twice. */
  migrationId: string;
  records: unknown;
  /** The server revision the uploader inspected. A mismatch means someone else changed it. */
  expectedRevision: number;
  /** Replace existing server data (the caller has already verified the typed confirmation). */
  replace: boolean;
  actor: string;
};

export type ImportResult =
  | { ok: true; revision: number; hash: string; counts: Record<string, number>; alreadyApplied: boolean }
  | { ok: false; error: 'invalid' | 'revision_mismatch' | 'server_not_empty' | 'failed'; message?: string; revision?: number };

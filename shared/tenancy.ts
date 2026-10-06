/**
 * Multi-tenant vocabulary shared by the Worker, the Durable Objects and the
 * browser. Plain TypeScript, no dependencies.
 *
 * Security boundaries are STABLE IDS (`ten_…`, `usr_…`). Names are display text
 * only. Emails are identities, normalised so that one person cannot exist twice
 * under different spellings.
 */

import type { RecordKind, RecordPut, Role } from './protocol';
import { LIMITS, isRecordKind } from './protocol';
import type { UserLifecycle } from './lifecycle';

// ---- vocabulary ----

export type AppRole = 'super_admin' | 'admin' | 'user';
export type StorageMode = 'local' | 'web';
export type TenantStatus = 'active' | 'deactivated' | 'deletion_requested' | 'deleting';
export type UserStatus = 'invited' | 'active' | 'disabled';
/** What a `user` may do inside the workspace (the former "read-only" concept). */
export type UserAccess = 'editor' | 'viewer';

export const TENANT_ID_PREFIX = 'ten_';
export const USER_ID_PREFIX = 'usr_';
const ID_BODY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isTenantId(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith(TENANT_ID_PREFIX) && ID_BODY.test(v.slice(TENANT_ID_PREFIX.length));
}

export function isUserId(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith(USER_ID_PREFIX) && ID_BODY.test(v.slice(USER_ID_PREFIX.length));
}

/** Unguessable, server-generated. */
export function newTenantId(): string {
  return TENANT_ID_PREFIX + crypto.randomUUID();
}

export function newUserId(): string {
  return USER_ID_PREFIX + crypto.randomUUID();
}

/** The exact word a person must type to confirm replacing a whole workspace (checked by BOTH the browser and the server). */
export const REPLACE_CONFIRMATION = 'REPLACE';

/** The exact word an Admin must type to switch a web workspace back to local storage (checked by BOTH the browser and the server). */
export const SWITCH_TO_LOCAL_CONFIRMATION = 'LOCAL';

/** The exact word an Admin must type to REQUEST deletion of their workspace (checked by BOTH the browser and the server). */
export const REQUEST_DELETION_CONFIRMATION = 'DELETE';

/** WebSocket close codes with a meaning for the client. */
export const CLOSE_CODES = {
  sessionExpired: 4401,
  accessRevoked: 4403,
  storageMoved: 4410,
  tenantDeleted: 4411,
} as const;

// ---- email identity ----

const EMAIL_FORBIDDEN = /[\s<>()[\]\\,;:"\u0000-\u001f\u007f]/;

/**
 * Canonical form of an email identity: Unicode NFKC (folds full-width and
 * compatibility characters), trimmed, lower-case. Returns null when it is not a
 * plausible address. This is what is stored, compared and made unique.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const e = raw.normalize('NFKC').trim().toLowerCase();
  if (e.length < 3 || e.length > 254) return null;
  const at = e.indexOf('@');
  if (at < 1 || at !== e.lastIndexOf('@')) return null;
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (local.length > 64 || EMAIL_FORBIDDEN.test(local) || EMAIL_FORBIDDEN.test(domain)) return null;
  const labels = domain.split('.');
  if (labels.length < 2 || labels.some((l) => l.length === 0 || l.startsWith('-') || l.endsWith('-'))) return null;
  if (labels[labels.length - 1].length < 2) return null;
  return e;
}

// ---- managed organisation domains ----

/** One DNS name: dot-separated labels, no wildcard, no leading/trailing hyphen, at least two labels. */
const DOMAIN_SHAPE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/;

/**
 * The organisation domains whose people may be given an Admin or User account
 * (the `MANAGED_USER_EMAIL_DOMAINS` setting, comma separated).
 *
 * Fail closed: an entry that is not a plain domain name (a wildcard, a path, an
 * address, a typo) is DROPPED, so a mistake in the setting can only shrink what
 * is allowed, never widen it. A subdomain is a different domain and must be
 * listed on its own. An empty result means nobody can be provisioned.
 */
export function parseManagedDomains(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const d = part.normalize('NFKC').trim().toLowerCase();
    if (DOMAIN_SHAPE.test(d) && !out.includes(d)) out.push(d);
  }
  return out;
}

/** The domain of an already-normalised email (everything after its single "@"). */
export function emailDomain(normalizedEmail: string): string {
  return normalizedEmail.slice(normalizedEmail.lastIndexOf('@') + 1);
}

/** Exact match of the email's whole domain against the managed list — never "ends with", never "contains". */
export function isManagedEmail(rawEmail: unknown, managedDomains: readonly string[]): boolean {
  const email = normalizeEmail(rawEmail);
  if (email === null) return false;
  return managedDomains.includes(emailDomain(email));
}

/**
 * An optional person's display name: absent/empty means "none"; otherwise 1–80 characters, no
 * control characters. It is display text only; identity is always the email.
 */
export function parseDisplayName(raw: unknown): { ok: true; value: string | null } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false };
  const n = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (n === '') return { ok: true, value: null };
  // eslint-disable-next-line no-control-regex
  if (n.length > 80 || /[\u0000-\u001f\u007f<>]/.test(n)) return { ok: false };
  return { ok: true, value: n };
}

/** A tenant's display name: 1–80 characters, no control characters. */
export function normalizeTenantName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const n = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  // eslint-disable-next-line no-control-regex
  if (n.length < 1 || n.length > 80 || /[\u0000-\u001f\u007f]/.test(n)) return null;
  return n;
}

// ---- DTOs sent to the browser ----

export interface TenantDto {
  id: string;
  name: string;
  storageMode: StorageMode;
  status: TenantStatus;
  createdAt: string;
  deletionRequestedAt: string | null;
}

export interface TenantSummaryDto extends TenantDto {
  adminEmail: string;
  adminDisplayName: string | null;
  adminStatus: UserLifecycle;
  userCount: number;
  /** Newest sign-in of anyone in the workspace (kept up to date at most every 12 h; see registry.ts). null = nobody has signed in. */
  lastActivityAt: string | null;
  /** The Admin's address is outside the managed organisation domains (an older account): shown as a warning, never acted on. */
  adminOutsideManagedDomains: boolean;
}

export interface UserDto {
  id: string;
  email: string;
  displayName: string | null;
  role: 'admin' | 'user';
  access: UserAccess;
  status: UserLifecycle;
  createdAt: string;
  updatedAt: string;
  /** Last sign-in/activity; bucketed (at most one write per person per 12 h), so approximate. */
  lastLoginAt: string | null;
}

/** Search/filter/sort/paging of the Super Admin's workspace list (all applied on the server). */
export interface TenantListQuery {
  q?: string;
  status?: TenantStatus | 'disabled' | 'all';
  mode?: StorageMode | 'all';
  sort?: 'name' | 'created' | 'admin' | 'activity' | 'status' | 'accounts';
  dir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface TenantListResult {
  tenants: TenantSummaryDto[];
  total: number;
}

// ---- administrative audit trail (not the QA revision history) ----

export const AUDIT_ACTIONS = [
  'admin.created',
  'tenant.disabled',
  'tenant.reactivated',
  'tenant.deletion_requested',
  'tenant.deletion_cancelled',
  'tenant.deletion_rejected',
  'tenant.deletion_approved',
  'tenant.deleted',
  'user.created',
  'user.disabled',
  'user.reactivated',
  'user.access_changed',
  'storage.migration_uploaded',
  'storage.web_activated',
  'storage.local_activated',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** What the Super Admin sees: platform-level events only. Account events inside a workspace stay with that workspace's Admin. */
export const PLATFORM_AUDIT_ACTIONS: readonly AuditAction[] = AUDIT_ACTIONS.filter((a) => !a.startsWith('user.'));

export interface AuditActor {
  userId: string | null;
  email: string;
  role: AppRole;
}

export interface AdminAuditDto {
  id: number;
  at: string;
  action: AuditAction;
  actorEmail: string;
  actorRole: AppRole;
  tenantId: string | null;
  targetType: 'tenant' | 'user' | null;
  targetId: string | null;
  targetEmail: string | null;
  /** Safe, content-free details (names, counts, levels). Never tokens, secrets or workspace content. */
  meta: Record<string, string | number | boolean | null>;
}

/** What `/api/whoami` tells the signed-in person about themselves. */
export interface PrincipalDto {
  email: string;
  displayName: string | null;
  role: AppRole;
  /** null for a super admin (they have no tenant). */
  tenant: TenantDto | null;
  /** For users: editor or viewer. Admins are always editor. */
  access: UserAccess | null;
  /** The permission level the live workspace uses (derived server-side). null when there is no shared workspace for this person. */
  workspaceRole: Role | null;
  /** True when this person may open the shared workspace right now. */
  sharedWorkspace: boolean;
}

export type DenyReason = 'unregistered' | 'disabled' | 'tenant_inactive' | 'workspace_not_shared';

// ---- canonical content hash (migration verification) ----

/**
 * SHA-256 (hex) over the records sorted by (kind, id). Client and server
 * compute it over the same exact strings, so equal hashes mean the shared
 * workspace holds exactly what was uploaded / downloaded.
 */
export async function canonicalRecordsHash(records: ReadonlyArray<Pick<RecordPut, 'kind' | 'id' | 'json'>>): Promise<string> {
  const sorted = [...records].sort((a, b) => (a.kind === b.kind ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.kind < b.kind ? -1 : 1));
  const text = 'gc1\n' + sorted.map((r) => `${r.kind}\u0000${r.id}\u0000${r.json}\n`).join('');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- validation of an uploaded workspace ----

export const IMPORT_LIMITS = {
  maxRecords: 20_000,
  maxTotalChars: 20_000_000,
} as const;

export type ImportValidation = { ok: true; records: RecordPut[] } | { ok: false; error: string };

/**
 * Structural validation of a whole workspace upload. Domain-level checks stay
 * with the client's existing validators; this guarantees the server never
 * stores something it cannot read back: known kinds, unique keys, JSON objects
 * whose own `id` matches the key.
 */
export function validateImportRecords(raw: unknown): ImportValidation {
  if (!Array.isArray(raw)) return { ok: false, error: 'records must be an array' };
  if (raw.length > IMPORT_LIMITS.maxRecords) return { ok: false, error: 'too many records' };
  const seen = new Set<string>();
  const out: RecordPut[] = [];
  let total = 0;
  for (const item of raw as unknown[]) {
    if (typeof item !== 'object' || item === null) return { ok: false, error: 'record must be an object' };
    const r = item as Record<string, unknown>;
    if (!isRecordKind(r.kind)) return { ok: false, error: 'unknown record kind' };
    if (typeof r.id !== 'string' || r.id.length === 0 || r.id.length > LIMITS.maxIdChars) return { ok: false, error: 'invalid record id' };
    if (typeof r.json !== 'string' || r.json.length === 0) return { ok: false, error: 'invalid record json' };
    if (r.json.length > LIMITS.maxRecordChars) return { ok: false, error: 'record too large' };
    total += r.json.length;
    if (total > IMPORT_LIMITS.maxTotalChars) return { ok: false, error: 'workspace too large' };
    const key = `${r.kind}\u0000${r.id}`;
    if (seen.has(key)) return { ok: false, error: 'duplicate record' };
    seen.add(key);
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.json);
    } catch {
      return { ok: false, error: 'record json is not valid' };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, error: 'record must be a JSON object' };
    const kind = r.kind as RecordKind;
    if (kind === 'settings') {
      if (r.id !== 'settings') return { ok: false, error: 'settings record id must be "settings"' };
    } else if ((parsed as { id?: unknown }).id !== r.id) {
      return { ok: false, error: 'record id does not match its content' };
    }
    out.push({ kind, id: r.id, json: r.json });
  }
  return { ok: true, records: out };
}

/** Counts shown in migration screens. */
export function summarizeRecords(records: ReadonlyArray<{ kind: RecordKind }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of records) out[r.kind] = (out[r.kind] ?? 0) + 1;
  return out;
}

/** A workspace "has data" when it holds anything beyond the shared-settings record. */
export function recordsHaveData(records: ReadonlyArray<{ kind: RecordKind }>): boolean {
  return records.some((r) => r.kind !== 'settings');
}

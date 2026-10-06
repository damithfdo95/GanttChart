/**
 * RegistryStore — the control plane's data: tenants, users, deletion audit.
 *
 * It holds METADATA only (who exists, which tenant, role, status, storage mode,
 * deletion requests). It never holds QA content. Pure logic over a minimal SQL
 * interface, so the same code runs in the RegistryRoom Durable Object and in
 * unit tests against real SQLite.
 *
 * Invariants are enforced by the database where it can be (CHECK constraints,
 * UNIQUE email, exactly one admin per tenant) and by the methods otherwise:
 * every user operation is scoped by BOTH the user id and the tenant id, so a
 * user id belonging to another tenant is simply "not found".
 */

import {
  newTenantId,
  newUserId,
  isManagedEmail,
  normalizeEmail,
  normalizeTenantName,
  type DenyReason,
  type StorageMode,
  type TenantDto,
  type TenantStatus,
  type TenantSummaryDto,
  type UserAccess,
  type UserDto,
  type UserStatus,
} from '../../shared/tenancy';
import type { StoreStorage } from './store';

export interface TenantRow {
  id: string;
  name: string;
  storage_mode: StorageMode;
  status: TenantStatus;
  created_at: string;
  updated_at: string;
  deletion_requested_at: string | null;
  deletion_requested_by: string | null;
}

export interface UserRow {
  id: string;
  email: string;
  tenant_id: string;
  role: 'admin' | 'user';
  access: UserAccess;
  status: UserStatus;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  last_login_at: string | null;
}

export interface DeletionAuditRow {
  id: number;
  tenant_id: string;
  requested_by_email: string;
  requested_at: string;
  approved_by_email: string;
  approved_at: string;
  deleted_at: string | null;
  users_deleted: number;
}

export type RegistryError =
  | 'invalid_email'
  | 'invalid_name'
  | 'invalid_input'
  | 'email_taken'
  | 'email_reserved'
  /** The address is valid but not in a managed organisation domain. */
  | 'email_domain_not_allowed'
  /** The deployment lists no managed domain at all: nobody can be provisioned (fail closed). */
  | 'managed_domains_not_configured'
  | 'not_found'
  | 'wrong_mode'
  | 'tenant_inactive'
  | 'forbidden_target'
  | 'bad_state'
  | 'same_person';

export type Reg<T> = { ok: true; value: T } | { ok: false; error: RegistryError };

const fail = (error: RegistryError): { ok: false; error: RegistryError } => ({ ok: false, error });

/**
 * The managed-domain rule for registry-created Admins and Users. The Super
 * Admin identities are configuration, are never created here, and are exempt.
 */
function checkManagedDomain(normalizedEmail: string, managedDomains: readonly string[]): 'managed_domains_not_configured' | 'email_domain_not_allowed' | null {
  if (managedDomains.length === 0) return 'managed_domains_not_configured';
  return isManagedEmail(normalizedEmail, managedDomains) ? null : 'email_domain_not_allowed';
}
const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tenants (
     id                    TEXT PRIMARY KEY,
     name                  TEXT NOT NULL,
     storage_mode          TEXT NOT NULL CHECK (storage_mode IN ('local', 'web')),
     status                TEXT NOT NULL CHECK (status IN ('active', 'deactivated', 'deletion_requested', 'deleting')),
     created_at            TEXT NOT NULL,
     updated_at            TEXT NOT NULL,
     deletion_requested_at TEXT,
     deletion_requested_by TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS users (
     id            TEXT PRIMARY KEY,
     email         TEXT NOT NULL UNIQUE,
     tenant_id     TEXT NOT NULL REFERENCES tenants (id),
     role          TEXT NOT NULL CHECK (role IN ('admin', 'user')),
     access        TEXT NOT NULL CHECK (access IN ('editor', 'viewer')),
     status        TEXT NOT NULL CHECK (status IN ('invited', 'active', 'disabled')),
     created_at    TEXT NOT NULL,
     updated_at    TEXT NOT NULL,
     created_by    TEXT,
     last_login_at TEXT
   )`,
  // Exactly one Admin per tenant, enforced by the database.
  `CREATE UNIQUE INDEX IF NOT EXISTS users_one_admin_per_tenant ON users (tenant_id) WHERE role = 'admin'`,
  `CREATE INDEX IF NOT EXISTS users_by_tenant ON users (tenant_id)`,
  `CREATE TABLE IF NOT EXISTS deletion_audit (
     id                 INTEGER PRIMARY KEY AUTOINCREMENT,
     tenant_id          TEXT NOT NULL,
     requested_by_email TEXT NOT NULL,
     requested_at       TEXT NOT NULL,
     approved_by_email  TEXT NOT NULL,
     approved_at        TEXT NOT NULL,
     deleted_at         TEXT,
     users_deleted      INTEGER NOT NULL DEFAULT 0
   )`,
];

/** Refresh last_login_at at most this often (keeps writes to a minimum on the free plan). */
const LOGIN_REFRESH_MS = 12 * 60 * 60 * 1000;

export function toTenantDto(t: TenantRow): TenantDto {
  return {
    id: t.id,
    name: t.name,
    storageMode: t.storage_mode,
    status: t.status,
    createdAt: t.created_at,
    deletionRequestedAt: t.deletion_requested_at,
  };
}

export function toUserDto(u: UserRow): UserDto {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    access: u.access,
    status: u.status,
    createdAt: u.created_at,
    updatedAt: u.updated_at,
    lastLoginAt: u.last_login_at,
  };
}

/**
 * The access decision for a registered person. Pure: the single place that
 * says "this identity may (not) use the application", so it is tested once.
 */
export function decideAccess(user: UserRow, tenant: TenantRow): { allowed: true } | { allowed: false; reason: DenyReason } {
  if (user.status === 'disabled') return { allowed: false, reason: 'disabled' };
  if (tenant.status === 'deactivated' || tenant.status === 'deleting') return { allowed: false, reason: 'tenant_inactive' };
  // Collaboration is not active for a local-mode workspace: its users are refused.
  if (user.role === 'user' && tenant.storage_mode !== 'web') return { allowed: false, reason: 'workspace_not_shared' };
  return { allowed: true };
}

export type AuthResult =
  | { allowed: true; user: UserRow; tenant: TenantRow }
  | { allowed: false; reason: DenyReason };

export class RegistryStore {
  constructor(private readonly storage: StoreStorage) {}

  init(): void {
    for (const statement of SCHEMA) this.storage.sql.exec(statement);
  }

  // ---- reads ---------------------------------------------------------------

  getTenant(id: string): TenantRow | null {
    return this.storage.sql.exec<TenantRow & Record<string, string | number | null>>(`SELECT * FROM tenants WHERE id = ?`, id).toArray()[0] ?? null;
  }

  findUserByEmail(email: string): UserRow | null {
    const e = normalizeEmail(email);
    if (e === null) return null;
    return this.storage.sql.exec<UserRow & Record<string, string | number | null>>(`SELECT * FROM users WHERE email = ?`, e).toArray()[0] ?? null;
  }

  /** A user, only if they belong to this tenant (a foreign id is "not found"). */
  getUserInTenant(tenantId: string, userId: string): UserRow | null {
    return (
      this.storage.sql
        .exec<UserRow & Record<string, string | number | null>>(`SELECT * FROM users WHERE id = ? AND tenant_id = ?`, userId, tenantId)
        .toArray()[0] ?? null
    );
  }

  adminOf(tenantId: string): UserRow | null {
    return (
      this.storage.sql
        .exec<UserRow & Record<string, string | number | null>>(`SELECT * FROM users WHERE tenant_id = ? AND role = 'admin'`, tenantId)
        .toArray()[0] ?? null
    );
  }

  listUsers(tenantId: string): UserRow[] {
    return this.storage.sql
      .exec<UserRow & Record<string, string | number | null>>(`SELECT * FROM users WHERE tenant_id = ? ORDER BY role, email`, tenantId)
      .toArray();
  }

  /** Metadata for the Super Admin console. No workspace content exists here to leak. */
  listTenantSummaries(): TenantSummaryDto[] {
    const rows = this.storage.sql
      .exec<TenantRow & { admin_email: string | null; admin_status: UserStatus | null; user_count: number } & Record<string, string | number | null>>(
        `SELECT t.*, a.email AS admin_email, a.status AS admin_status,
                (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id) AS user_count
           FROM tenants t
           LEFT JOIN users a ON a.tenant_id = t.id AND a.role = 'admin'
          ORDER BY t.created_at, t.id`,
      )
      .toArray();
    // `adminOutsideManagedDomains` is filled in by the caller, which knows the configured domains.
    return rows.map((r) => ({ ...toTenantDto(r), adminEmail: r.admin_email ?? '', adminStatus: r.admin_status ?? 'disabled', userCount: r.user_count, adminOutsideManagedDomains: false }));
  }

  listAudit(): DeletionAuditRow[] {
    return this.storage.sql.exec<DeletionAuditRow & Record<string, string | number | null>>(`SELECT * FROM deletion_audit ORDER BY id`).toArray();
  }

  // ---- authentication (the registry half of "authenticated ≠ authorized") ---

  /**
   * Who is this verified email, and may they use the application? Records the
   * first sign-in (invited → active) and refreshes last_login_at at most
   * every 12 hours.
   */
  authenticate(rawEmail: string, now: string): AuthResult {
    const user = this.findUserByEmail(rawEmail);
    if (user === null) return { allowed: false, reason: 'unregistered' };
    const tenant = this.getTenant(user.tenant_id);
    if (tenant === null) return { allowed: false, reason: 'unregistered' }; // orphan row: fail closed
    const decision = decideAccess(user, tenant);
    if (!decision.allowed) return decision;

    const stale = user.last_login_at === null || Date.parse(now) - Date.parse(user.last_login_at) > LOGIN_REFRESH_MS;
    if (user.status === 'invited' || stale) {
      this.storage.sql.exec(
        `UPDATE users SET status = CASE WHEN status = 'invited' THEN 'active' ELSE status END, last_login_at = ?, updated_at = ? WHERE id = ?`,
        now,
        now,
        user.id,
      );
      return { allowed: true, user: { ...user, status: user.status === 'invited' ? 'active' : user.status, last_login_at: now, updated_at: now }, tenant };
    }
    return { allowed: true, user, tenant };
  }

  // ---- tenants (Super Admin) -----------------------------------------------

  /**
   * A new tenant with its single Admin. The tenant starts in LOCAL storage mode
   * (no cloud data exists until the Admin chooses to migrate). `reserved` are
   * emails that may not be used (the Super Admin list).
   */
  createTenantWithAdmin(input: { name: string; adminEmail: string; reserved: readonly string[]; managedDomains: readonly string[]; actorEmail: string; now: string }): Reg<{ tenant: TenantRow; admin: UserRow }> {
    const name = normalizeTenantName(input.name);
    if (name === null) return fail('invalid_name');
    const email = normalizeEmail(input.adminEmail);
    if (email === null) return fail('invalid_email');
    if (input.reserved.includes(email)) return fail('email_reserved');
    const domain = checkManagedDomain(email, input.managedDomains);
    if (domain !== null) return fail(domain);
    if (this.findUserByEmail(email) !== null) return fail('email_taken');

    return this.storage.transactionSync(() => {
      const tenantId = newTenantId();
      const adminId = newUserId();
      this.storage.sql.exec(
        `INSERT INTO tenants (id, name, storage_mode, status, created_at, updated_at) VALUES (?, ?, 'local', 'active', ?, ?)`,
        tenantId,
        name,
        input.now,
        input.now,
      );
      this.storage.sql.exec(
        `INSERT INTO users (id, email, tenant_id, role, access, status, created_at, updated_at, created_by) VALUES (?, ?, ?, 'admin', 'editor', 'invited', ?, ?, ?)`,
        adminId,
        email,
        tenantId,
        input.now,
        input.now,
        input.actorEmail,
      );
      return ok({ tenant: this.getTenant(tenantId)!, admin: this.getUserInTenant(tenantId, adminId)! });
    });
  }

  /** Super Admin only: switch a tenant between active and deactivated (never during a deletion). */
  setTenantStatus(tenantId: string, status: 'active' | 'deactivated', now: string): Reg<TenantRow> {
    const tenant = this.getTenant(tenantId);
    if (tenant === null) return fail('not_found');
    if (tenant.status !== 'active' && tenant.status !== 'deactivated') return fail('bad_state');
    this.storage.sql.exec(`UPDATE tenants SET status = ?, updated_at = ? WHERE id = ?`, status, now, tenantId);
    return ok(this.getTenant(tenantId)!);
  }

  renameTenant(tenantId: string, rawName: string, now: string): Reg<TenantRow> {
    const name = normalizeTenantName(rawName);
    if (name === null) return fail('invalid_name');
    if (this.getTenant(tenantId) === null) return fail('not_found');
    this.storage.sql.exec(`UPDATE tenants SET name = ?, updated_at = ? WHERE id = ?`, name, now, tenantId);
    return ok(this.getTenant(tenantId)!);
  }

  /** Only an active tenant can change mode (not while deactivated or being deleted). */
  setStorageMode(tenantId: string, mode: StorageMode, now: string): Reg<TenantRow> {
    const tenant = this.getTenant(tenantId);
    if (tenant === null) return fail('not_found');
    if (tenant.status !== 'active') return fail('tenant_inactive');
    this.storage.sql.exec(`UPDATE tenants SET storage_mode = ?, updated_at = ? WHERE id = ?`, mode, now, tenantId);
    return ok(this.getTenant(tenantId)!);
  }

  // ---- users (the tenant's Admin) --------------------------------------------

  /**
   * Add a subordinate user. Only a WEB-mode, active tenant can have users; the
   * tenant comes from the caller's verified principal, never from request data.
   */
  createUser(input: { tenantId: string; email: string; access: UserAccess; reserved: readonly string[]; managedDomains: readonly string[]; actorUserId: string; now: string }): Reg<UserRow> {
    const tenant = this.getTenant(input.tenantId);
    if (tenant === null) return fail('not_found');
    if (tenant.status !== 'active') return fail('tenant_inactive');
    if (tenant.storage_mode !== 'web') return fail('wrong_mode');
    if (input.access !== 'editor' && input.access !== 'viewer') return fail('invalid_input');
    const email = normalizeEmail(input.email);
    if (email === null) return fail('invalid_email');
    if (input.reserved.includes(email)) return fail('email_reserved');
    const domain = checkManagedDomain(email, input.managedDomains);
    if (domain !== null) return fail(domain);
    if (this.findUserByEmail(email) !== null) return fail('email_taken');
    const id = newUserId();
    this.storage.sql.exec(
      `INSERT INTO users (id, email, tenant_id, role, access, status, created_at, updated_at, created_by) VALUES (?, ?, ?, 'user', ?, 'invited', ?, ?, ?)`,
      id,
      email,
      input.tenantId,
      input.access,
      input.now,
      input.now,
      input.actorUserId,
    );
    return ok(this.getUserInTenant(input.tenantId, id)!);
  }

  /**
   * Change a subordinate user. Scoped by tenant AND user id; the Admin row can
   * never be changed this way; re-enabling restores 'invited' until the first
   * sign-in has happened.
   */
  updateUser(input: { tenantId: string; userId: string; status?: 'enabled' | 'disabled'; access?: UserAccess; now: string }): Reg<UserRow> {
    const user = this.getUserInTenant(input.tenantId, input.userId);
    if (user === null) return fail('not_found');
    if (user.role !== 'user') return fail('forbidden_target');
    if (input.access !== undefined && input.access !== 'editor' && input.access !== 'viewer') return fail('invalid_input');
    if (input.status !== undefined && input.status !== 'enabled' && input.status !== 'disabled') return fail('invalid_input');
    const nextStatus: UserStatus = input.status === undefined ? user.status : input.status === 'disabled' ? 'disabled' : user.last_login_at === null ? 'invited' : 'active';
    this.storage.sql.exec(
      `UPDATE users SET status = ?, access = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`,
      nextStatus,
      input.access ?? user.access,
      input.now,
      input.userId,
      input.tenantId,
    );
    return ok(this.getUserInTenant(input.tenantId, input.userId)!);
  }

  // ---- deletion workflow ---------------------------------------------------

  /** The tenant's Admin asks for permanent deletion. Nothing is deleted. */
  requestDeletion(input: { tenantId: string; requestedByUserId: string; now: string }): Reg<TenantRow> {
    const tenant = this.getTenant(input.tenantId);
    if (tenant === null) return fail('not_found');
    const admin = this.adminOf(input.tenantId);
    if (admin === null || admin.id !== input.requestedByUserId) return fail('forbidden_target');
    if (tenant.status !== 'active') return fail('bad_state');
    this.storage.sql.exec(
      `UPDATE tenants SET status = 'deletion_requested', deletion_requested_at = ?, deletion_requested_by = ?, updated_at = ? WHERE id = ?`,
      input.now,
      input.requestedByUserId,
      input.now,
      input.tenantId,
    );
    return ok(this.getTenant(input.tenantId)!);
  }

  cancelDeletion(input: { tenantId: string; requestedByUserId: string; now: string }): Reg<TenantRow> {
    const tenant = this.getTenant(input.tenantId);
    if (tenant === null) return fail('not_found');
    const admin = this.adminOf(input.tenantId);
    if (admin === null || admin.id !== input.requestedByUserId) return fail('forbidden_target');
    if (tenant.status !== 'deletion_requested') return fail('bad_state');
    this.storage.sql.exec(
      `UPDATE tenants SET status = 'active', deletion_requested_at = NULL, deletion_requested_by = NULL, updated_at = ? WHERE id = ?`,
      input.now,
      input.tenantId,
    );
    return ok(this.getTenant(input.tenantId)!);
  }

  /**
   * Step 1 of an approved deletion: the Super Admin has confirmed. All access
   * to the tenant stops at once ('deleting'). Repeating it for a tenant that
   * is already 'deleting' is allowed (retry after a partial failure). The
   * approver can never be the person who requested it.
   */
  beginDeletion(input: { tenantId: string; approverEmail: string; now: string }): Reg<{ tenant: TenantRow; requesterEmail: string }> {
    const tenant = this.getTenant(input.tenantId);
    if (tenant === null) return fail('not_found');
    if (tenant.status !== 'deletion_requested' && tenant.status !== 'deleting') return fail('bad_state');
    const requester = tenant.deletion_requested_by === null ? null : this.getUserInTenant(input.tenantId, tenant.deletion_requested_by);
    const approver = normalizeEmail(input.approverEmail);
    if (approver === null) return fail('invalid_email');
    if (requester !== null && requester.email === approver) return fail('same_person');
    if (tenant.status === 'deletion_requested') {
      this.storage.sql.exec(`UPDATE tenants SET status = 'deleting', updated_at = ? WHERE id = ?`, input.now, input.tenantId);
    }
    return ok({ tenant: this.getTenant(input.tenantId)!, requesterEmail: requester?.email ?? '' });
  }

  /**
   * Step 2: after the workspace data is gone, remove every user and the tenant
   * in ONE transaction and keep a minimal audit row (identities and timestamps
   * only — never workspace content).
   */
  finishDeletion(input: { tenantId: string; approverEmail: string; requesterEmail: string; now: string }): Reg<{ usersDeleted: number }> {
    const tenant = this.getTenant(input.tenantId);
    if (tenant === null) return fail('not_found');
    if (tenant.status !== 'deleting') return fail('bad_state');
    const approver = normalizeEmail(input.approverEmail);
    if (approver === null) return fail('invalid_email');
    return this.storage.transactionSync(() => {
      const count = this.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE tenant_id = ?`, input.tenantId).one().n;
      this.storage.sql.exec(`DELETE FROM users WHERE tenant_id = ?`, input.tenantId);
      this.storage.sql.exec(`DELETE FROM tenants WHERE id = ?`, input.tenantId);
      this.storage.sql.exec(
        `INSERT INTO deletion_audit (tenant_id, requested_by_email, requested_at, approved_by_email, approved_at, deleted_at, users_deleted) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        input.tenantId,
        input.requesterEmail,
        tenant.deletion_requested_at ?? input.now,
        approver,
        input.now,
        input.now,
        count,
      );
      return ok({ usersDeleted: count });
    });
  }
}

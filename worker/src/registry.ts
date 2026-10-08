/**
 * RegistryStore — the control plane's data: tenants, users, deletion audit.
 *
 * It holds METADATA only (who exists, which tenant, role, status, storage mode,
 * deletion requests). It never holds QA content. Pure logic over a minimal SQL
 * interface, so the same code runs in the RegistryRoom Durable Object and in
 * unit tests against real SQLite.
 *
 * Invariants are enforced by the database where it can be (CHECK constraints,
 * UNIQUE email, exactly one OWNER per tenant, any number of SVs) and by the methods otherwise:
 * every user operation is scoped by BOTH the user id and the tenant id, so a
 * user id belonging to another tenant is simply "not found".
 */

import { nextTenantState, tenantAllowsAccess, userLifecycle } from '../../shared/lifecycle';
import {
  newTenantId,
  newUserId,
  PLATFORM_AUDIT_ACTIONS,
  isManagedEmail,
  normalizeEmail,
  normalizeTenantName,
  parseDisplayName,
  type AdminAuditDto,
  type AuditAction,
  type AuditActor,
  type DenyReason,
  type TenantListQuery,
  type TesterDto,
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
  /** The Owner SV (Stage 8B). Null only for a legacy row that has no admin at all. */
  owner_user_id: string | null;
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
  display_name: string | null;
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
  | 'invalid_display_name'
  | 'invalid_input'
  | 'email_taken'
  /** Creating a Tester: the address already belongs to a DIFFERENT workspace. It is never moved or duplicated. */
  | 'email_in_other_workspace'
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
  | 'same_person'
  /** The Owner SV cannot be disabled, removed or demoted; ownership must be transferred first. */
  | 'owner_protected';

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
  // Administrative audit trail (Stage 7): who did what to which account/workspace. Content-free, append-only
  // (the triggers make UPDATE and DELETE impossible, even for code in this Worker).
  `CREATE TABLE IF NOT EXISTS admin_audit (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     at            TEXT NOT NULL,
     action        TEXT NOT NULL,
     actor_user_id TEXT,
     actor_email   TEXT NOT NULL,
     actor_role    TEXT NOT NULL CHECK (actor_role IN ('super_admin', 'admin', 'user')),
     tenant_id     TEXT,
     target_type   TEXT CHECK (target_type IN ('tenant', 'user')),
     target_id     TEXT,
     target_email  TEXT,
     meta          TEXT NOT NULL DEFAULT '{}'
   )`,
  `CREATE INDEX IF NOT EXISTS admin_audit_by_tenant ON admin_audit (tenant_id, id)`,
  `CREATE TRIGGER IF NOT EXISTS admin_audit_no_update BEFORE UPDATE ON admin_audit BEGIN SELECT RAISE(ABORT, 'admin_audit is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS admin_audit_no_delete BEFORE DELETE ON admin_audit BEGIN SELECT RAISE(ABORT, 'admin_audit is append-only'); END`,
];

/** Columns added after the first release. Added in place, so an existing registry upgrades itself on first start. */
const ADDED_COLUMNS: ReadonlyArray<{ table: string; column: string; ddl: string }> = [
  { table: 'users', column: 'display_name', ddl: 'TEXT' },
  { table: 'tenants', column: 'owner_user_id', ddl: 'TEXT' },
];

/**
 * Stage 8B. A tenant may have several SVs (internal role 'admin') and exactly one OWNER (`tenants.owner_user_id`).
 * Applied on every start and idempotent: the old one-admin-per-tenant index is dropped, an existing tenant's single
 * Admin becomes its Owner, and the database itself refuses to disable, demote or move the Owner or to point the
 * ownership at anyone who is not an enabled SV of that same tenant.
 */
const OWNER_SCHEMA = [
  `DROP INDEX IF EXISTS users_one_admin_per_tenant`,
  `UPDATE tenants SET owner_user_id = (SELECT u.id FROM users u WHERE u.tenant_id = tenants.id AND u.role = 'admin' AND u.status <> 'disabled' ORDER BY u.created_at, u.id LIMIT 1) WHERE owner_user_id IS NULL`,
  `CREATE TRIGGER IF NOT EXISTS users_owner_guard BEFORE UPDATE OF role, status, tenant_id ON users
     WHEN OLD.id IN (SELECT owner_user_id FROM tenants WHERE id = OLD.tenant_id) AND (NEW.role <> 'admin' OR NEW.status = 'disabled' OR NEW.tenant_id <> OLD.tenant_id)
     BEGIN SELECT RAISE(ABORT, 'the owner cannot be disabled, demoted or moved'); END`,
  `CREATE TRIGGER IF NOT EXISTS tenants_owner_valid BEFORE UPDATE OF owner_user_id ON tenants
     WHEN NEW.owner_user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.owner_user_id AND tenant_id = NEW.id AND role = 'admin' AND status <> 'disabled')
     BEGIN SELECT RAISE(ABORT, 'the owner must be an enabled SV of the same workspace'); END`,
  `CREATE TRIGGER IF NOT EXISTS tenants_owner_not_cleared BEFORE UPDATE OF owner_user_id ON tenants
     WHEN OLD.owner_user_id IS NOT NULL AND NEW.owner_user_id IS NULL
     BEGIN SELECT RAISE(ABORT, 'a workspace always has an owner'); END`,
];

const AUDIT_ROW_LIMIT = 200;
const META_MAX_CHARS = 1000;

interface AuditRow {
  id: number;
  at: string;
  action: AuditAction;
  actor_user_id: string | null;
  actor_email: string;
  actor_role: 'super_admin' | 'admin' | 'user';
  tenant_id: string | null;
  target_type: 'tenant' | 'user' | null;
  target_id: string | null;
  target_email: string | null;
  meta: string;
}

type AuditMeta = Record<string, string | number | boolean | null>;

function toAuditDto(r: AuditRow): AdminAuditDto {
  let meta: AuditMeta = {};
  try {
    const parsed: unknown = JSON.parse(r.meta);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) meta = parsed as AuditMeta;
  } catch {
    /* unreadable meta is shown as empty */
  }
  return {
    id: r.id,
    at: r.at,
    action: r.action,
    actorEmail: r.actor_email,
    actorRole: r.actor_role,
    tenantId: r.tenant_id,
    targetType: r.target_type,
    targetId: r.target_id,
    targetEmail: r.target_email,
    meta,
  };
}

/** Escape LIKE wildcards so a search for "100%" or "a_b" means exactly that. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`).toLowerCase()}%`;
}

const TENANT_SORT: Readonly<Record<NonNullable<TenantListQuery['sort']>, string>> = {
  name: 'LOWER(t.name)',
  created: 't.created_at',
  admin: 'LOWER(COALESCE(a.email, \'\'))',
  activity: 'last_activity',
  status: 't.status',
  accounts: 'user_count',
};

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

export function toUserDto(u: UserRow, ownerUserId: string | null = null): UserDto {
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name ?? null,
    role: u.role,
    isOwner: ownerUserId !== null && u.id === ownerUserId,
    access: u.access,
    status: userLifecycle(u.status),
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
  if (!tenantAllowsAccess(tenant.status)) return { allowed: false, reason: 'tenant_inactive' };
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
    for (const { table, column, ddl } of ADDED_COLUMNS) {
      const have = this.storage.sql.exec<{ name: string } & Record<string, string | number | null>>(`PRAGMA table_info(${table})`).toArray();
      if (!have.some((c) => c.name === column)) this.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
    for (const statement of OWNER_SCHEMA) this.storage.sql.exec(statement);
  }

  // ---- administrative audit trail -----------------------------------------

  /**
   * Append one audit entry. There is no way to change or remove one afterwards. `meta` may hold only
   * short, content-free values (names, counts, levels): anything else is dropped.
   */
  appendAudit(entry: {
    at: string;
    action: AuditAction;
    actor: AuditActor;
    tenantId?: string | null;
    targetType?: 'tenant' | 'user';
    targetId?: string | null;
    targetEmail?: string | null;
    meta?: AuditMeta;
  }): void {
    const clean: AuditMeta = {};
    for (const [k, v] of Object.entries(entry.meta ?? {})) {
      if (typeof v === 'string') clean[k] = v.slice(0, 200);
      else if (typeof v === 'number' || typeof v === 'boolean' || v === null) clean[k] = v;
    }
    let meta = JSON.stringify(clean);
    if (meta.length > META_MAX_CHARS) meta = '{}';
    this.storage.sql.exec(
      `INSERT INTO admin_audit (at, action, actor_user_id, actor_email, actor_role, tenant_id, target_type, target_id, target_email, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.at,
      entry.action,
      entry.actor.userId,
      entry.actor.email,
      entry.actor.role,
      entry.tenantId ?? null,
      entry.targetType ?? null,
      entry.targetId ?? null,
      entry.targetEmail ?? null,
      meta,
    );
  }

  /**
   * The audit entries one reader may see. Platform scope: workspace-level events only (no account events inside a
   * workspace). Tenant scope: that workspace's own events, selected by the tenant id the SERVER derived.
   */
  listAdminAudit(scope: { kind: 'platform' } | { kind: 'tenant'; tenantId: string }, limit = 100, beforeId?: number): AdminAuditDto[] {
    const take = Math.min(AUDIT_ROW_LIMIT, Math.max(1, Math.floor(limit)));
    const before = beforeId === undefined ? Number.MAX_SAFE_INTEGER : beforeId;
    const rows =
      scope.kind === 'platform'
        ? this.storage.sql
            .exec<AuditRow & Record<string, string | number | null>>(
              `SELECT * FROM admin_audit WHERE id < ? AND action IN (${PLATFORM_AUDIT_ACTIONS.map(() => '?').join(',')}) ORDER BY id DESC LIMIT ?`,
              before,
              ...PLATFORM_AUDIT_ACTIONS,
              take,
            )
            .toArray()
        : this.storage.sql
            .exec<AuditRow & Record<string, string | number | null>>(`SELECT * FROM admin_audit WHERE id < ? AND tenant_id = ? ORDER BY id DESC LIMIT ?`, before, scope.tenantId, take)
            .toArray();
    return rows.map(toAuditDto);
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

  /** The Owner SV of a workspace (null for a workspace that has none). */
  ownerOf(tenantId: string): UserRow | null {
    return (
      this.storage.sql
        .exec<UserRow & Record<string, string | number | null>>(`SELECT u.* FROM users u JOIN tenants t ON t.owner_user_id = u.id AND t.id = u.tenant_id WHERE t.id = ?`, tenantId)
        .toArray()[0] ?? null
    );
  }

  /** Kept for callers that mean "the person who administers the workspace": that is the Owner SV. */
  adminOf(tenantId: string): UserRow | null {
    return this.ownerOf(tenantId);
  }

  ownerIdOf(tenantId: string): string | null {
    return this.getTenant(tenantId)?.owner_user_id ?? null;
  }

  listUsers(tenantId: string): UserRow[] {
    return this.storage.sql
      .exec<UserRow & Record<string, string | number | null>>(`SELECT * FROM users WHERE tenant_id = ? ORDER BY role, email`, tenantId)
      .toArray();
  }

  /** The Tester accounts of one workspace (never an Admin), for the roster. */
  listTesters(tenantId: string): TesterDto[] {
    return this.storage.sql
      .exec<UserRow & Record<string, string | number | null>>(`SELECT * FROM users WHERE tenant_id = ? AND role = 'user' ORDER BY COALESCE(display_name, email), email`, tenantId)
      .toArray()
      .map((u) => ({ id: u.id, email: u.email, displayName: u.display_name ?? null, status: userLifecycle(u.status) }));
  }

  /** One Tester account of THIS workspace, or null (another workspace's account, an Admin and an unknown id are all "not found"). */
  getTester(tenantId: string, userId: string): TesterDto | null {
    const u = this.getUserInTenant(tenantId, userId);
    if (u === null || u.role !== 'user') return null;
    return { id: u.id, email: u.email, displayName: u.display_name ?? null, status: userLifecycle(u.status) };
  }

  /**
   * Metadata for the Super Admin console, filtered, sorted and paged ON THE SERVER so the list scales. No workspace
   * content exists here to leak.
   */
  listTenantSummaries(query: TenantListQuery = {}): { rows: TenantSummaryDto[]; total: number } {
    const where: string[] = [];
    const args: Array<string | number> = [];
    const q = (query.q ?? '').normalize('NFKC').trim().slice(0, 100);
    if (q !== '') {
      const like = likePattern(q);
      where.push(
        `(LOWER(t.name) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(a.email, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(a.display_name, '')) LIKE ? ESCAPE '\\' OR LOWER(t.id) LIKE ? ESCAPE '\\')`,
      );
      args.push(like, like, like, like);
    }
    const status = query.status === 'disabled' ? 'deactivated' : query.status;
    if (status !== undefined && status !== 'all') {
      where.push('t.status = ?');
      args.push(status);
    }
    if (query.mode !== undefined && query.mode !== 'all') {
      where.push('t.storage_mode = ?');
      args.push(query.mode);
    }
    const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;
    const sortColumn = TENANT_SORT[query.sort ?? 'created'] ?? TENANT_SORT.created;
    const dir = query.dir === 'desc' ? 'DESC' : 'ASC';
    const limit = Math.min(200, Math.max(1, Math.floor(query.limit ?? 100)));
    const offset = Math.max(0, Math.floor(query.offset ?? 0));

    const total = this.storage.sql
      .exec<{ n: number } & Record<string, number>>(`SELECT COUNT(*) AS n FROM tenants t LEFT JOIN users a ON a.id = t.owner_user_id AND a.tenant_id = t.id ${clause}`, ...args)
      .one().n;
    const rows = this.storage.sql
      .exec<
        TenantRow & { admin_email: string | null; admin_display_name: string | null; admin_status: UserStatus | null; user_count: number; last_activity: string | null } & Record<string, string | number | null>
      >(
        `SELECT t.*, a.email AS admin_email, a.display_name AS admin_display_name, a.status AS admin_status,
                (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id) AS user_count,
                (SELECT MAX(u.last_login_at) FROM users u WHERE u.tenant_id = t.id) AS last_activity
           FROM tenants t
           LEFT JOIN users a ON a.id = t.owner_user_id AND a.tenant_id = t.id
           ${clause}
          ORDER BY ${sortColumn} ${dir}, t.id
          LIMIT ? OFFSET ?`,
        ...args,
        limit,
        offset,
      )
      .toArray();
    return {
      total,
      // `adminOutsideManagedDomains` is filled in by the caller, which knows the configured domains.
      rows: rows.map((r) => ({
        ...toTenantDto(r),
        adminEmail: r.admin_email ?? '',
        adminDisplayName: r.admin_display_name ?? null,
        adminStatus: userLifecycle(r.admin_status ?? 'disabled'),
        userCount: r.user_count,
        lastActivityAt: r.last_activity,
        adminOutsideManagedDomains: false,
      })),
    };
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
   * emails that may not be used (the Super Admin list). The workspace, the Admin and the audit entry are
   * written in ONE transaction: either all exist or none does.
   */
  createTenantWithAdmin(input: {
    name: string;
    adminEmail: string;
    displayName?: unknown;
    reserved: readonly string[];
    managedDomains: readonly string[];
    actorEmail: string;
    now: string;
  }): Reg<{ tenant: TenantRow; admin: UserRow }> {
    const name = normalizeTenantName(input.name);
    if (name === null) return fail('invalid_name');
    const email = normalizeEmail(input.adminEmail);
    if (email === null) return fail('invalid_email');
    const display = parseDisplayName(input.displayName);
    if (!display.ok) return fail('invalid_display_name');
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
        `INSERT INTO users (id, email, display_name, tenant_id, role, access, status, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, 'admin', 'editor', 'active', ?, ?, ?)`,
        adminId,
        email,
        display.value,
        tenantId,
        input.now,
        input.now,
        input.actorEmail,
      );
      // The first SV of a workspace is its Owner.
      this.storage.sql.exec(`UPDATE tenants SET owner_user_id = ? WHERE id = ?`, adminId, tenantId);
      this.appendAudit({
        at: input.now,
        action: 'admin.created',
        actor: { userId: null, email: input.actorEmail, role: 'super_admin' },
        tenantId,
        targetType: 'user',
        targetId: adminId,
        targetEmail: email,
        meta: { workspaceName: name },
      });
      return ok({ tenant: this.getTenant(tenantId)!, admin: this.getUserInTenant(tenantId, adminId)! });
    });
  }

  /** Super Admin only: disable or reactivate a workspace (never during a deletion). Data is untouched either way. */
  setTenantStatus(tenantId: string, status: 'active' | 'deactivated', actorEmail: string, now: string): Reg<TenantRow> {
    const tenant = this.getTenant(tenantId);
    if (tenant === null) return fail('not_found');
    const event = status === 'deactivated' ? 'disable' : 'reactivate';
    const next = nextTenantState(tenant.status, event);
    if (next === null || next === 'removed') return fail('bad_state');
    return this.storage.transactionSync(() => {
      this.storage.sql.exec(`UPDATE tenants SET status = ?, updated_at = ? WHERE id = ?`, next, now, tenantId);
      this.appendAudit({
        at: now,
        action: event === 'disable' ? 'tenant.disabled' : 'tenant.reactivated',
        actor: { userId: null, email: actorEmail, role: 'super_admin' },
        tenantId,
        targetType: 'tenant',
        targetId: tenantId,
        meta: { workspaceName: tenant.name },
      });
      return ok(this.getTenant(tenantId)!);
    });
  }

  renameTenant(tenantId: string, rawName: string, now: string): Reg<TenantRow> {
    const name = normalizeTenantName(rawName);
    if (name === null) return fail('invalid_name');
    if (this.getTenant(tenantId) === null) return fail('not_found');
    this.storage.sql.exec(`UPDATE tenants SET name = ?, updated_at = ? WHERE id = ?`, name, now, tenantId);
    return ok(this.getTenant(tenantId)!);
  }

  /** Only an active tenant can change mode (not while disabled or being deleted). */
  setStorageMode(tenantId: string, mode: StorageMode, actor: AuditActor, now: string): Reg<TenantRow> {
    const tenant = this.getTenant(tenantId);
    if (tenant === null) return fail('not_found');
    if (tenant.status !== 'active') return fail('tenant_inactive');
    return this.storage.transactionSync(() => {
      this.storage.sql.exec(`UPDATE tenants SET storage_mode = ?, updated_at = ? WHERE id = ?`, mode, now, tenantId);
      this.appendAudit({
        at: now,
        action: mode === 'web' ? 'storage.web_activated' : 'storage.local_activated',
        actor,
        tenantId,
        targetType: 'tenant',
        targetId: tenantId,
        meta: { from: tenant.storage_mode, to: mode },
      });
      return ok(this.getTenant(tenantId)!);
    });
  }

  // ---- Team Members (managed by the workspace's SVs) --------------------------------

  /**
   * Add a Team Member: a Tester or another SV. Only a WEB-mode, active tenant can have members; the
   * tenant comes from the caller's verified principal, never from request data.
   * The new account is `active` at once: nobody is invited by email, so there is no pending state.
   */
  createUser(input: {
    tenantId: string;
    email: string;
    displayName?: unknown;
    /** 'admin' = SV, 'user' = Tester. */
    role?: 'admin' | 'user';
    access: UserAccess;
    reserved: readonly string[];
    managedDomains: readonly string[];
    actor: AuditActor;
    now: string;
  }): Reg<UserRow> {
    const tenant = this.getTenant(input.tenantId);
    if (tenant === null) return fail('not_found');
    if (tenant.status !== 'active') return fail('tenant_inactive');
    if (tenant.storage_mode !== 'web') return fail('wrong_mode');
    const role = input.role ?? 'user';
    if (role !== 'admin' && role !== 'user') return fail('invalid_input');
    if (input.access !== 'editor' && input.access !== 'viewer') return fail('invalid_input');
    // An SV always works with full rights; the editor/viewer level is a Tester setting.
    const access: UserAccess = role === 'admin' ? 'editor' : input.access;
    const email = normalizeEmail(input.email);
    if (email === null) return fail('invalid_email');
    const display = parseDisplayName(input.displayName);
    if (!display.ok) return fail('invalid_display_name');
    if (input.reserved.includes(email)) return fail('email_reserved');
    const domain = checkManagedDomain(email, input.managedDomains);
    if (domain !== null) return fail(domain);
    const existing = this.findUserByEmail(email);
    if (existing !== null) return fail(existing.tenant_id === input.tenantId ? 'email_taken' : 'email_in_other_workspace');
    return this.storage.transactionSync(() => {
      const id = newUserId();
      this.storage.sql.exec(
        `INSERT INTO users (id, email, display_name, tenant_id, role, access, status, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        id,
        email,
        display.value,
        input.tenantId,
        role,
        access,
        input.now,
        input.now,
        input.actor.userId,
      );
      this.appendAudit({
        at: input.now,
        action: 'user.created',
        actor: input.actor,
        tenantId: input.tenantId,
        targetType: 'user',
        targetId: id,
        targetEmail: email,
        meta: { access, memberRole: role === 'admin' ? 'sv' : 'tester' },
      });
      return ok(this.getUserInTenant(input.tenantId, id)!);
    });
  }

  /**
   * Change a Team Member. Scoped by tenant AND user id. The Owner SV can never be changed this way, nobody can
   * disable themselves, and the editor/viewer level belongs to Testers only. Disabling keeps the account, its
   * history and its attribution; reactivating restores access.
   */
  updateUser(input: { tenantId: string; userId: string; status?: 'enabled' | 'disabled'; access?: UserAccess; actor: AuditActor; now: string }): Reg<UserRow> {
    const user = this.getUserInTenant(input.tenantId, input.userId);
    if (user === null) return fail('not_found');
    if (user.id === this.ownerIdOf(input.tenantId)) return fail('owner_protected');
    if (input.actor.userId !== null && input.actor.userId === user.id) return fail('same_person');
    if (user.role === 'admin' && input.access !== undefined) return fail('forbidden_target');
    if (input.access !== undefined && input.access !== 'editor' && input.access !== 'viewer') return fail('invalid_input');
    if (input.status !== undefined && input.status !== 'enabled' && input.status !== 'disabled') return fail('invalid_input');
    const nextStatus: UserStatus = input.status === undefined ? user.status : input.status === 'disabled' ? 'disabled' : 'active';
    return this.storage.transactionSync(() => {
      this.storage.sql.exec(
        `UPDATE users SET status = ?, access = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`,
        nextStatus,
        input.access ?? user.access,
        input.now,
        input.userId,
        input.tenantId,
      );
      const base = { at: input.now, actor: input.actor, tenantId: input.tenantId, targetType: 'user' as const, targetId: user.id, targetEmail: user.email };
      if (input.status !== undefined && userLifecycle(user.status) !== userLifecycle(nextStatus)) {
        this.appendAudit({ ...base, action: nextStatus === 'disabled' ? 'user.disabled' : 'user.reactivated' });
      }
      if (input.access !== undefined && input.access !== user.access) this.appendAudit({ ...base, action: 'user.access_changed', meta: { from: user.access, to: input.access } });
      return ok(this.getUserInTenant(input.tenantId, input.userId)!);
    });
  }

  /**
   * Change an account's role: SV <-> Tester (Stage 8D). Scoped by tenant AND user id. The Owner SV is protected (the database
   * trigger refuses it too), nobody changes their own role, and the internal roles stay `admin` (SV) / `user` (Tester). A demoted SV
   * becomes an editor Tester; history written under the old role is never rewritten. The caller closes the person's live connections
   * so the next one is authorised as the new role.
   */
  changeRole(input: { tenantId: string; userId: string; role: 'admin' | 'user'; actor: AuditActor; now: string }): Reg<UserRow> {
    if (input.role !== 'admin' && input.role !== 'user') return fail('invalid_input');
    const user = this.getUserInTenant(input.tenantId, input.userId);
    if (user === null) return fail('not_found');
    if (user.id === this.ownerIdOf(input.tenantId)) return fail('owner_protected');
    if (input.actor.userId !== null && input.actor.userId === user.id) return fail('same_person');
    if (user.role === input.role) return ok(user);
    return this.storage.transactionSync(() => {
      this.storage.sql.exec(`UPDATE users SET role = ?, access = 'editor', updated_at = ? WHERE id = ? AND tenant_id = ?`, input.role, input.now, input.userId, input.tenantId);
      this.appendAudit({
        at: input.now,
        action: 'member.role_changed',
        actor: input.actor,
        tenantId: input.tenantId,
        targetType: 'user',
        targetId: user.id,
        targetEmail: user.email,
        meta: { from: user.role === 'admin' ? 'sv' : 'tester', to: input.role === 'admin' ? 'sv' : 'tester' },
      });
      return ok(this.getUserInTenant(input.tenantId, input.userId)!);
    });
  }

  /**
   * A Team Member event that happens in the workspace (profile created / edited / removed / reactivated, account linked). Only the
   * Worker calls this, with the actor from its verified principal; the tenant is the caller's. Content-free: names, counts, levels.
   */
  recordMemberEvent(input: {
    tenantId: string;
    action: Extract<AuditAction, `member.${string}`>;
    actor: AuditActor;
    userId?: string | null;
    meta?: Record<string, string | number | boolean | null>;
    now: string;
  }): void {
    const user = input.userId === undefined || input.userId === null ? null : this.getUserInTenant(input.tenantId, input.userId);
    this.appendAudit({
      at: input.now,
      action: input.action,
      actor: input.actor,
      tenantId: input.tenantId,
      ...(user === null ? {} : { targetType: 'user' as const, targetId: user.id, targetEmail: user.email }),
      meta: input.meta,
    });
  }

  /**
   * Hand the ownership to another enabled SV of the same workspace. ONE statement on ONE row: there is no moment
   * with zero or two owners, and the database refuses a target that is not an enabled SV of this workspace. Only the
   * current Owner may do it.
   */
  transferOwnership(input: { tenantId: string; actor: AuditActor; toUserId: string; now: string }): Reg<{ owner: UserRow; previous: UserRow }> {
    const tenant = this.getTenant(input.tenantId);
    if (tenant === null) return fail('not_found');
    if (tenant.status !== 'active') return fail('tenant_inactive');
    const current = this.ownerOf(input.tenantId);
    if (current === null || input.actor.userId !== current.id) return fail('forbidden_target');
    const target = this.getUserInTenant(input.tenantId, input.toUserId);
    if (target === null) return fail('not_found');
    if (target.id === current.id) return fail('bad_state');
    if (target.role !== 'admin' || target.status === 'disabled') return fail('forbidden_target');
    return this.storage.transactionSync(() => {
      this.storage.sql.exec(`UPDATE tenants SET owner_user_id = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?`, target.id, input.now, input.tenantId, current.id);
      this.appendAudit({
        at: input.now,
        action: 'owner.transferred',
        actor: input.actor,
        tenantId: input.tenantId,
        targetType: 'user',
        targetId: target.id,
        targetEmail: target.email,
        meta: { from: current.email, to: target.email },
      });
      return ok({ owner: this.getUserInTenant(input.tenantId, target.id)!, previous: this.getUserInTenant(input.tenantId, current.id)! });
    });
  }

  // ---- deletion workflow ---------------------------------------------------

  /** The Owner SV asks for permanent deletion. Nothing is deleted. */
  requestDeletion(input: { tenantId: string; requestedByUserId: string; now: string }): Reg<TenantRow> {
    const tenant = this.getTenant(input.tenantId);
    if (tenant === null) return fail('not_found');
    const admin = this.adminOf(input.tenantId);
    if (admin === null || admin.id !== input.requestedByUserId) return fail('forbidden_target');
    if (nextTenantState(tenant.status, 'requestDeletion') === null) return fail('bad_state');
    return this.storage.transactionSync(() => {
      this.storage.sql.exec(
        `UPDATE tenants SET status = 'deletion_requested', deletion_requested_at = ?, deletion_requested_by = ?, updated_at = ? WHERE id = ?`,
        input.now,
        input.requestedByUserId,
        input.now,
        input.tenantId,
      );
      this.appendAudit({
        at: input.now,
        action: 'tenant.deletion_requested',
        actor: { userId: admin.id, email: admin.email, role: 'admin' },
        tenantId: input.tenantId,
        targetType: 'tenant',
        targetId: input.tenantId,
        meta: { workspaceName: tenant.name },
      });
      return ok(this.getTenant(input.tenantId)!);
    });
  }

  /** The requesting Admin withdraws the request. */
  cancelDeletion(input: { tenantId: string; requestedByUserId: string; now: string }): Reg<TenantRow> {
    const tenant = this.getTenant(input.tenantId);
    if (tenant === null) return fail('not_found');
    const admin = this.adminOf(input.tenantId);
    if (admin === null || admin.id !== input.requestedByUserId) return fail('forbidden_target');
    if (nextTenantState(tenant.status, 'cancelDeletion') === null) return fail('bad_state');
    return this.storage.transactionSync(() => {
      this.clearDeletionRequest(input.tenantId, input.now);
      this.appendAudit({
        at: input.now,
        action: 'tenant.deletion_cancelled',
        actor: { userId: admin.id, email: admin.email, role: 'admin' },
        tenantId: input.tenantId,
        targetType: 'tenant',
        targetId: input.tenantId,
        meta: { workspaceName: tenant.name },
      });
      return ok(this.getTenant(input.tenantId)!);
    });
  }

  /** The Super Admin declines the request: the workspace is simply active again; nothing was ever touched. */
  rejectDeletion(input: { tenantId: string; actorEmail: string; now: string }): Reg<TenantRow> {
    const tenant = this.getTenant(input.tenantId);
    if (tenant === null) return fail('not_found');
    if (nextTenantState(tenant.status, 'rejectDeletion') === null) return fail('bad_state');
    return this.storage.transactionSync(() => {
      this.clearDeletionRequest(input.tenantId, input.now);
      this.appendAudit({
        at: input.now,
        action: 'tenant.deletion_rejected',
        actor: { userId: null, email: input.actorEmail, role: 'super_admin' },
        tenantId: input.tenantId,
        targetType: 'tenant',
        targetId: input.tenantId,
        meta: { workspaceName: tenant.name },
      });
      return ok(this.getTenant(input.tenantId)!);
    });
  }

  private clearDeletionRequest(tenantId: string, now: string): void {
    this.storage.sql.exec(`UPDATE tenants SET status = 'active', deletion_requested_at = NULL, deletion_requested_by = NULL, updated_at = ? WHERE id = ?`, now, tenantId);
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
    if (nextTenantState(tenant.status, 'approveDeletion') === null) return fail('bad_state');
    const requester = tenant.deletion_requested_by === null ? null : this.getUserInTenant(input.tenantId, tenant.deletion_requested_by);
    const approver = normalizeEmail(input.approverEmail);
    if (approver === null) return fail('invalid_email');
    if (requester !== null && requester.email === approver) return fail('same_person');
    if (tenant.status === 'deletion_requested') {
      this.storage.transactionSync(() => {
        this.storage.sql.exec(`UPDATE tenants SET status = 'deleting', updated_at = ? WHERE id = ?`, input.now, input.tenantId);
        this.appendAudit({
          at: input.now,
          action: 'tenant.deletion_approved',
          actor: { userId: null, email: approver, role: 'super_admin' },
          tenantId: input.tenantId,
          targetType: 'tenant',
          targetId: input.tenantId,
          meta: { workspaceName: tenant.name, requestedBy: requester?.email ?? null },
        });
      });
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
    if (nextTenantState(tenant.status, 'completeDeletion') === null) return fail('bad_state');
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
      // The workspace is gone; its administrative history is NOT (it is content-free and is how a deletion stays accountable).
      this.appendAudit({
        at: input.now,
        action: 'tenant.deleted',
        actor: { userId: null, email: approver, role: 'super_admin' },
        tenantId: input.tenantId,
        targetType: 'tenant',
        targetId: input.tenantId,
        meta: { workspaceName: tenant.name, usersDeleted: count },
      });
      return ok({ usersDeleted: count });
    });
  }
}

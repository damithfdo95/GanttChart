import { beforeEach, describe, expect, it } from 'vitest';
import { RegistryStore } from '../src/registry';
import { PLATFORM_AUDIT_ACTIONS, type AuditActor } from '../../shared/tenancy';
import { createTestStorage } from './helpers/sqlJsStorage';

/**
 * Stage 8B: several SVs per workspace, exactly one Owner SV, and Team Member creation rules.
 * Runs against real SQLite (sql.js) with the same SQL the Durable Object runs.
 */

type TestStorage = Awaited<ReturnType<typeof createTestStorage>>;

const DOMAINS = ['rakuten.com', 'example.com'];
const SUPER = 'boss@example.org';
const SUPER_ACTOR: AuditActor = { userId: null, email: SUPER, role: 'super_admin' };
let storage: TestStorage;
let reg: RegistryStore;
let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 7, 0, 0, 0) + clock++ * 1000).toISOString();

beforeEach(async () => {
  storage = await createTestStorage();
  reg = new RegistryStore(storage);
  reg.init();
  clock = 0;
});

function must<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
}

const rows = (sql: string, ...args: Array<string | number>) => storage.sql.exec<Record<string, string | number | null>>(sql, ...args).toArray();

function webTenant(name: string, ownerEmail: string) {
  const { tenant, admin } = must(reg.createTenantWithAdmin({ name, adminEmail: ownerEmail, managedDomains: DOMAINS, reserved: [SUPER], actorEmail: SUPER, now: now() }));
  const owner: AuditActor = { userId: admin.id, email: admin.email, role: 'admin' };
  must(reg.setStorageMode(tenant.id, 'web', owner, now()));
  return { tenant: reg.getTenant(tenant.id)!, owner, ownerRow: admin };
}

const add = (tenantId: string, email: string, actor: AuditActor, role: 'admin' | 'user' = 'user', access: 'editor' | 'viewer' = 'editor') =>
  reg.createUser({ tenantId, email, role, access, managedDomains: DOMAINS, reserved: [SUPER], actor, now: now() });

describe('the first SV of a new workspace is its Owner', () => {
  it('records the owner on the tenant (not on the email or the order)', () => {
    const w = webTenant('A', 'owner@rakuten.com');
    expect(w.tenant.owner_user_id).toBe(w.ownerRow.id);
    expect(reg.ownerOf(w.tenant.id)?.email).toBe('owner@rakuten.com');
    expect(reg.ownerIdOf(w.tenant.id)).toBe(w.ownerRow.id);
  });
});

describe('several SVs, one Owner', () => {
  it('an SV can create a second and a third SV and Testers; exactly one of them is the Owner', () => {
    const w = webTenant('A', 'owner@rakuten.com');
    const sv2 = must(add(w.tenant.id, 'sv2@rakuten.com', w.owner, 'admin'));
    const sv3 = must(add(w.tenant.id, 'sv3@rakuten.com', { userId: sv2.id, email: sv2.email, role: 'admin' }, 'admin'));
    const t1 = must(add(w.tenant.id, 't1@rakuten.com', w.owner));
    expect([sv2.role, sv3.role, t1.role]).toEqual(['admin', 'admin', 'user']);
    // An SV works with full rights whatever access was asked for.
    expect(must(add(w.tenant.id, 'sv4@rakuten.com', w.owner, 'admin', 'viewer')).access).toBe('editor');
    const users = reg.listUsers(w.tenant.id);
    expect(users.filter((u) => u.role === 'admin')).toHaveLength(4);
    expect(rows(`SELECT COUNT(*) AS n FROM tenants WHERE id = ? AND owner_user_id IS NOT NULL`, w.tenant.id)[0].n).toBe(1);
    expect(reg.ownerOf(w.tenant.id)?.id).toBe(w.ownerRow.id);
  });

  it('refuses an unknown role value', () => {
    const w = webTenant('A', 'owner@rakuten.com');
    expect(add(w.tenant.id, 'x@rakuten.com', w.owner, 'super_admin' as never)).toEqual({ ok: false, error: 'invalid_input' });
  });

  it('the creation audit says which kind of member was created', () => {
    const w = webTenant('A', 'owner@rakuten.com');
    must(add(w.tenant.id, 'sv2@rakuten.com', w.owner, 'admin'));
    must(add(w.tenant.id, 't@rakuten.com', w.owner));
    const metas = rows(`SELECT meta FROM admin_audit WHERE action = 'user.created' AND tenant_id = ? ORDER BY id`, w.tenant.id).map((r) => JSON.parse(String(r.meta)).memberRole);
    expect(metas).toEqual(['sv', 'tester']);
  });
});

describe('Owner SV safety', () => {
  it('the Owner cannot be disabled, by the API or by SQL', () => {
    const w = webTenant('A', 'owner@rakuten.com');
    const sv2 = must(add(w.tenant.id, 'sv2@rakuten.com', w.owner, 'admin'));
    expect(reg.updateUser({ tenantId: w.tenant.id, userId: w.ownerRow.id, status: 'disabled', actor: { userId: sv2.id, email: sv2.email, role: 'admin' }, now: now() })).toEqual({ ok: false, error: 'owner_protected' });
    expect(() => storage.sql.exec(`UPDATE users SET status = 'disabled' WHERE id = ?`, w.ownerRow.id)).toThrow();
    expect(reg.getUserInTenant(w.tenant.id, w.ownerRow.id)?.status).toBe('active');
  });

  it('the Owner cannot become a Tester or move to another workspace', () => {
    const w = webTenant('A', 'owner@rakuten.com');
    const other = webTenant('B', 'b@rakuten.com');
    expect(() => storage.sql.exec(`UPDATE users SET role = 'user' WHERE id = ?`, w.ownerRow.id)).toThrow();
    expect(() => storage.sql.exec(`UPDATE users SET tenant_id = ? WHERE id = ?`, other.tenant.id, w.ownerRow.id)).toThrow();
    expect(reg.getUserInTenant(w.tenant.id, w.ownerRow.id)).toMatchObject({ role: 'admin' });
  });

  it('ownership cannot be cleared or pointed at a Tester, a disabled SV, a missing user or another workspace', () => {
    const w = webTenant('A', 'owner@rakuten.com');
    const other = webTenant('B', 'b@rakuten.com');
    const tester = must(add(w.tenant.id, 't@rakuten.com', w.owner));
    const sv2 = must(add(w.tenant.id, 'sv2@rakuten.com', w.owner, 'admin'));
    must(reg.updateUser({ tenantId: w.tenant.id, userId: sv2.id, status: 'disabled', actor: w.owner, now: now() }));
    expect(() => storage.sql.exec(`UPDATE tenants SET owner_user_id = NULL WHERE id = ?`, w.tenant.id)).toThrow();
    for (const target of [tester.id, sv2.id, 'usr_missing', other.ownerRow.id]) {
      expect(() => storage.sql.exec(`UPDATE tenants SET owner_user_id = ? WHERE id = ?`, target, w.tenant.id), target).toThrow();
      expect(reg.transferOwnership({ tenantId: w.tenant.id, actor: w.owner, toUserId: target, now: now() }).ok, target).toBe(false);
    }
    expect(reg.ownerIdOf(w.tenant.id)).toBe(w.ownerRow.id);
  });

  it('nobody can disable themselves', () => {
    const w = webTenant('A', 'owner@rakuten.com');
    const sv2 = must(add(w.tenant.id, 'sv2@rakuten.com', w.owner, 'admin'));
    expect(reg.updateUser({ tenantId: w.tenant.id, userId: sv2.id, status: 'disabled', actor: { userId: sv2.id, email: sv2.email, role: 'admin' }, now: now() })).toEqual({ ok: false, error: 'same_person' });
  });

  it('a non-owner SV can be disabled and reactivated by another SV; the Tester access level is not an SV setting', () => {
    const w = webTenant('A', 'owner@rakuten.com');
    const sv2 = must(add(w.tenant.id, 'sv2@rakuten.com', w.owner, 'admin'));
    const sv3 = must(add(w.tenant.id, 'sv3@rakuten.com', w.owner, 'admin'));
    const by3: AuditActor = { userId: sv3.id, email: sv3.email, role: 'admin' };
    expect(must(reg.updateUser({ tenantId: w.tenant.id, userId: sv2.id, status: 'disabled', actor: by3, now: now() })).status).toBe('disabled');
    expect(reg.authenticate('sv2@rakuten.com', now())).toEqual({ allowed: false, reason: 'disabled' });
    expect(must(reg.updateUser({ tenantId: w.tenant.id, userId: sv2.id, status: 'enabled', actor: by3, now: now() })).status).toBe('active');
    expect(reg.authenticate('sv2@rakuten.com', now()).allowed).toBe(true);
    expect(reg.updateUser({ tenantId: w.tenant.id, userId: sv2.id, access: 'viewer', actor: by3, now: now() })).toEqual({ ok: false, error: 'forbidden_target' });
    const kinds = rows(`SELECT action FROM admin_audit WHERE tenant_id = ? AND action IN ('user.disabled','user.reactivated') ORDER BY id`, w.tenant.id).map((r) => r.action);
    expect(kinds).toEqual(['user.disabled', 'user.reactivated']);
  });

  it('a foreign workspace cannot reach this workspace members', () => {
    const w = webTenant('A', 'owner@rakuten.com');
    const other = webTenant('B', 'b@rakuten.com');
    const sv2 = must(add(w.tenant.id, 'sv2@rakuten.com', w.owner, 'admin'));
    expect(reg.updateUser({ tenantId: other.tenant.id, userId: sv2.id, status: 'disabled', actor: other.owner, now: now() })).toEqual({ ok: false, error: 'not_found' });
    expect(reg.transferOwnership({ tenantId: other.tenant.id, actor: other.owner, toUserId: sv2.id, now: now() })).toEqual({ ok: false, error: 'not_found' });
  });
});

describe('ownership transfer', () => {
  it('is atomic: the new Owner is authoritative in the same statement the old one stops being', () => {
    const w = webTenant('A', 'owner@rakuten.com');
    const sv2 = must(add(w.tenant.id, 'sv2@rakuten.com', w.owner, 'admin'));
    const done = must(reg.transferOwnership({ tenantId: w.tenant.id, actor: w.owner, toUserId: sv2.id, now: now() }));
    expect(done.owner.id).toBe(sv2.id);
    expect(reg.ownerOf(w.tenant.id)?.id).toBe(sv2.id);
    // The previous Owner is an ordinary SV now: they can be disabled by the new Owner.
    expect(must(reg.updateUser({ tenantId: w.tenant.id, userId: w.ownerRow.id, status: 'disabled', actor: { userId: sv2.id, email: sv2.email, role: 'admin' }, now: now() })).status).toBe('disabled');
    expect(rows(`SELECT COUNT(*) AS n FROM tenants WHERE owner_user_id IS NOT NULL`)[0].n).toBe(1);
  });

  it('only the current Owner may do it, never to themselves, and only while the workspace is active', () => {
    const w = webTenant('A', 'owner@rakuten.com');
    const sv2 = must(add(w.tenant.id, 'sv2@rakuten.com', w.owner, 'admin'));
    const sv3 = must(add(w.tenant.id, 'sv3@rakuten.com', w.owner, 'admin'));
    const by2: AuditActor = { userId: sv2.id, email: sv2.email, role: 'admin' };
    expect(reg.transferOwnership({ tenantId: w.tenant.id, actor: by2, toUserId: sv3.id, now: now() })).toEqual({ ok: false, error: 'forbidden_target' });
    expect(reg.transferOwnership({ tenantId: w.tenant.id, actor: w.owner, toUserId: w.ownerRow.id, now: now() })).toEqual({ ok: false, error: 'bad_state' });
    must(reg.setTenantStatus(w.tenant.id, 'deactivated', SUPER, now()));
    expect(reg.transferOwnership({ tenantId: w.tenant.id, actor: w.owner, toUserId: sv3.id, now: now() })).toEqual({ ok: false, error: 'tenant_inactive' });
    expect(reg.ownerIdOf(w.tenant.id)).toBe(w.ownerRow.id);
  });

  it('is audited, in the workspace trail only (the Super Admin does not see it)', () => {
    const w = webTenant('A', 'owner@rakuten.com');
    const sv2 = must(add(w.tenant.id, 'sv2@rakuten.com', w.owner, 'admin'));
    must(reg.transferOwnership({ tenantId: w.tenant.id, actor: w.owner, toUserId: sv2.id, now: now() }));
    const mine = reg.listAdminAudit({ kind: 'tenant', tenantId: w.tenant.id }).filter((e) => e.action === 'owner.transferred');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ actorEmail: 'owner@rakuten.com', targetEmail: 'sv2@rakuten.com', meta: { from: 'owner@rakuten.com', to: 'sv2@rakuten.com' } });
    expect(PLATFORM_AUDIT_ACTIONS).not.toContain('owner.transferred');
    expect(reg.listAdminAudit({ kind: 'platform' }).some((e) => e.action === 'owner.transferred')).toBe(false);
  });

  it('only the Owner can ask for the workspace to be deleted, and after a transfer that is the new Owner', () => {
    const w = webTenant('A', 'owner@rakuten.com');
    const sv2 = must(add(w.tenant.id, 'sv2@rakuten.com', w.owner, 'admin'));
    expect(reg.requestDeletion({ tenantId: w.tenant.id, requestedByUserId: sv2.id, now: now() })).toEqual({ ok: false, error: 'forbidden_target' });
    must(reg.transferOwnership({ tenantId: w.tenant.id, actor: w.owner, toUserId: sv2.id, now: now() }));
    expect(reg.requestDeletion({ tenantId: w.tenant.id, requestedByUserId: w.ownerRow.id, now: now() })).toEqual({ ok: false, error: 'forbidden_target' });
    expect(must(reg.requestDeletion({ tenantId: w.tenant.id, requestedByUserId: sv2.id, now: now() })).status).toBe('deletion_requested');
  });
});

describe('identity rules when adding a member', () => {
  it('rejects a duplicate in the same workspace and an address that belongs to another workspace, without revealing it', () => {
    const a = webTenant('A', 'a@rakuten.com');
    const b = webTenant('B', 'b@rakuten.com');
    must(add(a.tenant.id, 'dup@rakuten.com', a.owner));
    expect(add(a.tenant.id, 'DUP@Rakuten.com', a.owner)).toEqual({ ok: false, error: 'email_taken' });
    expect(add(b.tenant.id, 'dup@rakuten.com', b.owner)).toEqual({ ok: false, error: 'email_in_other_workspace' });
    expect(add(b.tenant.id, 'dup@rakuten.com', b.owner, 'admin')).toEqual({ ok: false, error: 'email_in_other_workspace' });
    expect(reg.findUserByEmail('dup@rakuten.com')?.tenant_id).toBe(a.tenant.id); // never moved
  });

  it('enforces the managed domain exactly, for SVs as well as Testers', () => {
    const a = webTenant('A', 'a@rakuten.com');
    for (const email of ['x@gmail.com', 'x@fake-rakuten.com', 'x@rakuten.com.evil.io', 'x@sub.rakuten.com']) {
      expect(add(a.tenant.id, email, a.owner, 'admin'), email).toEqual({ ok: false, error: 'email_domain_not_allowed' });
      expect(add(a.tenant.id, email, a.owner, 'user'), email).toEqual({ ok: false, error: 'email_domain_not_allowed' });
    }
    expect(add(a.tenant.id, 'x@rakuten.com', a.owner, 'admin').ok).toBe(true);
  });

  it('a local-mode workspace cannot have members', () => {
    const { tenant, admin } = must(reg.createTenantWithAdmin({ name: 'L', adminEmail: 'l@rakuten.com', managedDomains: DOMAINS, reserved: [SUPER], actorEmail: SUPER, now: now() }));
    expect(add(tenant.id, 'x@rakuten.com', { userId: admin.id, email: admin.email, role: 'admin' }, 'admin')).toEqual({ ok: false, error: 'wrong_mode' });
  });
});

describe('upgrading a registry created before Stage 8B', () => {
  /** The exact Stage 7 tables, including the one-admin-per-tenant index. */
  async function legacy() {
    const s = await createTestStorage();
    for (const q of [
      `CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, storage_mode TEXT NOT NULL CHECK (storage_mode IN ('local','web')), status TEXT NOT NULL CHECK (status IN ('active','deactivated','deletion_requested','deleting')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deletion_requested_at TEXT, deletion_requested_by TEXT)`,
      `CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, tenant_id TEXT NOT NULL REFERENCES tenants (id), role TEXT NOT NULL CHECK (role IN ('admin','user')), access TEXT NOT NULL CHECK (access IN ('editor','viewer')), status TEXT NOT NULL CHECK (status IN ('invited','active','disabled')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT, last_login_at TEXT, display_name TEXT)`,
      `CREATE UNIQUE INDEX users_one_admin_per_tenant ON users (tenant_id) WHERE role = 'admin'`,
      `INSERT INTO tenants VALUES ('ten_old', 'Old', 'web', 'active', 'c', 'c', NULL, NULL)`,
      `INSERT INTO tenants VALUES ('ten_old2', 'Old2', 'local', 'active', 'c', 'c', NULL, NULL)`,
      `INSERT INTO users VALUES ('usr_admin', 'admin@rakuten.com', 'ten_old', 'admin', 'editor', 'active', 'c', 'c', NULL, '2026-01-01T00:00:00.000Z', 'The Admin')`,
      `INSERT INTO users VALUES ('usr_tester', 'tester@rakuten.com', 'ten_old', 'user', 'editor', 'active', 'c', 'c', 'usr_admin', NULL, NULL)`,
      `INSERT INTO users VALUES ('usr_admin2', 'admin2@rakuten.com', 'ten_old2', 'admin', 'editor', 'active', 'c', 'c', NULL, NULL, NULL)`,
    ]) s.sql.exec(q);
    return s;
  }

  it('makes the existing Admin the Owner, keeps every row, and allows more SVs afterwards', async () => {
    const s = await legacy();
    const store = new RegistryStore(s);
    store.init();
    expect(store.ownerOf('ten_old')?.email).toBe('admin@rakuten.com');
    expect(store.ownerOf('ten_old2')?.email).toBe('admin2@rakuten.com');
    expect(store.getUserInTenant('ten_old', 'usr_tester')).toMatchObject({ role: 'user', email: 'tester@rakuten.com', access: 'editor' });
    expect(store.getUserInTenant('ten_old', 'usr_admin')).toMatchObject({ display_name: 'The Admin', last_login_at: '2026-01-01T00:00:00.000Z' });
    // The old index is gone: a second SV can now exist.
    const actor: AuditActor = { userId: 'usr_admin', email: 'admin@rakuten.com', role: 'admin' };
    expect(store.createUser({ tenantId: 'ten_old', email: 'second@rakuten.com', role: 'admin', access: 'editor', managedDomains: DOMAINS, reserved: [], actor, now: now() }).ok).toBe(true);
    // ... but the old Tester can still sign in unchanged.
    expect(store.authenticate('tester@rakuten.com', now()).allowed).toBe(true);
  });

  it('is idempotent: starting again changes nothing and never moves the owner', async () => {
    const s = await legacy();
    const store = new RegistryStore(s);
    store.init();
    const actor: AuditActor = { userId: 'usr_admin', email: 'admin@rakuten.com', role: 'admin' };
    const second = must(store.createUser({ tenantId: 'ten_old', email: 'second@rakuten.com', role: 'admin', access: 'editor', managedDomains: DOMAINS, reserved: [], actor, now: now() }));
    must(store.transferOwnership({ tenantId: 'ten_old', actor, toUserId: second.id, now: now() }));
    const again = new RegistryStore(s);
    again.init();
    again.init();
    expect(again.ownerIdOf('ten_old')).toBe(second.id);
    expect(s.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM users`).one().n).toBe(4);
  });

  it('a workspace with no admin at all is left without an owner instead of failing the upgrade', async () => {
    const s = await createTestStorage();
    for (const q of [
      `CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, storage_mode TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deletion_requested_at TEXT, deletion_requested_by TEXT)`,
      `INSERT INTO tenants VALUES ('ten_x', 'X', 'web', 'active', 'c', 'c', NULL, NULL)`,
    ]) s.sql.exec(q);
    const store = new RegistryStore(s);
    expect(() => store.init()).not.toThrow();
    expect(store.ownerIdOf('ten_x')).toBeNull();
  });

  it('keeps deletion and administrative audit rows, and the audit stays append-only', async () => {
    const s = await legacy();
    s.sql.exec(`CREATE TABLE deletion_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, requested_by_email TEXT NOT NULL, requested_at TEXT NOT NULL, approved_by_email TEXT NOT NULL, approved_at TEXT NOT NULL, deleted_at TEXT, users_deleted INTEGER NOT NULL DEFAULT 0)`);
    s.sql.exec(`INSERT INTO deletion_audit (tenant_id, requested_by_email, requested_at, approved_by_email, approved_at, deleted_at, users_deleted) VALUES ('ten_gone','a@x.com','t','b@x.com','t','t',2)`);
    const store = new RegistryStore(s);
    store.init();
    expect(store.listAudit()).toHaveLength(1);
    store.appendAudit({ at: now(), action: 'tenant.disabled', actor: SUPER_ACTOR, tenantId: 'ten_old' });
    expect(() => s.sql.exec(`DELETE FROM admin_audit`)).toThrow();
  });
});

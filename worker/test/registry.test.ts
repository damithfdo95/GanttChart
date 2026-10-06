import { beforeEach, describe, expect, it } from 'vitest';
import { RegistryStore, decideAccess, type TenantRow, type UserRow } from '../src/registry';
import { isTenantId, isUserId } from '../../shared/tenancy';
import { createTestStorage } from './helpers/sqlJsStorage';

/** The organisation domains the fixtures use; the real rule is tested in managed-domains.test.ts. */
const MANAGED = ['example.com', 'b.co', 'c.co', 'e.co', 'x.yz', 'y.zz', 'tenant.test', 'old.test', 'dev.test'];

type TestStorage = Awaited<ReturnType<typeof createTestStorage>>;

let storage: TestStorage;
let reg: RegistryStore;
const SUPER = ['super@example.com'];
let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 6, 12, 0, 0) + clock++ * 1000).toISOString();

beforeEach(async () => {
  storage = await createTestStorage();
  reg = new RegistryStore(storage);
  reg.init();
  clock = 0;
});

function mustOk<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
}

function newTenant(name: string, adminEmail: string) {
  return mustOk(reg.createTenantWithAdmin({ name, adminEmail, managedDomains: MANAGED, reserved: SUPER, actorEmail: SUPER[0], now: now() }));
}

/** A tenant switched to web mode, ready to have users. */
function webTenant(name: string, adminEmail: string) {
  const { tenant, admin } = newTenant(name, adminEmail);
  mustOk(reg.setStorageMode(tenant.id, 'web', now()));
  return { tenant: reg.getTenant(tenant.id)!, admin };
}

function addUser(tenantId: string, email: string, access: 'editor' | 'viewer' = 'editor', actor = 'usr_x') {
  return reg.createUser({ tenantId, email, access, managedDomains: MANAGED, reserved: SUPER, actorUserId: actor, now: now() });
}

describe('tenant + admin creation', () => {
  it('creates a tenant in LOCAL mode with one invited admin, using stable server-generated ids', () => {
    const { tenant, admin } = newTenant('Alpha QA', 'Alice@Example.com');
    expect(isTenantId(tenant.id)).toBe(true);
    expect(isUserId(admin.id)).toBe(true);
    expect(tenant).toMatchObject({ name: 'Alpha QA', storage_mode: 'local', status: 'active' });
    expect(admin).toMatchObject({ email: 'alice@example.com', role: 'admin', access: 'editor', status: 'invited', tenant_id: tenant.id });
  });

  it('rejects bad names and emails', () => {
    for (const name of ['', '   ', 'x'.repeat(81)]) {
      expect(reg.createTenantWithAdmin({ name, adminEmail: 'a@example.com', managedDomains: MANAGED, reserved: [], actorEmail: 's', now: now() })).toEqual({ ok: false, error: 'invalid_name' });
    }
    for (const email of ['', 'nope', 'a@b', 'a b@example.com', '@example.com', 'a@@example.com']) {
      expect(reg.createTenantWithAdmin({ name: 'T', adminEmail: email, managedDomains: MANAGED, reserved: [], actorEmail: 's', now: now() })).toEqual({ ok: false, error: 'invalid_email' });
    }
  });

  it('treats differently spelled emails as the same identity (case, whitespace, full-width characters)', () => {
    newTenant('A', 'bob@example.com');
    for (const dup of ['BOB@EXAMPLE.COM', '  bob@example.com ', 'ｂｏｂ@example.com']) {
      expect(reg.createTenantWithAdmin({ name: 'B', adminEmail: dup, managedDomains: MANAGED, reserved: [], actorEmail: 's', now: now() })).toEqual({ ok: false, error: 'email_taken' });
    }
  });

  it('refuses the Super Admin emails (a person cannot be both)', () => {
    expect(reg.createTenantWithAdmin({ name: 'T', adminEmail: 'SUPER@example.com', managedDomains: MANAGED, reserved: SUPER, actorEmail: 's', now: now() })).toEqual({ ok: false, error: 'email_reserved' });
  });

  it('the database itself refuses a second admin for a tenant', () => {
    const { tenant } = newTenant('A', 'a@example.com');
    expect(() =>
      storage.sql.exec(
        `INSERT INTO users (id, email, tenant_id, role, access, status, created_at, updated_at) VALUES ('usr_zz', 'second@example.com', ?, 'admin', 'editor', 'active', 'x', 'x')`,
        tenant.id,
      ),
    ).toThrow();
  });

  it('the database refuses invalid states and unknown values', () => {
    const { tenant } = newTenant('A', 'a@example.com');
    expect(() => storage.sql.exec(`UPDATE tenants SET status = 'pwned' WHERE id = ?`, tenant.id)).toThrow();
    expect(() => storage.sql.exec(`UPDATE tenants SET storage_mode = 'hybrid' WHERE id = ?`, tenant.id)).toThrow();
    expect(() => storage.sql.exec(`UPDATE users SET role = 'super_admin' WHERE tenant_id = ?`, tenant.id)).toThrow();
  });
});

describe('users are bound to ONE tenant and cannot be reached across tenants', () => {
  it('only web-mode, active tenants can have users', () => {
    const { tenant } = newTenant('Local', 'l@example.com');
    expect(addUser(tenant.id, 'u@example.com')).toEqual({ ok: false, error: 'wrong_mode' });
    mustOk(reg.setStorageMode(tenant.id, 'web', now()));
    expect(addUser(tenant.id, 'u@example.com').ok).toBe(true);
    mustOk(reg.setTenantStatus(tenant.id, 'deactivated', now()));
    expect(addUser(tenant.id, 'u2@example.com')).toEqual({ ok: false, error: 'tenant_inactive' });
  });

  it('creates invited users with the right tenant, role and access, and unique emails across ALL tenants', () => {
    const a = webTenant('A', 'a@example.com');
    const b = webTenant('B', 'b@example.com');
    const u = mustOk(addUser(a.tenant.id, 'User@Example.com', 'viewer'));
    expect(u).toMatchObject({ email: 'user@example.com', tenant_id: a.tenant.id, role: 'user', access: 'viewer', status: 'invited' });
    expect(addUser(b.tenant.id, 'user@example.com')).toEqual({ ok: false, error: 'email_taken' }); // same person cannot be in two tenants
    expect(addUser(a.tenant.id, 'a@example.com')).toEqual({ ok: false, error: 'email_taken' }); // an admin's email is taken too
    expect(addUser(a.tenant.id, 'super@example.com')).toEqual({ ok: false, error: 'email_reserved' });
    expect(addUser(a.tenant.id, 'nonsense')).toEqual({ ok: false, error: 'invalid_email' });
    expect(addUser(a.tenant.id, 'x@example.com', 'owner' as never)).toEqual({ ok: false, error: 'invalid_input' });
  });

  it('a user id from ANOTHER tenant is "not found" for every operation', () => {
    const a = webTenant('A', 'a@example.com');
    const b = webTenant('B', 'b@example.com');
    const ub = mustOk(addUser(b.tenant.id, 'ub@example.com'));
    expect(reg.getUserInTenant(a.tenant.id, ub.id)).toBeNull();
    expect(reg.updateUser({ tenantId: a.tenant.id, userId: ub.id, status: 'disabled', now: now() })).toEqual({ ok: false, error: 'not_found' });
    expect(reg.updateUser({ tenantId: a.tenant.id, userId: ub.id, access: 'viewer', now: now() })).toEqual({ ok: false, error: 'not_found' });
    expect(reg.getUserInTenant(b.tenant.id, ub.id)?.status).toBe('invited'); // untouched
    expect(reg.listUsers(a.tenant.id).map((u) => u.email)).toEqual(['a@example.com']);
  });

  it('the admin row can never be modified through user management', () => {
    const a = webTenant('A', 'a@example.com');
    expect(reg.updateUser({ tenantId: a.tenant.id, userId: a.admin.id, status: 'disabled', now: now() })).toEqual({ ok: false, error: 'forbidden_target' });
    expect(reg.updateUser({ tenantId: a.tenant.id, userId: a.admin.id, access: 'viewer', now: now() })).toEqual({ ok: false, error: 'forbidden_target' });
    expect(reg.getUserInTenant(a.tenant.id, a.admin.id)).toMatchObject({ role: 'admin', access: 'editor' });
  });

  it('disable / re-enable / change access; re-enabling a never-signed-in user restores "invited"', () => {
    const a = webTenant('A', 'a@example.com');
    const u = mustOk(addUser(a.tenant.id, 'u@example.com'));
    expect(mustOk(reg.updateUser({ tenantId: a.tenant.id, userId: u.id, status: 'disabled', now: now() })).status).toBe('disabled');
    expect(mustOk(reg.updateUser({ tenantId: a.tenant.id, userId: u.id, status: 'enabled', now: now() })).status).toBe('invited');
    expect(reg.authenticate('u@example.com', now()).allowed).toBe(true); // first sign-in → active
    reg.updateUser({ tenantId: a.tenant.id, userId: u.id, status: 'disabled', now: now() });
    expect(mustOk(reg.updateUser({ tenantId: a.tenant.id, userId: u.id, status: 'enabled', now: now() })).status).toBe('active');
    expect(mustOk(reg.updateUser({ tenantId: a.tenant.id, userId: u.id, access: 'viewer', now: now() })).access).toBe('viewer');
    expect(reg.updateUser({ tenantId: a.tenant.id, userId: u.id, status: 'banned' as never, now: now() })).toEqual({ ok: false, error: 'invalid_input' });
  });
});

describe('authenticate (authenticated is not authorized)', () => {
  it('an email that is not in the registry fails closed', () => {
    webTenant('A', 'a@example.com');
    expect(reg.authenticate('stranger@example.com', now())).toEqual({ allowed: false, reason: 'unregistered' });
    expect(reg.authenticate('', now())).toEqual({ allowed: false, reason: 'unregistered' });
    expect(reg.authenticate('not-an-email', now())).toEqual({ allowed: false, reason: 'unregistered' });
  });

  it('matches regardless of how the email is spelled', () => {
    const a = webTenant('A', 'a@example.com');
    const r = reg.authenticate('  A@EXAMPLE.COM ', now());
    expect(r.allowed && r.tenant.id).toBe(a.tenant.id);
  });

  it('a disabled user is refused', () => {
    const a = webTenant('A', 'a@example.com');
    const u = mustOk(addUser(a.tenant.id, 'u@example.com'));
    reg.updateUser({ tenantId: a.tenant.id, userId: u.id, status: 'disabled', now: now() });
    expect(reg.authenticate('u@example.com', now())).toEqual({ allowed: false, reason: 'disabled' });
  });

  it('a deactivated or deleting tenant refuses EVERYONE in it, including its admin', () => {
    const a = webTenant('A', 'a@example.com');
    mustOk(addUser(a.tenant.id, 'u@example.com'));
    mustOk(reg.setTenantStatus(a.tenant.id, 'deactivated', now()));
    expect(reg.authenticate('a@example.com', now())).toEqual({ allowed: false, reason: 'tenant_inactive' });
    expect(reg.authenticate('u@example.com', now())).toEqual({ allowed: false, reason: 'tenant_inactive' });
    mustOk(reg.setTenantStatus(a.tenant.id, 'active', now()));
    expect(reg.authenticate('u@example.com', now()).allowed).toBe(true);
  });

  it('users of a LOCAL-mode tenant are refused; its admin is not', () => {
    const { tenant } = webTenant('A', 'a@example.com');
    mustOk(addUser(tenant.id, 'u@example.com'));
    mustOk(reg.setStorageMode(tenant.id, 'local', now()));
    expect(reg.authenticate('u@example.com', now())).toEqual({ allowed: false, reason: 'workspace_not_shared' });
    expect(reg.authenticate('a@example.com', now()).allowed).toBe(true);
  });

  it('records the first sign-in (invited → active) and throttles last_login writes', () => {
    const { tenant } = webTenant('A', 'a@example.com');
    const t0 = '2026-10-06T12:00:00.000Z';
    const first = reg.authenticate('a@example.com', t0);
    expect(first.allowed && first.user.status).toBe('active');
    storage.writes.count = 0;
    reg.authenticate('a@example.com', '2026-10-06T12:05:00.000Z'); // 5 min later
    expect(storage.writes.count).toBe(0); // no write
    reg.authenticate('a@example.com', '2026-10-07T01:00:00.000Z'); // > 12 h later
    expect(storage.writes.count).toBe(1);
    expect(reg.adminOf(tenant.id)?.last_login_at).toBe('2026-10-07T01:00:00.000Z');
  });

  it('decideAccess is exhaustive and pure', () => {
    const user = (over: Partial<UserRow>): UserRow => ({ id: 'u', email: 'e@e.co', tenant_id: 't', role: 'user', access: 'editor', status: 'active', created_at: '', updated_at: '', created_by: null, last_login_at: null, ...over });
    const tenant = (over: Partial<TenantRow>): TenantRow => ({ id: 't', name: 'n', storage_mode: 'web', status: 'active', created_at: '', updated_at: '', deletion_requested_at: null, deletion_requested_by: null, ...over });
    expect(decideAccess(user({}), tenant({}))).toEqual({ allowed: true });
    expect(decideAccess(user({ status: 'invited' }), tenant({}))).toEqual({ allowed: true });
    expect(decideAccess(user({}), tenant({ status: 'deletion_requested' }))).toEqual({ allowed: true });
    expect(decideAccess(user({ status: 'disabled' }), tenant({}))).toEqual({ allowed: false, reason: 'disabled' });
    expect(decideAccess(user({}), tenant({ status: 'deactivated' }))).toEqual({ allowed: false, reason: 'tenant_inactive' });
    expect(decideAccess(user({}), tenant({ status: 'deleting' }))).toEqual({ allowed: false, reason: 'tenant_inactive' });
    expect(decideAccess(user({}), tenant({ storage_mode: 'local' }))).toEqual({ allowed: false, reason: 'workspace_not_shared' });
    expect(decideAccess(user({ role: 'admin' }), tenant({ storage_mode: 'local' }))).toEqual({ allowed: true });
  });
});

describe('tenant administration', () => {
  it('status can only toggle between active and deactivated, never during deletion', () => {
    const { tenant } = newTenant('A', 'a@example.com');
    expect(mustOk(reg.setTenantStatus(tenant.id, 'deactivated', now())).status).toBe('deactivated');
    mustOk(reg.setTenantStatus(tenant.id, 'active', now()));
    mustOk(reg.requestDeletion({ tenantId: tenant.id, requestedByUserId: reg.adminOf(tenant.id)!.id, now: now() }));
    expect(reg.setTenantStatus(tenant.id, 'active', now())).toEqual({ ok: false, error: 'bad_state' });
    expect(reg.setTenantStatus('ten_nope', 'active', now())).toEqual({ ok: false, error: 'not_found' });
  });

  it('storage mode can only change on an active tenant', () => {
    const { tenant } = newTenant('A', 'a@example.com');
    mustOk(reg.setTenantStatus(tenant.id, 'deactivated', now()));
    expect(reg.setStorageMode(tenant.id, 'web', now())).toEqual({ ok: false, error: 'tenant_inactive' });
  });

  it('the Super Admin summary is metadata only', () => {
    const a = webTenant('A', 'a@example.com');
    mustOk(addUser(a.tenant.id, 'u1@example.com'));
    mustOk(addUser(a.tenant.id, 'u2@example.com'));
    newTenant('B', 'b@example.com');
    const rows = reg.listTenantSummaries();
    expect(rows.map((r) => [r.name, r.adminEmail, r.userCount, r.storageMode])).toEqual([
      ['A', 'a@example.com', 3, 'web'],
      ['B', 'b@example.com', 1, 'local'],
    ]);
    expect(Object.keys(rows[0]).sort()).toEqual(['adminEmail', 'adminOutsideManagedDomains', 'adminStatus', 'createdAt', 'deletionRequestedAt', 'id', 'name', 'status', 'storageMode', 'userCount']);
  });
});

describe('deletion workflow', () => {
  function requested() {
    const a = webTenant('A', 'admin-a@example.com');
    mustOk(addUser(a.tenant.id, 'u@example.com'));
    const t = mustOk(reg.requestDeletion({ tenantId: a.tenant.id, requestedByUserId: a.admin.id, now: now() }));
    return { a, t };
  }

  it('only the tenant’s admin can request, and only for an active tenant', () => {
    const a = webTenant('A', 'a@example.com');
    const u = mustOk(addUser(a.tenant.id, 'u@example.com'));
    expect(reg.requestDeletion({ tenantId: a.tenant.id, requestedByUserId: u.id, now: now() })).toEqual({ ok: false, error: 'forbidden_target' });
    const b = webTenant('B', 'b@example.com');
    expect(reg.requestDeletion({ tenantId: a.tenant.id, requestedByUserId: b.admin.id, now: now() })).toEqual({ ok: false, error: 'forbidden_target' }); // another tenant's admin
    mustOk(reg.requestDeletion({ tenantId: a.tenant.id, requestedByUserId: a.admin.id, now: now() }));
    expect(reg.requestDeletion({ tenantId: a.tenant.id, requestedByUserId: a.admin.id, now: now() })).toEqual({ ok: false, error: 'bad_state' });
    expect(reg.getTenant(a.tenant.id)?.status).toBe('deletion_requested');
    expect(reg.getTenant(b.tenant.id)?.status).toBe('active');
  });

  it('the request can be cancelled; the tenant works normally afterwards', () => {
    const { a } = requested();
    expect(mustOk(reg.cancelDeletion({ tenantId: a.tenant.id, requestedByUserId: a.admin.id, now: now() })).status).toBe('active');
    expect(reg.getTenant(a.tenant.id)).toMatchObject({ deletion_requested_at: null, deletion_requested_by: null });
    expect(reg.cancelDeletion({ tenantId: a.tenant.id, requestedByUserId: a.admin.id, now: now() })).toEqual({ ok: false, error: 'bad_state' });
  });

  it('a deletion that was never requested cannot be started', () => {
    const a = webTenant('A', 'a@example.com');
    expect(reg.beginDeletion({ tenantId: a.tenant.id, approverEmail: SUPER[0], now: now() })).toEqual({ ok: false, error: 'bad_state' });
    expect(reg.finishDeletion({ tenantId: a.tenant.id, approverEmail: SUPER[0], requesterEmail: 'x@example.com', now: now() })).toEqual({ ok: false, error: 'bad_state' });
  });

  it('the requester can NEVER approve their own deletion', () => {
    const { a } = requested();
    expect(reg.beginDeletion({ tenantId: a.tenant.id, approverEmail: 'ADMIN-A@example.com', now: now() })).toEqual({ ok: false, error: 'same_person' });
    expect(reg.getTenant(a.tenant.id)?.status).toBe('deletion_requested'); // nothing happened
  });

  it('approval blocks all access immediately, then removes tenant, users and email identities with a minimal audit row', () => {
    const { a } = requested();
    const begun = mustOk(reg.beginDeletion({ tenantId: a.tenant.id, approverEmail: SUPER[0], now: now() }));
    expect(begun).toMatchObject({ tenant: { status: 'deleting' }, requesterEmail: 'admin-a@example.com' });
    expect(reg.authenticate('u@example.com', now())).toEqual({ allowed: false, reason: 'tenant_inactive' });
    expect(reg.authenticate('admin-a@example.com', now())).toEqual({ allowed: false, reason: 'tenant_inactive' });

    const done = mustOk(reg.finishDeletion({ tenantId: a.tenant.id, approverEmail: SUPER[0], requesterEmail: begun.requesterEmail, now: now() }));
    expect(done.usersDeleted).toBe(2);
    expect(reg.getTenant(a.tenant.id)).toBeNull();
    expect(reg.listUsers(a.tenant.id)).toEqual([]);
    expect(reg.authenticate('u@example.com', now())).toEqual({ allowed: false, reason: 'unregistered' });
    // The email identity is free again.
    expect(reg.createTenantWithAdmin({ name: 'Reborn', adminEmail: 'u@example.com', managedDomains: MANAGED, reserved: SUPER, actorEmail: SUPER[0], now: now() }).ok).toBe(true);

    const audit = reg.listAudit();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ tenant_id: a.tenant.id, requested_by_email: 'admin-a@example.com', approved_by_email: SUPER[0], users_deleted: 2 });
    // The audit row has identities and timestamps only: no names, no content.
    expect(Object.keys(audit[0]).sort()).toEqual(['approved_at', 'approved_by_email', 'deleted_at', 'id', 'requested_at', 'requested_by_email', 'tenant_id', 'users_deleted']);
  });

  it('a retry after a half-finished deletion completes it (begin is idempotent for "deleting")', () => {
    const { a } = requested();
    mustOk(reg.beginDeletion({ tenantId: a.tenant.id, approverEmail: SUPER[0], now: now() }));
    const again = mustOk(reg.beginDeletion({ tenantId: a.tenant.id, approverEmail: SUPER[0], now: now() }));
    expect(again.tenant.status).toBe('deleting');
    mustOk(reg.finishDeletion({ tenantId: a.tenant.id, approverEmail: SUPER[0], requesterEmail: again.requesterEmail, now: now() }));
    expect(reg.getTenant(a.tenant.id)).toBeNull();
  });

  it('is atomic: a failure while writing the audit row leaves users and tenant intact', () => {
    const { a } = requested();
    mustOk(reg.beginDeletion({ tenantId: a.tenant.id, approverEmail: SUPER[0], now: now() }));
    storage.failOn('INSERT INTO deletion_audit');
    expect(() => reg.finishDeletion({ tenantId: a.tenant.id, approverEmail: SUPER[0], requesterEmail: 'x', now: now() })).toThrow(/injected/);
    storage.failOn(null);
    expect(reg.getTenant(a.tenant.id)?.status).toBe('deleting');
    expect(reg.listUsers(a.tenant.id)).toHaveLength(2);
    expect(reg.listAudit()).toHaveLength(0);
  });

  it('deleting one tenant never touches another', () => {
    const { a } = requested();
    const b = webTenant('B', 'b@example.com');
    mustOk(addUser(b.tenant.id, 'ub@example.com'));
    const begun = mustOk(reg.beginDeletion({ tenantId: a.tenant.id, approverEmail: SUPER[0], now: now() }));
    mustOk(reg.finishDeletion({ tenantId: a.tenant.id, approverEmail: SUPER[0], requesterEmail: begun.requesterEmail, now: now() }));
    expect(reg.getTenant(b.tenant.id)?.status).toBe('active');
    expect(reg.listUsers(b.tenant.id).map((u) => u.email).sort()).toEqual(['b@example.com', 'ub@example.com']);
    expect(reg.authenticate('ub@example.com', now()).allowed).toBe(true);
  });
});

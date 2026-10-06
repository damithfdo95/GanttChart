import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { AdminAuditDto, TenantDto, TenantListResult, TenantSummaryDto, UserDto } from '../../../shared/tenancy';
import { CLOSE_CODES } from '../../../shared/tenancy';
import { BASE, SECRET_A, SUPER, activateWeb, addUser, call, createTenant, email, get, listTenants, openSocket, patch, post, rec, twoTenants, whoami } from './tenancy-harness';

/**
 * Stage 7: account lifecycle, administration, the administrative audit trail. Everything
 * goes through the real Worker entry (origin checks, authentication, registry lookup,
 * authorization, routing) and the real Durable Objects.
 */

let n = 0;
const rk = (label: string): string => `${label}-${++n}-${crypto.randomUUID().slice(0, 6)}@rakuten.com`;

const listUsers = async (adminEmail: string) => (await get<{ users: UserDto[] }>(adminEmail, '/api/tenant/users')).json.users;
const tenantAudit = async (who: string) => get<{ audit: AdminAuditDto[] }>(who, '/api/tenant/audit');
const platformAudit = async () => (await get<{ audit: AdminAuditDto[] }>(SUPER, '/api/super/admin-audit?limit=200')).json.audit;
const find = (list: TenantSummaryDto[], id: string) => list.find((t) => t.id === id);
const registry = () => env.REGISTRY.getByName('registry');
const rowCount = (table: string) => runInDurableObject(registry(), async (_i, state) => state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n);

describe('Super Admin: the workspace list', () => {
  it('returns metadata with a total, and never any QA content', async () => {
    const w = await twoTenants();
    const r = await get<TenantListResult>(SUPER, '/api/super/tenants');
    expect(r.status).toBe(200);
    expect(r.json.total).toBeGreaterThanOrEqual(2);
    const a = find(r.json.tenants, w.a.id)!;
    expect(a).toMatchObject({ name: 'Alpha QA', storageMode: 'web', status: 'active', adminEmail: w.a.adminEmail, userCount: 3, adminStatus: 'active' });
    expect(Object.keys(a).sort()).toEqual(
      ['adminDisplayName', 'adminEmail', 'adminOutsideManagedDomains', 'adminStatus', 'createdAt', 'deletionRequestedAt', 'id', 'lastActivityAt', 'name', 'status', 'storageMode', 'userCount'],
    );
    expect(r.text).not.toContain(SECRET_A);
    expect(r.text).not.toContain('proj-a');
  });

  it('searches by workspace name and admin email, filters by status and mode, sorts and pages', async () => {
    const tag = `Zq${crypto.randomUUID().slice(0, 6)}`;
    const adminA = rk(`${tag}-a`);
    const a = await createTenant(`${tag} Alpha`, adminA);
    const b = await createTenant(`${tag} Bravo`, rk(`${tag}-b`));
    await activateWeb(a, [rec('project', 'p1')]);
    await patch(SUPER, `/api/super/tenants/${b.id}`, { status: 'deactivated' });

    const q = (qs: string) => get<TenantListResult>(SUPER, `/api/super/tenants?${qs}`);
    expect((await q(`q=${tag}&sort=name`)).json.tenants.map((t) => t.name)).toEqual([`${tag} Alpha`, `${tag} Bravo`]);
    expect((await q(`q=${encodeURIComponent(adminA.toUpperCase())}`)).json.tenants.map((t) => t.id)).toEqual([a.id]);
    expect((await q(`q=${tag}&status=disabled`)).json.tenants.map((t) => t.id)).toEqual([b.id]);
    expect((await q(`q=${tag}&status=active`)).json.tenants.map((t) => t.id)).toEqual([a.id]);
    expect((await q(`q=${tag}&mode=web`)).json.tenants.map((t) => t.id)).toEqual([a.id]);
    expect((await q(`q=${tag}&mode=local`)).json.tenants.map((t) => t.id)).toEqual([b.id]);
    expect((await q(`q=${tag}&sort=name&dir=desc`)).json.tenants.map((t) => t.name)[0]).toBe(`${tag} Bravo`);
    const page = await q(`q=${tag}&sort=name&limit=1&offset=1`);
    expect(page.json.total).toBe(2);
    expect(page.json.tenants.map((t) => t.name)).toEqual([`${tag} Bravo`]);
    expect((await q(`q=${tag}%25`)).json.tenants).toEqual([]); // "%" is a literal character, not "everything"
  });

  it('refuses malformed list parameters instead of guessing', async () => {
    for (const qs of ['status=bogus', 'mode=cloud', 'sort=password', 'dir=sideways', 'limit=-1', 'limit=abc', 'offset=1.5']) {
      expect((await get(SUPER, `/api/super/tenants?${qs}`)).status, qs).toBe(400);
    }
  });

  it('is for the Super Admin only', async () => {
    const w = await twoTenants();
    for (const who of [w.a.adminEmail, w.userA, email('stranger')]) expect((await get(who, '/api/super/tenants')).status).toBe(403);
  });

  it('shows the last activity of the workspace (bucketed sign-in time) and the admin’s display name', async () => {
    const t = await createTenant('Active ones', rk('act'));
    await post(SUPER, '/api/super/tenants', { name: 'Named admin', adminEmail: rk('named'), displayName: 'Hanako Suzuki' });
    expect(find(await listTenants(), t.id)?.lastActivityAt).toBeNull();
    await whoami(t.adminEmail);
    expect(find(await listTenants(), t.id)?.lastActivityAt).not.toBeNull();
    expect((await listTenants()).find((x) => x.name === 'Named admin')?.adminDisplayName).toBe('Hanako Suzuki');
  });
});

describe('Super Admin: creating an Admin', () => {
  it('shows exactly what was created (workspace, admin, local storage, active)', async () => {
    const mail = rk('new');
    const r = await post<{ tenant: TenantDto; admin: UserDto }>(SUPER, '/api/super/tenants', { name: '  Release   QA ', adminEmail: ` ${mail.toUpperCase()} `, displayName: ' Taro  Yamada ' });
    expect(r.status).toBe(201);
    expect(r.json.tenant).toMatchObject({ name: 'Release QA', storageMode: 'local', status: 'active' });
    expect(r.json.admin).toMatchObject({ email: mail, role: 'admin', status: 'active', displayName: 'Taro Yamada' });
  });

  it('rejects a duplicate (any spelling), an outside domain, a bad name and a bad display name — and creates nothing', async () => {
    const mail = rk('dup');
    expect((await post(SUPER, '/api/super/tenants', { name: 'One', adminEmail: mail })).status).toBe(201);
    const before = { tenants: await rowCount('tenants'), users: await rowCount('users') };
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{ name: 'Two', adminEmail: mail.toUpperCase() }, 409, 'email_taken'],
      [{ name: 'Two', adminEmail: ` ${mail} ` }, 409, 'email_taken'],
      [{ name: 'Two', adminEmail: 'person@gmail.com' }, 400, 'email_domain_not_allowed'],
      [{ name: 'Two', adminEmail: 'x@fake-rakuten.com' }, 400, 'email_domain_not_allowed'],
      [{ name: '', adminEmail: rk('x') }, 400, 'invalid_name'],
      [{ name: 'x'.repeat(81), adminEmail: rk('x') }, 400, 'invalid_name'],
      [{ name: 'Two', adminEmail: 'not-an-email' }, 400, 'invalid_email'],
      [{ name: 'Two', adminEmail: rk('x'), displayName: '<script>' }, 400, 'invalid_display_name'],
      [{ name: 'Two', adminEmail: rk('x'), displayName: 'x'.repeat(81) }, 400, 'invalid_display_name'],
      [{ name: 'Two', adminEmail: SUPER }, 409, 'email_reserved'], // a Super Admin address can never become an Admin
    ];
    for (const [body, status, error] of cases) {
      const r = await post(SUPER, '/api/super/tenants', body);
      expect([r.status, r.json.error], JSON.stringify(body)).toEqual([status, error]);
    }
    expect({ tenants: await rowCount('tenants'), users: await rowCount('users') }).toEqual(before);
  });

  it('an Admin, a User and a stranger cannot create Admins', async () => {
    const w = await twoTenants();
    for (const who of [w.a.adminEmail, w.userA, rk('stranger')]) {
      const r = await post(who, '/api/super/tenants', { name: 'Sneaky', adminEmail: rk('s') });
      expect(r.status).toBe(403);
    }
    expect((await listTenants()).some((t) => t.name === 'Sneaky')).toBe(false);
  });

  it('is recorded in the platform audit with the real actor', async () => {
    const mail = rk('audited');
    const created = await post<{ tenant: TenantDto }>(SUPER, '/api/super/tenants', { name: 'Audited', adminEmail: mail });
    const entry = (await platformAudit()).find((e) => e.action === 'admin.created' && e.tenantId === created.json.tenant.id)!;
    expect(entry).toMatchObject({ actorEmail: SUPER, actorRole: 'super_admin', targetType: 'user', targetEmail: mail, meta: { workspaceName: 'Audited' } });
  });
});

describe('Super Admin: disabling and reactivating a workspace', () => {
  it('refuses the Admin AND their Users, closes every open socket, touches no data, and is fully reversible', async () => {
    const w = await twoTenants();
    const adminSock = await openSocket(w.a.adminEmail);
    const userSock = await openSocket(w.userA);
    const otherSock = await openSocket(w.userB);
    if (!adminSock.ok || !userSock.ok || !otherSock.ok) throw new Error('connect');
    const before = await get<{ hash: string; revision: number }>(w.a.adminEmail, '/api/export');

    const off = await patch<{ tenant: TenantDto }>(SUPER, `/api/super/tenants/${w.a.id}`, { status: 'deactivated' });
    expect(off.status).toBe(200);
    expect(off.json.tenant.status).toBe('deactivated');
    expect((await adminSock.sock.closed).code).toBe(CLOSE_CODES.accessRevoked);
    expect((await userSock.sock.closed).code).toBe(CLOSE_CODES.accessRevoked);

    for (const who of [w.a.adminEmail, w.userA, w.viewerA]) {
      const r = await whoami(who);
      expect([r.status, r.json.reason], who).toEqual([403, 'tenant_inactive']);
      expect((await get(who, '/api/export')).status).toBe(403);
      expect((await get(who, '/api/tenant/users')).status).toBe(403);
      expect(await openSocket(who)).toMatchObject({ ok: false, status: 403 });
    }
    // Another workspace never notices.
    expect((await whoami(w.userB)).status).toBe(200);
    expect(otherSock.sock.isOpen).toBe(true);
    expect(find(await listTenants(), w.a.id)).toMatchObject({ status: 'deactivated', userCount: 3 });

    const on = await patch<{ tenant: TenantDto }>(SUPER, `/api/super/tenants/${w.a.id}`, { status: 'active' });
    expect(on.json.tenant.status).toBe('active');
    expect((await whoami(w.a.adminEmail)).status).toBe(200);
    expect((await whoami(w.userA)).status).toBe(200);
    const again = await openSocket(w.userA);
    expect(again.ok).toBe(true);
    // Not one byte of the workspace changed.
    const after = await get<{ hash: string; revision: number }>(w.a.adminEmail, '/api/export');
    expect(after.json.hash).toBe(before.json.hash);
    expect(after.json.revision).toBe(before.json.revision);
  });

  it('is Super Admin only, refuses nonsense and repeats, and is audited both ways', async () => {
    const w = await twoTenants();
    for (const who of [w.a.adminEmail, w.userA]) expect((await patch(who, `/api/super/tenants/${w.a.id}`, { status: 'deactivated' })).status).toBe(403);
    expect((await patch(SUPER, `/api/super/tenants/${w.a.id}`, { status: 'banana' })).status).toBe(400);
    expect((await patch(SUPER, `/api/super/tenants/${w.a.id}`, { status: 'active' })).status).toBe(409); // already active
    expect((await patch(SUPER, `/api/super/tenants/${w.a.id}`, { status: 'deactivated' })).status).toBe(200);
    expect((await patch(SUPER, `/api/super/tenants/${w.a.id}`, { status: 'deactivated' })).status).toBe(409);
    await patch(SUPER, `/api/super/tenants/${w.a.id}`, { status: 'active' });
    const actions = (await platformAudit()).filter((e) => e.tenantId === w.a.id).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['tenant.disabled', 'tenant.reactivated']));
    const disabled = (await platformAudit()).find((e) => e.action === 'tenant.disabled' && e.tenantId === w.a.id)!;
    expect(disabled).toMatchObject({ actorEmail: SUPER, actorRole: 'super_admin' });
  });

  it('is not the same as a deletion request: a disabled workspace cannot be asked to delete, and vice versa', async () => {
    const w = await twoTenants();
    await patch(SUPER, `/api/super/tenants/${w.b.id}`, { status: 'deactivated' });
    expect((await post(w.b.adminEmail, '/api/tenant/deletion-request', { confirm: 'DELETE' })).status).toBe(403); // cannot even sign in
    expect((await post(w.a.adminEmail, '/api/tenant/deletion-request', { confirm: 'DELETE' })).status).toBe(200);
    expect((await patch(SUPER, `/api/super/tenants/${w.a.id}`, { status: 'deactivated' })).status).toBe(409);
  });
});

describe('deletion requests: confirm, review, reject, approve', () => {
  it('needs the typed word on the SERVER, then only marks the workspace', async () => {
    const w = await twoTenants();
    for (const body of [{}, { confirm: 'delete' }, { confirm: 'YES' }, { confirm: true }]) {
      const r = await post(w.a.adminEmail, '/api/tenant/deletion-request', body);
      expect([r.status, r.json.error], JSON.stringify(body)).toEqual([400, 'confirmation_required']);
    }
    expect(find(await listTenants(), w.a.id)?.status).toBe('active');
    const ok = await post<{ tenant: TenantDto }>(w.a.adminEmail, '/api/tenant/deletion-request', { confirm: 'DELETE' });
    expect(ok.status).toBe(200);
    expect(ok.json.tenant.status).toBe('deletion_requested');
    // Nothing was destroyed and everyone keeps working until the Super Admin decides.
    expect((await get(w.a.adminEmail, '/api/export')).text).toContain(SECRET_A);
    expect((await whoami(w.userA)).status).toBe(200);
  });

  it('the Super Admin sees it, can review metadata only, and can REJECT it: the workspace is simply active again', async () => {
    const w = await twoTenants();
    await post(w.a.adminEmail, '/api/tenant/deletion-request', { confirm: 'DELETE' });
    const list = await get<TenantListResult>(SUPER, '/api/super/tenants?status=deletion_requested');
    const row = find(list.json.tenants, w.a.id)!;
    expect(row).toMatchObject({ status: 'deletion_requested', adminEmail: w.a.adminEmail });
    expect(list.text).not.toContain(SECRET_A);

    // Not the Admin, not a User, not a stranger.
    for (const who of [w.a.adminEmail, w.userA, w.b.adminEmail]) expect((await post(who, `/api/super/tenants/${w.a.id}/reject-deletion`)).status).toBe(403);
    const rejected = await post<{ tenant: TenantDto }>(SUPER, `/api/super/tenants/${w.a.id}/reject-deletion`);
    expect(rejected.status).toBe(200);
    expect(rejected.json.tenant).toMatchObject({ status: 'active', deletionRequestedAt: null });
    expect((await post(SUPER, `/api/super/tenants/${w.a.id}/reject-deletion`)).status).toBe(409); // nothing left to reject
    expect((await get(w.a.adminEmail, '/api/export')).text).toContain(SECRET_A);
    expect((await platformAudit()).filter((e) => e.tenantId === w.a.id).map((e) => e.action)).toEqual(expect.arrayContaining(['tenant.deletion_requested', 'tenant.deletion_rejected']));
  });

  it('the Admin can withdraw it; the Super Admin cannot ask for deletion; approval needs both typed confirmations', async () => {
    const w = await twoTenants();
    expect((await post(SUPER, '/api/tenant/deletion-request', { confirm: 'DELETE' })).status).toBe(403);
    await post(w.a.adminEmail, '/api/tenant/deletion-request', { confirm: 'DELETE' });
    expect((await post(w.a.adminEmail, '/api/tenant/deletion-request/cancel', {})).status).toBe(200);
    expect((await get(w.a.adminEmail, '/api/tenant/audit')).json.audit as AdminAuditDto[]).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'tenant.deletion_cancelled' })]));

    await post(w.a.adminEmail, '/api/tenant/deletion-request', { confirm: 'DELETE' });
    expect((await post(SUPER, `/api/super/tenants/${w.a.id}/delete`, { confirmTenantId: w.a.id })).status).toBe(400);
    expect((await post(SUPER, `/api/super/tenants/${w.a.id}/delete`, { confirmTenantId: w.a.id, confirmAdminEmail: 'someone@else.co' })).status).toBe(400);
    expect(find(await listTenants(), w.a.id)?.status).toBe('deletion_requested');
    const done = await post<{ deleted: boolean; usersDeleted: number }>(SUPER, `/api/super/tenants/${w.a.id}/delete`, { confirmTenantId: w.a.id, confirmAdminEmail: w.a.adminEmail });
    expect(done.json).toMatchObject({ deleted: true, usersDeleted: 3 });
    expect(find(await listTenants(), w.a.id)).toBeUndefined();
    expect((await whoami(w.userA)).json.reason).toBe('unregistered');
    // The content-free history of what happened stays, and mentions no QA content.
    const trail = (await platformAudit()).filter((e) => e.tenantId === w.a.id);
    expect(trail.map((e) => e.action)).toEqual(expect.arrayContaining(['tenant.deletion_requested', 'tenant.deletion_approved', 'tenant.deleted']));
    expect(JSON.stringify(trail)).not.toContain(SECRET_A);
  });
});

describe('Admin: managing Users', () => {
  it('lists only their own Users, with display names and sign-in times', async () => {
    const w = await twoTenants();
    const named = rk('named');
    const made = await post<{ user: UserDto }>(w.a.adminEmail, '/api/tenant/users', { email: named, displayName: 'Mika Tanaka', access: 'viewer' });
    expect(made.status).toBe(201);
    expect(made.json.user).toMatchObject({ displayName: 'Mika Tanaka', status: 'active', access: 'viewer', role: 'user' });
    const inA = await listUsers(w.a.adminEmail);
    expect(inA.map((u) => u.email)).toEqual(expect.arrayContaining([w.a.adminEmail, w.userA, w.viewerA, named]));
    expect(inA.map((u) => u.email)).not.toContain(w.userB);
    expect(inA.every((u) => 'displayName' in u && 'createdAt' in u && 'updatedAt' in u && 'lastLoginAt' in u)).toBe(true);
  });

  it('refuses outside domains, duplicates, bad names and an unknown access level — and creates nothing', async () => {
    const w = await twoTenants();
    const before = await rowCount('users');
    const taken = w.userA;
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{ email: 'friend@gmail.com' }, 400, 'email_domain_not_allowed'],
      [{ email: taken.toUpperCase() }, 409, 'email_taken'],
      [{ email: w.userB }, 409, 'email_in_other_workspace'], // another workspace's account: a clear answer, but never whose
      [{ email: rk('x'), displayName: 'a<b' }, 400, 'invalid_display_name'],
      [{ email: rk('x'), access: 'owner' }, 400, 'invalid_input'],
      [{ email: '' }, 400, 'invalid_email'],
    ];
    for (const [body, status, error] of cases) {
      const r = await post(w.a.adminEmail, '/api/tenant/users', body);
      expect([r.status, r.json.error], JSON.stringify(body)).toEqual([status, error]);
    }
    expect(await rowCount('users')).toBe(before);
  });

  it('cannot create an Admin, move a User, name another workspace, or forge who is acting', async () => {
    const w = await twoTenants();
    const mail = rk('promo');
    const r = await post<{ user: UserDto }>(w.a.adminEmail, '/api/tenant/users', {
      email: mail,
      role: 'admin',
      isAdmin: true,
      actor: { email: SUPER, role: 'super_admin' },
      actorEmail: SUPER,
      actorRole: 'super_admin',
      createdBy: SUPER,
    });
    expect(r.status).toBe(201);
    expect(r.json.user.role).toBe('user');
    expect((await whoami(mail)).json).toMatchObject({ role: 'user', tenant: { id: w.a.id } });
    const entry = (await tenantAudit(w.a.adminEmail)).json.audit.find((e) => e.action === 'user.created' && e.targetEmail === mail)!;
    expect(entry).toMatchObject({ actorEmail: w.a.adminEmail, actorRole: 'admin', tenantId: w.a.id });
    expect(JSON.stringify(entry)).not.toContain(SUPER);
    expect((await post(w.a.adminEmail, '/api/tenant/users', { email: rk('m'), tenantId: w.b.id })).status).toBe(403);
    expect((await patch(w.a.adminEmail, `/api/tenant/users/${r.json.user.id}`, { tenantId: w.b.id, status: 'disabled' })).status).toBe(403);
  });

  it('disables and reactivates a User: API, new and open sockets are cut, the record and data stay, reactivation restores everything', async () => {
    const w = await twoTenants();
    const target = (await listUsers(w.a.adminEmail)).find((u) => u.email === w.userA)!;
    const live = await openSocket(w.userA);
    if (!live.ok) throw new Error('connect');

    const off = await patch<{ user: UserDto; disconnected: boolean }>(w.a.adminEmail, `/api/tenant/users/${target.id}`, { status: 'disabled' });
    expect(off.json).toMatchObject({ user: { status: 'disabled', email: w.userA, id: target.id }, disconnected: true });
    expect((await live.sock.closed).code).toBe(CLOSE_CODES.accessRevoked);
    expect((await whoami(w.userA)).json.reason).toBe('disabled');
    expect(await openSocket(w.userA)).toMatchObject({ ok: false, status: 403 });
    expect((await listUsers(w.a.adminEmail)).find((u) => u.id === target.id)).toMatchObject({ status: 'disabled', email: w.userA }); // the record is kept
    expect((await get(w.a.adminEmail, '/api/export')).text).toContain(SECRET_A); // and so is the workspace

    const on = await patch<{ user: UserDto }>(w.a.adminEmail, `/api/tenant/users/${target.id}`, { status: 'enabled' });
    expect(on.json.user.status).toBe('active');
    expect((await whoami(w.userA)).status).toBe(200);
    const back = await openSocket(w.userA);
    expect(back.ok).toBe(true);
    const actions = (await tenantAudit(w.a.adminEmail)).json.audit.filter((e) => e.targetId === target.id).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['user.disabled', 'user.reactivated']));
  });

  it('cannot touch another workspace’s User, an Admin (including themselves), or a malformed id', async () => {
    const w = await twoTenants();
    const otherUser = (await listUsers(w.b.adminEmail)).find((u) => u.email === w.userB)!;
    const adminA = (await listUsers(w.a.adminEmail)).find((u) => u.role === 'admin')!;
    const adminB = (await listUsers(w.b.adminEmail)).find((u) => u.role === 'admin')!;
    expect((await patch(w.a.adminEmail, `/api/tenant/users/${otherUser.id}`, { status: 'disabled' })).status).toBe(404);
    expect((await patch(w.a.adminEmail, `/api/tenant/users/${adminB.id}`, { status: 'disabled' })).status).toBe(404);
    expect((await patch(w.a.adminEmail, `/api/tenant/users/${adminA.id}`, { status: 'disabled' })).status).toBe(403); // cannot disable an Admin, even themselves
    expect((await patch(w.a.adminEmail, '/api/tenant/users/not-an-id', { status: 'disabled' })).status).toBe(400);
    expect((await whoami(w.userB)).status).toBe(200);
    expect((await whoami(w.b.adminEmail)).status).toBe(200);
    expect((await whoami(w.a.adminEmail)).status).toBe(200);
  });

  it('a Local-mode Admin cannot create Users', async () => {
    const t = await createTenant('Local only', rk('localadmin'));
    const r = await post(t.adminEmail, '/api/tenant/users', { email: rk('u') });
    expect(r.status).toBe(403);
    expect((await get(t.adminEmail, '/api/tenant/users')).status).toBe(403);
  });

  it('a User cannot create, change or list Users, and still has their normal data access', async () => {
    const w = await twoTenants();
    const victim = (await listUsers(w.a.adminEmail)).find((u) => u.email === w.viewerA)!;
    expect((await post(w.userA, '/api/tenant/users', { email: rk('z') })).status).toBe(403);
    expect((await patch(w.userA, `/api/tenant/users/${victim.id}`, { status: 'disabled' })).status).toBe(403);
    expect((await get(w.userA, '/api/tenant/users')).status).toBe(403);
    expect((await whoami(w.viewerA)).status).toBe(200);
    const mine = await get(w.userA, '/api/export');
    expect(mine.status).toBe(200);
    expect(mine.text).toContain(SECRET_A);
    expect((await get(w.userA, '/api/super/tenants')).status).toBe(403);
  });
});

describe('the administrative audit trail (not the QA revision history)', () => {
  it('an Admin sees their own workspace’s events and never another’s; a User and the Super Admin cannot use that view', async () => {
    const w = await twoTenants();
    await addUser(w.b, rk('only-in-b'));
    const a = await tenantAudit(w.a.adminEmail);
    const b = await tenantAudit(w.b.adminEmail);
    expect(a.status).toBe(200);
    expect(a.json.audit.every((e) => e.tenantId === w.a.id)).toBe(true);
    expect(a.json.audit.map((e) => e.action)).toEqual(expect.arrayContaining(['admin.created', 'storage.migration_uploaded', 'storage.web_activated', 'user.created']));
    expect(a.text).not.toContain(w.b.id);
    expect(a.text).not.toContain('only-in-b');
    expect(b.text).not.toContain(w.a.id);
    expect(a.json.audit.map((e) => e.id)).toEqual([...a.json.audit.map((e) => e.id)].sort((x, y) => y - x)); // newest first
    expect((await tenantAudit(w.userA)).status).toBe(403);
    expect((await tenantAudit(w.viewerA)).status).toBe(403);
    expect((await tenantAudit(SUPER)).status).toBe(403); // the Super Admin has no workspace
    expect((await tenantAudit(rk('stranger'))).status).toBe(403);
  });

  it('a forged tenant id cannot widen the view', async () => {
    const w = await twoTenants();
    expect((await call(w.a.adminEmail, 'GET', `/api/tenant/audit?tenantId=${w.b.id}`)).status).toBe(403);
    expect((await call(w.a.adminEmail, 'GET', '/api/tenant/audit', undefined, { 'x-gc-tenant': w.b.id })).status).toBe(403);
  });

  it('the platform view is for the Super Admin only and holds no account-level events of any workspace', async () => {
    const w = await twoTenants();
    expect((await get(w.a.adminEmail, '/api/super/admin-audit')).status).toBe(403);
    expect((await get(w.userA, '/api/super/admin-audit')).status).toBe(403);
    const log = await platformAudit();
    expect(log.length).toBeGreaterThan(0);
    expect(log.some((e) => e.action.startsWith('user.'))).toBe(false);
    expect(JSON.stringify(log)).not.toContain(w.userA);
  });

  it('cannot be written, changed or deleted through any route, and not even by code that reaches the database', async () => {
    const w = await twoTenants();
    const before = (await tenantAudit(w.a.adminEmail)).json.audit.length;
    for (const [method, path] of [
      ['POST', '/api/tenant/audit'],
      ['PUT', '/api/tenant/audit'],
      ['PATCH', '/api/tenant/audit'],
      ['DELETE', '/api/tenant/audit'],
      ['DELETE', '/api/tenant/audit/1'],
      ['POST', '/api/super/admin-audit'],
      ['DELETE', '/api/super/admin-audit'],
    ] as const) {
      const r = await call(method.startsWith('P') || method === 'DELETE' ? (path.startsWith('/api/super') ? SUPER : w.a.adminEmail) : w.a.adminEmail, method, path, { action: 'user.created', actorEmail: 'x@y.zz' });
      expect(r.status, `${method} ${path}`).toBeGreaterThanOrEqual(400);
    }
    expect((await tenantAudit(w.a.adminEmail)).json.audit).toHaveLength(before);
    await runInDurableObject(registry(), async (_i, state) => {
      expect(() => state.storage.sql.exec(`UPDATE admin_audit SET actor_email = 'x@y.zz'`)).toThrow(/append-only/);
      expect(() => state.storage.sql.exec(`DELETE FROM admin_audit`)).toThrow(/append-only/);
    });
  });

  it('never records secrets or workspace content: only names, counts and levels', async () => {
    const w = await twoTenants();
    const all = JSON.stringify((await tenantAudit(w.a.adminEmail)).json.audit) + JSON.stringify(await platformAudit());
    expect(all).not.toContain(SECRET_A);
    expect(all).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/); // no JWT-looking strings
    expect(all).not.toMatch(/cf-access|authorization|password/i);
    const upload = (await tenantAudit(w.a.adminEmail)).json.audit.find((e) => e.action === 'storage.migration_uploaded')!;
    expect(Object.keys(upload.meta).sort()).toEqual(['records', 'replaced', 'revision']);
  });
});

describe('accounts that predate Stage 7', () => {
  it('a stored "invited" account is shown and works as active; its first sign-in is simply a sign-in', async () => {
    const t = await createTenant('Old style', rk('old'));
    await runInDurableObject(registry(), async (_i, state) => {
      state.storage.sql.exec(`UPDATE users SET status = 'invited', last_login_at = NULL WHERE tenant_id = ? AND role = 'admin'`, t.id);
    });
    expect(find(await listTenants(), t.id)?.adminStatus).toBe('active');
    expect((await whoami(t.adminEmail)).status).toBe(200);
  });

  it('the legacy non-managed workspace stays intact: listed, flagged, usable, and its creation rules still hold for new accounts', async () => {
    const legacy = await createTenant('Legacy Gmail workspace', rk('legacy'));
    const gmail = `legacy-admin-${++n}@gmail.com`;
    await runInDurableObject(registry(), async (_i, state) => {
      state.storage.sql.exec(`UPDATE users SET email = ? WHERE tenant_id = ? AND role = 'admin'`, gmail, legacy.id);
    });
    expect(find(await listTenants(), legacy.id)).toMatchObject({ adminEmail: gmail, adminOutsideManagedDomains: true, status: 'active' });
    expect((await whoami(gmail)).status).toBe(200);
    expect((await post(SUPER, '/api/super/tenants', { name: 'Another gmail', adminEmail: `x-${++n}@gmail.com` })).status).toBe(400);
  });
});

describe('the sign-in entry and the shell identity', () => {
  it('whoami carries the display name for the header, and nothing internal', async () => {
    const mail = rk('shown');
    await post(SUPER, '/api/super/tenants', { name: 'Shown QA', adminEmail: mail, displayName: 'Yuki Ito' });
    const who = await whoami(mail);
    expect(who.json).toMatchObject({ email: mail, displayName: 'Yuki Ito', role: 'admin', tenant: { name: 'Shown QA', storageMode: 'local' } });
    expect(JSON.stringify(who.json)).not.toContain('usr_');
    expect((await whoami(SUPER)).json).toMatchObject({ role: 'super_admin', displayName: null, tenant: null });
    const res = await exports.default.fetch(new Request(`${BASE}/api/whoami`, { headers: { 'x-dev-email': mail } }));
    expect(res.status).toBe(200);
  });
});

describe('the Tester account model (the Tester is the stored role "user")', () => {
  it('Admin adds a Tester by email; the Tester later signs in with that address and lands in THAT workspace automatically', async () => {
    const w = await twoTenants();
    const mail = rk('tester');
    const made = await post<{ user: UserDto }>(w.a.adminEmail, '/api/tenant/users', { email: mail, displayName: 'Hana Sato', access: 'editor' });
    expect(made.status).toBe(201);
    expect(made.json.user).toMatchObject({ role: 'user', status: 'active', displayName: 'Hana Sato' });

    // Later, on first sign-in: the registry matches the verified email and puts them in the Admin's workspace.
    const who = await whoami(mail);
    expect(who.status).toBe(200);
    expect(who.json).toMatchObject({ role: 'user', displayName: 'Hana Sato', tenant: { id: w.a.id }, sharedWorkspace: true });
    const sock = await openSocket(mail);
    expect(sock.ok).toBe(true);
    expect((await get(mail, '/api/export')).text).toContain(SECRET_A);
    expect((await get(mail, '/api/export')).text).not.toContain('BETA-CONFIDENTIAL');
  });

  it('the tenant is assigned by the server only: the browser cannot choose one, name one, or move a Tester afterwards', async () => {
    const w = await twoTenants();
    const mail = rk('bound');
    expect((await post(w.a.adminEmail, '/api/tenant/users', { email: mail, tenantId: w.b.id })).status).toBe(403);
    expect((await call(w.a.adminEmail, 'POST', `/api/tenant/users?workspaceId=${w.b.id}`, { email: mail })).status).toBe(403);
    const ok = await post<{ user: UserDto }>(w.a.adminEmail, '/api/tenant/users', { email: mail });
    expect(ok.status).toBe(201);
    // There is no way to move or re-assign: every attempt is refused and the Tester stays where they were created.
    for (const body of [{ tenantId: w.b.id }, { tenant_id: w.b.id }, { status: 'enabled', tenantId: w.b.id }]) {
      expect((await patch(w.a.adminEmail, `/api/tenant/users/${ok.json.user.id}`, body)).status).toBe(403);
      expect((await patch(w.b.adminEmail, `/api/tenant/users/${ok.json.user.id}`, { status: 'disabled' })).status).toBe(404); // not B's to touch
    }
    expect((await whoami(mail)).json.tenant?.id).toBe(w.a.id);
  });

  it('an address that belongs to ANOTHER workspace is refused with its own clear answer; nothing is moved or duplicated', async () => {
    const w = await twoTenants();
    const before = await rowCount('users');
    for (const taken of [w.userB, w.userB.toUpperCase(), w.b.adminEmail]) {
      const r = await post(w.a.adminEmail, '/api/tenant/users', { email: taken });
      expect([r.status, r.json.error], taken).toEqual([409, 'email_in_other_workspace']);
      // The answer says it belongs elsewhere — never whose.
      expect(r.text).not.toContain(w.b.id);
      expect(r.text).not.toContain(w.b.name);
      expect(r.text).not.toContain(w.b.adminEmail);
    }
    expect(await rowCount('users')).toBe(before);
    expect((await whoami(w.userB)).json.tenant?.id).toBe(w.b.id);
    expect((await whoami(w.b.adminEmail)).json).toMatchObject({ role: 'admin', tenant: { id: w.b.id } });
    expect((await listUsers(w.a.adminEmail)).map((u) => u.email)).not.toContain(w.userB);
  });

  it('an address already in the SAME workspace is a duplicate (Tester or the Admin’s own)', async () => {
    const w = await twoTenants();
    for (const dup of [w.userA, w.userA.toUpperCase(), ` ${w.viewerA} `, w.a.adminEmail]) {
      const r = await post(w.a.adminEmail, '/api/tenant/users', { email: dup });
      expect([r.status, r.json.error], dup).toEqual([409, 'email_taken']);
    }
  });

  it('only Web-mode Admins can add Testers; a Local-mode Admin cannot', async () => {
    const t = await createTenant('Local workspace', rk('localadmin'));
    expect((await post(t.adminEmail, '/api/tenant/users', { email: rk('x') })).status).toBe(403);
    await activateWeb(t, [rec('project', 'p')]);
    expect((await post(t.adminEmail, '/api/tenant/users', { email: rk('x') })).status).toBe(201);
  });

  it('nobody becomes a Tester just by being authenticated, and there is no public or code-based way in', async () => {
    const w = await twoTenants();
    const stranger = rk('stranger');
    const before = await rowCount('users');
    expect((await whoami(stranger)).json.reason).toBe('unregistered');
    expect((await whoami(stranger)).json.reason).toBe('unregistered');
    for (const path of ['/api/register', '/api/signup', '/api/join', '/api/invite', '/api/tenant/join', '/api/tenant/invite', '/api/tenant/accept']) {
      const r = await post(stranger, path, { email: stranger, code: 'ABC', tenantId: w.a.id, inviteCode: 'ABC' });
      expect(r.status, path).toBeGreaterThanOrEqual(403);
    }
    expect(await rowCount('users')).toBe(before);
  });

  it('a disabled Tester cannot reach the workspace or reconnect, yet stays in the history and audit trail', async () => {
    const w = await twoTenants();
    const mail = rk('leaver');
    const made = await post<{ user: UserDto }>(w.a.adminEmail, '/api/tenant/users', { email: mail, displayName: 'Ken Mori' });
    const live = await openSocket(mail);
    if (!live.ok) throw new Error('connect');
    await patch(w.a.adminEmail, `/api/tenant/users/${made.json.user.id}`, { status: 'disabled' });
    expect((await live.sock.closed).code).toBe(CLOSE_CODES.accessRevoked);
    expect(await openSocket(mail)).toMatchObject({ ok: false, status: 403 });
    expect((await get(mail, '/api/export')).status).toBe(403);
    // Still in the list (with their name), and still named in the administration history.
    expect((await listUsers(w.a.adminEmail)).find((u) => u.id === made.json.user.id)).toMatchObject({ status: 'disabled', displayName: 'Ken Mori', email: mail });
    const actions = (await tenantAudit(w.a.adminEmail)).json.audit.filter((e) => e.targetEmail === mail).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['user.created', 'user.disabled']));
    // Reactivation brings the same account back, in the same workspace.
    await patch(w.a.adminEmail, `/api/tenant/users/${made.json.user.id}`, { status: 'enabled' });
    expect((await whoami(mail)).json).toMatchObject({ role: 'user', tenant: { id: w.a.id } });
    expect((await openSocket(mail)).ok).toBe(true);
  });
});

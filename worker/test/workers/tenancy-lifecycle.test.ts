import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { PrincipalDto, UserDto } from '../../../shared/tenancy';
import { CLOSE_CODES } from '../../../shared/tenancy';
import { SECRET_A, SUPER, activateWeb, addUser, createTenant, deactivate, email, get, openSocket, patch, post, rec, twoTenants, whoami } from './tenancy-harness';
import { workspaceFor } from './helpers';

const listUsers = async (adminEmail: string) => (await get<{ users: UserDto[] }>(adminEmail, '/api/tenant/users')).json.users;

describe('disabled users', () => {
  it('lose all access immediately: API, new sockets and the sockets they already have open', async () => {
    const w = await twoTenants();
    const live = await openSocket(w.userA);
    if (!live.ok) throw new Error('should connect while enabled');
    await live.sock.next('snapshot');

    const victim = (await listUsers(w.a.adminEmail)).find((u) => u.email === w.userA)!;
    const r = await patch<{ user: UserDto; disconnected: boolean }>(w.a.adminEmail, `/api/tenant/users/${victim.id}`, { status: 'disabled' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ user: { status: 'disabled' }, disconnected: true });

    expect((await live.sock.closed).code).toBe(CLOSE_CODES.accessRevoked);
    const who = await whoami(w.userA);
    expect(who.status).toBe(403);
    expect(who.json).toMatchObject({ reason: 'disabled' });
    expect((await get(w.userA, '/api/export')).status).toBe(403);
    expect(await openSocket(w.userA)).toMatchObject({ ok: false, status: 403 });
    // Everyone else in the tenant, and the other tenant, is unaffected.
    expect((await whoami(w.a.adminEmail)).status).toBe(200);
    expect((await whoami(w.userB)).status).toBe(200);
  });

  it('are restored when re-enabled', async () => {
    const w = await twoTenants();
    const u = (await listUsers(w.a.adminEmail)).find((x) => x.email === w.userA)!;
    await patch(w.a.adminEmail, `/api/tenant/users/${u.id}`, { status: 'disabled' });
    expect((await whoami(w.userA)).status).toBe(403);
    await patch(w.a.adminEmail, `/api/tenant/users/${u.id}`, { status: 'enabled' });
    expect((await whoami(w.userA)).status).toBe(200);
  });

  it('changing a user’s access closes their connection so the new level applies on reconnect', async () => {
    const w = await twoTenants();
    const live = await openSocket(w.userA);
    if (!live.ok) throw new Error('connect');
    expect(live.ready).toMatchObject({ you: { role: 'editor' } });
    const u = (await listUsers(w.a.adminEmail)).find((x) => x.email === w.userA)!;
    await patch(w.a.adminEmail, `/api/tenant/users/${u.id}`, { access: 'viewer' });
    expect((await live.sock.closed).code).toBe(CLOSE_CODES.accessRevoked);
    const again = await openSocket(w.userA);
    if (!again.ok) throw new Error('reconnect');
    expect(again.ready).toMatchObject({ you: { role: 'viewer' } });
  });
});

describe('deactivated tenants', () => {
  it('refuse EVERYONE in them, close their sockets, and come back on reactivation; other tenants never notice', async () => {
    const w = await twoTenants();
    const live = await openSocket(w.userA);
    if (!live.ok) throw new Error('connect');
    const r = await patch(SUPER, `/api/super/tenants/${w.a.id}`, { status: 'deactivated' });
    expect(r.status).toBe(200);
    expect((await live.sock.closed).code).toBe(CLOSE_CODES.accessRevoked);
    for (const who of [w.a.adminEmail, w.userA, w.viewerA]) {
      const res = await whoami(who);
      expect(res.status).toBe(403);
      expect(res.json).toMatchObject({ reason: 'tenant_inactive' });
    }
    expect((await whoami(w.b.adminEmail)).status).toBe(200);
    expect((await patch(SUPER, `/api/super/tenants/${w.a.id}`, { status: 'active' })).status).toBe(200);
    expect((await whoami(w.userA)).status).toBe(200);
  });

  it('can only be (de)activated by the Super Admin, with a valid status and id', async () => {
    const w = await twoTenants();
    expect((await patch(w.a.adminEmail, `/api/super/tenants/${w.a.id}`, { status: 'deactivated' })).status).toBe(403);
    expect((await patch(SUPER, `/api/super/tenants/${w.a.id}`, { status: 'deleted' })).status).toBe(400);
    expect((await patch(SUPER, '/api/super/tenants/not-an-id', { status: 'active' })).status).toBe(400);
    expect((await patch(SUPER, '/api/super/tenants/ten_00000000-0000-0000-0000-000000000000', { status: 'active' })).status).toBe(404);
  });
});

describe('user management (Admin of a WEB workspace)', () => {
  it('creates active users bound to the admin’s tenant (there is no invited state)', async () => {
    const w = await twoTenants();
    const e = email('fresh');
    const created = await post<{ user: UserDto }>(w.a.adminEmail, '/api/tenant/users', { email: e.toUpperCase(), access: 'viewer' });
    expect(created.status).toBe(201);
    expect(created.json.user).toMatchObject({ email: e, role: 'user', access: 'viewer', status: 'active' });
    expect(created.json.user.id).toMatch(/^usr_/);
    expect((await whoami(e)).json).toMatchObject({ role: 'user', access: 'viewer' });
    expect((await listUsers(w.a.adminEmail)).find((u) => u.email === e)).toMatchObject({ status: 'active' });
  });

  it('validates input: bad email, duplicate, unknown access, malformed ids', async () => {
    const w = await twoTenants();
    expect((await post(w.a.adminEmail, '/api/tenant/users', { email: 'nonsense' })).status).toBe(400);
    expect((await post(w.a.adminEmail, '/api/tenant/users', {})).status).toBe(400);
    expect((await post(w.a.adminEmail, '/api/tenant/users', { email: w.userA })).status).toBe(409);
    expect((await post(w.a.adminEmail, '/api/tenant/users', { email: email('x'), access: 'owner' })).status).toBe(400);
    expect((await patch(w.a.adminEmail, '/api/tenant/users/../../x', { status: 'disabled' })).status).toBe(404);
    expect((await patch(w.a.adminEmail, '/api/tenant/users/usr_nope', { status: 'disabled' })).status).toBe(400);
  });

  it('the admin account itself cannot be changed through user management', async () => {
    const w = await twoTenants();
    const admin = (await listUsers(w.a.adminEmail)).find((u) => u.role === 'admin')!;
    expect((await patch(w.a.adminEmail, `/api/tenant/users/${admin.id}`, { status: 'disabled' })).status).toBe(409);
    expect((await whoami(w.a.adminEmail)).status).toBe(200);
  });

  it('a disabled admin-of-nothing: users cannot manage users, whatever they send', async () => {
    const w = await twoTenants();
    const e = email('sneaky');
    expect((await post(w.userA, '/api/tenant/users', { email: e })).status).toBe(403);
    expect((await whoami(e)).status).toBe(403);
  });
});

describe('a LOCAL-mode workspace has no shared users and no shared data', () => {
  it('cannot create users, open a socket or read cloud data, but the admin still signs in', async () => {
    const t = await createTenant('Local QA', email('admin-local'));
    const who = await whoami(t.adminEmail);
    expect(who.json).toMatchObject({ role: 'admin', sharedWorkspace: false, workspaceRole: null, tenant: { storageMode: 'local' } });

    // Refused by the permission layer first (an Admin of a local workspace does not hold users.manage);
    // the registry's own wrong_mode check is the second line and is covered by its unit tests.
    const r = await post(t.adminEmail, '/api/tenant/users', { email: email('u') });
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ error: 'forbidden', action: 'users.manage' });
    expect((await whoami(email('never-created'))).status).toBe(403);
    expect((await get(t.adminEmail, '/api/tenant/users')).status).toBe(403);
    expect((await get(t.adminEmail, '/api/export')).status).toBe(403);
    expect(await openSocket(t.adminEmail)).toMatchObject({ ok: false, status: 403 });
  });

  it('users that somehow belong to a tenant that is (now) local are refused', async () => {
    const w = await twoTenants();
    // Move A back to local the proper way, then its users must be locked out.
    const exp = await get<{ revision: number; hash: string }>(w.a.adminEmail, '/api/export');
    expect((await deactivate(w.a.adminEmail, exp.json.revision, exp.json.hash)).status).toBe(200);
    const res = await whoami(w.userA);
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ reason: 'workspace_not_shared' });
    expect((await whoami(w.a.adminEmail)).status).toBe(200); // the admin keeps working locally
  });
});

describe('defence in depth: the workspace object enforces its own tenant', () => {
  it('refuses an RPC that names a different tenant, even from inside the Worker', async () => {
    const w = await twoTenants();
    const a = workspaceFor(w.a.id);
    await expect(a.stub.exportAll(w.b.id)).rejects.toThrow(/tenant mismatch/);
    await expect(a.stub.listRevisions(w.b.id, 10)).rejects.toThrow(/tenant mismatch/);
    await expect(a.stub.restoreRevision(w.b.id, 1, 'x@y.zz')).rejects.toThrow(/tenant mismatch/);
    await expect(a.stub.importWorkspace(w.b.id, { migrationId: 'm', records: [], expectedRevision: 0, replace: true, actor: 'x@y.zz' })).rejects.toThrow(/tenant mismatch/);
    await expect(a.stub.disconnectAll(w.b.id, 4403, 'x')).rejects.toThrow(/tenant mismatch/);
    await expect(a.stub.destroy(w.b.id)).rejects.toThrow(/tenant mismatch/);
    expect((await get(w.b.adminEmail, '/api/export')).text).toContain('BETA-CONFIDENTIAL');
  });

  it('refuses to be driven with a different tenant in the upgrade headers', async () => {
    const w = await twoTenants();
    const res = await env.WORKSPACE.getByName(w.a.id).fetch(
      new Request('http://localhost/ws', {
        headers: { Upgrade: 'websocket', 'x-gc-tenant': w.b.id, 'x-gc-user': 'usr_x', 'x-gc-verified-email': 'x@y.zz', 'x-gc-verified-role': 'admin' },
      }),
    );
    expect(res.status).toBe(403);
  });

  it('a tenant’s own object will not act as the legacy workspace', async () => {
    const w = await twoTenants();
    await expect(workspaceFor(w.a.id).stub.exportLegacy()).rejects.toThrow(/not the legacy workspace/);
  });

  it('an object that is not addressed by a tenant id serves no tenant operation at all', async () => {
    const stray = env.WORKSPACE.getByName('workspace');
    await expect(stray.exportAll('ten_00000000-0000-0000-0000-000000000000')).rejects.toThrow();
  });
});

describe('sanity of the seeded data used above', () => {
  it('tenant A really holds the marker', async () => {
    const t = await createTenant('Marker', email('m'));
    await activateWeb(t, [rec('project', 'p', { name: SECRET_A })]);
    await addUser(t, email('mu'));
    expect((await get(t.adminEmail, '/api/export')).text).toContain(SECRET_A);
  });
});

type _Unused = PrincipalDto;

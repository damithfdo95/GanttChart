import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { TenantSummaryDto, UserDto } from '../../../shared/tenancy';
import { BASE, SUPER, activateWeb, addUser, call, createTenant, get, listTenants, patch, post, rec, twoTenants, whoami } from './tenancy-harness';

/**
 * Stage 6: the account-creation hierarchy (Super Admin -> Admin -> User), the
 * managed-organisation-domain rule (wrangler.test.jsonc: rakuten.com, example.com,
 * tenant.test ...), and "authenticated is not provisioned". Everything goes
 * through the real Worker entry; nothing is mocked.
 */

let n = 0;
const rk = (label: string): string => `${label}-${++n}-${crypto.randomUUID().slice(0, 6)}@rakuten.com`;

async function registryCounts(): Promise<{ users: number; tenants: number }> {
  const stub = env.REGISTRY.getByName('registry');
  return runInDurableObject(stub, async (_instance, state) => ({
    users: state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM users').one().n,
    tenants: state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM tenants').one().n,
  }));
}

describe('only the Super Admin creates Admins, and only for managed domains', () => {
  it('creates an Admin for a managed address, normalised', async () => {
    const mixed = `Boss-${n++}@Rakuten.COM`;
    const r = await post<{ tenant: { id: string }; admin: UserDto }>(SUPER, '/api/super/tenants', { name: 'Rakuten QA', adminEmail: ` ${mixed} ` });
    expect(r.status).toBe(201);
    expect(r.json.admin.email).toBe(mixed.toLowerCase());
    expect(r.json.admin.role).toBe('admin');
  });

  it('rejects an outside address with a clear error and creates NO tenant (atomic)', async () => {
    const before = await registryCounts();
    for (const bad of ['person@gmail.com', 'user@fake-rakuten.com', 'user@rakuten.com.attacker.example', 'user@sub.rakuten.com', 'user@rakuten.co']) {
      const r = await post(SUPER, '/api/super/tenants', { name: 'Nope', adminEmail: bad });
      expect(r.status, bad).toBe(400);
      expect(r.json).toMatchObject({ error: 'email_domain_not_allowed' });
    }
    expect(await registryCounts()).toEqual(before);
    expect((await listTenants()).some((t) => t.name === 'Nope')).toBe(false);
  });

  it('an Admin cannot create another Admin or tenant; a User cannot either', async () => {
    const w = await twoTenants();
    expect((await post(w.a.adminEmail, '/api/super/tenants', { name: 'X', adminEmail: rk('x') })).status).toBe(403);
    expect((await post(w.userA, '/api/super/tenants', { name: 'X', adminEmail: rk('x') })).status).toBe(403);
    expect((await get(w.a.adminEmail, '/api/super/tenants')).status).toBe(403);
  });

  it('the Super Admin address itself needs no managed domain (it is configuration, not a registry account)', async () => {
    const who = await whoami(SUPER); // super@dev.test is in no managed domain
    expect(who.status).toBe(200);
    expect(who.json.role).toBe('super_admin');
    // ... and it cannot be turned into a registry Admin either.
    expect((await post(SUPER, '/api/super/tenants', { name: 'X', adminEmail: SUPER })).status).toBeGreaterThanOrEqual(400);
  });
});

describe('only a tenant Admin creates Users, inside their own tenant, for managed domains', () => {
  it('creates managed Users (normalised) and rejects outside addresses without creating anything', async () => {
    const w = await twoTenants();
    const before = await registryCounts();
    for (const bad of ['friend@gmail.com', 'user@fake-rakuten.com', 'user@rakuten.com.attacker.example', 'user@sub.rakuten.com']) {
      const r = await post(w.a.adminEmail, '/api/tenant/users', { email: bad, access: 'editor' });
      expect(r.status, bad).toBe(400);
      expect(r.json).toMatchObject({ error: 'email_domain_not_allowed' });
    }
    expect(await registryCounts()).toEqual(before);

    const ok = await post<{ user: UserDto }>(w.a.adminEmail, '/api/tenant/users', { email: `  New.${n++}@RAKUTEN.com `, access: 'viewer' });
    expect(ok.status).toBe(201);
    expect(ok.json.user).toMatchObject({ role: 'user', access: 'viewer' });
    expect(ok.json.user.email).toBe(ok.json.user.email.toLowerCase());
  });

  it('a User cannot create a User (or an Admin)', async () => {
    const w = await twoTenants();
    const r = await post(w.userA, '/api/tenant/users', { email: rk('x'), access: 'editor' });
    expect(r.status).toBe(403);
    expect((await post(w.viewerA, '/api/tenant/users', { email: rk('x'), access: 'editor' })).status).toBe(403);
  });

  it('a body can name only the product roles (sv, tester): the internal role name or any other field cannot create an SV', async () => {
    const w = await twoTenants();
    const email = rk('sneaky');
    expect((await post(w.a.adminEmail, '/api/tenant/users', { email, access: 'editor', role: 'admin' })).status).toBe(400);
    expect((await post(w.a.adminEmail, '/api/tenant/users', { email, access: 'editor', role: 'super_admin' })).status).toBe(400);
    const r = await post<{ user: UserDto }>(w.a.adminEmail, '/api/tenant/users', { email, access: 'editor', isAdmin: true, tenantRole: 'admin' });
    expect(r.status).toBe(201);
    expect(r.json.user.role).toBe('user');
    expect((await whoami(email)).json.role).toBe('user');
  });

  it('the new User belongs to the creating Admin only: the tenant comes from the principal, never the request', async () => {
    const w = await twoTenants();
    const email = rk('bound');
    expect((await post(w.a.adminEmail, '/api/tenant/users', { email, access: 'editor' })).status).toBe(201);
    const inA = (await get<{ users: UserDto[] }>(w.a.adminEmail, '/api/tenant/users')).json.users.map((u) => u.email);
    const inB = (await get<{ users: UserDto[] }>(w.b.adminEmail, '/api/tenant/users')).json.users.map((u) => u.email);
    expect(inA).toContain(email);
    expect(inB).not.toContain(email);
    expect((await whoami(email)).json.tenant?.id).toBe(w.a.id);
  });

  it('naming another tenant (body, query or header) cannot get a user into it — nor bypass the domain rule', async () => {
    const w = await twoTenants();
    const before = await registryCounts();
    const forged = [
      await post(w.a.adminEmail, '/api/tenant/users', { email: rk('f1'), access: 'editor', tenantId: w.b.id }),
      await post(w.a.adminEmail, '/api/tenant/users', { email: 'f2@gmail.com', access: 'editor', tenantId: w.b.id }),
      await call(w.a.adminEmail, 'POST', `/api/tenant/users?tenantId=${w.b.id}`, { email: rk('f3'), access: 'editor' }),
      await call(w.a.adminEmail, 'POST', '/api/tenant/users', { email: rk('f4'), access: 'editor' }, { 'x-gc-tenant': w.b.id }),
    ];
    for (const r of forged) expect(r.status).toBe(403);
    expect(forged[0].json).toMatchObject({ error: 'tenant_mismatch' });
    expect(await registryCounts()).toEqual(before);
    // The same forged body with the admin's OWN tenant id still has to pass the domain rule.
    const own = await post(w.a.adminEmail, '/api/tenant/users', { email: 'f5@gmail.com', access: 'editor', tenantId: w.a.id });
    expect(own.status).toBe(400);
    expect(own.json).toMatchObject({ error: 'email_domain_not_allowed' });
  });

  it('users can only be created in a web-mode tenant', async () => {
    const t = await createTenant('Local only', rk('localadmin'));
    const r = await post(t.adminEmail, '/api/tenant/users', { email: rk('u'), access: 'editor' });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });
});

describe('Cloudflare authentication is not GanttChart authorization', () => {
  it('an authenticated Rakuten employee with no account is denied — and is NOT provisioned by trying', async () => {
    const stranger = rk('stranger');
    const before = await registryCounts();
    for (let i = 0; i < 3; i++) {
      const who = await whoami(stranger);
      expect(who.status).toBe(403);
      expect(who.json).toMatchObject({ error: 'forbidden', reason: 'unregistered' });
    }
    for (const [method, path] of [
      ['GET', '/api/tenant'],
      ['GET', '/api/export'],
      ['GET', '/api/tenant/users'],
      ['GET', '/api/revisions'],
      ['GET', '/api/super/tenants'],
      ['POST', '/api/tenant/users'],
      ['POST', '/api/super/tenants'],
    ] as const) {
      const r = await call(stranger, method, path, method === 'POST' ? { email: rk('z'), access: 'editor', name: 'x', adminEmail: rk('z') } : undefined);
      expect(r.status, `${method} ${path}`).toBe(403);
    }
    expect(await registryCounts()).toEqual(before);
    // Still unknown afterwards.
    expect((await whoami(stranger)).json.reason).toBe('unregistered');
  });

  it('the denial reveals nothing about tenants, admins or other people', async () => {
    const w = await twoTenants();
    const who = await whoami(rk('nobody'));
    const text = JSON.stringify(who.json);
    expect(Object.keys(who.json).sort()).toEqual(['email', 'error', 'reason']);
    for (const secret of [w.a.id, w.b.id, w.a.adminEmail, w.b.adminEmail, w.a.name, w.b.name]) expect(text).not.toContain(secret);
  });

  it('registered active Super Admin, Admin and User are accepted with their own roles', async () => {
    const w = await twoTenants();
    expect((await whoami(SUPER)).json).toMatchObject({ role: 'super_admin', tenant: null });
    expect((await whoami(w.a.adminEmail)).json).toMatchObject({ role: 'admin', tenant: { id: w.a.id } });
    expect((await whoami(w.userA)).json).toMatchObject({ role: 'user', tenant: { id: w.a.id } });
  });

  it('a disabled User and a User of a deactivated tenant are denied', async () => {
    const w = await twoTenants();
    const users = (await get<{ users: UserDto[] }>(w.a.adminEmail, '/api/tenant/users')).json.users;
    const target = users.find((u) => u.email === w.userA)!;
    expect((await patch(w.a.adminEmail, `/api/tenant/users/${target.id}`, { status: 'disabled' })).status).toBe(200);
    expect((await whoami(w.userA)).json).toMatchObject({ reason: 'disabled' });

    expect((await patch(SUPER, `/api/super/tenants/${w.b.id}`, { status: 'deactivated' })).status).toBe(200);
    expect((await whoami(w.b.adminEmail)).json).toMatchObject({ reason: 'tenant_inactive' });
    expect((await whoami(w.userB)).json).toMatchObject({ reason: 'tenant_inactive' });
  });

  it('a successful first sign-in only activates an account that already exists', async () => {
    const t = await createTenant('Invited', rk('invited'));
    const before = await registryCounts();
    expect((await whoami(t.adminEmail)).status).toBe(200);
    expect(await registryCounts()).toEqual(before);
  });
});

describe('accounts that predate the managed-domain rule', () => {
  it('stay usable and visible (flagged for the Super Admin); nothing is deleted or deactivated', async () => {
    const legacy = await createTenant('Legacy test workspace', rk('legacy'));
    const other = await createTenant('Compliant workspace', rk('compliant'));
    // Make the first admin look like an older, non-Rakuten account (as created before the rule existed).
    const gmail = `legacy-admin-${n++}@gmail.com`;
    await runInDurableObject(env.REGISTRY.getByName('registry'), async (_i, state) => {
      state.storage.sql.exec(`UPDATE users SET email = ? WHERE tenant_id = ? AND role = 'admin'`, gmail, legacy.id);
    });

    const list = await listTenants();
    const byId = new Map<string, TenantSummaryDto>(list.map((t) => [t.id, t]));
    expect(byId.get(legacy.id)).toMatchObject({ adminEmail: gmail, adminOutsideManagedDomains: true, status: 'active' });
    expect(byId.get(other.id)).toMatchObject({ adminOutsideManagedDomains: false });

    // Still authenticates (the Access policy decides whether they can even reach the Worker) ...
    const who = await whoami(gmail);
    expect(who.status).toBe(200);
    expect(who.json).toMatchObject({ role: 'admin', tenant: { id: legacy.id } });
    // ... but cannot add a non-managed user, and deletion stays an explicit, separate workflow.
    await activateWeb({ ...legacy, adminEmail: gmail }, [rec('project', 'p1')]);
    expect((await post(gmail, '/api/tenant/users', { email: 'friend@gmail.com', access: 'editor' })).status).toBe(400);
    expect((await addUser({ ...legacy, adminEmail: gmail }, rk('colleague'))).role).toBe('user');
    expect((await listTenants()).find((t) => t.id === legacy.id)?.status).toBe('active');
  });
});

describe('the sign-in entry point', () => {
  it('/login sends a signed-in person to the app root and never anywhere else', async () => {
    const res = await exports.default.fetch(new Request(`${BASE}/login`, { headers: { 'x-dev-email': SUPER }, redirect: 'manual' }));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
  });

  it('ignores any redirect-looking parameter (no open redirect) and refuses other methods', async () => {
    const res = await exports.default.fetch(new Request(`${BASE}/login?next=https://evil.example&redirect=//evil.example&returnTo=/api`, { headers: { 'x-dev-email': SUPER }, redirect: 'manual' }));
    expect(res.headers.get('location')).toBe('/');
    const post405 = await exports.default.fetch(new Request(`${BASE}/login`, { method: 'POST', headers: { 'x-dev-email': SUPER, Origin: BASE }, redirect: 'manual' }));
    expect(post405.status).toBe(405);
  });
});

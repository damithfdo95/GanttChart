import { describe, expect, it } from 'vitest';
import { SECRET_A, SECRET_B, addUser, call, createTenant, activateWeb, email, get, listTenants, openSocket, patch, post, rec, twoTenants, whoami, SUPER } from './tenancy-harness';
import { commitMsg } from './helpers';
import type { PrincipalDto } from '../../../shared/tenancy';

/**
 * Tenant isolation. Each test tries to cross from tenant A into tenant B (or
 * to act without being known at all) and must fail — through the real Worker.
 */

describe('authenticated is not authorized: unknown identities fail closed', () => {
  it('an email the registry has never heard of gets nothing, anywhere', async () => {
    const stranger = email('stranger');
    for (const path of ['/api/whoami', '/api/export', '/api/revisions', '/api/tenant', '/api/tenant/users', '/api/super/tenants']) {
      const r = await get(stranger, path);
      expect(r.status, path).toBe(403);
      expect(r.json).toMatchObject({ error: 'forbidden', reason: 'unregistered' });
    }
    const ws = await openSocket(stranger);
    expect(ws).toMatchObject({ ok: false, status: 403 });
  });

  it('an unregistered person cannot create anything either', async () => {
    const stranger = email('stranger');
    expect((await post(stranger, '/api/super/tenants', { name: 'Evil', adminEmail: email('x') })).status).toBe(403);
    expect((await post(stranger, '/api/tenant/users', { email: email('x') })).status).toBe(403);
    expect((await post(stranger, '/api/tenant/storage/upload', { migrationId: 'm', expectedRevision: 0, records: [] })).status).toBe(403);
  });

  it('the response never reveals anything about other people or tenants', async () => {
    const w = await twoTenants();
    const r = await get(email('stranger'), '/api/tenant');
    expect(r.text).not.toContain(w.a.id);
    expect(r.text).not.toContain(w.a.adminEmail);
  });
});

describe('Admin A cannot reach tenant B', () => {
  it('sees only their own data through every read path', async () => {
    const w = await twoTenants();
    const exp = await get<{ records: { id: string; json: string }[] }>(w.a.adminEmail, '/api/export');
    expect(exp.status).toBe(200);
    expect(exp.text).toContain(SECRET_A);
    expect(exp.text).not.toContain(SECRET_B);
    const revs = await get<{ revision: number; records: { json: string }[] }>(w.a.adminEmail, '/api/revisions/1');
    expect(revs.text).toContain(SECRET_A);
    expect(revs.text).not.toContain(SECRET_B);
    expect((await whoami(w.a.adminEmail)).json.tenant?.id).toBe(w.a.id);
    expect((await whoami(w.a.adminEmail)).text).not.toContain(w.b.id);
  });

  it('a record id that exists in BOTH tenants always resolves to the caller’s own copy', async () => {
    const w = await twoTenants();
    const a = await get<{ records: { id: string; json: string }[] }>(w.a.adminEmail, '/api/export');
    const b = await get<{ records: { id: string; json: string }[] }>(w.b.adminEmail, '/api/export');
    expect(a.json.records.find((r) => r.id === 'shared-id')?.json).toContain(`${SECRET_A}-shared`);
    expect(b.json.records.find((r) => r.id === 'shared-id')?.json).toContain(`${SECRET_B}-shared`);
  });

  it('cannot manage tenant B’s users, even knowing their ids', async () => {
    const w = await twoTenants();
    const bUsers = (await get<{ users: { id: string; email: string }[] }>(w.b.adminEmail, '/api/tenant/users')).json.users;
    const victim = bUsers.find((u) => u.email === w.userB)!;
    // A's admin tries to disable B's user by id.
    const r = await patch(w.a.adminEmail, `/api/tenant/users/${victim.id}`, { status: 'disabled' });
    expect(r.status).toBe(404);
    expect((await whoami(w.userB)).status).toBe(200); // B's user is untouched
    // A's user list never shows B's people.
    const aUsers = await get(w.a.adminEmail, '/api/tenant/users');
    expect(aUsers.text).not.toContain(w.userB);
    expect(aUsers.text).not.toContain(w.b.adminEmail);
  });

  it('cannot poach B’s people by creating them as their own users', async () => {
    const w = await twoTenants();
    const r = await post(w.a.adminEmail, '/api/tenant/users', { email: w.userB });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: 'email_taken' });
    expect((await whoami(w.userB)).json.tenant?.id).toBe(w.b.id);
  });
});

describe('User A cannot reach tenant B', () => {
  it('reads only tenant A', async () => {
    const w = await twoTenants();
    const exp = await get(w.userA, '/api/export');
    expect(exp.status).toBe(200);
    expect(exp.text).toContain(SECRET_A);
    expect(exp.text).not.toContain(SECRET_B);
    expect((await whoami(w.userA)).json.tenant?.id).toBe(w.a.id);
  });

  it('is refused every Admin and Super Admin action', async () => {
    const w = await twoTenants();
    const attempts: Array<[string, string, unknown?]> = [
      ['GET', '/api/tenant/users'],
      ['POST', '/api/tenant/users', { email: email('x') }],
      ['POST', '/api/revisions/1/restore'],
      ['GET', '/api/stats'],
      ['GET', '/api/tenant/storage/inspect'],
      ['POST', '/api/tenant/storage/upload', { migrationId: 'm', expectedRevision: 1, records: [] }],
      ['POST', '/api/tenant/storage/deactivate-web', { revision: 1, hash: 'x' }],
      ['POST', '/api/tenant/deletion-request', { confirm: 'DELETE' }],
      ['GET', '/api/super/tenants'],
      ['POST', '/api/super/tenants', { name: 'x', adminEmail: email('x') }],
      ['POST', `/api/super/tenants/${w.b.id}/delete`, { confirmTenantId: w.b.id, confirmAdminEmail: w.b.adminEmail }],
      ['PATCH', `/api/super/tenants/${w.b.id}`, { status: 'deactivated' }],
      ['GET', '/api/super/audit'],
    ];
    for (const [method, path, body] of attempts) {
      const r = await call(w.userA, method, path, body);
      expect(r.status, `${method} ${path}`).toBe(403);
    }
    expect((await whoami(w.b.adminEmail)).json.tenant?.status).toBe('active'); // nothing happened to B
  });

  it('a viewer reads but their own socket can never write', async () => {
    const w = await twoTenants();
    const ws = await openSocket(w.viewerA);
    if (!ws.ok) throw new Error('viewer should connect');
    expect(ws.ready).toMatchObject({ you: { role: 'viewer' } });
    await ws.sock.next('snapshot');
    ws.sock.send(commitMsg(1, [rec('project', 'tamper', { name: 'x' })]));
    expect(await ws.sock.next('reject')).toMatchObject({ reason: 'forbidden' });
    expect(JSON.stringify((await get(w.a.adminEmail, '/api/export')).json)).not.toContain('tamper');
  });
});

describe('a forged tenant id is rejected, never used', () => {
  it('in the query string, a header, or a body', async () => {
    const w = await twoTenants();
    for (const person of [w.a.adminEmail, w.userA]) {
      for (const key of ['tenantId', 'tenant_id', 'tenant', 'workspaceId']) {
        const r = await get(person, `/api/export?${key}=${w.b.id}`);
        expect(r.status, key).toBe(403);
        expect(r.json).toMatchObject({ error: 'tenant_mismatch' });
        expect(r.text).not.toContain(SECRET_B);
      }
      for (const header of ['x-gc-tenant', 'x-tenant-id', 'x-workspace-id']) {
        const r = await get(person, '/api/export', { [header]: w.b.id });
        expect(r.status, header).toBe(403);
      }
    }
    const body = await post(w.a.adminEmail, '/api/tenant/users', { tenantId: w.b.id, email: email('forged') });
    expect(body.status).toBe(403);
    expect(body.json).toMatchObject({ error: 'tenant_mismatch' });
    expect((await get(w.b.adminEmail, '/api/tenant/users')).text).not.toContain('forged');
  });

  it('naming your OWN tenant is harmless (it is ignored; the principal decides)', async () => {
    const w = await twoTenants();
    expect((await get(w.a.adminEmail, `/api/export?tenantId=${w.a.id}`)).status).toBe(200);
  });

  it('a user created while a forged tenantId is in the body is NOT created', async () => {
    const w = await twoTenants();
    const e = email('ghost');
    await post(w.a.adminEmail, '/api/tenant/users', { tenantId: w.b.id, email: e });
    expect((await whoami(e)).status).toBe(403);
  });

  it('the tenant of a new user is always the creating admin’s, whatever else is sent', async () => {
    const w = await twoTenants();
    const e = email('newbie');
    expect((await post(w.a.adminEmail, '/api/tenant/users', { email: e })).status).toBe(201);
    const who = await whoami(e);
    expect(who.json.tenant?.id).toBe(w.a.id);
    expect(who.json.tenant?.id).not.toBe(w.b.id);
  });
});

describe('WebSockets cannot cross tenants', () => {
  it('each person is attached to THEIR tenant’s workspace and sees only its data', async () => {
    const w = await twoTenants();
    const a = await openSocket(w.userA);
    const b = await openSocket(w.userB);
    if (!a.ok || !b.ok) throw new Error('both should connect');
    const snapA = await a.sock.next('snapshot');
    const snapB = await b.sock.next('snapshot');
    expect(JSON.stringify(snapA)).toContain(SECRET_A);
    expect(JSON.stringify(snapA)).not.toContain(SECRET_B);
    expect(JSON.stringify(snapB)).toContain(SECRET_B);
    expect(JSON.stringify(snapB)).not.toContain(SECRET_A);
  });

  it('a change in A is broadcast to A’s people and NEVER to B’s', async () => {
    const w = await twoTenants();
    const a1 = await openSocket(w.userA);
    const a2 = await openSocket(w.a.adminEmail);
    const b1 = await openSocket(w.userB);
    const b2 = await openSocket(w.b.adminEmail);
    if (!a1.ok || !a2.ok || !b1.ok || !b2.ok) throw new Error('connect');
    await Promise.all([a1.sock.next('snapshot'), a2.sock.next('snapshot'), b1.sock.next('snapshot'), b2.sock.next('snapshot')]);
    const snap = await get<{ revision: number }>(w.a.adminEmail, '/api/export');
    a1.sock.send(commitMsg(snap.json.revision, [rec('project', 'new-in-a', { name: 'ALPHA-LIVE-CHANGE' })]));
    await a1.sock.next('ack');
    expect(JSON.stringify(await a2.sock.next('changes'))).toContain('ALPHA-LIVE-CHANGE');
    await b1.sock.expectNone('changes', 400);
    await b2.sock.expectNone('changes', 100);
  });

  it('forged tenant hints on the upgrade are rejected; nothing is attached', async () => {
    const w = await twoTenants();
    expect(await openSocket(w.userA, { query: `?tenantId=${w.b.id}` })).toMatchObject({ ok: false, status: 403 });
    expect(await openSocket(w.userA, { headers: { 'x-gc-tenant': w.b.id } })).toMatchObject({ ok: false, status: 403 });
    expect(await openSocket(w.userA, { headers: { 'x-gc-user': 'usr_other', 'x-gc-verified-role': 'admin' } })).toMatchObject({ ok: true }); // spoofed identity headers are overwritten, not honoured
  });

  it('spoofed internal identity headers can never raise a viewer to admin', async () => {
    const w = await twoTenants();
    const ws = await openSocket(w.viewerA, { headers: { 'x-gc-verified-role': 'admin', 'x-gc-verified-email': w.a.adminEmail } });
    if (!ws.ok) throw new Error('should connect as the real viewer');
    expect(ws.ready).toMatchObject({ you: { email: w.viewerA, role: 'viewer' } });
  });

  it('the same two tenants keep independent revision numbers and conflict spaces', async () => {
    const w = await twoTenants();
    const a = await openSocket(w.userA);
    const b = await openSocket(w.userB);
    if (!a.ok || !b.ok) throw new Error('connect');
    await Promise.all([a.sock.next('snapshot'), b.sock.next('snapshot')]);
    // Both edit the record that has the SAME id in both tenants, on base revision 1.
    a.sock.send(commitMsg(1, [rec('project', 'shared-id', { name: 'A edit' })]));
    b.sock.send(commitMsg(1, [rec('project', 'shared-id', { name: 'B edit' })]));
    expect(await a.sock.next('ack')).toMatchObject({ revision: 2 });
    expect(await b.sock.next('ack')).toMatchObject({ revision: 2 }); // no conflict: different tenants
    expect((await get(w.a.adminEmail, '/api/export')).text).toContain('A edit');
    expect((await get(w.a.adminEmail, '/api/export')).text).not.toContain('B edit');
  });
});

describe('history and restore cannot cross tenants', () => {
  it('listing, previewing and restoring act only on the caller’s own tenant', async () => {
    const w = await twoTenants();
    // Give A a second revision so there is something to restore.
    const a = await openSocket(w.a.adminEmail);
    if (!a.ok) throw new Error('connect');
    await a.sock.next('snapshot');
    a.sock.send(commitMsg(1, [rec('project', 'proj-a', { name: `${SECRET_A}-v2` })]));
    await a.sock.next('ack');

    const revsA = await get<Array<{ revision: number; actor: string }>>(w.a.adminEmail, '/api/revisions');
    expect(revsA.json.map((r) => r.revision)).toEqual([2, 1]);
    expect(revsA.text).not.toContain(w.b.adminEmail);

    const revsB = await get<Array<{ revision: number }>>(w.b.adminEmail, '/api/revisions');
    expect(revsB.json.map((r) => r.revision)).toEqual([1]); // B's history is B's own

    // A restores revision 1: only A changes.
    expect((await post(w.a.adminEmail, '/api/revisions/1/restore')).status).toBe(200);
    expect((await get(w.a.adminEmail, '/api/export')).text).not.toContain(`${SECRET_A}-v2`);
    expect((await get(w.b.adminEmail, '/api/export')).text).toContain(SECRET_B);
    // Revision 2 exists for A only.
    expect((await get(w.b.adminEmail, '/api/revisions/2')).status).toBe(404);
  });

  it('a user (not admin) cannot restore, and an admin cannot restore another tenant’s revision by number', async () => {
    const w = await twoTenants();
    expect((await post(w.userA, '/api/revisions/1/restore')).status).toBe(403);
    const before = (await get(w.b.adminEmail, '/api/export')).text;
    expect((await post(w.a.adminEmail, '/api/revisions/1/restore?tenantId=' + w.b.id)).status).toBe(403);
    expect((await get(w.b.adminEmail, '/api/export')).text).toBe(before);
  });
});

describe('the Super Admin administers the platform, not tenant data', () => {
  it('cannot read any tenant’s workspace, history, users or socket', async () => {
    const w = await twoTenants();
    for (const path of ['/api/export', '/api/revisions', '/api/revisions/1', '/api/tenant/users', '/api/tenant', '/api/stats']) {
      expect((await get(SUPER, path)).status, path).toBe(403);
    }
    expect(await openSocket(SUPER)).toMatchObject({ ok: false, status: 403 });
    expect((await get(SUPER, `/api/export?tenantId=${w.a.id}`)).status).toBe(403);
  });

  it('sees tenant METADATA only: no QA content anywhere in the registry listing', async () => {
    const w = await twoTenants();
    const raw = JSON.stringify(await listTenants());
    expect(raw).toContain(w.a.id);
    expect(raw).toContain(w.a.adminEmail);
    expect(raw).not.toContain(SECRET_A);
    expect(raw).not.toContain(SECRET_B);
    expect(raw).not.toContain('proj-a');
  });

  it('whoami for a Super Admin has no tenant', async () => {
    const r = await whoami(SUPER);
    expect(r.json).toMatchObject({ role: 'super_admin', tenant: null, sharedWorkspace: false, workspaceRole: null });
  });

  it('a Super Admin email can never be registered as a tenant admin or user', async () => {
    const w = await twoTenants();
    expect((await post(SUPER, '/api/super/tenants', { name: 'x', adminEmail: SUPER })).status).toBe(409);
    expect((await post(w.a.adminEmail, '/api/tenant/users', { email: SUPER })).status).toBe(409);
  });
});

describe('admins cannot perform Super Admin actions', () => {
  it('create tenants, change tenant status, approve deletion, read the audit', async () => {
    const w = await twoTenants();
    expect((await post(w.a.adminEmail, '/api/super/tenants', { name: 'x', adminEmail: email('x') })).status).toBe(403);
    expect((await patch(w.a.adminEmail, `/api/super/tenants/${w.b.id}`, { status: 'deactivated' })).status).toBe(403);
    expect((await post(w.a.adminEmail, `/api/super/tenants/${w.b.id}/delete`, { confirmTenantId: w.b.id, confirmAdminEmail: w.b.adminEmail })).status).toBe(403);
    expect((await get(w.a.adminEmail, '/api/super/audit')).status).toBe(403);
    expect((await post(w.a.adminEmail, '/api/super/legacy/adopt', { tenantId: w.a.id })).status).toBe(403);
    expect((await whoami(w.b.adminEmail)).json.tenant?.status).toBe('active');
  });
});

describe('principal shape', () => {
  it('maps registry roles onto workspace roles; there is no second authorization system', async () => {
    const w = await twoTenants();
    const roleOf = async (who: string) => (await whoami(who)).json as PrincipalDto;
    expect(await roleOf(w.a.adminEmail)).toMatchObject({ role: 'admin', workspaceRole: 'admin', sharedWorkspace: true });
    expect(await roleOf(w.userA)).toMatchObject({ role: 'user', access: 'editor', workspaceRole: 'editor' });
    expect(await roleOf(w.viewerA)).toMatchObject({ role: 'user', access: 'viewer', workspaceRole: 'viewer' });
  });

  it('is never influenced by the old global role variables or by request headers', async () => {
    const w = await twoTenants();
    const r = await get(w.userA, '/api/whoami', { 'x-gc-verified-role': 'admin', 'x-gc-verified-email': w.a.adminEmail });
    expect(r.json).toMatchObject({ email: w.userA, role: 'user' });
  });
});

// keep the unused imports honest for tree-shaking checks in future refactors
void addUser;
void createTenant;
void activateWeb;

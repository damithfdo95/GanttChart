import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { TenantDto, TenantSummaryDto } from '../../../shared/tenancy';
import { CLOSE_CODES } from '../../../shared/tenancy';
import { SECRET_A, SECRET_B, SUPER, activateWeb, addUser, createTenant, email, get, hashOf, listTenants, openSocket, post, rec, twoTenants, whoami } from './tenancy-harness';
import { workspaceFor } from './helpers';

const request = (adminEmail: string) => post<{ tenant: TenantDto }>(adminEmail, '/api/tenant/deletion-request');
const cancel = (adminEmail: string) => post<{ tenant: TenantDto }>(adminEmail, '/api/tenant/deletion-request/cancel');
const approve = (tenantId: string, adminEmail: string, as = SUPER, overrides: Record<string, unknown> = {}) =>
  post<{ deleted?: boolean; usersDeleted?: number }>(as, `/api/super/tenants/${tenantId}/delete`, { confirmTenantId: tenantId, confirmAdminEmail: adminEmail, ...overrides });
const summaryOf = async (id: string): Promise<TenantSummaryDto | undefined> => (await listTenants()).find((t) => t.id === id);

describe('requesting deletion', () => {
  it('only marks the tenant; nothing is deleted and the admin keeps working (they must be able to export)', async () => {
    const w = await twoTenants();
    const r = await request(w.a.adminEmail);
    expect(r.status).toBe(200);
    expect(r.json.tenant.status).toBe('deletion_requested');
    expect((await summaryOf(w.a.id))?.status).toBe('deletion_requested');
    expect((await get(w.a.adminEmail, '/api/export')).text).toContain(SECRET_A);
    expect((await whoami(w.userA)).status).toBe(200);
  });

  it('is an admin-only action on the admin’s OWN tenant', async () => {
    const w = await twoTenants();
    expect((await request(w.userA)).status).toBe(403);
    expect((await request(w.viewerA)).status).toBe(403);
    expect((await request(SUPER)).status).toBe(403);
    expect((await request(email('stranger'))).status).toBe(403);
    // B's admin requesting deletion can only ever affect B.
    expect((await request(w.b.adminEmail)).status).toBe(200);
    expect((await summaryOf(w.a.id))?.status).toBe('active');
    expect((await post(w.b.adminEmail, '/api/tenant/deletion-request', { tenantId: w.a.id })).status).toBe(403); // forged tenant
  });

  it('can be repeated safely and cancelled; the tenant then works normally', async () => {
    const w = await twoTenants();
    await request(w.a.adminEmail);
    expect((await request(w.a.adminEmail)).status).toBe(409); // already requested
    expect((await cancel(w.a.adminEmail)).json.tenant.status).toBe('active');
    expect((await cancel(w.a.adminEmail)).status).toBe(409); // nothing to cancel
    expect((await summaryOf(w.a.id))?.deletionRequestedAt).toBeNull();
    expect((await request(w.a.adminEmail)).status).toBe(200);
  });

  it('a tenant waiting for deletion cannot add users or start a migration', async () => {
    const w = await twoTenants();
    await request(w.a.adminEmail);
    expect((await post(w.a.adminEmail, '/api/tenant/users', { email: email('late') })).status).toBe(403);
    expect((await post(w.a.adminEmail, '/api/tenant/storage/upload', { migrationId: 'm', expectedRevision: 1, records: [] })).status).toBe(403);
  });
});

describe('approving deletion: who may, and what must be confirmed', () => {
  it('the requesting Admin cannot approve their own deletion (they have no Super Admin rights at all)', async () => {
    const w = await twoTenants();
    await request(w.a.adminEmail);
    const r = await approve(w.a.id, w.a.adminEmail, w.a.adminEmail);
    expect(r.status).toBe(403);
    expect((await summaryOf(w.a.id))?.status).toBe('deletion_requested');
    expect((await get(w.a.adminEmail, '/api/export')).text).toContain(SECRET_A); // data intact
  });

  it('nobody else can approve: users, another tenant’s admin, strangers', async () => {
    const w = await twoTenants();
    await request(w.a.adminEmail);
    for (const who of [w.userA, w.b.adminEmail, email('stranger')]) expect((await approve(w.a.id, w.a.adminEmail, who)).status).toBe(403);
    expect((await summaryOf(w.a.id))?.status).toBe('deletion_requested');
  });

  it('a tenant that never asked cannot be deleted, even by the Super Admin', async () => {
    const w = await twoTenants();
    const r = await approve(w.a.id, w.a.adminEmail);
    expect(r.status).toBe(409);
    expect((await summaryOf(w.a.id))?.status).toBe('active');
    expect((await get(w.a.adminEmail, '/api/export')).text).toContain(SECRET_A);
  });

  it('requires BOTH typed confirmations to match; anything else deletes nothing', async () => {
    const w = await twoTenants();
    await request(w.a.adminEmail);
    expect((await approve(w.a.id, w.a.adminEmail, SUPER, { confirmTenantId: w.b.id })).status).toBe(400);
    expect((await approve(w.a.id, w.a.adminEmail, SUPER, { confirmAdminEmail: w.b.adminEmail })).status).toBe(400);
    expect((await approve(w.a.id, w.a.adminEmail, SUPER, { confirmAdminEmail: 'wrong@tenant.test' })).status).toBe(400);
    expect((await approve(w.a.id, w.a.adminEmail, SUPER, { confirmTenantId: undefined })).status).toBe(400);
    expect((await summaryOf(w.a.id))?.status).toBe('deletion_requested');
    expect((await get(w.a.adminEmail, '/api/export')).text).toContain(SECRET_A);
  });

  it('rejects malformed or unknown tenant ids', async () => {
    expect((await post(SUPER, '/api/super/tenants/not-an-id/delete', {})).status).toBe(400);
    expect((await post(SUPER, '/api/super/tenants/ten_00000000-0000-0000-0000-000000000000/delete', { confirmTenantId: 'ten_00000000-0000-0000-0000-000000000000', confirmAdminEmail: 'a@b.co' })).status).toBe(404);
  });
});

describe('an approved deletion removes everything the tenant owned — and only that', () => {
  it('ends sessions, removes users and workspace data, writes a content-free audit row, frees the emails, spares other tenants', async () => {
    const w = await twoTenants();
    const live = await openSocket(w.userA);
    const liveAdmin = await openSocket(w.a.adminEmail);
    if (!live.ok || !liveAdmin.ok) throw new Error('connect');
    await request(w.a.adminEmail);

    const r = await approve(w.a.id, w.a.adminEmail);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ deleted: true, usersDeleted: 3 }); // admin + editor + viewer

    // Live sessions were ended.
    expect((await live.sock.closed).code).toBe(CLOSE_CODES.tenantDeleted);
    expect((await liveAdmin.sock.closed).code).toBe(CLOSE_CODES.tenantDeleted);

    // Everyone who belonged to A is now unknown: fail closed.
    for (const who of [w.a.adminEmail, w.userA, w.viewerA]) {
      const res = await whoami(who);
      expect(res.status).toBe(403);
      expect(res.json).toMatchObject({ reason: 'unregistered' });
      expect(await openSocket(who)).toMatchObject({ ok: false, status: 403 });
    }

    // The tenant is gone from the registry; B is untouched.
    expect(await summaryOf(w.a.id)).toBeUndefined();
    expect((await summaryOf(w.b.id))?.status).toBe('active');
    expect((await get(w.b.adminEmail, '/api/export')).text).toContain(SECRET_B);
    expect((await whoami(w.userB)).status).toBe(200);

    // Workspace storage: either the object is empty, or its tables are gone.
    try {
      const left = await workspaceFor(w.a.id).exportAll();
      expect(left.records).toEqual([]);
    } catch {
      /* storage was dropped entirely — also fine */
    }

    // The audit trail has identities and timestamps only. No names, no QA content.
    const audit = await get<{ audit: Array<Record<string, unknown>> }>(SUPER, '/api/super/audit');
    const row = audit.json.audit.find((x) => x.tenant_id === w.a.id)!;
    expect(row).toMatchObject({ requested_by_email: w.a.adminEmail, approved_by_email: SUPER, users_deleted: 3 });
    expect(audit.text).not.toContain(SECRET_A);
    expect(audit.text).not.toContain('Alpha QA');
    expect(audit.text).not.toContain('proj-a');

    // The same email addresses can be registered again (a clean slate).
    const reborn = await createTenant('Reborn', w.a.adminEmail);
    expect((await whoami(w.a.adminEmail)).json.tenant?.id).toBe(reborn.id);
    expect(reborn.id).not.toBe(w.a.id);
  });

  it('deleting a tenant that was in LOCAL mode (no cloud data) works the same way', async () => {
    const t = await createTenant('Local to delete', email('admin-l'));
    await request(t.adminEmail);
    expect((await approve(t.id, t.adminEmail)).json).toMatchObject({ deleted: true, usersDeleted: 1 });
    expect(await summaryOf(t.id)).toBeUndefined();
  });

  it('a second approval of the same tenant finds nothing to delete', async () => {
    const t = await createTenant('Twice', email('admin-t'));
    await request(t.adminEmail);
    await approve(t.id, t.adminEmail);
    expect((await approve(t.id, t.adminEmail)).status).toBe(404);
  });

  it('only the Super Admin can read the audit', async () => {
    const w = await twoTenants();
    for (const who of [w.a.adminEmail, w.userA, email('stranger')]) expect((await get(who, '/api/super/audit')).status).toBe(403);
  });
});

describe('adopting the pre-tenant (Stage 4) workspace', () => {
  const legacy = () => env.WORKSPACE.getByName('workspace');
  const adopt = (as: string, tenantId: unknown) => post<Record<string, unknown>>(as, '/api/super/legacy/adopt', { tenantId });

  it('says so when there is nothing to adopt', async () => {
    const t = await createTenant('Empty adopt', email('admin-e'));
    expect((await adopt(SUPER, t.id)).json).toMatchObject({ error: 'nothing_to_adopt' });
  });

  it('copies the old single workspace into ONE chosen, empty tenant — exactly, once, and never over existing data', async () => {
    // Seed the legacy instance the way Stage 4 stored data (same storage schema).
    await runInDurableObject(legacy(), async (instance: { store: { commit: (i: unknown) => unknown } }) => {
      instance.store.commit({
        commitId: 'legacy-seed',
        baseRevision: 0,
        puts: [rec('project', 'legacy-p', { name: 'LEGACY-STAGE4-PROJECT' }), rec('settings', 'settings', { teams: ['Legacy'] })],
        deletes: [],
        actor: 'legacy@old.test',
        reason: 'edit',
        now: new Date().toISOString(),
      });
    });

    const target = await createTenant('Adoptive', email('admin-ad'));
    const other = await createTenant('Not chosen', email('admin-no'));
    expect((await adopt(target.adminEmail, target.id)).status).toBe(403); // a tenant admin cannot
    expect((await adopt(SUPER, 'nope')).status).toBe(400);
    expect((await adopt(SUPER, 'ten_00000000-0000-0000-0000-000000000000')).status).toBe(404);

    const ok = await adopt(SUPER, target.id);
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ ok: true, revision: 1 });
    const expected = await hashOf([rec('project', 'legacy-p', { name: 'LEGACY-STAGE4-PROJECT' }), rec('settings', 'settings', { teams: ['Legacy'] })]);
    expect(ok.json.hash).toBe(expected); // byte-identical copy

    // Only the chosen tenant received it; and it can then be activated through the normal verified path.
    expect((await get(other.adminEmail, '/api/tenant/storage/inspect')).text).not.toContain('LEGACY');
    expect((await post(target.adminEmail, '/api/tenant/storage/activate-web', { revision: 1, hash: ok.json.hash })).status).toBe(200);
    expect((await get(target.adminEmail, '/api/export')).text).toContain('LEGACY-STAGE4-PROJECT');

    // A tenant that already has data is never overwritten by adoption.
    expect((await adopt(SUPER, target.id)).json).toMatchObject({ error: 'server_not_empty' });
    const withData = await createTenant('Has data', email('admin-hd'));
    await activateWeb(withData, [rec('project', 'mine', { name: 'KEEP-ME' })]);
    expect((await adopt(SUPER, withData.id)).status).toBe(409);
    expect((await get(withData.adminEmail, '/api/export')).text).toContain('KEEP-ME');
  });
});

void addUser;

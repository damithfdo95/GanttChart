import { describe, expect, it } from 'vitest';
import type { RecordPut } from '../../../shared/protocol';
import { REPLACE_CONFIRMATION, SECRET_A, SECRET_B, SUPER, addUser, createTenant, deactivate, email, get, hashOf, openSocket, post, rec, whoami, type Tenant } from './tenancy-harness';
import { commitMsg } from './helpers';
import { CLOSE_CODES } from '../../../shared/tenancy';

/**
 * Local ⇄ Web migration. The rules: never overwrite silently, verify before
 * switching, keep the cloud copy, stay retry-safe.
 */

const local = (n: string): RecordPut[] => [rec('project', 'p1', { name: `Project ${n}` }), rec('report', 'r1', { name: `Report ${n}` }), rec('settings', 'settings', { teams: ['QA'] })];

async function freshLocalTenant(): Promise<Tenant> {
  return createTenant('Migrating QA', email('admin-m'));
}

const upload = (t: Tenant, body: Record<string, unknown>) => post<Record<string, unknown> & { revision: number; hash: string; alreadyApplied: boolean }>(t.adminEmail, '/api/tenant/storage/upload', body);

describe('inspect', () => {
  it('shows what the server holds before anything is migrated', async () => {
    const t = await freshLocalTenant();
    const r = await get<{ tenant: { storageMode: string }; server: { revision: number; hasData: boolean; frozen: boolean } }>(t.adminEmail, '/api/tenant/storage/inspect');
    expect(r.status).toBe(200);
    expect(r.json.tenant.storageMode).toBe('local');
    expect(r.json.server).toMatchObject({ revision: 0, hasData: false, frozen: false });
  });

  it('is for the tenant’s own admin only', async () => {
    const t = await freshLocalTenant();
    expect((await get(SUPER, '/api/tenant/storage/inspect')).status).toBe(403);
    expect((await get(email('stranger'), '/api/tenant/storage/inspect')).status).toBe(403);
  });
});

describe('Local → Web: upload', () => {
  it('stores the workspace as ONE revision and returns a content hash the client can verify independently', async () => {
    const t = await freshLocalTenant();
    const records = local('one');
    const r = await upload(t, { migrationId: 'mig-1', expectedRevision: 0, records });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, revision: 1, alreadyApplied: false });
    expect(r.json.hash).toBe(await hashOf(records)); // same bytes in, same hash out
  });

  it('is retry-safe: repeating it (same id, or same content under a new id) changes nothing', async () => {
    const t = await freshLocalTenant();
    const records = local('retry');
    const first = await upload(t, { migrationId: 'mig-a', expectedRevision: 0, records });
    const again = await upload(t, { migrationId: 'mig-a', expectedRevision: 0, records });
    const newId = await upload(t, { migrationId: 'mig-b', expectedRevision: 0, records });
    for (const r of [again, newId]) {
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ revision: first.json.revision, alreadyApplied: true, hash: first.json.hash });
    }
    const insp = await get<{ server: { revision: number } }>(t.adminEmail, '/api/tenant/storage/inspect');
    expect(insp.json.server.revision).toBe(1); // exactly one revision exists
  });

  it('rejects malformed uploads without touching anything', async () => {
    const t = await freshLocalTenant();
    const bad: Array<[string, Record<string, unknown>]> = [
      ['records not an array', { migrationId: 'm', expectedRevision: 0, records: {} }],
      ['unknown kind', { migrationId: 'm', expectedRevision: 0, records: [{ kind: 'secrets', id: 'x', json: '{"id":"x"}' }] }],
      ['id mismatch', { migrationId: 'm', expectedRevision: 0, records: [{ kind: 'project', id: 'p', json: '{"id":"other"}' }] }],
      ['duplicate', { migrationId: 'm', expectedRevision: 0, records: [rec('project', 'p'), rec('project', 'p')] }],
      ['not json', { migrationId: 'm', expectedRevision: 0, records: [{ kind: 'project', id: 'p', json: '{nope' }] }],
    ];
    for (const [name, body] of bad) expect((await upload(t, body)).status, name).toBe(400);
    expect((await upload(t, { expectedRevision: 0, records: [] })).status).toBe(400); // no migration id
    expect((await upload(t, { migrationId: 'm', records: [] })).status).toBe(400); // no expected revision
    expect((await upload(t, { migrationId: 'm', expectedRevision: -1, records: [] })).status).toBe(400);
    const insp = await get<{ server: { revision: number } }>(t.adminEmail, '/api/tenant/storage/inspect');
    expect(insp.json.server.revision).toBe(0);
  });

  it('only the tenant’s admin may upload; users and other tenants’ admins cannot', async () => {
    const t = await freshLocalTenant();
    const other = await freshLocalTenant();
    expect((await post(other.adminEmail, '/api/tenant/storage/upload', { migrationId: 'm', expectedRevision: 0, records: local('x'), tenantId: t.id })).status).toBe(403); // forged tenant
    // …and what other's admin uploads lands in other's own workspace, never t's.
    expect((await upload(other, { migrationId: 'm2', expectedRevision: 0, records: local('other') })).status).toBe(200);
    const insp = await get<{ server: { revision: number } }>(t.adminEmail, '/api/tenant/storage/inspect');
    expect(insp.json.server.revision).toBe(0);
  });
});

describe('Local → Web: never overwrites existing server data silently', () => {
  async function tenantWithCloudData(): Promise<{ t: Tenant; hash: string }> {
    const t = await freshLocalTenant();
    const up = await upload(t, { migrationId: 'seed', expectedRevision: 0, records: local('cloud') });
    return { t, hash: up.json.hash };
  }

  it('different content on a non-empty server is refused (409 server_not_empty); nothing changes', async () => {
    const { t, hash } = await tenantWithCloudData();
    const r = await upload(t, { migrationId: 'm2', expectedRevision: 1, records: [rec('project', 'p9', { name: 'LOCAL' })] });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: 'server_not_empty' });
    const insp = await get<{ server: { hash: string; revision: number } }>(t.adminEmail, '/api/tenant/storage/inspect');
    expect(insp.json.server).toMatchObject({ hash, revision: 1 });
  });

  it('replacing needs the typed confirmation, checked by the SERVER', async () => {
    const { t } = await tenantWithCloudData();
    const body = { migrationId: 'm3', expectedRevision: 1, records: [rec('project', 'p9', { name: 'LOCAL' })], replace: true };
    expect((await upload(t, body)).json).toMatchObject({ error: 'confirmation_required' });
    expect((await upload(t, { ...body, confirm: 'replace' })).status).toBe(400);
    expect((await upload(t, { ...body, confirm: ` ${REPLACE_CONFIRMATION}` })).status).toBe(400);
  });

  it('a stale view of the server is refused: someone changed it since it was inspected (409 revision_mismatch)', async () => {
    const { t } = await tenantWithCloudData();
    const r = await upload(t, { migrationId: 'm4', expectedRevision: 0, records: [rec('project', 'p9')], replace: true, confirm: REPLACE_CONFIRMATION });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: 'revision_mismatch', revision: 1 });
  });

  it('an explicit, confirmed replace works — and the previous cloud state stays recoverable in history', async () => {
    const { t } = await tenantWithCloudData();
    const records = [rec('project', 'p9', { name: 'LOCAL WINS' })];
    const r = await upload(t, { migrationId: 'm5', expectedRevision: 1, records, replace: true, confirm: REPLACE_CONFIRMATION });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ revision: 2, hash: await hashOf(records) });
    // Activate so the admin can read history through the normal API.
    expect((await post(t.adminEmail, '/api/tenant/storage/activate-web', { revision: 2, hash: r.json.hash })).status).toBe(200);
    const old = await get<{ records: RecordPut[] }>(t.adminEmail, '/api/revisions/1');
    expect(old.text).toContain('Project cloud'); // the replaced state is still there
    const now = await get(t.adminEmail, '/api/export');
    expect(now.text).toContain('LOCAL WINS');
    expect(now.text).not.toContain('Project cloud');
  });
});

describe('Local → Web: the switch happens only after the server verifies the content', () => {
  it('a wrong hash or revision keeps the workspace LOCAL and its data unreadable through the web API', async () => {
    const t = await freshLocalTenant();
    const up = await upload(t, { migrationId: 'm', expectedRevision: 0, records: local('v') });
    expect((await post(t.adminEmail, '/api/tenant/storage/activate-web', { revision: up.json.revision, hash: '0'.repeat(64) })).status).toBe(409);
    expect((await post(t.adminEmail, '/api/tenant/storage/activate-web', { revision: 99, hash: up.json.hash })).status).toBe(409);
    expect((await post(t.adminEmail, '/api/tenant/storage/activate-web', { revision: 'x', hash: up.json.hash })).status).toBe(400);
    expect((await whoami(t.adminEmail)).json.tenant?.storageMode).toBe('local');
    expect((await get(t.adminEmail, '/api/export')).status).toBe(403);
  });

  it('the right hash flips the mode; users can then be created and the data is live', async () => {
    const t = await freshLocalTenant();
    const up = await upload(t, { migrationId: 'm', expectedRevision: 0, records: local('ok') });
    const act = await post(t.adminEmail, '/api/tenant/storage/activate-web', { revision: up.json.revision, hash: up.json.hash });
    expect(act.status).toBe(200);
    expect((await whoami(t.adminEmail)).json).toMatchObject({ tenant: { storageMode: 'web' }, sharedWorkspace: true });
    await addUser(t, email('u'));
    expect((await get(t.adminEmail, '/api/export')).text).toContain('Project ok');
  });

  it('activation is idempotent', async () => {
    const t = await freshLocalTenant();
    const up = await upload(t, { migrationId: 'm', expectedRevision: 0, records: local('idem') });
    const body = { revision: up.json.revision, hash: up.json.hash };
    expect((await post(t.adminEmail, '/api/tenant/storage/activate-web', body)).status).toBe(200);
    expect((await post(t.adminEmail, '/api/tenant/storage/activate-web', body)).status).toBe(200);
  });
});

describe('Web → Local', () => {
  async function webTenantWithUser() {
    const t = await freshLocalTenant();
    const up = await upload(t, { migrationId: 'm', expectedRevision: 0, records: [rec('project', 'p1', { name: SECRET_A })] });
    await post(t.adminEmail, '/api/tenant/storage/activate-web', { revision: up.json.revision, hash: up.json.hash });
    const userEmail = email('collab');
    await addUser(t, userEmail);
    return { t, userEmail };
  }

  const download = async (t: Tenant) => (await get<{ revision: number; hash: string; records: RecordPut[] }>(t.adminEmail, '/api/export')).json;

  it('refuses unless the cloud copy is EXACTLY what was downloaded (hash and revision)', async () => {
    const { t } = await webTenantWithUser();
    const snap = await download(t);
    expect((await deactivate(t.adminEmail, snap.revision, 'f'.repeat(64))).json).toMatchObject({ error: 'workspace_changed' });
    expect((await deactivate(t.adminEmail, snap.revision + 1, snap.hash)).status).toBe(409);
    expect((await whoami(t.adminEmail)).json.tenant?.storageMode).toBe('web'); // unchanged
  });

  it('refuses if a collaborator changed the workspace after the download (nothing is lost)', async () => {
    const { t, userEmail } = await webTenantWithUser();
    const snap = await download(t);
    const live = await openSocket(t.adminEmail);
    if (!live.ok) throw new Error('connect');
    await live.sock.next('snapshot');
    live.sock.send(commitMsg(snap.revision, [rec('project', 'p2', { name: 'late edit by a user' })]));
    await live.sock.next('ack');
    const r = await deactivate(t.adminEmail, snap.revision, snap.hash);
    expect(r.status).toBe(409);
    expect((await whoami(t.adminEmail)).json.tenant?.storageMode).toBe('web');
    expect((await get(t.adminEmail, '/api/export')).text).toContain('late edit by a user');
  });

  it('switches to local, closes live sessions, locks the users out — and KEEPS the cloud copy', async () => {
    const { t, userEmail } = await webTenantWithUser();
    const live = await openSocket(t.adminEmail);
    if (!live.ok) throw new Error('connect');
    const snap = await download(t);
    const r = await deactivate(t.adminEmail, snap.revision, snap.hash) as { status: number; json: { cloudCopy: string } };
    expect(r.status).toBe(200);
    expect(r.json.cloudCopy).toBe('archived');

    expect((await live.sock.closed).code).toBe(CLOSE_CODES.storageMoved);
    expect((await whoami(userEmail)).json).toMatchObject({ reason: 'workspace_not_shared' });
    expect((await whoami(t.adminEmail)).json.tenant?.storageMode).toBe('local');

    // The cloud copy is still there, archived (frozen), not deleted.
    const insp = await get<{ server: { hasData: boolean; frozen: boolean; hash: string } }>(t.adminEmail, '/api/tenant/storage/inspect');
    expect(insp.json.server).toMatchObject({ hasData: true, frozen: true, hash: snap.hash });
  });

  it('the SERVER requires the typed confirmation: a script cannot skip the browser prompt', async () => {
    const { t, userEmail } = await webTenantWithUser();
    const snap = await download(t);
    for (const wrong of ['', 'local', ' LOCAL', 'yes', 5, null]) {
      const r = await deactivate(t.adminEmail, snap.revision, snap.hash, wrong);
      expect(r.status, String(wrong)).toBe(400);
      expect(r.json).toMatchObject({ error: 'confirmation_required' });
    }
    // …and omitting the field entirely is refused too.
    const omitted = await post(t.adminEmail, '/api/tenant/storage/deactivate-web', { revision: snap.revision, hash: snap.hash });
    expect(omitted.status).toBe(400);
    expect((await whoami(t.adminEmail)).json.tenant?.storageMode).toBe('web'); // nothing moved
    expect((await whoami(userEmail)).status).toBe(200); // collaborators are not locked out
    expect((await deactivate(t.adminEmail, snap.revision, snap.hash)).status).toBe(200);
  });

  it('is only possible from web mode', async () => {
    const t = await freshLocalTenant();
    expect((await deactivate(t.adminEmail, 0, await hashOf([]))).status).toBe(409);
  });

  it('going back to Web never silently overwrites the archived copy, and reactivation makes it writable again', async () => {
    const { t, userEmail } = await webTenantWithUser();
    const snap = await download(t);
    await deactivate(t.adminEmail, snap.revision, snap.hash);

    // A different local workspace cannot just replace the archived cloud copy.
    const clash = await upload(t, { migrationId: 'back', expectedRevision: snap.revision, records: [rec('project', 'other', { name: SECRET_B })] });
    expect(clash.status).toBe(409);
    expect(clash.json).toMatchObject({ error: 'server_not_empty' });

    // Re-uploading the same content is a harmless no-op, and activation thaws the workspace.
    const same = await upload(t, { migrationId: 'back2', expectedRevision: snap.revision, records: snap.records });
    expect(same.json).toMatchObject({ alreadyApplied: true, hash: snap.hash });
    expect((await post(t.adminEmail, '/api/tenant/storage/activate-web', { revision: snap.revision, hash: snap.hash })).status).toBe(200);
    const live = await openSocket(t.adminEmail);
    if (!live.ok) throw new Error('user should be able to connect again');
    await live.sock.next('snapshot');
    live.sock.send(commitMsg(snap.revision, [rec('project', 'p3', { name: 'after thaw' })]));
    expect(await live.sock.next('ack')).toMatchObject({ revision: snap.revision + 1 });
  });
});

describe('migration is a tenant-admin action', () => {
  it('users, viewers, the Super Admin and strangers cannot start, verify or switch anything', async () => {
    const t = await freshLocalTenant();
    const up = await upload(t, { migrationId: 'm', expectedRevision: 0, records: local('guard') });
    await post(t.adminEmail, '/api/tenant/storage/activate-web', { revision: up.json.revision, hash: up.json.hash });
    const u = email('u');
    await addUser(t, u);
    const v = email('v');
    await addUser(t, v, 'viewer');
    for (const who of [u, v, SUPER, email('stranger')]) {
      for (const [m, path] of [['GET', '/api/tenant/storage/inspect'], ['POST', '/api/tenant/storage/upload'], ['POST', '/api/tenant/storage/activate-web'], ['POST', '/api/tenant/storage/deactivate-web']] as const) {
        const r = m === 'GET' ? await get(who, path) : await post(who, path, { migrationId: 'x', expectedRevision: 0, records: [], revision: 1, hash: 'x' });
        expect(r.status, `${who} ${path}`).toBe(403);
      }
    }
    expect((await whoami(t.adminEmail)).json.tenant?.storageMode).toBe('web');
  });
});

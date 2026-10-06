import { describe, expect, it } from 'vitest';
import { appRoleOf, can, toPrincipalDto, workspaceRoleOf, type Action, type MemberPrincipal, type Principal } from '../src/permissions';
import { isSuperAdminEmail, parseEmailList, principalFromAuth, resolvePrincipal } from '../src/principal';
import type { AuthResult, TenantRow, UserRow } from '../src/registry';

const ACTIONS: Action[] = [
  'registry.view', 'tenant.create', 'tenant.setStatus', 'tenant.approveDeletion', 'tenant.rejectDeletion', 'audit.platform', 'legacy.adopt',
  'tenant.view', 'tenant.requestDeletion', 'storage.migrate', 'users.manage', 'audit.tenant',
  'data.read', 'data.write', 'data.restore', 'data.replace',
];

const SUPER: Principal = { kind: 'super_admin', email: 'super@example.com' };
const member = (over: Partial<MemberPrincipal>): MemberPrincipal => ({
  kind: 'member', email: 'x@example.com', userId: 'usr_x', tenantId: 'ten_x', tenantName: 'T',
  role: 'user', displayName: null, access: 'editor', storageMode: 'web', tenantStatus: 'active', ...over,
});
const allowedFor = (p: Principal | null) => ACTIONS.filter((a) => can(p, a)).sort();

describe('permission matrix (default deny)', () => {
  it('nobody (unauthenticated / unknown) can do anything', () => {
    expect(allowedFor(null)).toEqual([]);
  });

  it('Super Admin: control-plane actions ONLY, never tenant QA data or tenant internals', () => {
    expect(allowedFor(SUPER)).toEqual(['audit.platform', 'legacy.adopt', 'registry.view', 'tenant.approveDeletion', 'tenant.create', 'tenant.rejectDeletion', 'tenant.setStatus']);
    for (const a of ['data.read', 'data.write', 'data.restore', 'data.replace', 'users.manage', 'storage.migrate', 'tenant.view'] as const) {
      expect(can(SUPER, a)).toBe(false);
    }
  });

  it('Admin of a WEB workspace: everything inside their tenant, nothing in the control plane', () => {
    expect(allowedFor(member({ role: 'admin' }))).toEqual(
      ['audit.tenant', 'data.read', 'data.replace', 'data.restore', 'data.write', 'storage.migrate', 'tenant.requestDeletion', 'tenant.view', 'users.manage'],
    );
  });

  it('Admin of a LOCAL workspace: no shared data and cannot manage users, but can migrate and request deletion', () => {
    expect(allowedFor(member({ role: 'admin', storageMode: 'local' }))).toEqual(['audit.tenant', 'storage.migrate', 'tenant.requestDeletion', 'tenant.view']);
  });

  it('User (editor) in a web workspace: read + write only', () => {
    expect(allowedFor(member({ role: 'user', access: 'editor' }))).toEqual(['data.read', 'data.write', 'tenant.view']);
  });

  it('User (viewer): read only; the former "read-only" concept maps here', () => {
    expect(allowedFor(member({ role: 'user', access: 'viewer' }))).toEqual(['data.read', 'tenant.view']);
  });

  it('a User can never perform an Admin or Super Admin action, in any state', () => {
    for (const storageMode of ['web', 'local'] as const) {
      for (const access of ['editor', 'viewer'] as const) {
        const u = member({ role: 'user', access, storageMode });
        for (const a of ['users.manage', 'audit.tenant', 'audit.platform', 'storage.migrate', 'tenant.requestDeletion', 'data.restore', 'data.replace', 'registry.view', 'tenant.create', 'tenant.setStatus', 'tenant.approveDeletion', 'tenant.rejectDeletion', 'legacy.adopt'] as const) {
          expect(can(u, a), `${storageMode}/${access}/${a}`).toBe(false);
        }
      }
    }
  });

  it('an Admin can never perform a Super Admin action', () => {
    for (const storageMode of ['web', 'local'] as const) {
      for (const a of ['registry.view', 'tenant.create', 'tenant.setStatus', 'tenant.approveDeletion', 'tenant.rejectDeletion', 'audit.platform', 'legacy.adopt'] as const) {
        expect(can(member({ role: 'admin', storageMode }), a)).toBe(false);
      }
    }
  });

  it('a tenant awaiting deletion keeps read access (so the admin can export) but cannot add users, migrate or restore-replace anew', () => {
    const adm = member({ role: 'admin', tenantStatus: 'deletion_requested' });
    expect(can(adm, 'data.read')).toBe(true);
    expect(can(adm, 'users.manage')).toBe(false);
    expect(can(adm, 'storage.migrate')).toBe(false);
    expect(can(adm, 'tenant.requestDeletion')).toBe(true); // to cancel
  });

  it('a deactivated or deleting tenant grants nothing at all (defence in depth; the registry already refuses sign-in)', () => {
    for (const tenantStatus of ['deactivated', 'deleting'] as const) {
      expect(allowedFor(member({ role: 'admin', tenantStatus }))).toEqual(['tenant.view']);
      expect(allowedFor(member({ role: 'user', tenantStatus }))).toEqual(['tenant.view']);
    }
  });

  it('an unknown action is denied', () => {
    expect(can(member({ role: 'admin' }), 'launch.missiles' as Action)).toBe(false);
    expect(can(SUPER, 'launch.missiles' as Action)).toBe(false);
  });
});

describe('derived roles', () => {
  it('maps the registry onto the workspace permission levels (one system, no contradictions)', () => {
    expect(workspaceRoleOf(member({ role: 'admin' }))).toBe('admin');
    expect(workspaceRoleOf(member({ role: 'user', access: 'editor' }))).toBe('editor');
    expect(workspaceRoleOf(member({ role: 'user', access: 'viewer' }))).toBe('viewer');
  });

  it('there is no workspace role when there is no shared workspace', () => {
    expect(workspaceRoleOf(member({ role: 'admin', storageMode: 'local' }))).toBeNull();
    expect(workspaceRoleOf(member({ role: 'admin', tenantStatus: 'deactivated' }))).toBeNull();
    expect(workspaceRoleOf(SUPER)).toBeNull();
  });

  it('exposes the app role', () => {
    expect([appRoleOf(SUPER), appRoleOf(member({ role: 'admin' })), appRoleOf(member({}))]).toEqual(['super_admin', 'admin', 'user']);
  });

  it('the DTO for the browser carries no internal ids beyond the tenant', () => {
    const dto = toPrincipalDto(member({ role: 'user', access: 'viewer' }), { id: 'ten_x', name: 'T', storageMode: 'web', status: 'active', createdAt: 'c', deletionRequestedAt: null });
    expect(dto).toEqual({
      email: 'x@example.com', displayName: null, role: 'user', access: 'viewer', workspaceRole: 'viewer', sharedWorkspace: true,
      tenant: { id: 'ten_x', name: 'T', storageMode: 'web', status: 'active', createdAt: 'c', deletionRequestedAt: null },
    });
    expect(JSON.stringify(dto)).not.toContain('usr_');
    expect(toPrincipalDto(SUPER, null)).toMatchObject({ role: 'super_admin', tenant: null, sharedWorkspace: false, workspaceRole: null });
  });
});

describe('resolving a verified email', () => {
  const tenant: TenantRow = { id: 'ten_a', name: 'A', storage_mode: 'web', status: 'active', created_at: '', updated_at: '', deletion_requested_at: null, deletion_requested_by: null };
  const user = (over: Partial<UserRow>): UserRow => ({ id: 'usr_a', email: 'a@example.com', tenant_id: 'ten_a', role: 'user', access: 'editor', status: 'active', created_at: '', updated_at: '', created_by: null, last_login_at: null, display_name: null, ...over });
  const supers = ['super@example.com'];
  const registryThatKnows = (u: UserRow | null, t: TenantRow = tenant) => async (): Promise<AuthResult> => (u === null ? { allowed: false, reason: 'unregistered' } : { allowed: true, user: u, tenant: t });

  it('parses the Super Admin list from configuration', () => {
    expect(parseEmailList(' Super@Example.com, other@example.com;  third@example.com garbage')).toEqual(['super@example.com', 'other@example.com', 'third@example.com']);
    expect(parseEmailList(undefined)).toEqual([]);
    expect(parseEmailList('')).toEqual([]);
    expect(isSuperAdminEmail('SUPER@example.com', supers)).toBe(true);
    expect(isSuperAdminEmail('someone@example.com', supers)).toBe(false);
    expect(isSuperAdminEmail('', supers)).toBe(false);
  });

  it('a configured Super Admin never touches the registry', async () => {
    let calls = 0;
    const r = await resolvePrincipal(' SUPER@example.com ', supers, async () => { calls += 1; return { allowed: false, reason: 'unregistered' }; });
    expect(r).toEqual({ ok: true, principal: { kind: 'super_admin', email: 'super@example.com' } });
    expect(calls).toBe(0);
  });

  it('a registered member becomes a principal bound to THEIR tenant', async () => {
    const r = await resolvePrincipal('a@example.com', supers, registryThatKnows(user({})));
    expect(r.ok && r.principal).toMatchObject({ kind: 'member', tenantId: 'ten_a', role: 'user', access: 'editor', storageMode: 'web' });
  });

  it('an admin is always an editor regardless of the stored access value', async () => {
    const r = await resolvePrincipal('a@example.com', supers, registryThatKnows(user({ role: 'admin', access: 'viewer' })));
    expect(r.ok && r.principal.kind === 'member' && r.principal.access).toBe('editor');
  });

  it('unknown and malformed identities fail closed', async () => {
    expect(await resolvePrincipal('stranger@example.com', supers, registryThatKnows(null))).toEqual({ ok: false, reason: 'unregistered' });
    for (const bad of ['', 'not-an-email', '   ']) {
      expect(await resolvePrincipal(bad, supers, registryThatKnows(user({})))).toEqual({ ok: false, reason: 'unregistered' });
    }
  });

  it('registry refusals pass through unchanged', () => {
    for (const reason of ['disabled', 'tenant_inactive', 'workspace_not_shared', 'unregistered'] as const) {
      expect(principalFromAuth({ allowed: false, reason })).toEqual({ ok: false, reason });
    }
  });
});

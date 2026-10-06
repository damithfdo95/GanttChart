import { describe, expect, it } from 'vitest';
import { decideStartup, deviceBelongsTo, type DeviceState } from '../app/startupDecision';
import type { ServerDetection } from '../lib/sync/serverMode';
import type { PrincipalDto, TenantDto } from '../../shared/tenancy';
import { deletionConfirmed } from '../features/tenancy/SuperAdminConsole';
import { errorKey, panelCapabilities } from '../features/tenancy/format';
import { ApiError } from '../lib/tenancy/api';

const tenant = (id: string, mode: 'local' | 'web' = 'web'): TenantDto => ({ id, name: id, storageMode: mode, status: 'active', createdAt: 't', deletionRequestedAt: null });

function member(over: Partial<PrincipalDto> & { tenantId?: string } = {}): Extract<ServerDetection, { mode: 'server' }> {
  const principal: PrincipalDto = {
    email: 'u@x.co',
    displayName: null,
    role: 'user',
    tenant: tenant(over.tenantId ?? 'ten_a'),
    access: 'editor',
    workspaceRole: 'editor',
    sharedWorkspace: true,
    ...over,
  };
  return { mode: 'server', principal, identity: principal.workspaceRole === null ? null : { email: principal.email, role: principal.workspaceRole } };
}

const NO_DEVICE: DeviceState = { link: null, hasMirror: false };
const linked = (email: string, tenantId?: string): DeviceState => ({ link: { origin: 'o', linkedAt: 't', email, ...(tenantId === undefined ? {} : { tenantId }) }, hasMirror: true });

describe('decideStartup', () => {
  it('no backend: plain local app', () => {
    expect(decideStartup({ mode: 'local' }, NO_DEVICE)).toEqual({ kind: 'local' });
  });

  it('denied is final — even a linked device gets no offline copy', () => {
    const d = decideStartup({ mode: 'denied', reason: 'disabled', email: 'u@x.co' }, linked('u@x.co', 'ten_a'));
    expect(d).toEqual({ kind: 'denied', reason: 'disabled', email: 'u@x.co' });
  });

  it('a super admin gets the console, never a workspace', () => {
    const principal: PrincipalDto = { email: 's@x.co', displayName: null, role: 'super_admin', tenant: null, access: null, workspaceRole: null, sharedWorkspace: false };
    expect(decideStartup({ mode: 'server', principal, identity: null }, linked('s@x.co', 'ten_a')).kind).toBe('super-admin');
  });

  it('an admin whose workspace is local runs the local app, and stale sync state of this device is cleared', () => {
    const d = decideStartup(member({ role: 'admin', tenant: tenant('ten_a', 'local'), workspaceRole: null, sharedWorkspace: false }), linked('u@x.co', 'ten_a'));
    expect(d).toMatchObject({ kind: 'local-tenant', clearDevice: true });
    expect(decideStartup(member({ role: 'admin', tenant: tenant('ten_a', 'local'), workspaceRole: null, sharedWorkspace: false }), NO_DEVICE)).toMatchObject({ kind: 'local-tenant', clearDevice: false });
  });

  it('a first device for a shared workspace goes through linking', () => {
    expect(decideStartup(member(), NO_DEVICE)).toMatchObject({ kind: 'link', foreignDevice: false });
  });

  it('the same person in the same workspace resumes from the device copy', () => {
    expect(decideStartup(member(), linked('u@x.co', 'ten_a')).kind).toBe('resume');
    expect(decideStartup(member(), linked('U@X.co', 'ten_a')).kind).toBe('resume'); // email case does not matter
  });

  it('a copy for ANOTHER workspace is foreign — never resumed, never offered for merging', () => {
    expect(decideStartup(member({ tenantId: 'ten_b' }), linked('u@x.co', 'ten_a'))).toMatchObject({ kind: 'link', foreignDevice: true });
  });

  it('a copy that belongs to ANOTHER PERSON on a shared browser is foreign', () => {
    expect(decideStartup(member(), linked('someone@else.co', 'ten_a'))).toMatchObject({ kind: 'link', foreignDevice: true });
  });

  it('a Stage-4 link that never recorded a workspace is not trusted', () => {
    expect(decideStartup(member(), linked('u@x.co'))).toMatchObject({ kind: 'link', foreignDevice: true });
  });

  it('a mirror without a link is not a usable copy', () => {
    expect(decideStartup(member(), { link: null, hasMirror: true })).toMatchObject({ kind: 'link', foreignDevice: true });
  });

  it('offline: only a properly recorded linked device keeps working', () => {
    expect(decideStartup({ mode: 'unreachable' }, linked('u@x.co', 'ten_a')).kind).toBe('resume');
    expect(decideStartup({ mode: 'unreachable' }, linked('u@x.co'))).toEqual({ kind: 'problem', problem: 'unreachable' });
    expect(decideStartup({ mode: 'unreachable' }, NO_DEVICE)).toEqual({ kind: 'problem', problem: 'unreachable' });
    expect(decideStartup({ mode: 'error', status: 500 }, NO_DEVICE)).toEqual({ kind: 'problem', problem: 'error', status: 500 });
  });

  it('NOT signed in shows the public page only — a linked device copy is never opened for an anonymous visitor', () => {
    expect(decideStartup({ mode: 'login-required' }, NO_DEVICE)).toEqual({ kind: 'landing' });
    expect(decideStartup({ mode: 'login-required' }, linked('u@x.co', 'ten_a'))).toEqual({ kind: 'landing' });
    expect(decideStartup({ mode: 'login-required' }, { link: null, hasMirror: true })).toEqual({ kind: 'landing' });
  });

  it('an authenticated person the registry does not know gets the denial, never a workspace or an account', () => {
    for (const reason of ['unregistered', 'disabled', 'tenant_inactive', 'workspace_not_shared'] as const) {
      expect(decideStartup({ mode: 'denied', reason, email: 'e@rakuten.com' }, NO_DEVICE)).toEqual({ kind: 'denied', reason, email: 'e@rakuten.com' });
    }
  });

  it('deviceBelongsTo needs the link, the mirror, the person and the workspace', () => {
    const p = member().principal;
    expect(deviceBelongsTo(linked('u@x.co', 'ten_a'), p)).toBe(true);
    expect(deviceBelongsTo({ link: linked('u@x.co', 'ten_a').link, hasMirror: false }, p)).toBe(false);
    expect(deviceBelongsTo(linked('u@x.co', 'ten_z'), p)).toBe(false);
    expect(deviceBelongsTo(linked('o@x.co', 'ten_a'), p)).toBe(false);
  });
});

describe('Super Admin deletion confirmation', () => {
  const tn = { id: 'ten_a', adminEmail: 'Boss@X.co' };
  it('needs BOTH the exact workspace id and the admin email (case-insensitive)', () => {
    expect(deletionConfirmed(tn, 'ten_a', 'boss@x.co')).toBe(true);
    expect(deletionConfirmed(tn, 'ten_a', ' boss@x.co ')).toBe(true);
    expect(deletionConfirmed(tn, 'ten_b', 'boss@x.co')).toBe(false);
    expect(deletionConfirmed(tn, 'ten_a', 'other@x.co')).toBe(false);
    expect(deletionConfirmed(tn, '', '')).toBe(false);
  });
});

describe('error messages', () => {
  it('known server codes map to their own message, anything else to the generic one (raw server text is never shown)', () => {
    expect(errorKey(new ApiError(409, 'email_taken', {}))).toBe('tenancy.error.email_taken');
    expect(errorKey(new ApiError(409, 'email_taken', {}), 'tester')).toBe('tenancy.error.tester_duplicate');
    expect(errorKey(new ApiError(409, 'email_in_other_workspace', {}), 'tester')).toBe('tenancy.error.email_in_other_workspace');
    expect(errorKey(new ApiError(403, 'same_person', {}))).toBe('tenancy.error.same_person');
    expect(errorKey(new ApiError(500, '<script>alert(1)</script>', {}))).toBe('tenancy.error.generic');
    expect(errorKey(new Error('x'))).toBe('tenancy.error.generic');
  });
});

describe('workspace panel capabilities', () => {
  const web = { storageMode: 'web' as const };
  const local = { storageMode: 'local' as const };
  it('a user sees the panel but can change nothing', () => {
    expect(panelCapabilities({ role: 'user', tenant: web })).toEqual({ showPanel: true, canChooseStorage: false, canManageUsers: false, canRequestDeletion: false });
  });
  it('an admin manages users only in web mode', () => {
    expect(panelCapabilities({ role: 'admin', tenant: web })).toMatchObject({ canChooseStorage: true, canManageUsers: true, canRequestDeletion: true });
    expect(panelCapabilities({ role: 'admin', tenant: local })).toMatchObject({ canChooseStorage: true, canManageUsers: false, canRequestDeletion: true });
  });
  it('a super admin or no backend gets no workspace panel', () => {
    expect(panelCapabilities({ role: 'super_admin', tenant: null }).showPanel).toBe(false);
    expect(panelCapabilities(null).showPanel).toBe(false);
  });
});

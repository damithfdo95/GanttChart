/**
 * Role-based access control: ONE authorization system.
 *
 * `Principal` is what the server knows about the caller AFTER authentication
 * and a registry lookup. `can(principal, action)` is the only place a role is
 * turned into a permission. It is a pure, default-DENY function so the whole
 * matrix can be tested exhaustively.
 *
 * The workspace-level `Role` ('admin' | 'editor' | 'viewer') used by the
 * WebSocket protocol is not a second system: it is DERIVED here from the
 * registry (`workspaceRoleOf`), never taken from configuration or the client.
 */

import type { Role } from '../../shared/protocol';
import type { AppRole, PrincipalDto, StorageMode, TenantDto, TenantStatus, UserAccess } from '../../shared/tenancy';

export interface SuperAdminPrincipal {
  kind: 'super_admin';
  email: string;
}

export interface MemberPrincipal {
  kind: 'member';
  email: string;
  userId: string;
  /** Derived server-side from the registry. Never from the request. */
  tenantId: string;
  tenantName: string;
  role: 'admin' | 'user';
  access: UserAccess;
  storageMode: StorageMode;
  tenantStatus: TenantStatus;
}

export type Principal = SuperAdminPrincipal | MemberPrincipal;

export type Action =
  // control plane (Super Admin only)
  | 'registry.view'
  | 'tenant.create'
  | 'tenant.setStatus'
  | 'tenant.approveDeletion'
  | 'legacy.adopt'
  // the caller's own tenant
  | 'tenant.view'
  | 'tenant.requestDeletion'
  | 'storage.migrate'
  | 'users.manage'
  // shared workspace data (web mode only)
  | 'data.read'
  | 'data.write'
  | 'data.restore'
  | 'data.replace';

const SUPER_ONLY: ReadonlySet<Action> = new Set<Action>(['registry.view', 'tenant.create', 'tenant.setStatus', 'tenant.approveDeletion', 'legacy.adopt']);

/** A shared workspace exists for this person right now. */
function workspaceIsShared(p: MemberPrincipal): boolean {
  return p.storageMode === 'web' && (p.tenantStatus === 'active' || p.tenantStatus === 'deletion_requested');
}

export function can(principal: Principal | null, action: Action): boolean {
  if (principal === null) return false;
  if (principal.kind === 'super_admin') {
    // The Super Admin administers the platform, not any tenant's QA data.
    return SUPER_ONLY.has(action);
  }
  if (SUPER_ONLY.has(action)) return false;
  const p = principal;
  switch (action) {
    case 'tenant.view':
      return true;
    case 'data.read':
      return workspaceIsShared(p);
    case 'data.write':
      return workspaceIsShared(p) && (p.role === 'admin' || p.access === 'editor');
    case 'data.restore':
    case 'data.replace':
      return workspaceIsShared(p) && p.role === 'admin';
    case 'users.manage':
      return p.role === 'admin' && p.storageMode === 'web' && p.tenantStatus === 'active';
    case 'storage.migrate':
      return p.role === 'admin' && p.tenantStatus === 'active';
    case 'tenant.requestDeletion':
      return p.role === 'admin' && (p.tenantStatus === 'active' || p.tenantStatus === 'deletion_requested');
    default:
      return false; // unknown action: deny
  }
}

export function appRoleOf(p: Principal): AppRole {
  return p.kind === 'super_admin' ? 'super_admin' : p.role;
}

/** The live-workspace permission level, or null when there is no shared workspace for this person. */
export function workspaceRoleOf(p: Principal): Role | null {
  if (p.kind !== 'member' || !can(p, 'data.read')) return null;
  if (p.role === 'admin') return 'admin';
  return p.access === 'editor' ? 'editor' : 'viewer';
}

export function toPrincipalDto(p: Principal, tenant: TenantDto | null): PrincipalDto {
  if (p.kind === 'super_admin') {
    return { email: p.email, role: 'super_admin', tenant: null, access: null, workspaceRole: null, sharedWorkspace: false };
  }
  const workspaceRole = workspaceRoleOf(p);
  return {
    email: p.email,
    role: p.role,
    tenant,
    access: p.role === 'admin' ? 'editor' : p.access,
    workspaceRole,
    sharedWorkspace: workspaceRole !== null,
  };
}

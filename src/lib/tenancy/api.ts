/**
 * Typed client for the tenancy / registry API. Same-origin, cookie-authenticated
 * (Cloudflare Access); state-changing calls carry the intent header the server
 * requires. The browser never sends a tenant id: the server derives it.
 */

import type { RecordPut } from '../../../shared/protocol';
import type { PrincipalDto, TenantDto, TenantSummaryDto, UserAccess, UserDto } from '../../../shared/tenancy';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** The server's machine-readable error code, e.g. "server_not_empty". */
    readonly code: string,
    readonly body: Record<string, unknown>,
  ) {
    super(`${status} ${code}`);
    this.name = 'ApiError';
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ServerState {
  revision: number;
  hash: string;
  counts: Record<string, number>;
  hasData: boolean;
  frozen: boolean;
}

export interface UploadBody {
  migrationId: string;
  expectedRevision: number;
  records: RecordPut[];
  replace?: boolean;
  confirm?: string;
}

export interface UploadOk {
  ok: true;
  revision: number;
  hash: string;
  counts: Record<string, number>;
  alreadyApplied: boolean;
}

export interface ExportAll {
  revision: number;
  hash: string;
  records: RecordPut[];
}

/** Everything the UI needs, as an interface so it can be faked in tests. */
export interface TenancyApi {
  inspect(): Promise<{ tenant: TenantDto; server: ServerState }>;
  upload(body: UploadBody): Promise<UploadOk>;
  activateWeb(revision: number, hash: string): Promise<{ tenant: TenantDto }>;
  deactivateWeb(revision: number, hash: string, confirm: string): Promise<{ tenant: TenantDto; cloudCopy: string }>;
  exportAll(): Promise<ExportAll>;
  whoami(): Promise<PrincipalDto>;
  listUsers(): Promise<UserDto[]>;
  createUser(email: string, access: UserAccess): Promise<UserDto>;
  updateUser(userId: string, patch: { status?: 'enabled' | 'disabled'; access?: UserAccess }): Promise<{ user: UserDto; disconnected: boolean }>;
  requestDeletion(): Promise<TenantDto>;
  cancelDeletion(): Promise<TenantDto>;
  // Super Admin
  listTenants(): Promise<TenantSummaryDto[]>;
  createTenant(name: string, adminEmail: string): Promise<{ tenant: TenantDto; admin: UserDto }>;
  setTenantStatus(tenantId: string, status: 'active' | 'deactivated'): Promise<TenantDto>;
  approveDeletion(tenantId: string, confirmTenantId: string, confirmAdminEmail: string): Promise<{ usersDeleted: number }>;
  audit(): Promise<DeletionAudit[]>;
}

export interface DeletionAudit {
  id: number;
  tenant_id: string;
  requested_by_email: string;
  requested_at: string;
  approved_by_email: string;
  approved_at: string;
  deleted_at: string | null;
  users_deleted: number;
}

export function createTenancyApi(fetchFn: FetchLike = (i, init) => fetch(i, init)): TenancyApi {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchFn(path, {
      method,
      credentials: 'same-origin',
      redirect: 'manual',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        ...(method === 'GET' ? {} : { 'X-GC-Intent': 'ui' }),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.type === 'opaqueredirect') throw new ApiError(401, 'login_required', {});
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      /* no JSON body */
    }
    if (!res.ok) throw new ApiError(res.status, typeof json.error === 'string' ? json.error : 'error', json);
    return json as T;
  }

  return {
    inspect: () => call('GET', '/api/tenant/storage/inspect'),
    upload: (body) => call('POST', '/api/tenant/storage/upload', body),
    activateWeb: (revision, hash) => call('POST', '/api/tenant/storage/activate-web', { revision, hash }),
    deactivateWeb: (revision, hash, confirm) => call('POST', '/api/tenant/storage/deactivate-web', { revision, hash, confirm }),
    exportAll: () => call('GET', '/api/export'),
    whoami: () => call('GET', '/api/whoami'),
    listUsers: async () => (await call<{ users: UserDto[] }>('GET', '/api/tenant/users')).users,
    createUser: async (email, access) => (await call<{ user: UserDto }>('POST', '/api/tenant/users', { email, access })).user,
    updateUser: (userId, patch) => call('PATCH', `/api/tenant/users/${encodeURIComponent(userId)}`, patch),
    requestDeletion: async () => (await call<{ tenant: TenantDto }>('POST', '/api/tenant/deletion-request', {})).tenant,
    cancelDeletion: async () => (await call<{ tenant: TenantDto }>('POST', '/api/tenant/deletion-request/cancel', {})).tenant,
    listTenants: async () => (await call<{ tenants: TenantSummaryDto[] }>('GET', '/api/super/tenants')).tenants,
    createTenant: (name, adminEmail) => call('POST', '/api/super/tenants', { name, adminEmail }),
    setTenantStatus: async (tenantId, status) => (await call<{ tenant: TenantDto }>('PATCH', `/api/super/tenants/${encodeURIComponent(tenantId)}`, { status })).tenant,
    approveDeletion: (tenantId, confirmTenantId, confirmAdminEmail) =>
      call('POST', `/api/super/tenants/${encodeURIComponent(tenantId)}/delete`, { confirmTenantId, confirmAdminEmail }),
    audit: async () => (await call<{ audit: DeletionAudit[] }>('GET', '/api/super/audit')).audit,
  };
}

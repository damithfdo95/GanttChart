/**
 * Typed client for the tenancy / registry API. Same-origin, cookie-authenticated
 * (Cloudflare Access); state-changing calls carry the intent header the server
 * requires. The browser never sends a tenant id: the server derives it.
 */

import type { RecordPut } from '../../../shared/protocol';
import type { NotificationFields } from '../../../shared/notifications';
import { REQUEST_DELETION_CONFIRMATION, TRANSFER_OWNERSHIP_CONFIRMATION, type TesterDto, type AdminAuditDto, type PrincipalDto, type TenantDto, type TenantListQuery, type TenantListResult, type UserAccess, type UserDto } from '../../../shared/tenancy';

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
  /** Add a Team Member: an SV or a Tester. The tenant is the server's, never sent. */
  createUser(email: string, access: UserAccess, displayName?: string, role?: 'sv' | 'tester'): Promise<UserDto>;
  updateUser(userId: string, patch: { status?: 'enabled' | 'disabled'; access?: UserAccess }): Promise<{ user: UserDto; disconnected: boolean }>;
  requestDeletion(): Promise<TenantDto>;
  cancelDeletion(): Promise<TenantDto>;
  /** Hand the workspace's ownership to another enabled SV (the Owner SV only; the typed word is checked by the server too). */
  transferOwnership(userId: string): Promise<{ owner: UserDto; previous: UserDto }>;
  /** Create a Team Member profile, with or without a login account (SV). The email is required only for an account. */
  createMember(input: { displayName: string; email?: string; role: 'sv' | 'tester'; createAccount?: boolean; access?: UserAccess }): Promise<{ memberId: string; user: UserDto | null; linked?: boolean }>;
  /** Edit a profile: name, team and (while there is no account) email. */
  editMember(memberId: string, patch: { displayName?: string; team?: string; email?: string | null; startDate?: string; endDate?: string | null; nameHistory?: Array<{ name: string; fromDate?: string; toDate?: string }> }): Promise<{ memberId: string; changed: boolean }>;
  /** Change a Team Member's role. For a linked member this changes the account's role and ends their live connections. */
  setMemberRole(memberId: string, role: 'sv' | 'tester'): Promise<{ memberId: string; role: 'sv' | 'tester'; disconnected: boolean }>;
  /** Remove a Team Member from active use (history stays); a linked account is disabled in the same action. */
  removeMember(memberId: string): Promise<{ memberId: string; accountDisabled: boolean; disconnected: boolean }>;
  /** Bring a removed Team Member back; a disabled account is re-enabled only when asked. */
  reactivateMember(memberId: string, reactivateAccount: boolean): Promise<{ memberId: string; accountReactivated: boolean; accountStillDisabled: boolean }>;
  /** Create the login account for a profile that has none; the profile becomes the linked one. */
  provisionAccount(memberId: string, access?: UserAccess): Promise<{ memberId: string; user: UserDto; linked: boolean; assignments: number }>;
  /** Assign a Team Member (linked or not) to a project, or one scope of it. */
  assignMember(projectId: string, memberId: string, scopeId?: string): Promise<{ created: boolean; linked?: boolean }>;
  /** Scheduled notifications (SV): create, change (also used to switch one on or off), delete. The server stamps who did it. */
  createNotification(fields: NotificationFields): Promise<{ id: string }>;
  updateNotification(id: string, fields: NotificationFields): Promise<{ id: string; action: string }>;
  deleteNotification(id: string): Promise<{ deleted: boolean }>;
  /** Close one occurrence of a notification for the signed-in person (the server decides the person and checks the occurrence). */
  acknowledgeNotification(id: string, occurrence: string): Promise<{ created: boolean }>;
  /** The workspace logo (SV): a small validated PNG, JPEG or WebP as base64. */
  setLogo(mime: string, data: string): Promise<{ bytes: number }>;
  removeLogo(): Promise<{ removed: boolean }>;
  /** The once-a-day housekeeping of old meeting plans and notes (SV opening Meeting History). */
  runRetention(): Promise<{ ran: boolean; plans: number; notes: number; acks: number }>;
  /** Link an older roster-only member to an account of this workspace (SV). */
  linkMember(memberId: string, userId: string): Promise<{ memberId: string }>;
  /** Give an account that predates Team Member profiles its profile (SV). */
  createProfile(userId: string): Promise<{ memberId: string; created: boolean }>;
  /** The Testers of this workspace (SVs only: assigning and workload). */
  team(): Promise<TesterDto[]>;
  /** Assign a Tester account to a project (Admin; the server checks the account and the project). */
  assignTester(projectId: string, userId: string, scopeId?: string): Promise<{ created: boolean; assignment: { id: string; projectId: string; userId: string } }>;
  /** This workspace's administrative history (Admin only). */
  tenantAudit(limit?: number): Promise<AdminAuditDto[]>;
  // Super Admin
  listTenants(query?: TenantListQuery): Promise<TenantListResult>;
  createTenant(name: string, adminEmail: string, displayName?: string): Promise<{ tenant: TenantDto; admin: UserDto }>;
  setTenantStatus(tenantId: string, status: 'active' | 'deactivated'): Promise<TenantDto>;
  rejectDeletion(tenantId: string): Promise<TenantDto>;
  platformAudit(limit?: number): Promise<AdminAuditDto[]>;
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
    createUser: async (email, access, displayName, role = 'tester') =>
      (await call<{ user: UserDto }>('POST', '/api/tenant/users', { email, access, role, ...(displayName === undefined || displayName.trim() === '' ? {} : { displayName }) })).user,
    transferOwnership: (userId) => call('POST', '/api/tenant/owner', { userId, confirm: TRANSFER_OWNERSHIP_CONFIRMATION }),
    linkMember: (memberId, userId) => call('POST', '/api/tenant/members/link', { memberId, userId }),
    createNotification: (fields) => call('POST', '/api/tenant/notifications', fields),
    updateNotification: (id, fields) => call('PATCH', `/api/tenant/notifications/${encodeURIComponent(id)}`, fields),
    deleteNotification: (id) => call('DELETE', `/api/tenant/notifications/${encodeURIComponent(id)}`),
    acknowledgeNotification: (id, occurrence) => call('POST', `/api/tenant/notifications/${encodeURIComponent(id)}/ack`, { occurrence }),
    setLogo: (mime, data) => call('PUT', '/api/tenant/branding', { mime, data }),
    removeLogo: () => call('DELETE', '/api/tenant/branding'),
    runRetention: () => call('POST', '/api/tenant/retention', {}),
    createMember: (input) => call('POST', '/api/tenant/members', input),
    editMember: (memberId, patch) => call('PATCH', `/api/tenant/members/${encodeURIComponent(memberId)}`, patch),
    setMemberRole: (memberId, role) => call('POST', `/api/tenant/members/${encodeURIComponent(memberId)}/role`, { role }),
    removeMember: (memberId) => call('POST', `/api/tenant/members/${encodeURIComponent(memberId)}/remove`, {}),
    reactivateMember: (memberId, reactivateAccount) => call('POST', `/api/tenant/members/${encodeURIComponent(memberId)}/reactivate`, { reactivateAccount }),
    provisionAccount: (memberId, access) => call('POST', `/api/tenant/members/${encodeURIComponent(memberId)}/account`, access === undefined ? {} : { access }),
    assignMember: (projectId, memberId, scopeId) => call('POST', '/api/tenant/assignments', { projectId, memberId, ...(scopeId === undefined ? {} : { scopeId }) }),
    createProfile: (userId) => call('POST', '/api/tenant/members/profile', { userId }),
    updateUser: (userId, patch) => call('PATCH', `/api/tenant/users/${encodeURIComponent(userId)}`, patch),
    requestDeletion: async () => (await call<{ tenant: TenantDto }>('POST', '/api/tenant/deletion-request', { confirm: REQUEST_DELETION_CONFIRMATION })).tenant,
    team: async () => (await call<{ testers: TesterDto[] }>('GET', '/api/tenant/team')).testers,
    assignTester: (projectId, userId, scopeId) => call('POST', '/api/tenant/assignments', { projectId, userId, ...(scopeId === undefined ? {} : { scopeId }) }),
    tenantAudit: async (limit = 100) => (await call<{ audit: AdminAuditDto[] }>('GET', `/api/tenant/audit?limit=${limit}`)).audit,
    cancelDeletion: async () => (await call<{ tenant: TenantDto }>('POST', '/api/tenant/deletion-request/cancel', {})).tenant,
    listTenants: (query = {}) => {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') params.set(k, String(v));
      const qs = params.toString();
      return call<TenantListResult>('GET', `/api/super/tenants${qs === '' ? '' : `?${qs}`}`);
    },
    createTenant: (name, adminEmail, displayName) => call('POST', '/api/super/tenants', { name, adminEmail, ...(displayName === undefined || displayName.trim() === '' ? {} : { displayName }) }),
    rejectDeletion: async (tenantId) => (await call<{ tenant: TenantDto }>('POST', `/api/super/tenants/${encodeURIComponent(tenantId)}/reject-deletion`, {})).tenant,
    platformAudit: async (limit = 100) => (await call<{ audit: AdminAuditDto[] }>('GET', `/api/super/admin-audit?limit=${limit}`)).audit,
    setTenantStatus: async (tenantId, status) => (await call<{ tenant: TenantDto }>('PATCH', `/api/super/tenants/${encodeURIComponent(tenantId)}`, { status })).tenant,
    approveDeletion: (tenantId, confirmTenantId, confirmAdminEmail) =>
      call('POST', `/api/super/tenants/${encodeURIComponent(tenantId)}/delete`, { confirmTenantId, confirmAdminEmail }),
    audit: async () => (await call<{ audit: DeletionAudit[] }>('GET', '/api/super/audit')).audit,
  };
}

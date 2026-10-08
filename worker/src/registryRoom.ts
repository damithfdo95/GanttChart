/**
 * RegistryRoom — the control plane. ONE Durable Object that knows which tenants
 * and users exist and what state they are in. It never stores QA content.
 *
 * Only the Worker calls it (Durable Object RPC); nothing in the browser can
 * reach it. All rules live in RegistryStore, which is unit-tested against real
 * SQLite; this class only supplies the clock and converts rows to DTOs.
 */

import { DurableObject } from 'cloudflare:workers';
import { isManagedEmail, parseManagedDomains, type AdminAuditDto, type AuditAction, type AuditActor, type StorageMode, type TenantDto, type TenantListQuery, type TenantListResult, type TesterDto, type UserAccess, type UserDto } from '../../shared/tenancy';
import { RegistryStore, toTenantDto, toUserDto, type AuthResult, type DeletionAuditRow, type Reg, type UserRow } from './registry';

const mapReg = <A, B>(r: Reg<A>, f: (a: A) => B): Reg<B> => (r.ok ? { ok: true, value: f(r.value) } : r);

export class RegistryRoom extends DurableObject<Env> {
  private readonly store: RegistryStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new RegistryStore({
      sql: ctx.storage.sql,
      transactionSync: (fn) => ctx.storage.transactionSync(fn),
    });
    ctx.blockConcurrencyWhile(async () => {
      this.store.init();
    });
  }

  private now(): string {
    return new Date().toISOString();
  }

  /**
   * The managed organisation domains, read from the deployment's configuration HERE, so no
   * caller can forget to apply the rule or pass a different one.
   */
  private managedDomains(): string[] {
    return parseManagedDomains(this.env.MANAGED_USER_EMAIL_DOMAINS);
  }

  /** Authenticated email → may they use the application, and as what? */
  async authenticate(email: string): Promise<AuthResult> {
    return this.store.authenticate(email, this.now());
  }

  async getTenant(tenantId: string): Promise<TenantDto | null> {
    const t = this.store.getTenant(tenantId);
    return t === null ? null : toTenantDto(t);
  }

  async adminEmailOf(tenantId: string): Promise<string | null> {
    return this.store.adminOf(tenantId)?.email ?? null;
  }

  // ---- Super Admin ----

  async listTenants(query: TenantListQuery = {}): Promise<TenantListResult> {
    const domains = this.managedDomains();
    const { rows, total } = this.store.listTenantSummaries(query);
    return { total, tenants: rows.map((t) => ({ ...t, adminOutsideManagedDomains: t.adminEmail !== '' && !isManagedEmail(t.adminEmail, domains) })) };
  }

  /** Administrative audit entries for ONE reader scope. The Worker chooses the scope from the verified principal. */
  async listAdminAudit(scope: { kind: 'platform' } | { kind: 'tenant'; tenantId: string }, limit?: number, beforeId?: number): Promise<AdminAuditDto[]> {
    return this.store.listAdminAudit(scope, limit, beforeId);
  }

  /** An event that happens outside the registry (e.g. a workspace upload) but belongs in the trail. The actor comes from the Worker's verified principal. */
  async appendAudit(entry: { action: AuditAction; actor: AuditActor; tenantId: string; meta?: Record<string, string | number | boolean | null> }): Promise<void> {
    this.store.appendAudit({ at: this.now(), action: entry.action, actor: entry.actor, tenantId: entry.tenantId, targetType: 'tenant', targetId: entry.tenantId, meta: entry.meta });
  }

  async listTesters(tenantId: string): Promise<TesterDto[]> {
    return this.store.listTesters(tenantId);
  }

  async getTester(tenantId: string, userId: string): Promise<TesterDto | null> {
    return this.store.getTester(tenantId, userId);
  }

  async createTenant(input: { name: string; adminEmail: string; displayName?: unknown; reserved: string[]; actorEmail: string }): Promise<Reg<{ tenant: TenantDto; admin: UserDto }>> {
    return mapReg(this.store.createTenantWithAdmin({ ...input, managedDomains: this.managedDomains(), now: this.now() }), (v) => ({ tenant: toTenantDto(v.tenant), admin: toUserDto(v.admin, v.tenant.owner_user_id) }));
  }

  async setTenantStatus(tenantId: string, status: 'active' | 'deactivated', actorEmail: string): Promise<Reg<TenantDto>> {
    return mapReg(this.store.setTenantStatus(tenantId, status, actorEmail, this.now()), toTenantDto);
  }

  async rejectDeletion(tenantId: string, actorEmail: string): Promise<Reg<TenantDto>> {
    return mapReg(this.store.rejectDeletion({ tenantId, actorEmail, now: this.now() }), toTenantDto);
  }

  async beginDeletion(tenantId: string, approverEmail: string): Promise<Reg<{ tenant: TenantDto; requesterEmail: string }>> {
    return mapReg(this.store.beginDeletion({ tenantId, approverEmail, now: this.now() }), (v) => ({ tenant: toTenantDto(v.tenant), requesterEmail: v.requesterEmail }));
  }

  async finishDeletion(tenantId: string, approverEmail: string, requesterEmail: string): Promise<Reg<{ usersDeleted: number }>> {
    return this.store.finishDeletion({ tenantId, approverEmail, requesterEmail, now: this.now() });
  }

  async listAudit(): Promise<DeletionAuditRow[]> {
    return this.store.listAudit();
  }

  // ---- a tenant's own Admin (the tenant id always comes from the verified principal) ----

  private dto(u: UserRow): UserDto {
    return toUserDto(u, this.store.ownerIdOf(u.tenant_id));
  }

  async listUsers(tenantId: string): Promise<UserDto[]> {
    const owner = this.store.ownerIdOf(tenantId);
    return this.store.listUsers(tenantId).map((u) => toUserDto(u, owner));
  }

  async getUser(tenantId: string, userId: string): Promise<UserDto | null> {
    const u = this.store.getUserInTenant(tenantId, userId);
    return u === null ? null : this.dto(u);
  }

  async createUser(input: { tenantId: string; email: string; displayName?: unknown; role?: 'admin' | 'user'; access: UserAccess; reserved: string[]; actor: AuditActor }): Promise<Reg<UserDto>> {
    return mapReg(this.store.createUser({ ...input, managedDomains: this.managedDomains(), now: this.now() }), (u) => this.dto(u));
  }

  async updateUser(input: { tenantId: string; userId: string; status?: 'enabled' | 'disabled'; access?: UserAccess; actor: AuditActor }): Promise<Reg<UserDto>> {
    return mapReg(this.store.updateUser({ ...input, now: this.now() }), (u) => this.dto(u));
  }

  /** Stage 8D: SV <-> Tester. The Owner SV and the caller themselves are protected; the caller then closes the person's connections. */
  async changeRole(input: { tenantId: string; userId: string; role: 'admin' | 'user'; actor: AuditActor }): Promise<Reg<UserDto>> {
    return mapReg(this.store.changeRole({ ...input, now: this.now() }), (u) => this.dto(u));
  }

  /** Stage 8D: a Team Member event of the workspace for the administrative trail (actor from the Worker's verified principal). */
  async recordMemberEvent(input: { tenantId: string; action: Extract<AuditAction, `member.${string}` | `notification.${string}` | `branding.${string}`>; actor: AuditActor; userId?: string | null; meta?: Record<string, string | number | boolean | null> }): Promise<void> {
    this.store.recordMemberEvent({ ...input, now: this.now() });
  }

  /** The Owner SV hands ownership to another enabled SV of the same workspace (one atomic statement). */
  async transferOwnership(input: { tenantId: string; actor: AuditActor; toUserId: string }): Promise<Reg<{ owner: UserDto; previous: UserDto }>> {
    return mapReg(this.store.transferOwnership({ ...input, now: this.now() }), (v) => ({ owner: this.dto(v.owner), previous: this.dto(v.previous) }));
  }

  async setStorageMode(tenantId: string, mode: StorageMode, actor: AuditActor): Promise<Reg<TenantDto>> {
    return mapReg(this.store.setStorageMode(tenantId, mode, actor, this.now()), toTenantDto);
  }

  async renameTenant(tenantId: string, name: string): Promise<Reg<TenantDto>> {
    return mapReg(this.store.renameTenant(tenantId, name, this.now()), toTenantDto);
  }

  async requestDeletion(tenantId: string, requestedByUserId: string): Promise<Reg<TenantDto>> {
    return mapReg(this.store.requestDeletion({ tenantId, requestedByUserId, now: this.now() }), toTenantDto);
  }

  async cancelDeletion(tenantId: string, requestedByUserId: string): Promise<Reg<TenantDto>> {
    return mapReg(this.store.cancelDeletion({ tenantId, requestedByUserId, now: this.now() }), toTenantDto);
  }
}

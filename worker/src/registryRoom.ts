/**
 * RegistryRoom — the control plane. ONE Durable Object that knows which tenants
 * and users exist and what state they are in. It never stores QA content.
 *
 * Only the Worker calls it (Durable Object RPC); nothing in the browser can
 * reach it. All rules live in RegistryStore, which is unit-tested against real
 * SQLite; this class only supplies the clock and converts rows to DTOs.
 */

import { DurableObject } from 'cloudflare:workers';
import type { StorageMode, TenantDto, TenantSummaryDto, UserAccess, UserDto } from '../../shared/tenancy';
import { RegistryStore, toTenantDto, toUserDto, type AuthResult, type DeletionAuditRow, type Reg } from './registry';

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

  async listTenants(): Promise<TenantSummaryDto[]> {
    return this.store.listTenantSummaries();
  }

  async createTenant(input: { name: string; adminEmail: string; reserved: string[]; actorEmail: string }): Promise<Reg<{ tenant: TenantDto; admin: UserDto }>> {
    return mapReg(this.store.createTenantWithAdmin({ ...input, now: this.now() }), (v) => ({ tenant: toTenantDto(v.tenant), admin: toUserDto(v.admin) }));
  }

  async setTenantStatus(tenantId: string, status: 'active' | 'deactivated'): Promise<Reg<TenantDto>> {
    return mapReg(this.store.setTenantStatus(tenantId, status, this.now()), toTenantDto);
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

  async listUsers(tenantId: string): Promise<UserDto[]> {
    return this.store.listUsers(tenantId).map(toUserDto);
  }

  async createUser(input: { tenantId: string; email: string; access: UserAccess; reserved: string[]; actorUserId: string }): Promise<Reg<UserDto>> {
    return mapReg(this.store.createUser({ ...input, now: this.now() }), toUserDto);
  }

  async updateUser(input: { tenantId: string; userId: string; status?: 'enabled' | 'disabled'; access?: UserAccess }): Promise<Reg<UserDto>> {
    return mapReg(this.store.updateUser({ ...input, now: this.now() }), toUserDto);
  }

  async setStorageMode(tenantId: string, mode: StorageMode): Promise<Reg<TenantDto>> {
    return mapReg(this.store.setStorageMode(tenantId, mode, this.now()), toTenantDto);
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

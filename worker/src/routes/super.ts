/**
 * Super Admin API routes (/api/super/*): the registry control plane — tenant
 * listing/creation, platform audit, legacy adoption and the two-step
 * permanent-deletion approval. Metadata and explicit privileged actions only.
 */

import {
  CLOSE_CODES,
  isTenantId,
  normalizeEmail,
  type TenantListQuery,
} from '../../../shared/tenancy';
import { json, need, problem, readJson, registryProblem, revisionParam, type Ctx } from '../http';
import { LEGACY_WORKSPACE_NAME } from '../workspaceRoom';

export async function superRoutes(ctx: Ctx): Promise<Response | null> {
  const { path, method } = ctx;
  if (!path.startsWith('/api/super/')) return null;
  if (ctx.principal.kind !== 'super_admin') return problem(403, 'forbidden', { reason: 'role' });
  const actor = ctx.principal.email;

  if (path === '/api/super/tenants' && method === 'GET') {
    const denial = need(ctx, 'registry.view');
    if (denial !== null) return denial;
    const query = parseTenantQuery(ctx.url.searchParams);
    if (query === null) return problem(400, 'invalid_query');
    return json(await ctx.registry.listTenants(query));
  }

  if (path === '/api/super/tenants' && method === 'POST') {
    const denial = need(ctx, 'tenant.create');
    if (denial !== null) return denial;
    const body = await readJson(ctx);
    if (!body.ok) return body.response;
    const result = await ctx.registry.createTenant({
      name: String(body.body.name ?? ''),
      adminEmail: String(body.body.adminEmail ?? ''),
      displayName: body.body.displayName,
      reserved: ctx.superAdmins,
      actorEmail: actor,
    });
    return result.ok ? json(result.value, 201) : registryProblem(result.error);
  }

  if (path === '/api/super/audit' && method === 'GET') {
    const denial = need(ctx, 'registry.view');
    if (denial !== null) return denial;
    return json({ audit: await ctx.registry.listAudit() });
  }

  // Platform-level administrative history: workspace events only, never account events inside a workspace.
  if (path === '/api/super/admin-audit' && method === 'GET') {
    const denial = need(ctx, 'audit.platform');
    if (denial !== null) return denial;
    const limit = Math.min(200, Math.max(1, Number(ctx.url.searchParams.get('limit') ?? 100) || 100));
    const beforeRaw = ctx.url.searchParams.get('before');
    const before = beforeRaw === null ? undefined : (revisionParam(beforeRaw) ?? undefined);
    return json({ audit: await ctx.registry.listAdminAudit({ kind: 'platform' }, limit, before) });
  }

  if (path === '/api/super/legacy/adopt' && method === 'POST') {
    const denial = need(ctx, 'legacy.adopt');
    if (denial !== null) return denial;
    const body = await readJson(ctx);
    if (!body.ok) return body.response;
    return adoptLegacy(ctx, body.body.tenantId);
  }

  const one = /^\/api\/super\/tenants\/([^/]+)(\/delete|\/reject-deletion)?$/.exec(path);
  if (one !== null) {
    const tenantId = one[1] ?? '';
    if (!isTenantId(tenantId)) return problem(400, 'invalid_tenant_id');

    if (one[2] === undefined && method === 'PATCH') {
      const denial = need(ctx, 'tenant.setStatus');
      if (denial !== null) return denial;
      const body = await readJson(ctx);
      if (!body.ok) return body.response;
      const status = body.body.status;
      if (status !== 'active' && status !== 'deactivated') return problem(400, 'invalid_status');
      const result = await ctx.registry.setTenantStatus(tenantId, status, actor);
      if (!result.ok) return registryProblem(result.error);
      if (status === 'deactivated') await ctx.env.WORKSPACE.getByName(tenantId).disconnectAll(tenantId, CLOSE_CODES.accessRevoked, 'workspace deactivated');
      return json({ tenant: result.value });
    }

    if (one[2] === '/delete' && method === 'POST') return approveDeletion(ctx, tenantId, actor);

    if (one[2] === '/reject-deletion' && method === 'POST') {
      const denial = need(ctx, 'tenant.rejectDeletion');
      if (denial !== null) return denial;
      const body = await readJson(ctx);
      if (!body.ok) return body.response;
      const result = await ctx.registry.rejectDeletion(tenantId, actor);
      return result.ok ? json({ tenant: result.value }) : registryProblem(result.error);
    }
  }
  return null;
}

const TENANT_SORTS: ReadonlySet<string> = new Set(['name', 'created', 'admin', 'activity', 'status', 'accounts']);
const TENANT_STATUS_FILTERS: ReadonlySet<string> = new Set(['all', 'active', 'disabled', 'deactivated', 'deletion_requested', 'deleting']);

/** The Super Admin list's search/filter/sort/paging, validated; null = a value that is not allowed. */
function parseTenantQuery(params: URLSearchParams): TenantListQuery | null {
  const query: TenantListQuery = {};
  const q = params.get('q');
  if (q !== null) query.q = q.slice(0, 100);
  const status = params.get('status');
  if (status !== null) {
    if (!TENANT_STATUS_FILTERS.has(status)) return null;
    query.status = status as TenantListQuery['status'];
  }
  const mode = params.get('mode');
  if (mode !== null) {
    if (mode !== 'all' && mode !== 'local' && mode !== 'web') return null;
    query.mode = mode;
  }
  const sort = params.get('sort');
  if (sort !== null) {
    if (!TENANT_SORTS.has(sort)) return null;
    query.sort = sort as TenantListQuery['sort'];
  }
  const dir = params.get('dir');
  if (dir !== null) {
    if (dir !== 'asc' && dir !== 'desc') return null;
    query.dir = dir;
  }
  for (const key of ['limit', 'offset'] as const) {
    const raw = params.get(key);
    if (raw === null) continue;
    if (!/^\d{1,6}$/.test(raw)) return null;
    query[key] = Number(raw);
  }
  return query;
}

/**
 * Permanent deletion. The scope is stated back to the Super Admin as two typed
 * confirmations (the tenant id and the admin's email). Order matters for safety
 * and retries: (1) all access stops at once, (2) the tenant's workspace data is
 * destroyed, (3) the registry rows are removed in one transaction with a minimal
 * audit row. A failure after (1) leaves the tenant 'deleting' and the same
 * approval can simply be repeated.
 */
async function approveDeletion(ctx: Ctx, tenantId: string, approver: string): Promise<Response> {
  const denial = need(ctx, 'tenant.approveDeletion');
  if (denial !== null) return denial;
  const body = await readJson(ctx);
  if (!body.ok) return body.response;
  const adminEmail = await ctx.registry.adminEmailOf(tenantId);
  if (adminEmail === null) return problem(404, 'not_found');
  if (body.body.confirmTenantId !== tenantId || normalizeEmail(body.body.confirmAdminEmail) !== adminEmail) return problem(400, 'confirmation_mismatch');

  const begun = await ctx.registry.beginDeletion(tenantId, approver);
  if (!begun.ok) return registryProblem(begun.error);
  await ctx.env.WORKSPACE.getByName(tenantId).destroy(tenantId);
  const done = await ctx.registry.finishDeletion(tenantId, approver, begun.value.requesterEmail);
  return done.ok ? json({ deleted: true, usersDeleted: done.value.usersDeleted }) : registryProblem(done.error);
}

/** Copy the pre-tenant Stage 4 workspace into a tenant whose workspace is still empty. */
async function adoptLegacy(ctx: Ctx, rawTenantId: unknown): Promise<Response> {
  if (!isTenantId(rawTenantId)) return problem(400, 'invalid_tenant_id');
  const tenant = await ctx.registry.getTenant(rawTenantId);
  if (tenant === null) return problem(404, 'not_found');
  if (tenant.status !== 'active') return problem(409, 'tenant_inactive');
  const target = ctx.env.WORKSPACE.getByName(rawTenantId);
  const state = await target.verifyState(rawTenantId);
  if (state.hasData) return problem(409, 'server_not_empty');
  const legacy = await ctx.env.WORKSPACE.getByName(LEGACY_WORKSPACE_NAME).exportLegacy();
  if (legacy.records.length === 0) return problem(409, 'nothing_to_adopt');
  const result = await target.importWorkspace(rawTenantId, {
    migrationId: `legacy-adopt-${rawTenantId}`,
    records: legacy.records,
    expectedRevision: state.revision,
    replace: false,
    actor: ctx.principal.email,
  });
  console.warn(JSON.stringify({ event: 'legacy_adopted', tenantId: rawTenantId, by: ctx.principal.email }));
  return result.ok ? json(result) : problem(409, result.error, { message: result.message });
}

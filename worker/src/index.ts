/**
 * Worker entry. Every API/WebSocket request goes through ONE pipeline:
 *
 *   1. origin / CSRF checks
 *   2. authenticate  -> verified email (Cloudflare Access JWT)        [auth.ts]
 *   3. resolve       -> principal via the registry; unknown = refused  [principal.ts]
 *   4. tenant guard  -> any tenant id supplied by the client that disagrees is rejected
 *   5. authorize     -> one named permission per route                 [permissions.ts]
 *   6. act           -> on the tenant taken from the PRINCIPAL, never from the request
 *
 * Static assets (the built SPA) are PUBLIC and served by the platform; `run_worker_first`
 * sends only the routes in shared/routes.ts (/api/*, /ws, /login) here. Those
 * are the only routes that matter for security, and each one verifies the
 * Cloudflare Access token ITSELF — the Worker never assumes Access was in front.
 */

import { AuthError, DEV_IDENTITY_COOKIE, authenticate, type VerifiedIdentity } from './auth';
import { isWorkerPath } from '../../shared/routes';
import { can, toPrincipalDto, workspaceRoleOf, type Action, type MemberPrincipal, type Principal } from './permissions';
import { parseEmailList, resolvePrincipal } from './principal';
import type { RegistryError } from './registry';
import { IDENTITY_EMAIL_HEADER, IDENTITY_EXPIRES_HEADER, IDENTITY_ROLE_HEADER, IDENTITY_USER_HEADER, LEGACY_WORKSPACE_NAME, TENANT_HEADER, WorkspaceRoom } from './workspaceRoom';
import { RegistryRoom } from './registryRoom';
import {
  CLOSE_CODES,
  REPLACE_CONFIRMATION,
  REQUEST_DELETION_CONFIRMATION,
  SWITCH_TO_LOCAL_CONFIRMATION,
  canonicalRecordsHash,
  emailDomain,
  isTenantId,
  isUserId,
  normalizeEmail,
  type AuditActor,
  type DenyReason,
  type TenantListQuery,
  type UserAccess,
} from '../../shared/tenancy';

export { WorkspaceRoom, RegistryRoom };

const REGISTRY_NAME = 'registry';

/** Header a cross-site page cannot send without a CORS preflight (which we never allow). */
const INTENT_HEADER = 'x-gc-intent';
const MAX_BODY_CHARS = 25_000_000;

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
} as const;

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...extra },
  });
}

function problem(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return json({ error, ...extra }, status);
}

function allowedOrigins(request: Request, env: Env): Set<string> {
  const own = new URL(request.url).origin;
  const extra = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return new Set([own, ...extra]);
}

/** Browsers always send Origin on WebSocket upgrades and cross-origin/unsafe requests. */
function originAllowed(request: Request, env: Env, required: boolean): boolean {
  const origin = request.headers.get('Origin');
  if (origin === null) return !required;
  return allowedOrigins(request, env).has(origin);
}

function revisionParam(segment: string): number | null {
  return /^\d{1,12}$/.test(segment) ? Number(segment) : null;
}

// ---- request context -----------------------------------------------------------

interface Ctx {
  request: Request;
  env: Env;
  url: URL;
  path: string;
  method: string;
  identity: VerifiedIdentity;
  principal: Principal;
  superAdmins: string[];
  registry: DurableObjectStub<RegistryRoom>;
}

/** The tenant's workspace object. Only ever called with a tenant id taken from a verified principal. */
function roomFor(ctx: Ctx, principal: MemberPrincipal): DurableObjectStub<WorkspaceRoom> {
  return ctx.env.WORKSPACE.getByName(principal.tenantId);
}

function member(ctx: Ctx): MemberPrincipal | null {
  return ctx.principal.kind === 'member' ? ctx.principal : null;
}

/**
 * Who is acting, for the administrative audit trail. Taken ONLY from the verified principal: no request
 * field, header or body can name the actor.
 */
function actorOf(principal: Principal): AuditActor {
  return principal.kind === 'super_admin' ? { userId: null, email: principal.email, role: 'super_admin' } : { userId: principal.userId, email: principal.email, role: principal.role };
}

const FORGED_KEYS = ['tenantid', 'tenant_id', 'tenant', 'workspaceid', 'workspace_id', 'workspace'];

/**
 * A browser has no business naming a tenant. The tenant is derived from who
 * you are. If a request names one anyway and it is not yours, it is rejected
 * (and, either way, never used).
 */
function forgedTenant(ctx: Ctx, body: unknown): boolean {
  const own = ctx.principal.kind === 'member' ? ctx.principal.tenantId : null;
  const differs = (v: unknown): boolean => v !== undefined && v !== null && String(v) !== own;
  for (const [k, v] of ctx.url.searchParams) if (FORGED_KEYS.includes(k.toLowerCase()) && differs(v)) return true;
  for (const h of [TENANT_HEADER, 'x-tenant-id', 'x-workspace-id']) {
    const v = ctx.request.headers.get(h);
    if (v !== null && differs(v)) return true;
  }
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) if (FORGED_KEYS.includes(k.toLowerCase()) && differs(v)) return true;
  }
  return false;
}

async function readJson(ctx: Ctx): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  const declared = Number(ctx.request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_CHARS) return { ok: false, response: problem(413, 'too_large') };
  let text: string;
  try {
    text = await ctx.request.text();
  } catch {
    return { ok: false, response: problem(400, 'unreadable_body') };
  }
  if (text.length > MAX_BODY_CHARS) return { ok: false, response: problem(413, 'too_large') };
  let parsed: unknown;
  try {
    parsed = text === '' ? {} : JSON.parse(text);
  } catch {
    return { ok: false, response: problem(400, 'invalid_json') };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, response: problem(400, 'invalid_body') };
  if (ctx.principal.kind === 'member' && forgedTenant(ctx, parsed)) return { ok: false, response: problem(403, 'tenant_mismatch') };
  return { ok: true, body: parsed as Record<string, unknown> };
}

/** 403 unless the principal holds the action. */
function need(ctx: Ctx, action: Action): Response | null {
  return can(ctx.principal, action) ? null : problem(403, 'forbidden', { reason: 'role', action });
}

const REGISTRY_STATUS: Record<RegistryError, number> = {
  invalid_email: 400,
  invalid_name: 400,
  invalid_input: 400,
  email_taken: 409,
  email_in_other_workspace: 409,
  email_reserved: 409,
  invalid_display_name: 400,
  email_domain_not_allowed: 400,
  managed_domains_not_configured: 503,
  not_found: 404,
  wrong_mode: 409,
  tenant_inactive: 409,
  bad_state: 409,
  forbidden_target: 403,
  same_person: 403,
};

function registryProblem(error: RegistryError): Response {
  return problem(REGISTRY_STATUS[error] ?? 400, error);
}

// ---- entry ---------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof AuthError) {
        if (error.status === 500) console.error(JSON.stringify({ event: 'auth_misconfigured' }));
        return problem(error.status, error.message);
      }
      console.error(JSON.stringify({ event: 'unhandled', error: String(error) }));
      return problem(500, 'Internal error');
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (!isWorkerPath(path)) {
    // Everything else is the PUBLIC SPA shell (normally served by the platform before reaching here).
    return env.ASSETS.fetch(request);
  }

  if (path === '/login') return login(request, env);

  // 1. origin / CSRF
  if (path === '/ws') {
    if (request.headers.get('Upgrade') !== 'websocket') return problem(426, 'Expected WebSocket');
    if (!originAllowed(request, env, true)) return problem(403, 'Origin not allowed');
  } else if (method !== 'GET') {
    // Unsafe methods need a same-origin Origin AND the intent header (CSRF defence in depth).
    if (!originAllowed(request, env, true)) return problem(403, 'Origin not allowed');
    if (request.headers.get(INTENT_HEADER) === null) return problem(403, 'Missing intent header');
  }

  // 2. authenticate
  const identity = await authenticate(request, env);

  // Development only: switch which person this browser is (so every role can be tried locally).
  if (path === '/api/dev/as' && method === 'POST' && env.ENVIRONMENT === 'development') {
    const email = normalizeEmail(((await request.json().catch(() => ({}))) as { email?: unknown }).email);
    if (email === null) return problem(400, 'invalid_email');
    return json({ email }, 200, { 'Set-Cookie': `${DEV_IDENTITY_COOKIE}=${encodeURIComponent(email)}; Path=/; SameSite=Strict` });
  }

  // 3. resolve the principal through the registry (unknown identities fail closed)
  const registry = env.REGISTRY.getByName(REGISTRY_NAME);
  const superAdmins = parseEmailList(env.SUPER_ADMIN_EMAILS);
  const resolved = await resolvePrincipal(identity.email, superAdmins, (email) => registry.authenticate(email));
  if (!resolved.ok) return denied(resolved.reason, identity.email);

  const ctx: Ctx = { request, env, url, path, method, identity, principal: resolved.principal, superAdmins, registry };

  // 4. a browser may not name a tenant
  if (ctx.principal.kind === 'member' && forgedTenant(ctx, undefined)) return problem(403, 'tenant_mismatch');

  if (path === '/ws') return openSocket(ctx);
  if (path === '/api/whoami' && method === 'GET') return whoami(ctx);

  return (await tenantRoutes(ctx)) ?? (await superRoutes(ctx)) ?? problem(404, 'Not found');
}

function denied(reason: DenyReason, email: string): Response {
  // A person Cloudflare Access let in but the application does not know (or no longer allows). Logged without the
  // mailbox name: enough to see that someone is trying, not enough to build a list of people.
  console.warn(JSON.stringify({ event: 'access_denied', reason, domain: emailDomain(email) }));
  return problem(403, 'forbidden', { reason, email });
}

// ---- sign-in ----------------------------------------------------------------------

/**
 * `/login` exists so that "Sign in" has a URL Cloudflare Access protects. Access
 * challenges the visitor there; once they are through, the request reaches this
 * Worker WITH a token, which is verified like any other, and the person is sent
 * back to the app at "/". The destination is fixed: there is no redirect parameter, so this
 * can never be used as an open redirect. Reaching this code without a valid token
 * (Access not configured for the path) never signs anybody in; it sends them back to the
 * public page with a notice.
 */
async function login(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return problem(405, 'method_not_allowed');
  let target = '/';
  try {
    await authenticate(request, env);
  } catch {
    target = '/?signin=unavailable';
  }
  return new Response(null, { status: 302, headers: { Location: target, ...SECURITY_HEADERS } });
}

// ---- who am I -------------------------------------------------------------------

async function whoami(ctx: Ctx): Promise<Response> {
  const p = member(ctx);
  const tenant = p === null ? null : await ctx.registry.getTenant(p.tenantId);
  return json(toPrincipalDto(ctx.principal, tenant));
}

// ---- WebSocket ------------------------------------------------------------------

async function openSocket(ctx: Ctx): Promise<Response> {
  const denial = need(ctx, 'data.read');
  if (denial !== null) return denial;
  const p = member(ctx)!;
  const role = workspaceRoleOf(p);
  if (role === null) return problem(403, 'forbidden', { reason: 'workspace_not_shared' });
  // Rebuild the headers so nothing the client sent can masquerade as identity or tenant.
  const headers = new Headers(ctx.request.headers);
  for (const h of [IDENTITY_EMAIL_HEADER, IDENTITY_ROLE_HEADER, IDENTITY_EXPIRES_HEADER, IDENTITY_USER_HEADER, TENANT_HEADER, 'x-tenant-id', 'x-workspace-id']) headers.delete(h);
  headers.set(TENANT_HEADER, p.tenantId);
  headers.set(IDENTITY_USER_HEADER, p.userId);
  headers.set(IDENTITY_EMAIL_HEADER, p.email);
  headers.set(IDENTITY_ROLE_HEADER, role);
  if (ctx.identity.expiresAt !== null) headers.set(IDENTITY_EXPIRES_HEADER, String(ctx.identity.expiresAt));
  return roomFor(ctx, p).fetch(new Request(ctx.request, { headers }));
}

// ---- the caller's own tenant ------------------------------------------------------

async function tenantRoutes(ctx: Ctx): Promise<Response | null> {
  const { path, method, url } = ctx;
  const isRead = method === 'GET';
  const p = member(ctx);

  // Tenant-scoped routes exist for members only.
  const tenantPath = path === '/api/tenant' || path.startsWith('/api/tenant/') || path === '/api/export' || path === '/api/stats' || path === '/api/revisions' || path.startsWith('/api/revisions/');
  if (!tenantPath) return null;
  if (p === null) return problem(403, 'forbidden', { reason: 'role' }); // a Super Admin has no tenant

  if (path === '/api/tenant' && isRead) {
    const denial = need(ctx, 'tenant.view');
    if (denial !== null) return denial;
    return json({ tenant: await ctx.registry.getTenant(p.tenantId) });
  }

  // ---- shared workspace data (web mode) ----
  if (path === '/api/export' && isRead) {
    const denial = need(ctx, 'data.read');
    if (denial !== null) return denial;
    const snap = await roomFor(ctx, p).exportAll(p.tenantId);
    return json({ ...snap, hash: await canonicalRecordsHash(snap.records) });
  }

  if (path === '/api/stats' && isRead) {
    const denial = need(ctx, 'data.restore');
    if (denial !== null) return denial;
    return json(await roomFor(ctx, p).stats(p.tenantId));
  }

  if (path === '/api/revisions' && isRead) {
    const denial = need(ctx, 'data.read');
    if (denial !== null) return denial;
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 100) || 100));
    const beforeRaw = url.searchParams.get('before');
    const before = beforeRaw === null ? undefined : (revisionParam(beforeRaw) ?? undefined);
    return json(await roomFor(ctx, p).listRevisions(p.tenantId, limit, before));
  }

  const rev = /^\/api\/revisions\/([^/]+)(\/restore)?$/.exec(path);
  if (rev !== null) {
    const revision = revisionParam(rev[1]);
    if (revision === null) return problem(400, 'Invalid revision');
    if (rev[2] === undefined && isRead) {
      const denial = need(ctx, 'data.read');
      if (denial !== null) return denial;
      const records = await roomFor(ctx, p).previewRevision(p.tenantId, revision);
      return records === null ? problem(404, 'Revision not available') : json({ revision, records });
    }
    if (rev[2] === '/restore' && method === 'POST') {
      const denial = need(ctx, 'data.restore');
      if (denial !== null) return denial;
      const body = await readJson(ctx); // not used, but a forged tenant in it is rejected like everywhere else
      if (!body.ok) return body.response;
      const result = await roomFor(ctx, p).restoreRevision(p.tenantId, revision, p.email);
      return result.ok ? json(result) : problem(409, result.error);
    }
  }

  // ---- users (Admin of a web workspace) ----
  if (path === '/api/tenant/users' && isRead) {
    const denial = need(ctx, 'users.manage');
    if (denial !== null) return denial;
    return json({ users: await ctx.registry.listUsers(p.tenantId) });
  }

  if (path === '/api/tenant/users' && method === 'POST') {
    const denial = need(ctx, 'users.manage');
    if (denial !== null) return denial;
    const body = await readJson(ctx);
    if (!body.ok) return body.response;
    const access = (body.body.access ?? 'editor') as UserAccess;
    const result = await ctx.registry.createUser({
      tenantId: p.tenantId, // from the principal, never from the body
      email: String(body.body.email ?? ''),
      displayName: body.body.displayName,
      access,
      reserved: ctx.superAdmins,
      actor: actorOf(p), // from the principal, never from the body
    });
    return result.ok ? json({ user: result.value }, 201) : registryProblem(result.error);
  }

  const userRoute = /^\/api\/tenant\/users\/([^/]+)$/.exec(path);
  if (userRoute !== null && method === 'PATCH') {
    const denial = need(ctx, 'users.manage');
    if (denial !== null) return denial;
    if (!isUserId(userRoute[1])) return problem(400, 'invalid_user_id');
    const body = await readJson(ctx);
    if (!body.ok) return body.response;
    const result = await ctx.registry.updateUser({
      tenantId: p.tenantId,
      userId: userRoute[1],
      status: body.body.status as 'enabled' | 'disabled' | undefined,
      access: body.body.access as UserAccess | undefined,
      actor: actorOf(p),
    });
    if (!result.ok) return registryProblem(result.error);
    // A disabled user, or one whose access level changed, must not keep a live connection.
    let disconnected = true;
    if (body.body.status === 'disabled' || body.body.access !== undefined) {
      try {
        await roomFor(ctx, p).disconnectUser(p.tenantId, userRoute[1], CLOSE_CODES.accessRevoked, 'access changed');
      } catch {
        disconnected = false; // reported to the caller; the session-expiry check still bounds the connection
      }
    }
    return json({ user: result.value, disconnected });
  }

  // ---- deletion request (Admin) ----
  if (path === '/api/tenant/deletion-request' && method === 'POST') {
    const denial = need(ctx, 'tenant.requestDeletion');
    if (denial !== null) return denial;
    const body = await readJson(ctx);
    if (!body.ok) return body.response;
    // Asking for permanent deletion is deliberate: the typed word is checked HERE, not only in the browser.
    if (body.body.confirm !== REQUEST_DELETION_CONFIRMATION) return problem(400, 'confirmation_required');
    const result = await ctx.registry.requestDeletion(p.tenantId, p.userId);
    return result.ok ? json({ tenant: result.value }) : registryProblem(result.error);
  }
  if (path === '/api/tenant/deletion-request/cancel' && method === 'POST') {
    const denial = need(ctx, 'tenant.requestDeletion');
    if (denial !== null) return denial;
    const body = await readJson(ctx);
    if (!body.ok) return body.response;
    const result = await ctx.registry.cancelDeletion(p.tenantId, p.userId);
    return result.ok ? json({ tenant: result.value }) : registryProblem(result.error);
  }

  // ---- Testers of this workspace: the roster everyone may see; assignment is the Admin's ----
  if (path === '/api/tenant/team' && isRead) {
    const denial = need(ctx, 'team.view');
    if (denial !== null) return denial;
    return json({ testers: await ctx.registry.listTesters(p.tenantId) });
  }

  if (path === '/api/tenant/assignments' && method === 'POST') {
    const denial = need(ctx, 'assignments.manage');
    if (denial !== null) return denial;
    const body = await readJson(ctx);
    if (!body.ok) return body.response;
    const projectId = body.body.projectId;
    const userId = body.body.userId;
    if (typeof projectId !== 'string' || projectId.length === 0 || projectId.length > 100) return problem(400, 'invalid_project_id');
    if (!isUserId(userId)) return problem(400, 'invalid_user_id');
    // The account must be a Tester of THIS workspace (the tenant is the principal's, never the request's) and must be enabled.
    const tester = await ctx.registry.getTester(p.tenantId, userId);
    if (tester === null) return problem(404, 'tester_not_found');
    if (tester.status === 'disabled') return problem(409, 'tester_disabled');
    const result = await roomFor(ctx, p).assignTester(p.tenantId, {
      projectId,
      userId,
      testerName: tester.displayName ?? tester.email,
      actor: p.email,
      today: new Date().toISOString().slice(0, 10),
    });
    if (!result.ok) return problem(result.error === 'project_not_found' ? 404 : 409, result.error);
    return json(result, result.created ? 201 : 200);
  }

  // ---- this workspace's administrative history (Admin only; never another tenant's) ----
  if (path === '/api/tenant/audit' && isRead) {
    const denial = need(ctx, 'audit.tenant');
    if (denial !== null) return denial;
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 100) || 100));
    const beforeRaw = url.searchParams.get('before');
    const before = beforeRaw === null ? undefined : (revisionParam(beforeRaw) ?? undefined);
    return json({ audit: await ctx.registry.listAdminAudit({ kind: 'tenant', tenantId: p.tenantId }, limit, before) });
  }

  // ---- storage mode and migration (Admin) ----
  if (path.startsWith('/api/tenant/storage/')) return storageRoutes(ctx, p);

  return null;
}

async function storageRoutes(ctx: Ctx, p: MemberPrincipal): Promise<Response> {
  const denial = need(ctx, 'storage.migrate');
  if (denial !== null) return denial;
  const room = roomFor(ctx, p);
  const { path, method } = ctx;

  // What the server holds for this tenant right now (works in either mode).
  if (path === '/api/tenant/storage/inspect' && method === 'GET') {
    return json({ tenant: await ctx.registry.getTenant(p.tenantId), server: await room.verifyState(p.tenantId) });
  }

  // Atomic upload of a whole workspace as ONE revision. Never overwrites silently.
  if (path === '/api/tenant/storage/upload' && method === 'POST') {
    const body = await readJson(ctx);
    if (!body.ok) return body.response;
    const b = body.body;
    const migrationId = typeof b.migrationId === 'string' && b.migrationId.length > 0 && b.migrationId.length <= 100 ? b.migrationId : null;
    if (migrationId === null) return problem(400, 'invalid_migration_id');
    if (typeof b.expectedRevision !== 'number' || !Number.isSafeInteger(b.expectedRevision) || b.expectedRevision < 0) return problem(400, 'invalid_expected_revision');
    const replace = b.replace === true;
    // Replacing existing cloud data is destructive: it needs the typed confirmation, checked HERE.
    if (replace && b.confirm !== REPLACE_CONFIRMATION) return problem(400, 'confirmation_required');
    const result = await room.importWorkspace(p.tenantId, { migrationId, records: b.records, expectedRevision: b.expectedRevision, replace, actor: p.email });
    if (result.ok) {
      if (!result.alreadyApplied) {
        const records = Object.values(result.counts).reduce((a, n) => a + n, 0);
        await ctx.registry.appendAudit({ action: 'storage.migration_uploaded', actor: actorOf(p), tenantId: p.tenantId, meta: { revision: result.revision, records, replaced: replace } });
      }
      return json(result);
    }
    const status = result.error === 'invalid' ? 400 : result.error === 'failed' ? 500 : 409;
    return problem(status, result.error, { message: result.message, revision: result.revision });
  }

  // Switch authority to the cloud — only after the server re-verifies the uploaded content itself.
  if (path === '/api/tenant/storage/activate-web' && method === 'POST') {
    const body = await readJson(ctx);
    if (!body.ok) return body.response;
    const { revision, hash } = body.body;
    if (typeof revision !== 'number' || typeof hash !== 'string') return problem(400, 'invalid_verification');
    const state = await room.verifyState(p.tenantId);
    if (state.revision !== revision || state.hash !== hash) return problem(409, 'verification_failed', { revision: state.revision });
    await room.thaw(p.tenantId);
    const result = await ctx.registry.setStorageMode(p.tenantId, 'web', actorOf(p));
    return result.ok ? json({ tenant: result.value }) : registryProblem(result.error);
  }

  // Switch back to local — only if the cloud copy is exactly what the caller downloaded; the copy is KEPT.
  if (path === '/api/tenant/storage/deactivate-web' && method === 'POST') {
    const body = await readJson(ctx);
    if (!body.ok) return body.response;
    const { revision, hash } = body.body;
    if (typeof revision !== 'number' || typeof hash !== 'string') return problem(400, 'invalid_verification');
    // Leaving the cloud locks every collaborator out: it needs the typed confirmation, checked HERE too.
    if (body.body.confirm !== SWITCH_TO_LOCAL_CONFIRMATION) return problem(400, 'confirmation_required');
    if (p.storageMode !== 'web') return problem(409, 'wrong_mode');
    const frozen = await room.freezeIfUnchanged(p.tenantId, { revision, hash });
    if (!frozen.ok) return problem(409, frozen.error);
    const result = await ctx.registry.setStorageMode(p.tenantId, 'local', actorOf(p));
    if (!result.ok) {
      await room.thaw(p.tenantId); // roll back: the workspace stays live
      return registryProblem(result.error);
    }
    return json({ tenant: result.value, cloudCopy: 'archived' });
  }

  return problem(404, 'Not found');
}

// ---- Super Admin (metadata and explicit privileged actions only) ------------------

async function superRoutes(ctx: Ctx): Promise<Response | null> {
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
    const tenantId = one[1];
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

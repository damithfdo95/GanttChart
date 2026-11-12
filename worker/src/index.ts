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
 * Cloudflare Access token ITSELF - the Worker never assumes Access was in front.
 *
 * Route handlers live in routes/ (tenant-scoped and Super Admin); the shared
 * HTTP plumbing (responses, body reading, permission checks) is in http.ts.
 */

import { normalizeEmail } from '../../shared/tenancy';
import { AuthError, DEV_IDENTITY_COOKIE, authenticate } from './auth';
import { isWorkerPath } from '../../shared/routes';
import { toPrincipalDto, workspaceRoleOf } from './permissions';
import { parseEmailList, resolvePrincipal } from './principal';
import { authRoutes, changePasswordRoute } from './routes/auth';
import {
  IDENTITY_EMAIL_HEADER,
  IDENTITY_EXPIRES_HEADER,
  IDENTITY_ROLE_HEADER,
  IDENTITY_USER_HEADER,
  SESSION_HEADER,
  TENANT_HEADER,
  WorkspaceRoom,
} from './workspaceRoom';
import { RegistryRoom } from './registryRoom';
import { emailDomain, type DenyReason } from '../../shared/tenancy';
import { forgedTenant, json, member, need, originAllowed, problem, roomFor, SECURITY_HEADERS, type Ctx } from './http';
import { logEvent, newRequestId, safeError, withRequestId } from './log';
import { tenantRoutes } from './routes/tenant';
import { superRoutes } from './routes/super';

export { WorkspaceRoom, RegistryRoom };

const REGISTRY_NAME = 'registry';

/** Header a cross-site page cannot send without a CORS preflight (which we never allow). */
const INTENT_HEADER = 'x-gc-intent';

// ---- entry ---------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = newRequestId();
    const path = new URL(request.url).pathname;
    let response: Response;
    try {
      response = await route(request, env);
    } catch (error) {
      if (error instanceof AuthError) {
        // 500 = the Worker itself is misconfigured; 401/403 = a caller that could not be authenticated (category only, never the token).
        logEvent(error.status === 500 ? 'error' : 'warn', error.status === 500 ? 'auth_misconfigured' : 'auth_failed', { requestId, status: error.status, path });
        response = problem(error.status, error.message);
      } else {
        // The browser gets a stable code and the request id; the technical detail stays in the server log (no stack trace leaves the Worker).
        logEvent('error', 'unhandled', { requestId, path, error: safeError(error) });
        response = problem(500, 'Internal error', { code: 'internal_error' });
      }
    }
    // Static assets are not API responses: only the Worker's own routes carry a request id.
    return isWorkerPath(path) ? withRequestId(response, requestId) : response;
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

  if (path === '/login' || path === '/signin') return login(request, env);

  // The registry stub, used by the auth routes and the pipeline below.
  const registry = env.REGISTRY.getByName(REGISTRY_NAME);

  // The sign-in / sign-out routes are the ONLY unauthenticated API routes.
  const auth = await authRoutes(request, env, registry);
  if (auth !== null) return auth;

  // 1. origin / CSRF
  if (path === '/ws') {
    if (request.headers.get('Upgrade') !== 'websocket') return problem(426, 'Expected WebSocket');
    if (!originAllowed(request, env, true)) return problem(403, 'Origin not allowed');
  } else if (method !== 'GET') {
    // Unsafe methods need a same-origin Origin AND the intent header (CSRF defence in depth).
    if (!originAllowed(request, env, true)) return problem(403, 'Origin not allowed');
    if (request.headers.get(INTENT_HEADER) === null) return problem(403, 'Missing intent header');
  }

  // 2. authenticate (the session cookie, checked against the registry's session list)
  const identity = await authenticate(request, env, (sid) => registry.sessionValid(sid));

  // Development only: switch which person this browser is (so every role can be tried locally).
  if (path === '/api/dev/as' && method === 'POST' && env.ENVIRONMENT === 'development') {
    const email = normalizeEmail(((await request.json().catch(() => ({}))) as { email?: unknown }).email);
    if (email === null) return problem(400, 'invalid_email');
    return json({ email }, 200, { 'Set-Cookie': `${DEV_IDENTITY_COOKIE}=${encodeURIComponent(email)}; Path=/; SameSite=Strict` });
  }

  // 3. resolve the principal through the registry (unknown identities fail closed)
  const superAdmins = parseEmailList(env.SUPER_ADMIN_EMAILS);
  const resolved = await resolvePrincipal(identity.email, superAdmins, (email) => registry.authenticate(email));
  if (!resolved.ok) return denied(resolved.reason, identity.email);

  const ctx: Ctx = { request, env, url, path, method, identity, principal: resolved.principal, superAdmins, registry };

  // 4. a browser may not name a tenant
  if (ctx.principal.kind === 'member' && forgedTenant(ctx, undefined)) return problem(403, 'tenant_mismatch');

  if (path === '/ws') return openSocket(ctx);
  if (path === '/api/whoami' && method === 'GET') return whoami(ctx);

  const changed = await changePasswordRoute(ctx);
  if (changed !== null) return changed;

  return (await tenantRoutes(ctx)) ?? (await superRoutes(ctx)) ?? problem(404, 'Not found');
}

function denied(reason: DenyReason, email: string): Response {
  // A person Cloudflare Access let in but the application does not know (or no longer allows). Logged without the
  // mailbox name: enough to see that someone is trying, not enough to build a list of people.
  logEvent('warn', 'access_denied', { reason, domain: emailDomain(email) });
  return problem(403, 'forbidden', { reason, email });
}

// ---- sign-in ----------------------------------------------------------------------

/**
 * `/login` and `/signin` are the two sign-in entries. `/login` is the Cloudflare
 * Access entry (when Access is configured for it, Access challenges the visitor
 * before the request ever arrives); `/signin` is the password form's own URL.
 * With a VALID identity — an Access JWT or a session cookie — the person goes
 * straight to "/". Without one the SPA shell is served: the login form lives
 * there, so this can never loop.
 */
async function login(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return problem(405, 'method_not_allowed');
  try {
    const registry = env.REGISTRY.getByName(REGISTRY_NAME);
    await authenticate(request, env, (sid) => registry.sessionValid(sid));
    return new Response(null, { status: 302, headers: { Location: '/', ...SECURITY_HEADERS } });
  } catch {
    /* not signed in: serve the SPA (its login form is exactly right) */
    return env.ASSETS.fetch(new Request(request.url, { ...request, redirect: 'manual', method: 'GET' }));
  }
}

// ---- who am I -------------------------------------------------------------------

async function whoami(ctx: Ctx): Promise<Response> {
  const p = member(ctx);
  const tenant = p === null ? null : await ctx.registry.getTenant(p.tenantId);
  // A member whose password was set by an SV must change it before using the app.
  const mustChangePassword = p === null ? false : await ctx.registry.mustChangePassword(p.userId);
  return json({ ...toPrincipalDto(ctx.principal, tenant), mustChangePassword });
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
  for (const h of [IDENTITY_EMAIL_HEADER, IDENTITY_ROLE_HEADER, IDENTITY_EXPIRES_HEADER, IDENTITY_USER_HEADER, TENANT_HEADER, SESSION_HEADER, 'x-tenant-id', 'x-workspace-id']) headers.delete(h);
  headers.set(TENANT_HEADER, p.tenantId);
  headers.set(IDENTITY_USER_HEADER, p.userId);
  headers.set(IDENTITY_EMAIL_HEADER, p.email);
  headers.set(IDENTITY_ROLE_HEADER, role);
  if (ctx.identity.expiresAt !== null) headers.set(IDENTITY_EXPIRES_HEADER, String(ctx.identity.expiresAt));
  if (ctx.identity.sessionId !== null) headers.set(SESSION_HEADER, ctx.identity.sessionId);
  return roomFor(ctx, p).fetch(new Request(ctx.request, { headers }));
}

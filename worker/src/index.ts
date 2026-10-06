/**
 * Worker entry: authenticates every API/WebSocket request, then routes to the
 * single shared-workspace Durable Object. Static assets (the built SPA) are
 * served by the platform; `run_worker_first` sends only /api/* and /ws here.
 *
 * Routes
 *   GET  /ws                          WebSocket (live sync)
 *   GET  /api/whoami                  verified identity
 *   GET  /api/export                  whole workspace as records (any user)
 *   GET  /api/revisions               revision list            (any user)
 *   GET  /api/revisions/:rev          state at a revision      (any user)
 *   POST /api/revisions/:rev/restore  restore as a new revision (admin)
 *   GET  /api/stats                   revision/size/connections (admin)
 */

import { AuthError, authenticate } from './auth';
import { IDENTITY_EMAIL_HEADER, IDENTITY_EXPIRES_HEADER, IDENTITY_ROLE_HEADER, WorkspaceRoom } from './workspaceRoom';

export { WorkspaceRoom };

/** One workspace for now; a future per-team deployment would derive this from the path or identity. */
const WORKSPACE_NAME = 'workspace';

/** Header a cross-site page cannot send without a CORS preflight (which we never allow). */
const INTENT_HEADER = 'x-gc-intent';

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
} as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS },
  });
}

function problem(status: number, message: string): Response {
  return json({ error: message }, status);
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

  if (path === '/ws') {
    if (request.headers.get('Upgrade') !== 'websocket') return problem(426, 'Expected WebSocket');
    if (!originAllowed(request, env, true)) return problem(403, 'Origin not allowed');
    const identity = await authenticate(request, env);
    // Rebuild the headers so nothing the client sent can masquerade as identity.
    const headers = new Headers(request.headers);
    headers.delete(IDENTITY_EMAIL_HEADER);
    headers.delete(IDENTITY_ROLE_HEADER);
    headers.delete(IDENTITY_EXPIRES_HEADER);
    headers.set(IDENTITY_EMAIL_HEADER, identity.email);
    headers.set(IDENTITY_ROLE_HEADER, identity.role);
    if (identity.expiresAt !== null) headers.set(IDENTITY_EXPIRES_HEADER, String(identity.expiresAt));
    return env.WORKSPACE.getByName(WORKSPACE_NAME).fetch(new Request(request, { headers }));
  }

  if (!path.startsWith('/api/')) {
    // Everything else is the SPA (normally served by the platform before reaching here).
    return env.ASSETS.fetch(request);
  }

  const identity = await authenticate(request, env);
  const room = env.WORKSPACE.getByName(WORKSPACE_NAME);
  const isRead = request.method === 'GET';

  // Unsafe methods need a same-origin Origin AND the intent header (CSRF defence in depth).
  if (!isRead) {
    if (!originAllowed(request, env, true)) return problem(403, 'Origin not allowed');
    if (request.headers.get(INTENT_HEADER) === null) return problem(403, 'Missing intent header');
  }

  if (path === '/api/whoami' && isRead) return json({ email: identity.email, role: identity.role });

  if (path === '/api/export' && isRead) return json(await room.exportAll());

  if (path === '/api/stats' && isRead) {
    if (identity.role !== 'admin') return problem(403, 'Admin only');
    return json(await room.stats());
  }

  if (path === '/api/revisions' && isRead) {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 100) || 100));
    const beforeRaw = url.searchParams.get('before');
    const before = beforeRaw === null ? undefined : revisionParam(beforeRaw) ?? undefined;
    return json(await room.listRevisions(limit, before));
  }

  const match = /^\/api\/revisions\/([^/]+)(\/restore)?$/.exec(path);
  if (match !== null) {
    const revision = revisionParam(match[1]);
    if (revision === null) return problem(400, 'Invalid revision');
    if (match[2] === undefined && isRead) {
      const records = await room.previewRevision(revision);
      return records === null ? problem(404, 'Revision not available') : json({ revision, records });
    }
    if (match[2] === '/restore' && request.method === 'POST') {
      if (identity.role !== 'admin') return problem(403, 'Admin only');
      const result = await room.restoreRevision(revision, identity.email);
      return result.ok ? json(result) : problem(409, result.error);
    }
  }

  return problem(404, 'Not found');
}

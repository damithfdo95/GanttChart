/**
 * Which URLs are the application's and which are plain public files.
 *
 * The built SPA (HTML, JS, CSS, images) is PUBLIC: it contains code and static
 * text only, never data, so an anonymous visitor may load it and see the sign-in
 * page. Everything below is handled by the Worker. Data routes require a
 * verified identity (the Worker's own session cookie, or a Cloudflare Access
 * JWT, checked by the Worker itself); `/signin` is the explicit password-auth
 * entry:
 *
 *   /login   the Cloudflare Access entry (Access challenges the visitor; the
 *            Worker exchanges the JWT for its own session cookie)
 *   /signin  the password sign-in page and its same-origin POST endpoint
 *   /api/*   every authenticated API (plus the unauthenticated logout endpoint)
 *   /ws      the live-sync WebSocket
 *
 * This list is the single source of truth for: the Worker's routing
 * (`isWorkerPath`) and `assets.run_worker_first` in wrangler.jsonc (checked by
 * the pre-deployment guard).
 */

export const ACCESS_LOGIN_PATH = '/login';
export const PASSWORD_LOGIN_PATH = '/signin';

export const WORKER_ROUTES = ['/api/*', '/ws', ACCESS_LOGIN_PATH, PASSWORD_LOGIN_PATH] as const;

/**
 * The paths on the app hostname that Cloudflare Access protects. Access sits
 * ONLY in front of `/login`: the Worker verifies the Access JWT itself and
 * exchanges it for its own session cookie, so `/api/*` and `/ws` are guarded
 * by the Worker (session cookie or Access JWT) and must NOT be behind Access —
 * a password-session browser has no Access cookie and would be redirected
 * away from the API before the Worker ever sees it.
 */
export const ACCESS_PROTECTED_PATHS = [ACCESS_LOGIN_PATH] as const;

export function isWorkerPath(path: string): boolean {
  return path === '/ws' || path === '/login' || path === '/signin' || path.startsWith('/api/');
}

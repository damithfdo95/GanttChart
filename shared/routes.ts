/**
 * Which URLs are the application's and which are plain public files.
 *
 * The built SPA (HTML, JS, CSS, images) is PUBLIC: it contains code and static
 * text only, never data, so an anonymous visitor may load it and see the sign-in
 * page. Everything below is handled by the Worker. Data routes require a
 * verified identity (a Cloudflare Access JWT or the Worker's own session,
 * checked by the Worker itself); `/signin` is the explicit password-auth entry:
 *
 *   /login   the Cloudflare Access entry (a valid identity redirects to "/")
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

/** The paths on the app hostname that require an identity. */
export const ACCESS_PROTECTED_PATHS = [ACCESS_LOGIN_PATH, '/api', '/ws'] as const;

export function isWorkerPath(path: string): boolean {
  return path === '/ws' || path === '/login' || path === '/signin' || path.startsWith('/api/');
}

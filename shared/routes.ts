/**
 * Which URLs are the application's and which are plain public files.
 *
 * The built SPA (HTML, JS, CSS, images) is PUBLIC: it contains code and static
 * text only, never data, so an anonymous visitor may load it and see the sign-in
 * page. Everything below is handled by the Worker, requires a verified
 * identity (a Cloudflare Access JWT or the Worker's own session, checked by the
 * Worker itself), and is where all data lives:
 *
 *   /login   the Cloudflare Access entry (a valid identity redirects to "/")
 *   /signin  the password sign-in page (the SPA's login form)
 *   /api/*   every API (including /api/auth/login and /api/auth/logout)
 *   /ws      the live-sync WebSocket
 *
 * This list is the single source of truth for: the Worker's routing
 * (`isWorkerPath`) and `assets.run_worker_first` in wrangler.jsonc (checked by
 * the pre-deployment guard).
 */

export const WORKER_ROUTES = ['/api/*', '/ws', '/login', '/signin'] as const;

/** The paths on the app hostname that require an identity. */
export const ACCESS_PROTECTED_PATHS = ['/login', '/api', '/ws'] as const;

export function isWorkerPath(path: string): boolean {
  return path === '/ws' || path === '/login' || path === '/signin' || path.startsWith('/api/');
}

/**
 * Which URLs are the application's and which are plain public files.
 *
 * The built SPA (HTML, JS, CSS, images) is PUBLIC: it contains code and static
 * text only, never data, so an anonymous visitor may load it and see the sign-in
 * page. Everything below is handled by the Worker, requires a verified
 * Cloudflare Access identity (checked by the Worker itself, whatever Access
 * does at the edge), and is where all data lives:
 *
 *   /login   starts sign-in: Access challenges it, then the Worker sends the person back to "/"
 *   /api/*   every API
 *   /ws      the live-sync WebSocket
 *
 * This list is the single source of truth for: the Worker's routing
 * (`isWorkerPath`), `assets.run_worker_first` in wrangler.jsonc (checked by the
 * pre-deployment guard) and the Cloudflare Access destinations documented in
 * docs/DEPLOYMENT_PLAN.md (the same three paths).
 */

export const WORKER_ROUTES = ['/api/*', '/ws', '/login'] as const;

/** The Access destinations (paths on the app hostname) that must be protected. */
export const ACCESS_PROTECTED_PATHS = ['/login', '/api', '/ws'] as const;

export function isWorkerPath(path: string): boolean {
  return path === '/ws' || path === '/login' || path.startsWith('/api/');
}

import type { AuthEnv } from './auth';
import type { WorkspaceRoom } from './workspaceRoom';

/**
 * Worker environment. NOTE: once Node >= 22 is available, replace this with
 * the generated types (`npm run types` → worker-configuration.d.ts) so the
 * bindings can never drift from wrangler.jsonc.
 */
export interface Env extends AuthEnv {
  /** The shared workspace (one Durable Object, addressed by name). */
  WORKSPACE: DurableObjectNamespace<WorkspaceRoom>;
  /** The built single-page app (../dist). */
  ASSETS: Fetcher;
  /** Extra allowed WebSocket/API origins, comma-separated (local dev only). */
  ALLOWED_ORIGINS?: string;
  /** History retention in days (>= 7). Default 90. */
  HISTORY_RETENTION_DAYS?: string;
}

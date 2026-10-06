/**
 * Self-service sign-out, as plain orchestration over injected dependencies so every
 * path is unit-tested.
 *
 * Authentication belongs to Cloudflare Access, so signing out means: stop this page's
 * own use of the session, then visit Access's logout endpoint on THIS origin. Nothing
 * here talks to the application's API, and nothing here names a person or a workspace:
 * it signs out the browser that clicked, never anybody else.
 *
 * What it never does: delete or change any server data, change any account/tenant,
 * or touch this device's own data (local database, backups, device link and copy,
 * preferences). That is "Clear this device", a different, deliberate action.
 */

/** Cloudflare-managed endpoint on the application's own domain (not a Worker route). It takes no parameters. */
export const ACCESS_LOGOUT_PATH = '/cdn-cgi/access/logout';

export interface LogoutDeps {
  /** Edits not yet on the shared server (0 in local mode / when nothing is pending). */
  unsentChanges(): number;
  /** Write any pending edit to THIS device's own database (never throws away anything). */
  saveLocal(): Promise<void>;
  /** Close the live connection and stop every reconnect/heartbeat/flush timer. */
  stopSync(): void;
  /** Forget the signed-in person in memory and replace the app with the signed-out screen (nothing authenticated stays on screen). */
  endSession(): void;
  /** Leave the page for the given same-origin path. */
  navigate(path: string): void;
}

export type LogoutStart = { kind: 'done' } | { kind: 'confirm'; unsent: number };

/**
 * The user asked to sign out. With unsent shared changes nothing happens yet: the
 * caller must ask, and only `completeLogout` continues. Without them it signs out at once.
 */
export async function startLogout(deps: LogoutDeps): Promise<LogoutStart> {
  const unsent = deps.unsentChanges();
  if (unsent > 0) return { kind: 'confirm', unsent };
  await completeLogout(deps);
  return { kind: 'done' };
}

/** Sign out now (after a confirmation, or when nothing is unsent). */
export async function completeLogout(deps: LogoutDeps): Promise<void> {
  // 1. No more traffic and no more reconnect attempts, from this moment.
  deps.stopSync();
  // 2. Keep this device's own copy up to date: a failure here must not trap anyone in the app.
  try {
    await deps.saveLocal();
  } catch {
    /* the device copy is whatever was last saved */
  }
  // 3. Nothing authenticated may stay on screen, then leave.
  deps.endSession();
  deps.navigate(ACCESS_LOGOUT_PATH);
}

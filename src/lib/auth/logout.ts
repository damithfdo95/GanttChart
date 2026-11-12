/**
 * Self-service sign-out, as plain orchestration over injected dependencies so every
 * path is unit-tested.
 *
 * The sign-in session is the Worker's own (a session cookie), so signing out
 * means: tell the Worker to revoke the session (POST /api/auth/logout, which
 * also clears the cookie), stop this page's own use of the session, and show
 * the sign-in page. Nothing here names a person or a workspace: it signs out
 * the browser that clicked, never anybody else.
 *
 * What it never does: delete or change any server data, change any account/tenant,
 * or touch this device's own data (local database, backups, device link and copy,
 * preferences). That is "Clear this device", a different, deliberate action.
 */

/** The Worker's sign-out endpoint (revokes the session server-side and clears the cookie). */
export const LOGOUT_API_PATH = '/api/auth/logout';

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
  /** POST the sign-out (injectable for tests). */
  fetchFn?: (input: string, init?: RequestInit) => Promise<Response>;
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
  // 3. Revoke the session server-side (the cookie is cleared with the answer).
  //    A failure must not trap anyone in the app either: the local stop below still happens.
  try {
    await (deps.fetchFn ?? ((i: string, init?: RequestInit) => fetch(i, init)))(LOGOUT_API_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'x-gc-intent': 'logout' },
    });
  } catch {
    /* the session ends with the cookie when the browser closes; nothing else to do */
  }
  // 4. Nothing authenticated may stay on screen, then leave for the sign-in page.
  deps.endSession();
  deps.navigate('/signin');
}

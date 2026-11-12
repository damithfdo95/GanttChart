/**
 * Self-service sign-out, as plain orchestration over injected dependencies so every
 * path is unit-tested.
 *
 * The Worker tells the browser which verified authentication method is active.
 * Password sessions end at the Worker. Access sessions additionally visit
 * Cloudflare's same-origin logout endpoint after the local UI is gone.
 *
 * What it never does: delete or change any server data, change any account/tenant,
 * or touch this device's own data (local database, backups, device link and copy,
 * preferences). That is "Clear this device", a different, deliberate action.
 */

/** The Worker's sign-out endpoint (revokes the session server-side and clears the cookie). */
import type { AuthSource } from '../../../shared/tenancy';

export const LOGOUT_API_PATH = '/api/auth/logout';
export const ACCESS_LOGOUT_PATH = '/cdn-cgi/access/logout';

export interface LogoutDeps {
  /** Server-verified source returned by /api/whoami. */
  authSource: AuthSource;
  /** Current application origin, used only for a fixed same-origin return URL. */
  origin: string;
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

export function accessLogoutUrl(origin: string, incomplete: boolean): string {
  const parsed = new URL(origin);
  if (parsed.origin !== origin || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) throw new Error('Invalid application origin');
  const destination = new URL(incomplete ? '/signin?logout=incomplete' : '/signin', parsed.origin).href;
  return `${ACCESS_LOGOUT_PATH}?returnTo=${encodeURIComponent(destination)}`;
}

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
  let revokeFailed = false;
  try {
    const response = await (deps.fetchFn ?? ((i: string, init?: RequestInit) => fetch(i, init)))(LOGOUT_API_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'x-gc-intent': 'logout' },
    });
    revokeFailed = !response.ok;
  } catch {
    revokeFailed = true;
  }
  // 4. Nothing authenticated may stay on screen, then leave for the sign-in page.
  deps.endSession();
  if (deps.authSource === 'access') deps.navigate(accessLogoutUrl(deps.origin, revokeFailed));
  else deps.navigate(revokeFailed ? '/signin?logout=incomplete' : '/signin');
}

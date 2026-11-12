/**
 * Sign-in / sign-out / password routes: the Worker's own authentication
 * (replaces Cloudflare Access).
 *
 *   POST /api/auth/login           email + password -> session cookie
 *   POST /api/auth/logout          revoke the session, clear the cookie
 *   POST /api/auth/change-password change one's own password (old one required)
 *
 * Rules that hold everywhere else hold here too:
 *  - the same generic error for an unknown email and a wrong password (no account enumeration);
 *  - a locked account is reported, because the person must know to wait or ask an SV;
 *  - login is rate-limited per account inside the registry (failed-attempt counter + lockout);
 *  - the session cookie is HttpOnly + Secure + SameSite=Lax, so no script can read it
 *    and no other site can make the browser send it on a state-changing request.
 */

import { normalizeEmail } from '../../../shared/tenancy';
import { parseEmailList } from '../principal';
import { AuthError } from '../auth';
import { hashPassword, MIN_PASSWORD_LENGTH, randomToken, validatePasswordPolicy, verifyPassword } from '../passwords';
import { clearSessionCookie, readCookie, SESSION_COOKIE, SESSION_TTL_MS, sessionCookie, signSession, verifySession } from '../sessions';
import { json, originAllowed, problem, type Ctx } from '../http';
import { logEvent } from '../log';

/** The registry surface the auth routes need (satisfied by the real RegistryRoom stub). */
export interface AuthRegistry {
  checkPassword(email: string, password: string): Promise<
    | { ok: true; user: { id: string; email: string }; mustChange: boolean }
    | { ok: false; reason: 'invalid_credentials' | 'locked' | 'no_password' }
  >;
  createSession(input: { id: string; userId: string | null; email: string; ttlMs: number }): Promise<unknown>;
  revokeSession(id: string): Promise<void>;
  changeOwnPassword(input: { userId: string; currentPassword: string; newPasswordHash: string }): Promise<'ok' | 'wrong_password'>;
}

export interface AuthEnvLike {
  ENVIRONMENT?: string;
  SESSION_SECRET?: string;
  ALLOWED_ORIGINS?: string;
  /** Comma-separated Super Admin emails (the same list the pipeline uses). */
  SUPER_ADMIN_EMAILS?: string;
  /** The Super Admin's sign-in password, ALREADY HASHED (a `hashPassword` output stored as a Worker secret). */
  SUPER_ADMIN_PASSWORD?: string;
}

function secretOf(env: AuthEnvLike): string {
  const secret = env.SESSION_SECRET;
  if (secret === undefined || secret.length < 32) throw new AuthError(500, 'Sessions are not configured');
  return secret;
}

/**
 * The unauthenticated auth routes (login, logout). Returns null when the path
 * is not one of ours, so the caller continues with the normal pipeline.
 */
export async function authRoutes(request: Request, env: AuthEnvLike, registry: AuthRegistry): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const method = request.method;

  if (path === '/api/auth/login' && method === 'POST') {
    // Same-origin only: a cross-site form must not be able to log a person in.
    if (!originAllowed(request, env as never, true)) return problem(403, 'Origin not allowed');
    let body: { email?: unknown; password?: unknown };
    try {
      body = (await request.json()) as { email?: unknown; password?: unknown };
    } catch {
      return problem(400, 'invalid_json');
    }
    const email = typeof body.email === 'string' ? normalizeEmail(body.email) : null;
    const password = typeof body.password === 'string' ? body.password : '';
    if (email === null || password === '') return problem(400, 'invalid_credentials');

    // Super Admins are configuration, not registry users: their password comes
    // from configuration too (SUPER_ADMIN_PASSWORD, a stored hash), and their
    // session has no user id. The check runs through the same slow hash as
    // everyone else's, so timing does not reveal which kind of account it is.
    const superAdmins = parseEmailList(env.SUPER_ADMIN_EMAILS);
    if (superAdmins.includes(email)) {
      const configured = env.SUPER_ADMIN_PASSWORD;
      const good = configured !== undefined && configured.length > 0 && (await verifyPassword(password, configured));
      if (!good) {
        logEvent('warn', 'login_failed', { reason: 'invalid_credentials', domain: email.split('@')[1] ?? '' });
        return problem(401, 'invalid_credentials');
      }
      const secret = secretOf(env);
      const sid = randomToken();
      await registry.createSession({ id: sid, userId: null, email, ttlMs: SESSION_TTL_MS });
      const token = await signSession({ sub: null, email, sid, exp: Date.now() + SESSION_TTL_MS }, secret);
      logEvent('info', 'login_ok', { domain: email.split('@')[1] ?? '' });
      return json({ ok: true, mustChangePassword: false }, 200, { 'Set-Cookie': sessionCookie(token, SESSION_TTL_MS / 1000) });
    }

    const check = await registry.checkPassword(email, password);
    if (!check.ok) {
      // 'locked' is the only specific reason: the person must know to wait.
      logEvent('warn', 'login_failed', { reason: check.reason, domain: email.split('@')[1] ?? '' });
      return problem(check.reason === 'locked' ? 423 : 401, check.reason === 'locked' ? 'account_locked' : 'invalid_credentials');
    }

    const secret = secretOf(env);
    const sid = randomToken();
    await registry.createSession({ id: sid, userId: check.user.id, email, ttlMs: SESSION_TTL_MS });
    const token = await signSession({ sub: check.user.id, email, sid, exp: Date.now() + SESSION_TTL_MS }, secret);
    logEvent('info', 'login_ok', { domain: email.split('@')[1] ?? '' });
    return json({ ok: true, mustChangePassword: check.mustChange }, 200, { 'Set-Cookie': sessionCookie(token, SESSION_TTL_MS / 1000) });
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    if (!originAllowed(request, env as never, true)) return problem(403, 'Origin not allowed');
    // Revoke the session server-side (the cookie alone is worthless afterwards).
    const token = readCookie(request, SESSION_COOKIE);
    if (token !== null) {
      const claims = await verifySession(token, secretOf(env));
      if (claims !== null) await registry.revokeSession(claims.sid);
    }
    return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
  }

  return null;
}

/** The authenticated change-password route (needs the principal from the normal pipeline). */
export async function changePasswordRoute(ctx: Ctx): Promise<Response | null> {
  if (ctx.path !== '/api/auth/change-password' || ctx.method !== 'POST') return null;
  const p = ctx.principal;
  if (p.kind !== 'member') return problem(403, 'forbidden', { reason: 'role' });

  let body: { currentPassword?: unknown; newPassword?: unknown };
  try {
    body = (await ctx.request.json()) as { currentPassword?: unknown; newPassword?: unknown };
  } catch {
    return problem(400, 'invalid_json');
  }
  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
  if (currentPassword === '' || newPassword === '') return problem(400, 'invalid_input');
  if (validatePasswordPolicy(newPassword) !== 'ok') return problem(400, 'password_too_short', { minLength: MIN_PASSWORD_LENGTH });

  const newHash = await hashPassword(newPassword);
  const result = await ctx.registry.changeOwnPassword({ userId: p.userId, currentPassword, newPasswordHash: newHash });
  if (result !== 'ok') return problem(401, 'wrong_password');
  logEvent('info', 'password_changed', { userId: p.userId });
  return json({ ok: true });
}

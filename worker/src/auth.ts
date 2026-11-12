/**
 * Authentication — answers ONE question: who is calling?
 *
 * TWO sign-in methods are accepted, and either one alone is enough:
 *
 *   1. Cloudflare Access: Access authenticates the user at the edge and forwards
 *      a signed JWT in the `Cf-Access-Jwt-Assertion` header. The Worker MUST
 *      verify that token itself (signature, issuer, audience, expiry).
 *   2. The Worker's own session: an email + password sign-in issued a signed
 *      session token, stored in an HttpOnly cookie. This module verifies its
 *      signature and expiry, then the registry confirms the session id is still
 *      listed (so logout and account changes revoke at once).
 *
 * Both produce the same thing: a verified email. It deliberately does NOT
 * decide what the person may do — that is the registry's job (principal.ts).
 *
 * The code fails closed: missing configuration is a 500, never "allow".
 */

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { normalizeEmail, type AuthSource } from '../../shared/tenancy';
import { readCookie, SESSION_COOKIE, verifySession } from './sessions';

export interface AuthEnv {
  /** "development" enables local identities (loopback hosts only). Never set in production config. */
  ENVIRONMENT?: string;
  /** The HMAC key for session tokens (Worker secret, >= 32 chars). */
  SESSION_SECRET?: string;
  /** e.g. https://myteam.cloudflareaccess.com (no trailing slash). Optional: when unset, only password sign-in exists. */
  ACCESS_TEAM_DOMAIN?: string;
  /** The Access application's AUD tag (comma-separated list accepted; every entry matched exactly). */
  ACCESS_AUD?: string;
  /** Comma-separated emails of the platform's Super Admins (configuration, not data). */
  SUPER_ADMIN_EMAILS?: string;
  /** Default identity when ENVIRONMENT=development and none is chosen. */
  DEV_EMAIL?: string;
}

/** A verified email plus when its session ends (ms epoch; null for a local dev identity). */
export interface VerifiedIdentity {
  email: string;
  source: AuthSource;
  expiresAt: number | null;
  /** The session id (the registry's revocation handle; null for a local dev identity). */
  sessionId: string | null;
}

export class AuthError extends Error {
  constructor(
    readonly status: 401 | 403 | 500,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

const JWKS_BY_TEAM = new Map<string, JWTVerifyGetKey>();

/** Remote key sets cache and rotate keys internally; one per team domain is safe to share across requests. */
function remoteJwks(teamDomain: string): JWTVerifyGetKey {
  let jwks = JWKS_BY_TEAM.get(teamDomain);
  if (jwks === undefined) {
    jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    JWKS_BY_TEAM.set(teamDomain, jwks);
  }
  return jwks;
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** Name of the cookie the development identity switcher sets. */
export const DEV_IDENTITY_COOKIE = 'gc_dev_email';

function cookie(request: Request, name: string): string | null {
  return readCookie(request, name);
}

/** Confirms a session id is still valid in the registry (injected: the DO stub in production). */
export type SessionValidator = (sessionId: string) => Promise<boolean>;

/**
 * Resolve the verified identity of a request: EITHER a Cloudflare Access JWT
 * (header) OR the Worker's own session cookie. `sessionValid` (the registry's
 * session check) and `jwks` (the Access key set) are injectable for tests;
 * production passes the registry's validator and uses the team's remote key set.
 */
export async function authenticate(request: Request, env: AuthEnv, sessionValid?: SessionValidator, jwks?: JWTVerifyGetKey): Promise<VerifiedIdentity> {
  if (env.ENVIRONMENT === 'development') {
    // Local development only: exactly "development" AND a loopback host. The
    // identity is chosen by a header or cookie so every role can be exercised;
    // in any other configuration those inputs are never read.
    if (!isLocalHost(new URL(request.url).hostname)) {
      throw new AuthError(403, 'Development identity is only available on localhost');
    }
    const chosen = request.headers.get('x-dev-email') ?? cookie(request, DEV_IDENTITY_COOKIE) ?? env.DEV_EMAIL ?? 'super@dev.test';
    const email = normalizeEmail(chosen);
    if (email === null) throw new AuthError(403, 'Invalid development identity');
    return { email, source: 'development', expiresAt: null, sessionId: null };
  }

  // Method 1: Cloudflare Access. When the team domain is configured, a valid
  // Access JWT in its own header is accepted as-is (the registry still decides
  // whether the person may use the app, like always).
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.replace(/\/+$/, '');
  const audience = (env.ACCESS_AUD ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
  const accessConfigured = teamDomain !== undefined && teamDomain.startsWith('https://') && audience.length > 0;
  if (teamDomain !== undefined && teamDomain !== '' && !accessConfigured) {
    // Half-configured Access is a misconfiguration, not a silent fallback.
    throw new AuthError(500, 'Access is not configured');
  }
  const accessTokenHeader = request.headers.get('cf-access-jwt-assertion');
  if (accessConfigured && accessTokenHeader !== null && accessTokenHeader !== '') {
    let email: unknown;
    let exp: unknown;
    try {
      const { payload } = await jwtVerify(accessTokenHeader, jwks ?? remoteJwks(teamDomain!), {
        issuer: teamDomain!,
        audience: audience.length === 1 ? audience[0] : audience,
        algorithms: ['RS256'],
      });
      email = payload.email;
      exp = payload.exp;
    } catch {
      // Do not leak why (expired vs. bad signature vs. wrong audience).
      throw new AuthError(403, 'Invalid Access token');
    }
    const normalized = normalizeEmail(email);
    if (normalized === null) {
      // Service tokens carry no email; they are not supported for browser sessions.
      throw new AuthError(403, 'Access token has no user identity');
    }
    const expiresAt = typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
    return { email: normalized, source: 'access', expiresAt, sessionId: null };
  }

  // Method 2: the Worker's own session cookie.
  const secret = env.SESSION_SECRET;
  if (secret === undefined || secret.length < 32) {
    throw new AuthError(500, 'Sessions are not configured');
  }

  const token = cookie(request, SESSION_COOKIE);
  if (token === null || token === '') throw new AuthError(401, 'Missing session');

  const claims = await verifySession(token, secret);
  if (claims === null) throw new AuthError(403, 'Invalid session');

  // The registry's word is final: a logged-out, disabled or expired session is
  // refused even if the token's signature and expiry are still good.
  if (sessionValid !== undefined && !(await sessionValid(claims.sid))) throw new AuthError(403, 'Invalid session');

  const normalized = normalizeEmail(claims.email);
  if (normalized === null) {
    // A token without an identity is not a browser session.
    throw new AuthError(403, 'Session has no user identity');
  }
  // verifySession already rejected expired tokens; keep the expiry so a long-lived
  // WebSocket can be closed when the session ends.
  return { email: normalized, source: 'password', expiresAt: claims.exp, sessionId: claims.sid };
}

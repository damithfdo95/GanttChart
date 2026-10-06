/**
 * Cloudflare Access authentication — answers ONE question: who is calling?
 *
 * Access authenticates the user at the edge and forwards a signed JWT in the
 * `Cf-Access-Jwt-Assertion` header. The Worker MUST verify that token itself
 * (signature, issuer, audience, expiry): trusting the header or an email
 * header without verification would be bypassable by any request that reaches
 * the Worker another way.
 *
 * It deliberately does NOT decide what the person may do. A valid Access
 * identity is only an email; whether the application knows that email, and as
 * which role in which tenant, is decided by the registry (see principal.ts).
 *
 * The code fails closed: missing configuration is a 500, never "allow".
 */

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { normalizeEmail } from '../../shared/tenancy';

export interface AuthEnv {
  /** "development" enables local identities (loopback hosts only). Never set in production config. */
  ENVIRONMENT?: string;
  /** e.g. https://myteam.cloudflareaccess.com (no trailing slash) */
  ACCESS_TEAM_DOMAIN?: string;
  /**
   * The Access application's AUD tag. A comma-separated list is accepted for the rare case of more
   * than one Access application in front of this Worker; every entry must match a token's audience EXACTLY.
   */
  ACCESS_AUD?: string;
  /** Comma-separated emails of the platform's Super Admins (configuration, not data). */
  SUPER_ADMIN_EMAILS?: string;
  /** Default identity when ENVIRONMENT=development and none is chosen. */
  DEV_EMAIL?: string;
}

/** A verified email plus when its Access session ends (ms epoch; null for a local dev identity). */
export interface VerifiedIdentity {
  email: string;
  expiresAt: number | null;
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
  const raw = request.headers.get('cookie');
  if (raw === null) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/**
 * Resolve the verified identity of a request.
 * `jwks` is injectable for tests; production uses the team's remote key set.
 */
export async function authenticate(request: Request, env: AuthEnv, jwks?: JWTVerifyGetKey): Promise<VerifiedIdentity> {
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
    return { email, expiresAt: null };
  }

  const teamDomain = env.ACCESS_TEAM_DOMAIN?.replace(/\/+$/, '');
  const audience = (env.ACCESS_AUD ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
  if (!teamDomain || audience.length === 0 || !teamDomain.startsWith('https://')) {
    throw new AuthError(500, 'Access is not configured');
  }

  const token = request.headers.get('cf-access-jwt-assertion');
  if (token === null || token === '') throw new AuthError(401, 'Missing Access token');

  let email: unknown;
  let exp: unknown;
  try {
    const { payload } = await jwtVerify(token, jwks ?? remoteJwks(teamDomain), {
      issuer: teamDomain,
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
  // jwtVerify already rejected expired tokens; keep the expiry so a long-lived
  // WebSocket can be closed when the Access session ends.
  const expiresAt = typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
  return { email: normalized, expiresAt };
}

/**
 * Cloudflare Access authentication.
 *
 * Access authenticates the user at the edge and forwards a signed JWT in the
 * `Cf-Access-Jwt-Assertion` header. The Worker MUST verify that token itself
 * (signature, issuer, audience, expiry) — trusting the header or an email
 * header without verification would be bypassable by any request that
 * reaches the Worker another way (e.g. a leftover workers.dev URL).
 *
 * The code fails closed: missing configuration is a 500, never "allow".
 */

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Identity, Role } from '../../shared/protocol';

export interface AuthEnv {
  /** "development" enables the local dev identity (localhost only). Never set in production config. */
  ENVIRONMENT?: string;
  /** e.g. https://myteam.cloudflareaccess.com (no trailing slash) */
  ACCESS_TEAM_DOMAIN?: string;
  /** The Access application's AUD tag. */
  ACCESS_AUD?: string;
  /** Comma-separated emails with admin rights (restore, whole-workspace import). */
  ADMIN_EMAILS?: string;
  /** Comma-separated emails that may read but not write. Wins over ADMIN_EMAILS. */
  READ_ONLY_EMAILS?: string;
  /** Dev identity email when ENVIRONMENT=development. */
  DEV_EMAIL?: string;
}

/** A verified identity plus when its Access session ends (ms epoch; null for the local dev identity). */
export interface VerifiedIdentity extends Identity {
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

function emailList(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

export function roleFor(email: string, env: AuthEnv): Role {
  const e = email.toLowerCase();
  if (emailList(env.READ_ONLY_EMAILS).has(e)) return 'viewer'; // least privilege wins
  if (emailList(env.ADMIN_EMAILS).has(e)) return 'admin';
  return 'editor';
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/**
 * Resolve the verified identity of a request.
 * `jwks` is injectable for tests; production uses the team's remote key set.
 */
export async function authenticate(request: Request, env: AuthEnv, jwks?: JWTVerifyGetKey): Promise<VerifiedIdentity> {
  if (env.ENVIRONMENT === 'development') {
    // Local development only: exactly "development" AND a loopback host.
    if (!isLocalHost(new URL(request.url).hostname)) {
      throw new AuthError(403, 'Development identity is only available on localhost');
    }
    const email = (env.DEV_EMAIL ?? 'dev@localhost').toLowerCase();
    return { email, role: roleFor(email, env) === 'viewer' ? 'viewer' : 'admin', expiresAt: null };
  }

  const teamDomain = env.ACCESS_TEAM_DOMAIN?.replace(/\/+$/, '');
  const audience = env.ACCESS_AUD;
  if (!teamDomain || !audience || !teamDomain.startsWith('https://')) {
    throw new AuthError(500, 'Access is not configured');
  }

  const token = request.headers.get('cf-access-jwt-assertion');
  if (token === null || token === '') throw new AuthError(401, 'Missing Access token');

  let email: unknown;
  let exp: unknown;
  try {
    const { payload } = await jwtVerify(token, jwks ?? remoteJwks(teamDomain), {
      issuer: teamDomain,
      audience,
      algorithms: ['RS256'],
    });
    email = payload.email;
    exp = payload.exp;
  } catch {
    // Do not leak why (expired vs. bad signature vs. wrong audience).
    throw new AuthError(403, 'Invalid Access token');
  }
  if (typeof email !== 'string' || email.length === 0 || email.length > 320) {
    // Service tokens carry no email; they are not supported for browser sessions.
    throw new AuthError(403, 'Access token has no user identity');
  }
  const normalized = email.toLowerCase();
  // jwtVerify already rejected expired tokens; keep the expiry so a long-lived
  // WebSocket can be closed when the Access session ends.
  const expiresAt = typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
  return { email: normalized, role: roleFor(normalized, env), expiresAt };
}

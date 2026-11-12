/**
 * Session tokens: the Worker's own replacement for the Cloudflare Access JWT.
 *
 * A session token is a signed (HMAC-SHA256) string that carries exactly what
 * `authenticate()` needs: the email, the user id, and when the session ends.
 * It is stored in an HttpOnly cookie, so no script in the browser can read it.
 *
 * Format: base64url(payload).base64url(hmac)
 * Payload: { sub: userId, email, exp: ms-epoch, v: 1 }
 *
 * The signing key is the Worker secret SESSION_SECRET. Sessions are ALSO
 * recorded in the registry (id + expiry) so logout and account disable can
 * revoke them server-side; the token alone is never enough. Verification is
 * two-phase:
 *   1. signature + expiry (stateless, fast, no DO round-trip)
 *   2. session id still listed as valid in the registry (revocable)
 *
 * For step 2 the token carries the session id (sid) and the registry keeps
 * sessions in SQLite, so revocation is durable.
 */

import { SignJWT, jwtVerify } from 'jose';

const encoder = new TextEncoder();

export const SESSION_COOKIE = 'gc_session';
/** How long a sign-in lasts (7 days, per the product decision). */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionClaims {
  /** The registry user id (null for a Super Admin, who is configuration, not data). */
  sub: string | null;
  email: string;
  /** Session id: the registry's revocation handle. */
  sid: string;
  /** ms-epoch when the session ends. */
  exp: number;
}

function key(secret: string): Uint8Array {
  return encoder.encode(secret);
}

/** Create a signed session token. */
export async function signSession(claims: SessionClaims, secret: string): Promise<string> {
  return new SignJWT({ email: claims.email, sid: claims.sid, sub: claims.sub ?? '' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(claims.exp / 1000))
    .sign(key(secret));
}

/**
 * Verify a session token's signature and expiry. Returns the claims, or null
 * for anything wrong (the caller decides what that means; no reason is leaked
 * to the browser).
 */
export async function verifySession(token: string, secret: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ['HS256'] });
    const email = typeof payload.email === 'string' ? payload.email : null;
    const sid = typeof payload.sid === 'string' ? payload.sid : null;
    if (email === null || sid === null || sid === '') return null;
    const exp = typeof payload.exp === 'number' ? payload.exp * 1000 : null;
    if (exp === null || !Number.isFinite(exp)) return null;
    const sub = typeof payload.sub === 'string' && payload.sub !== '' ? payload.sub : null;
    return { sub, email, sid, exp };
  } catch {
    return null;
  }
}

/** The Set-Cookie value for a new session. HttpOnly + SameSite=Lax + Secure (the app is https-only). */
export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

/** The Set-Cookie value that deletes the session cookie. */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** Read a cookie value from a request (same parsing rules as the dev identity cookie). */
export function readCookie(request: Request, name: string): string | null {
  const raw = request.headers.get('cookie');
  if (raw === null) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

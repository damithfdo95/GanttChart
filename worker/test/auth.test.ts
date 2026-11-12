import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuthError, DEV_IDENTITY_COOKIE, authenticate, type AuthEnv } from '../src/auth';
import { SESSION_COOKIE, signSession, verifySession } from '../src/sessions';

const SECRET = 'test-session-secret-0123456789abcdef0123456789abcdef';
const TEAM = 'https://acme.cloudflareaccess.com';
const AUD = 'aud-tag-123';
const ENV: AuthEnv = { SESSION_SECRET: SECRET };
const DUAL_ENV: AuthEnv = { SESSION_SECRET: SECRET, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };

let privateKey: CryptoKey;
let otherPrivateKey: CryptoKey;
let jwks: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  privateKey = pair.privateKey as CryptoKey;
  otherPrivateKey = other.privateKey as CryptoKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  jwks = createLocalJWKSet({ keys: [jwk] });
});

async function accessToken(claims: Record<string, unknown>, opts: { key?: CryptoKey; iss?: string; aud?: string; exp?: string | number } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(opts.iss ?? TEAM)
    .setAudience(opts.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '10m')
    .sign(opts.key ?? privateKey);
}

const req = (cookie?: string, url = 'https://gantt.example.com/ws', extra: Record<string, string> = {}) =>
  new Request(url, { headers: { ...(cookie === undefined ? {} : { cookie }), ...extra } });

async function failure(promise: Promise<unknown>): Promise<AuthError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(AuthError);
    return e as AuthError;
  }
  throw new Error('expected authentication to fail');
}

async function session(email: string, opts: { secret?: string; exp?: number; sid?: string } = {}): Promise<string> {
  return signSession({ sub: 'user-1', email, sid: opts.sid ?? 'sid-1', exp: opts.exp ?? Date.now() + 60_000 }, opts.secret ?? SECRET);
}

describe('authenticate (session cookie) — answers "who", never "what may they do"', () => {
  it('accepts a valid session and returns the normalized email, the session end and the session id', async () => {
    const id = await authenticate(req(`${SESSION_COOKIE}=${await session('Alice@Example.com')}`), ENV, async () => true);
    expect(Object.keys(id).sort()).toEqual(['email', 'expiresAt', 'sessionId']);
    expect(id.email).toBe('alice@example.com');
    expect(id.expiresAt).toBeGreaterThan(Date.now());
    expect(id.sessionId).toBe('sid-1');
  });

  it('rejects requests without a cookie (401)', async () => {
    expect((await failure(authenticate(req(), ENV, async () => true))).status).toBe(401);
  });

  it.each([
    ['signed with another key', async () => session('a@b.co', { secret: 'another-session-secret-0123456789abcdef0123456789' })],
    ['expired', async () => session('a@b.co', { exp: Date.now() - 3600_000 })],
    ['garbage', async () => 'not-a-token'],
  ])('rejects a session that is %s (403)', async (_name, make) => {
    expect((await failure(authenticate(req(`${SESSION_COOKIE}=${await make()}`), ENV, async () => true))).status).toBe(403);
  });

  it('rejects a session the registry has revoked (logout, account disabled)', async () => {
    const token = await session('a@b.co');
    expect((await failure(authenticate(req(`${SESSION_COOKIE}=${token}`), ENV, async () => false))).status).toBe(403);
  });

  it('fails closed when sessions are not configured (missing or too-short secret)', async () => {
    const token = await session('a@b.co');
    expect((await failure(authenticate(req(`${SESSION_COOKIE}=${token}`), {}, async () => true))).status).toBe(500);
    expect((await failure(authenticate(req(`${SESSION_COOKIE}=${token}`), { SESSION_SECRET: 'short' }, async () => true))).status).toBe(500);
  });
});

describe('authenticate (Cloudflare Access JWT, the second sign-in method)', () => {
  const reqWithJwt = (jwt: string, url = 'https://gantt.example.com/ws') => new Request(url, { headers: { 'cf-access-jwt-assertion': jwt } });

  it('accepts a valid Access token and returns the normalized email with no session id', async () => {
    const id = await authenticate(reqWithJwt(await accessToken({ email: 'Alice@Example.com' })), DUAL_ENV, async () => true, jwks);
    expect(id.email).toBe('alice@example.com');
    expect(id.expiresAt).toBeGreaterThan(Date.now());
    expect(id.sessionId).toBeNull();
  });

  it.each([
    ['signed by another key', async () => accessToken({ email: 'a@b.co' }, { key: otherPrivateKey })],
    ['wrong audience', async () => accessToken({ email: 'a@b.co' }, { aud: 'someone-elses-app' })],
    ['wrong issuer', async () => accessToken({ email: 'a@b.co' }, { iss: 'https://evil.cloudflareaccess.com' })],
    ['expired', async () => accessToken({ email: 'a@b.co' }, { exp: Math.floor(Date.now() / 1000) - 3600 })],
  ])('rejects an Access token that is %s (403)', async (_name, make) => {
    expect((await failure(authenticate(reqWithJwt(await make()), DUAL_ENV, async () => true, jwks))).status).toBe(403);
  });

  it('rejects a token without a usable email (service tokens)', async () => {
    expect((await failure(authenticate(reqWithJwt(await accessToken({ common_name: 'svc' })), DUAL_ENV, async () => true, jwks))).status).toBe(403);
  });

  it('fails closed when Access is half-configured (a token arrives but no AUD)', async () => {
    const jwt = await accessToken({ email: 'a@b.co' });
    expect((await failure(authenticate(reqWithJwt(jwt), { SESSION_SECRET: SECRET, ACCESS_TEAM_DOMAIN: TEAM }, async () => true, jwks))).status).toBe(500);
  });

  it('ignores the Access header entirely when Access is not configured (password-only deployment)', async () => {
    const jwt = await accessToken({ email: 'a@b.co' });
    // No Access vars: the header is just another header; the request has no session either → 401.
    expect((await failure(authenticate(reqWithJwt(jwt), ENV, async () => true))).status).toBe(401);
  });

  it('a valid Access token works even without a session cookie (either method alone is enough)', async () => {
    const id = await authenticate(reqWithJwt(await accessToken({ email: 'sso.user@example.com' })), DUAL_ENV, async () => false, jwks);
    expect(id.email).toBe('sso.user@example.com');
  });
});

describe('session tokens (signing and verification)', () => {
  it('round-trips the claims and hides nothing else', async () => {
    const token = await signSession({ sub: 'u1', email: 'a@b.co', sid: 's1', exp: Date.now() + 1000 }, SECRET);
    const claims = await verifySession(token, SECRET);
    expect(claims).toMatchObject({ sub: 'u1', email: 'a@b.co', sid: 's1' });
    expect(claims?.exp).toBeGreaterThan(Date.now());
  });

  it('a Super Admin session (no user id) round-trips with sub null', async () => {
    const token = await signSession({ sub: null, email: 'super@x.yz', sid: 's2', exp: Date.now() + 1000 }, SECRET);
    expect(await verifySession(token, SECRET)).toMatchObject({ sub: null, email: 'super@x.yz', sid: 's2' });
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signSession({ sub: 'u1', email: 'a@b.co', sid: 's1', exp: Date.now() + 1000 }, SECRET);
    expect(await verifySession(token, 'another-session-secret-0123456789abcdef0123456789')).toBeNull();
  });
});

describe('development identities (local testing of every role)', () => {
  const dev: AuthEnv = { ENVIRONMENT: 'development', DEV_EMAIL: 'default@dev.test' };
  const local = 'http://localhost:8787/api/whoami';

  it('works only for ENVIRONMENT=development on a loopback host', async () => {
    expect(await authenticate(req(undefined, local), dev)).toEqual({ email: 'default@dev.test', expiresAt: null, sessionId: null });
    expect((await failure(authenticate(req(undefined, 'https://gantt.example.com/api/whoami'), dev))).status).toBe(403);
  });

  it('lets a header or a cookie choose WHICH person this is (header wins)', async () => {
    expect((await authenticate(req(undefined, local, { 'x-dev-email': 'Admin@Tenant.Test' }), dev)).email).toBe('admin@tenant.test');
    expect((await authenticate(req(undefined, local, { cookie: `${DEV_IDENTITY_COOKIE}=${encodeURIComponent('cookie@dev.test')}` }), dev)).email).toBe('cookie@dev.test');
    expect((await authenticate(req(undefined, local, { 'x-dev-email': 'h@dev.test', cookie: `${DEV_IDENTITY_COOKIE}=c@dev.test` }), dev)).email).toBe('h@dev.test');
  });

  it('rejects a malformed development identity', async () => {
    expect((await failure(authenticate(req(undefined, local, { 'x-dev-email': 'nonsense' }), dev))).status).toBe(403);
  });

  it('is not enabled by any value other than exactly "development"', async () => {
    for (const value of ['Development', 'dev', 'true', '1', 'production', '']) {
      const e = await failure(authenticate(req(undefined, local, { 'x-dev-email': 'a@b.co' }), { ...ENV, ENVIRONMENT: value }, async () => true));
      expect(e.status).toBe(401); // normal session path, no cookie → 401, never a bypass
    }
  });

  it('IN PRODUCTION the dev header and cookie are completely ignored: only the verified session decides who you are', async () => {
    const token = await session('alice@example.com');
    const spoof = { 'x-dev-email': 'super@example.com', cookie: `${DEV_IDENTITY_COOKIE}=super@example.com; ${SESSION_COOKIE}=${token}` };
    expect((await authenticate(req(undefined, 'https://gantt.example.com/api/whoami', spoof), ENV, async () => true)).email).toBe('alice@example.com');
    // …and without a session cookie the spoof buys nothing.
    const spoofNoSession = { 'x-dev-email': 'super@example.com', cookie: `${DEV_IDENTITY_COOKIE}=super@example.com` };
    expect((await failure(authenticate(req(undefined, 'https://gantt.example.com/api/whoami', spoofNoSession), ENV, async () => true))).status).toBe(401);
  });
});

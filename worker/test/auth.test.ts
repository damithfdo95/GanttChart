import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuthError, DEV_IDENTITY_COOKIE, authenticate, type AuthEnv } from '../src/auth';

const TEAM = 'https://acme.cloudflareaccess.com';
const AUD = 'aud-tag-123';
const ENV: AuthEnv = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };

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

async function token(claims: Record<string, unknown>, opts: { key?: CryptoKey; iss?: string; aud?: string; exp?: string | number } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(opts.iss ?? TEAM)
    .setAudience(opts.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '10m')
    .sign(opts.key ?? privateKey);
}

const req = (jwt?: string, url = 'https://gantt.example.com/ws', extra: Record<string, string> = {}) =>
  new Request(url, { headers: { ...(jwt === undefined ? {} : { 'Cf-Access-Jwt-Assertion': jwt }), ...extra } });

async function failure(promise: Promise<unknown>): Promise<AuthError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(AuthError);
    return e as AuthError;
  }
  throw new Error('expected authentication to fail');
}

describe('authenticate (Cloudflare Access JWT) — answers "who", never "what may they do"', () => {
  it('accepts a valid token and returns ONLY the normalized email and the session end', async () => {
    const id = await authenticate(req(await token({ email: 'Alice@Example.com' })), ENV, jwks);
    expect(Object.keys(id).sort()).toEqual(['email', 'expiresAt']);
    expect(id.email).toBe('alice@example.com');
    expect(id.expiresAt).toBeGreaterThan(Date.now());
  });

  it('rejects requests without a token (401)', async () => {
    expect((await failure(authenticate(req(), ENV, jwks))).status).toBe(401);
  });

  it.each([
    ['signed by another key', async () => token({ email: 'a@b.co' }, { key: otherPrivateKey })],
    ['wrong audience', async () => token({ email: 'a@b.co' }, { aud: 'someone-elses-app' })],
    ['wrong issuer', async () => token({ email: 'a@b.co' }, { iss: 'https://evil.cloudflareaccess.com' })],
    ['expired', async () => token({ email: 'a@b.co' }, { exp: Math.floor(Date.now() / 1000) - 3600 })],
  ])('rejects a token that is %s (403)', async (_name, make) => {
    expect((await failure(authenticate(req(await make()), ENV, jwks))).status).toBe(403);
  });

  it('rejects a tampered token and a garbage token', async () => {
    const good = await token({ email: 'a@b.co' });
    const [h, p, s] = good.split('.');
    const forgedPayload = btoa(JSON.stringify({ email: 'admin@x.yz', iss: TEAM, aud: AUD, exp: 9999999999 })).replace(/=+$/, '');
    expect((await failure(authenticate(req(`${h}.${forgedPayload}.${s}`), ENV, jwks))).status).toBe(403);
    expect((await failure(authenticate(req(p), ENV, jwks))).status).toBe(403);
  });

  it('rejects an HS256 token (algorithm confusion)', async () => {
    const forged = await new SignJWT({ email: 'a@b.co' })
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setIssuer(TEAM)
      .setAudience(AUD)
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode('secret'));
    expect((await failure(authenticate(req(forged), ENV, jwks))).status).toBe(403);
  });

  it('rejects tokens without a usable email (e.g. service tokens, malformed addresses)', async () => {
    expect((await failure(authenticate(req(await token({ common_name: 'svc' })), ENV, jwks))).status).toBe(403);
    expect((await failure(authenticate(req(await token({ email: 'not-an-email' })), ENV, jwks))).status).toBe(403);
  });

  it('fails closed when Access is not configured', async () => {
    const jwt = await token({ email: 'a@b.co' });
    expect((await failure(authenticate(req(jwt), {}, jwks))).status).toBe(500);
    expect((await failure(authenticate(req(jwt), { ACCESS_TEAM_DOMAIN: TEAM }, jwks))).status).toBe(500);
    expect((await failure(authenticate(req(jwt), { ACCESS_AUD: AUD }, jwks))).status).toBe(500);
    expect((await failure(authenticate(req(jwt), { ACCESS_TEAM_DOMAIN: 'http://insecure', ACCESS_AUD: AUD }, jwks))).status).toBe(500);
  });
});

describe('development identities (local testing of every role)', () => {
  const dev: AuthEnv = { ENVIRONMENT: 'development', DEV_EMAIL: 'default@dev.test' };
  const local = 'http://localhost:8787/api/whoami';

  it('works only for ENVIRONMENT=development on a loopback host', async () => {
    expect(await authenticate(req(undefined, local), dev)).toEqual({ email: 'default@dev.test', expiresAt: null });
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
      const e = await failure(authenticate(req(undefined, local, { 'x-dev-email': 'a@b.co' }), { ...ENV, ENVIRONMENT: value }, jwks));
      expect(e.status).toBe(401); // normal Access path, no token → 401, never a bypass
    }
  });

  it('IN PRODUCTION the dev header and cookie are completely ignored: only the verified token decides who you are', async () => {
    const jwt = await token({ email: 'alice@example.com' });
    const spoof = { 'x-dev-email': 'super@example.com', cookie: `${DEV_IDENTITY_COOKIE}=super@example.com` };
    expect((await authenticate(req(jwt, 'https://gantt.example.com/api/whoami', spoof), ENV, jwks)).email).toBe('alice@example.com');
    // …and without a token the spoof buys nothing.
    expect((await failure(authenticate(req(undefined, 'https://gantt.example.com/api/whoami', spoof), ENV, jwks))).status).toBe(401);
  });
});

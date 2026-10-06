import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuthError, authenticate, roleFor, type AuthEnv } from '../src/auth';

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

const req = (jwt?: string, url = 'https://gantt.example.com/ws') =>
  new Request(url, { headers: jwt === undefined ? {} : { 'Cf-Access-Jwt-Assertion': jwt } });

async function failure(promise: Promise<unknown>): Promise<AuthError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(AuthError);
    return e as AuthError;
  }
  throw new Error('expected authentication to fail');
}

describe('authenticate (Cloudflare Access JWT)', () => {
  it('accepts a valid token and normalizes the email', async () => {
    const id = await authenticate(req(await token({ email: 'Alice@Example.com' })), ENV, jwks);
    expect(id).toMatchObject({ email: 'alice@example.com', role: 'editor' });
    expect(id.expiresAt).toBeGreaterThan(Date.now()); // the session end, for closing long-lived sockets
  });

  it('rejects requests without a token (401)', async () => {
    expect((await failure(authenticate(req(), ENV, jwks))).status).toBe(401);
  });

  it.each([
    ['signed by another key', async () => token({ email: 'a@b.c' }, { key: otherPrivateKey })],
    ['wrong audience', async () => token({ email: 'a@b.c' }, { aud: 'someone-elses-app' })],
    ['wrong issuer', async () => token({ email: 'a@b.c' }, { iss: 'https://evil.cloudflareaccess.com' })],
    ['expired', async () => token({ email: 'a@b.c' }, { exp: Math.floor(Date.now() / 1000) - 3600 })],
  ])('rejects a token that is %s (403)', async (_name, make) => {
    expect((await failure(authenticate(req(await make()), ENV, jwks))).status).toBe(403);
  });

  it('rejects a tampered token and a garbage token', async () => {
    const good = await token({ email: 'a@b.c' });
    const [h, p, s] = good.split('.');
    const forgedPayload = btoa(JSON.stringify({ email: 'admin@x.y', iss: TEAM, aud: AUD, exp: 9999999999 })).replace(/=+$/, '');
    expect((await failure(authenticate(req(`${h}.${forgedPayload}.${s}`), ENV, jwks))).status).toBe(403);
    expect((await failure(authenticate(req(p), ENV, jwks))).status).toBe(403);
  });

  it('rejects an HS256 token signed with the public key as secret (algorithm confusion)', async () => {
    const forged = await new SignJWT({ email: 'a@b.c' })
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setIssuer(TEAM)
      .setAudience(AUD)
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode('secret'));
    expect((await failure(authenticate(req(forged), ENV, jwks))).status).toBe(403);
  });

  it('rejects tokens without an email (e.g. service tokens)', async () => {
    expect((await failure(authenticate(req(await token({ common_name: 'svc' })), ENV, jwks))).status).toBe(403);
  });

  it('fails closed when Access is not configured', async () => {
    const jwt = await token({ email: 'a@b.c' });
    expect((await failure(authenticate(req(jwt), {}, jwks))).status).toBe(500);
    expect((await failure(authenticate(req(jwt), { ACCESS_TEAM_DOMAIN: TEAM }, jwks))).status).toBe(500);
    expect((await failure(authenticate(req(jwt), { ACCESS_AUD: AUD }, jwks))).status).toBe(500);
    expect((await failure(authenticate(req(jwt), { ACCESS_TEAM_DOMAIN: 'http://insecure', ACCESS_AUD: AUD }, jwks))).status).toBe(500);
  });
});

describe('roles', () => {
  it('maps emails to roles; read-only wins over admin', async () => {
    const env = { ...ENV, ADMIN_EMAILS: 'Boss@Example.com, both@example.com', READ_ONLY_EMAILS: 'viewer@example.com,both@example.com' };
    expect(roleFor('boss@example.com', env)).toBe('admin');
    expect(roleFor('viewer@example.com', env)).toBe('viewer');
    expect(roleFor('both@example.com', env)).toBe('viewer');
    expect(roleFor('anyone@example.com', env)).toBe('editor');
    const id = await authenticate(req(await token({ email: 'BOSS@example.com' })), env, jwks);
    expect(id.role).toBe('admin');
  });
});

describe('development bypass', () => {
  it('works only for ENVIRONMENT=development on localhost', async () => {
    const dev: AuthEnv = { ENVIRONMENT: 'development' };
    expect(await authenticate(req(undefined, 'http://localhost:8787/ws'), dev)).toEqual({ email: 'dev@localhost', role: 'admin', expiresAt: null });
    expect((await failure(authenticate(req(undefined, 'https://gantt.example.com/ws'), dev))).status).toBe(403);
  });

  it('is not enabled by any other value', async () => {
    for (const value of ['Development', 'dev', 'true', '1', 'production', '']) {
      const e = await failure(authenticate(req(undefined, 'http://localhost:8787/ws'), { ...ENV, ENVIRONMENT: value }, jwks));
      expect(e.status).toBe(401); // normal Access path, no token → 401, never a bypass
    }
  });
});

import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The Worker configured like PRODUCTION (wrangler.prod-sim.jsonc): no development
 * identity, real Cloudflare Access JWT verification, and the public static shell.
 * Only the Access signing key is a test key, served to the Worker in place of the
 * real team's JWKS endpoint.
 *
 * What this simulates of the Cloudflare Access path policy: Access is NOT in front
 * of these requests at all. That is the strictest possible reading — an anonymous
 * request reaches the Worker directly, as it would if an Access destination were
 * missing or misconfigured — and the Worker must still refuse everything protected.
 */

const BASE = 'https://ganttchart.sim.workers.dev';
const TEAM = 'https://sim-team.cloudflareaccess.com';
const AUD = 'sim-aud-tag';
const SUPER = 'boss@rakuten.com';

let signingKey: CryptoKey;
let otherKey: CryptoKey;
let rs384Key: CryptoKey;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  const good = await generateKeyPair('RS256', { extractable: true });
  const bad = await generateKeyPair('RS256', { extractable: true });
  const other384 = await generateKeyPair('RS384', { extractable: true });
  signingKey = good.privateKey;
  otherKey = bad.privateKey;
  rs384Key = other384.privateKey;
  const jwk: JWK = { ...(await exportJWK(good.publicKey)), kid: 'sim-key', alg: 'RS256', use: 'sig' };
  // A key the team could plausibly publish too, but for an algorithm the Worker does not accept.
  const jwk384: JWK = { ...(await exportJWK(other384.publicKey)), kid: 'sim-key-384', alg: 'RS384', use: 'sig' };
  // The Worker verifies tokens against `${TEAM}/cdn-cgi/access/certs`; serve the test key there.
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === `${TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk, jwk384] });
    return realFetch(input, init);
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

interface TokenOptions {
  aud?: string;
  iss?: string;
  expiresIn?: number | string;
  key?: CryptoKey;
  email?: string | null;
}

async function token(email: string | null, o: TokenOptions = {}): Promise<string> {
  const claims: Record<string, unknown> = email === null ? { sub: 'service' } : { email, sub: 'u-1' };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'sim-key' })
    .setIssuer(o.iss ?? TEAM)
    .setAudience(o.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(o.expiresIn ?? '1h')
    .sign(o.key ?? signingKey);
}

interface Sent {
  status: number;
  text: string;
  json: Record<string, unknown>;
  headers: Headers;
}

async function send(method: string, path: string, opts: { jwt?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Sent> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.jwt !== undefined) headers['cf-access-jwt-assertion'] = opts.jwt;
  if (method !== 'GET') {
    headers.Origin = BASE;
    headers['x-gc-intent'] = 'test';
  }
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await exports.default.fetch(new Request(BASE + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), redirect: 'manual' }));
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  return { status: res.status, text, json, headers: res.headers };
}

async function registryCounts(): Promise<{ users: number; tenants: number }> {
  return runInDurableObject(env.REGISTRY.getByName('registry'), async (_i, state) => ({
    users: state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM users').one().n,
    tenants: state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM tenants').one().n,
  }));
}

describe('this really is the production configuration', () => {
  it('has no development identity switched on', () => {
    expect((env as unknown as Record<string, unknown>).ENVIRONMENT).toBeUndefined();
    expect((env as unknown as Record<string, unknown>).DEV_EMAIL).toBeUndefined();
  });
});

describe('PUBLIC: an anonymous visitor gets the sign-in shell and nothing else', () => {
  it('serves the app shell at "/" and its static files', async () => {
    const root = await send('GET', '/');
    expect(root.status).toBe(200);
    expect(root.text).toContain('PUBLIC-SHELL');
    expect(root.headers.get('set-cookie')).toBeNull();
    const js = await send('GET', '/assets/app.js');
    expect(js.status).toBe(200);
    expect(js.text).toContain('PUBLIC-BUNDLE');
  });

  it('serves the shell for any in-app link too (single-page app fallback) — still no data', async () => {
    for (const path of ['/some/deep/link', '/settings', '/login/', '/loginx']) {
      const r = await send('GET', path);
      expect(r.status, path).toBe(200);
      expect(r.text, path).toContain('PUBLIC-SHELL');
    }
    // The platform canonicalises /index.html to "/" with a same-origin redirect.
    const index = await send('GET', '/index.html');
    expect([200, 307, 308]).toContain(index.status);
    if (index.status !== 200) expect(index.headers.get('location')).toBe('/');
  });

  it('"/login" without a verified token never signs anyone in: it returns to the public page with a notice', async () => {
    const r = await send('GET', '/login');
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/?signin=unavailable');
    expect(r.headers.get('set-cookie')).toBeNull();
  });

  it('"/login" with a verified Access token sends the person to the app root', async () => {
    const r = await send('GET', '/login', { jwt: await token(SUPER) });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/');
  });

  it('path tricks (case, encoding, double slashes, dot segments) never reach data without a token', async () => {
    for (const path of ['/API/whoami', '/Api/export', '//api/whoami', '/%61pi/whoami', '/api%2Fwhoami', '/api', '/./api/whoami', '/x/../api/whoami', '/api/../api/export', '/api/whoami/', '/api//whoami', '/api/whoami%00']) {
      let r = await send('GET', path);
      // The platform may canonicalise the path with a same-origin redirect (e.g. "//api/x" -> "/api/x"):
      // follow it the way a browser would, still without a token.
      for (let hops = 0; r.status >= 300 && r.status < 400 && hops < 3; hops++) {
        const location = r.headers.get('location') ?? '';
        expect(location.startsWith('/') && !location.startsWith('//'), `${path} redirects to ${location}`).toBe(true);
        r = await send('GET', location);
      }
      // Either the public shell (the Worker was not asked) or a refusal — never data.
      const isShell = r.status === 200 && r.text.includes('PUBLIC-SHELL');
      const refused = r.status >= 400;
      expect(isShell || refused, `${path} -> ${r.status}`).toBe(true);
      expect(r.text, path).not.toMatch(/"email"|"tenant"|"records"|"revision"/);
    }
  });
});

describe('PROTECTED: no token, no data — whatever Access did or did not do', () => {
  const GETS = [
    '/api/whoami',
    '/api/tenant',
    '/api/export',
    '/api/stats',
    '/api/revisions',
    '/api/revisions?limit=5',
    '/api/revisions/1',
    '/api/tenant/users',
    '/api/tenant/storage/inspect',
    '/api/super/tenants',
    '/api/super/audit',
    '/api/does-not-exist',
    '/api/dev/as',
  ];
  const POSTS = [
    '/api/tenant/users',
    '/api/tenant/deletion-request',
    '/api/tenant/deletion-request/cancel',
    '/api/tenant/storage/upload',
    '/api/tenant/storage/activate-web',
    '/api/tenant/storage/deactivate-web',
    '/api/revisions/1/restore',
    '/api/super/tenants',
    '/api/super/tenants/ten_00000000-0000-0000-0000-000000000000/delete',
    '/api/super/legacy/adopt',
    '/api/dev/as',
  ];

  it('every API GET without a token is refused with no information', async () => {
    for (const path of GETS) {
      const r = await send('GET', path);
      expect(r.status, path).toBe(401);
      expect(Object.keys(r.json), path).toEqual(['error']);
      expect(r.text, path).not.toMatch(/ten_|usr_|@/);
    }
  });

  it('every state-changing API call without a token is refused', async () => {
    for (const path of POSTS) {
      const r = await send('POST', path, { body: { email: 'a@rakuten.com', name: 'x', adminEmail: 'a@rakuten.com' } });
      expect(r.status, path).toBe(401);
      expect(Object.keys(r.json), path).toEqual(['error']);
    }
    for (const method of ['PATCH', 'PUT', 'DELETE']) {
      expect((await send(method, '/api/tenant/users/usr_00000000-0000-0000-0000-000000000000', { body: { status: 'disabled' } })).status, method).toBe(401);
    }
  });

  it('the live-sync WebSocket cannot be opened without a token', async () => {
    const ws = await exports.default.fetch(new Request(`${BASE}/ws`, { headers: { Upgrade: 'websocket', Origin: BASE } }));
    expect(ws.status).toBe(401);
    expect(ws.webSocket).toBeNull();
    const foreign = await exports.default.fetch(new Request(`${BASE}/ws`, { headers: { Upgrade: 'websocket', Origin: 'https://evil.example' } }));
    expect(foreign.status).toBe(403);
    const plain = await exports.default.fetch(new Request(`${BASE}/ws`));
    expect(plain.status).toBe(426);
  });

  it('identity claims that are not a verified Access token are ignored', async () => {
    const forged: Array<Record<string, string>> = [
      { 'x-dev-email': SUPER },
      { cookie: `gc_dev_email=${encodeURIComponent(SUPER)}` },
      { 'cf-access-authenticated-user-email': SUPER },
      { 'x-gc-user': SUPER, 'x-gc-role': 'admin', 'x-gc-tenant': 'ten_00000000-0000-0000-0000-000000000000' },
      { authorization: `Bearer ${await token(SUPER)}` }, // the token must come in Access's own header
      { 'cf-access-jwt-assertion': '' },
    ];
    for (const headers of forged) {
      const r = await send('GET', '/api/whoami', { headers });
      expect(r.status, JSON.stringify(headers)).toBe(401);
    }
    expect((await send('POST', '/api/dev/as', { body: { email: SUPER } })).status).toBe(401);
  });

  it('tokens that are not exactly right are refused', async () => {
    const unsigned = `${btoa('{"alg":"none"}').replace(/=+$/, '')}.${btoa(JSON.stringify({ email: SUPER, aud: AUD, iss: TEAM, exp: 9999999999 })).replace(/=+$/, '')}.`;
    const bad: Array<[string, string]> = [
      ['garbage', 'not-a-jwt'],
      ['unsigned (alg none)', unsigned],
      ['signed by another key', await token(SUPER, { key: otherKey })],
      ['wrong audience', await token(SUPER, { aud: 'someone-elses-app' })],
      ['wrong issuer', await token(SUPER, { iss: 'https://evil.cloudflareaccess.com' })],
      ['expired', await token(SUPER, { expiresIn: Math.floor(Date.now() / 1000) - 3600 })],
      ['no user identity (service token)', await token(null)],
    ];
    for (const [label, jwt] of bad) {
      const r = await send('GET', '/api/whoami', { jwt });
      expect([401, 403], label).toContain(r.status);
      expect(r.text, label).not.toContain(SUPER);
    }
    // Only RS256 is accepted: a correctly signed RS384 token (key in the published key set) is refused.
    const rs384 = await new SignJWT({ email: SUPER }).setProtectedHeader({ alg: 'RS384', kid: 'sim-key-384' }).setIssuer(TEAM).setAudience(AUD).setExpirationTime('1h').sign(rs384Key);
    expect([401, 403]).toContain((await send('GET', '/api/whoami', { jwt: rs384 })).status);
    // HS256 "algorithm confusion": a token MACed with some secret must never verify against an RS256 key set.
    const hs = await new SignJWT({ email: SUPER }).setProtectedHeader({ alg: 'HS256' }).setIssuer(TEAM).setAudience(AUD).setExpirationTime('1h').sign(new TextEncoder().encode('secret-secret-secret-secret-secret'));
    expect([401, 403]).toContain((await send('GET', '/api/whoami', { jwt: hs })).status);
  });
});

describe('AUTHENTICATED: Access proves who you are; the registry decides whether you may use the app', () => {
  it('the configured Super Admin is accepted, with no tenant and no data access', async () => {
    const jwt = await token(SUPER);
    const who = await send('GET', '/api/whoami', { jwt });
    expect(who.status).toBe(200);
    expect(who.json).toMatchObject({ role: 'super_admin', tenant: null, sharedWorkspace: false });
    expect((await send('GET', '/api/export', { jwt })).status).toBe(403);
    expect((await send('GET', '/api/revisions', { jwt })).status).toBe(403);
  });

  it('creates an Admin only for a managed address; that Admin is then accepted', async () => {
    const jwt = await token(SUPER);
    const rejected = await send('POST', '/api/super/tenants', { jwt, body: { name: 'Nope', adminEmail: 'someone@gmail.com' } });
    expect(rejected.status).toBe(400);
    expect(rejected.json).toMatchObject({ error: 'email_domain_not_allowed' });

    const created = await send('POST', '/api/super/tenants', { jwt, body: { name: 'Rakuten QA', adminEmail: 'Admin.One@Rakuten.com' } });
    expect(created.status).toBe(201);
    const who = await send('GET', '/api/whoami', { jwt: await token('Admin.One@Rakuten.com') }); // mixed case in the token is normalised
    expect(who.status).toBe(200);
    expect(who.json).toMatchObject({ role: 'admin', email: 'admin.one@rakuten.com' });
  });

  it('an authenticated Rakuten employee who has no account is denied and is NOT provisioned', async () => {
    const before = await registryCounts();
    for (let i = 0; i < 3; i++) {
      const r = await send('GET', '/api/whoami', { jwt: await token('employee@rakuten.com') });
      expect(r.status).toBe(403);
      expect(r.json).toMatchObject({ error: 'forbidden', reason: 'unregistered' });
    }
    for (const path of ['/api/tenant', '/api/export', '/api/tenant/users', '/api/super/tenants']) {
      expect((await send('GET', path, { jwt: await token('employee@rakuten.com') })).status, path).toBe(403);
    }
    const create = await send('POST', '/api/tenant/users', { jwt: await token('employee@rakuten.com'), body: { email: 'friend@rakuten.com', access: 'editor' } });
    expect(create.status).toBe(403);
    expect(await registryCounts()).toEqual(before);
  });

  it('a Rakuten employee cannot make themselves an Admin or a User through any route', async () => {
    const before = await registryCounts();
    const jwt = await token('self.service@rakuten.com');
    for (const [method, path, body] of [
      ['POST', '/api/super/tenants', { name: 'Mine', adminEmail: 'self.service@rakuten.com' }],
      ['POST', '/api/tenant/users', { email: 'self.service@rakuten.com', access: 'editor' }],
      ['POST', '/api/register', { email: 'self.service@rakuten.com' }],
      ['POST', '/api/signup', { email: 'self.service@rakuten.com' }],
      ['POST', '/api/tenant/join', { tenantId: 'ten_00000000-0000-0000-0000-000000000000' }],
    ] as const) {
      const r = await send(method, path, { jwt, body });
      expect([403, 404], `${method} ${path}`).toContain(r.status);
    }
    expect(await registryCounts()).toEqual(before);
  });
});

import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { hashPassword } from '../../src/passwords';

/**
 * The Worker configured like PRODUCTION (wrangler.prod-sim.jsonc): no development
 * identity, real session-cookie verification, and the public static shell.
 *
 * What this simulates of the network path: nothing else is in front of these
 * requests. That is the strictest possible reading — an anonymous request
 * reaches the Worker directly — and the Worker must still refuse everything
 * protected.
 *
 * Sign-in is DUAL: either the Worker's own password sign-in (POST /signin
 * with email + password; the Super Admin's password is a HASH in configuration,
 * SUPER_ADMIN_PASSWORD, the production setup step; tenant users' passwords are
 * set by the SV who creates them) or a Cloudflare Access JWT (the SSO path —
 * only the Access signing key is a test key, served to the Worker in place of
 * the real team's JWKS endpoint).
 */

const BASE = 'https://ganttchart.sim.workers.dev';
const SUPER = 'boss@rakuten.com';
const SUPER_PASSWORD = 'super-initial-password-1234';
const TEAM = 'https://sim-team.cloudflareaccess.com';
const AUD = 'sim-aud-tag';

interface Sent {
  status: number;
  text: string;
  json: Record<string, unknown>;
  headers: Headers;
}

async function send(method: string, path: string, opts: { cookie?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Sent> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.cookie !== undefined) headers.cookie = opts.cookie;
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

/** Sign in; returns the status and the session cookie (null when refused). */
async function signIn(email: string, password: string): Promise<{ status: number; cookie: string | null }> {
  const res = await exports.default.fetch(
    new Request(BASE + '/signin', {
      method: 'POST',
      headers: { Origin: BASE, 'x-gc-intent': 'test', 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
      redirect: 'manual',
    }),
  );
  const setCookie = res.headers.get('set-cookie');
  const cookie = setCookie === null ? null : setCookie.split(';')[0] ?? null;
  return { status: res.status, cookie };
}

/** Set a user's password directly in the registry (what the SV flow does through the Worker). */
async function seedPassword(email: string, password: string): Promise<void> {
  const hash = await hashPassword(password);
  await runInDurableObject(env.REGISTRY.getByName('registry'), async (_i, state) => {
    const user = state.storage.sql.exec<{ id: string } & Record<string, string | number | null>>(`SELECT id FROM users WHERE email = ?`, email).one();
    state.storage.sql.exec(
      `INSERT INTO credentials (user_id, password_hash, must_change, set_at, set_by, failed_attempts, locked_until) VALUES (?, ?, 0, ?, 'test', 0, NULL)
       ON CONFLICT (user_id) DO UPDATE SET password_hash = excluded.password_hash, failed_attempts = 0, locked_until = NULL`,
      user.id,
      hash,
      new Date().toISOString(),
    );
  });
}

/** Flip a tenant to web storage directly in the registry (what the upload + activate-web flow ends with). */
async function seedWebMode(adminEmail: string): Promise<void> {
  await runInDurableObject(env.REGISTRY.getByName('registry'), async (_i, state) => {
    state.storage.sql.exec(
      `UPDATE tenants SET storage_mode = 'web' WHERE id = (SELECT tenant_id FROM users WHERE email = ?)`,
      adminEmail,
    );
  });
}

/** Create a tenant whose SV has a seeded password, and return the SV's session cookie. */
async function svSession(tenantName: string): Promise<string> {
  const slug = tenantName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const svEmail = `${slug}-sv@rakuten.com`;
  const { cookie } = await signIn(SUPER, SUPER_PASSWORD);
  expect(cookie).not.toBeNull();
  const created = await send('POST', '/api/super/tenants', { cookie: cookie ?? undefined, body: { name: tenantName, adminEmail: svEmail } });
  expect(created.status).toBe(201);
  await seedWebMode(svEmail);
  await seedPassword(svEmail, 'sv-initial-password-1234');
  const sv = await signIn(svEmail, 'sv-initial-password-1234');
  expect(sv.cookie).not.toBeNull();
  return sv.cookie ?? '';
}

let accessKey: CryptoKey;
let otherKey: CryptoKey;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  // The Worker verifies Access tokens against `${TEAM}/cdn-cgi/access/certs`;
  // serve the test key there (the real team's published key set in production).
  const pair = await generateKeyPair('RS256');
  accessKey = pair.privateKey as CryptoKey;
  const other = await generateKeyPair('RS256');
  otherKey = other.privateKey as CryptoKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'sim-key', alg: 'RS256', use: 'sig' };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === `${TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    return realFetch(input, init);
  });
  // Nothing to seed: the Super Admin's password is a hash in configuration
  // (wrangler.prod-sim.jsonc sets SUPER_ADMIN_PASSWORD to hashPassword(SUPER_PASSWORD)).
});

afterAll(() => {
  vi.unstubAllGlobals();
});

/** Mint an Access JWT the way Cloudflare Access would (RS256, team issuer, app audience). */
async function accessToken(email: string | null, o: { key?: CryptoKey; iss?: string; aud?: string; exp?: string | number } = {}): Promise<string> {
  const claims: Record<string, unknown> = email === null ? { sub: 'service' } : { email, sub: 'u-1' };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'sim-key' })
    .setIssuer(o.iss ?? TEAM)
    .setAudience(o.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(o.exp ?? '10m')
    .sign(o.key ?? accessKey);
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

  it('"/login" without a session serves the sign-in shell (no redirect loop); with a session it goes to the app root', async () => {
    const anon = await send('GET', '/login');
    expect(anon.status).toBe(200);
    expect(anon.text).toContain('PUBLIC-SHELL');
    expect(anon.headers.get('set-cookie')).toBeNull();
    const { cookie } = await signIn(SUPER, SUPER_PASSWORD);
    expect(cookie).not.toBeNull();
    const signedIn = await send('GET', '/login', { cookie: cookie ?? undefined });
    expect(signedIn.status).toBe(302);
    expect(signedIn.headers.get('location')).toBe('/');
  });

  it('path tricks (case, encoding, double slashes, dot segments) never reach data without a session', async () => {
    for (const path of ['/API/whoami', '/Api/export', '//api/whoami', '/%61pi/whoami', '/api%2Fwhoami', '/api', '/./api/whoami', '/x/../api/whoami', '/api/../api/export', '/api/whoami/', '/api//whoami', '/api/whoami%00']) {
      let r = await send('GET', path);
      // The platform may canonicalise the path with a same-origin redirect (e.g. "//api/x" -> "/api/x"):
      // follow it the way a browser would, still without a session.
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

describe('SIGN-IN: the Worker\'s own password authentication', () => {
  it('refuses a wrong password, an unknown email and a missing body — with no account enumeration', async () => {
    const wrong = await signIn(SUPER, 'wrong-password');
    expect(wrong.status).toBe(401);
    expect(wrong.cookie).toBeNull();
    const unknown = await signIn('nobody@rakuten.com', 'whatever-password');
    expect(unknown.status).toBe(401);
    expect(unknown.cookie).toBeNull();
    const empty = await send('POST', '/signin', { body: {} });
    expect(empty.status).toBe(400);
  });

  it('a cross-site form cannot log anyone in (no Origin, foreign Origin)', async () => {
    for (const headers of [{}, { Origin: 'https://evil.example' }]) {
      const res = await exports.default.fetch(
        new Request(BASE + '/signin', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ email: SUPER, password: SUPER_PASSWORD }) }),
      );
      expect(res.status).toBe(403);
    }
  });

  it('locks the account after too many failures, then reports the lock (even the right password is refused)', async () => {
    // A dedicated account so the Super Admin is not locked out of the other tests.
    const { cookie } = await signIn(SUPER, SUPER_PASSWORD);
    expect(cookie).not.toBeNull();
    const created = await send('POST', '/api/super/tenants', { cookie: cookie ?? undefined, body: { name: 'Lock Test', adminEmail: 'lock.admin@rakuten.com' } });
    expect(created.status).toBe(201);
    await seedPassword('lock.admin@rakuten.com', 'lock-admin-password-1234');
    for (let i = 0; i < 10; i++) {
      const bad = await signIn('lock.admin@rakuten.com', 'not-the-password');
      // The 10th failure is the one that locks, so it may already report the lock.
      expect([401, 423]).toContain(bad.status);
    }
    const locked = await signIn('lock.admin@rakuten.com', 'lock-admin-password-1234');
    expect(locked.status).toBe(423);
  });

  it('logout revokes the session server-side: the cookie is worthless afterwards', async () => {
    const { cookie } = await signIn(SUPER, SUPER_PASSWORD);
    expect(cookie).not.toBeNull();
    const out = await send('POST', '/api/auth/logout', { cookie: cookie ?? undefined });
    expect(out.status).toBe(200);
    expect((out.headers.get('set-cookie') ?? '')).toContain('Max-Age=0');
    const after = await send('GET', '/api/whoami', { cookie: cookie ?? undefined });
    expect(after.status).toBe(403);
  });
});

describe('PROTECTED: no session, no data', () => {
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

  it('every API GET without a session is refused with no information', async () => {
    for (const path of GETS) {
      const r = await send('GET', path);
      expect(r.status, path).toBe(401);
      expect(Object.keys(r.json).sort(), path).toEqual(['error', 'requestId']);
      expect(r.text, path).not.toMatch(/ten_|usr_|@/);
    }
  });

  it('every state-changing API call without a session is refused', async () => {
    for (const path of POSTS) {
      const r = await send('POST', path, { body: { email: 'a@rakuten.com', name: 'x', adminEmail: 'a@rakuten.com' } });
      expect(r.status, path).toBe(401);
      expect(Object.keys(r.json).sort(), path).toEqual(['error', 'requestId']);
    }
    for (const method of ['PATCH', 'PUT', 'DELETE']) {
      expect((await send(method, '/api/tenant/users/usr_00000000-0000-0000-0000-000000000000', { body: { status: 'disabled' } })).status, method).toBe(401);
    }
  });

  it('the live-sync WebSocket cannot be opened without a session', async () => {
    const ws = await exports.default.fetch(new Request(`${BASE}/ws`, { headers: { Upgrade: 'websocket', Origin: BASE } }));
    expect(ws.status).toBe(401);
    expect(ws.webSocket).toBeNull();
    const foreign = await exports.default.fetch(new Request(`${BASE}/ws`, { headers: { Upgrade: 'websocket', Origin: 'https://evil.example' } }));
    expect(foreign.status).toBe(403);
    const plain = await exports.default.fetch(new Request(`${BASE}/ws`));
    expect(plain.status).toBe(426);
  });

  it('identity claims that are not a verified session are ignored', async () => {
    const forged: Array<Record<string, string>> = [
      { 'x-dev-email': SUPER },
      { cookie: `gc_dev_email=${encodeURIComponent(SUPER)}` },
      { 'cf-access-authenticated-user-email': SUPER },
      { 'x-gc-user': SUPER, 'x-gc-role': 'admin', 'x-gc-tenant': 'ten_00000000-0000-0000-0000-000000000000' },
      { authorization: 'Bearer some-made-up-token' },
      { cookie: 'gc_session=forged-token-value' },
    ];
    for (const headers of forged) {
      const r = await send('GET', '/api/whoami', { headers });
      // No session at all is 401; a PRESENT but forged session is 403. Both are refusals.
      expect([401, 403], JSON.stringify(headers)).toContain(r.status);
    }
    expect((await send('GET', '/api/whoami', { headers: { cookie: 'gc_session=' } })).status).toBe(401);
    expect((await send('POST', '/api/dev/as', { body: { email: SUPER } })).status).toBe(401);
  });

  it('a forged Access JWT (wrong key, wrong team, wrong audience, expired) is refused', async () => {
    const bad: Array<[string, string]> = [
      ['wrong key', await accessToken(SUPER, { key: otherKey })],
      ['wrong team', await accessToken(SUPER, { iss: 'https://evil.cloudflareaccess.com' })],
      ['wrong audience', await accessToken(SUPER, { aud: 'other-app' })],
      ['expired', await accessToken(SUPER, { exp: '-1h' })],
    ];
    for (const [name, jwt] of bad) {
      const r = await send('GET', '/api/whoami', { headers: { 'cf-access-jwt-assertion': jwt } });
      expect([401, 403], name).toContain(r.status);
    }
  });
});

describe('SSO: the Cloudflare Access JWT is the second sign-in method (either alone is enough)', () => {
  it('a valid Access JWT authenticates without any session cookie', async () => {
    const jwt = await accessToken(SUPER);
    const who = await send('GET', '/api/whoami', { headers: { 'cf-access-jwt-assertion': jwt } });
    expect(who.status).toBe(200);
    expect(who.json).toMatchObject({ role: 'super_admin', tenant: null, sharedWorkspace: false });
  });

  it('an Access JWT for a tenant user is accepted too (the registry decides access)', async () => {
    const { cookie } = await signIn(SUPER, SUPER_PASSWORD);
    const created = await send('POST', '/api/super/tenants', { cookie: cookie ?? undefined, body: { name: 'SSO Tenant', adminEmail: 'sso.admin@rakuten.com' } });
    expect(created.status).toBe(201);
    const jwt = await accessToken('sso.admin@rakuten.com');
    const who = await send('GET', '/api/whoami', { headers: { 'cf-access-jwt-assertion': jwt } });
    expect(who.status).toBe(200);
    expect(who.json).toMatchObject({ role: 'admin' });
  });

  it('an Access JWT without a user identity (service token) is refused', async () => {
    const jwt = await accessToken(null);
    const r = await send('GET', '/api/whoami', { headers: { 'cf-access-jwt-assertion': jwt } });
    expect([401, 403]).toContain(r.status);
  });

  it('a session cookie and an Access JWT can travel together (the session wins nothing extra; both are valid)', async () => {
    const { cookie } = await signIn(SUPER, SUPER_PASSWORD);
    const jwt = await accessToken(SUPER);
    const who = await send('GET', '/api/whoami', { cookie: cookie ?? undefined, headers: { 'cf-access-jwt-assertion': jwt } });
    expect(who.status).toBe(200);
    expect(who.json).toMatchObject({ role: 'super_admin' });
  });
});

describe('AUTHENTICATED: the password proves who you are; the registry decides whether you may use the app', () => {
  it('the configured Super Admin is accepted, with no tenant and no data access', async () => {
    const { cookie } = await signIn(SUPER, SUPER_PASSWORD);
    expect(cookie).not.toBeNull();
    const who = await send('GET', '/api/whoami', { cookie: cookie ?? undefined });
    expect(who.status).toBe(200);
    expect(who.json).toMatchObject({ role: 'super_admin', tenant: null, sharedWorkspace: false });
    expect((await send('GET', '/api/export', { cookie: cookie ?? undefined })).status).toBe(403);
    expect((await send('GET', '/api/revisions', { cookie: cookie ?? undefined })).status).toBe(403);
  });

  it('creates an Admin only for a managed address; that Admin is then accepted', async () => {
    const { cookie } = await signIn(SUPER, SUPER_PASSWORD);
    const rejected = await send('POST', '/api/super/tenants', { cookie: cookie ?? undefined, body: { name: 'Nope', adminEmail: 'someone@gmail.com' } });
    expect(rejected.status).toBe(400);
    expect(rejected.json).toMatchObject({ error: 'email_domain_not_allowed' });

    const created = await send('POST', '/api/super/tenants', { cookie: cookie ?? undefined, body: { name: 'Rakuten QA', adminEmail: 'Admin.One@Rakuten.com' } });
    expect(created.status).toBe(201);
  });

  it('an anonymous visitor cannot provision anything by asking', async () => {
    const before = await registryCounts();
    for (const path of ['/api/tenant', '/api/export', '/api/tenant/users', '/api/super/tenants']) {
      expect((await send('GET', path)).status, path).toBe(401);
    }
    const create = await send('POST', '/api/tenant/users', { body: { email: 'friend@rakuten.com', access: 'editor' } });
    expect(create.status).toBe(401);
    expect(await registryCounts()).toEqual(before);
  });

  it('a Rakuten employee cannot make themselves an Admin or a User through any route', async () => {
    const before = await registryCounts();
    for (const [method, path, body] of [
      ['POST', '/api/super/tenants', { name: 'Mine', adminEmail: 'self.service@rakuten.com' }],
      ['POST', '/api/tenant/users', { email: 'self.service@rakuten.com', access: 'editor' }],
      ['POST', '/api/register', { email: 'self.service@rakuten.com' }],
      ['POST', '/api/signup', { email: 'self.service@rakuten.com' }],
      ['POST', '/api/tenant/join', { tenantId: 'ten_00000000-0000-0000-0000-000000000000' }],
    ] as const) {
      const r = await send(method, path, { body });
      expect([401, 403, 404], `${method} ${path}`).toContain(r.status);
    }
    expect(await registryCounts()).toEqual(before);
  });
});

describe('SUPER ADMIN SV PASSWORD RESET: caller and target sessions stay separate', () => {
  it('revokes only the target SV sessions and leaves the Super Admin principal authenticated', async () => {
    const superIn = await signIn(SUPER, SUPER_PASSWORD);
    expect(superIn.cookie).not.toBeNull();
    const adminEmail = 'super-reset-sv@rakuten.com';
    const created = await send('POST', '/api/super/tenants', {
      cookie: superIn.cookie ?? undefined,
      body: { name: 'Super Reset QA', adminEmail },
    });
    expect(created.status).toBe(201);
    const tenant = created.json.tenant as { id: string };
    const admin = created.json.admin as { id: string };
    await seedPassword(adminEmail, 'old-sv-password-1234');
    const svIn = await signIn(adminEmail, 'old-sv-password-1234');
    expect(svIn.cookie).not.toBeNull();

    const reset = await send('POST', `/api/super/tenants/${tenant.id}/users/${admin.id}/password`, {
      cookie: superIn.cookie ?? undefined,
      body: { password: 'new-sv-password-5678' },
    });
    expect(reset.status).toBe(200);
    expect(reset.json).toMatchObject({ ok: true, revokedSessions: 1 });
    expect((await send('GET', '/api/whoami', { cookie: svIn.cookie ?? undefined })).status).toBe(403);
    const superWho = await send('GET', '/api/whoami', { cookie: superIn.cookie ?? undefined });
    expect(superWho.status).toBe(200);
    expect(superWho.json).toMatchObject({ email: SUPER, role: 'super_admin', tenant: null });
    const targetIn = await signIn(adminEmail, 'new-sv-password-5678');
    expect(targetIn.status).toBe(200);
    expect((await send('GET', '/api/whoami', { cookie: targetIn.cookie ?? undefined })).json).toMatchObject({ mustChangePassword: true });
  });
});

describe('SV-SET PASSWORDS: the SV gives a user their initial password', () => {
  it('the SV sets a Tester\'s initial password; the Tester signs in and is forced to change it', async () => {
    const cookie = await svSession('Password QA');
    const tester = await send('POST', '/api/tenant/users', { cookie, body: { email: 'pw.tester@rakuten.com', access: 'editor', role: 'tester' } });
    expect(tester.status).toBe(201);
    const testerId = (tester.json.user as { id: string }).id;

    // Before: the Tester cannot sign in (no password yet).
    expect((await signIn('pw.tester@rakuten.com', 'anything-at-all')).status).toBe(401);

    // The SV sets the initial password.
    const set = await send('POST', `/api/tenant/users/${testerId}/password`, { cookie, body: { password: 'tester-initial-1234' } });
    expect(set.status).toBe(200);
    expect(set.json).toMatchObject({ ok: true });

    // The Tester signs in with it and owes a change.
    const in1 = await signIn('pw.tester@rakuten.com', 'tester-initial-1234');
    expect(in1.status).toBe(200);
    const who = await send('GET', '/api/whoami', { cookie: in1.cookie ?? undefined });
    expect(who.status).toBe(200);
    expect(who.json).toMatchObject({ mustChangePassword: true });

    // The Tester changes it; the flag clears and the old password stops working.
    const changed = await send('POST', '/api/auth/change-password', { cookie: in1.cookie ?? undefined, body: { currentPassword: 'tester-initial-1234', newPassword: 'tester-own-password-5678' } });
    expect(changed.status).toBe(200);
    expect((await signIn('pw.tester@rakuten.com', 'tester-initial-1234')).status).toBe(401);
    const in2 = await signIn('pw.tester@rakuten.com', 'tester-own-password-5678');
    expect(in2.status).toBe(200);
    const who2 = await send('GET', '/api/whoami', { cookie: in2.cookie ?? undefined });
    expect(who2.json).toMatchObject({ mustChangePassword: false });
  });

  it('a reset password ends the sessions the old password had opened', async () => {
    const cookie = await svSession('Reset QA');
    const tester = await send('POST', '/api/tenant/users', { cookie, body: { email: 'reset.tester@rakuten.com', access: 'editor', role: 'tester' } });
    const testerId = (tester.json.user as { id: string }).id;
    await send('POST', `/api/tenant/users/${testerId}/password`, { cookie, body: { password: 'reset-initial-1234' } });
    const in1 = await signIn('reset.tester@rakuten.com', 'reset-initial-1234');
    expect(in1.status).toBe(200);
    expect((await send('GET', '/api/whoami', { cookie: in1.cookie ?? undefined })).status).toBe(200);

    // The SV resets it: the Tester's session is revoked server-side.
    const reset = await send('POST', `/api/tenant/users/${testerId}/password`, { cookie, body: { password: 'reset-second-5678' } });
    expect(reset.status).toBe(200);
    expect(reset.json).toMatchObject({ ok: true, revokedSessions: 1 });
    expect((await send('GET', '/api/whoami', { cookie: in1.cookie ?? undefined })).status).toBe(403);
    expect((await signIn('reset.tester@rakuten.com', 'reset-second-5678')).status).toBe(200);
  });

  it('only the SV may set passwords; a Tester cannot, not even their own id', async () => {
    const cookie = await svSession('Guard QA');
    const tester = await send('POST', '/api/tenant/users', { cookie, body: { email: 'guard.tester@rakuten.com', access: 'editor', role: 'tester' } });
    const testerId = (tester.json.user as { id: string }).id;
    await send('POST', `/api/tenant/users/${testerId}/password`, { cookie, body: { password: 'guard-initial-1234' } });
    const testerIn = await signIn('guard.tester@rakuten.com', 'guard-initial-1234');
    expect(testerIn.status).toBe(200);
    // The Tester tries to set another password for themselves through the SV route.
    const attempt = await send('POST', `/api/tenant/users/${testerId}/password`, { cookie: testerIn.cookie ?? undefined, body: { password: 'self-made-password-9999' } });
    expect(attempt.status).toBe(403);
    // The old password still works; nothing changed.
    expect((await signIn('guard.tester@rakuten.com', 'guard-initial-1234')).status).toBe(200);
  });

  it('a too-short password is refused and changes nothing', async () => {
    const cookie = await svSession('Short QA');
    const tester = await send('POST', '/api/tenant/users', { cookie, body: { email: 'short.tester@rakuten.com', access: 'editor', role: 'tester' } });
    const testerId = (tester.json.user as { id: string }).id;
    const bad = await send('POST', `/api/tenant/users/${testerId}/password`, { cookie, body: { password: 'short' } });
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({ error: 'password_too_short' });
    expect((await signIn('short.tester@rakuten.com', 'short')).status).toBe(401);
  });
});

describe('SESSION REVOCATION: a disable, access change or role change ends the person\'s live session', () => {
  /** Create a web tenant, an SV session, and a Tester with a working password + session. */
  async function svAndTester(tenantName: string, testerEmail: string): Promise<{ svCookie: string; testerId: string; memberId: string; testerCookie: string }> {
    const svCookie = await svSession(tenantName);
    const tester = await send('POST', '/api/tenant/users', { cookie: svCookie, body: { email: testerEmail, access: 'editor', role: 'tester' } });
    expect(tester.status).toBe(201);
    const testerId = (tester.json.user as { id: string }).id;
    const memberId = (tester.json.memberId as string) ?? '';
    await send('POST', `/api/tenant/users/${testerId}/password`, { cookie: svCookie, body: { password: 'tester-initial-1234' } });
    const in1 = await signIn(testerEmail, 'tester-initial-1234');
    expect(in1.status).toBe(200);
    expect((await send('GET', '/api/whoami', { cookie: in1.cookie ?? undefined })).status).toBe(200);
    return { svCookie, testerId, memberId, testerCookie: in1.cookie ?? '' };
  }

  it('disabling a Tester ends their session: the next request is refused', async () => {
    const { svCookie, testerId, testerCookie } = await svAndTester('Disable QA', 'disable.tester@rakuten.com');
    const off = await send('PATCH', `/api/tenant/users/${testerId}`, { cookie: svCookie, body: { status: 'disabled' } });
    expect(off.status).toBe(200);
    // The session was revoked server-side: the cookie is worthless now.
    expect((await send('GET', '/api/whoami', { cookie: testerCookie })).status).toBe(403);
    // And the account cannot sign in again while disabled.
    expect((await signIn('disable.tester@rakuten.com', 'tester-initial-1234')).status).toBe(401);
  });

  it('changing a Tester\'s access level ends their session', async () => {
    const { svCookie, testerId, testerCookie } = await svAndTester('Access QA', 'access.tester@rakuten.com');
    const change = await send('PATCH', `/api/tenant/users/${testerId}`, { cookie: svCookie, body: { access: 'viewer' } });
    expect(change.status).toBe(200);
    expect((await send('GET', '/api/whoami', { cookie: testerCookie })).status).toBe(403);
  });

  it('changing a Tester\'s role to SV ends their session (the next request is authorised as the new role)', async () => {
    const { svCookie, memberId, testerCookie } = await svAndTester('Role QA', 'role.tester@rakuten.com');
    const role = await send('POST', `/api/tenant/members/${memberId}/role`, { cookie: svCookie, body: { role: 'sv' } });
    expect(role.status).toBe(200);
    // The old session is gone; the person signs in again and is now an SV.
    expect((await send('GET', '/api/whoami', { cookie: testerCookie })).status).toBe(403);
    const in2 = await signIn('role.tester@rakuten.com', 'tester-initial-1234');
    expect(in2.status).toBe(200);
    const who = await send('GET', '/api/whoami', { cookie: in2.cookie ?? undefined });
    expect(who.status).toBe(200);
    expect(who.json).toMatchObject({ role: 'admin' });
  });
});

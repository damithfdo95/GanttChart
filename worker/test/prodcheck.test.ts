import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEV_ONLY_VARS, EXPECTED_WORKER_ROUTES, SECRET_NAMES, checkProduction, parseDomains, parseJsonc, stripJsonComments } from '../scripts/prodcheck.mjs';
import { ACCESS_PROTECTED_PATHS, WORKER_ROUTES, isWorkerPath } from '../../shared/routes';
import { parseManagedDomains } from '../../shared/tenancy';

const root = resolve(__dirname, '..', '..');
const read = (p: string): string => readFileSync(resolve(root, p), 'utf8');
const real = (): Record<string, any> => parseJsonc(read('worker/wrangler.jsonc'));
const docs = read('docs/DEPLOYMENT_PLAN.md');
const ok = { distHasIndex: true, docsText: docs };
const errorsFor = (config: Record<string, any>, ctx = ok): string[] => checkProduction(config, ctx).errors;
const clone = (): Record<string, any> => JSON.parse(JSON.stringify(real()));

describe('the production configuration in the repository', () => {
  it('passes the pre-deployment guard', () => {
    expect(errorsFor(real())).toEqual([]);
  });

  it('is wired so that wrangler runs the guard before every deploy', () => {
    expect(real().build?.command).toBe('node scripts/check-production.mjs');
  });

  it('keeps the production auth secrets OUT of vars and requires them as secrets', () => {
    const c = real();
    for (const name of SECRET_NAMES) expect(c.vars).not.toHaveProperty(name);
    expect(c.secrets.required).toEqual(expect.arrayContaining(['ACCESS_AUD', 'SUPER_ADMIN_EMAILS']));
  });

  it('holds the non-secret production settings', () => {
    const c = real();
    expect(c.vars.ACCESS_TEAM_DOMAIN).toBe('https://qa-internal.cloudflareaccess.com');
    expect(c.vars.MANAGED_USER_EMAIL_DOMAINS).toBe('rakuten.com');
    expect(c.vars.HISTORY_RETENTION_DAYS).toBe('30');
    expect(c.preview_urls).toBe(false);
  });

  it('commits no personal address anywhere in the configuration', () => {
    expect(read('worker/wrangler.jsonc')).not.toMatch(/gmail\.com|@(?!dev\.test)[a-z0-9-]+\.[a-z]{2,}/i);
  });
});

describe('guard rules (each one is a way production could be left unsafe)', () => {
  const expectError = (mutate: (c: Record<string, any>) => void, fragment: string, ctx = ok) => {
    const c = clone();
    mutate(c);
    expect(errorsFor(c, ctx).join('\n')).toContain(fragment);
  };

  it('Access team domain must be https://<team>.cloudflareaccess.com', () => {
    for (const bad of ['', 'http://qa-internal.cloudflareaccess.com', 'https://evil.example', 'https://qa-internal.cloudflareaccess.com/', 'https://qa-internal.cloudflareaccess.com/x', 'qa-internal.cloudflareaccess.com']) {
      expectError((c) => (c.vars.ACCESS_TEAM_DOMAIN = bad), 'ACCESS_TEAM_DOMAIN');
    }
    expectError((c) => delete c.vars.ACCESS_TEAM_DOMAIN, 'ACCESS_TEAM_DOMAIN');
  });

  it('managed domains must exist and be plain domain names', () => {
    expectError((c) => (c.vars.MANAGED_USER_EMAIL_DOMAINS = ''), 'MANAGED_USER_EMAIL_DOMAINS');
    expectError((c) => delete c.vars.MANAGED_USER_EMAIL_DOMAINS, 'MANAGED_USER_EMAIL_DOMAINS');
    expectError((c) => (c.vars.MANAGED_USER_EMAIL_DOMAINS = '*'), 'MANAGED_USER_EMAIL_DOMAINS');
    expectError((c) => (c.vars.MANAGED_USER_EMAIL_DOMAINS = 'rakuten.com,*.example.com'), 'not plain domain names');
  });

  it('secrets must not be plain vars (a deploy would overwrite them) and must be required', () => {
    for (const name of SECRET_NAMES) {
      expectError((c) => (c.vars[name] = ''), `vars.${name} must NOT be in the config`);
      expectError((c) => (c.vars[name] = 'x'), `vars.${name} must NOT be in the config`);
      expectError((c) => (c.secrets.required = c.secrets.required.filter((n: string) => n !== name)), `secrets.required must list ${name}`);
    }
    expectError((c) => delete c.secrets, 'secrets.required');
  });

  it('development-only variables never appear in production config', () => {
    for (const name of DEV_ONLY_VARS) expectError((c) => (c.vars[name] = 'x'), `vars.${name} is development-only`);
  });

  it('Worker bindings must exist', () => {
    expectError((c) => (c.durable_objects.bindings = c.durable_objects.bindings.filter((b: any) => b.name !== 'REGISTRY')), 'REGISTRY');
    expectError((c) => (c.durable_objects.bindings = c.durable_objects.bindings.filter((b: any) => b.name !== 'WORKSPACE')), 'WORKSPACE');
    expectError((c) => delete c.assets.binding, 'assets.binding');
  });

  it('Durable Object migrations must remain, and no destructive one may be added', () => {
    expectError((c) => (c.migrations = c.migrations.filter((m: any) => m.tag !== 'v2')), 'v2 must create RegistryRoom');
    expectError((c) => (c.migrations = c.migrations.filter((m: any) => m.tag !== 'v1')), 'v1 must create WorkspaceRoom');
    expectError((c) => c.migrations.push({ tag: 'v3', deleted_classes: ['WorkspaceRoom'] }), 'deleted_classes');
    expectError((c) => c.migrations.push({ tag: 'v3', renamed_classes: [{ from: 'A', to: 'B' }] }), 'renamed_classes');
  });

  it('the routes the Worker handles must be exactly the protected ones', () => {
    expectError((c) => (c.assets.run_worker_first = ['/api/*', '/ws']), 'run_worker_first'); // /login would be a public SPA page
    expectError((c) => (c.assets.run_worker_first = ['/api/*', '/ws', '/login', '/extra']), 'run_worker_first');
    expectError((c) => delete c.assets.run_worker_first, 'run_worker_first');
    expectError((c) => (c.assets.run_worker_first = true), 'run_worker_first');
    expectError((c) => (c.assets.not_found_handling = '404-page'), 'not_found_handling');
  });

  it('preview URLs stay off; no custom domain or account is committed', () => {
    expectError((c) => (c.preview_urls = true), 'preview_urls');
    expectError((c) => delete c.preview_urls, 'preview_urls');
    expectError((c) => (c.account_id = 'abc'), 'account_id');
    expectError((c) => (c.routes = [{ pattern: 'x.example.com/*' }]), 'routes');
  });

  it('the production SPA build must exist', () => {
    expectError(() => undefined, 'npm run build', { ...ok, distHasIndex: false });
  });

  it('observability stays on with a valid sampling rate', () => {
    expectError((c) => (c.observability.enabled = false), 'observability.enabled');
    expectError((c) => (c.observability.head_sampling_rate = 0), 'head_sampling_rate');
    expectError((c) => (c.observability.head_sampling_rate = 2), 'head_sampling_rate');
    expect(errorsFor({ ...clone(), observability: { enabled: true, head_sampling_rate: 0.1 } })).toEqual([]);
  });

  it('the deployment documentation must state the expectations', () => {
    for (const needle of ['ACCESS_AUD', 'SUPER_ADMIN_EMAILS', 'MANAGED_USER_EMAIL_DOMAINS', '/login']) {
      expectError(() => undefined, needle, { ...ok, docsText: docs.split(needle).join('') });
    }
  });

  it('always reminds what it cannot verify', () => {
    expect(checkProduction(real(), ok).notes.join(' ')).toMatch(/secrets ACCESS_AUD and SUPER_ADMIN_EMAILS/);
  });
});

describe('the guard stays in step with the application code', () => {
  it('parses domains exactly like the Worker does', () => {
    for (const raw of ['rakuten.com', ' A.com , b.co ', '*', '', 'rakuten.com,*.x.com', '@x.com', 'x..com', 'ｒａｋｕｔｅｎ.com', undefined, 3]) {
      expect(parseDomains(raw)).toEqual(parseManagedDomains(raw));
    }
  });

  it('uses the same protected route list as the Worker and the documented Access destinations', () => {
    expect([...EXPECTED_WORKER_ROUTES].sort()).toEqual([...WORKER_ROUTES].sort());
    expect(real().assets.run_worker_first.slice().sort()).toEqual([...WORKER_ROUTES].sort());
    for (const p of ACCESS_PROTECTED_PATHS) expect(docs).toContain(p);
  });

  it('isWorkerPath covers every protected route and nothing public', () => {
    for (const p of ['/ws', '/login', '/api/whoami', '/api/', '/api/tenant/users']) expect(isWorkerPath(p), p).toBe(true);
    for (const p of ['/', '/index.html', '/assets/app.js', '/apix', '/api', '/login/', '/loginx', '/wss', '/anything/else']) expect(isWorkerPath(p), p).toBe(false);
  });
});

describe('JSONC reading', () => {
  it('keeps // inside strings, removes comments and trailing commas', () => {
    const text = '{\n // note\n "a": "https://x.example//y", /* c */ "b": [1, 2,],\n}';
    expect(JSON.parse(stripJsonComments(text))).toEqual({ a: 'https://x.example//y', b: [1, 2] });
  });
});

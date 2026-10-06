import { beforeEach, describe, expect, it } from 'vitest';
import { RegistryStore } from '../src/registry';
import { emailDomain, isManagedEmail, parseManagedDomains } from '../../shared/tenancy';
import { createTestStorage } from './helpers/sqlJsStorage';

type TestStorage = Awaited<ReturnType<typeof createTestStorage>>;

const RAKUTEN = parseManagedDomains('rakuten.com');
const SUPER = ['boss@example.org']; // a configured Super Admin identity: NOT in the managed domain
let storage: TestStorage;
let reg: RegistryStore;
let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 7, 0, 0, 0) + clock++ * 1000).toISOString();

beforeEach(async () => {
  storage = await createTestStorage();
  reg = new RegistryStore(storage);
  reg.init();
  clock = 0;
});

const count = (table: 'tenants' | 'users'): number => storage.sql.exec<{ n: number } & Record<string, number>>(`SELECT COUNT(*) AS n FROM ${table}`).toArray()[0].n;

function createAdmin(adminEmail: string, domains: readonly string[] = RAKUTEN) {
  return reg.createTenantWithAdmin({ name: 'QA', adminEmail, managedDomains: domains, reserved: SUPER, actorEmail: SUPER[0], now: now() });
}

function webTenant(adminEmail = 'admin@rakuten.com', domains: readonly string[] = RAKUTEN) {
  const created = createAdmin(adminEmail, domains);
  if (!created.ok) throw new Error(`setup failed: ${created.error}`);
  const set = reg.setStorageMode(created.value.tenant.id, 'web', now());
  if (!set.ok) throw new Error('setup failed');
  return created.value.tenant.id;
}

const createUser = (tenantId: string, email: string, domains: readonly string[] = RAKUTEN) =>
  reg.createUser({ tenantId, email, access: 'editor', managedDomains: domains, reserved: SUPER, actorUserId: 'usr_x', now: now() });

describe('parseManagedDomains (the MANAGED_USER_EMAIL_DOMAINS setting)', () => {
  it('reads one or several domains, normalised and de-duplicated', () => {
    expect(parseManagedDomains('rakuten.com')).toEqual(['rakuten.com']);
    expect(parseManagedDomains(' Rakuten.COM , example.com ,rakuten.com')).toEqual(['rakuten.com', 'example.com']);
    expect(parseManagedDomains('rakuten.com,example.com,sub.rakuten.com')).toEqual(['rakuten.com', 'example.com', 'sub.rakuten.com']);
  });

  it('fails closed: anything that is not a plain domain is dropped, so a typo can only shrink the list', () => {
    expect(parseManagedDomains('')).toEqual([]);
    expect(parseManagedDomains(undefined)).toEqual([]);
    expect(parseManagedDomains(null)).toEqual([]);
    expect(parseManagedDomains(42)).toEqual([]);
    expect(parseManagedDomains(',, ,')).toEqual([]);
    expect(parseManagedDomains('*')).toEqual([]);
    expect(parseManagedDomains('*.rakuten.com')).toEqual([]); // no wildcard subdomains
    expect(parseManagedDomains('@rakuten.com')).toEqual([]);
    expect(parseManagedDomains('user@rakuten.com')).toEqual([]);
    expect(parseManagedDomains('rakuten.com/path')).toEqual([]);
    expect(parseManagedDomains('https://rakuten.com')).toEqual([]);
    expect(parseManagedDomains('rakuten')).toEqual([]);
    expect(parseManagedDomains('-rakuten.com')).toEqual([]);
    expect(parseManagedDomains('rakuten..com')).toEqual([]);
    expect(parseManagedDomains('rakuten.com.')).toEqual([]);
    expect(parseManagedDomains('rakuten.com;example.com')).toEqual([]);
    expect(parseManagedDomains('rakuten.com, *, example.com')).toEqual(['rakuten.com', 'example.com']);
  });
});

describe('isManagedEmail — exact domain match only', () => {
  it('accepts the configured domain, whatever the spelling after normalisation', () => {
    expect(isManagedEmail('user@rakuten.com', RAKUTEN)).toBe(true);
    expect(isManagedEmail('  User@Rakuten.COM ', RAKUTEN)).toBe(true);
    expect(isManagedEmail('first.last+tag@rakuten.com', RAKUTEN)).toBe(true);
    expect(isManagedEmail('user@ｒａｋｕｔｅｎ.com', RAKUTEN)).toBe(true); // full-width folds to the real domain
  });

  it('rejects every look-alike and every other domain', () => {
    for (const bad of [
      'user@gmail.com',
      'user@fake-rakuten.com',
      'user@rakuten.com.attacker.example',
      'user@sub.rakuten.com',
      'user@notrakuten.com',
      'user@rakuten.co',
      'user@rakuten.com.',
      'user@rakuten.com@evil.example',
      'rakuten.com@evil.example',
      'user@evil.example?@rakuten.com',
      'user@rаkuten.com', // Cyrillic "а"
      'user@xn--rakuten-9ya.com',
      'user',
      '',
    ]) {
      expect(isManagedEmail(bad, RAKUTEN), bad).toBe(false);
    }
    expect(isManagedEmail(undefined, RAKUTEN)).toBe(false);
    expect(isManagedEmail(12, RAKUTEN)).toBe(false);
  });

  it('a subdomain is allowed only when it is listed itself; several domains work together', () => {
    expect(isManagedEmail('user@sub.rakuten.com', RAKUTEN)).toBe(false);
    const both = parseManagedDomains('rakuten.com,sub.rakuten.com,example.com');
    expect(isManagedEmail('user@sub.rakuten.com', both)).toBe(true);
    expect(isManagedEmail('user@example.com', both)).toBe(true);
    expect(isManagedEmail('user@rakuten.com', both)).toBe(true);
    expect(isManagedEmail('user@deep.sub.rakuten.com', both)).toBe(false);
    expect(isManagedEmail('user@gmail.com', both)).toBe(false);
  });

  it('an empty list allows nobody', () => {
    expect(isManagedEmail('user@rakuten.com', [])).toBe(false);
  });

  it('emailDomain is everything after the single @', () => {
    expect(emailDomain('a@b.co')).toBe('b.co');
  });
});

describe('Admin creation (Super Admin) enforces the managed domains', () => {
  it('accepts a managed address and stores it normalised', () => {
    const r = createAdmin('  Alice.Admin@Rakuten.com ');
    expect(r.ok && r.value.admin.email).toBe('alice.admin@rakuten.com');
  });

  it('rejects other domains with a clear validation error — and creates NOTHING (atomic)', () => {
    for (const bad of ['person@gmail.com', 'user@fake-rakuten.com', 'user@rakuten.com.attacker.example', 'user@sub.rakuten.com']) {
      expect(createAdmin(bad), bad).toEqual({ ok: false, error: 'email_domain_not_allowed' });
    }
    expect(count('tenants')).toBe(0);
    expect(count('users')).toBe(0);
    // ... and the same name/address can still be used correctly afterwards.
    expect(createAdmin('person@rakuten.com').ok).toBe(true);
    expect(count('tenants')).toBe(1);
    expect(count('users')).toBe(1);
  });

  it('an invalid address is reported as invalid, not as a domain problem', () => {
    expect(createAdmin('not-an-email')).toEqual({ ok: false, error: 'invalid_email' });
    expect(createAdmin('a@b@rakuten.com')).toEqual({ ok: false, error: 'invalid_email' });
  });

  it('with NO managed domain configured nobody can be provisioned (fail closed)', () => {
    expect(createAdmin('person@rakuten.com', [])).toEqual({ ok: false, error: 'managed_domains_not_configured' });
    expect(createAdmin('person@rakuten.com', parseManagedDomains('*,rakuten'))).toEqual({ ok: false, error: 'managed_domains_not_configured' });
    expect(count('tenants')).toBe(0);
  });

  it('several configured domains work', () => {
    const both = parseManagedDomains('rakuten.com,example.com');
    expect(createAdmin('a@rakuten.com', both).ok).toBe(true);
    expect(createAdmin('b@example.com', both).ok).toBe(true);
    expect(createAdmin('c@gmail.com', both)).toEqual({ ok: false, error: 'email_domain_not_allowed' });
  });

  it('the domain rule does not turn a reserved Super Admin address into an available one', () => {
    const r = reg.createTenantWithAdmin({ name: 'X', adminEmail: SUPER[0], managedDomains: parseManagedDomains('example.org'), reserved: SUPER, actorEmail: SUPER[0], now: now() });
    expect(r).toEqual({ ok: false, error: 'email_reserved' });
  });
});

describe('User creation (Admin) enforces the managed domains', () => {
  it('accepts managed addresses, normalised, inside the Admin tenant', () => {
    const tenantId = webTenant();
    const r = createUser(tenantId, 'New.User@RAKUTEN.com');
    expect(r.ok && r.value).toMatchObject({ email: 'new.user@rakuten.com', tenant_id: tenantId, role: 'user' });
  });

  it('rejects other domains and look-alikes, and creates nothing', () => {
    const tenantId = webTenant();
    const before = count('users');
    for (const bad of ['person@gmail.com', 'user@fake-rakuten.com', 'user@rakuten.com.attacker.example', 'user@sub.rakuten.com']) {
      expect(createUser(tenantId, bad), bad).toEqual({ ok: false, error: 'email_domain_not_allowed' });
    }
    expect(count('users')).toBe(before);
  });

  it('with no managed domain configured no user can be created either', () => {
    const tenantId = webTenant();
    expect(createUser(tenantId, 'u@rakuten.com', [])).toEqual({ ok: false, error: 'managed_domains_not_configured' });
  });

  it('a subdomain works once it is listed', () => {
    const tenantId = webTenant();
    expect(createUser(tenantId, 'u@sub.rakuten.com').ok).toBe(false);
    expect(createUser(tenantId, 'u@sub.rakuten.com', parseManagedDomains('rakuten.com,sub.rakuten.com')).ok).toBe(true);
  });
});

describe('accounts that predate the rule are never touched', () => {
  it('an existing non-managed Admin keeps working and is not deactivated; only NEW accounts are restricted', () => {
    // Created while the rule did not exist (here: while a broader list was configured).
    const broad = parseManagedDomains('gmail.com,rakuten.com');
    const old = createAdmin('legacy.admin@gmail.com', broad);
    expect(old.ok).toBe(true);
    const tenantId = old.ok ? old.value.tenant.id : '';
    reg.setStorageMode(tenantId, 'web', now());

    // The rule is tightened: the existing account still authenticates, its tenant is untouched ...
    const auth = reg.authenticate('legacy.admin@gmail.com', now());
    expect(auth.allowed).toBe(true);
    expect(reg.getTenant(tenantId)?.status).toBe('active');
    expect(reg.listTenantSummaries().map((t) => t.adminEmail)).toContain('legacy.admin@gmail.com');

    // ... but it cannot add a Gmail user any more, and cannot add anyone while it is in a non-managed domain... only managed ones.
    expect(createUser(tenantId, 'friend@gmail.com')).toEqual({ ok: false, error: 'email_domain_not_allowed' });
    expect(createUser(tenantId, 'colleague@rakuten.com').ok).toBe(true);
  });
});

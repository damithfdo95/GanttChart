import { beforeEach, describe, expect, it } from 'vitest';
import { RegistryStore } from '../src/registry';
import { TENANT_TRANSITIONS, nextTenantState, tenantAllowsAccess, userLifecycle, type TenantEvent } from '../../shared/lifecycle';
import { AUDIT_ACTIONS, PLATFORM_AUDIT_ACTIONS, parseDisplayName, type AuditActor, type TenantStatus } from '../../shared/tenancy';
import { createTestStorage } from './helpers/sqlJsStorage';

type TestStorage = Awaited<ReturnType<typeof createTestStorage>>;

const DOMAINS = ['rakuten.com', 'example.com'];
const SUPER = 'boss@example.org';
const SUPER_ACTOR: AuditActor = { userId: null, email: SUPER, role: 'super_admin' };
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

function must<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
}

function newTenant(name: string, adminEmail: string, displayName?: unknown) {
  return must(reg.createTenantWithAdmin({ name, adminEmail, displayName, managedDomains: DOMAINS, reserved: [SUPER], actorEmail: SUPER, now: now() }));
}

function webTenant(name: string, adminEmail: string) {
  const { tenant, admin } = newTenant(name, adminEmail);
  const actor: AuditActor = { userId: admin.id, email: admin.email, role: 'admin' };
  must(reg.setStorageMode(tenant.id, 'web', actor, now()));
  return { tenant: reg.getTenant(tenant.id)!, admin, actor };
}

const addUser = (tenantId: string, email: string, actor: AuditActor, displayName?: unknown) =>
  reg.createUser({ tenantId, email, displayName, access: 'editor', managedDomains: DOMAINS, reserved: [SUPER], actor, now: now() });

const rows = (sql: string, ...args: Array<string | number>) => storage.sql.exec<Record<string, string | number | null>>(sql, ...args).toArray();

describe('the lifecycle model', () => {
  const EVENTS: TenantEvent[] = ['disable', 'reactivate', 'requestDeletion', 'cancelDeletion', 'rejectDeletion', 'approveDeletion', 'completeDeletion'];
  const STATES: TenantStatus[] = ['active', 'deactivated', 'deletion_requested', 'deleting'];

  it('allows exactly the documented transitions and nothing else', () => {
    const allowed: Array<[TenantStatus, TenantEvent, string]> = [
      ['active', 'disable', 'deactivated'],
      ['active', 'requestDeletion', 'deletion_requested'],
      ['deactivated', 'reactivate', 'active'],
      ['deletion_requested', 'cancelDeletion', 'active'],
      ['deletion_requested', 'rejectDeletion', 'active'],
      ['deletion_requested', 'approveDeletion', 'deleting'],
      ['deleting', 'approveDeletion', 'deleting'],
      ['deleting', 'completeDeletion', 'removed'],
    ];
    for (const state of STATES) {
      for (const event of EVENTS) {
        const expected = allowed.find(([s, e]) => s === state && e === event)?.[2] ?? null;
        expect(nextTenantState(state, event), `${state} + ${event}`).toBe(expected);
      }
    }
    expect(Object.keys(TENANT_TRANSITIONS).sort()).toEqual([...STATES].sort());
  });

  it('disabled is not deletion-requested: only active/deletion_requested workspaces can be used', () => {
    expect(STATES.filter(tenantAllowsAccess)).toEqual(['active', 'deletion_requested']);
    expect(nextTenantState('deletion_requested', 'disable')).toBeNull();
    expect(nextTenantState('deactivated', 'requestDeletion')).toBeNull();
  });

  it('a stored "invited" account is presented as active; there are two states', () => {
    expect(userLifecycle('invited')).toBe('active');
    expect(userLifecycle('active')).toBe('active');
    expect(userLifecycle('disabled')).toBe('disabled');
  });

  it('the registry follows the table (illegal changes are refused and change nothing)', () => {
    const { tenant } = newTenant('A', 'a@example.com');
    expect(reg.setTenantStatus(tenant.id, 'active', SUPER, now())).toEqual({ ok: false, error: 'bad_state' }); // reactivating an active one
    must(reg.setTenantStatus(tenant.id, 'deactivated', SUPER, now()));
    expect(reg.setTenantStatus(tenant.id, 'deactivated', SUPER, now())).toEqual({ ok: false, error: 'bad_state' });
    expect(reg.requestDeletion({ tenantId: tenant.id, requestedByUserId: reg.adminOf(tenant.id)!.id, now: now() })).toEqual({ ok: false, error: 'bad_state' });
    must(reg.setTenantStatus(tenant.id, 'active', SUPER, now()));
    expect(reg.rejectDeletion({ tenantId: tenant.id, actorEmail: SUPER, now: now() })).toEqual({ ok: false, error: 'bad_state' });
  });
});

describe('display names', () => {
  it('are optional, trimmed text; control characters and angle brackets are refused', () => {
    expect(parseDisplayName(undefined)).toEqual({ ok: true, value: null });
    expect(parseDisplayName('')).toEqual({ ok: true, value: null });
    expect(parseDisplayName('   ')).toEqual({ ok: true, value: null });
    expect(parseDisplayName('  Taro   Yamada ')).toEqual({ ok: true, value: 'Taro Yamada' });
    expect(parseDisplayName('山田 太郎')).toEqual({ ok: true, value: '山田 太郎' });
    expect(parseDisplayName('a\nb')).toEqual({ ok: true, value: 'a b' }); // line breaks collapse to a space
    for (const bad of ['x'.repeat(81), 'a\u0000b', '<script>', 5, {}]) expect(parseDisplayName(bad), String(bad)).toEqual({ ok: false });
  });

  it('are stored for Admin and User, and a bad one creates nothing', () => {
    const { admin } = newTenant('A', 'a@example.com', 'Alice A.');
    expect(admin.display_name).toBe('Alice A.');
    const before = Number(rows('SELECT COUNT(*) AS n FROM tenants')[0].n);
    expect(reg.createTenantWithAdmin({ name: 'B', adminEmail: 'b@example.com', displayName: '<b>', managedDomains: DOMAINS, reserved: [], actorEmail: SUPER, now: now() })).toEqual({ ok: false, error: 'invalid_display_name' });
    expect(Number(rows('SELECT COUNT(*) AS n FROM tenants')[0].n)).toBe(before);

    const w = webTenant('W', 'w@example.com');
    expect(must(addUser(w.tenant.id, 'u@example.com', w.actor, 'Uma U.')).display_name).toBe('Uma U.');
    expect(addUser(w.tenant.id, 'v@example.com', w.actor, 'a\u0000b')).toEqual({ ok: false, error: 'invalid_display_name' });
  });
});

describe('upgrading an existing (Stage 5/6) registry', () => {
  it('adds the new column and table in place, keeps every row, and is repeatable', async () => {
    const old = await createTestStorage();
    // The exact Stage 5/6 schema: no display_name, no admin_audit.
    for (const ddl of [
      `CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, storage_mode TEXT NOT NULL CHECK (storage_mode IN ('local','web')), status TEXT NOT NULL CHECK (status IN ('active','deactivated','deletion_requested','deleting')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deletion_requested_at TEXT, deletion_requested_by TEXT)`,
      `CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, tenant_id TEXT NOT NULL REFERENCES tenants (id), role TEXT NOT NULL CHECK (role IN ('admin','user')), access TEXT NOT NULL CHECK (access IN ('editor','viewer')), status TEXT NOT NULL CHECK (status IN ('invited','active','disabled')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT, last_login_at TEXT)`,
      `CREATE TABLE deletion_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, requested_by_email TEXT NOT NULL, requested_at TEXT NOT NULL, approved_by_email TEXT NOT NULL, approved_at TEXT NOT NULL, deleted_at TEXT, users_deleted INTEGER NOT NULL DEFAULT 0)`,
      `INSERT INTO tenants VALUES ('ten_legacy', 'Legacy test workspace', 'web', 'active', 't0', 't0', NULL, NULL)`,
      `INSERT INTO users VALUES ('usr_a', 'legacy-admin@gmail.com', 'ten_legacy', 'admin', 'editor', 'invited', 't0', 't0', 'boss', NULL)`,
      `INSERT INTO users VALUES ('usr_b', 'old.user@rakuten.com', 'ten_legacy', 'user', 'viewer', 'disabled', 't0', 't0', 'usr_a', 't1')`,
      `INSERT INTO deletion_audit (tenant_id, requested_by_email, requested_at, approved_by_email, approved_at, deleted_at, users_deleted) VALUES ('ten_gone', 'r@x.co', 't', 's@x.co', 't', 't', 2)`,
    ]) old.sql.exec(ddl);

    const upgraded = new RegistryStore(old);
    upgraded.init();
    upgraded.init(); // a second start must change nothing

    const cols = old.sql.exec<{ name: string }>(`PRAGMA table_info(users)`).toArray().map((c) => c.name);
    expect(cols).toContain('display_name');
    expect(old.sql.exec(`SELECT name FROM sqlite_master WHERE name = 'admin_audit'`).toArray()).toHaveLength(1);

    // Nothing was lost or altered.
    expect(upgraded.getTenant('ten_legacy')).toMatchObject({ name: 'Legacy test workspace', status: 'active', storage_mode: 'web' });
    expect(upgraded.findUserByEmail('legacy-admin@gmail.com')).toMatchObject({ id: 'usr_a', status: 'invited', display_name: null });
    expect(upgraded.findUserByEmail('old.user@rakuten.com')).toMatchObject({ status: 'disabled', last_login_at: 't1' });
    expect(upgraded.listAudit()).toHaveLength(1);
    // A legacy 'invited' admin still signs in and is simply active; the legacy Gmail identity is still readable by the Super Admin.
    expect(upgraded.authenticate('legacy-admin@gmail.com', '2026-10-07T00:00:00.000Z')).toMatchObject({ allowed: true });
    expect(upgraded.findUserByEmail('legacy-admin@gmail.com')?.status).toBe('active');
    const listed = upgraded.listTenantSummaries();
    expect(listed.rows[0]).toMatchObject({ adminEmail: 'legacy-admin@gmail.com', adminDisplayName: null, adminStatus: 'active', userCount: 2 });
    // And the new features work on top of the old data.
    expect(upgraded.setTenantStatus('ten_legacy', 'deactivated', SUPER, '2026-10-07T00:01:00.000Z').ok).toBe(true);
    expect(upgraded.listAdminAudit({ kind: 'platform' }).map((a) => a.action)).toEqual(['tenant.disabled']);
  });
});

describe('the administrative audit trail', () => {
  it('records who did what, from the server-known actor', () => {
    const w = webTenant('Alpha', 'alpha@rakuten.com');
    const u = must(addUser(w.tenant.id, 'u@rakuten.com', w.actor));
    must(reg.updateUser({ tenantId: w.tenant.id, userId: u.id, status: 'disabled', actor: w.actor, now: now() }));
    must(reg.updateUser({ tenantId: w.tenant.id, userId: u.id, status: 'enabled', actor: w.actor, now: now() }));
    must(reg.updateUser({ tenantId: w.tenant.id, userId: u.id, access: 'viewer', actor: w.actor, now: now() }));
    must(reg.setTenantStatus(w.tenant.id, 'deactivated', SUPER, now()));
    must(reg.setTenantStatus(w.tenant.id, 'active', SUPER, now()));
    const log = reg.listAdminAudit({ kind: 'tenant', tenantId: w.tenant.id }, 100);
    expect(log.map((e) => e.action).reverse()).toEqual(['admin.created', 'storage.web_activated', 'user.created', 'user.disabled', 'user.reactivated', 'user.access_changed', 'tenant.disabled', 'tenant.reactivated']);
    const created = log.find((e) => e.action === 'user.created')!;
    expect(created).toMatchObject({ actorEmail: 'alpha@rakuten.com', actorRole: 'admin', tenantId: w.tenant.id, targetType: 'user', targetEmail: 'u@rakuten.com', meta: { access: 'editor' } });
    expect(log.find((e) => e.action === 'tenant.disabled')).toMatchObject({ actorEmail: SUPER, actorRole: 'super_admin', targetType: 'tenant', meta: { workspaceName: 'Alpha' } });
    expect(log.find((e) => e.action === 'admin.created')).toMatchObject({ actorEmail: SUPER, targetEmail: 'alpha@rakuten.com' });
  });

  it('a no-op change is not an event (disabling an already-disabled user, same access level)', () => {
    const w = webTenant('A', 'a@rakuten.com');
    const u = must(addUser(w.tenant.id, 'u@rakuten.com', w.actor));
    must(reg.updateUser({ tenantId: w.tenant.id, userId: u.id, status: 'disabled', actor: w.actor, now: now() }));
    const n = reg.listAdminAudit({ kind: 'tenant', tenantId: w.tenant.id }).length;
    must(reg.updateUser({ tenantId: w.tenant.id, userId: u.id, status: 'disabled', access: 'editor', actor: w.actor, now: now() }));
    expect(reg.listAdminAudit({ kind: 'tenant', tenantId: w.tenant.id })).toHaveLength(n);
  });

  it('is scoped: an Admin sees only their workspace; the platform view has no account-level events', () => {
    const a = webTenant('A', 'a@rakuten.com');
    const b = webTenant('B', 'b@rakuten.com');
    must(addUser(a.tenant.id, 'ua@rakuten.com', a.actor));
    must(addUser(b.tenant.id, 'ub@rakuten.com', b.actor));
    const ofA = reg.listAdminAudit({ kind: 'tenant', tenantId: a.tenant.id });
    expect(ofA.every((e) => e.tenantId === a.tenant.id)).toBe(true);
    expect(JSON.stringify(ofA)).not.toContain('ub@rakuten.com');
    expect(JSON.stringify(ofA)).not.toContain(b.tenant.id);
    const platform = reg.listAdminAudit({ kind: 'platform' });
    expect(platform.length).toBeGreaterThan(0);
    expect(platform.every((e) => !e.action.startsWith('user.'))).toBe(true);
    expect(JSON.stringify(platform)).not.toContain('ua@rakuten.com');
    expect([...PLATFORM_AUDIT_ACTIONS].some((a2) => a2.startsWith('user.'))).toBe(false);
    expect(AUDIT_ACTIONS.length).toBeGreaterThan(PLATFORM_AUDIT_ACTIONS.length);
  });

  it('is append-only: UPDATE and DELETE are refused by the database itself', () => {
    newTenant('A', 'a@rakuten.com');
    expect(() => storage.sql.exec(`UPDATE admin_audit SET actor_email = 'someone@else.co'`)).toThrow(/append-only/);
    expect(() => storage.sql.exec(`DELETE FROM admin_audit`)).toThrow(/append-only/);
    expect(rows('SELECT COUNT(*) AS n FROM admin_audit')[0].n).toBe(1);
  });

  it('keeps only short, content-free metadata', () => {
    const { tenant } = newTenant('A', 'a@rakuten.com');
    reg.appendAudit({
      at: now(),
      action: 'storage.migration_uploaded',
      actor: SUPER_ACTOR,
      tenantId: tenant.id,
      meta: { records: 3, note: 'x'.repeat(500), nested: { secret: 'tok' } as never, list: ['a'] as never, flag: true },
    });
    const entry = reg.listAdminAudit({ kind: 'tenant', tenantId: tenant.id }, 1)[0];
    expect(entry.meta).toEqual({ records: 3, note: 'x'.repeat(200), flag: true });
  });

  it('survives deleting the workspace; the deletion itself is recorded', () => {
    const w = webTenant('Doomed', 'd@rakuten.com');
    must(reg.requestDeletion({ tenantId: w.tenant.id, requestedByUserId: w.admin.id, now: now() }));
    must(reg.beginDeletion({ tenantId: w.tenant.id, approverEmail: SUPER, now: now() }));
    must(reg.finishDeletion({ tenantId: w.tenant.id, approverEmail: SUPER, requesterEmail: 'd@rakuten.com', now: now() }));
    expect(reg.getTenant(w.tenant.id)).toBeNull();
    const kept = reg.listAdminAudit({ kind: 'platform' }).map((e) => e.action);
    expect(kept).toEqual(expect.arrayContaining(['admin.created', 'tenant.deletion_requested', 'tenant.deletion_approved', 'tenant.deleted']));
    expect(reg.listAdminAudit({ kind: 'platform' }).find((e) => e.action === 'tenant.deleted')?.meta).toMatchObject({ workspaceName: 'Doomed', usersDeleted: 1 });
  });

  it('pages newest first', () => {
    const w = webTenant('A', 'a@rakuten.com');
    for (let i = 0; i < 5; i++) must(addUser(w.tenant.id, `u${i}@rakuten.com`, w.actor));
    const first = reg.listAdminAudit({ kind: 'tenant', tenantId: w.tenant.id }, 3);
    expect(first).toHaveLength(3);
    const next = reg.listAdminAudit({ kind: 'tenant', tenantId: w.tenant.id }, 3, first[2].id);
    expect(next[0].id).toBeLessThan(first[2].id);
    expect(first.map((e) => e.id)).toEqual([...first.map((e) => e.id)].sort((x, y) => y - x));
  });

  it('an audit failure undoes the change it belongs to (one transaction)', () => {
    const { tenant } = newTenant('A', 'a@rakuten.com');
    storage.failOn('INSERT INTO admin_audit');
    expect(() => reg.setTenantStatus(tenant.id, 'deactivated', SUPER, now())).toThrow();
    storage.failOn(null);
    expect(reg.getTenant(tenant.id)?.status).toBe('active');
  });
});

describe('deletion requests: reject and cancel', () => {
  it('the Super Admin can reject a request; the workspace is active again and nothing was touched', () => {
    const w = webTenant('A', 'a@rakuten.com');
    must(reg.requestDeletion({ tenantId: w.tenant.id, requestedByUserId: w.admin.id, now: now() }));
    const r = must(reg.rejectDeletion({ tenantId: w.tenant.id, actorEmail: SUPER, now: now() }));
    expect(r).toMatchObject({ status: 'active', deletion_requested_at: null, deletion_requested_by: null });
    expect(reg.listAdminAudit({ kind: 'tenant', tenantId: w.tenant.id })[0]).toMatchObject({ action: 'tenant.deletion_rejected', actorRole: 'super_admin' });
    expect(reg.rejectDeletion({ tenantId: w.tenant.id, actorEmail: SUPER, now: now() })).toEqual({ ok: false, error: 'bad_state' });
  });

  it('the requesting Admin can cancel; another tenant’s Admin cannot', () => {
    const a = webTenant('A', 'a@rakuten.com');
    const b = webTenant('B', 'b@rakuten.com');
    must(reg.requestDeletion({ tenantId: a.tenant.id, requestedByUserId: a.admin.id, now: now() }));
    expect(reg.cancelDeletion({ tenantId: a.tenant.id, requestedByUserId: b.admin.id, now: now() })).toEqual({ ok: false, error: 'forbidden_target' });
    expect(must(reg.cancelDeletion({ tenantId: a.tenant.id, requestedByUserId: a.admin.id, now: now() })).status).toBe('active');
    expect(reg.listAdminAudit({ kind: 'tenant', tenantId: a.tenant.id })[0].action).toBe('tenant.deletion_cancelled');
  });
});

describe('the Super Admin workspace list (search, filter, sort, paging)', () => {
  function seed() {
    const a = webTenant('Alpha QA', 'alice@rakuten.com'); // web
    newTenant('Beta Team', 'bob@example.com', 'Bob Builder'); // local
    const c = newTenant('Gamma 100%', 'carol@rakuten.com'); // local
    must(reg.setTenantStatus(c.tenant.id, 'deactivated', SUPER, now()));
    const d = webTenant('日本語チーム', 'dai@rakuten.com');
    must(addUser(d.tenant.id, 'x1@rakuten.com', d.actor));
    must(addUser(d.tenant.id, 'x2@rakuten.com', d.actor));
    must(reg.requestDeletion({ tenantId: a.tenant.id, requestedByUserId: a.admin.id, now: now() }));
    return { a, c, d };
  }
  const names = (q: Parameters<RegistryStore['listTenantSummaries']>[0]) => reg.listTenantSummaries(q).rows.map((r) => r.name);

  it('searches by workspace name, admin email, admin name and id (case-insensitive, literal wildcards)', () => {
    const { a } = seed();
    expect(names({ q: 'alpha' })).toEqual(['Alpha QA']);
    expect(names({ q: 'BOB@EXAMPLE' })).toEqual(['Beta Team']);
    expect(names({ q: 'builder' })).toEqual(['Beta Team']);
    expect(names({ q: a.tenant.id.slice(0, 12) })).toEqual(['Alpha QA']);
    expect(names({ q: '日本語' })).toEqual(['日本語チーム']);
    expect(names({ q: '100%' })).toEqual(['Gamma 100%']);
    expect(names({ q: '%' })).toEqual(['Gamma 100%']); // a literal percent, not "everything"
    expect(names({ q: '__' })).toEqual([]); // a literal pair of underscores (ids contain just one)
    expect(names({ q: 'no such thing' })).toEqual([]);
    expect(names({ q: "x' OR 1=1 --" })).toEqual([]);
  });

  it('filters by status (disabled is the same as the stored "deactivated") and by storage mode', () => {
    seed();
    expect(names({ status: 'active', sort: 'name' })).toEqual(['Beta Team', '日本語チーム']);
    expect(names({ status: 'disabled' })).toEqual(['Gamma 100%']);
    expect(names({ status: 'deactivated' })).toEqual(['Gamma 100%']);
    expect(names({ status: 'deletion_requested' })).toEqual(['Alpha QA']);
    expect(names({ mode: 'web', sort: 'name' })).toEqual(['Alpha QA', '日本語チーム']);
    expect(names({ mode: 'local', sort: 'name' })).toEqual(['Beta Team', 'Gamma 100%']);
    expect(names({ status: 'active', mode: 'web' })).toEqual(['日本語チーム']);
    expect(names({ status: 'all', mode: 'all' })).toHaveLength(4);
  });

  it('sorts by each allowed column in both directions, and a total survives paging', () => {
    seed();
    expect(names({ sort: 'name', dir: 'asc' })).toEqual(['Alpha QA', 'Beta Team', 'Gamma 100%', '日本語チーム']);
    expect(names({ sort: 'name', dir: 'desc' })[0]).toBe('日本語チーム');
    expect(names({ sort: 'accounts', dir: 'desc' })[0]).toBe('日本語チーム'); // 3 accounts
    expect(names({ sort: 'created', dir: 'asc' })[0]).toBe('Alpha QA');
    expect(names({ sort: 'created', dir: 'desc' })[0]).toBe('日本語チーム');
    expect(names({ sort: 'admin', dir: 'asc' })[0]).toBe('Alpha QA'); // alice@
    expect(names({ sort: 'status' })).toHaveLength(4);
    expect(names({ sort: 'activity' })).toHaveLength(4);
    const page = reg.listTenantSummaries({ sort: 'name', limit: 2, offset: 1 });
    expect(page.total).toBe(4);
    expect(page.rows.map((r) => r.name)).toEqual(['Beta Team', 'Gamma 100%']);
    expect(reg.listTenantSummaries({ limit: 10_000 }).rows).toHaveLength(4); // clamped, not an error
  });

  it('shows the admin name, account count and last activity (the newest sign-in in the workspace)', () => {
    seed();
    reg.authenticate('x1@rakuten.com', '2026-10-08T01:00:00.000Z');
    reg.authenticate('dai@rakuten.com', '2026-10-08T05:00:00.000Z');
    const d = reg.listTenantSummaries({ q: '日本語' }).rows[0];
    expect(d).toMatchObject({ adminEmail: 'dai@rakuten.com', userCount: 3, lastActivityAt: '2026-10-08T05:00:00.000Z' });
    expect(reg.listTenantSummaries({ q: 'beta' }).rows[0]).toMatchObject({ adminDisplayName: 'Bob Builder', lastActivityAt: null });
  });

  it('last activity costs no extra writes: it is the throttled sign-in time (at most one write per person per 12 hours)', () => {
    webTenant('A', 'a@rakuten.com');
    reg.authenticate('a@rakuten.com', '2026-10-08T00:00:00.000Z');
    storage.writes.count = 0;
    for (let minute = 1; minute < 60 * 11; minute += 7) reg.authenticate('a@rakuten.com', new Date(Date.parse('2026-10-08T00:00:00.000Z') + minute * 60_000).toISOString());
    expect(storage.writes.count).toBe(0);
  });
});

describe('creation defaults', () => {
  it('new Admins and Users are active at once — nothing is pending an invitation', () => {
    const w = webTenant('A', 'a@rakuten.com');
    expect(w.admin.status).toBe('active');
    expect(must(addUser(w.tenant.id, 'u@rakuten.com', w.actor)).status).toBe('active');
  });
});

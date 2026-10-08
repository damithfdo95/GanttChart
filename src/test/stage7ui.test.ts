import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, navItems } from '../app/navigation';
import { AccountBadge } from '../features/tenancy/AccountBadge';
import { ConfirmDialog, typedSatisfied } from '../components/ConfirmDialog';
import { StatusBadge } from '../features/tenancy/UsersManager';
import { StorageModeExplainer, TeamView } from '../features/tenancy/TeamScreen';
import { CONSOLE_TABS, SuperAdminConsole, overviewCounts } from '../features/tenancy/SuperAdminConsole';
import { detailsText } from '../features/tenancy/AuditLog';
import { DEFAULT_USER_VIEW, viewUsers } from '../features/tenancy/usersView';
import { WorkspaceEmptyNotice, emptyWorkspaceKind } from '../features/dashboard/WorkspaceEmptyNotice';
import { managerSummary } from '../domain/projects/managerSummary';
import { newProjectRecord, setProjectLifecycleStatus } from '../domain/projects/lifecycle';
import { normalizeQaInputs } from '../lib/storage/storage';
import { dictionaries } from '../i18n/dictionaries';
import { AUDIT_ACTIONS, type PrincipalDto, type TenantSummaryDto, type UserDto } from '../../shared/tenancy';
import type { TenancyApi } from '../lib/tenancy/api';
import type { QaInputs } from '../types';

const tenant = (mode: 'local' | 'web' = 'web') => ({ id: 'ten_x', name: 'Rakuten QA', storageMode: mode, status: 'active' as const, createdAt: 't', deletionRequestedAt: null });
const principal = (role: PrincipalDto['role'], over: Partial<PrincipalDto> = {}): PrincipalDto => ({
  email: 'taro.yamada@rakuten.com',
  userId: role === 'super_admin' ? null : 'usr_taro',
  isOwner: role === 'admin',
  displayName: null,
  role,
  tenant: role === 'super_admin' ? null : tenant(),
  access: role === 'user' ? 'editor' : null,
  workspaceRole: role === 'super_admin' ? null : 'editor',
  sharedWorkspace: role !== 'super_admin',
  ...over,
});
const fakeApi = {} as unknown as TenancyApi;
const render = (el: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(el);

describe('navigation by role', () => {
  const ids = (role: Parameters<typeof navItems>[0]) => navItems(role).map((i) => i.id);

  it('Team Members: an SV manages them, a Tester sees only their own profile there; plain local use has no accounts', () => {
    expect(ids('admin')).toContain('team');
    expect(ids('user')).toContain('team');
    expect(ids(null)).not.toContain('team');
  });

  it('everyone with a workspace gets the QA screens, History and Settings, in a sensible order', () => {
    for (const role of ['admin', null] as const) {
      const list = ids(role);
      expect(list.slice(0, 5), String(role)).toEqual(['dashboard', 'cycles', 'overall', 'gantt', 'testManagement']);
      expect(list).toEqual(expect.arrayContaining(['history', 'settings', 'reports', 'review']));
      expect(list[list.length - 1]).toBe('settings');
      expect(list).not.toContain('members'); // "RCS Members" is part of Team Members now
    }
    // A Tester gets only the screens they work with.
    expect(ids('user')).toEqual(['dashboard', 'overall', 'gantt', 'myTesting', 'tickets', 'performance', 'team']);
  });

  it('the Super Admin has NO QA navigation at all', () => {
    expect(navItems('super_admin')).toEqual([]);
  });

  it('every item is a real, translated screen (no dead entries) and ids are unique', () => {
    expect(new Set(NAV_ITEMS.map((i) => i.id)).size).toBe(NAV_ITEMS.length);
    for (const item of NAV_ITEMS) for (const lang of ['en', 'ja'] as const) expect(dictionaries[lang][item.key], `${lang} ${item.key}`).toBeTruthy();
    expect(dictionaries.en['nav.overall']).toBe('Projects / Test Executions');
  });
});

describe('who is signed in (header)', () => {
  it('shows name, email, role in words, workspace and storage mode — and no internal ids', () => {
    const html = render(createElement(AccountBadge, { lang: 'en', principal: principal('admin', { displayName: 'Taro Yamada' }) }));
    expect(html).toContain('Taro Yamada');
    expect(html).toContain('taro.yamada@rakuten.com');
    expect(html).toContain('>SV<');
    expect(html).toContain('Rakuten QA');
    expect(html).toContain('Web');
    expect(html).not.toMatch(/ten_|usr_/);
  });

  it('falls back to the email when there is no display name, and shows the role for each kind of person', () => {
    const user = render(createElement(AccountBadge, { lang: 'en', principal: principal('user') }));
    expect(user).toContain('>Tester<');
    expect(user.match(/taro\.yamada@rakuten\.com/g)?.length).toBe(2); // tooltip + name
    expect(render(createElement(AccountBadge, { lang: 'ja', principal: principal('admin') }))).toContain('>SV<');
  });
});

describe('confirmation dialog', () => {
  const base = { title: 'Delete?', body: createElement('p', null, 'Body'), confirmLabel: 'Delete it', cancelLabel: 'Cancel' };

  it('typed confirmations must match exactly (or loosely for email addresses)', () => {
    expect(typedSatisfied(undefined, [])).toBe(true);
    expect(typedSatisfied([], [])).toBe(true);
    expect(typedSatisfied([{ label: 'x', expected: 'DELETE' }], ['DELETE'])).toBe(true);
    expect(typedSatisfied([{ label: 'x', expected: 'DELETE' }], ['delete'])).toBe(false);
    expect(typedSatisfied([{ label: 'x', expected: 'DELETE' }], [' DELETE'])).toBe(false);
    expect(typedSatisfied([{ label: 'x', expected: 'DELETE' }], [])).toBe(false);
    const both = [
      { label: 'id', expected: 'ten_1' },
      { label: 'mail', expected: 'A@b.co', loose: true },
    ];
    expect(typedSatisfied(both, ['ten_1', ' a@B.CO '])).toBe(true);
    expect(typedSatisfied(both, ['ten_1', 'other@b.co'])).toBe(false);
    expect(typedSatisfied(both, ['ten_2', 'a@b.co'])).toBe(false);
  });

  it('is an accessible modal: role, labelled, described, with a visible symbol as well as colour', () => {
    const html = render(createElement(ConfirmDialog, { options: { ...base, severity: 'danger' }, onSettle: () => undefined }));
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toMatch(/aria-labelledby="[^"]+"/);
    expect(html).toMatch(/aria-describedby="[^"]+"/);
    expect(html).toContain('⛔');
    expect(html).toContain('Cancel');
    expect(html).toContain('Delete it');
    expect(render(createElement(ConfirmDialog, { options: { ...base, severity: 'warning' }, onSettle: () => undefined }))).toContain('⚠');
    expect(render(createElement(ConfirmDialog, { options: base, onSettle: () => undefined }))).toContain('role="dialog"');
  });

  it('with typed words the confirm button starts disabled', () => {
    const html = render(createElement(ConfirmDialog, { options: { ...base, severity: 'danger', typed: [{ label: 'Type DELETE', expected: 'DELETE' }] }, onSettle: () => undefined }));
    expect(html).toMatch(/<button[^>]*class="btn btn-danger"[^>]*disabled/);
    expect(html).toContain('Type DELETE');
    // Without typed words it is enabled.
    expect(render(createElement(ConfirmDialog, { options: { ...base, severity: 'warning' }, onSettle: () => undefined }))).not.toMatch(/btn-warning"[^>]*disabled/);
  });
});

describe('storage modes are explained in plain words', () => {
  it('Local: stays on this device, no collaboration, no user management, no live sync', () => {
    const html = render(createElement(StorageModeExplainer, { lang: 'en', mode: 'local' }));
    expect(html).toContain('stays on this device');
    expect(html).toContain('cannot collaborate');
    expect(html).toContain('Adding Team Members is not available');
    expect(html).toContain('no shared live sync');
  });

  it('Web: server-backed, collaboration, live sync, shared history', () => {
    const html = render(createElement(StorageModeExplainer, { lang: 'en', mode: 'web' }));
    expect(html).toContain('stored on the server');
    expect(html).toContain('work together');
    expect(html).toContain('sync live');
    expect(html).toContain('revision history is shared');
  });

  it('both are translated', () => {
    expect(render(createElement(StorageModeExplainer, { lang: 'ja', mode: 'local' }))).toContain('この端末');
  });
});

describe('Team / Users', () => {
  it('Local mode explains why there is nothing to manage — it does not show a dead form', () => {
    const html = render(createElement(TeamView, { lang: 'en', principal: principal('admin', { tenant: tenant('local') }), api: fakeApi, onOpenSettings: () => undefined }));
    expect(html).toContain('Adding Team Members is available when this workspace uses Web storage.');
    expect(html).toContain('collaboration with other people is not possible');
    expect(html).toContain('Open storage settings');
    // Local storage keeps profiles (no login exists to create): the form offers no login choice and no login-state columns.
    expect(html).not.toContain('Login account');
    expect(html).not.toContain('Create a login');
  });

  it('Web mode shows the Users manager (add form) and the administration history', () => {
    const html = render(createElement(TeamView, { lang: 'en', principal: principal('admin'), api: fakeApi, onOpenSettings: () => undefined }));
    expect(html).toContain('Add Team Member');
    expect(html).toContain('type="email"');
    expect(html).toContain('Administration history');
    expect(html).not.toContain('role-selector');
  });

  it('the management view shows nothing to a Tester (the server refuses them too); they get their own profile instead', () => {
    expect(render(createElement(TeamView, { lang: 'en', principal: principal('user'), api: fakeApi, onOpenSettings: () => undefined }))).toBe('');
  });

  it('the add form has no tenant selector and offers only the two product roles: email, name, SV or Tester, access level', () => {
    const html = render(createElement(TeamView, { lang: 'en', principal: principal('admin'), api: fakeApi, onOpenSettings: () => undefined }));
    expect((html.match(/<select/g) ?? []).length).toBe(2); // role of the new member and the status filter (the access level appears only when a Tester login is chosen)
    expect(html).toContain('value="sv"');
    expect(html).toContain('value="tester"');
    expect(html).not.toMatch(/value="(admin|user|super_admin)"/);
    expect(html).not.toMatch(/tenant/i);
    expect(html).not.toMatch(/Super Admin/);
  });
});

describe('Platform administration', () => {
  it('has the four sections, the role, and Logout; and no QA navigation', () => {
    const html = render(createElement(SuperAdminConsole, { initialLang: 'en', principal: principal('super_admin', { email: 'boss@example.org' }), api: fakeApi }));
    expect(CONSOLE_TABS).toEqual(['overview', 'workspaces', 'deletions', 'audit']);
    for (const label of ['Overview', 'Workspaces', 'Deletion requests', 'Audit log']) expect(html).toContain(label);
    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tab"/g)?.length).toBe(4);
    expect(html).toContain('Super Admin');
    expect(html).toContain('Logout');
    for (const qa of ['Gantt', 'Daily Report', 'Dashboard', 'Reports &amp; Export', 'Test Executions']) expect(html).not.toContain(qa);
  });

  it('counts workspaces for the overview', () => {
    const row = (over: Partial<TenantSummaryDto>): TenantSummaryDto => ({
      id: 'ten_1',
      name: 'A',
      storageMode: 'web',
      status: 'active',
      createdAt: 't',
      deletionRequestedAt: null,
      adminEmail: 'a@rakuten.com',
      adminDisplayName: null,
      adminStatus: 'active',
      userCount: 3,
      lastActivityAt: null,
      adminOutsideManagedDomains: false,
      ...over,
    });
    expect(overviewCounts([])).toMatchObject({ workspaces: 0, accounts: 0 });
    expect(overviewCounts([row({}), row({ status: 'deactivated', storageMode: 'local', userCount: 1 }), row({ status: 'deletion_requested', adminOutsideManagedDomains: true })])).toEqual({
      workspaces: 3,
      active: 1,
      disabled: 1,
      deletionRequested: 1,
      web: 2,
      local: 1,
      accounts: 7,
      outsideDomain: 1,
    });
  });
});

describe('status is shown in words and a symbol, never colour alone', () => {
  it('maps every state', () => {
    const html = (s: Parameters<typeof StatusBadge>[0]['status']) => render(createElement(StatusBadge, { lang: 'en', status: s }));
    expect(html('active')).toContain('Active');
    expect(html('active')).toContain('●');
    expect(html('disabled')).toContain('Disabled');
    expect(html('deactivated')).toContain('Disabled'); // the stored word for a disabled workspace
    expect(html('deletion_requested')).toContain('Deletion requested');
    expect(html('deletion_requested')).toContain('⚠');
    expect(render(createElement(StatusBadge, { lang: 'ja', status: 'disabled' }))).toContain('無効');
  });
});

describe('the user table view', () => {
  const user = (over: Partial<UserDto>): UserDto => ({
    id: 'usr_1',
    email: 'a@rakuten.com',
    displayName: null,
    role: 'user',
    isOwner: false,
    access: 'editor',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: null,
    ...over,
  });
  const people = [
    user({ id: 'usr_a', email: 'zoe@rakuten.com', displayName: 'Zoe Adams', createdAt: '2026-03-01T00:00:00.000Z', lastLoginAt: '2026-04-01T00:00:00.000Z' }),
    user({ id: 'usr_b', email: 'bob@rakuten.com', displayName: null, status: 'disabled', createdAt: '2026-02-01T00:00:00.000Z' }),
    user({ id: 'usr_c', email: 'mika@rakuten.com', displayName: '田中 美香', createdAt: '2026-01-01T00:00:00.000Z', lastLoginAt: '2026-05-01T00:00:00.000Z' }),
    user({ id: 'usr_admin', email: 'boss@rakuten.com', role: 'admin', isOwner: true, createdAt: '2025-12-01T00:00:00.000Z' }),
  ];
  const names = (v: Partial<typeof DEFAULT_USER_VIEW>) => viewUsers(people, { ...DEFAULT_USER_VIEW, ...v }).map((u) => u.id);

  it('lists SVs and Testers alike (the Owner SV included), and filters by role', () => {
    expect(names({})).toContain('usr_admin');
    expect(names({ role: 'sv' })).toEqual(['usr_admin']);
    expect(names({ role: 'tester' })).not.toContain('usr_admin');
    expect(names({ role: 'tester' })).toHaveLength(3);
  });

  it('searches name and email (case-insensitive, Japanese too) and filters by status', () => {
    expect(names({ q: 'ZOE' })).toEqual(['usr_a']);
    expect(names({ q: 'bob@' })).toEqual(['usr_b']);
    expect(names({ q: '美香' })).toEqual(['usr_c']);
    expect(names({ q: 'nobody' })).toEqual([]);
    expect(names({ status: 'disabled' })).toEqual(['usr_b']);
    expect(names({ status: 'active', sort: 'email' })).toEqual(['usr_admin', 'usr_c', 'usr_a']);
  });

  it('sorts by name, email, created, status and last activity in both directions', () => {
    expect(names({ sort: 'email' })).toEqual(['usr_b', 'usr_admin', 'usr_c', 'usr_a']);
    expect(names({ sort: 'email', dir: 'desc' })).toEqual(['usr_a', 'usr_c', 'usr_admin', 'usr_b']);
    expect(names({ sort: 'created' })).toEqual(['usr_admin', 'usr_c', 'usr_b', 'usr_a']);
    expect(names({ sort: 'activity' })[0]).toBe('usr_b'); // never signed in = oldest
    expect(names({ sort: 'activity', dir: 'desc' })[0]).toBe('usr_c');
    expect(names({ sort: 'status' })).toEqual(['usr_admin', 'usr_a', 'usr_c', 'usr_b']); // active (by name) before disabled
    expect(names({ sort: 'name' })).toHaveLength(4);
  });
});

describe('audit presentation', () => {
  it('every audit action has an English and a Japanese label', () => {
    for (const action of AUDIT_ACTIONS) for (const lang of ['en', 'ja'] as const) expect((dictionaries[lang] as Record<string, string>)[`tenancy.audit.action.${action}`], `${lang} ${action}`).toBeTruthy();
  });

  it('details are short plain text drawn from the safe metadata only', () => {
    expect(detailsText({ action: 'user.created', meta: { access: 'viewer' } }, 'en')).toBe('Read-only');
    expect(detailsText({ action: 'user.access_changed', meta: { from: 'editor', to: 'viewer' } }, 'en')).toBe('Can edit → Read-only');
    expect(detailsText({ action: 'storage.web_activated', meta: { from: 'local', to: 'web' } }, 'en')).toBe('Local → Web');
    expect(detailsText({ action: 'tenant.deleted', meta: { workspaceName: 'Doomed', usersDeleted: 3 } }, 'en')).toContain('3 account(s)');
    expect(detailsText({ action: 'storage.migration_uploaded', meta: { records: 12 } }, 'en')).toBe('12 record(s)');
    expect(detailsText({ action: 'tenant.disabled', meta: { workspaceName: 'Alpha' } }, 'ja')).toBe('Alpha');
  });
});

describe('the QA manager summary (only numbers the data already supports)', () => {
  const inputs = (over: Partial<QaInputs>): QaInputs =>
    normalizeQaInputs({
      totalCases: 100,
      currentTesters: 2,
      startTime: 9 * 60,
      targetFinish: 18 * 60,
      lunchStart: 12 * 60,
      lunchEnd: 13 * 60,
      perHourPerTester: 5,
      casesCompleted: 0,
      startDate: '2026-10-01',
      targetCompletionDate: '2026-10-30',
      targetCompletionTime: '18:00',
      planningRows: [],
      ...over,
    });
  const NOW = '2026-10-10T00:00:00.000Z';
  const project = (over: Partial<QaInputs>, status: 'todo' | 'ongoing' | 'done' | 'onHold' = 'ongoing') => newProjectRecord(inputs(over), { nameEn: 'P', status }, NOW);

  it('is empty and null-safe with no projects', () => {
    expect(managerSummary([], '2026-10-10', NOW)).toMatchObject({ activeProjects: 0, completedProjects: 0, plannedCases: 0, remainingCases: 0, progress: null, executingToday: 0 });
  });

  it('counts active, completed, overdue, executing today and case totals from the existing fields', () => {
    const list = [
      project({ totalCases: 100, casesCompleted: 40 }), // executing today
      project({ totalCases: 50, casesCompleted: 50, targetCompletionDate: '2026-10-05' }, 'ongoing'), // overdue
      project({ totalCases: 200, casesCompleted: 200 }, 'done'), // completed: not in active totals
      project({ totalCases: 80, casesCompleted: 0, startDate: '2026-11-01', targetCompletionDate: '2026-11-30' }, 'todo'), // not started
    ];
    const s = managerSummary(list, '2026-10-10', NOW);
    expect(s).toMatchObject({ activeProjects: 3, completedProjects: 1, overdue: 1, executingToday: 1, plannedCases: 230, completedCases: 90, remainingCases: 140 });
    expect(s.progress).toBeCloseTo(90 / 230);
    expect(s.needsAttention).toBeGreaterThanOrEqual(1);
  });

  it('a completed project can be reopened without double counting', () => {
    const done = setProjectLifecycleStatus(project({ totalCases: 10, casesCompleted: 10 }), 'done', NOW);
    expect(managerSummary([done], '2026-10-10', NOW)).toMatchObject({ activeProjects: 0, completedProjects: 1, plannedCases: 0 });
  });
});

describe('empty workspace', () => {
  it('says the right thing to each kind of person, and nothing when there are projects or no backend', () => {
    expect(emptyWorkspaceKind(principal('admin'), 0)).toBe('admin');
    expect(emptyWorkspaceKind(principal('user', { access: 'editor' }), 0)).toBe('editor');
    expect(emptyWorkspaceKind(principal('user', { access: 'viewer' }), 0)).toBe('viewer');
    expect(emptyWorkspaceKind(principal('admin'), 3)).toBeNull();
    expect(emptyWorkspaceKind(null, 0)).toBeNull();
    expect(emptyWorkspaceKind(principal('super_admin'), 0)).toBeNull();
  });

  it('renders in both languages and is a note, not an error', () => {
    const en = render(createElement(WorkspaceEmptyNotice, { lang: 'en', principal: principal('user', { access: 'viewer' }), projectCount: 0 }));
    expect(en).toContain('This workspace has no projects yet');
    expect(en).toContain('read-only');
    expect(en).toContain('role="note"');
    expect(render(createElement(WorkspaceEmptyNotice, { lang: 'ja', principal: principal('admin'), projectCount: 0 }))).toContain('プロジェクト');
    expect(render(createElement(WorkspaceEmptyNotice, { lang: 'en', principal: principal('admin'), projectCount: 2 }))).toBe('');
  });
});

describe('Testers (the QA-facing name of the User role)', () => {
  const en = dictionaries.en as Record<string, string>;
  const ja = dictionaries.ja as Record<string, string>;

  it('subordinate accounts are called Testers in English and Japanese; the Admin and Super Admin keep their names', () => {
    expect(en['tenancy.role.user']).toBe('Tester');
    expect(ja['tenancy.role.user']).toBe('テスター');
    expect(en['nav.team']).toBe('Team Members');
    expect(en['tenancy.role.admin']).toBe('SV');
    expect(en['tenancy.role.sv']).toBe('SV');
    expect(en['tenancy.role.tester']).toBe('Tester');
    expect(ja['tenancy.role.admin']).toBe('SV');
    expect(en['tenancy.role.super_admin']).toBe('Super Admin');
  });

  it('QA-facing administration text never calls a tester a "user" (the role value stays "user" internally)', () => {
    const keys = Object.keys(en).filter((k) => k.startsWith('tenancy.users.') || k.startsWith('team.') || k === 'nav.team' || k.startsWith('tenancy.storage.') || k.startsWith('dashboard.empty.') || k.startsWith('tenancy.audit.action.user.'));
    for (const k of keys) {
      expect(en[k], k).not.toMatch(/users?/i);
      expect(ja[k], k).not.toContain('ユーザー');
    }
  });

  it('the add form explains the flow: organization email, optional name, signs in later with that address, no code, no password, no selector', () => {
    const html = render(createElement(TeamView, { lang: 'en', principal: principal('admin'), api: fakeApi, onOpenSettings: () => undefined }));
    expect(html).toContain('Add Team Member');
    expect(html).toContain('Display name');
    expect(html).toContain('there is no invitation code, password or workspace chooser');
    expect(html).toContain('there is no workspace selection');
    expect(html).not.toMatch(/<select[^>]*tenant/i);
  });

  it('a Tester sees the role "Tester" in the header', () => {
    expect(render(createElement(AccountBadge, { lang: 'en', principal: principal('user') }))).toContain('>Tester<');
    expect(render(createElement(AccountBadge, { lang: 'ja', principal: principal('user') }))).toContain('テスター');
  });
});

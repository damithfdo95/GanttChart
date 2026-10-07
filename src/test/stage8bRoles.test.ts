import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, navItems } from '../app/navigation';
import { SCREEN_ACCESS, accessTo, ownMemberOf, uiRoleOf, type ScreenId } from '../app/access';
import { memberCounts, memberRows, nameSuggestions, ownershipCandidates, rosterOnly } from '../domain/teamMembers';
import { upsertRcsMember } from '../domain/members';
import { TOOL_NAME_MAX, cleanToolName, toolNameOf } from '../domain/branding';
import { applyActiveProjectSyncRestricted } from '../domain/projects/migrations';
import { MyProfile } from '../features/tenancy/TeamScreen';
import { TicketTable } from '../features/tickets/TicketTable';
import { DEFAULT_HISTORY_PAGE_SIZE, HISTORY_PAGE_SIZES, pageUrl, toPage } from '../lib/history/pagination';
import { actionLabel, detailsText } from '../features/tenancy/AuditLog';
import { dictionaries } from '../i18n/dictionaries';
import { DEMO_STATE, normalizeQaInputs } from '../lib/storage/storage';
import { newProjectRecord } from '../domain/projects/lifecycle';
import type { PrincipalDto, UserDto } from '../../shared/tenancy';
import type { BugTicket, ProjectRecord, QaInputs, RcsMember, TesterProjectAssignment } from '../types';

const render = (el: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(el);
const en = dictionaries.en as Record<string, string>;
const ja = dictionaries.ja as Record<string, string>;

describe('the role and screen matrix (one table for the navigation and the screens)', () => {
  it('names the two QA roles SV and Tester and maps them onto the internal roles', () => {
    expect(uiRoleOf('admin')).toBe('sv');
    expect(uiRoleOf('user')).toBe('tester');
    expect(uiRoleOf('super_admin')).toBeNull();
    expect(uiRoleOf(null)).toBeNull();
  });

  it('every navigation item has a row in the matrix, and every row is a navigation item', () => {
    expect(Object.keys(SCREEN_ACCESS).sort()).toEqual(NAV_ITEMS.map((i) => i.id).sort());
  });

  it('an SV manages every screen', () => {
    for (const screen of Object.keys(SCREEN_ACCESS) as ScreenId[]) expect(accessTo('admin', screen), screen).toBe('manage');
  });

  it('a Tester: inputs only on Dashboard (Today’s Execution), Tickets and Performance; reads Overall and Gantt; has their own profile; nothing else', () => {
    const expected: Record<ScreenId, string> = {
      dashboard: 'input',
      overall: 'view',
      gantt: 'view',
      tickets: 'input',
      performance: 'input',
      team: 'view',
      cycles: 'none',
      dailyReport: 'none',
      review: 'none',
      reports: 'none',
      history: 'none',
      settings: 'none',
    };
    for (const [screen, access] of Object.entries(expected)) expect(accessTo('user', screen as ScreenId), screen).toBe(access);
  });

  it('the Super Admin has no QA screen at all', () => {
    for (const screen of Object.keys(SCREEN_ACCESS) as ScreenId[]) expect(accessTo('super_admin', screen)).toBe('none');
    expect(navItems('super_admin')).toEqual([]);
  });

  it('plain local use (no accounts) keeps every screen except Team Members', () => {
    for (const screen of Object.keys(SCREEN_ACCESS) as ScreenId[]) expect(accessTo(null, screen), screen).toBe(screen === 'team' ? 'none' : 'manage');
  });

  it('navigation for a Tester offers no History, Settings, Cycles, Daily Report, Review or Reports, and no member management', () => {
    const ids = navItems('user').map((i) => i.id);
    expect(ids).toEqual(['dashboard', 'overall', 'gantt', 'tickets', 'performance', 'team']);
    for (const hidden of ['history', 'settings', 'cycles', 'dailyReport', 'review', 'reports']) expect(ids).not.toContain(hidden);
  });

  it('navigation for an SV lists Team Members before History and Settings last; "RCS Members" is gone', () => {
    const ids = navItems('admin').map((i) => i.id);
    expect(ids.indexOf('team')).toBeLessThan(ids.indexOf('history'));
    expect(ids[ids.length - 1]).toBe('settings');
    expect(ids).not.toContain('members');
    expect(en['nav.team']).toBe('Team Members');
    expect(ja['nav.team']).toBe('チームメンバー');
  });
});

describe('role words (EN and JA)', () => {
  it('QA-facing text says SV and Tester; "Admin" and "administrator" survive only for the Super Admin and the platform', () => {
    for (const [lang, dict] of [['en', en], ['ja', ja]] as const) {
      for (const [key, value] of Object.entries(dict)) {
        if (lang === 'en') {
          const rest = value.replace(/Super Admin/g, '').replace(/platform administrator/g, '');
          expect(rest, key).not.toMatch(/\b(Admins?|admins?|administrators?)\b/);
        } else {
          const rest = value.replace(/スーパー管理者/g, '').replace(/プラットフォーム管理者/g, '');
          expect(rest, key).not.toContain('管理者');
        }
      }
    }
  });

  it('the role labels', () => {
    expect([en['tenancy.role.sv'], en['tenancy.role.tester'], en['tenancy.role.admin'], en['tenancy.role.user']]).toEqual(['SV', 'Tester', 'SV', 'Tester']);
    expect([ja['tenancy.role.sv'], ja['tenancy.role.tester'], ja['tenancy.role.admin'], ja['tenancy.role.user']]).toEqual(['SV', 'テスター', 'SV', 'テスター']);
  });

  it('the new screens and actions exist in both languages with the same placeholders', () => {
    const keys = Object.keys(en).filter((k) => /^(team\.|tenancy\.owner\.|tenancy\.members\.|settings\.dataBackup\.|shared\.history\.|tenancy\.error\.)/.test(k));
    expect(keys.length).toBeGreaterThan(30);
    const holes = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const k of keys) {
      expect(ja[k], k).toBeTruthy();
      expect(holes(ja[k]), k).toEqual(holes(en[k]));
    }
    for (const code of ['owner_protected', 'invalid_role', 'confirmation_required', 'user_not_found', 'member_not_found', 'member_already_linked', 'account_already_linked']) {
      expect(en[`tenancy.error.${code}`], code).toBeTruthy();
      expect(ja[`tenancy.error.${code}`], code).toBeTruthy();
    }
  });
});

describe('Team Members: accounts and their profiles', () => {
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
  const member = (over: Partial<RcsMember>): RcsMember => ({ id: 'USER0001', name: 'Hana Sato', team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true, ...over });
  const users = [user({ id: 'usr_owner', email: 'owner@rakuten.com', role: 'admin', isOwner: true, displayName: 'Owner One' }), user({ id: 'usr_hana', email: 'hana@rakuten.com', displayName: 'Hana Sato' }), user({ id: 'usr_ken', email: 'ken@rakuten.com', status: 'disabled' })];
  const roster = [member({ id: 'USER0001', userId: 'usr_hana' }), member({ id: 'USER0002', name: 'hana  sato' }), member({ id: 'USER0003', name: 'Someone Else' })];

  it('links an account to its profile by the account id only', () => {
    const rows = memberRows(users, roster);
    expect(rows.map((r) => [r.user.id, r.profile?.id ?? null])).toEqual([['usr_owner', null], ['usr_hana', 'USER0001'], ['usr_ken', null]]);
  });

  it('roster-only members are the ones with no account', () => {
    expect(rosterOnly(roster).map((m) => m.id)).toEqual(['USER0002', 'USER0003']);
  });

  it('a name match is only a SUGGESTION (exact after normalising case and spaces), never a link; an email never matches', () => {
    const hanaNoProfile = user({ id: 'usr_h2', email: 'someone@rakuten.com', displayName: 'Hana Sato' });
    expect(nameSuggestions(hanaNoProfile, rosterOnly(roster)).map((m) => m.id)).toEqual(['USER0002']);
    expect(nameSuggestions(user({ displayName: null, email: 'hana.sato@rakuten.com' }), rosterOnly(roster))).toEqual([]);
    expect(nameSuggestions(user({ displayName: 'Hana' }), rosterOnly(roster))).toEqual([]);
    expect(memberRows([hanaNoProfile], roster)[0].profile).toBeNull(); // still not linked
  });

  it('ownership can go to another enabled SV only', () => {
    const more = [...users, user({ id: 'usr_sv2', email: 'sv2@rakuten.com', role: 'admin' }), user({ id: 'usr_sv3', email: 'sv3@rakuten.com', role: 'admin', status: 'disabled' })];
    expect(ownershipCandidates(more).map((u) => u.id)).toEqual(['usr_sv2']);
  });

  it('counts', () => {
    expect(memberCounts(users)).toEqual({ svs: 1, testers: 2, disabled: 1 });
  });

  it('editing a profile can never drop or change its account link', () => {
    const list = [member({ userId: 'usr_hana' })];
    const edited = upsertRcsMember(list, member({ name: 'Hana S.' })); // an edit form that does not carry userId
    expect(edited[0]).toMatchObject({ name: 'Hana S.', userId: 'usr_hana' });
    expect(upsertRcsMember(list, member({ userId: 'usr_other' }))[0].userId).toBe('usr_hana');
    expect(upsertRcsMember([member({})], member({ name: 'X' }))[0].userId).toBeUndefined();
  });

  it('finds a Tester’s own profile by their account id, and by nothing else', () => {
    expect(ownMemberOf(roster, 'usr_hana')?.id).toBe('USER0001');
    expect(ownMemberOf(roster, 'usr_nobody')).toBeNull();
    expect(ownMemberOf(roster, null)).toBeNull();
  });
});

describe('My Team Member Profile (what a Tester sees on Team Members)', () => {
  const principal: PrincipalDto = {
    email: 'hana@rakuten.com',
    userId: 'usr_hana',
    displayName: 'Hana Sato',
    role: 'user',
    isOwner: false,
    tenant: { id: 'ten_x', name: 'Rakuten QA', storageMode: 'web', status: 'active', createdAt: 't', deletionRequestedAt: null },
    access: 'editor',
    workspaceRole: 'editor',
    sharedWorkspace: true,
  };
  const members: RcsMember[] = [
    { id: 'USER0001', name: 'Hana Sato', team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true, userId: 'usr_hana' },
    { id: 'USER0002', name: 'Secret Colleague', team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true, userId: 'usr_ken' },
  ];
  const inputs = normalizeQaInputs({ ...(DEMO_STATE as QaInputs), totalCases: 10 });
  const project = (id: string, stable: string, nameEn: string): ProjectRecord => ({ ...newProjectRecord(inputs, { nameEn, status: 'ongoing' }, '2026-10-07T00:00:00.000Z', []), id, projectId: stable });
  const assign = (id: string, userId: string, projectId: string, extra: Partial<TesterProjectAssignment> = {}): TesterProjectAssignment => ({ id, projectId, userId, testerName: 'x', startDate: '2026-10-01', active: true, ...extra });

  it('shows their own name, email, role, status, workspace and profile — and nobody else', () => {
    const html = render(createElement(MyProfile, { lang: 'en', principal, members, projects: [], assignments: [] }));
    expect(html).toContain('My Team Member Profile');
    for (const s of ['Hana Sato', 'hana@rakuten.com', 'Tester', 'Active', 'Rakuten QA', 'USER0001']) expect(html).toContain(s);
    expect(html).not.toContain('Secret Colleague');
    expect(html).not.toContain('USER0002');
    expect(html).not.toContain('type="email"'); // nothing to edit, nothing to add
    expect(html).not.toContain('Add Member');
  });

  it('lists only the test executions THEY are assigned to', () => {
    const html = render(
      createElement(MyProfile, {
        lang: 'en',
        principal,
        members,
        projects: [project('p1', 'PRJ-001', 'Android Sanity'), project('p2', 'PRJ-002', 'iOS Regression')],
        assignments: [assign('a1', 'usr_hana', 'PRJ-001'), assign('a2', 'usr_ken', 'PRJ-002'), assign('a3', 'usr_hana', 'PRJ-003', { active: false })],
      }),
    );
    expect(html).toContain('Android Sanity');
    expect(html).not.toContain('iOS Regression');
    expect(html).not.toContain('PRJ-003');
  });

  it('says so when the account has no profile yet', () => {
    expect(render(createElement(MyProfile, { lang: 'en', principal, members: [], projects: [], assignments: [] }))).toContain('not linked to a Team Member profile');
  });

  it('renders in Japanese', () => {
    const html = render(createElement(MyProfile, { lang: 'ja', principal, members, projects: [], assignments: [] }));
    expect(html).toContain('マイ・チームメンバープロフィール');
    expect(html).toContain('テスター');
    expect(html).toContain('hana@rakuten.com'); // emails are never translated
  });
});

describe('Tickets: a Tester changes only their own', () => {
  const ticket = (id: string, owner: string): BugTicket => ({ id, projectId: 'PRJ-001', title: `Bug ${id}`, url: 'https://jira.example.com/browse/X-1', createdAt: '2026-10-07', reportedBy: owner, reporterMemberId: owner === 'Hana' ? 'USER0001' : 'USER0002' });
  const tickets = [ticket('t1', 'Hana'), ticket('t2', 'Ken')];

  it('everyone sees every ticket; the Edit/Delete buttons appear only on the ones the person may change', () => {
    const html = render(createElement(TicketTable, { lang: 'en', tickets, members: [], onEdit: () => undefined, onDelete: () => undefined, canChange: (t) => t.reporterMemberId === 'USER0001' }));
    expect(html).toContain('Bug t1');
    expect(html).toContain('Bug t2');
    expect((html.match(/>Edit ticket</g) ?? []).length + (html.match(/Edit/g) ?? []).length).toBeGreaterThan(0);
    const all = render(createElement(TicketTable, { lang: 'en', tickets, members: [], onEdit: () => undefined, onDelete: () => undefined }));
    expect((all.match(/btn-danger/g) ?? []).length).toBe(2);
    expect((html.match(/btn-danger/g) ?? []).length).toBe(1);
  });
});

describe('a Tester’s changes to a project are limited to what a Tester may change', () => {
  const NOW = '2026-10-07T09:00:00.000Z';
  const base = normalizeQaInputs({ ...(DEMO_STATE as QaInputs), totalCases: 100 });
  const record = (): ProjectRecord => ({ ...newProjectRecord(base, { nameEn: 'Android Sanity', status: 'ongoing' }, NOW, []), id: 'p1', projectId: 'PRJ-001' });
  const entry = { id: 'e1', date: '2026-10-07', startTime: null, endTime: null, overtimeMinutes: 0, intervalEnabled: true, testers: 2, pass: 5, fail: 1, notApplicable: 0, spo: 0, blocked: 0, retest: 0, questioned: 0, note: '' };

  it('keeps the plan, name and everything else exactly as stored, and takes only today’s execution, tickets and performance', () => {
    const p = record();
    const editing = { ...p.inputs, totalCases: 5, currentTesters: 99, dailyExecuted: [entry], casesCompleted: 6, casesPassed: 5, bugTickets: [{ id: 't', projectId: 'PRJ-001', title: 'x', url: 'https://x.example', createdAt: '2026-10-07', reportedBy: 'H' }] };
    const out = applyActiveProjectSyncRestricted([p], 'p1', editing, '2026-10-07T10:00:00.000Z');
    expect(out[0].inputs.totalCases).toBe(100);
    expect(out[0].inputs.currentTesters).toBe(base.currentTesters);
    expect(out[0].inputs.dailyExecuted).toEqual([entry]);
    expect(out[0].inputs.casesCompleted).toBe(6);
    expect(out[0].inputs.bugTickets).toHaveLength(1);
    expect(out[0].nameEn).toBe('Android Sanity');
    expect(out[0].updatedAt).toBe('2026-10-07T10:00:00.000Z');
  });

  it('is a no-op (same array) when only things a Tester may not change differ, e.g. after opening a project', () => {
    const p = record();
    const projects = [p];
    expect(applyActiveProjectSyncRestricted(projects, 'p1', { ...p.inputs, totalCases: 5, startDate: '2020-01-01' }, NOW)).toBe(projects);
  });

  it('touches only the active project', () => {
    const a = record();
    const b = { ...record(), id: 'p2', projectId: 'PRJ-002' };
    const out = applyActiveProjectSyncRestricted([a, b], 'p2', { ...b.inputs, dailyExecuted: [entry] }, NOW);
    expect(out[0]).toBe(a);
    expect(out[1].inputs.dailyExecuted).toEqual([entry]);
  });
});

describe('History paging', () => {
  const rows = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ revision: from - i }));

  it('25 rows by default, 25 or 50 allowed', () => {
    expect(DEFAULT_HISTORY_PAGE_SIZE).toBe(25);
    expect([...HISTORY_PAGE_SIZES]).toEqual([25, 50]);
  });

  it('asks the server for one row more than it shows, and from the cursor onward', () => {
    expect(pageUrl(25, undefined)).toBe('/api/revisions?limit=26');
    expect(pageUrl(50, 120)).toBe('/api/revisions?limit=51&before=120');
  });

  it('shows the page, knows whether an older one exists, and reports the range', () => {
    const full = toPage(rows(100, 26), 25);
    expect(full).toMatchObject({ hasMore: true, newest: 100, oldest: 76 });
    expect(full.rows).toHaveLength(25);
    const last = toPage(rows(10, 7), 25);
    expect(last).toMatchObject({ hasMore: false, newest: 10, oldest: 4 });
    expect(toPage([], 25)).toMatchObject({ rows: [], hasMore: false, newest: null, oldest: null });
    expect(toPage(rows(30, 25), 25).hasMore).toBe(false); // exactly a page: nothing older
  });

  it('walking the pages by cursor visits every revision once', () => {
    const all = rows(60, 60).map((r) => r.revision);
    const server = (limit: number, before: number | undefined) => all.filter((r) => before === undefined || r < before).slice(0, limit).map((revision) => ({ revision }));
    const seen: number[] = [];
    let before: number | undefined;
    for (;;) {
      const page = toPage(server(26, before), 25);
      seen.push(...page.rows.map((r) => r.revision));
      if (!page.hasMore || page.oldest === null) break;
      before = page.oldest;
    }
    expect(seen).toEqual(all);
  });
});

describe('audit labels for members and ownership', () => {
  it('say which kind of member was created, and who got the ownership', () => {
    expect(actionLabel({ action: 'user.created', meta: { memberRole: 'sv' } }, 'en')).toBe('SV created');
    expect(actionLabel({ action: 'user.created', meta: { memberRole: 'tester' } }, 'en')).toBe('Tester created');
    expect(actionLabel({ action: 'user.created', meta: {} }, 'ja')).toBe('テスターを作成');
    expect(actionLabel({ action: 'owner.transferred', meta: {} }, 'en')).toBe('Ownership transferred');
    expect(detailsText({ action: 'owner.transferred', meta: { from: 'a@rakuten.com', to: 'b@rakuten.com' } }, 'en')).toBe('a@rakuten.com → b@rakuten.com');
    expect(detailsText({ action: 'user.created', meta: { memberRole: 'sv', access: 'editor' } }, 'en')).toBe('SV');
  });
});

describe('Workspace Appearance: the tool name', () => {
  it('cleans plain text and refuses markup, control characters and long names', () => {
    expect(cleanToolName('  Rakuten   QA Board ')).toBe('Rakuten QA Board');
    expect(cleanToolName('ＱＡ Board')).toBe('QA Board'); // full-width letters are normalised
    for (const bad of ['', '   ', 'x'.repeat(TOOL_NAME_MAX + 1), '<b>x</b>', 'a\u0000b', 'a\u0007b', 5, null, undefined]) expect(cleanToolName(bad), String(bad)).toBeNull();
    expect(cleanToolName('x'.repeat(TOOL_NAME_MAX))).toHaveLength(TOOL_NAME_MAX);
  });

  it('shows the workspace’s own name, or the platform name when none is set or it is not valid', () => {
    expect(toolNameOf({ toolName: 'QA Board' }, 'en')).toBe('QA Board');
    expect(toolNameOf({}, 'en')).toBe(en['app.title']);
    expect(toolNameOf(undefined, 'ja')).toBe(ja['app.title']);
    expect(toolNameOf({ toolName: '<script>' }, 'en')).toBe(en['app.title']);
  });
});

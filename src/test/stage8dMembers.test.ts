import { describe, expect, it } from 'vitest';
import { memberCommitError, memberRoleOf } from '../../shared/members';
import { assigneeLabel } from '../domain/people';
import { scopeAssignees } from '../domain/testManagement';
import {
  directoryRows,
  emailTaken,
  intendedRoleOf,
  isActiveMember,
  isLinked,
  memberState,
  normalizeMemberEmail,
  optionLabel,
  personOptionText,
  personOptions,
  selectableMembers,
} from '../domain/teamMembers';
import type { UserDto } from '../../shared/tenancy';
import type { RcsMember, TesterProjectAssignment, TestScope } from '../types';

const TODAY = '2026-10-08';
const m = (id: string, name: string, over: Partial<RcsMember> = {}): RcsMember => ({ id, name, team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true, ...over });

const roster: RcsMember[] = [
  m('USER0001', 'Linked Tester', { userId: 'usr_a', email: 'a@x.com' }),
  m('USER0002', 'Unlinked Tester', { email: 'b@x.com' }),
  m('USER0003', 'Removed Tester', { active: false, endDate: '2026-09-30' }),
  m('USER0004', 'An SV', { role: 'SV' }),
  m('USER0005', 'Old Role', { role: 'Test Engineer' }),
  m('USER0006', 'Ended Yesterday', { endDate: '2026-10-07' }),
  m('USER0007', 'tester seven', { role: 'tester' }),
];

describe('who appears in a dropdown', () => {
  it('every ACTIVE Tester appears, whether or not they have a login', () => {
    const names = selectableMembers(roster, { role: 'tester', today: TODAY }).map((x) => x.name);
    expect(names).toEqual(['Linked Tester', 'tester seven', 'Unlinked Tester']);
  });

  it('removed members and members whose end date has passed never appear in a new pick', () => {
    const names = selectableMembers(roster, { today: TODAY }).map((x) => x.name);
    expect(names).not.toContain('Removed Tester');
    expect(names).not.toContain('Ended Yesterday');
    expect(names).toContain('An SV');
  });

  it('a role-specific pick offers only that role; an older free-text role is never guessed to be either', () => {
    expect(selectableMembers(roster, { role: 'sv', today: TODAY }).map((x) => x.name)).toEqual(['An SV']);
    expect(selectableMembers(roster, { role: 'tester', today: TODAY }).map((x) => x.name)).not.toContain('Old Role');
    expect(intendedRoleOf(roster[4])).toBeNull();
    expect(memberRoleOf('Tester')).toBe('tester');
    expect(memberRoleOf(' sv ')).toBe('sv');
    expect(memberRoleOf('Test Engineer')).toBeNull();
  });

  it('a record being edited keeps its removed person selectable (so it stays displayable)', () => {
    const names = selectableMembers(roster, { role: 'tester', today: TODAY, keep: ['USER0003'] }).map((x) => x.name);
    expect(names).toContain('Removed Tester');
  });

  it('active means: not removed and not past its end date (an open or future end date is active)', () => {
    expect(isActiveMember(roster[0], TODAY)).toBe(true);
    expect(isActiveMember(roster[2], TODAY)).toBe(false);
    expect(isActiveMember(roster[5], TODAY)).toBe(false);
    expect(isActiveMember(m('x', 'x', { endDate: TODAY }), TODAY)).toBe(true);
    expect(memberState(roster[2], TODAY)).toBe('removed');
  });
});

describe('what the dropdown shows', () => {
  it('the value is the stable id and the label is a name: never an id, whatever the data holds', () => {
    const opts = personOptions('en', selectableMembers(roster, { role: 'tester', today: TODAY }), TODAY);
    for (const o of opts) {
      expect(o.label).not.toMatch(/USER\d+|usr_|mem_/);
      expect(o.memberId).toMatch(/^USER\d+$/);
    }
    // a profile named after its own id falls back to its email, then to "Former member"
    expect(optionLabel('en', { name: 'USER0009', email: 'z@x.com' })).toBe('z@x.com');
    expect(optionLabel('en', { name: 'usr_1234567890', email: undefined })).toBe('Former member');
    expect(optionLabel('ja', { name: 'USER0009' })).not.toContain('USER');
  });

  it('says in words whether a login exists, without exposing ids', () => {
    const [linked, unlinked] = personOptions('en', [roster[0], roster[1]], TODAY);
    expect(personOptionText('en', linked)).toBe('Linked Tester');
    expect(personOptionText('en', unlinked)).toBe('Unlinked Tester (no login yet)');
    expect(personOptionText('ja', unlinked)).toContain('ログイン未作成');
    expect(isLinked(roster[0])).toBe(true);
    expect(isLinked(roster[1])).toBe(false);
  });

  it('an assignee is named by account or by profile; neither shows an id', () => {
    const dir = { members: roster };
    expect(assigneeLabel('en', { userId: 'usr_a' }, dir)).toBe('Linked Tester');
    expect(assigneeLabel('en', { memberId: 'USER0002' }, dir)).toBe('Unlinked Tester');
    expect(assigneeLabel('en', { memberId: 'USER4242' }, dir)).toBe('Former member');
    expect(assigneeLabel('en', { userId: 'usr_unknown' }, dir)).toBe('Former member');
  });
});

describe('the directory table', () => {
  const user = (id: string, over: Partial<UserDto> = {}): UserDto => ({ id, email: `${id}@x.com`, displayName: null, role: 'user', isOwner: false, access: 'editor', status: 'active', createdAt: '', updatedAt: '', lastLoginAt: null, ...over });

  it('lists profiles with their linked account, then accounts that have no profile', () => {
    const rows = directoryRows(roster.slice(0, 2), [user('usr_a'), user('usr_orphan')]);
    expect(rows.map((r) => [r.member?.id ?? null, r.user?.id ?? null, r.orphanAccount])).toEqual([
      ['USER0001', 'usr_a', false],
      ['USER0002', null, false],
      [null, 'usr_orphan', true],
    ]);
  });

  it('without a list of accounts (Local storage) every profile simply has no account', () => {
    expect(directoryRows(roster.slice(0, 2), null).every((r) => r.user === null && !r.orphanAccount)).toBe(true);
  });
});

describe('emails', () => {
  it('are normalised the same way as the server does and compared exactly', () => {
    expect(normalizeMemberEmail('  Tanaka@Rakuten.COM ')).toBe('tanaka@rakuten.com');
    expect(normalizeMemberEmail('nope')).toBeNull();
    expect(emailTaken(roster, 'b@x.com')).toBe(true);
    expect(emailTaken(roster, 'b@x.com', 'USER0002')).toBe(false);
    expect(emailTaken(roster, 'c@x.com')).toBe(false);
  });
});

describe('the shared profile rules', () => {
  const view = (records: Record<string, object>, list: Array<{ id: string; json: string }> = []) => ({
    get: (_k: string, id: string) => (records[id] === undefined ? null : JSON.stringify(records[id])),
    list: () => list,
  });
  const put = (o: { id: string } & Record<string, unknown>) => ({ kind: 'member', id: o.id, json: JSON.stringify(o) });
  const base = { id: 'USER0001', name: 'A', team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true };

  it('rejects a duplicate email, in the store or inside the same commit, and an un-normalised one', () => {
    const existing = { ...base, id: 'USER0002', email: 'a@x.com' };
    const v = view({ USER0002: existing }, [{ id: 'USER0002', json: JSON.stringify(existing) }]);
    expect(memberCommitError({ puts: [put({ ...base, email: 'a@x.com' })], deletes: [], view: v })).toBe('member_email_taken');
    expect(memberCommitError({ puts: [put({ ...base, email: 'b@x.com' }), put({ ...base, id: 'USER0003', email: 'b@x.com' })], deletes: [], view: v })).toBe('member_email_taken');
    expect(memberCommitError({ puts: [put({ ...base, email: 'A@X.COM' })], deletes: [], view: v })).toBe('member_invalid_email');
    expect(memberCommitError({ puts: [put({ ...base, email: 'fresh@x.com' })], deletes: [], view: v })).toBeNull();
  });

  it('the same display name is not a conflict', () => {
    const existing = { ...base, id: 'USER0002', email: 'a@x.com' };
    const v = view({ USER0002: existing }, [{ id: 'USER0002', json: JSON.stringify(existing) }]);
    expect(memberCommitError({ puts: [put({ ...base, name: existing.name, email: 'other@x.com' })], deletes: [], view: v })).toBeNull();
  });

  it('a linked profile\'s email, role and active state are the account\'s, and it is never deleted', () => {
    const linked = { ...base, userId: 'usr_a', email: 'a@x.com' };
    const v = view({ USER0001: linked });
    expect(memberCommitError({ puts: [put({ ...linked, email: 'z@x.com' })], deletes: [], view: v })).toBe('member_email_locked');
    expect(memberCommitError({ puts: [put({ ...linked, role: 'SV' })], deletes: [], view: v })).toBe('member_role_requires_api');
    expect(memberCommitError({ puts: [put({ ...linked, active: false })], deletes: [], view: v })).toBe('member_status_requires_api');
    expect(memberCommitError({ puts: [], deletes: [{ kind: 'member', id: 'USER0001' }], view: v })).toBe('member_linked_cannot_delete');
    expect(memberCommitError({ puts: [put({ ...linked, name: 'Renamed', endDate: '2026-12-31' })], deletes: [], view: v })).toBeNull();
  });

  it('an unlinked profile can be edited and deleted freely', () => {
    const v = view({ USER0001: base });
    expect(memberCommitError({ puts: [put({ ...base, role: 'SV', active: false, email: 'n@x.com' })], deletes: [], view: v })).toBeNull();
    expect(memberCommitError({ puts: [], deletes: [{ kind: 'member', id: 'USER0001' }], view: v })).toBeNull();
  });
});

describe('scope assignees include people without a login', () => {
  const scope: TestScope = { id: 'scp_a', projectId: 'PRJ-001', name: 'A', status: 'active', order: 1, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' };
  const a = (over: Partial<TesterProjectAssignment>): TesterProjectAssignment => ({ id: 'a', projectId: 'PRJ-001', startDate: '2026-10-01', active: true, ...over });

  it('lists an account and a profile-only assignee once each; a project-level assignment covers the scope; ended or other-scope ones do not', () => {
    const list = [
      a({ id: '1', userId: 'usr_a', memberId: 'USER0001', scopeId: 'scp_a' }),
      a({ id: '2', memberId: 'USER0002' }),
      a({ id: '3', memberId: 'USER0003', scopeId: 'scp_other' }),
      a({ id: '4', memberId: 'USER0004', endDate: '2026-10-07' }),
      a({ id: '5', memberId: 'USER0005', active: false }),
      a({ id: '6', memberId: 'USER0002', scopeId: 'scp_a' }),
    ];
    expect(scopeAssignees(scope, list, TODAY).map((x) => x.key).sort()).toEqual(['m:USER0002', 'u:usr_a']);
  });
});

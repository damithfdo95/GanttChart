import { describe, expect, it } from 'vitest';
import { qaCommitError } from '../../shared/qaRules';
import { SV_ONLY_KINDS } from '../../shared/testerRules';
import { RECORD_KINDS } from '../../shared/protocol';
import { AUDIT_ACTIONS, PLATFORM_AUDIT_ACTIONS } from '../../shared/tenancy';
import { accountRoleOf, memberRoleOf, memberRoleWord } from '../../shared/members';
import { dailyPlanId } from '../../shared/meeting';

/** Stage 8D rules that live in the shared commit checks, exercised without any runtime. */

const J = JSON.stringify;
const world = (records: Record<string, object>, lists: Record<string, Array<{ id: string; json: string }>> = {}) => ({
  get: (kind: string, id: string) => (records[`${kind}:${id}`] === undefined ? null : J(records[`${kind}:${id}`])),
  list: (kind: string) => lists[kind] ?? [],
});
const project = (over: Record<string, unknown> = {}) => ({ id: 'proj-1', projectId: 'PRJ-001', nameEn: 'P', status: 'ongoing', inputs: { totalCases: 10 }, ...over });
const run = (role: 'admin' | 'editor', puts: Array<{ kind: string; id: string; json: string }>, view = world({})) =>
  qaCommitError({ role, puts, deletes: [], view, userId: 'usr_x', today: '2026-10-08' });

describe('the project owner is a Team Member of this workspace', () => {
  const members = world({ 'member:USER0001': { id: 'USER0001', name: 'A' }, 'project:proj-1': project() });
  it('accepts an owner that exists; refuses an unknown or malformed one; an unchanged owner is not re-checked', () => {
    expect(run('admin', [{ kind: 'project', id: 'proj-1', json: J(project({ ownerMemberId: 'USER0001' })) }], members)).toBeNull();
    expect(run('admin', [{ kind: 'project', id: 'proj-1', json: J(project({ ownerMemberId: 'USER9999' })) }], members)).toBe('project_owner_not_found');
    expect(run('admin', [{ kind: 'project', id: 'proj-1', json: J(project({ ownerMemberId: 'bad id!' })) }], members)).toBe('project_invalid_owner');
    expect(run('admin', [{ kind: 'project', id: 'proj-1', json: J(project({ ownerMemberId: 7 })) }], members)).toBe('project_invalid_owner');
    const already = world({ 'project:proj-1': project({ ownerMemberId: 'USER0777' }) });
    expect(run('admin', [{ kind: 'project', id: 'proj-1', json: J(project({ ownerMemberId: 'USER0777', nameEn: 'Renamed' })) }], already)).toBeNull();
  });

  it('a member created in the same commit counts', () => {
    expect(run('admin', [{ kind: 'member', id: 'USER0002', json: J({ id: 'USER0002', name: 'B' }) }, { kind: 'project', id: 'proj-1', json: J(project({ ownerMemberId: 'USER0002' })) }], world({ 'project:proj-1': project() }))).toBeNull();
  });
});

describe('older projects keep their typed owner', () => {
  it('a project with only the old free-text owner is accepted and unchanged; the typed owner is not a reference', () => {
    const legacy = project({ owner: 'Somebody Typed' });
    expect(run('admin', [{ kind: 'project', id: 'proj-1', json: J(legacy) }], world({ 'project:proj-1': project() }))).toBeNull();
    expect(run('admin', [{ kind: 'project', id: 'proj-1', json: J({ ...legacy, nameEn: 'Renamed' }) }], world({ 'project:proj-1': legacy }))).toBeNull();
  });
});

describe('the new kinds and words', () => {
  it('plans and notes are SV-only kinds (a Tester never receives them) and real record kinds', () => {
    for (const k of ['dailyPlan', 'meetingNote']) {
      expect(SV_ONLY_KINDS.has(k)).toBe(true);
      expect((RECORD_KINDS as readonly string[]).includes(k)).toBe(true);
    }
  });

  it('a plan commit by a non-SV is refused at the very first rule', () => {
    expect(run('editor', [{ kind: 'dailyPlan', id: dailyPlanId('2026-10-08', 'PRJ-001'), json: '{}' }])).toBe('tester_cannot_change_kind');
  });

  it('member audit actions exist for the workspace\'s Owner/SVs and are hidden from the platform trail', () => {
    for (const a of ['member.created', 'member.updated', 'member.role_changed', 'member.removed', 'member.reactivated', 'member.account_linked'] as const) {
      expect(AUDIT_ACTIONS).toContain(a);
      expect(PLATFORM_AUDIT_ACTIONS).not.toContain(a);
    }
  });

  it('roles: SV <-> admin, Tester <-> user; older free-text roles are neither', () => {
    expect(memberRoleOf('SV')).toBe('sv');
    expect(memberRoleOf('Tester')).toBe('tester');
    expect(memberRoleOf('QA Lead')).toBeNull();
    expect(accountRoleOf('sv')).toBe('admin');
    expect(accountRoleOf('tester')).toBe('user');
    expect(memberRoleWord('sv')).toBe('SV');
  });
});

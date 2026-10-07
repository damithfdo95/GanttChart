import { describe, expect, it } from 'vitest';
import { authorizedScopeIds, filterForTester, testerMaySee } from '../../shared/testManagementAccess';

/** What a Tester may read of Test Management, as pure functions. */

const NOW = '2026-10-07T09:00:00.000Z';
const TODAY = '2026-10-07';
const J = JSON.stringify;
const scope = (id: string, projectId: string, status = 'active') => J({ id, projectId, name: id, status, order: 10, createdAt: NOW, updatedAt: NOW });
const asg = (over: Record<string, unknown>) => J({ id: 'a', projectId: 'PRJ-001', userId: 'usr_a', startDate: '2026-10-01', active: true, ...over });

const scopes = [scope('s1', 'PRJ-001'), scope('s2', 'PRJ-001'), scope('s3', 'PRJ-002'), scope('s4', 'PRJ-001', 'archived')];
const auth = (assignments: string[], user = 'usr_a') => authorizedScopeIds(assignments, scopes, user, TODAY);

describe('which scopes an account may read', () => {
  it('a scope-level assignment: that scope only', () => {
    expect([...auth([asg({ scopeId: 's1' })])]).toEqual(['s1']);
  });

  it('a project-level assignment (no scope, as before Stage 8C): every ACTIVE scope of that project, nothing of another project', () => {
    expect([...auth([asg({})])].sort()).toEqual(['s1', 's2']);
  });

  it('no assignment, someone else\'s, ended, inactive, not yet started, or a name-only assignment: nothing', () => {
    expect(auth([]).size).toBe(0);
    expect(auth([asg({ userId: 'usr_b' })]).size).toBe(0);
    expect(auth([asg({ endDate: '2026-10-06' })]).size).toBe(0);
    expect(auth([asg({ active: false })]).size).toBe(0);
    expect(auth([asg({ startDate: '2026-10-08' })]).size).toBe(0);
    expect(auth([J({ id: 'a', projectId: 'PRJ-001', memberId: 'USER0001', startDate: '2026-10-01', active: true })]).size).toBe(0);
  });

  it('an archived scope is never offered, even to its own assignee', () => {
    expect(auth([asg({ scopeId: 's4' })]).size).toBe(0);
  });

  it('several assignments add up', () => {
    expect([...auth([asg({ scopeId: 's1' }), asg({ id: 'b', projectId: 'PRJ-002' })])].sort()).toEqual(['s1', 's3']);
  });
});

describe('what a Tester receives', () => {
  const allowed = new Set(['s1']);
  const item = (kind: string, id: string, v?: unknown) => ({ kind, id, ...(v === undefined ? {} : { json: J(v) }) });

  it('the scope, its ACTIVE cases and its results; nothing of other scopes', () => {
    expect(testerMaySee(item('scope', 's1', { id: 's1' }), allowed)).toBe(true);
    expect(testerMaySee(item('scope', 's2', { id: 's2' }), allowed)).toBe(false);
    expect(testerMaySee(item('testCase', 'c1', { scopeId: 's1', status: 'active' }), allowed)).toBe(true);
    expect(testerMaySee(item('testCase', 'c1', { scopeId: 's1', status: 'archived' }), allowed)).toBe(false);
    expect(testerMaySee(item('testCase', 'c2', { scopeId: 's2', status: 'active' }), allowed)).toBe(false);
    expect(testerMaySee(item('caseResult', 'r1', { scopeId: 's1' }), allowed)).toBe(true);
    expect(testerMaySee(item('caseResult', 'r2', { scopeId: 's2' }), allowed)).toBe(false);
  });

  it('refuses what it cannot read, and everything when nothing is authorised', () => {
    expect(testerMaySee({ kind: 'scope', id: 's1', json: 'nope' }, allowed)).toBe(false);
    expect(testerMaySee(item('testCase', 'c1', { status: 'active' }), allowed)).toBe(false);
    expect(testerMaySee(item('testCase', 'c1', { scopeId: 's1', status: 'active' }), new Set())).toBe(false);
  });

  it('other kinds are not affected; a deletion names only an opaque id', () => {
    expect(testerMaySee(item('project', 'p', { id: 'p' }), allowed)).toBe(true);
    expect(testerMaySee(item('settings', 'settings', {}), allowed)).toBe(true);
    expect(testerMaySee({ kind: 'scope', id: 's9' }, allowed)).toBe(true);
  });

  it('a Tester receives only their OWN account assignments (they name scopes and people); name-based ones are unchanged', () => {
    expect(testerMaySee(item('assignment', 'a', { userId: 'usr_a', scopeId: 's1' }), allowed, 'usr_a')).toBe(true);
    expect(testerMaySee(item('assignment', 'a', { userId: 'usr_b', scopeId: 's2' }), allowed, 'usr_a')).toBe(false);
    expect(testerMaySee(item('assignment', 'a', { memberId: 'USER0001' }), allowed, 'usr_a')).toBe(true);
    expect(testerMaySee(item('assignment', 'a', { userId: 'usr_a' }), allowed, undefined)).toBe(false);
  });

  it('filters a list', () => {
    const list = [item('scope', 's1', { id: 's1' }), item('scope', 's2', { id: 's2' }), item('project', 'p', {})];
    expect(filterForTester(list, allowed).map((x) => x.id)).toEqual(['s1', 'p']);
  });
});

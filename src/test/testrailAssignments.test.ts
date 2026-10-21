import { describe, expect, it } from 'vitest';
import { planTestRailAssignments } from '../domain/testManagement/testrailAssignments';
import type { TestRailTestRow, TestRailUser } from '../../shared/testrail';
import type { ExternalIdentity, RcsMember, TesterProjectAssignment } from '../types';

const TODAY = '2026-10-21';
const P = 'PRJ-001';

const user = (id: number, name: string, email?: string): TestRailUser => ({ id, name, ...(email === undefined ? {} : { email }) });
const member = (id: string, name: string, email?: string, over: Partial<RcsMember> = {}): RcsMember =>
  ({ id, name, team: 'RCS', role: 'Tester', startDate: '2026-01-01', active: true, ...(email === undefined ? {} : { email }), ...over } as RcsMember);
const test = (testId: number, assignedToId: number | null): TestRailTestRow => ({ testId, assignedToId, statusId: 3 });

const users = [user(1, 'Suzuki', 'suzuki@example.com'), user(2, 'Tanaka', 'tanaka@example.com'), user(3, 'No Email User')];
const members = [member('m1', 'Suzuki Ichiro', 'suzuki@example.com'), member('m2', 'Tanaka Jiro', 'tanaka@example.com')];

describe('planTestRailAssignments', () => {
  it('creates one assignment per matched member per scope', () => {
    const testsByRunId = new Map<number, TestRailTestRow[]>([
      [9001, [test(1, 1), test(2, 1), test(3, 2)]],
      [9002, [test(4, 2)]],
    ]);
    const scopeIds = new Map<number, string>([[9001, 'scp_a'], [9002, 'scp_b']]);
    const plan = planTestRailAssignments(testsByRunId, users, members, P, scopeIds, [], TODAY);
    expect(plan.assignments).toHaveLength(3); // Suzuki@9001, Tanaka@9001, Tanaka@9002
    expect(plan.unmatched).toEqual([]); // user 3 has no tests in these runs — never reported
    const suzuki = plan.assignments.find((a) => a.memberId === 'm1');
    expect(suzuki).toMatchObject({ projectId: P, scopeId: 'scp_a', startDate: TODAY, active: true, testerName: 'Suzuki Ichiro' });
  });

  it('matches by email case-insensitively (the linkTestRailMembers rule)', () => {
    const mixed = [user(9, 'UPPER', 'Suzuki@Example.COM')];
    const testsByRunId = new Map<number, TestRailTestRow[]>([[9001, [test(1, 9)]]]);
    const plan = planTestRailAssignments(testsByRunId, mixed, members, P, new Map([[9001, 'scp_a']]), [], TODAY);
    expect(plan.assignments[0]?.memberId).toBe('m1');
  });

  it('reports unmatched TestRail users with their test counts, never guesses', () => {
    const testsByRunId = new Map<number, TestRailTestRow[]>([[9001, [test(1, 3), test(2, 3), test(3, 99)]]]);
    const plan = planTestRailAssignments(testsByRunId, users, members, P, new Map([[9001, 'scp_a']]), [], TODAY);
    expect(plan.assignments).toHaveLength(0);
    expect(plan.unmatched).toEqual([
      { testrailUserId: 3, name: 'No Email User', tests: 2 },
      { testrailUserId: 99, name: 'User #99', tests: 1 }, // unknown user id → stable fallback label
    ]);
  });

  it('skips a member already assigned to the scope (re-import never duplicates)', () => {
    const existing: TesterProjectAssignment[] = [
      { id: 'asg1', projectId: P, memberId: 'm1', testerName: 'Suzuki Ichiro', scopeId: 'scp_a', startDate: '2026-10-01', active: true },
    ];
    const testsByRunId = new Map<number, TestRailTestRow[]>([[9001, [test(1, 1)]]]);
    const plan = planTestRailAssignments(testsByRunId, users, members, P, new Map([[9001, 'scp_a']]), existing, TODAY);
    expect(plan.assignments).toHaveLength(0);
  });

  it('keeps a member already assigned to ANOTHER scope (only the exact pair is a duplicate)', () => {
    const existing: TesterProjectAssignment[] = [
      { id: 'asg1', projectId: P, memberId: 'm1', testerName: 'Suzuki Ichiro', scopeId: 'scp_other', startDate: '2026-10-01', active: true },
    ];
    const testsByRunId = new Map<number, TestRailTestRow[]>([[9001, [test(1, 1)]]]);
    const plan = planTestRailAssignments(testsByRunId, users, members, P, new Map([[9001, 'scp_a']]), existing, TODAY);
    expect(plan.assignments).toHaveLength(1);
  });

  it('ignores inactive members and unassigned tests', () => {
    const inactive = [member('m9', 'Gone', 'gone@example.com', { active: false, endDate: '2026-09-01' })];
    const testsByRunId = new Map<number, TestRailTestRow[]>([[9001, [test(1, 5), test(2, null)]]]);
    const plan = planTestRailAssignments(testsByRunId, [user(5, 'Gone', 'gone@example.com')], inactive, P, new Map([[9001, 'scp_a']]), [], TODAY);
    expect(plan.assignments).toHaveLength(0);
    expect(plan.unmatched).toEqual([{ testrailUserId: 5, name: 'Gone', tests: 1 }]); // reported, not silently dropped
  });

  it('ignores runs whose scope id is unknown (defensive)', () => {
    const testsByRunId = new Map<number, TestRailTestRow[]>([[9001, [test(1, 1)]]]);
    const plan = planTestRailAssignments(testsByRunId, users, members, P, new Map(), [], TODAY);
    expect(plan.assignments).toHaveLength(0);
    expect(plan.unmatched).toHaveLength(0);
  });

  it('resolves by an ACTIVE testrail external identity before email (the JIRA reporter rule)', () => {
    // User 3 has no email, but the SV linked TestRail id 3 → m2 explicitly.
    const identities: ExternalIdentity[] = [
      { id: 'EI1', provider: 'testrail', externalId: '3', memberId: 'm2', displayName: 'No Email User', active: true, linkedAt: '2026-10-01T00:00:00Z' },
    ];
    const testsByRunId = new Map<number, TestRailTestRow[]>([[9001, [test(1, 3)]]]);
    const plan = planTestRailAssignments(testsByRunId, users, members, P, new Map([[9001, 'scp_a']]), [], TODAY, identities);
    expect(plan.unmatched).toEqual([]);
    expect(plan.assignments[0]).toMatchObject({ memberId: 'm2', testerName: 'Tanaka Jiro', scopeId: 'scp_a' });
  });

  it('an explicit identity link overrides a matching email', () => {
    // Suzuki's TestRail id (1) is linked to m2 — the SV's link wins even
    // though his email matches m1.
    const identities: ExternalIdentity[] = [
      { id: 'EI1', provider: 'testrail', externalId: '1', memberId: 'm2', displayName: 'Suzuki', active: true, linkedAt: '2026-10-01T00:00:00Z' },
    ];
    const testsByRunId = new Map<number, TestRailTestRow[]>([[9001, [test(1, 1)]]]);
    const plan = planTestRailAssignments(testsByRunId, users, members, P, new Map([[9001, 'scp_a']]), [], TODAY, identities);
    expect(plan.assignments[0]).toMatchObject({ memberId: 'm2' });
  });

  it('ignores retired testrail identities and other providers', () => {
    const identities: ExternalIdentity[] = [
      { id: 'EI1', provider: 'testrail', externalId: '3', memberId: 'm2', displayName: 'No Email User', active: false, linkedAt: '2026-10-01T00:00:00Z' },
      { id: 'EI2', provider: 'jira', externalId: '3', memberId: 'm1', displayName: 'No Email User', active: true, linkedAt: '2026-10-01T00:00:00Z' },
    ];
    const testsByRunId = new Map<number, TestRailTestRow[]>([[9001, [test(1, 3)]]]);
    const plan = planTestRailAssignments(testsByRunId, users, members, P, new Map([[9001, 'scp_a']]), [], TODAY, identities);
    expect(plan.assignments).toHaveLength(0);
    expect(plan.unmatched).toEqual([{ testrailUserId: 3, name: 'No Email User', tests: 1 }]);
  });
});

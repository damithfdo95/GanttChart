import { describe, expect, it } from 'vitest';
import type {
  AttendanceRecord,
  BugTicket,
  ProjectRecord,
  QaInputs,
  RcsMember,
  TesterDailyPerformance,
  TesterProjectAssignment,
  TesterReview,
} from '../types';
import { normalizeQaInputs } from '../lib/storage/storage';
import { newProjectRecord } from '../domain/projects/lifecycle';
import {
  collectIdentityIssues,
  hasMemberReferences,
  manualResolutionKeepUnresolved,
  manualResolutionTo,
  memberReferenceScope,
  resolveAttendanceRecord,
  resolveBugTicket,
} from '../domain/identityResolution';

/**
 * V6.9-A §40 — the underlying actions of the Identity Resolution Center:
 * resolving unmatched records, resolving ambiguous records, keeping records
 * unresolved, repeated resolution (idempotency), manual-resolution
 * preservation and stable identity. These are pure domain functions — the
 * UI calls them through the existing reports-state actions.
 */

function member(overrides: Partial<RcsMember> = {}): RcsMember {
  return {
    id: 'USER0003',
    name: 'Yamauchi K.',
    team: 'RCS',
    role: 'Tester',
    startDate: '2026-07-01',
    active: true,
    ...overrides,
  };
}

function attendance(overrides: Partial<AttendanceRecord> = {}): AttendanceRecord {
  return {
    id: 'att-1',
    date: '2026-09-10',
    memberName: 'Yamauchi Kentaro',
    team: 'RCS',
    status: 'PRESENT',
    workingStart: null,
    workingEnd: null,
    leaveType: null,
    comment: '',
    ...overrides,
  };
}

function ticket(overrides: Partial<BugTicket> = {}): BugTicket {
  return {
    id: 't1',
    projectId: 'PRJ-001',
    title: 'Login fails',
    url: 'https://jira.example.com/browse/ABC-100',
    createdAt: '2026-09-10',
    reportedBy: 'Yamauchi Kentaro',
    ...overrides,
  };
}

function baseInputs(): QaInputs {
  return normalizeQaInputs({
    totalCases: 100,
    currentTesters: 2,
    startTime: 9 * 60,
    targetFinish: 18 * 60,
    lunchStart: 0,
    lunchEnd: 0,
    perHourPerTester: 4,
    casesCompleted: 0,
    startDate: '2026-09-01',
    targetCompletionDate: '2026-09-30',
    targetCompletionTime: '18:00',
    planningRows: [{ id: 'row-1', date: '2026-09-01', plannedTesters: 2, absentTesters: 0, nonWorkingDay: false, note: '' }],
  });
}

function project(tickets: readonly BugTicket[] = [], performance: readonly TesterDailyPerformance[] = []): ProjectRecord {
  const record = newProjectRecord(baseInputs(), { nameEn: 'Project A' }, '2026-09-01T00:00:00.000Z', []);
  return {
    ...record,
    projectId: 'PRJ-001',
    inputs: { ...record.inputs, bugTickets: [...tickets], testerDailyPerformance: [...performance] },
  };
}

const AMBIGUOUS_MEMBERS = [
  member({ nameHistory: [{ name: 'Yamauchi Kentaro' }] }),
  member({ id: 'USER0012', name: 'Yamauchi Kentaro', team: 'Other Team', role: 'Tester' }),
];

describe('V6.9-A manual resolution actions (attendance)', () => {
  it('resolves an ambiguous record to the explicitly chosen member with an audit trail', () => {
    const resolved = resolveAttendanceRecord(attendance(), 'USER0012', '2026-09-30T01:02:03.000Z');
    expect(resolved.memberId).toBe('USER0012');
    expect(resolved.memberName).toBe('Yamauchi Kentaro'); // historical truth preserved
    expect(resolved.identityResolution).toEqual({ method: 'manual', memberId: 'USER0012', resolvedAt: '2026-09-30T01:02:03.000Z' });
  });

  it('keeps a record unresolved on explicit decision (it never reappears as actionable)', () => {
    const kept = resolveAttendanceRecord(attendance(), undefined, '2026-09-30T00:00:00.000Z');
    expect(kept.memberId).toBeUndefined();
    expect(kept.identityResolution).toEqual({ method: 'manual', resolvedAt: '2026-09-30T00:00:00.000Z' });
    const issues = collectIdentityIssues([kept], [], AMBIGUOUS_MEMBERS);
    expect(issues.attendance).toHaveLength(0);
    expect(issues.resolvedAttendance).toHaveLength(1);
  });

  it('is idempotent: a second resolution never changes the first decision', () => {
    const first = resolveAttendanceRecord(attendance(), 'USER0003', '2026-09-30T00:00:00.000Z');
    const second = resolveAttendanceRecord(first, 'USER0012', '2026-10-01T00:00:00.000Z');
    expect(second).toEqual(first); // untouched — manual decisions are final
  });

  it('provides the audit builders', () => {
    expect(manualResolutionTo('USER0003', 't0')).toEqual({ method: 'manual', memberId: 'USER0003', resolvedAt: 't0' });
    expect(manualResolutionKeepUnresolved('t1')).toEqual({ method: 'manual', resolvedAt: 't1' });
  });
});

describe('V6.9-A manual resolution actions (tickets)', () => {
  it('resolves an ambiguous reporter to the chosen member; the decision survives re-resolution', () => {
    const resolved = resolveBugTicket(ticket(), 'USER0003', '2026-09-30T00:00:00.000Z');
    expect(resolved.reporterMemberId).toBe('USER0003');
    expect(resolved.reportedBy).toBe('Yamauchi Kentaro');
    const again = resolveBugTicket(resolved, 'USER0012', '2026-10-01T00:00:00.000Z');
    expect(again).toEqual(resolved); // first manual decision is final
  });

  it('keeps an unresolved ticket on explicit decision and it stops being actionable', () => {
    const kept = resolveBugTicket(ticket(), undefined, '2026-09-30T00:00:00.000Z');
    const issues = collectIdentityIssues([], [project([kept])], AMBIGUOUS_MEMBERS);
    expect(issues.tickets).toHaveLength(0);
    expect(issues.resolvedTickets).toHaveLength(1);
    expect(issues.resolvedTickets[0].audit.memberId).toBeUndefined();
  });
});

describe('V6.9-A issue collection categories', () => {
  it('shows unmatched, ambiguous and resolved categories; resolved-by-id records are not actionable', () => {
    const issues = collectIdentityIssues(
      [
        attendance({ id: 'a1', memberName: 'Nobody' }), // unmatched
        attendance({ id: 'a2' }), // ambiguous
        attendance({ id: 'a3', memberId: 'USER0003' }), // resolved — not actionable
        attendance({ id: 'a4', memberName: 'Already Decided', identityResolution: manualResolutionKeepUnresolved('t') }),
      ],
      [
        project([
          ticket({ id: 't1', reportedBy: 'Nobody' }),
          ticket({ id: 't2' }),
          ticket({ id: 't3', reporterMemberId: 'USER0003' }),
        ]),
      ],
      AMBIGUOUS_MEMBERS,
    );
    expect(issues.attendance.map((i) => [i.recordId, i.kind])).toEqual([
      ['a1', 'unmatched'],
      ['a2', 'ambiguous'],
    ]);
    expect(issues.tickets.map((i) => [i.ticketId, i.kind])).toEqual([
      ['t1', 'unmatched'],
      ['t2', 'ambiguous'],
    ]);
    expect(issues.resolvedAttendance.map((r) => r.recordId)).toEqual(['a4']);
    // Ambiguous candidates carry full member context for the UI.
    const ambiguous = issues.attendance.find((i) => i.recordId === 'a2')!;
    expect(ambiguous.candidates).toHaveLength(2);
    expect(ambiguous.candidates[0]).toMatchObject({ memberId: 'USER0003', name: 'Yamauchi K.', team: 'RCS', role: 'Tester', active: true });
  });

  it('returns nothing to do when all identities are resolved', () => {
    const issues = collectIdentityIssues(
      [attendance({ memberId: 'USER0003' })],
      [project([ticket({ reporterMemberId: 'USER0003' })])],
      AMBIGUOUS_MEMBERS,
    );
    expect(issues.attendance).toHaveLength(0);
    expect(issues.tickets).toHaveLength(0);
    expect(issues.resolvedAttendance).toHaveLength(0);
    expect(issues.resolvedTickets).toHaveLength(0);
  });
});

describe('V6.9-A member reference detection (delete guard)', () => {
  const baseScope = {
    attendance: [] as AttendanceRecord[],
    assignments: [] as TesterProjectAssignment[],
    tickets: [] as BugTicket[],
    performance: [] as TesterDailyPerformance[],
    reviews: [] as TesterReview[],
  };

  it('detects references from every identity-bearing record type', () => {
    expect(hasMemberReferences('USER0003', { ...baseScope, attendance: [attendance({ memberId: 'USER0003' })] })).toBe(true);
    expect(
      hasMemberReferences('USER0003', {
        ...baseScope,
        assignments: [{ id: 'a', projectId: 'PRJ-001', memberId: 'USER0003', startDate: '2026-07-01', active: true }],
      }),
    ).toBe(true);
    expect(hasMemberReferences('USER0003', { ...baseScope, tickets: [ticket({ reporterMemberId: 'USER0003' })] })).toBe(true);
    expect(
      hasMemberReferences('USER0003', {
        ...baseScope,
        performance: [{ id: 'r1', date: '2026-09-10', testerName: 'X', memberId: 'USER0003', projectId: 'PRJ-001', casesTested: 1 }],
      }),
    ).toBe(true);
    expect(
      hasMemberReferences('USER0003', {
        ...baseScope,
        reviews: [
          {
            id: 'rev-1',
            testerName: 'X',
            memberId: 'USER0003',
            periodType: 'month',
            periodStart: '2026-09-01',
            periodEnd: '2026-09-30',
            status: 'draft',
            createdAt: 't',
            updatedAt: 't',
          },
        ],
      }),
    ).toBe(true);
    expect(hasMemberReferences('USER9999', baseScope)).toBe(false);
  });

  it('builds the workspace-wide reference scope from the reports state view', () => {
    const scope = memberReferenceScope({
      attendance: [attendance({ memberId: 'USER0003' })],
      testerAssignments: [],
      projects: [project([ticket({ reporterMemberId: 'USER0003' })], [
        { id: 'r1', date: '2026-09-10', testerName: 'X', memberId: 'USER0003', projectId: 'PRJ-001', casesTested: 1 },
      ])],
      reviews: [],
    });
    expect(hasMemberReferences('USER0003', scope)).toBe(true);
    expect(hasMemberReferences('USER0004', scope)).toBe(false);
  });
});

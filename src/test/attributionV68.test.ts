import { describe, expect, it } from 'vitest';
import type { ProjectRecord, QaInputs, TesterDailyPerformance } from '../types';
import { newProjectRecord } from '../domain/projects/lifecycle';
import { normalizeQaInputs } from '../lib/storage/storage';
import { seedRcsMembers } from '../domain/members';
import {
  applyTesterPerformanceSync,
  buildTesterPerformanceSyncPlan,
  getAssignedTestersForDate,
  suggestAttendanceAwareAllocation,
} from '../lib/calculations/testerAttribution';
import { validateAllocation } from '../lib/validation/validateMember';

/**
 * V6.8 — Attribution 2.0: memberId-based sync records, attendance-aware
 * suggestions, custom allocation validation, unassigned remainders and
 * idempotency under member identity. Provenance (V6.7 sources) is preserved.
 */

const NOW = '2026-09-30T00:00:00.000Z';

function baseInputs(): QaInputs {
  return normalizeQaInputs({
    totalCases: 500,
    currentTesters: 3,
    startTime: 9 * 60,
    targetFinish: 18 * 60,
    lunchStart: 12 * 60,
    lunchEnd: 13 * 60,
    perHourPerTester: 4,
    casesCompleted: 0,
    startDate: '2026-09-28',
    targetCompletionDate: '2026-09-30',
    targetCompletionTime: '18:00',
    planningRows: [
      { id: 'row-1', date: '2026-09-28', plannedTesters: 3, absentTesters: 0, nonWorkingDay: false, note: '' },
    ],
  });
}

function project(
  projectId: string,
  overrides: Partial<Pick<QaInputs, 'dailyActuals' | 'testerDailyPerformance'>> = {},
  existing: readonly ProjectRecord[] = [],
): ProjectRecord {
  const record = newProjectRecord({ ...baseInputs(), ...overrides }, { nameEn: `Project ${projectId}` }, NOW, existing);
  return { ...record, projectId };
}

function memberAssignment(memberId: string, startDate = '2026-09-01') {
  const members = seedRcsMembers();
  const member = members.find((m) => m.id === memberId)!;
  return {
    id: 'asg-' + memberId,
    projectId: 'PRJ-001',
    memberId,
    testerName: member.name,
    team: member.team,
    startDate,
    active: true,
  };
}

describe('V6.8 member-identity sync', () => {
  const members = seedRcsMembers();

  it('creates records carrying the stable memberId and the member display name', () => {
    const prj = project('PRJ-001', {
      dailyActuals: [{ id: 's1', date: '2026-09-28', executed: 120, passed: 120, casesPassed: 120 }],
    });
    const assignments = [memberAssignment('USER0003'), memberAssignment('USER0004')];
    const plan = buildTesterPerformanceSyncPlan([prj], assignments, members);
    expect(plan.toCreate).toBe(2);
    for (const item of plan.items) {
      expect(['USER0003', 'USER0004']).toContain(item.record.memberId);
      expect(item.record.testerName).toBe(members.find((m) => m.id === item.record.memberId)!.name);
      expect(item.record.casesTested).toBe(60);
      expect(item.record.source).toBe('assisted');
    }
  });

  it('shares one slot between a legacy name record and its memberId successor (no duplicates)', () => {
    // V6.7 assisted record without memberId, but the name uniquely matches USER0003.
    const legacyAssisted: TesterDailyPerformance = {
      id: 'legacy-1',
      date: '2026-09-28',
      testerName: 'Yamauchi Kentaro',
      projectId: 'PRJ-001',
      casesTested: 60,
      source: 'assisted',
    };
    const prj = project('PRJ-001', {
      dailyActuals: [{ id: 's1', date: '2026-09-28', executed: 120, passed: 120, casesPassed: 120 }],
      testerDailyPerformance: [legacyAssisted, { id: 'other', date: '2026-09-28', testerName: 'Kobayashi Masashi', projectId: 'PRJ-001', casesTested: 60, source: 'assisted' }],
    });
    const assignments = [memberAssignment('USER0003'), memberAssignment('USER0004')];
    const plan = buildTesterPerformanceSyncPlan([prj], assignments, members);
    // Both V6.7 records resolve to their members and are UPDATED in place (adding memberId), not duplicated.
    expect(plan.toCreate).toBe(0);
    expect(plan.toUpdate).toBe(2);
    const records = applyTesterPerformanceSync(prj.inputs.testerDailyPerformance ?? [], plan.items, members);
    expect(records).toHaveLength(2);
    const yamauchi = records.find((r) => r.memberId === 'USER0003')!;
    expect(yamauchi.id).toBe('legacy-1'); // stable id preserved
    expect(yamauchi.memberId).toBe('USER0003');
    // Idempotent second run: everything unchanged now.
    const plan2 = buildTesterPerformanceSyncPlan([{ ...prj, inputs: { ...prj.inputs, testerDailyPerformance: records } }], assignments, members);
    expect(plan2.toUpdate).toBe(0);
    expect(plan2.unchanged).toBe(2);
  });

  it('never overwrites manual overrides, even with member identity', () => {
    const overridden: TesterDailyPerformance = {
      id: 'ovr-1',
      date: '2026-09-28',
      testerName: 'Yamauchi Kentaro',
      memberId: 'USER0003',
      projectId: 'PRJ-001',
      casesTested: 42,
      source: 'manualOverride',
    };
    const prj = project('PRJ-001', {
      dailyActuals: [{ id: 's1', date: '2026-09-28', executed: 120, passed: 120, casesPassed: 120 }],
      testerDailyPerformance: [overridden],
    });
    const assignments = [memberAssignment('USER0003')];
    const plan = buildTesterPerformanceSyncPlan([prj], assignments, members);
    expect(plan.manualPreserved).toBe(1);
    expect(plan.toCreate).toBe(0);
    expect(plan.toUpdate).toBe(0);
    const records = applyTesterPerformanceSync([overridden], plan.items, members);
    expect(records[0].casesTested).toBe(42);
    expect(records[0].source).toBe('manualOverride');
  });

  it('is idempotent under member identity: repeated syncs produce the same records', () => {
    const prj = project('PRJ-001', {
      dailyActuals: [
        { id: 's1', date: '2026-09-28', executed: 30, passed: 30, casesPassed: 30 },
        { id: 's2', date: '2026-09-29', executed: 65, passed: 60, casesPassed: 60, casesFailed: 5 },
      ],
    });
    const assignments = [memberAssignment('USER0003'), memberAssignment('USER0004'), memberAssignment('USER0005')];
    let current: TesterDailyPerformance[] = [];
    for (let run = 0; run < 3; run += 1) {
      const working = { ...prj, inputs: { ...prj.inputs, testerDailyPerformance: current } };
      const plan = buildTesterPerformanceSyncPlan([working], assignments, members);
      current = applyTesterPerformanceSync(current, plan.items, members);
      expect(current).toHaveLength(6); // 3 testers × 2 days — every run
    }
    expect(current.every((r) => r.memberId !== undefined)).toBe(true);
    expect(current.filter((r) => r.date === '2026-09-29').reduce((s, r) => s + r.casesTested, 0)).toBe(35);
  });

  it('renamed members keep one identity: aggregation joins memberId and legacy name records', async () => {
    const { aggregateTesterPerformance } = await import('../lib/calculations/testerPerformance');
    const members = seedRcsMembers();
    const records: TesterDailyPerformance[] = [
      { id: 'r1', date: '2026-09-10', testerName: 'Yamauchi Kentaro', projectId: 'PRJ-001', casesTested: 40 }, // legacy name, no id
      { id: 'r2', date: '2026-09-11', testerName: 'Yamauchi Kentaro', memberId: 'USER0003', projectId: 'PRJ-001', casesTested: 35 }, // id + name
    ];
    // While the member's name still matches, identity joins both records into one row.
    const rows = aggregateTesterPerformance(records, [], { members });
    expect(rows).toHaveLength(1);
    expect(rows[0].memberId).toBe('USER0003');
    expect(rows[0].casesTested).toBe(75);

    // After a rename, records carrying the memberId follow the new display
    // name; legacy records with the old name stay honestly separate (name
    // history is not invented — a known, documented limitation).
    const renamed = members.map((m) => (m.id === 'USER0003' ? { ...m, name: 'Yamauchi K.' } : m));
    const renamedRows = aggregateTesterPerformance(records, [], { members: renamed });
    expect(renamedRows).toHaveLength(2);
    const memberRow = renamedRows.find((r) => r.memberId === 'USER0003')!;
    expect(memberRow.testerName).toBe('Yamauchi K.');
    expect(memberRow.casesTested).toBe(35);
    expect(renamedRows.find((r) => r.testerName === 'Yamauchi Kentaro')!.casesTested).toBe(40);

    // Without the master (legacy callers), the records stay name-keyed as before.
    const legacyRows = aggregateTesterPerformance(records, []);
    expect(legacyRows).toHaveLength(2);
  });
});

describe('V6.8 attendance-aware allocation suggestion (§20)', () => {
  const assigned = [
    { key: 'USER0003', memberId: 'USER0003', testerName: 'Yamauchi Kentaro', attendance: 'PRESENT' as const },
    { key: 'USER0004', memberId: 'USER0004', testerName: 'Kobayashi Masashi', attendance: 'PRESENT' as const },
    { key: 'USER0005', memberId: 'USER0005', testerName: 'Osaki Kazuki', attendance: 'ABSENT' as const },
  ];

  it('suggests splitting only among attending testers', () => {
    const suggestion = suggestAttendanceAwareAllocation(30, assigned);
    expect(suggestion.basis).toBe('attendance');
    expect(suggestion.attendingKeys).toEqual(['USER0003', 'USER0004']);
    expect(suggestion.excludedKeys).toEqual(['USER0005']);
    expect(suggestion.allocations).toEqual([
      { key: 'USER0003', memberId: 'USER0003', testerName: 'Yamauchi Kentaro', cases: 15 },
      { key: 'USER0004', memberId: 'USER0004', testerName: 'Kobayashi Masashi', cases: 15 },
    ]);
  });

  it('handles remainder deterministically among attending testers', () => {
    const two = [assigned[0], assigned[1]];
    const suggestion = suggestAttendanceAwareAllocation(31, two);
    expect(suggestion.allocations.map((a) => a.cases)).toEqual([16, 15]);
  });

  it('falls back to all assigned testers when everyone is recorded absent (never deletes execution)', () => {
    const allAbsent = [
      { key: 'A', testerName: 'A', attendance: 'ABSENT' as const },
      { key: 'B', testerName: 'B', attendance: 'PAID_LEAVE' as const },
      { key: 'C', testerName: 'C', attendance: 'OTHER' as const },
    ];
    const suggestion = suggestAttendanceAwareAllocation(30, allAbsent);
    expect(suggestion.basis).toBe('none');
    expect(suggestion.allocations.map((a) => a.cases)).toEqual([10, 10, 10]);
    expect(suggestion.attendingKeys).toEqual([]);
  });

  it('treats missing attendance as attending by default (absence-only input)', () => {
    const suggestion = suggestAttendanceAwareAllocation(10, [
      { key: 'A', testerName: 'A', attendance: undefined },
      { key: 'B', testerName: 'B', attendance: 'LATE' as const },
    ]);
    // A has no record → attending; B is explicitly attending.
    expect(suggestion.basis).toBe('attendance');
    expect(suggestion.attendingKeys).toEqual(['A', 'B']);
    expect(suggestion.allocations.map((a) => a.cases)).toEqual([5, 5]);
  });

  it('splits among everyone with no attendance input at all (basis all, no hint)', () => {
    const suggestion = suggestAttendanceAwareAllocation(10, [
      { key: 'A', testerName: 'A', attendance: undefined },
      { key: 'B', testerName: 'B', attendance: undefined },
    ]);
    expect(suggestion.basis).toBe('all');
    expect(suggestion.attendingKeys).toEqual(['A', 'B']);
    expect(suggestion.excludedKeys).toEqual([]);
    expect(suggestion.allocations.map((a) => a.cases)).toEqual([5, 5]);
  });

  it('suggests only non-absent testers when absences are recorded', () => {
    const suggestion = suggestAttendanceAwareAllocation(10, [
      { key: 'A', testerName: 'A', attendance: undefined },
      { key: 'B', testerName: 'B', attendance: 'ABSENT' as const },
    ]);
    expect(suggestion.basis).toBe('attendance');
    expect(suggestion.attendingKeys).toEqual(['A']);
    expect(suggestion.excludedKeys).toEqual(['B']);
    expect(suggestion.allocations).toEqual([{ key: 'A', testerName: 'A', cases: 10 }]);
  });

  it('handles LATE and HALF_DAY as attending, OTHER as not', () => {
    const suggestion = suggestAttendanceAwareAllocation(20, [
      { key: 'A', testerName: 'A', attendance: 'HALF_DAY' as const },
      { key: 'B', testerName: 'B', attendance: 'OTHER' as const },
    ]);
    expect(suggestion.attendingKeys).toEqual(['A']);
    expect(suggestion.excludedKeys).toEqual(['B']);
  });
});

describe('V6.8 allocation validation (§17/§21)', () => {
  it('accepts an exact allocation with zero unassigned', () => {
    expect(validateAllocation(30, [15, 10, 5])).toEqual({ isValid: true, unassigned: 0, total: 30, allocated: 30 });
  });

  it('records an explicit unassigned remainder instead of losing cases', () => {
    const outcome = validateAllocation(30, [15, 7]);
    expect(outcome.isValid).toBe(true);
    expect(outcome.unassigned).toBe(8); // "Unassigned: 8 cases"
  });

  it('rejects over-allocation (never silently inflates execution)', () => {
    const outcome = validateAllocation(30, [20, 20]);
    expect(outcome.isValid).toBe(false);
    expect(outcome.unassigned).toBe(-10);
  });

  it('handles empty and zero allocations', () => {
    expect(validateAllocation(12, []).unassigned).toBe(12);
    expect(validateAllocation(12, [0, 0]).unassigned).toBe(12);
    expect(validateAllocation(0, [0]).isValid).toBe(true);
  });
});

describe('V6.8 unassigned execution visibility (§21)', () => {
  const members = seedRcsMembers();

  it('reports executed cases that cannot be confidently attributed', () => {
    const prj = project('PRJ-001', {
      dailyActuals: [
        { id: 's1', date: '2026-09-28', executed: 100, passed: 100, casesPassed: 100 },
        { id: 's2', date: '2026-09-29', executed: 130, passed: 130, casesPassed: 130 },
      ],
    });
    // Only 2026-09-28 has an assignment: 30 cases on 09-29 stay unassigned.
    const assignments = [memberAssignment('USER0003', '2026-09-28')];
    // Narrow the assignment to one day.
    const oneDay = [{ ...assignments[0], endDate: '2026-09-28' }];
    const plan = buildTesterPerformanceSyncPlan([prj], oneDay, members);
    expect(plan.unassignedDates).toEqual([{ projectId: 'PRJ-001', date: '2026-09-29', casesExecuted: 30 }]);
    const records = applyTesterPerformanceSync([], plan.items, members);
    expect(records).toHaveLength(1);
    expect(records[0].casesTested).toBe(100); // executed vs attributed stay distinct
  });

  it('uses member identity to find assigned testers for a date', () => {
    const assignments = [memberAssignment('USER0006')];
    const matched = getAssignedTestersForDate(assignments, 'PRJ-001', '2026-09-15', members);
    expect(matched.map((a) => a.memberId)).toEqual(['USER0006']);
  });
});

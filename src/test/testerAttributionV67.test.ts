import { describe, expect, it } from 'vitest';
import type { ProjectRecord, QaInputs, TesterDailyPerformance, TesterProjectAssignment } from '../types';
import { newProjectRecord } from '../domain/projects/lifecycle';
import {
  applyTesterPerformanceSync,
  buildTesterPerformanceSyncPlan,
  getAssignedTestersForDate,
  getDailyExecutionFacts,
  splitEvenly,
} from '../lib/calculations/testerAttribution';
import { normalizeQaInputs } from '../lib/storage/storage';

/**
 * V6.7 — Automated tester execution attribution (Level 2, assisted): daily
 * execution facts are derived from the V6.5 snapshot chain, attributed to
 * assigned testers as an equal-split proposal, and synchronized into
 * TesterDailyPerformance idempotently. Manual corrections are preserved;
 * nothing is invented for unassigned dates.
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
  // Force the stable project id so tests are deterministic.
  return { ...record, projectId };
}

function assignment(overrides: Partial<TesterProjectAssignment> = {}): TesterProjectAssignment {
  return {
    id: 'a-' + Math.random().toString(36).slice(2, 8),
    projectId: 'PRJ-001',
    testerName: 'Tanaka',
    startDate: '2026-09-01',
    active: true,
    ...overrides,
  };
}

// ---- Daily execution facts -----------------------------------------------------

describe('V6.7 getDailyExecutionFacts', () => {
  it('derives per-day executed deltas with the granular breakdown', () => {
    const facts = getDailyExecutionFacts({
      ...baseInputs(),
      dailyActuals: [
        { id: 's1', date: '2026-09-28', executed: 100, passed: 90, casesPassed: 90, casesFailed: 5, casesNotApplicable: 2, spoAssigned: 3, casesBlocked: 1, casesRetest: 2, casesQuestioned: 1 },
        { id: 's2', date: '2026-09-29', executed: 220, passed: 205, casesPassed: 205, casesFailed: 9, casesNotApplicable: 4, spoAssigned: 4, casesBlocked: 2, casesRetest: 3, casesQuestioned: 2 },
      ],
    });
    expect(facts).toHaveLength(2);
    expect(facts[0]).toEqual({
      date: '2026-09-28',
      casesExecuted: 100,
      casesPassed: 90,
      casesFailed: 5,
      casesNotApplicable: 2,
      casesBlocked: 1,
      casesRetest: 2,
      casesQuestioned: 1,
      casesSpoAssigned: 3,
    });
    expect(facts[1].casesExecuted).toBe(120);
    expect(facts[1].casesPassed).toBe(115);
    expect(facts[1].casesFailed).toBe(4);
  });

  it('leaves granular values null for legacy snapshots (never reconstructed)', () => {
    const facts = getDailyExecutionFacts({
      ...baseInputs(),
      dailyActuals: [
        { id: 's1', date: '2026-09-28', executed: 50, passed: 45 }, // pre-V6.5 shape
        { id: 's2', date: '2026-09-29', executed: 80, passed: 75, casesPassed: 75, casesFailed: 5 },
      ],
    });
    expect(facts[0].casesExecuted).toBe(50);
    expect(facts[0].casesPassed).toBeNull();
    // Legacy predecessor → the granular delta is unknown even for the new snapshot.
    expect(facts[1].casesPassed).toBeNull();
    expect(facts[1].casesExecuted).toBe(30);
  });

  it('skips days with zero or negative executed deltas', () => {
    const facts = getDailyExecutionFacts({
      ...baseInputs(),
      dailyActuals: [
        { id: 's1', date: '2026-09-28', executed: 100, passed: 100, casesPassed: 100 },
        { id: 's2', date: '2026-09-29', executed: 100, passed: 100, casesPassed: 100 }, // no progress
        { id: 's3', date: '2026-09-30', executed: 90, passed: 90, casesPassed: 90 }, // correction
      ],
    });
    // Only the first day has a positive delta (cumulative from zero).
    expect(facts).toHaveLength(1);
    expect(facts[0].date).toBe('2026-09-28');
    expect(facts[0].casesExecuted).toBe(100);
  });

  it('treats the first snapshot as cumulative from zero', () => {
    const facts = getDailyExecutionFacts({
      ...baseInputs(),
      dailyActuals: [{ id: 's1', date: '2026-09-28', executed: 40, passed: 35, casesPassed: 35, casesFailed: 5 }],
    });
    expect(facts[0].casesExecuted).toBe(40);
    expect(facts[0].casesPassed).toBe(35);
  });
});

// ---- Assignment matching --------------------------------------------------------

describe('V6.7 getAssignedTestersForDate', () => {
  it('matches active assignments covering the date, sorted by tester name', () => {
    const assignments = [
      assignment({ testerName: 'Suzuki', startDate: '2026-09-01' }),
      assignment({ testerName: 'Sato', startDate: '2026-09-15', endDate: '2026-09-20' }),
      assignment({ testerName: 'Tanaka', startDate: '2026-10-01' }), // not started yet
      assignment({ testerName: 'Kim', active: false }), // deactivated
      assignment({ testerName: 'Lee', projectId: 'PRJ-002' }), // other project
    ];
    const matched = getAssignedTestersForDate(assignments, 'PRJ-001', '2026-09-16');
    expect(matched.map((a) => a.testerName)).toEqual(['Sato', 'Suzuki']);
  });

  it('treats a missing endDate as open-ended', () => {
    const assignments = [assignment({ testerName: 'Tanaka', startDate: '2026-09-01' })];
    expect(getAssignedTestersForDate(assignments, 'PRJ-001', '2027-03-01')).toHaveLength(1);
    expect(getAssignedTestersForDate(assignments, 'PRJ-001', '2026-08-31')).toHaveLength(0);
  });
});

describe('V6.7 splitEvenly', () => {
  it('splits evenly and gives the remainder to the first testers', () => {
    expect(splitEvenly(120, 3)).toEqual([40, 40, 40]);
    expect(splitEvenly(10, 3)).toEqual([4, 3, 3]);
    expect(splitEvenly(7, 0)).toEqual([]);
  });
});

// ---- Sync plan & apply -----------------------------------------------------------

describe('V6.7 tester performance sync', () => {
  it('creates correctly attributed records (project, date, tester, equal split)', () => {
    const prj = project('PRJ-001', {
      dailyActuals: [
        { id: 's1', date: '2026-09-28', executed: 120, passed: 114, casesPassed: 114, casesFailed: 6 },
      ],
    });
    const assignments = [
      assignment({ testerName: 'Tanaka' }),
      assignment({ testerName: 'Sato' }),
      assignment({ testerName: 'Suzuki' }),
    ];
    const plan = buildTesterPerformanceSyncPlan([prj], assignments);
    expect(plan.toCreate).toBe(3);
    expect(plan.toUpdate).toBe(0);
    expect(plan.items).toHaveLength(3);
    for (const item of plan.items) {
      expect(item.action).toBe('create');
      expect(item.record.projectId).toBe('PRJ-001');
      expect(item.record.date).toBe('2026-09-28');
      expect(item.record.source).toBe('assisted');
      expect(item.record.casesTested).toBe(40);
      expect(item.record.casesPassed).toBe(38);
      expect(item.record.casesFailed).toBe(2);
    }
    expect(plan.items.map((item) => item.record.testerName).sort()).toEqual(['Sato', 'Suzuki', 'Tanaka']);
  });

  it('syncs multiple days and multiple testers without duplicates', () => {
    const prj = project('PRJ-001', {
      dailyActuals: [
        { id: 's1', date: '2026-09-28', executed: 60, passed: 60, casesPassed: 60 },
        { id: 's2', date: '2026-09-29', executed: 90, passed: 90, casesPassed: 90 },
      ],
    });
    const assignments = [assignment({ testerName: 'Tanaka' }), assignment({ testerName: 'Sato' })];
    let plan = buildTesterPerformanceSyncPlan([prj], assignments);
    let records = applyTesterPerformanceSync([], plan.items);
    expect(records).toHaveLength(4); // 2 testers × 2 days — no duplicates
    expect(plan.toCreate).toBe(4);

    // Sync again: everything is unchanged, ids and values are stable.
    const syncedProject = { ...prj, inputs: { ...prj.inputs, testerDailyPerformance: records } };
    plan = buildTesterPerformanceSyncPlan([syncedProject], assignments);
    expect(plan.toCreate).toBe(0);
    expect(plan.toUpdate).toBe(0);
    expect(plan.unchanged).toBe(4);
    const recordsAfter = applyTesterPerformanceSync(records, plan.items);
    expect(recordsAfter).toEqual(records);
  });

  it('aggregates a tester working across multiple projects', () => {
    const prj1 = project('PRJ-001', {
      dailyActuals: [{ id: 's1', date: '2026-09-28', executed: 30, passed: 30, casesPassed: 30 }],
    });
    const prj2 = project('PRJ-002', {
      dailyActuals: [{ id: 's2', date: '2026-09-28', executed: 45, passed: 45, casesPassed: 45 }],
    }, [prj1]);
    const assignments = [
      assignment({ testerName: 'Tanaka', projectId: 'PRJ-001' }),
      assignment({ testerName: 'Tanaka', projectId: 'PRJ-002' }),
    ];
    const plan = buildTesterPerformanceSyncPlan([prj1, prj2], assignments);
    const records = applyTesterPerformanceSync([], plan.items);
    const tanaka = records.filter((r) => r.testerName === 'Tanaka');
    expect(tanaka.map((r) => r.projectId).sort()).toEqual(['PRJ-001', 'PRJ-002']);
    expect(tanaka.find((r) => r.projectId === 'PRJ-001')!.casesTested).toBe(30);
    expect(tanaka.find((r) => r.projectId === 'PRJ-002')!.casesTested).toBe(45);
  });

  it('invents nothing for dates without an assignment and reports them', () => {
    const prj = project('PRJ-001', {
      dailyActuals: [
        { id: 's1', date: '2026-09-28', executed: 100, passed: 100, casesPassed: 100 },
        { id: 's2', date: '2026-09-29', executed: 130, passed: 130, casesPassed: 130 },
      ],
    });
    const assignments = [assignment({ testerName: 'Tanaka', startDate: '2026-09-29' })];
    const plan = buildTesterPerformanceSyncPlan([prj], assignments);
    expect(plan.unassignedDates).toEqual([{ projectId: 'PRJ-001', date: '2026-09-28', casesExecuted: 100 }]);
    const records = applyTesterPerformanceSync([], plan.items);
    expect(records).toHaveLength(1);
    expect(records[0].date).toBe('2026-09-29');
  });

  it('preserves manual and legacy records during sync (no overwrite)', () => {
    const manualRecord: TesterDailyPerformance = {
      id: 'manual-1',
      date: '2026-09-28',
      testerName: 'Tanaka',
      projectId: 'PRJ-001',
      casesTested: 42,
      source: 'manualOverride',
    };
    const legacyRecord: TesterDailyPerformance = {
      id: 'legacy-1',
      date: '2026-09-28',
      testerName: 'Sato',
      projectId: 'PRJ-001',
      casesTested: 11, // V6.6 record without source
    };
    const prj = project('PRJ-001', {
      dailyActuals: [{ id: 's1', date: '2026-09-28', executed: 100, passed: 100, casesPassed: 100 }],
      testerDailyPerformance: [manualRecord, legacyRecord],
    });
    const assignments = [assignment({ testerName: 'Tanaka' }), assignment({ testerName: 'Sato' })];
    const plan = buildTesterPerformanceSyncPlan([prj], assignments);
    expect(plan.manualPreserved).toBe(2);
    expect(plan.toCreate).toBe(0);
    expect(plan.toUpdate).toBe(0);
    const records = applyTesterPerformanceSync(prj.inputs.testerDailyPerformance ?? [], plan.items);
    expect(records.find((r) => r.id === 'manual-1')!.casesTested).toBe(42);
    expect(records.find((r) => r.id === 'manual-1')!.source).toBe('manualOverride');
    expect(records.find((r) => r.id === 'legacy-1')!.casesTested).toBe(11);
  });

  it('updates assisted records when the source snapshots change, keeping stable ids', () => {
    const prj = project('PRJ-001', {
      dailyActuals: [{ id: 's1', date: '2026-09-28', executed: 100, passed: 100, casesPassed: 100 }],
    });
    const assignments = [assignment({ testerName: 'Tanaka' })];
    const plan1 = buildTesterPerformanceSyncPlan([prj], assignments);
    const records = applyTesterPerformanceSync([], plan1.items);
    expect(records[0].casesTested).toBe(100);

    // The day's execution snapshot is corrected to 80; the existing assisted
    // record is re-derived (same tester/day/project → update, not duplicate).
    const corrected = {
      ...prj,
      inputs: {
        ...prj.inputs,
        dailyActuals: [{ id: 's1', date: '2026-09-28', executed: 80, passed: 80, casesPassed: 80 }],
        testerDailyPerformance: records,
      },
    };
    const plan2 = buildTesterPerformanceSyncPlan([corrected], assignments);
    expect(plan2.toUpdate).toBe(1);
    expect(plan2.toCreate).toBe(0);
    expect(plan2.unchanged).toBe(0);
    const updated = applyTesterPerformanceSync(records, plan2.items);
    expect(updated).toHaveLength(1);
    expect(updated[0].id).toBe(records[0].id);
    expect(updated[0].casesTested).toBe(80);
  });

  it('is idempotent: repeated syncs produce the same three records', () => {
    const prj = project('PRJ-001', {
      dailyActuals: [
        { id: 's1', date: '2026-09-28', executed: 30, passed: 30, casesPassed: 30 },
        { id: 's2', date: '2026-09-29', executed: 60, passed: 55, casesPassed: 55, casesFailed: 5 },
        { id: 's3', date: '2026-09-30', executed: 95, passed: 90, casesPassed: 90, casesFailed: 5 },
      ],
    });
    const assignments = [assignment({ testerName: 'Tanaka' }), assignment({ testerName: 'Sato' }), assignment({ testerName: 'Suzuki' })];

    let current: TesterDailyPerformance[] = [];
    for (let run = 0; run < 3; run += 1) {
      const working = { ...prj, inputs: { ...prj.inputs, testerDailyPerformance: current } };
      const plan = buildTesterPerformanceSyncPlan([working], assignments);
      current = applyTesterPerformanceSync(current, plan.items);
      expect(current).toHaveLength(9); // 3 testers × 3 days — every run
    }
    // Values are deterministic (equal split, alphabetical remainder order).
    const sept29 = current.filter((r) => r.date === '2026-09-29');
    expect(sept29.map((r) => r.casesTested).sort((a, b) => a - b)).toEqual([10, 10, 10]);
    const sept30 = current.filter((r) => r.date === '2026-09-30');
    expect(sept30.reduce((sum, r) => sum + r.casesTested, 0)).toBe(35);
  });

  it('assigns zero-case days to nobody (facts with no execution are skipped)', () => {
    const prj = project('PRJ-001', {
      dailyActuals: [
        { id: 's1', date: '2026-09-28', executed: 50, passed: 50, casesPassed: 50 },
        { id: 's2', date: '2026-09-29', executed: 50, passed: 50, casesPassed: 50 }, // zero delta
      ],
    });
    const assignments = [assignment({ testerName: 'Tanaka' })];
    const plan = buildTesterPerformanceSyncPlan([prj], assignments);
    const records = applyTesterPerformanceSync([], plan.items);
    expect(records).toHaveLength(1);
    expect(records[0].casesTested).toBe(50);
  });

  it('creates records for Done projects too (history is evidence)', () => {
    const prj = { ...project('PRJ-001', { dailyActuals: [{ id: 's1', date: '2026-09-28', executed: 10, passed: 10, casesPassed: 10 }] }), status: 'done' as const };
    const assignments = [assignment({ testerName: 'Tanaka' })];
    const plan = buildTesterPerformanceSyncPlan([prj], assignments);
    expect(plan.toCreate).toBe(1);
  });
});

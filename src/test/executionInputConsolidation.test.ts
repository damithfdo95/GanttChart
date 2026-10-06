import { describe, expect, it } from 'vitest';
import type { AppState, DailyExecutionEntry, TesterDailyPerformance } from '../types';
import { dailyAttributionMismatches } from '../lib/calculations/testerAttribution';
import { seedAutoActivities } from '../lib/reporting/drafts';
import { DEMO_STATE } from '../lib/storage/storage';

/**
 * Input consolidation: execution results are entered ONCE (Dashboard →
 * Today's Execution → dailyExecuted entries). The other surfaces either
 * derive from them (Daily Report auto-seed), link back to them (Manager
 * view), or are checked against them (Performance tester attribution).
 */

const D1 = '2026-10-05'; // Monday
const D2 = '2026-10-06'; // Tuesday
const D3 = '2026-10-07'; // Wednesday

function entry(overrides: Partial<DailyExecutionEntry> = {}): DailyExecutionEntry {
  return {
    id: 'e-1',
    date: D1,
    startTime: 9 * 60,
    endTime: 17 * 60 + 30,
    overtimeMinutes: 0,
    intervalEnabled: true,
    testers: 4,
    pass: 10,
    fail: 2,
    notApplicable: 1,
    spo: 1,
    blocked: 0,
    retest: 0,
    questioned: 0,
    note: '',
    ...overrides,
  };
}

function testerRecord(overrides: Partial<TesterDailyPerformance> = {}): TesterDailyPerformance {
  return {
    id: 't-1',
    date: D1,
    testerName: 'Tester One',
    projectId: 'PRJ-001',
    casesTested: 0,
    ...overrides,
  };
}

function appState(overrides: Partial<AppState> = {}): AppState {
  return { ...DEMO_STATE, ...overrides };
}

// ---- tester attribution consistency -------------------------------------------

describe('dailyAttributionMismatches', () => {
  it('returns nothing when tester records sum to the entry completed cases', () => {
    const entries = [entry({ date: D1, pass: 10, fail: 2, notApplicable: 1, spo: 1 })]; // 14 completed
    const records = [
      testerRecord({ id: 't-1', date: D1, casesTested: 8 }),
      testerRecord({ id: 't-2', date: D1, testerName: 'Tester Two', casesTested: 6 }),
    ];
    expect(dailyAttributionMismatches(entries, records)).toEqual([]);
  });

  it('reports dates where the sums disagree, with both totals', () => {
    const entries = [entry({ date: D1, pass: 10, fail: 2, notApplicable: 1, spo: 1 })]; // 14 completed
    const records = [testerRecord({ id: 't-1', date: D1, casesTested: 11 })];
    expect(dailyAttributionMismatches(entries, records)).toEqual([
      { date: D1, entryCompleted: 14, testersTotal: 11 },
    ]);
  });

  it('flags tester records on a date with no daily entry (entered per-tester only)', () => {
    const records = [testerRecord({ date: D3, casesTested: 5 })];
    expect(dailyAttributionMismatches([], records)).toEqual([
      { date: D3, entryCompleted: 0, testersTotal: 5 },
    ]);
  });

  it('ignores unattributed entry days with zero tester records only when the entry is empty too', () => {
    // An entry with 0 completed and no tester records is consistent...
    expect(dailyAttributionMismatches([entry({ date: D2, pass: 0, fail: 0, notApplicable: 0, spo: 0 })], [])).toEqual([]);
    // ...but an entry with completed cases and no tester attribution is not.
    expect(dailyAttributionMismatches([entry({ date: D2 })], [])).toEqual([
      { date: D2, entryCompleted: 14, testersTotal: 0 },
    ]);
  });

  it('checks each date independently across several days', () => {
    const entries = [
      entry({ id: 'e-1', date: D1, pass: 10, fail: 2, notApplicable: 1, spo: 1 }), // 14
      entry({ id: 'e-2', date: D2, pass: 4, fail: 0, notApplicable: 0, spo: 0 }), // 4
    ];
    const records = [
      testerRecord({ id: 't-1', date: D1, casesTested: 14 }), // match
      testerRecord({ id: 't-2', date: D2, testerName: 'Tester Two', casesTested: 3 }), // mismatch
    ];
    expect(dailyAttributionMismatches(entries, records)).toEqual([
      { date: D2, entryCompleted: 4, testersTotal: 3 },
    ]);
  });
});

// ---- Daily Report auto-seed from the canonical entries ---------------------------

describe('seedAutoActivities with daily execution entries', () => {
  it('seeds the day counts and actual testers from the entry for the date', () => {
    const state = appState({
      totalCases: 120,
      casesCompleted: 30,
      casesPassed: 26,
      casesFailed: 2,
      currentTesters: 4,
      planningRows: [
        { id: 'p1', date: D1, plannedTesters: 6, absentTesters: 2, nonWorkingDay: false, note: '' },
      ],
      dailyExecuted: [entry({ date: D1, testers: 5, pass: 7, fail: 1, notApplicable: 0, spo: 2, blocked: 3, retest: 1, questioned: 2 })],
    });
    const seeded = seedAutoActivities('en', state, D1);
    expect(seeded).toHaveLength(1);
    // The day's entry wins for the day's counts and staffing.
    expect(seeded[0].memberCount).toBe(5);
    expect(seeded[0].casesPassed).toBe(7);
    expect(seeded[0].casesFailed).toBe(1);
    expect(seeded[0].notApplicableCases).toBe(0);
    expect(seeded[0].spoAssigned).toBe(2);
    expect(seeded[0].blockedCases).toBe(3);
    expect(seeded[0].casesRetest).toBe(1);
    expect(seeded[0].casesQuestioned).toBe(2);
    // Cumulative progress fields stay cumulative (progress % are computed from them).
    expect(seeded[0].completedCases).toBe(30);
    expect(seeded[0].startedCases).toBe(30);
    expect(seeded[0].totalCases).toBe(120);
  });

  it('keeps the legacy cumulative seeding on dates without an entry', () => {
    const state = appState({
      totalCases: 120,
      casesCompleted: 30,
      casesPassed: 26,
      casesFailed: 2,
      currentTesters: 4,
      planningRows: [
        { id: 'p1', date: D1, plannedTesters: 6, absentTesters: 2, nonWorkingDay: false, note: '' },
      ],
      dailyExecuted: [entry({ date: D2, testers: 5, pass: 7 })], // different date
    });
    const seeded = seedAutoActivities('en', state, D1);
    expect(seeded[0].memberCount).toBe(4); // 6 planned − 2 absent
    expect(seeded[0].casesPassed).toBe(26);
    expect(seeded[0].casesFailed).toBe(2);
    expect(seeded[0].blockedCases).toBe(DEMO_STATE.casesBlocked ?? 0);
  });
});

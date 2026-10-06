import { describe, expect, it } from 'vitest';
import type { DailyExecutionEntry, QaInputs } from '../types';
import {
  applyDailyExecutionEntry,
  cumulativeBeforeDate,
  cumulativeThroughDate,
  dailyDeltaFromTotals,
  type ExecutionStatusTotals,
} from '../lib/calculations/dailyExecuted';

/**
 * Cumulative (total) input mode for the daily execution form: the user
 * enters RUNNING TOTALS as of the selected date; the day's per-status
 * counts are derived (total − everything recorded before that date,
 * clamped at 0) before a normal per-day entry is saved. The stored model
 * (one per-day entry per date) is unchanged.
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
    pass: 0,
    fail: 0,
    notApplicable: 0,
    spo: 0,
    blocked: 0,
    retest: 0,
    questioned: 0,
    note: '',
    ...overrides,
  };
}

function totals(overrides: Partial<ExecutionStatusTotals> = {}): ExecutionStatusTotals {
  return {
    pass: 0,
    fail: 0,
    notApplicable: 0,
    spo: 0,
    blocked: 0,
    retest: 0,
    questioned: 0,
    ...overrides,
  };
}

function inputs(overrides: Partial<QaInputs> = {}): QaInputs {
  return {
    totalCases: 100,
    currentTesters: 8,
    startTime: 9 * 60,
    targetFinish: 17 * 60 + 30,
    lunchStart: 12 * 60,
    lunchEnd: 13 * 60,
    perHourPerTester: 4,
    casesCompleted: 0,
    casesPassed: 0,
    startDate: D1,
    targetCompletionDate: D3,
    targetCompletionTime: null,
    planningRows: [
      { id: 'r1', date: D1, plannedTesters: 8, absentTesters: 0, nonWorkingDay: false, note: '' },
      { id: 'r2', date: D2, plannedTesters: 8, absentTesters: 0, nonWorkingDay: false, note: '' },
      { id: 'r3', date: D3, plannedTesters: 8, absentTesters: 0, nonWorkingDay: false, note: '' },
    ],
    ...overrides,
  };
}

// ---- pure helpers -------------------------------------------------------------

describe('cumulative input mode helpers', () => {
  it('cumulativeBeforeDate/ThroughDate filter strictly by date and tolerate unsorted storage', () => {
    const entries = [
      entry({ id: 'e-2', date: D2, pass: 7, fail: 1 }),
      entry({ id: 'e-1', date: D1, pass: 3, fail: 2 }),
      entry({ id: 'e-3', date: D3, pass: 5 }),
    ];
    expect(cumulativeBeforeDate(entries, D1)).toEqual(totals());
    expect(cumulativeBeforeDate(entries, D2)).toEqual(totals({ pass: 3, fail: 2 }));
    expect(cumulativeThroughDate(entries, D2)).toEqual(totals({ pass: 10, fail: 3 }));
    expect(cumulativeThroughDate(entries, D3)).toEqual(totals({ pass: 15, fail: 3 }));
  });

  it('dailyDeltaFromTotals subtracts the previous cumulative per field', () => {
    const delta = dailyDeltaFromTotals(
      totals({ pass: 15, fail: 3, notApplicable: 2, spo: 4, blocked: 5, retest: 1, questioned: 2 }),
      totals({ pass: 7, fail: 1, notApplicable: 2, spo: 1, blocked: 2, retest: 1, questioned: 0 }),
    );
    expect(delta).toEqual(totals({ pass: 8, fail: 2, notApplicable: 0, spo: 3, blocked: 3, retest: 0, questioned: 2 }));
  });

  it('dailyDeltaFromTotals clamps a decreasing total at zero (e.g. unblocked cases)', () => {
    const delta = dailyDeltaFromTotals(totals({ pass: 5, blocked: 2 }), totals({ pass: 7, blocked: 6 }));
    expect(delta).toEqual(totals({ pass: 0, blocked: 0 }));
  });
});

// ---- save path (derived entries through the canonical action) ------------------

describe('saving cumulative inputs as daily entries', () => {
  it('entering running totals across two days yields the right per-day entries and canonical fields', () => {
    // Day 1: nothing recorded before → the day IS the total.
    const base = inputs();
    const day1 = applyDailyExecutionEntry(
      base,
      entry({ id: 'e-1', date: D1, ...dailyDeltaFromTotals(totals({ pass: 10, fail: 2, notApplicable: 1, spo: 1 }), cumulativeBeforeDate(base.dailyExecuted ?? [], D1)) }),
    );
    // Day 2: totals as of D2 minus everything before D2.
    const day2 = applyDailyExecutionEntry(
      day1,
      entry({ id: 'e-2', date: D2, ...dailyDeltaFromTotals(totals({ pass: 18, fail: 3, notApplicable: 1, spo: 2 }), cumulativeBeforeDate(day1.dailyExecuted ?? [], D2)) }),
    );

    expect(day2.dailyExecuted?.map((e) => [e.date, e.pass, e.fail, e.notApplicable, e.spo])).toEqual([
      [D1, 10, 2, 1, 1],
      [D2, 8, 1, 0, 1],
    ]);
    expect(day2.casesCompleted).toBe(24); // 14 (D1) + 10 (D2)
    expect(day2.casesPassed).toBe(18);
    expect(day2.dailyActuals).toEqual([
      expect.objectContaining({ date: D1, executed: 14, passed: 10 }),
      expect.objectContaining({ date: D2, executed: 24, passed: 18 }),
    ]);
  });

  it('re-saving a day with the same running totals keeps every number unchanged', () => {
    let state = inputs();
    state = applyDailyExecutionEntry(state, entry({ id: 'e-1', date: D1, pass: 10, fail: 2, notApplicable: 1, spo: 1 }));
    state = applyDailyExecutionEntry(state, entry({ id: 'e-2', date: D2, pass: 8, fail: 1 }));

    // The form seeds TOTAL mode with cumulativeThroughDate(D2) = 18/3/1/1;
    // re-saving those totals must derive the identical per-day entry.
    const reseeded = entry({ id: 'e-2', date: D2, ...cumulativeThroughDate(state.dailyExecuted ?? [], D2) });
    const resaved = applyDailyExecutionEntry(state, {
      ...reseeded,
      ...dailyDeltaFromTotals(
        { pass: reseeded.pass, fail: reseeded.fail, notApplicable: reseeded.notApplicable, spo: reseeded.spo, blocked: reseeded.blocked, retest: reseeded.retest, questioned: reseeded.questioned },
        cumulativeBeforeDate(state.dailyExecuted ?? [], D2),
      ),
    });
    expect(resaved.casesCompleted).toBe(state.casesCompleted);
    expect(resaved.casesPassed).toBe(state.casesPassed);
    expect(resaved.dailyExecuted).toEqual(state.dailyExecuted);
    expect(resaved.dailyActuals).toEqual(state.dailyActuals);
  });

  it('raising an earlier day’s total changes only that day’s delta', () => {
    let state = inputs();
    state = applyDailyExecutionEntry(state, entry({ id: 'e-1', date: D1, pass: 10, fail: 2, notApplicable: 1, spo: 1 }));
    state = applyDailyExecutionEntry(state, entry({ id: 'e-2', date: D2, pass: 8, fail: 1 }));

    // Edit D1 in TOTAL mode: previous for D1 is still empty → new delta 12/2/1/1.
    const edited = applyDailyExecutionEntry(
      state,
      entry({ id: 'e-1', date: D1, ...dailyDeltaFromTotals(totals({ pass: 12, fail: 2, notApplicable: 1, spo: 1 }), cumulativeBeforeDate(state.dailyExecuted ?? [], D1)) }),
    );
    // D2 keeps its stored per-day counts (8/1) — its cumulative shifts.
    expect(edited.casesPassed).toBe(20);
    expect(edited.dailyActuals).toEqual([
      expect.objectContaining({ date: D1, passed: 12 }),
      expect.objectContaining({ date: D2, passed: 20 }),
    ]);
  });

  it('a migrated entry’s uncategorizedCompleted never distorts the status deltas', () => {
    const withLegacy = applyDailyExecutionEntry(
      inputs(),
      entry({ id: 'migrated-D1', date: D1, pass: 3, fail: 1, uncategorizedCompleted: 5 }),
    );
    // Previous sums for D2 see pass 3 / fail 1 — the 5 unattributed cases
    // belong to no status field, so entering pass 6 on D2 derives 3.
    const previous = cumulativeBeforeDate(withLegacy.dailyExecuted ?? [], D2);
    expect(previous).toEqual(totals({ pass: 3, fail: 1 }));
    expect(dailyDeltaFromTotals(totals({ pass: 6 }), previous).pass).toBe(3);
  });
});

import { describe, expect, it } from 'vitest';
import type { DailyExecutionEntry, QaInputs } from '../types';
import {
  aggregateDailyExecuted,
  applyDailyExecutionEntry,
  entryCompletedCases,
  entryForDate,
  migrateDailyExecuted,
  regenerateSnapshotsFromEntries,
  removeDailyExecutionEntry,
  sortDailyExecuted,
  syncActualsFromDailyExecuted,
  upsertDailyExecutionEntry,
} from '../lib/calculations/dailyExecuted';
import { calculateCumulativeCapacityByDay } from '../lib/calculations/planning';
import {
  advanceOverWorkDays,
  dayWindowProductiveHours,
  dayWindowsFromRows,
  projectDayWindowDefaults,
  rowDayWindow,
  workingEpochDays,
} from '../lib/calculations/workday';
import { generateDailyPlan } from '../lib/calculations/dailyPlan';

/**
 * V7 — per-day plan windows and daily execution entries.
 *
 * Model under test:
 * - PLAN: PlanningRow window overrides (start/end/overtime/interval), the
 *   project defaults filling the gaps, and their effect on the capacity
 *   engine, the finish walk and the daily plan.
 * - EXECUTION: DailyExecutionEntry records as the single source of truth —
 *   aggregation, snapshot regeneration, the sync projection, the UI save
 *   action and the legacy migration (invariant-preserving).
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

// ---- per-day windows -----------------------------------------------------------

describe('V7 per-day plan windows', () => {
  it('rowDayWindow falls back to the project defaults for unset overrides', () => {
    const defaults = projectDayWindowDefaults(inputs({ dailyOvertimeMinutes: 60 }));
    const win = rowDayWindow({ startTime: undefined, endTime: undefined, overtimeMinutes: undefined, intervalEnabled: undefined }, defaults);
    expect(win.start).toBe(9 * 60);
    expect(win.end).toBe(17 * 60 + 30 + 60);
    expect(win.lunch).toEqual({ start: 12 * 60, end: 13 * 60 });
    expect(dayWindowProductiveHours(win)).toBe(8.5); // 9.5h span − 1h lunch
  });

  it('row overrides win over the defaults and stack overtime on the row end', () => {
    const defaults = projectDayWindowDefaults(inputs());
    const win = rowDayWindow(
      { startTime: 10 * 60, endTime: 16 * 60, overtimeMinutes: 30, intervalEnabled: false },
      defaults,
    );
    expect(win.start).toBe(10 * 60);
    expect(win.end).toBe(16 * 60 + 30);
    expect(win.lunch).toEqual({ start: 0, end: 0 }); // interval not taken
    expect(dayWindowProductiveHours(win)).toBe(6.5); // whole window productive
  });

  it('interval = no removes the lunch deduction (9:00–17:30 → 8.5h)', () => {
    const defaults = projectDayWindowDefaults(inputs({ intervalEnabled: false }));
    expect(dayWindowProductiveHours(defaults)).toBe(8.5);
  });

  it('capacity honors each row window through calculateCumulativeCapacityByDay', () => {
    const rows = inputs({
      intervalEnabled: false,
      planningRows: [
        { id: 'r1', date: D1, plannedTesters: 4, absentTesters: 0, nonWorkingDay: false, note: '' },
        { id: 'r2', date: D2, plannedTesters: 4, absentTesters: 0, nonWorkingDay: false, note: '', startTime: 9 * 60, endTime: 17 * 60 + 30 }, // 7.5h (interval default off → 8.5h? no: row interval falls back to default=off → 8.5h)
        { id: 'r3', date: D3, plannedTesters: 4, absentTesters: 0, nonWorkingDay: false, note: '', intervalEnabled: true }, // 7.5h
      ],
    }).planningRows;
    const defaults = projectDayWindowDefaults({ startTime: 9 * 60, dailyOvertimeMinutes: 0, intervalEnabled: false });
    const daily = calculateCumulativeCapacityByDay(rows, 4, 8.5, dayWindowsFromRows(rows, defaults));
    // Day 1: 4 testers × 4/h × 8.5h = 136; day 2 same; day 3 with interval = 120.
    expect(daily.map((r) => r.dailyCapacity)).toEqual([136, 136, 120]);
    expect(daily.map((r) => r.productiveHours)).toEqual([8.5, 8.5, 7.5]);
  });

  it('the finish walk uses each listed day window when a context is given', () => {
    const rows = inputs({
      planningRows: [
        { id: 'r1', date: D1, plannedTesters: 8, absentTesters: 0, nonWorkingDay: false, note: '', intervalEnabled: false }, // 8.5h day
        { id: 'r2', date: D2, plannedTesters: 8, absentTesters: 0, nonWorkingDay: false, note: '' }, // 7.5h day
      ],
    }).planningRows;
    const days = workingEpochDays(rows, D1);
    const ctx = dayWindowsFromRows(rows, projectDayWindowDefaults(inputs()));
    // 8.5h + 7.5h = 16h of work: the finish lands on day 2 at 17:30
    // (7.5 productive hours from 9:00, lunch skipped).
    const finish = advanceOverWorkDays(16 * 60, days, D1, 9 * 60, undefined, 0, [], ctx);
    expect(finish).toEqual({ epochDay: days[1], time: 17 * 60 + 30 });
  });

  it('the daily plan uses each row window for its capacity', () => {
    const rows = inputs({
      planningRows: [
        { id: 'r1', date: D1, plannedTesters: 4, absentTesters: 0, nonWorkingDay: false, note: '', intervalEnabled: false },
        { id: 'r2', date: D2, plannedTesters: 4, absentTesters: 0, nonWorkingDay: false, note: '' },
      ],
    }).planningRows;
    const plan = generateDailyPlan(rows, 4, 7.5, 300, 1, [], dayWindowsFromRows(rows, projectDayWindowDefaults(inputs())));
    expect(plan[0].plannedExecute).toBe(4 * 4 * 8.5); // 136
    expect(plan[1].plannedExecute).toBe(4 * 4 * 7.5); // 120
    expect(plan[1].cumulativeExecute).toBe(136 + 120);
  });
});

// ---- daily execution entries ---------------------------------------------------

describe('V7 daily execution aggregation', () => {
  it('entryCompletedCases = Pass + Fail + N/A + SPO + uncategorized', () => {
    expect(entryCompletedCases(entry())).toBe(14);
    expect(entryCompletedCases(entry({ uncategorizedCompleted: 3, spo: 0, fail: 0, notApplicable: 0 }))).toBe(13);
  });

  it('aggregateDailyExecuted sums every canonical field over the entries', () => {
    const totals = aggregateDailyExecuted([
      entry({ pass: 10, fail: 1, notApplicable: 1, spo: 1, blocked: 2, retest: 1, questioned: 1 }),
      entry({ id: 'e-2', date: D2, pass: 5, fail: 2, notApplicable: 0, spo: 3, blocked: 1, retest: 0, questioned: 2 }),
    ]);
    expect(totals.casesCompleted).toBe(10 + 1 + 1 + 1 + 5 + 2 + 0 + 3);
    expect(totals.casesPassed).toBe(15);
    expect(totals.casesFailed).toBe(3);
    expect(totals.casesNotApplicable).toBe(1);
    expect(totals.spoAssigned).toBe(4);
    expect(totals.casesBlocked).toBe(3);
    expect(totals.casesRetest).toBe(1);
    expect(totals.casesQuestioned).toBe(3);
  });

  it('sortDailyExecuted orders chronologically and upsert keeps one entry per date', () => {
    const a = entry({ date: D2, id: 'a' });
    const b = entry({ date: D1, id: 'b' });
    const sorted = sortDailyExecuted([a, b]);
    expect(sorted.map((e) => e.date)).toEqual([D1, D2]);
    const upserted = upsertDailyExecutionEntry([b], entry({ date: D1, id: 'c', pass: 9 }));
    expect(upserted).toHaveLength(1);
    expect(upserted[0].pass).toBe(9);
    expect(upserted[0].id).toBe('b'); // the existing id is kept (stable keys)
    expect(entryForDate(upserted, D1)!.pass).toBe(9);
    expect(entryForDate(upserted, D3)).toBeNull();
  });

  it('regenerateSnapshotsFromEntries produces cumulative end-of-day snapshots', () => {
    const snapshots = regenerateSnapshotsFromEntries([
      entry({ pass: 10, fail: 2, notApplicable: 1, spo: 1, blocked: 5, retest: 4, questioned: 3 }),
      entry({ id: 'e-2', date: D2, pass: 1, fail: 1, notApplicable: 1, spo: 1 }),
    ]);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].executed).toBe(14);
    expect(snapshots[0].casesPassed).toBe(10);
    expect(snapshots[1].executed).toBe(18);
    expect(snapshots[1].passed).toBe(11);
    expect(snapshots[1].casesBlocked).toBe(5);
  });

  it('syncActualsFromDailyExecuted recomputes the canonical projection and leaves snapshots alone', () => {
    const withEntries = inputs({
      dailyExecuted: [
        entry({ pass: 10, fail: 2, notApplicable: 1, spo: 1, blocked: 5, retest: 4, questioned: 3 }),
        entry({ id: 'e-2', date: D2, pass: 1, fail: 1, notApplicable: 1, spo: 1 }),
      ],
      dailyActuals: [{ id: 'legacy', date: D1, executed: 99, passed: 99 }],
    });
    const synced = syncActualsFromDailyExecuted(withEntries);
    expect(synced.casesCompleted).toBe(18);
    expect(synced.casesPassed).toBe(11);
    expect(synced.spoAssigned).toBe(2);
    expect(synced.casesBlocked).toBe(5);
    // Snapshots are NOT regenerated by the sync — only the UI save does.
    expect(synced.dailyActuals).toEqual(withEntries.dailyActuals);
  });

  it('syncActualsFromDailyExecuted leaves legacy inputs (no entries) untouched', () => {
    const legacy = inputs({ casesCompleted: 42, casesPassed: 40 });
    expect(syncActualsFromDailyExecuted(legacy)).toBe(legacy);
  });

  it('applyDailyExecutionEntry saves a day, syncs totals and regenerates snapshots', () => {
    const saved = applyDailyExecutionEntry(inputs(), entry({ pass: 7, fail: 1, notApplicable: 0, spo: 2 }));
    expect(saved.casesCompleted).toBe(10);
    expect(saved.casesPassed).toBe(7);
    expect(saved.dailyExecuted).toHaveLength(1);
    expect(saved.dailyActuals).toHaveLength(1);
    expect(saved.dailyActuals![0].executed).toBe(10);
    // Saving another day accumulates.
    const second = applyDailyExecutionEntry(saved, entry({ id: 'e-2', date: D2, pass: 3, fail: 0, notApplicable: 1, spo: 0 }));
    expect(second.casesCompleted).toBe(14);
    expect(second.dailyActuals).toHaveLength(2);
    expect(second.dailyActuals![1].executed).toBe(14);
    // Editing the FIRST day rewrites every cumulative total.
    const edited = applyDailyExecutionEntry(second, entry({ pass: 8, fail: 1, notApplicable: 0, spo: 2 }));
    expect(edited.casesCompleted).toBe(15);
    expect(edited.dailyActuals).toHaveLength(2);
    expect(edited.dailyActuals![0].executed).toBe(11);
    expect(edited.dailyActuals![1].executed).toBe(15);
  });

  it('removeDailyExecutionEntry deletes a middle day and recomputes every projection', () => {
    let state = inputs();
    state = applyDailyExecutionEntry(state, entry({ pass: 10, fail: 2, notApplicable: 1, spo: 1 }));
    state = applyDailyExecutionEntry(state, entry({ id: 'e-2', date: D2, pass: 3, fail: 0, notApplicable: 1, spo: 0 }));
    state = applyDailyExecutionEntry(state, entry({ id: 'e-3', date: D3, pass: 5, fail: 1, notApplicable: 0, spo: 0 }));

    const withoutD2 = removeDailyExecutionEntry(state, D2);
    expect(withoutD2.dailyExecuted?.map((e) => e.date)).toEqual([D1, D3]);
    // Cumulative fields are Σ remaining entries (14 + 6, 10 + 5 passes).
    expect(withoutD2.casesCompleted).toBe(20);
    expect(withoutD2.casesPassed).toBe(15);
    // Snapshots regenerate without the deleted day: D3 keeps its own day
    // counts but lands on the recomputed cumulative.
    expect(withoutD2.dailyActuals).toHaveLength(2);
    expect(withoutD2.dailyActuals![0].executed).toBe(14);
    expect(withoutD2.dailyActuals![1].executed).toBe(20);
    expect(withoutD2.dailyActuals![1].passed).toBe(15);
  });

  it('removeDailyExecutionEntry on the only day zeroes the projection but keeps entries authoritative', () => {
    let state = inputs();
    state = applyDailyExecutionEntry(state, entry({ pass: 7, fail: 1, notApplicable: 0, spo: 2 }));
    const emptied = removeDailyExecutionEntry(state, D1);
    expect(emptied.dailyExecuted).toEqual([]);
    expect(emptied.casesCompleted).toBe(0);
    expect(emptied.casesPassed).toBe(0);
    expect(emptied.dailyActuals).toEqual([]);
    // A later save still works on the (empty but defined) entry list.
    const reSaved = applyDailyExecutionEntry(emptied, entry({ pass: 1, fail: 0, notApplicable: 0, spo: 0 }));
    expect(reSaved.casesCompleted).toBe(1);
    expect(reSaved.dailyActuals).toHaveLength(1);
  });

  it('removeDailyExecutionEntry is a no-op for legacy inputs (no entries) and unknown dates', () => {
    const legacy = inputs({ casesCompleted: 42, casesPassed: 40 });
    expect(removeDailyExecutionEntry(legacy, D1)).toBe(legacy);
    const withEntries = applyDailyExecutionEntry(inputs(), entry({ pass: 1, fail: 0, notApplicable: 0, spo: 0 }));
    expect(removeDailyExecutionEntry(withEntries, D3)).toBe(withEntries);
  });
});

// ---- migration ------------------------------------------------------------------

describe('V7 migration of legacy actuals', () => {
  it('is idempotent (projects with dailyExecuted are returned unchanged)', () => {
    const withEntries = inputs({ dailyExecuted: [entry()] });
    expect(migrateDailyExecuted(withEntries, D3)).toBe(withEntries);
  });

  it('no snapshots → one opening entry dated today with the current totals', () => {
    const migrated = migrateDailyExecuted(
      inputs({ casesCompleted: 15, casesPassed: 11, casesFailed: 0, casesNotApplicable: 0, spoAssigned: 0 }),
      D3,
    );
    expect(migrated.dailyExecuted).toHaveLength(1);
    expect(migrated.dailyExecuted![0].date).toBe(D3);
    expect(migrated.dailyExecuted![0].pass).toBe(11);
    expect(migrated.dailyExecuted![0].uncategorizedCompleted).toBe(4);
    // Invariant: totals preserved.
    expect(migrated.casesCompleted).toBe(15);
    expect(migrated.casesPassed).toBe(11);
  });

  it('granular snapshots → exact per-status per-day deltas; every field total is preserved', () => {
    const migrated = migrateDailyExecuted(
      inputs({
        casesCompleted: 90,
        casesPassed: 60,
        casesFailed: 5,
        casesNotApplicable: 5,
        spoAssigned: 20,
        casesBlocked: 3,
        casesRetest: 2,
        casesQuestioned: 1,
        dailyActuals: [
          { id: 's1', date: D1, executed: 70, passed: 60 },
        ],
      }),
      D3,
    );
    // The non-granular snapshot day keeps its executed/passed; the rest is
    // attributed greedily (fail first, then N/A, then SPO) within its budget.
    const day1 = migrated.dailyExecuted!.find((e) => e.date === D1)!;
    expect(day1.pass).toBe(60);
    expect(entryCompletedCases(day1)).toBe(70);
    const residual = migrated.dailyExecuted!.find((e) => e.date === D3)!;
    expect(entryCompletedCases(residual)).toBe(20);
    // Per-field invariants (internally consistent data).
    expect(migrated.casesCompleted).toBe(90);
    expect(migrated.casesPassed).toBe(60);
    expect(migrated.casesFailed).toBe(5);
    expect(migrated.casesNotApplicable).toBe(5);
    expect(migrated.spoAssigned).toBe(20);
    expect(migrated.casesBlocked).toBe(3);
    expect(migrated.casesRetest).toBe(2);
    expect(migrated.casesQuestioned).toBe(1);
    // Legacy snapshots survive verbatim (regeneration happens on UI saves).
    expect(migrated.dailyActuals).toEqual([{ id: 's1', date: D1, executed: 70, passed: 60 }]);
  });

  it('granular (V6.5) snapshots distribute their exact per-status deltas', () => {
    const migrated = migrateDailyExecuted(
      inputs({
        casesCompleted: 80,
        casesPassed: 58,
        casesFailed: 4,
        casesNotApplicable: 3,
        spoAssigned: 15,
        casesBlocked: 2,
        casesRetest: 1,
        casesQuestioned: 1,
        dailyActuals: [
          {
            id: 's1', date: D1, executed: 40, passed: 30,
            casesPassed: 30, casesFailed: 2, casesNotApplicable: 3, spoAssigned: 5,
            casesBlocked: 2, casesRetest: 1, casesQuestioned: 1,
          },
        ],
      }),
      D3,
    );
    const day1 = migrated.dailyExecuted!.find((e) => e.date === D1)!;
    expect(day1.pass).toBe(30);
    expect(day1.fail).toBe(2);
    expect(day1.notApplicable).toBe(3);
    expect(day1.spo).toBe(5);
    expect(day1.blocked).toBe(2);
    expect(day1.retest).toBe(1);
    expect(day1.questioned).toBe(1);
    expect(day1.uncategorizedCompleted ?? 0).toBe(0);
    const residual = migrated.dailyExecuted!.find((e) => e.date === D3)!;
    expect(residual.pass).toBe(28);
    expect(residual.fail).toBe(2);
    expect(residual.spo).toBe(10);
    expect(migrated.casesCompleted).toBe(80);
  });

  it('the residual merges into today when the latest snapshot is from today', () => {
    const today = D2;
    const migrated = migrateDailyExecuted(
      inputs({
        casesCompleted: 50,
        casesPassed: 40,
        casesFailed: 5,
        casesNotApplicable: 5,
        spoAssigned: 0,
        dailyActuals: [{ id: 's1', date: D2, executed: 30, passed: 25 }],
      }),
      today,
    );
    expect(migrated.dailyExecuted).toHaveLength(1); // one entry per date
    const only = migrated.dailyExecuted![0];
    expect(only.date).toBe(today);
    expect(only.pass).toBe(40);
    expect(entryCompletedCases(only)).toBe(50);
    expect(migrated.casesCompleted).toBe(50);
  });
});

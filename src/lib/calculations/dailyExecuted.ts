import type { DailyActualSnapshot, DailyExecutionEntry, QaInputs } from '../../types';
import { clampOvertimeMinutes, NO_LUNCH, WORK_DAY_END, WORK_LUNCH, rowDayWindow, projectDayWindowDefaults, type DayWindow } from './workday';
import { snapshotPass } from './history';

/**
 * V7 — Daily execution layer (pure; no React, no storage, no clock).
 *
 * DailyExecutionEntry records are the single source of truth for ACTUAL
 * execution: one entry per date holding that day's time window, tester
 * count and status counts. The legacy cumulative QaInputs fields
 * (casesCompleted, casesPassed, casesFailed, …) become a MAINTAINED
 * PROJECTION — syncActualsFromDailyExecuted recomputes them as the sum of
 * the entries, and dailyActuals snapshots are regenerated as the
 * cumulative-at-end-of-day totals so every existing engine reader (status,
 * pace, recovery, exports, reports, performance) keeps working unchanged.
 *
 * Composition (unchanged V6.4 semantics):
 *   day completed = Pass + Fail + N/A + SPO (+ uncategorizedCompleted)
 *   Blocked / Retest / Questioned are informational open-status tallies.
 */

function nonNegativeInt(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

/** A day's completed cases (the four completed categories + migrated remainder). */
export function entryCompletedCases(entry: DailyExecutionEntry): number {
  return (
    nonNegativeInt(entry.pass) +
    nonNegativeInt(entry.fail) +
    nonNegativeInt(entry.notApplicable) +
    nonNegativeInt(entry.spo) +
    nonNegativeInt(entry.uncategorizedCompleted)
  );
}

/** Entries sorted chronologically (date, then id for stable same-day order). */
export function sortDailyExecuted(entries: readonly DailyExecutionEntry[]): DailyExecutionEntry[] {
  return [...entries].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

/** The canonical cumulative fields as sums over the daily entries. */
export interface ExecutedTotals {
  casesCompleted: number;
  casesPassed: number;
  casesFailed: number;
  casesNotApplicable: number;
  spoAssigned: number;
  casesBlocked: number;
  casesRetest: number;
  casesQuestioned: number;
}

/** Sum the daily entries into the canonical cumulative fields (pure). */
export function aggregateDailyExecuted(entries: readonly DailyExecutionEntry[]): ExecutedTotals {
  const totals: ExecutedTotals = {
    casesCompleted: 0,
    casesPassed: 0,
    casesFailed: 0,
    casesNotApplicable: 0,
    spoAssigned: 0,
    casesBlocked: 0,
    casesRetest: 0,
    casesQuestioned: 0,
  };
  for (const entry of sortDailyExecuted(entries)) {
    totals.casesCompleted += entryCompletedCases(entry);
    totals.casesPassed += nonNegativeInt(entry.pass);
    totals.casesFailed += nonNegativeInt(entry.fail);
    totals.casesNotApplicable += nonNegativeInt(entry.notApplicable);
    totals.spoAssigned += nonNegativeInt(entry.spo);
    totals.casesBlocked += nonNegativeInt(entry.blocked);
    totals.casesRetest += nonNegativeInt(entry.retest);
    totals.casesQuestioned += nonNegativeInt(entry.questioned);
  }
  return totals;
}

/**
 * Upsert one entry into the list — exactly ONE entry per date (saving an
 * existing date replaces it, keeping its id so React keys stay stable).
 */
export function upsertDailyExecutionEntry(
  entries: readonly DailyExecutionEntry[],
  entry: DailyExecutionEntry,
): DailyExecutionEntry[] {
  const existing = entries.find((e) => e.date === entry.date);
  const next = existing === undefined ? entry : { ...entry, id: existing.id };
  return sortDailyExecuted([...entries.filter((e) => e.date !== entry.date), next]);
}

/** The entry recorded for a date (null when that day has none). */
export function entryForDate(entries: readonly DailyExecutionEntry[], date: string): DailyExecutionEntry | null {
  return entries.find((e) => e.date === date) ?? null;
}

// ---- cumulative (total) input mode -------------------------------------------

/**
 * Per-status running totals as entered in the form's cumulative input mode
 * (the totals as of the end of the selected date). `uncategorizedCompleted`
 * stays a direct per-day value even in cumulative mode, so it is not part
 * of this shape.
 */
export interface ExecutionStatusTotals {
  pass: number;
  fail: number;
  notApplicable: number;
  spo: number;
  blocked: number;
  retest: number;
  questioned: number;
}

function sumStatusTotals(entries: readonly DailyExecutionEntry[]): ExecutionStatusTotals {
  const totals: ExecutionStatusTotals = {
    pass: 0,
    fail: 0,
    notApplicable: 0,
    spo: 0,
    blocked: 0,
    retest: 0,
    questioned: 0,
  };
  for (const entry of entries) {
    totals.pass += nonNegativeInt(entry.pass);
    totals.fail += nonNegativeInt(entry.fail);
    totals.notApplicable += nonNegativeInt(entry.notApplicable);
    totals.spo += nonNegativeInt(entry.spo);
    totals.blocked += nonNegativeInt(entry.blocked);
    totals.retest += nonNegativeInt(entry.retest);
    totals.questioned += nonNegativeInt(entry.questioned);
  }
  return totals;
}

/** Running totals over the entries recorded STRICTLY BEFORE the date (pure). */
export function cumulativeBeforeDate(entries: readonly DailyExecutionEntry[], date: string): ExecutionStatusTotals {
  return sumStatusTotals(sortDailyExecuted(entries).filter((e) => e.date < date));
}

/** Running totals over the entries recorded ON OR BEFORE the date (pure). */
export function cumulativeThroughDate(entries: readonly DailyExecutionEntry[], date: string): ExecutionStatusTotals {
  return sumStatusTotals(sortDailyExecuted(entries).filter((e) => e.date <= date));
}

/**
 * The selected day's per-status counts from entered running totals: the
 * delta against everything recorded before that date, clamped at zero per
 * field (a decreasing total — e.g. unblocked cases — never yields a
 * negative day count).
 */
export function dailyDeltaFromTotals(entered: ExecutionStatusTotals, previous: ExecutionStatusTotals): ExecutionStatusTotals {
  const clamp = (value: number): number => nonNegativeInt(value);
  return {
    pass: clamp(entered.pass - previous.pass),
    fail: clamp(entered.fail - previous.fail),
    notApplicable: clamp(entered.notApplicable - previous.notApplicable),
    spo: clamp(entered.spo - previous.spo),
    blocked: clamp(entered.blocked - previous.blocked),
    retest: clamp(entered.retest - previous.retest),
    questioned: clamp(entered.questioned - previous.questioned),
  };
}

/**
 * Regenerate the end-of-day cumulative snapshots from the entries (V7):
 * snapshot[i] = cumulative totals after day i. Granular fields are the
 * running sums; the legacy executed/passed aggregates carry the same
 * completed/pass totals, so the existing history/trend layer reads them
 * unchanged.
 */
export function regenerateSnapshotsFromEntries(entries: readonly DailyExecutionEntry[]): DailyActualSnapshot[] {
  const snapshots: DailyActualSnapshot[] = [];
  let executed = 0;
  let passed = 0;
  let failed = 0;
  let notApplicable = 0;
  let spo = 0;
  let blocked = 0;
  let retest = 0;
  let questioned = 0;
  for (const entry of sortDailyExecuted(entries)) {
    executed += entryCompletedCases(entry);
    passed += nonNegativeInt(entry.pass);
    failed += nonNegativeInt(entry.fail);
    notApplicable += nonNegativeInt(entry.notApplicable);
    spo += nonNegativeInt(entry.spo);
    blocked += nonNegativeInt(entry.blocked);
    retest += nonNegativeInt(entry.retest);
    questioned += nonNegativeInt(entry.questioned);
    snapshots.push({
      id: entry.id,
      date: entry.date,
      executed,
      passed,
      casesPassed: passed,
      casesFailed: failed,
      casesNotApplicable: notApplicable,
      spoAssigned: spo,
      casesBlocked: blocked,
      casesRetest: retest,
      casesQuestioned: questioned,
    });
  }
  return snapshots;
}

/**
 * Recompute the canonical cumulative fields from the daily entries (pure —
 * returns a new inputs object). The dailyActuals snapshots are NOT touched:
 * they stay whatever is stored (legacy snapshots remain verbatim; the UI
 * regenerates them when a daily entry is saved). When `dailyExecuted` is
 * absent the inputs are returned unchanged (legacy projects keep their
 * authoritative cumulative fields until migrated).
 */
export function syncActualsFromDailyExecuted<T extends QaInputs>(inputs: T): T {
  if (inputs.dailyExecuted === undefined) return inputs;
  const totals = aggregateDailyExecuted(inputs.dailyExecuted);
  return {
    ...inputs,
    casesCompleted: totals.casesCompleted,
    casesPassed: totals.casesPassed,
    casesFailed: totals.casesFailed,
    casesNotApplicable: totals.casesNotApplicable,
    spoAssigned: totals.spoAssigned,
    casesBlocked: totals.casesBlocked,
    casesRetest: totals.casesRetest,
    casesQuestioned: totals.casesQuestioned,
  };
}

/**
 * Save one day's execution into the inputs (used by the UI action):
 * upserts the entry (one per date), recomputes the canonical cumulative
 * fields as Σ entries AND regenerates the end-of-day snapshots from the
 * entries — the one place snapshots are rebuilt, because the entries are
 * now the single source of truth.
 */
export function applyDailyExecutionEntry<T extends QaInputs>(inputs: T, entry: DailyExecutionEntry): T {
  const dailyExecuted = upsertDailyExecutionEntry(inputs.dailyExecuted ?? [], entry);
  const synced = syncActualsFromDailyExecuted({ ...inputs, dailyExecuted });
  return { ...synced, dailyActuals: regenerateSnapshotsFromEntries(dailyExecuted) };
}

/**
 * Delete one day's entry (the UI delete action): drops the entry for the
 * date and recomputes the canonical projection exactly like a save —
 * cumulative fields become Σ remaining entries and the snapshots are
 * regenerated without that day. A no-op when `dailyExecuted` is absent
 * (legacy projects stay untouched).
 */
export function removeDailyExecutionEntry<T extends QaInputs>(inputs: T, date: string): T {
  if (inputs.dailyExecuted === undefined || !inputs.dailyExecuted.some((e) => e.date === date)) return inputs;
  const dailyExecuted = inputs.dailyExecuted.filter((e) => e.date !== date);
  const synced = syncActualsFromDailyExecuted({ ...inputs, dailyExecuted });
  return { ...synced, dailyActuals: regenerateSnapshotsFromEntries(dailyExecuted) };
}

// ---- migration ---------------------------------------------------------------

/** Snapshot totals in the canonical composition semantics. */
interface SnapshotCumulative {
  executed: number;
  passed: number;
  failed: number;
  notApplicable: number;
  spo: number;
  blocked: number;
  retest: number;
  questioned: number;
  /** True when every V6.5 granular field was recorded. */
  granularKnown: boolean;
}

function snapshotCumulative(snapshot: DailyActualSnapshot): SnapshotCumulative {
  const granularKnown =
    snapshot.casesFailed !== undefined &&
    snapshot.casesNotApplicable !== undefined &&
    snapshot.spoAssigned !== undefined &&
    snapshot.casesBlocked !== undefined &&
    snapshot.casesRetest !== undefined &&
    snapshot.casesQuestioned !== undefined &&
    snapshot.casesPassed !== undefined;
  return {
    executed: Math.max(0, snapshot.executed),
    passed: Math.max(0, snapshotPass(snapshot)),
    failed: Math.max(0, snapshot.casesFailed ?? 0),
    notApplicable: Math.max(0, snapshot.casesNotApplicable ?? 0),
    spo: Math.max(0, snapshot.spoAssigned ?? 0),
    blocked: Math.max(0, snapshot.casesBlocked ?? 0),
    retest: Math.max(0, snapshot.casesRetest ?? 0),
    questioned: Math.max(0, snapshot.casesQuestioned ?? 0),
    granularKnown,
  };
}

/**
 * Migrate a legacy project (cumulative fields ± end-of-day snapshots) to
  * per-day entries. Pure and idempotent — projects that already carry
  * dailyExecuted are returned unchanged.
  *
  * Method: the per-day EXECUTED/PASSED deltas are reliable for every
  * snapshot; the granular status splits are only known for granular (V6.5)
  * snapshots. Each day's unattributed completed budget (executed − passed
  * delta) is filled greedily from the remaining fail/N-A/SPO totals (fixed
  * order), so the per-field sums are preserved whenever the data is
  * internally consistent; a leftover remainder stays honestly in
  * uncategorizedCompleted (never invented as a status). Blocked/Retest/
  * Questioned deltas (independent open tallies) come from granular
  * snapshots, with the remainder landing on the residual day. The residual
  * (current totals − latest snapshot) is one entry dated today (merging
  * into today's entry when the latest snapshot is from today); no snapshots
  * at all → a single opening entry dated today.
  *
  * Invariant (for internally consistent data): Σ entries equals the
  * previous canonical cumulative fields per field, so every engine
  * calculation is unchanged after migration. The LEGACY dailyActuals
  * snapshots are preserved verbatim — they remain accurate cumulative
  * records; snapshots are regenerated from entries only once a daily entry
  * is saved through the UI.
  */
export function migrateDailyExecuted<T extends QaInputs>(inputs: T, today: string): T {
  if (inputs.dailyExecuted !== undefined) return inputs;
  const snapshots = sortSnapshots(inputs.dailyActuals ?? []);
  const zero: SnapshotCumulative = {
    executed: 0,
    passed: 0,
    failed: 0,
    notApplicable: 0,
    spo: 0,
    blocked: 0,
    retest: 0,
    questioned: 0,
    granularKnown: true,
  };

  // One draft per recorded day plus the residual day (dated today).
  interface DayDraft {
    date: string;
    pass: number;
    /** Completed cases not attributed to Pass yet (the greedy fill budget). */
    budget: number;
    fail: number;
    notApplicable: number;
    spo: number;
    blocked: number;
    retest: number;
    questioned: number;
  }
  const drafts: DayDraft[] = [];
  let previous: SnapshotCumulative = zero;
  for (const snapshot of snapshots) {
    const current = snapshotCumulative(snapshot);
    const dExecuted = Math.max(0, current.executed - previous.executed);
    const dPass = Math.min(Math.max(0, current.passed - previous.passed), dExecuted);
    const nonPass = Math.max(0, dExecuted - dPass);
    if (dExecuted > 0 || dPass > 0) {
      const fail = current.granularKnown ? Math.min(Math.max(0, current.failed - previous.failed), nonPass) : 0;
      const notApplicable = current.granularKnown ? Math.min(Math.max(0, current.notApplicable - previous.notApplicable), nonPass - fail) : 0;
      const spo = current.granularKnown ? Math.min(Math.max(0, current.spo - previous.spo), nonPass - fail - notApplicable) : 0;
      drafts.push({
        date: snapshot.date,
        pass: dPass,
        // The greedy-fill budget is what the granular deltas could NOT
        // attribute (0 for fully granular consistent days).
        budget: Math.max(0, nonPass - fail - notApplicable - spo),
        fail,
        notApplicable,
        spo,
        blocked: current.granularKnown ? Math.max(0, current.blocked - previous.blocked) : 0,
        retest: current.granularKnown ? Math.max(0, current.retest - previous.retest) : 0,
        questioned: current.granularKnown ? Math.max(0, current.questioned - previous.questioned) : 0,
      });
    }
    previous = current;
  }
  const residualExecuted = Math.max(0, inputs.casesCompleted - previous.executed);
  const residualPass = Math.min(Math.max(0, (inputs.casesPassed ?? 0) - previous.passed), residualExecuted);
  const hasResidual =
    residualExecuted > 0 ||
    residualPass > 0 ||
    Math.max(0, (inputs.casesBlocked ?? 0) - previous.blocked) > 0 ||
    Math.max(0, (inputs.casesRetest ?? 0) - previous.retest) > 0 ||
    Math.max(0, (inputs.casesQuestioned ?? 0) - previous.questioned) > 0;
  if (hasResidual) {
    drafts.push({
      date: today,
      pass: residualPass,
      budget: Math.max(0, residualExecuted - residualPass),
      fail: 0,
      notApplicable: 0,
      spo: 0,
      blocked: Math.max(0, (inputs.casesBlocked ?? 0) - previous.blocked),
      retest: Math.max(0, (inputs.casesRetest ?? 0) - previous.retest),
      questioned: Math.max(0, (inputs.casesQuestioned ?? 0) - previous.questioned),
    });
  }

  // One entry per date: when the latest snapshot is from today, its draft
  // and the residual draft share the date and are merged (sums, greedy
  // budget included).
  const mergedDrafts: DayDraft[] = [];
  for (const draft of drafts) {
    const existing = mergedDrafts.find((d) => d.date === draft.date);
    if (existing === undefined) {
      mergedDrafts.push({ ...draft });
    } else {
      existing.pass += draft.pass;
      existing.budget += draft.budget;
      existing.fail += draft.fail;
      existing.notApplicable += draft.notApplicable;
      existing.spo += draft.spo;
      existing.blocked += draft.blocked;
      existing.retest += draft.retest;
      existing.questioned += draft.questioned;
    }
  }

  // Greedy fill of every day's unattributed completed budget from the
  // remaining fail/N-A/SPO totals (fixed order; per-field sums preserved).
  const remaining = {
    fail: Math.max(0, (inputs.casesFailed ?? 0) - mergedDrafts.reduce((s, d) => s + d.fail, 0)),
    notApplicable: Math.max(0, (inputs.casesNotApplicable ?? 0) - mergedDrafts.reduce((s, d) => s + d.notApplicable, 0)),
    spo: Math.max(0, (inputs.spoAssigned ?? 0) - mergedDrafts.reduce((s, d) => s + d.spo, 0)),
  };
  const entries: DailyExecutionEntry[] = mergedDrafts.map((draft) => {
    let budget = draft.budget;
    const take = (value: number): number => {
      const used = Math.min(value, budget);
      budget -= used;
      return used;
    };
    const fail = take(remaining.fail);
    remaining.fail -= fail;
    const notApplicable = take(remaining.notApplicable);
    remaining.notApplicable -= notApplicable;
    const spo = take(remaining.spo);
    remaining.spo -= spo;
    const uncategorized = budget; // what the recorded data cannot attribute
    return {
      // Deterministic id (one entry per date) so migrations are reproducible.
      id: `migrated-${draft.date}`,
      date: draft.date,
      startTime: null,
      endTime: null,
      overtimeMinutes: 0,
      intervalEnabled: true,
      testers: 0,
      pass: draft.pass,
      fail: draft.fail + fail,
      notApplicable: draft.notApplicable + notApplicable,
      spo: draft.spo + spo,
      blocked: draft.blocked,
      retest: draft.retest,
      questioned: draft.questioned,
      uncategorizedCompleted: uncategorized > 0 ? uncategorized : 0,
      note: '',
    };
  });

  // Legacy snapshots stay verbatim (sync no longer regenerates them): they
  // remain accurate cumulative records; regeneration happens on the first
  // UI entry save.
  return syncActualsFromDailyExecuted({ ...inputs, dailyExecuted: entries });
}

function sortSnapshots(snapshots: readonly DailyActualSnapshot[]): DailyActualSnapshot[] {
  return [...snapshots].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

// ---- today's effective window -----------------------------------------------

/**
 * The window that actually applies TODAY for pace calculations (V7):
 * today's entry when one exists (actual start/interval recorded), otherwise
 * the planned window for today's row, otherwise the project defaults. The
 * end always includes overtime; the lunch is the fixed interval or none.
 */
export function effectiveTodayWindow(
  inputs: Pick<QaInputs, 'startTime' | 'dailyOvertimeMinutes' | 'intervalEnabled' | 'planningRows'> & {
    dailyExecuted?: DailyExecutionEntry[];
  },
  today: string,
): DayWindow {
  const entry = entryForDate(inputs.dailyExecuted ?? [], today);
  if (entry !== null) {
    return {
      start: entry.startTime ?? inputs.startTime,
      end: (entry.endTime ?? WORK_DAY_END) + clampOvertimeMinutes(entry.overtimeMinutes),
      lunch: entry.intervalEnabled ? WORK_LUNCH : NO_LUNCH,
    };
  }
  const defaults = projectDayWindowDefaults(inputs);
  const row = inputs.planningRows.find((r) => r.date === today);
  return row !== undefined ? rowDayWindow(row, defaults) : defaults;
}

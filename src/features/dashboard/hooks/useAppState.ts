import { useCallback, useState } from 'react';
import type { AppState, DailyExecutionEntry, PlanningRow, PlanningRowPatch } from '../../../types';
import { DEMO_STATE, loadState, normalizeAppState } from '../../../lib/storage/storage';
import { formatDate, parseDate, todayEpochDays } from '../../../lib/dates/dates';
import { nextBusinessDayEpoch } from '../../../lib/dates/businessDays';
import { generateId } from '../../../lib/id';
import { applyDailyExecutionEntry, removeDailyExecutionEntry } from '../../../lib/calculations/dailyExecuted';

/** Simple (non-planning) fields; planning state has dedicated handlers below. */
export type ScalarField = Exclude<keyof AppState, 'planningRows' | 'startDate'>;

export interface AppStateApi {
  state: AppState;
  updateField: <K extends ScalarField>(key: K, value: AppState[K]) => void;
  replaceState: (next: AppState) => void;
  resetToDemo: () => void;
  /** Changing the start date shifts the whole plan, keeping day offsets. */
  changeStartDate: (date: string) => void;
  updatePlanningRow: (index: number, patch: PlanningRowPatch) => void;
  /** Add the next sequential day; optionally copying the last row's values. */
  addPlanningRow: (copyPrevious: boolean) => void;
  removePlanningRow: (index: number) => void;
  /**
   * Save one day's ACTUAL execution (V7): upserts the entry (one per date),
   * recomputes the canonical cumulative fields as Σ entries, regenerates the
   * end-of-day snapshots, and — when saving TODAY's entry with a positive
   * tester count — syncs currentTesters (still directly editable afterwards).
   */
  saveDailyExecutionEntry: (entry: DailyExecutionEntry) => void;
  /**
   * Delete one day's execution entry (the day itself, not just its counts):
   * cumulative totals and snapshots are recomputed from the remaining days.
   */
  deleteDailyExecutionEntry: (date: string) => void;
}

/**
 * Application state (raw inputs + language only — never derived values).
 * Persistence is centralized in AppProviders (V6.3 §5): this hook owns the
 * canonical state and its actions. The initial state comes from the V6.6
 * startup bootstrap (IndexedDB after migration, or the localStorage loaders
 * in fallback mode — both already applied the v1→v2 / schema migrations);
 * on storage problems the app falls back to demo defaults and keeps running
 * in-memory.
 */
export function useAppState(initial?: AppState): AppStateApi {
  const [state, setState] = useState<AppState>(() => initial ?? loadState());

  const updateField = useCallback(<K extends ScalarField>(key: K, value: AppState[K]): void => {
    setState((prev) => ({ ...prev, [key]: value }));
  }, []);

  const replaceState = useCallback((next: AppState): void => {
    setState(next);
  }, []);

  /** Reset to default demo data (§27); UI preferences (language, view) are kept. */
  const resetToDemo = useCallback((): void => {
    setState((prev) => ({
      ...normalizeAppState({ ...DEMO_STATE }),
      language: prev.language,
      dashboardView: prev.dashboardView,
    }));
  }, []);

  /**
   * Apply a planning-row mutation, then keep startDate mirroring the first
   * row's date (the single consistency rule for the stored start date).
   */
  const mutateRows = useCallback((updater: (rows: PlanningRow[]) => PlanningRow[]): void => {
    setState((prev) => {
      const rows = updater(prev.planningRows);
      return { ...prev, planningRows: rows, startDate: rows.length > 0 ? rows[0].date : prev.startDate };
    });
  }, []);

  const changeStartDate = useCallback((date: string): void => {
    setState((prev) => {
      const newStart = parseDate(date);
      if (newStart === null) return prev;
      const firstDate = prev.planningRows.length > 0 ? prev.planningRows[0].date : prev.startDate;
      const oldStart = parseDate(firstDate);
      const delta = oldStart === null ? 0 : newStart - oldStart;
      const rows = prev.planningRows.map((row) => {
        const d = parseDate(row.date);
        return d === null ? row : { ...row, date: formatDate(d + delta) };
      });
      return { ...prev, planningRows: rows, startDate: rows.length > 0 ? rows[0].date : date };
    });
  }, []);

  const updatePlanningRow = useCallback(
    (index: number, patch: PlanningRowPatch): void => {
      mutateRows((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
    },
    [mutateRows],
  );

  const addPlanningRow = useCallback(
    (copyPrevious: boolean): void => {
      mutateRows((rows) => {
        const last = rows.length > 0 ? rows[rows.length - 1] : undefined;
        const lastEpoch = last !== undefined ? parseDate(last.date) ?? todayEpochDays() : todayEpochDays();
        const row: PlanningRow = {
          id: generateId(),
          // "Next day" is the next business day — weekends and Japanese
          // public holidays are never planned automatically.
          date: formatDate(nextBusinessDayEpoch(lastEpoch)),
          plannedTesters: last?.plannedTesters ?? 1,
          absentTesters: copyPrevious ? last?.absentTesters ?? 0 : 0,
          nonWorkingDay: copyPrevious ? last?.nonWorkingDay ?? false : false,
          note: copyPrevious ? last?.note ?? '' : '',
          // V7: duplicating a row copies its per-day window overrides too.
          ...(copyPrevious
            ? {
                startTime: last?.startTime,
                endTime: last?.endTime,
                overtimeMinutes: last?.overtimeMinutes,
                intervalEnabled: last?.intervalEnabled,
              }
            : {}),
        };
        return [...rows, row];
      });
    },
    [mutateRows],
  );

  const removePlanningRow = useCallback(
    (index: number): void => {
      mutateRows((rows) => (rows.length <= 1 ? rows : rows.filter((_, i) => i !== index)));
    },
    [mutateRows],
  );

  const saveDailyExecutionEntry = useCallback((entry: DailyExecutionEntry): void => {
    setState((prev) => {
      const synced = applyDailyExecutionEntry(prev, entry);
      // Saving today's entry syncs the tester count (still editable).
      const today = formatDate(todayEpochDays());
      if (entry.date === today && entry.testers > 0) {
        return { ...synced, currentTesters: entry.testers };
      }
      return synced;
    });
  }, []);

  const deleteDailyExecutionEntry = useCallback((date: string): void => {
    setState((prev) => removeDailyExecutionEntry(prev, date));
  }, []);

  return {
    state,
    updateField,
    replaceState,
    resetToDemo,
    changeStartDate,
    updatePlanningRow,
    addPlanningRow,
    removePlanningRow,
    saveDailyExecutionEntry,
    deleteDailyExecutionEntry,
  };
}

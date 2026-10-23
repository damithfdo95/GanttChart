import type { PerformanceRecordSource, TesterDailyPerformance } from '../../types';
import { generateId } from '../../lib/id';

/**
 * Tester daily-execution record operations (V6.6 §12). Pure array helpers
 * — callers apply the result through the app-state actions so persistence
 * stays centralized. Records live inside the owning project's QaInputs
 * (project isolation by construction).
 *
 * V6.7: records carry an optional `source` so the supervisor can see how
 * each record was created; manual edits of an automatic/assisted record
 * mark it as a manual override that synchronization never overwrites.
 */

export interface TesterDailyInput {
  date: string;
  testerName: string;
  /** Stable RCS member identity (V6.8); absent for legacy name-only entries. */
  memberId?: string;
  team?: string;
  casesTested: number;
  casesPassed?: number;
  casesFailed?: number;
  casesNotApplicable?: number;
  casesBlocked?: number;
  casesRetest?: number;
  casesQuestioned?: number;
  casesSpoAssigned?: number;
  source?: PerformanceRecordSource;
}

/**
 * Upsert by natural key (projectId, date, tester identity). The identity is
 * the memberId when present (V6.8), falling back to the tester name — an
 * existing record for the same tester and day is replaced — testers never
 * get two rows for one day — while all other records keep their position
 * and ids. The replaced record keeps its stable id.
 */
export function upsertTesterDailyPerformance(
  records: readonly TesterDailyPerformance[],
  projectId: string,
  input: TesterDailyInput,
): TesterDailyPerformance[] {
  const testerName = input.testerName.trim();
  const next: TesterDailyPerformance = {
    id: generateId(),
    date: input.date,
    testerName,
    ...(input.memberId !== undefined && input.memberId !== '' ? { memberId: input.memberId } : {}),
    team: input.team,
    projectId,
    casesTested: Math.max(0, input.casesTested),
    casesPassed: input.casesPassed,
    casesFailed: input.casesFailed,
    casesNotApplicable: input.casesNotApplicable,
    casesBlocked: input.casesBlocked,
    casesRetest: input.casesRetest,
    casesQuestioned: input.casesQuestioned,
    casesSpoAssigned: input.casesSpoAssigned,
    source: input.source,
  };
  const index = records.findIndex((record) => {
    if (record.projectId !== projectId || record.date !== input.date) return false;
    if (input.memberId !== undefined && input.memberId !== '') {
      return record.memberId === input.memberId || record.testerName === testerName;
    }
    return record.testerName === testerName && record.memberId === undefined;
  });
  if (index === -1) return [...records, next];
  const existing = records[index];
  if (existing === undefined) return [...records, next];
  const copy = [...records];
  copy[index] = { ...next, id: existing.id };
  return copy;
}

/** Remove one record by id. */
export function removeTesterDailyPerformance(
  records: readonly TesterDailyPerformance[],
  id: string,
): TesterDailyPerformance[] {
  return records.filter((record) => record.id !== id);
}

/** The existing record for (projectId, date, tester identity), if any. */
export function findTesterDailyPerformance(
  records: readonly TesterDailyPerformance[],
  projectId: string,
  date: string,
  testerName: string,
  memberId?: string,
): TesterDailyPerformance | undefined {
  const name = testerName.trim();
  return records.find((record) => {
    if (record.projectId !== projectId || record.date !== date) return false;
    if (memberId !== undefined && memberId !== '') {
      return record.memberId === memberId || record.testerName === name;
    }
    return record.testerName === name && record.memberId === undefined;
  });
}

/**
 * Adopt records recorded under one of the member's known names (the exact
 * recorded display name) into the member's stable identity: every record
 * whose testerName matches (case-insensitive, whitespace-collapsed) and has
 * no memberId yet gets the memberId stamped. Records already linked to
 * another member are never touched. Pure — the caller applies the result
 * through the state actions so persistence stays centralized.
 *
 * Used when a TestRail user is linked to a Team Member: the records the
 * fetch wrote under the TestRail display name become the member's records
 * immediately, so the person never appears twice (linked + unlinked name).
 */
export function adoptRecordsIntoMember(
  records: readonly TesterDailyPerformance[],
  names: readonly string[],
  memberId: string,
): TesterDailyPerformance[] {
  const keys = new Set(names.map((name) => name.trim().toLowerCase()).filter((name) => name !== ''));
  if (keys.size === 0) return records as TesterDailyPerformance[];
  let changed = false;
  const next = records.map((record) => {
    if (record.memberId !== undefined || !keys.has(record.testerName.trim().toLowerCase())) return record;
    changed = true;
    return { ...record, memberId };
  });
  // Same reference when nothing changed so callers (the boot backfill) can
  // detect "nothing to heal" without deep comparison.
  return changed ? next : (records as TesterDailyPerformance[]);
}

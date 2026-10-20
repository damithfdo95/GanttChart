import { TM_LIMITS, type TestScope } from '../../../shared/testManagement';
import type { TestRailRunRef } from '../../../shared/testrail';
import { collapseWhitespace } from './jiraImport';

/**
 * TestRail run → Test Scope import mapping (Stage: TestRail run import).
 *
 * The TestRail lane fetches the runs of ONE plan (`getPlanRuns`) and imports
 * the selected runs as Test SCOPES through the EXISTING `newScope` pipeline —
 * the commit logic is not reimplemented, only reused, exactly like the JIRA
 * case import reuses `buildBulkCases`.
 *
 * Mapping decisions (documented because the scope shape is fixed):
 *  - ONE run becomes ONE scope. The scope name defaults to the run name,
 *    whitespace-collapsed and hard-capped at TM_LIMITS.scopeName (the same
 *    unit `checkScope` counts), so the default always passes validation. A
 *    run without a usable name falls back to "Run {id}" — never ''.
 *  - The scope's Total Test Cases comes from the run's status counts
 *    (`total`). TestRail exposes no total of its own; `TestRailRunProgress`
 *    computes the sum. A run without counts lands on 0, which is a valid
 *    (empty) Total — the SV can raise it later.
 *  - Each committed scope carries `testrail: { planId, runId }` — the LINK is
 *    the point of the import (the live progress readout keys off it). The
 *    link is shared data and syncs like every other scope field.
 *  - A run whose runId is ALREADY linked by ANY scope of the same project is
 *    SKIPPED (duplicate) — re-importing a plan must never create a second
 *    scope for the same run, mirroring `existingJiraImportKeys`. The same
 *    rule applies to a run appearing twice inside one plan (a defensive
 *    catch: the first occurrence counts, the second is a duplicate).
 *
 * Everything here is pure: no Date.now, no random ids, no fetch.
 */

/** Why one fetched run will not be offered for import. */
export type TestRailRunSkipReason = 'duplicate';

export interface TestRailRunImportRow {
  /** The fetched run this preview row describes. */
  run: TestRailRunRef;
  /** Whether the run may be selected and committed on confirm. */
  importable: boolean;
  /** The default scope name (the truncated run name) — the UI lets the SV edit it before commit. */
  name: string;
  /** The scope's would-be Total Test Cases (the run's total, 0 when the server exposed no counts). */
  totalTestCases: number;
  /** Why the run is skipped; null when importable. */
  skipReason: TestRailRunSkipReason | null;
}

export interface TestRailScopeImportPlan {
  /** One row per fetched run, in fetch order (skipped ones flagged). */
  rows: TestRailRunImportRow[];
  /** Runs that may be selected and committed. */
  importableCount: number;
  /** Runs skipped because a scope of this project already links their runId. */
  duplicateCount: number;
}

/**
 * The default scope name for a run: the run name, whitespace-collapsed and
 * capped at TM_LIMITS.scopeName UTF-16 code units (the unit `checkScope`
 * counts — a truncated value always passes validation). An empty result
 * falls back to "Run {id}" so the default is never rejected.
 */
export function defaultScopeName(runName: string, runId: number): string {
  const collapsed = collapseWhitespace(runName);
  const name = collapsed.length <= TM_LIMITS.scopeName ? collapsed : collapsed.slice(0, TM_LIMITS.scopeName);
  return name !== '' ? name : `Run ${runId}`;
}

/**
 * Pure import planning: one row per run of the plan, with the default scope
 * name and whether importing it would duplicate a link that already exists.
 *
 * `existingScopes` may contain scopes of other projects — only the scopes of
 * `projectId` that carry a `testrail` link count as "already linked" (a run
 * linked by a scope of ANOTHER project is not a duplicate for this one).
 */
export function planImportRows(runs: readonly TestRailRunRef[], existingScopes: readonly TestScope[], projectId: string): TestRailScopeImportPlan {
  const linkedRunIds = new Set<number>();
  for (const s of existingScopes) {
    if (s.projectId !== projectId || s.testrail === undefined) continue;
    linkedRunIds.add(s.testrail.runId);
  }
  // A run appearing twice inside ONE plan is a duplicate of itself: the first
  // occurrence stays importable, every later one is skipped (like the JIRA
  // batch rule: "same key twice in one batch → second one is a duplicate").
  const seen = new Set<number>();
  let importableCount = 0;
  let duplicateCount = 0;
  const rows: TestRailRunImportRow[] = runs.map((run) => {
    const duplicate = linkedRunIds.has(run.id) || seen.has(run.id);
    seen.add(run.id);
    if (duplicate) duplicateCount += 1;
    else importableCount += 1;
    return {
      run,
      importable: !duplicate,
      name: defaultScopeName(run.name, run.id),
      totalTestCases: run.progress?.total ?? 0,
      skipReason: duplicate ? 'duplicate' : null,
    };
  });
  return { rows, importableCount, duplicateCount };
}
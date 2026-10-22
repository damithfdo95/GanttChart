import type { CaseResult, CaseStatus, TestCase } from '../../../shared/testManagement';
import type { TestRailResultRow, TestRailTestRow } from '../../../shared/testrail';

/**
 * TestRail run results → per-case execution status sync (Stage: TestRail
 * result sync).
 *
 * The Execution tab fetches the tests and results of a linked run and maps
 * them onto the REGISTERED cases of that scope, matched by
 * `TestCase.testrailCaseId` (the id the case import stamps). The mapping is
 * a pure plan: the SV sees a preview (per-status counts, unmatched tests)
 * and confirms before anything is written.
 *
 * Matching rules (documented because they decide what the sync touches):
 *  - A test row joins a registered case by `caseId` ↔ `testrailCaseId`.
 *    Tests whose case is not registered are listed as unmatched — they are
 *    never guessed onto a case.
 *  - The CURRENT status comes from the test row (`statusId` at fetch
 *    time); the results are only used for the memo (the latest result's
 *    comment) and the defect reference. Latest = highest `createdOn`.
 *  - Built-in status ids map to the case statuses; ids ≥ 6 (custom) map to
 *    'inProgress' (the closest open category) and are counted separately so
 *    the preview can say so. Untested (3) / null maps to 'notStarted'.
 *  - A case whose mapped status EQUALS its current recorded status produces
 *    no patch (nothing is written — the same no-op rule as applyResultPatch).
 *
 * Everything here is pure: no Date.now, no random ids, no fetch.
 */

/** TestRail status id → the case execution status the sync writes. */
export function caseStatusFromTestRail(statusId: number | null): CaseStatus {
  switch (statusId) {
    case 1:
      return 'pass';
    case 2:
      return 'blocked';
    case 4:
      return 'inProgress'; // Retest: still open, being worked on
    case 5:
      return 'fail';
    case 3:
    case null:
      return 'notStarted';
    default:
      // Custom statuses (≥ 6): the closest open category, counted separately.
      return 'inProgress';
  }
}

export interface TestRailSyncPatch {
  /** The registered case the patch applies to. */
  testCase: TestCase;
  /** The status the sync would write. */
  status: CaseStatus;
  /** The latest result's comment (truncated), when there is one. */
  memo?: string;
  /** The latest result's defect reference, when there is one. */
  ticketRef?: string;
  /** True when the status came from a custom TestRail status (≥ 6). */
  customStatus: boolean;
}

export interface TestRailSyncPlan {
  /** One patch per registered case whose status would change, in case order. */
  patches: TestRailSyncPatch[];
  /** Tests of the run whose case is NOT registered in this scope (never guessed). */
  unmatchedCaseIds: number[];
  /** Registered cases whose status already matches (no patch needed). */
  unchangedCount: number;
  /** Patches whose status came from a custom TestRail status. */
  customStatusCount: number;
  /** Per-status counts of the patches, for the preview. */
  statusCounts: Record<CaseStatus, number>;
}

/** The memo/ticket of the LATEST result of a test (highest createdOn; ties → last in fetch order). */
function latestResult(results: readonly TestRailResultRow[], testId: number): TestRailResultRow | null {
  let best: TestRailResultRow | null = null;
  for (const r of results) {
    if (r.testId !== testId) continue;
    if (best === null || r.createdOn >= best.createdOn) best = r;
  }
  return best;
}

const MEMO_MAX = 500;

/**
 * Pure sync planning: map a run's tests (+ results) onto the registered
 * cases of one scope. `byCase` is the current results by case id (the
 * no-op detector); `cases` are the scope's registered cases.
 */
export function planTestRailResultSync(
  tests: readonly TestRailTestRow[],
  results: readonly TestRailResultRow[],
  cases: readonly TestCase[],
  byCase: ReadonlyMap<string, CaseResult>,
): TestRailSyncPlan {
  const caseByTestRailId = new Map<number, TestCase>();
  for (const c of cases) {
    if (c.testrailCaseId !== undefined) caseByTestRailId.set(c.testrailCaseId, c);
  }
  const testByCaseId = new Map<number, TestRailTestRow>();
  for (const t of tests) {
    if (t.caseId !== undefined) testByCaseId.set(t.caseId, t);
  }

  const statusCounts: Record<CaseStatus, number> = { notStarted: 0, inProgress: 0, pass: 0, fail: 0, na: 0, blocked: 0, spo: 0 };
  const patches: TestRailSyncPatch[] = [];
  const unmatchedCaseIds: number[] = [];
  let unchangedCount = 0;
  let customStatusCount = 0;

  for (const c of cases) {
    if (c.testrailCaseId === undefined) continue;
    const test = testByCaseId.get(c.testrailCaseId);
    if (test === undefined) continue; // the run has no test for this case
    const status = caseStatusFromTestRail(test.statusId);
    const current = byCase.get(c.id)?.status ?? 'notStarted';
    if (status === current) {
      unchangedCount += 1;
      continue;
    }
    const latest = latestResult(results, test.testId);
    const memo = latest?.comment !== undefined && latest.comment.trim() !== '' ? latest.comment.trim().slice(0, MEMO_MAX) : undefined;
    const ticketRef = latest?.defects !== undefined && latest.defects.trim() !== '' ? latest.defects.trim().slice(0, 200) : undefined;
    const custom = test.statusId !== null && test.statusId >= 6;
    if (custom) customStatusCount += 1;
    statusCounts[status] += 1;
    patches.push({
      testCase: c,
      status,
      ...(memo === undefined ? {} : { memo }),
      ...(ticketRef === undefined ? {} : { ticketRef }),
      customStatus: custom,
    });
  }

  for (const t of tests) {
    if (t.caseId === undefined) continue;
    if (!caseByTestRailId.has(t.caseId)) unmatchedCaseIds.push(t.caseId);
  }

  return { patches, unmatchedCaseIds, unchangedCount, customStatusCount, statusCounts };
}

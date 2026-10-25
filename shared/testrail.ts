/**
 * Shared TestRail integration types (Stage: TestRail import).
 *
 * TestRail's API v2 authenticates with HTTP Basic (email + API key) and is
 * read here for exactly one purpose: the day's test RESULTS of a linked
 * plan/run, attributed per tester. `TestRailResultRow` is the NORMALIZED
 * result shape every part of the app works with; only the fetch client in
 * `src/lib/testrail/` knows the raw API response.
 *
 * No network code lives here — `shared/` is imported by both the browser
 * app and the Cloudflare Worker, so it must stay environment-free.
 */

/**
 * Connection settings, entered by an SV in Settings → TestRail Integration.
 * All fields optional so the persisted shape backfills cleanly (the feature
 * is off until a base URL exists).
 */
export interface TestRailConnection {
  /** Instance root, e.g. `https://rkong.testrail.com`. No trailing slash. */
  baseUrl: string;
  /** The API user's email (TestRail Basic-auth user; usually the login email). */
  email?: string;
  /** API key generated in TestRail under My Settings → API Keys. Stored locally, never synced. */
  apiKey?: string;
  /**
   * Optional CORS-friendly proxy root. When set, ALL requests go to
   * `${proxyUrl}` + the original TestRail path instead of `baseUrl` (the
   * proxy forwards). TestRail sends no CORS headers, so browser
   * integrations effectively need this.
   */
  proxyUrl?: string;
}

/** One TestRail user (from get_users / get_user). */
export interface TestRailUser {
  id: number;
  /** Display name as TestRail shows it. */
  name: string;
  /** Organisation email when the account has one — links Team Members. */
  email?: string;
}

/**
 * One test run of a plan (or a standalone run).
 *
 * `progress` carries the run's CURRENT status counts exactly as TestRail's
 * plan/run objects expose them (flat `*_count` fields — there is no total in
 * the API, so `total` is the sum). The counts are per-run facts fetched
 * together with the run; they are not results and never become records.
 */
export interface TestRailRunRef {
  id: number;
  name: string;
  /** Suite id when the API exposed one on the run. */
  suiteId?: number;
  /** The TestRail project the run belongs to (get_run / plan runs report `project_id`); needed by get_cases. */
  projectId?: number;
  /** Config label(s), e.g. "Chrome" — plan entries create one run per config. */
  config?: string;
  /** The run's parent plan id — only present when the run was fetched through a plan. */
  planId?: number;
  /** The run's current status counts (missing on unusual servers → all zeros). */
  progress?: TestRailRunProgress;
}

/**
 * The status counts of one TestRail run. TestRail's API has no `total`: it
 * is the sum of the nine counts below (five built-ins + the seven custom
 * statuses). Custom statuses may be absent on older servers — the mapper
 * treats a missing field as 0, so a total computed here is always exact.
 */
export interface TestRailRunProgress {
  passed: number;
  blocked: number;
  retest: number;
  failed: number;
  untested: number;
  /** Sum of custom_status1_count … custom_status7_count. */
  custom: number;
  /** passed + blocked + retest + failed + untested + custom. */
  total: number;
}

/** Read one `*_count` field defensively: missing / non-numeric → 0, never NaN or a negative total. */
function countOf(raw: Record<string, unknown>, key: string): number {
  const v = raw[key];
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/**
 * Map the flat count fields of a TestRail plan-run / run object into the
 * normalized `TestRailRunProgress`. Pure, defensive: any absent or broken
 * field counts as 0 (older servers omit the custom fields; a corrupt value
 * must never poison the sum).
 */
export function runProgressFromCounts(raw: Record<string, unknown>): TestRailRunProgress {
  const passed = countOf(raw, 'passed_count');
  const blocked = countOf(raw, 'blocked_count');
  const retest = countOf(raw, 'retest_count');
  const failed = countOf(raw, 'failed_count');
  const untested = countOf(raw, 'untested_count');
  let custom = 0;
  for (let i = 1; i <= 7; i += 1) custom += countOf(raw, `custom_status${i}_count`);
  return { passed, blocked, retest, failed, untested, custom, total: passed + blocked + retest + failed + untested + custom };
}

/**
 * The run's "passed %" exactly like TestRail's plan screen shows it:
 * passed / total, and 0 when the run is empty. Never NaN, never negative.
 */
export function passedPct(p: TestRailRunProgress): number {
  return p.total === 0 ? 0 : p.passed / p.total;
}

/**
 * One normalized TEST row of a run (get_tests). Unlike a result, a test row
 * is the CURRENT state of one run × case instance: its status and its
 * assigned tester at fetch time. This is what the per-tester progress
 * breakdown of a linked run is built from (each test belongs to exactly one
 * group, so the group totals partition the run — they sum to the aggregate
 * line exactly).
 */
export interface TestRailTestRow {
  /** The test's id (the run × case instance; get_tests uses `id`). */
  testId: number;
  /** The assigned tester's TestRail user id; null = unassigned. */
  assignedToId: number | null;
  /** Built-in IDs: 1 Passed, 2 Blocked, 3 Untested, 4 Retest, 5 Failed; 6+ custom. */
  statusId: number | null;
  /** The underlying case id (get_tests exposes `case_id`); used to join results to cases. */
  caseId?: number;
}

/**
 * One test CASE of a suite (get_cases). Unlike a test row, a case is the
 * reusable definition: title, priority and type as TestRail stores them.
 * Used by the Test Management case import (Cases tab) so "Registered"
 * counts reflect what TestRail actually holds.
 */
export interface TestRailCaseRow {
  /** TestRail's case id (the stable identity used to link back). */
  caseId: number;
  /** The case title, as TestRail shows it. */
  title: string;
  /** TestRail's priority name ("Critical", "High", …) — mapped by the importer. */
  priorityName?: string;
  /** TestRail's type name ("Functional", "Regression", …). */
  typeName?: string;
}

/**
 * The per-tester progress of one linked run. One entry per assigned tester
 * plus one for unassigned tests (`testerId: null`); the sums of every row
 * equal the run's aggregate `TestRailRunProgress`.
 */
export interface TestRailTesterProgress {
  /** The assigned tester's TestRail user id; null = unassigned tests. */
  testerId: number | null;
  passed: number;
  blocked: number;
  retest: number;
  failed: number;
  untested: number;
  /** Statuses with id ≥ 6 (custom statuses). */
  custom: number;
  /** passed + blocked + retest + failed + untested + custom. */
  total: number;
}

/**
 * Group the test rows of a run by assigned tester and count their statuses.
 * Pure and defensive: every row lands in exactly one group and one bucket, so
 * the group totals are a partition of the run (they sum to the aggregate
 * line). Built-in status ids map to their named bucket; ids ≥ 6 count as
 * custom; anything unusable (null / non-positive) counts as untested — the
 * API default for a test without a meaningful status. Sorted by total
 * descending, unassigned last (deterministic tie-break: tester id).
 */
export function testerProgressFromTests(tests: readonly TestRailTestRow[]): TestRailTesterProgress[] {
  interface Acc {
    testerId: number | null;
    passed: number;
    blocked: number;
    retest: number;
    failed: number;
    untested: number;
    custom: number;
  }
  const newAcc = (testerId: number | null): Acc => ({ testerId, passed: 0, blocked: 0, retest: 0, failed: 0, untested: 0, custom: 0 });
  const bucket = (statusId: number | null): keyof Omit<Acc, 'testerId'> => {
    switch (statusId) {
      case 1:
        return 'passed';
      case 2:
        return 'blocked';
      case 4:
        return 'retest';
      case 5:
        return 'failed';
      case 3:
        return 'untested';
      default:
        return statusId !== null && statusId >= 6 ? 'custom' : 'untested';
    }
  };

  const byTester = new Map<number | null, Acc>();
  for (const row of tests) {
    const acc = byTester.get(row.assignedToId) ?? newAcc(row.assignedToId);
    acc[bucket(row.statusId)] += 1;
    byTester.set(row.assignedToId, acc);
  }

  return [...byTester.values()]
    .map((acc) => ({ ...acc, total: acc.passed + acc.blocked + acc.retest + acc.failed + acc.untested + acc.custom }))
    .sort((a, b) => {
      if (a.testerId === null && b.testerId !== null) return 1; // unassigned last
      if (a.testerId !== null && b.testerId === null) return -1;
      if (a.total !== b.total) return b.total - a.total; // total desc
      return (a.testerId ?? -1) - (b.testerId ?? -1); // deterministic tie-break
    });
}

/**
 * One normalized RESULT row (a single execution event of one test). The
 * day-aggregation keeps the LATEST result per test per day, attributes the
 * execution to `assignedToId` (the assigned tester, even when someone else
 * recorded the result).
 */
export interface TestRailResultRow {
  /** Result id (the latest-per-test tie-break). */
  id: number;
  /** The test (run × case) this result belongs to. */
  testId: number;
  /** The run the result was recorded in (filled by the fetch lane). */
  runId: number;
  /** Built-in IDs: 1 Passed, 2 Blocked, 3 Untested, 4 Retest, 5 Failed; 6+ custom. */
  statusId: number | null;
  /** Unix seconds the result was created. */
  createdOn: number;
  /** TestRail user id of whoever recorded the result. */
  createdBy: number;
  /** The assigned tester's user id; null = unassigned. */
  assignedToId: number | null;
  /** The result's comment text (get_results `comment`); absent when the server sent none. */
  comment?: string;
  /** The result's linked defect ids (get_results `defects`, comma/space separated as sent); absent when empty. */
  defects?: string;
}

/** Typed client failures so UI can show the right recovery hint. */
export type TestRailClientErrorKind =
  | 'notConfigured'
  | 'auth'
  | 'forbidden'
  | 'rateLimit'
  | 'timeout'
  | 'network'
  /** Browser blocked the request (CORS / mixed content / offline). TestRail never sends CORS headers. */
  | 'cors'
  | 'badRequest'
  /** The suite does not belong to the project the run reports: nothing is imported. */
  | 'mismatch'
  | 'server'
  | 'unknown';

/** One suite (get_suite): the project it belongs to is what get_cases needs. */
export interface TestRailSuiteRef {
  id: number;
  projectId: number;
  name: string;
}

export interface TestRailClientError {
  kind: TestRailClientErrorKind;
  /** Stable, non-localized technical message for logs; UI strings come from i18n. */
  message: string;
  /** HTTP status when a response was received. */
  status?: number;
}

/** Result-fetch options; the client handles paging internally. */
export interface TestRailResultsRequest {
  /** Only results created at/after this unix time. */
  createdAfter?: number;
  /** Only results created before this unix time. */
  createdBefore?: number;
  /** Total-result safety cap across all pages. Default 5000. */
  maxTotal?: number;
  /** Per-request abort/timeout budget in ms. Default 60_000. */
  timeoutMs?: number;
}

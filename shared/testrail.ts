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

/** One test run of a plan (or a standalone run). */
export interface TestRailRunRef {
  id: number;
  name: string;
  /** Suite id when the API exposed one on the run. */
  suiteId?: number;
  /** Config label(s), e.g. "Chrome" — plan entries create one run per config. */
  config?: string;
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
  | 'server'
  | 'unknown';

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

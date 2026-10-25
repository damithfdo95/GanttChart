/**
 * Browser fetch client for the TestRail import (Stage: TestRail import).
 *
 * Talks to TestRail's API v2 (`index.php?/api/v2/…`) with HTTP Basic auth
 * (email + API key). Read-only: plans, runs, results and users — nothing is
 * ever written back to TestRail. When a proxy URL is configured, every
 * request goes to the proxy with the original TestRail path appended
 * (TestRail sends no CORS headers, so browsers cannot call it directly).
 *
 * Every failure is reported as a `TestRailClientError` (kind + stable
 * technical message, UI hints live in i18n). No credential is ever included
 * in an error message or log.
 */

import type {
  TestRailCaseRow,
  TestRailClientError,
  TestRailClientErrorKind,
  TestRailConnection,
  TestRailResultRow,
  TestRailResultsRequest,
  TestRailRunProgress,
  TestRailRunRef,
  TestRailSuiteRef,
  TestRailTestRow,
  TestRailUser,
} from '../../../shared/testrail';
import { runProgressFromCounts } from '../../../shared/testrail';
import type { FetchLike } from '../tenancy/api';
import { encodeBasicAuth } from '../jira/client';
import { isSecureIntegrationUrl } from '../../../shared/integrationUrl';

const PAGE_SIZE = 250;
const DEFAULT_MAX_TOTAL = 5000;
const HARD_CAP_TOTAL = 20000;
const DEFAULT_TIMEOUT_MS = 60_000;
/** Safety bound on the single 429 wait so the UI never stalls for hours. */
const RETRY_AFTER_CAP_SECONDS = 300;

export interface TestRailClient {
  /** Smoke test: fetch the projects the account can see. */
  testConnection(): Promise<number>;
  /** Users with id/name/email (get_users). Cloud instances allow this for any API user; self-hosted may restrict to admins. */
  getUsers(): Promise<TestRailUser[]>;
  /** One user by id (get_user) — the name/email backfill when the list is restricted or the account is deactivated. */
  getUser(userId: number): Promise<TestRailUser>;
  /** All runs of a plan (entries[] flattened; plans contain one run per config/suite entry). */
  getPlanRuns(planId: number): Promise<TestRailRunRef[]>;
  /** One standalone run (the target of a /runs/view URL). */
  getRun(runId: number): Promise<TestRailRunRef>;
  /** The current status counts of one run (get_run). */
  getRunProgress(runId: number): Promise<TestRailRunProgress>;
  /**
   * All tests of a run (get_tests, paged). Each row is the test's CURRENT
   * state — status_id and assignedto_id at fetch time. Used for the
   * per-tester progress breakdown of a linked scope.
   */
  getTestsForRun(runId: number): Promise<TestRailTestRow[]>;  /** All cases of a suite (get_cases, paged): the reusable case definitions
   * (title, priority, type). Used by the Test Management case import. */
  getCases(projectId: number, suiteId: number): Promise<TestRailCaseRow[]>;
  /** One suite (get_suite): reports the project it belongs to. */
  getSuite(suiteId: number): Promise<TestRailSuiteRef>;
  /**
   * The cases of a run's suite, with the documented project/suite contract: uses the run's own project id when it reports one,
   * otherwise resolves it through get_suite (never guessing project id = suite id), and refuses a suite that belongs to another
   * project than the run reports (nothing is imported).
   */
  getCasesForRun(run: { projectId?: number; suiteId: number }): Promise<TestRailCaseRow[]>;  /** All results of a run (paged), optionally bounded by creation time. */
  getResultsForRun(runId: number, request?: TestRailResultsRequest): Promise<TestRailResultRow[]>;
}

function clientError(kind: TestRailClientErrorKind, message: string, status?: number): TestRailClientError {
  return { kind, message, ...(status === undefined ? {} : { status }) };
}

function isClientError(e: unknown): e is TestRailClientError {
  return typeof e === 'object' && e !== null && 'kind' in e;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(res: Response): number {
  const value = res.headers.get('retry-after');
  if (value === null) return 1;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, RETRY_AFTER_CAP_SECONDS);
  return 1;
}

interface RawUser {
  id?: unknown;
  name?: unknown;
  email?: unknown;
}

interface RawRun {
  id?: unknown;
  project_id?: unknown;
  name?: unknown;
  suite_id?: unknown;
  config?: unknown;
  // The flat status counts get_run / plan entries expose (custom_status*_count
  // are read dynamically by runProgressFromCounts through the Record cast).
  passed_count?: unknown;
  blocked_count?: unknown;
  retest_count?: unknown;
  failed_count?: unknown;
  untested_count?: unknown;
}

interface RawPlanEntry {
  runs?: unknown;
}

interface RawPlan {
  id?: unknown;
  name?: unknown;
  entries?: unknown;
}

interface RawResult {
  id?: unknown;
  test_id?: unknown;
  status_id?: unknown;
  created_on?: unknown;
  created_by?: unknown;
  assignedto_id?: unknown;
  comment?: unknown;
  defects?: unknown;
}

interface RawTest {
  id?: unknown;
  assignedto_id?: unknown;
  status_id?: unknown;
  case_id?: unknown;
}

interface RawCase {
  id?: unknown;
  title?: unknown;
  priority?: unknown;
  type?: unknown;
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function mapUser(raw: RawUser): TestRailUser {
  return {
    id: num(raw.id) ?? -1,
    name: typeof raw.name === 'string' ? raw.name : '',
    ...(typeof raw.email === 'string' && raw.email !== '' ? { email: raw.email } : {}),
  };
}

function mapRun(raw: RawRun, planId?: number): TestRailRunRef {
  const suiteId = num(raw.suite_id);
  const projectId = num(raw.project_id);
  return {
    id: num(raw.id) ?? -1,
    name: typeof raw.name === 'string' ? raw.name : '',
    ...(planId === undefined ? {} : { planId }),
    ...(suiteId !== null ? { suiteId } : {}),
    ...(projectId !== null && Number.isInteger(projectId) && projectId > 0 ? { projectId } : {}),
    ...(typeof raw.config === 'string' && raw.config !== '' ? { config: raw.config } : {}),
    // The counts that ride with the run object itself; a missing field maps to 0 (defensive).
    progress: runProgressFromCounts(raw as unknown as Record<string, unknown>),
  };
}

function runProgressOf(raw: RawRun): TestRailRunProgress {
  return runProgressFromCounts(raw as unknown as Record<string, unknown>);
}

function mapResult(raw: RawResult, runId: number): TestRailResultRow {
  const statusId = num(raw.status_id);
  return {
    id: num(raw.id) ?? -1,
    testId: num(raw.test_id) ?? -1,
    runId,
    statusId: statusId === null ? null : Math.trunc(statusId),
    createdOn: num(raw.created_on) ?? 0,
    createdBy: num(raw.created_by) ?? -1,
    assignedToId: num(raw.assignedto_id) === null ? null : Math.trunc(num(raw.assignedto_id) as number),
    ...(typeof raw.comment === 'string' && raw.comment.trim() !== '' ? { comment: raw.comment } : {}),
    ...(typeof raw.defects === 'string' && raw.defects.trim() !== '' ? { defects: raw.defects } : {}),
  };
}

function mapTest(raw: RawTest): TestRailTestRow {
  const statusId = num(raw.status_id);
  const assignedToId = num(raw.assignedto_id);
  const caseId = num(raw.case_id);
  return {
    testId: num(raw.id) ?? -1,
    assignedToId: assignedToId === null ? null : Math.trunc(assignedToId),
    statusId: statusId === null ? null : Math.trunc(statusId),
    ...(caseId !== null ? { caseId: Math.trunc(caseId) } : {}),
  };
}

/** get_cases rows carry priority/type as nested {id, name} objects on some
 * servers and as bare names on others — accept both shapes. */
function nameOf(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() === '' ? undefined : v.trim();
  if (typeof v === 'object' && v !== null) {
    const name = (v as { name?: unknown }).name;
    if (typeof name === 'string' && name.trim() !== '') return name.trim();
  }
  return undefined;
}

function mapCase(raw: RawCase): TestRailCaseRow {
  return {
    caseId: num(raw.id) ?? -1,
    title: typeof raw.title === 'string' ? raw.title : '',
    ...(nameOf(raw.priority) !== undefined ? { priorityName: nameOf(raw.priority) } : {}),
    ...(nameOf(raw.type) !== undefined ? { typeName: nameOf(raw.type) } : {}),
  };
}

export function createTestRailClient(conn: TestRailConnection, fetchLike: FetchLike = (input, init) => fetch(input, init)): TestRailClient {
  const proxyUrl = (conn.proxyUrl ?? '').trim();
  const baseUrl = (conn.baseUrl ?? '').trim();
  // Effective base: the proxy (when configured) replaces the TestRail root;
  // all requests go there with the original TestRail path appended.
  const base = trimSlash(proxyUrl !== '' ? proxyUrl : baseUrl);
  if (base === '') throw clientError('notConfigured', 'No TestRail base URL configured.');
  if (!isSecureIntegrationUrl(base)) throw clientError('notConfigured', 'The TestRail address must use https:// (http:// is only allowed on this computer).');
  const useProxy = proxyUrl !== '';

  const email = conn.email?.trim() ?? '';
  const apiKey = conn.apiKey?.trim() ?? '';
  if (email === '' || apiKey === '') {
    throw clientError('notConfigured', 'TestRail credentials (email + API key) are missing.');
  }
  const authHeader = `Basic ${encodeBasicAuth(email, apiKey)}`;

  async function doRequest<T>(url: string, timeoutMs: number): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: authHeader,
    };

    let retriedRateLimit = false;
    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let gotResponse = false;
      try {
        const res = await fetchLike(url, { method: 'GET', headers, signal: controller.signal });
        gotResponse = true;

        if (res.status === 429) {
          if (retriedRateLimit) {
            throw clientError('rateLimit', 'TestRail rate limit reached; retry later.', 429);
          }
          retriedRateLimit = true;
          const waitSeconds = parseRetryAfter(res);
          await sleep(waitSeconds * 1000);
          continue; // one retry after the advertised wait
        }
        if (res.status === 401) {
          throw clientError('auth', 'Authentication failed: the email/API key was rejected.', 401);
        }
        if (res.status === 403) {
          throw clientError('forbidden', 'Access denied: the account cannot read this TestRail data.', 403);
        }

        let payload: unknown = null;
        try {
          payload = await res.json();
        } catch {
          /* empty or non-JSON body */
        }

        if (!res.ok) {
          if (res.status >= 500) {
            throw clientError('server', `TestRail server error (HTTP ${res.status}).`, res.status);
          }
          const message =
            typeof payload === 'object' && payload !== null && typeof (payload as { error?: unknown }).error === 'string'
              ? (payload as { error: string }).error
              : '';
          throw clientError(
            'badRequest',
            message !== '' ? message : `TestRail rejected the request (HTTP ${res.status}).`,
            res.status,
          );
        }
        return payload as T;
      } catch (e) {
        if (isClientError(e)) throw e;
        if (controller.signal.aborted || (e instanceof Error && e.name === 'AbortError')) {
          throw clientError('timeout', `The TestRail request timed out after ${timeoutMs}ms.`);
        }
        if (gotResponse) {
          throw clientError('unknown', 'TestRail returned an unreadable response.');
        }
        // No HTTP response ever arrived: browsers raise TypeError on CORS
        // blocks / network failures. TestRail (cloud and self-hosted) does
        // not send CORS headers, so without a proxy this is almost always
        // a CORS block.
        if (!useProxy) {
          throw clientError(
            'cors',
            'Possible CORS block — TestRail does not allow direct browser calls; configure a proxy URL.',
          );
        }
        throw clientError('network', 'The TestRail request failed at the network level; check the connection.');
      } finally {
        clearTimeout(timer);
      }
    }
  }

  /** Build a v2 API URL: `index.php?/api/v2/<method>&<query>…` (TestRail's documented odd `&` separator). */
  function api(method: string, query: Record<string, string | number | undefined>): string {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      parts.push(`${key}=${encodeURIComponent(String(value))}`);
    }
    const qs = parts.length > 0 ? `&${parts.join('&')}` : '';
    return `${base}/index.php?/api/v2/${method}${qs}`;
  }

  /**
   * GET a paged list endpoint: bare arrays (older servers) and
   * `{<key>: []}` envelopes are both handled. The 6.7+ envelope may name the
   * next-page link `links` (newer) or `_links` (older servers in the same
   * line); both are honored.
   */
  async function getPaged<T>(
    method: string,
    query: Record<string, string | number | undefined>,
    timeoutMs: number,
    maxTotal: number,
    listKey: 'results' | 'projects' | 'tests' | 'users' | 'cases' = 'results',
  ): Promise<T[]> {
    const out: T[] = [];
    let offset = 0;
    for (;;) {
      const data = await doRequest<unknown>(api(method, { ...query, limit: PAGE_SIZE, offset }), timeoutMs);
      const envelope = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : undefined;
      const list = envelope?.[listKey];
      const page: T[] = Array.isArray(data) ? (data as T[]) : Array.isArray(list) ? (list as T[]) : [];
      out.push(...page);
      if (out.length >= maxTotal) {
        out.length = maxTotal;
        break;
      }
      const nextOf = (key: string): string | null => {
        const links = envelope?.[key];
        return typeof links === 'object' && links !== null && typeof (links as { next?: unknown }).next === 'string'
          ? ((links as { next: string }).next as string)
          : null;
      };
      const nextLink = nextOf('links') ?? nextOf('_links');
      const hasNext = nextLink !== null && nextLink !== '';
      if (!hasNext && page.length < PAGE_SIZE) break;
      if (page.length === 0) break;
      offset += page.length;
    }
    return out;
  }

  /** TestRail ids are positive integers; anything else never reaches a URL path. */
  function requireId(value: number, what: string): number {
    if (!Number.isInteger(value) || value <= 0) throw clientError('badRequest', `Invalid TestRail ${what} id.`);
    return value;
  }

  /** get_suite: the suite's project id (a payload without one is unusable and reported as such). */
  async function fetchSuite(suiteId: number): Promise<TestRailSuiteRef> {
    const id = requireId(suiteId, 'suite');
    const raw = await doRequest<Record<string, unknown> | null>(api(`get_suite/${id}`, {}), DEFAULT_TIMEOUT_MS);
    const projectId = raw !== null && typeof raw === 'object' ? num(raw.project_id) : null;
    if (projectId === null || !Number.isInteger(projectId) || projectId <= 0) throw clientError('unknown', 'TestRail returned an unreadable suite.');
    return { id, projectId, name: typeof raw?.name === 'string' ? raw.name : '' };
  }

  /** The documented request: get_cases/{project_id}&suite_id={suite_id}, paged (limit/offset or the links.next envelope). */
  async function fetchCases(projectId: number, suiteId: number): Promise<TestRailCaseRow[]> {
    const project = requireId(projectId, 'project');
    const suite = requireId(suiteId, 'suite');
    // Same defensive hard cap as getTestsForRun: never page unbounded.
    const maxTotal = Math.max(1, Math.min(DEFAULT_MAX_TOTAL, HARD_CAP_TOTAL));
    const rows = await getPaged<RawCase>(`get_cases/${project}`, { suite_id: suite }, DEFAULT_TIMEOUT_MS, maxTotal, 'cases');
    // A server that ignores offset would repeat its first page; a case id is never imported twice.
    const seen = new Set<number>();
    return rows.map((raw) => mapCase(raw)).filter((c) => (seen.has(c.caseId) ? false : (seen.add(c.caseId), true)));
  }

  return {
    testConnection: () => getPaged<unknown>('get_projects', {}, DEFAULT_TIMEOUT_MS, PAGE_SIZE, 'projects').then((projects) => projects.length),

    getUsers: () => getPaged<RawUser>('get_users', {}, DEFAULT_TIMEOUT_MS, PAGE_SIZE * 4, 'users').then((users) => users.map(mapUser)),

    getUser: async (userId: number) => mapUser(await doRequest<RawUser>(api(`get_user/${userId}`, {}), DEFAULT_TIMEOUT_MS)),

    getPlanRuns: async (planId: number) => {
      const plan = await doRequest<RawPlan>(api(`get_plan/${planId}`, {}), DEFAULT_TIMEOUT_MS);
      const runs: TestRailRunRef[] = [];
      if (Array.isArray(plan?.entries)) {
        for (const entry of plan.entries as RawPlanEntry[]) {
          if (!Array.isArray(entry?.runs)) continue;
          // Every nested run belongs to THIS plan — stamp it so a scope created
          // from the run can carry the link (planId, runId) without a second call.
          for (const raw of entry.runs as RawRun[]) runs.push(mapRun(raw, planId));
        }
      }
      return runs;
    },

    getRun: async (runId: number) => {
      const run = await doRequest<RawRun>(api(`get_run/${runId}`, {}), DEFAULT_TIMEOUT_MS);
      return mapRun(run);
    },

    getRunProgress: async (runId: number) => {
      const run = await doRequest<RawRun>(api(`get_run/${runId}`, {}), DEFAULT_TIMEOUT_MS);
      return runProgressOf(run);
    },

    getTestsForRun: (runId: number) => {
      // Same defensive hard cap as getResultsForRun: never page unbounded.
      const maxTotal = Math.max(1, Math.min(DEFAULT_MAX_TOTAL, HARD_CAP_TOTAL));
      return getPaged<RawTest>(`get_tests/${runId}`, {}, DEFAULT_TIMEOUT_MS, maxTotal, 'tests').then((rows) => rows.map((raw) => mapTest(raw)));
    },

    getCases: (projectId: number, suiteId: number) => fetchCases(projectId, suiteId),

    getSuite: (suiteId: number) => fetchSuite(suiteId),

    getCasesForRun: async (run: { projectId?: number; suiteId: number }) => {
      const suite = await fetchSuite(run.suiteId);
      // The run's own project id, when it reports one, must agree with the suite's: a mismatch means the link is wrong (or the
      // data is), so nothing is imported rather than mixing another project's cases into this scope.
      if (run.projectId !== undefined && suite.projectId !== run.projectId) {
        throw clientError('mismatch', 'The suite belongs to a different TestRail project than the run reports; nothing was imported.');
      }
      return fetchCases(suite.projectId, run.suiteId);
    },

    getResultsForRun: (runId: number, request: TestRailResultsRequest = {}) => {
      const maxTotal = Math.max(1, Math.min(request.maxTotal ?? DEFAULT_MAX_TOTAL, HARD_CAP_TOTAL));
      const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      return getPaged<RawResult>(
        `get_results_for_run/${runId}`,
        {
          ...(request.createdAfter !== undefined ? { created_after: request.createdAfter } : {}),
          ...(request.createdBefore !== undefined ? { created_before: request.createdBefore } : {}),
        },
        timeoutMs,
        maxTotal,
      ).then((rows) => rows.map((raw) => mapResult(raw, runId)));
    },
  };
}
/** Safety bound: never more than this many get_user calls per backfill. */
const MAX_USER_BACKFILL = 50;

/**
 * Best-effort name backfill for testers missing from the user list: a
 * deactivated account drops out of get_users while its tests stay assigned,
 * and some self-hosted instances restrict the list itself. Each missing id
 * is fetched with one get_user — which also returns the email that links
 * Team Members. Never throws: an id that cannot be fetched keeps the
 * caller's "User #id" fallback label.
 */
export async function backfillTestRailUsers(
  client: TestRailClient,
  users: readonly TestRailUser[],
  ids: readonly number[],
): Promise<TestRailUser[]> {
  const known = new Set(users.map((u) => u.id));
  const missing = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0 && !known.has(id)))].slice(0, MAX_USER_BACKFILL);
  if (missing.length === 0) return [...users];
  const fetched = await Promise.all(
    missing.map(async (id): Promise<TestRailUser | null> => {
      try {
        return await client.getUser(id);
      } catch {
        return null; // best-effort: the fallback label stays
      }
    }),
  );
  const added = fetched.filter((u): u is TestRailUser => u !== null && u.id > 0 && u.name !== '');
  return [...users, ...added];
}
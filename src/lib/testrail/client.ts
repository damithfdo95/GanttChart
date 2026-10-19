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
  TestRailClientError,
  TestRailClientErrorKind,
  TestRailConnection,
  TestRailResultRow,
  TestRailResultsRequest,
  TestRailRunRef,
  TestRailUser,
} from '../../../shared/testrail';
import type { FetchLike } from '../tenancy/api';
import { encodeBasicAuth } from '../jira/client';

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
  /** All runs of a plan (entries[] flattened; plans contain one run per config/suite entry). */
  getPlanRuns(planId: number): Promise<TestRailRunRef[]>;
  /** One standalone run (the target of a /runs/view URL). */
  getRun(runId: number): Promise<TestRailRunRef>;
  /** All results of a run (paged), optionally bounded by creation time. */
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
  name?: unknown;
  suite_id?: unknown;
  config?: unknown;
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

function mapRun(raw: RawRun): TestRailRunRef {
  const suiteId = num(raw.suite_id);
  return {
    id: num(raw.id) ?? -1,
    name: typeof raw.name === 'string' ? raw.name : '',
    ...(suiteId !== null ? { suiteId } : {}),
    ...(typeof raw.config === 'string' && raw.config !== '' ? { config: raw.config } : {}),
  };
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
  };
}

export function createTestRailClient(conn: TestRailConnection, fetchLike: FetchLike = (input, init) => fetch(input, init)): TestRailClient {
  const proxyUrl = (conn.proxyUrl ?? '').trim();
  const baseUrl = (conn.baseUrl ?? '').trim();
  // Effective base: the proxy (when configured) replaces the TestRail root;
  // all requests go there with the original TestRail path appended.
  const base = trimSlash(proxyUrl !== '' ? proxyUrl : baseUrl);
  if (base === '') throw clientError('notConfigured', 'No TestRail base URL configured.');
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

  /** GET a paged list endpoint: bare arrays (older servers) and `{<key>: []}` envelopes are both handled. */
  async function getPaged<T>(
    method: string,
    query: Record<string, string | number | undefined>,
    timeoutMs: number,
    maxTotal: number,
    listKey: 'results' | 'projects' = 'results',
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
      const links = envelope?._links as { next?: unknown } | undefined;
      const hasNext = typeof links?.next === 'string' && links.next !== '';
      if (!hasNext && page.length < PAGE_SIZE) break;
      if (page.length === 0) break;
      offset += page.length;
    }
    return out;
  }

  return {
    testConnection: () => getPaged<unknown>('get_projects', {}, DEFAULT_TIMEOUT_MS, PAGE_SIZE, 'projects').then((projects) => projects.length),

    getUsers: () => getPaged<RawUser>('get_users', {}, DEFAULT_TIMEOUT_MS, PAGE_SIZE * 4).then((users) => users.map(mapUser)),

    getPlanRuns: async (planId: number) => {
      const plan = await doRequest<RawPlan>(api(`get_plan/${planId}`, {}), DEFAULT_TIMEOUT_MS);
      const runs: TestRailRunRef[] = [];
      if (Array.isArray(plan?.entries)) {
        for (const entry of plan.entries as RawPlanEntry[]) {
          if (!Array.isArray(entry?.runs)) continue;
          for (const raw of entry.runs as RawRun[]) runs.push(mapRun(raw));
        }
      }
      return runs;
    },

    getRun: async (runId: number) => {
      const run = await doRequest<RawRun>(api(`get_run/${runId}`, {}), DEFAULT_TIMEOUT_MS);
      return mapRun(run);
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

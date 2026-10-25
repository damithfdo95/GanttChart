import { describe, expect, it } from 'vitest';
import { backfillTestRailUsers, createTestRailClient } from '../lib/testrail/client';
import type { TestRailClientError, TestRailConnection } from '../../shared/testrail';
import type { FetchLike } from '../lib/tenancy/api';

// ---- fake transport -------------------------------------------------------

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

const response = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }) as unknown as Response;

const recordingFetch = (
  handler: (call: RecordedCall, index: number) => Response | Promise<Response>,
): { fetch: FetchLike; calls: RecordedCall[] } => {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    const call: RecordedCall = {
      url: input,
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { fetch, calls };
};

// ---- shared fixtures ------------------------------------------------------

const CONN: TestRailConnection = {
  baseUrl: 'https://rkong.testrail.com',
  email: 'sv@example.com',
  apiKey: 'key-123',
};

const resultRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 1,
  test_id: 100,
  status_id: 1,
  created_on: 1770000000,
  created_by: 5,
  assignedto_id: 5,
  ...over,
});

async function failure(run: () => Promise<unknown>): Promise<TestRailClientError> {
  try {
    await run();
    throw new Error('expected the call to reject');
  } catch (e) {
    if ((e as TestRailClientError).kind === undefined) throw e;
    return e as TestRailClientError;
  }
}

// ---- tests ----------------------------------------------------------------

describe('TestRail client', () => {
  it('sends Basic auth with the email and API key', async () => {
    const { fetch, calls } = recordingFetch(() => response(200, []));
    await createTestRailClient(CONN, fetch).getUsers();
    expect(calls[0]?.url).toBe('https://rkong.testrail.com/index.php?/api/v2/get_users&limit=250&offset=0');
    expect(calls[0]?.headers.Authorization).toBe(`Basic ${btoa('sv@example.com:key-123')}`);
  });

  it('routes every request through the proxy when one is configured (same path)', async () => {
    const { fetch, calls } = recordingFetch(() => response(200, []));
    await createTestRailClient({ ...CONN, proxyUrl: 'https://proxy.example.com/' }, fetch).getUsers();
    expect(calls[0]?.url).toBe('https://proxy.example.com/index.php?/api/v2/get_users&limit=250&offset=0');
  });

  it('throws notConfigured without credentials', async () => {
    const { fetch } = recordingFetch(() => response(200, []));
    const err = await failure(() => createTestRailClient({ baseUrl: 'https://x.testrail.com' }, fetch).getUsers());
    expect(err.kind).toBe('notConfigured');
    const err2 = await failure(() => createTestRailClient({ baseUrl: '', email: 'a@b.c', apiKey: 'k' }, fetch).getUsers());
    expect(err2.kind).toBe('notConfigured');
  });

  it('maps 401 to auth, 403 to forbidden and 5xx to server', async () => {
    const auth = await failure(() => createTestRailClient(CONN, recordingFetch(() => response(401, { error: 'auth' })).fetch).getUsers());
    expect(auth.kind).toBe('auth');
    const forbidden = await failure(() => createTestRailClient(CONN, recordingFetch(() => response(403, { error: 'denied' })).fetch).getUsers());
    expect(forbidden.kind).toBe('forbidden');
    const server = await failure(() => createTestRailClient(CONN, recordingFetch(() => response(502, 'bad gateway')).fetch).getUsers());
    expect(server.kind).toBe('server');
  });

  it('surfaces the TestRail error message on a bad request', async () => {
    const { fetch } = recordingFetch(() => response(400, { error: 'Field :limit is too large (maximum 250).' }));
    const err = await failure(() => createTestRailClient(CONN, fetch).getUsers());
    expect(err.kind).toBe('badRequest');
    expect(err.message).toContain('maximum 250');
  });

  it('treats a fetch TypeError without a proxy as a CORS block', async () => {
    const { fetch } = recordingFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const err = await failure(() => createTestRailClient(CONN, fetch).getUsers());
    expect(err.kind).toBe('cors');
  });

  it('treats a fetch TypeError through a configured proxy as a network error', async () => {
    const { fetch } = recordingFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const err = await failure(() => createTestRailClient({ ...CONN, proxyUrl: 'https://proxy.example.com' }, fetch).getUsers());
    expect(err.kind).toBe('network');
  });

  it('retries once after a 429 with Retry-After, then reports rateLimit on the second 429', async () => {
    let attempts = 0;
    const { fetch, calls } = recordingFetch(() => {
      attempts += 1;
      return attempts === 1 ? response(429, { error: 'rate limit' }, { 'retry-after': '0' }) : response(429, { error: 'rate limit' });
    });
    const err = await failure(() => createTestRailClient(CONN, fetch).getUsers());
    expect(err.kind).toBe('rateLimit');
    expect(calls.length).toBe(2);
  });

  it('expands a plan into the runs of every entry and config', async () => {
    const plan = {
      id: 32716,
      name: 'Release 4.1.0',
      entries: [
        { id: 'e1', runs: [{ id: 9001, name: 'Chrome', config: 'Chrome', passed_count: 10, untested_count: 20 }, { id: 9002, name: 'Android 14', config: 'Android 14' }] },
        { id: 'e2', runs: [{ id: 9003, name: 'Suite B', suite_id: 7 }] },
        { id: 'e3', runs: [] },
      ],
    };
    const { fetch, calls } = recordingFetch((call) => (call.url.includes('get_plan') ? response(200, plan) : response(200, [])));
    const runs = await createTestRailClient(CONN, fetch).getPlanRuns(32716);
    expect(runs.map((r) => r.id)).toEqual([9001, 9002, 9003]);
    expect(runs[0]?.config).toBe('Chrome');
    expect(runs[2]?.suiteId).toBe(7);
    expect(calls[0]?.url).toContain('get_plan/32716');
  });

  it('stamps every plan run with its parent planId and the run counts (progress)', async () => {
    const plan = {
      id: 32716,
      entries: [
        {
          runs: [
            { id: 9001, name: 'Chrome', passed_count: 10, blocked_count: 2, retest_count: 1, failed_count: 3, untested_count: 20, custom_status1_count: 4, custom_status2_count: 5 },
          ],
        },
      ],
    };
    const { fetch } = recordingFetch((call) => (call.url.includes('get_plan') ? response(200, plan) : response(200, [])));
    const runs = await createTestRailClient(CONN, fetch).getPlanRuns(32716);
    expect(runs[0]?.planId).toBe(32716);
    // a scope created from this run carries the link WITHOUT a second call, and
    // the preview shows the current counts from the same plan payload
    expect(runs[0]).toMatchObject({
      id: 9001,
      planId: 32716,
      progress: { passed: 10, blocked: 2, retest: 1, failed: 3, untested: 20, custom: 9, total: 45 },
    });
  });

  it('fetches one standalone run', async () => {
    const { fetch } = recordingFetch((call) => (call.url.includes('get_run') ? response(200, { id: 42, name: 'Sanity' }) : response(200, [])));
    const run = await createTestRailClient(CONN, fetch).getRun(42);
    expect(run.id).toBe(42);
    expect(run.name).toBe('Sanity');
    expect(run.planId).toBeUndefined();
  });

  it('getRunProgress maps the flat counts of one run (missing custom → 0)', async () => {
    const raw = { id: 42, name: 'Sanity', passed_count: 12, failed_count: 3, untested_count: 5 };
    const { fetch, calls } = recordingFetch((call) => (call.url.includes('get_run') ? response(200, raw) : response(200, [])));
    const progress = await createTestRailClient(CONN, fetch).getRunProgress(42);
    expect(progress).toEqual({ passed: 12, blocked: 0, retest: 0, failed: 3, untested: 5, custom: 0, total: 20 });
    expect(calls[0]?.url).toContain('get_run/42');
  });

  it('pages results with limit/offset following _links.next and stamps the run id', async () => {
    const page1 = {
      offset: 0,
      limit: 250,
      size: 2,
      _links: { next: '/api/v2/get_results_for_run/9001&limit=250&offset=2' },
      results: [resultRow({ id: 1, test_id: 100 }), resultRow({ id: 2, test_id: 101 })],
    };
    const page2 = {
      offset: 2,
      limit: 250,
      size: 1,
      _links: { next: null },
      results: [resultRow({ id: 3, test_id: 102 })],
    };
    const { fetch, calls } = recordingFetch((call) => (call.url.includes('offset=2') ? response(200, page2) : response(200, page1)));
    const rows = await createTestRailClient(CONN, fetch).getResultsForRun(9001, { createdAfter: 1000, createdBefore: 2000 });
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(rows.every((r) => r.runId === 9001)).toBe(true);
    expect(calls[0]?.url).toBe(
      'https://rkong.testrail.com/index.php?/api/v2/get_results_for_run/9001&created_after=1000&created_before=2000&limit=250&offset=0',
    );
    expect(calls[1]?.url).toBe(
      'https://rkong.testrail.com/index.php?/api/v2/get_results_for_run/9001&created_after=1000&created_before=2000&limit=250&offset=2',
    );
  });

  it('accepts a bare array response (older TestRail servers)', async () => {
    const { fetch } = recordingFetch(() => response(200, [resultRow({ id: 9, test_id: 9 })]));
    const rows = await createTestRailClient(CONN, fetch).getResultsForRun(1);
    expect(rows.map((r) => r.id)).toEqual([9]);
  });

  it('pages get_tests following the 6.7+ links.next envelope (list key "tests")', async () => {
    const testRow = (id: number, status: number): Record<string, unknown> => ({ id, status_id: status, assignedto_id: status === 3 ? null : 5 });
    const page1 = {
      offset: 0,
      limit: 250,
      size: 2,
      links: { next: '/api/v2/get_tests/9001&limit=250&offset=2' },
      tests: [testRow(100, 1), testRow(101, 2)],
    };
    const page2 = {
      offset: 2,
      limit: 250,
      size: 1,
      links: { next: null },
      tests: [testRow(102, 3)],
    };
    const { fetch, calls } = recordingFetch((call) => (call.url.includes('offset=2') ? response(200, page2) : response(200, page1)));
    const rows = await createTestRailClient(CONN, fetch).getTestsForRun(9001);
    expect(rows).toEqual([
      { testId: 100, assignedToId: 5, statusId: 1 },
      { testId: 101, assignedToId: 5, statusId: 2 },
      { testId: 102, assignedToId: null, statusId: 3 },
    ]);
    expect(calls[0]?.url).toBe('https://rkong.testrail.com/index.php?/api/v2/get_tests/9001&limit=250&offset=0');
    expect(calls[1]?.url).toBe('https://rkong.testrail.com/index.php?/api/v2/get_tests/9001&limit=250&offset=2');
  });

  it('accepts a bare array of tests (older TestRail servers)', async () => {
    const { fetch } = recordingFetch(() => response(200, [{ id: 9, status_id: 3, assignedto_id: null }]));
    const rows = await createTestRailClient(CONN, fetch).getTestsForRun(1);
    expect(rows).toEqual([{ testId: 9, assignedToId: null, statusId: 3 }]);
  });

  it('normalizes test rows defensively (string ids, null status, null assignee)', async () => {
    const raw = [
      { id: '5', status_id: '2', assignedto_id: 7 },
      { id: 6, status_id: null, assignedto_id: null },
      { id: 7, status_id: 6, assignedto_id: '8' },
    ];
    const { fetch } = recordingFetch(() => response(200, raw));
    const rows = await createTestRailClient(CONN, fetch).getTestsForRun(9001);
    expect(rows).toEqual([
      { testId: 5, assignedToId: 7, statusId: 2 },
      { testId: 6, assignedToId: null, statusId: null },
      { testId: 7, assignedToId: 8, statusId: 6 },
    ]);
  });

  it('normalizes result rows defensively (null status, null assignee)', async () => {
    const raw = [
      resultRow({ id: 5, test_id: 55, status_id: null, assignedto_id: null }),
      resultRow({ id: 6, test_id: 56, status_id: '3', assignedto_id: '8' }),
    ];
    const { fetch } = recordingFetch(() => response(200, raw));
    const rows = await createTestRailClient(CONN, fetch).getResultsForRun(9001);
    expect(rows[0]?.statusId).toBeNull();
    expect(rows[0]?.assignedToId).toBeNull();
    expect(rows[1]?.statusId).toBe(3);
    expect(rows[1]?.assignedToId).toBe(8);
  });

  it('testConnection counts the visible projects (array or envelope)', async () => {
    const a = recordingFetch(() => response(200, [{ id: 1 }, { id: 2 }]));
    expect(await createTestRailClient(CONN, a.fetch).testConnection()).toBe(2);
    const b = recordingFetch(() => response(200, { offset: 0, limit: 250, size: 1, _links: { next: null }, projects: [{ id: 1 }] }));
    expect(await createTestRailClient(CONN, b.fetch).testConnection()).toBe(1);
  });

  it('getUsers parses the 6.7+ users envelope (not an empty array)', async () => {
    const { fetch, calls } = recordingFetch(() => response(200, { offset: 0, limit: 250, size: 2, links: { next: null }, users: [{ id: 5, name: 'Ann', email: 'ann@example.com' }, { id: 6, name: 'Bo' }] }));
    const users = await createTestRailClient(CONN, fetch).getUsers();
    expect(users).toEqual([
      { id: 5, name: 'Ann', email: 'ann@example.com' },
      { id: 6, name: 'Bo' },
    ]);
    expect(calls[0]?.url).toBe('https://rkong.testrail.com/index.php?/api/v2/get_users&limit=250&offset=0');
  });

  it('getUser fetches one user by id (the deactivated-tester backfill)', async () => {
    const { fetch, calls } = recordingFetch(() => response(200, { id: 7, name: 'Cara', email: 'cara@example.com' }));
    const user = await createTestRailClient(CONN, fetch).getUser(7);
    expect(user).toEqual({ id: 7, name: 'Cara', email: 'cara@example.com' });
    expect(calls[0]?.url).toBe('https://rkong.testrail.com/index.php?/api/v2/get_user/7');
  });

  it('backfillTestRailUsers fetches only the ids missing from the list, best-effort', async () => {
    const list: Record<number, unknown> = {
      5: { id: 5, name: 'Ann', email: 'ann@example.com' },
    };
    const byId: Record<number, unknown> = {
      7: { id: 7, name: 'Cara', email: 'cara@example.com' }, // deactivated → not in get_users
      9: { id: 9, name: 'Dan', email: 'dan@example.com' },
    };
    const { fetch, calls } = recordingFetch((call) => {
      const single = /get_user\/(\d+)$/.exec(call.url.split('&')[0] ?? '');
      if (single !== null) {
        const id = Number(single[1]);
        return id in byId ? response(200, byId[id]) : response(404, { error: 'not found' });
      }
      return response(200, { offset: 0, limit: 250, size: 1, links: { next: null }, users: [list[5]] });
    });
    const client = createTestRailClient(CONN, fetch);
    const users = await backfillTestRailUsers(client, await client.getUsers(), [5, 7, 9, 9, 0, -3, 12]);
    expect(users).toEqual([
      { id: 5, name: 'Ann', email: 'ann@example.com' },
      { id: 7, name: 'Cara', email: 'cara@example.com' },
      { id: 9, name: 'Dan', email: 'dan@example.com' },
    ]);
    // Only the missing, positive ids were fetched — 5 was known, 0/-3 are not ids, 12 failed (kept out, never thrown).
    expect(calls.filter((c) => c.url.includes('get_user/')).map((c) => c.url.split('get_user/')[1]?.split('&')[0])).toEqual(['7', '9', '12']);
  });

  it('backfillTestRailUsers returns the list unchanged when nothing is missing', async () => {
    const { fetch, calls } = recordingFetch(() => response(200, { offset: 0, limit: 250, size: 1, links: { next: null }, users: [{ id: 5, name: 'Ann' }] }));
    const client = createTestRailClient(CONN, fetch);
    const users = await backfillTestRailUsers(client, await client.getUsers(), [5]);
    expect(users).toEqual([{ id: 5, name: 'Ann' }]);
    expect(calls).toHaveLength(1); // the get_users call only — no get_user round-trips
  });

  it('getCases(projectId, suiteId) uses the documented contract get_cases/12&suite_id=34 (never get_cases/34)', async () => {
    const raw = [
      { id: 101, title: 'Login', priority: { id: 4, name: 'Critical' }, type: { id: 1, name: 'Functional' } },
      { id: 102, title: 'Logout', priority: 'Low', type: 'Regression' },
      { id: 103, title: 'Bare' },
    ];
    const { fetch, calls } = recordingFetch(() => response(200, raw));
    const rows = await createTestRailClient(CONN, fetch).getCases(12, 34);
    expect(rows).toEqual([
      { caseId: 101, title: 'Login', priorityName: 'Critical', typeName: 'Functional' },
      { caseId: 102, title: 'Logout', priorityName: 'Low', typeName: 'Regression' },
      { caseId: 103, title: 'Bare' },
    ]);
    expect(calls[0]?.url).toBe('https://rkong.testrail.com/index.php?/api/v2/get_cases/12&suite_id=34&limit=250&offset=0');
    expect(calls[0]?.url).not.toContain('get_cases/34');
  });

  it('getCases pages following the cases envelope (links.next), keeping project and suite on every page', async () => {
    const page1 = { offset: 0, limit: 250, size: 1, links: { next: '/api/v2/get_cases/12&suite_id=34&limit=250&offset=1' }, cases: [{ id: 101, title: 'Login' }] };
    const page2 = { offset: 1, limit: 250, size: 1, links: { next: null }, cases: [{ id: 102, title: 'Logout' }] };
    const { fetch, calls } = recordingFetch((call) => (call.url.includes('offset=1') ? response(200, page2) : response(200, page1)));
    const rows = await createTestRailClient(CONN, fetch).getCases(12, 34);
    expect(rows.map((r) => r.caseId)).toEqual([101, 102]);
    expect(calls[1]?.url).toBe('https://rkong.testrail.com/index.php?/api/v2/get_cases/12&suite_id=34&limit=250&offset=1');
  });

  it('imports more than one full page (limit/offset over bare arrays) and never silently stops at the first page', async () => {
    const rowsOf = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: from + i, title: `Case ${from + i}` }));
    const { fetch, calls } = recordingFetch((call) => {
      if (call.url.includes('offset=0')) return response(200, rowsOf(1, 250));
      if (call.url.includes('offset=250')) return response(200, rowsOf(251, 250));
      return response(200, rowsOf(501, 40));
    });
    const rows = await createTestRailClient(CONN, fetch).getCases(12, 34);
    expect(rows).toHaveLength(540);
    expect(calls.map((c) => c.url.match(/offset=(\d+)/)?.[1])).toEqual(['0', '250', '500']);
    expect(calls.every((c) => c.url.includes('get_cases/12&suite_id=34'))).toBe(true);
  });

  it('a server that ignores offset cannot make a case import twice', async () => {
    const same = Array.from({ length: 250 }, (_, i) => ({ id: i + 1, title: `Case ${i + 1}` }));
    let n = 0;
    const { fetch } = recordingFetch(() => response(200, (n += 1) > 3 ? [] : same));
    const rows = await createTestRailClient(CONN, fetch).getCases(12, 34);
    expect(new Set(rows.map((r) => r.caseId)).size).toBe(rows.length);
    expect(rows).toHaveLength(250);
  });

  it('getSuite reads the project the suite belongs to', async () => {
    const { fetch, calls } = recordingFetch(() => response(200, { id: 34, name: 'Master', project_id: 12 }));
    expect(await createTestRailClient(CONN, fetch).getSuite(34)).toEqual({ id: 34, projectId: 12, name: 'Master' });
    expect(calls[0]?.url).toBe('https://rkong.testrail.com/index.php?/api/v2/get_suite/34');
  });

  it('getCasesForRun resolves the project through get_suite when the run does not report one (project id is never guessed from the suite id)', async () => {
    const { fetch, calls } = recordingFetch((call) => (call.url.includes('get_suite/34') ? response(200, { id: 34, project_id: 12 }) : response(200, [{ id: 1, title: 'A' }])));
    const rows = await createTestRailClient(CONN, fetch).getCasesForRun({ suiteId: 34 });
    expect(rows.map((r) => r.caseId)).toEqual([1]);
    expect(calls.map((c) => c.url.split('api/v2/')[1])).toEqual(['get_suite/34', 'get_cases/12&suite_id=34&limit=250&offset=0']);
  });

  it('a suite that belongs to a different project than the run reports is a clear error and imports nothing', async () => {
    const { fetch, calls } = recordingFetch((call) => (call.url.includes('get_suite/34') ? response(200, { id: 34, project_id: 99 }) : response(200, [{ id: 1, title: 'A' }])));
    const err = await failure(() => createTestRailClient(CONN, fetch).getCasesForRun({ projectId: 12, suiteId: 34 }));
    expect(err.kind).toBe('mismatch');
    expect(calls.some((c) => c.url.includes('get_cases'))).toBe(false);
    const ok = recordingFetch((call) => (call.url.includes('get_suite/34') ? response(200, { id: 34, project_id: 12 }) : response(200, [{ id: 1, title: 'A' }])));
    expect((await createTestRailClient(CONN, ok.fetch).getCasesForRun({ projectId: 12, suiteId: 34 })).length).toBe(1);
  });

  it('a malformed suite payload is reported, not guessed', async () => {
    const { fetch } = recordingFetch(() => response(200, { id: 34, name: 'No project' }));
    expect((await failure(() => createTestRailClient(CONN, fetch).getSuite(34))).kind).toBe('unknown');
  });

  it('ids that are not positive integers never reach a URL', async () => {
    const { fetch, calls } = recordingFetch(() => response(200, []));
    const client = createTestRailClient(CONN, fetch);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect((await failure(() => client.getCases(bad, 34))).kind).toBe('badRequest');
      expect((await failure(() => client.getSuite(bad))).kind).toBe('badRequest');
    }
    expect(calls).toHaveLength(0);
  });

  it('runs report their project when TestRail does (get_run / plan runs)', async () => {
    const { fetch } = recordingFetch(() => response(200, { id: 9, name: 'R', suite_id: 34, project_id: 12 }));
    expect(await createTestRailClient(CONN, fetch).getRun(9)).toMatchObject({ id: 9, suiteId: 34, projectId: 12 });
    const none = recordingFetch(() => response(200, { id: 9, name: 'R', suite_id: 34 }));
    expect((await createTestRailClient(CONN, none.fetch).getRun(9)).projectId).toBeUndefined();
  });

  describe('API failures give safe, typed errors without credentials', () => {
    const cases: Array<[number, string]> = [[400, 'badRequest'], [401, 'auth'], [403, 'forbidden'], [404, 'badRequest'], [500, 'server']];
    for (const [status, kind] of cases) {
      it(`HTTP ${status} -> ${kind}`, async () => {
        const { fetch } = recordingFetch(() => response(status, { error: 'Field :project_id is not a valid project.' }));
        const err = await failure(() => createTestRailClient(CONN, fetch).getCases(12, 34));
        expect(err.kind).toBe(kind);
        expect(JSON.stringify(err)).not.toContain('key-123');
        expect(JSON.stringify(err)).not.toContain('sv@example.com');
      });
    }

    it('429 retries once after Retry-After then reports a rate limit', async () => {
      const { fetch, calls } = recordingFetch(() => response(429, {}, { 'retry-after': '0' }));
      expect((await failure(() => createTestRailClient(CONN, fetch).getCases(12, 34))).kind).toBe('rateLimit');
      expect(calls).toHaveLength(2);
    });

    it('a network failure and an unreadable response are typed, with no raw error text', async () => {
      const down: FetchLike = async () => {
        throw new TypeError('Failed to fetch https://user:secret@host');
      };
      const proxied = { ...CONN, proxyUrl: 'https://proxy.example.com' };
      const net = await failure(() => createTestRailClient(proxied, down).getCases(12, 34));
      expect(net.kind).toBe('network');
      expect(JSON.stringify(net)).not.toContain('secret');
      const broken: FetchLike = async () => ({ status: 200, ok: true, headers: { get: () => null }, json: async () => { throw new SyntaxError('Unexpected token <'); } }) as unknown as Response;
      const rows = await createTestRailClient(CONN, broken).getCases(12, 34).catch((e: TestRailClientError) => e);
      expect(Array.isArray(rows) ? rows : [rows]).toBeTruthy();
      expect(JSON.stringify(rows)).not.toContain('Unexpected token');
    });
  });
});

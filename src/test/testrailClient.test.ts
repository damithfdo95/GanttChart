import { describe, expect, it } from 'vitest';
import { createTestRailClient } from '../lib/testrail/client';
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
        { id: 'e1', runs: [{ id: 9001, name: 'Chrome', config: 'Chrome' }, { id: 9002, name: 'Android 14', config: 'Android 14' }] },
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

  it('fetches one standalone run', async () => {
    const { fetch } = recordingFetch((call) => (call.url.includes('get_run') ? response(200, { id: 42, name: 'Sanity' }) : response(200, [])));
    const run = await createTestRailClient(CONN, fetch).getRun(42);
    expect(run.id).toBe(42);
    expect(run.name).toBe('Sanity');
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
});

import { describe, expect, it } from 'vitest';
import { createJiraClient, encodeBasicAuth, resolveJiraFlavor } from '../lib/jira/client';
import { adfToPlainText, cleanPlainText } from '../lib/jira/adf';
import type { JiraClientError, JiraConnection } from '../../shared/jira';
import type { FetchLike } from '../lib/tenancy/api';

// ---- fake transport -------------------------------------------------------

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
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
      body: init?.body === undefined ? undefined : JSON.parse(init.body as string),
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { fetch, calls };
};

// ---- shared fixtures ------------------------------------------------------

const CLOUD = 'https://acme.atlassian.net';

const cloudConn = (over: Partial<JiraConnection> = {}): JiraConnection => ({
  baseUrl: CLOUD,
  email: 'sv@acme.example',
  token: 'tok-cloud',
  ...over,
});

const dcConn = (over: Partial<JiraConnection> = {}): JiraConnection => ({
  baseUrl: 'https://jira.acme.local',
  token: 'tok-dc',
  ...over,
});

const rawIssue = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: '10001',
  key: 'PROJ-42',
  fields: {
    summary: 'Fix login redirect',
    status: { name: 'In Progress', statusCategory: { name: 'In Progress' } },
    issuetype: { name: 'Bug' },
    priority: { name: 'High' },
    assignee: { displayName: 'Hana Sato' },
    reporter: { displayName: 'Ken Ito' },
    labels: ['regression', 'v6'],
    created: '2026-09-25T01:00:00.000Z',
    updated: '2026-09-30T02:00:00.000Z',
    versions: [{ name: '4.2.0', released: true }, { name: '4.3.0' }],
    description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Repro steps' }] }] },
  },
  ...over,
});

const cloudPage = (count: number, startKey = 1): Record<string, unknown>[] =>
  Array.from({ length: count }, (_, i) =>
    rawIssue({ id: String(10000 + startKey + i), key: `PROJ-${startKey + i}`, fields: { summary: `Issue ${startKey + i}` } }),
  );

async function searchFailure(conn: JiraConnection, fetch: FetchLike, jql = 'project = ABC'): Promise<JiraClientError> {
  try {
    await createJiraClient(conn, fetch).search({ jql });
    throw new Error('expected search to reject');
  } catch (e) {
    return e as JiraClientError;
  }
}

// ---- Cloud ------------------------------------------------------------------

describe('JIRA client — Cloud (v3 /search/jql, cursor paging)', () => {
  it('walks 2 cursor pages and stops when nextPageToken is gone', async () => {
    const { fetch, calls } = recordingFetch((_call, index) =>
      index === 0 ? response(200, { issues: cloudPage(100, 1), nextPageToken: 'tok-2' }) : response(200, { issues: cloudPage(30, 101) }),
    );
    const issues = await createJiraClient(cloudConn(), fetch).search({ jql: 'project = ABC', maxTotal: 500 });

    expect(issues).toHaveLength(130);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe(`${CLOUD}/rest/api/3/search/jql`);
    expect(calls[0]!.body).toMatchObject({
      jql: 'project = ABC',
      maxResults: 100,
      fields: ['summary', 'status', 'issuetype', 'priority', 'assignee', 'reporter', 'labels', 'created', 'updated', 'versions', 'description'],
    });
    expect('nextPageToken' in (calls[0]!.body as Record<string, unknown>)).toBe(false);
    expect(calls[1]!.body).toMatchObject({ nextPageToken: 'tok-2' });
    // Cloud auth: Basic base64(email:token).
    expect(calls[0]!.headers.Authorization).toBe(`Basic ${encodeBasicAuth('sv@acme.example', 'tok-cloud')}`);
  });

  it('stops at maxTotal mid-page (cap sliced to the request budget)', async () => {
    const { fetch, calls } = recordingFetch((_call, index) => (index === 0 ? response(200, { issues: cloudPage(100), nextPageToken: 'more' }) : response(200, { issues: cloudPage(5) })));
    const issues = await createJiraClient(cloudConn(), fetch).search({ jql: 'x', maxTotal: 50 });
    expect(issues).toHaveLength(50);
    expect(calls).toHaveLength(1);
  });

  it('hard-caps maxTotal at 1000', async () => {
    const { fetch } = recordingFetch(() => response(200, { issues: cloudPage(100), nextPageToken: 'more' }));
    // 11 pages would be needed for 1100; only 10 fit inside the cap.
    const issues = await createJiraClient(cloudConn(), fetch).search({ jql: 'x', maxTotal: 99999 });
    expect(issues).toHaveLength(1000);
  });

  it('maps raw fields to the normalized issue (ADF description flattened)', async () => {
    const { fetch } = recordingFetch(() =>
      response(200, {
        issues: [
          rawIssue({
            fields: {
              summary: '  Fix login  ',
              status: { name: 'Done', statusCategory: { name: 'Done' } },
              issuetype: { name: 'Story' },
              priority: { name: 'Low' },
              assignee: null,
              reporter: { displayName: 'Ken Ito' },
              labels: ['  spaced ', 42, 'ok'],
              updated: '2026-09-30T02:00:00.000Z',
              description: {
                type: 'doc',
                version: 1,
                content: [
                  { type: 'paragraph', content: [{ type: 'text', text: 'First' }] },
                  { type: 'paragraph', content: [{ type: 'text', text: 'Second' }] },
                ],
              },
            },
          }),
        ],
      }),
    );
    const [issue] = await createJiraClient(cloudConn(), fetch).search({ jql: 'x' });
    expect(issue).toMatchObject({
      id: '10001',
      key: 'PROJ-42',
      summary: '  Fix login  ',
      statusName: 'Done',
      statusCategoryName: 'Done',
      typeName: 'Story',
      priorityName: 'Low',
      assigneeName: undefined,
      reporterName: 'Ken Ito',
      labels: ['  spaced ', 'ok'],
      updated: '2026-09-30T02:00:00.000Z',
      descriptionPlain: 'First\nSecond',
    });
  });

  it('maps created and fix versions, tolerating missing/malformed values', async () => {
    const { fetch } = recordingFetch(() =>
      response(200, {
        issues: [
          rawIssue({
            fields: {
              created: '2026-09-25T01:00:00.000Z',
              versions: [
                { name: '4.2.0', released: true },
                { name: '4.3.0' },
                { noName: true },
                42,
                null,
                {},
              ],
            },
          }),
          // Missing created/versions ⇒ undefined / empty array.
          rawIssue({ id: '10002', key: 'PROJ-43', fields: { summary: 'No dates' } }),
        ],
      }),
    );
    const issues = await createJiraClient(cloudConn(), fetch).search({ jql: 'x' });
    expect(issues[0]).toMatchObject({
      key: 'PROJ-42',
      created: '2026-09-25T01:00:00.000Z',
      affectedVersions: ['4.2.0', '4.3.0'],
    });
    expect(issues[1]!.created).toBeUndefined();
    expect(issues[1]!.affectedVersions).toEqual([]);
  });

  it('testConnection fetches up to one issue with the default ordering JQL', async () => {
    const { fetch, calls } = recordingFetch(() => response(200, { issues: cloudPage(2) }));
    const issues = await createJiraClient(cloudConn(), fetch).testConnection();
    expect(issues).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ jql: 'ORDER BY created DESC', maxResults: 100 });
  });
});

// ---- Data Center -------------------------------------------------------------

describe('JIRA client — Data Center (v2 /search, offset paging)', () => {
  it('walks 2 offset pages using startAt += page length until total', async () => {
    const { fetch, calls } = recordingFetch((_call, index) =>
      index === 0
        ? response(200, { issues: cloudPage(2, 1), total: 3, startAt: 0, maxResults: 100 })
        : response(200, { issues: cloudPage(1, 3), total: 3, startAt: 2, maxResults: 100 }),
    );
    const issues = await createJiraClient(dcConn(), fetch).search({ jql: 'project = "QA 2026"' });

    expect(issues).toHaveLength(3);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url.startsWith('https://jira.acme.local/rest/api/2/search?')).toBe(true);
    const page1 = new URL(calls[0]!.url);
    expect(page1.searchParams.get('jql')).toBe('project = "QA 2026"');
    expect(page1.searchParams.get('startAt')).toBe('0');
    expect(page1.searchParams.get('maxResults')).toBe('100');
    expect(page1.searchParams.get('fields')).toBe('summary,status,issuetype,priority,assignee,reporter,labels,created,updated,versions,description');
    const page2 = new URL(calls[1]!.url);
    expect(page2.searchParams.get('startAt')).toBe('2');
    // DC auth: Bearer token.
    expect(calls[0]!.headers.Authorization).toBe('Bearer tok-dc');
  });

  it('stops early when a page is empty or total is reached', async () => {
    const { fetch, calls } = recordingFetch(() => response(200, { issues: [], total: 0 }));
    const issues = await createJiraClient(dcConn(), fetch).search({ jql: 'x' });
    expect(issues).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });
});

// ---- flavor detection --------------------------------------------------------

describe('flavor auto-detection', () => {
  it('host containing .atlassian.net resolves to Cloud (Basic auth)', async () => {
    const { fetch, calls } = recordingFetch(() => response(200, { issues: [] }));
    await createJiraClient(cloudConn(), fetch).search({ jql: 'x' });
    expect(calls[0]!.url).toContain('/rest/api/3/search/jql');
    expect(calls[0]!.headers.Authorization.startsWith('Basic ')).toBe(true);
  });

  it('any other host resolves to Data Center (Bearer auth)', async () => {
    const { fetch, calls } = recordingFetch(() => response(200, { issues: [], total: 0 }));
    await createJiraClient(dcConn(), fetch).search({ jql: 'x' });
    expect(calls[0]!.url).toContain('/rest/api/2/search');
    expect(calls[0]!.headers.Authorization).toBe('Bearer tok-dc');
  });

  it('an explicit flavor overrides auto detection', async () => {
    expect(resolveJiraFlavor({ baseUrl: CLOUD, flavor: 'dc', token: 't' }, CLOUD)).toBe('dc');
    expect(resolveJiraFlavor({ baseUrl: 'https://jira.acme.local', flavor: 'cloud', email: 'e', token: 't' }, 'https://jira.acme.local')).toBe('cloud');
  });

  it('auto resolves from the URL host', () => {
    expect(resolveJiraFlavor({ baseUrl: CLOUD }, CLOUD)).toBe('cloud');
    expect(resolveJiraFlavor({ baseUrl: 'https://jira.acme.local' }, 'https://jira.acme.local')).toBe('dc');
  });
});

// ---- proxy precedence ----------------------------------------------------------

describe('proxy precedence', () => {
  it('all requests go to the proxy root with the original JIRA path; base URL untouched', async () => {
    const { fetch, calls } = recordingFetch(() => response(200, { issues: [], total: 0 }));
    const client = createJiraClient(
      dcConn({ baseUrl: 'https://jira.acme.local/base/', proxyUrl: 'https://proxy.example.com/jira/' }),
      fetch,
    );
    await client.search({ jql: 'x', maxTotal: 1 });
    await client.testConnection();
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url.startsWith('https://proxy.example.com/jira/rest/api/2/search')).toBe(true);
      expect(call.url.includes('jira.acme.local')).toBe(false); // never the base URL
    }
    // trailing slashes are trimmed exactly once
    expect(calls[0]!.url).toContain('https://proxy.example.com/jira/rest/api/2/search?');
  });
});

// ---- error taxonomy ------------------------------------------------------------

describe('error mapping', () => {
  it('401 → auth, 403 → forbidden, 5xx → server', async () => {
    for (const [status, kind] of [[401, 'auth'], [403, 'forbidden'], [500, 'server'], [502, 'server']] as const) {
      const { fetch } = recordingFetch(() => response(status, {}));
      const err = await searchFailure(cloudConn(), fetch);
      expect(err.kind, `HTTP ${status}`).toBe(kind);
    }
  });

  it('400 → badRequest with the JIRA message (errorMessages + errors merged)', async () => {
    const { fetch } = recordingFetch(() =>
      response(400, { errorMessages: ['The value "BOGUS" does not exist'], errors: { jql: 'is not a valid JQL' } }),
    );
    const err = await searchFailure(cloudConn(), fetch);
    expect(err.kind).toBe('badRequest');
    expect(err.message).toContain('BOGUS');
    expect(err.message).toContain('is not a valid JQL');
  });

  it('429 waits once (Retry-After) then succeeds; a second 429 becomes rateLimit', async () => {
    let callIndex = 0;
    const { fetch, calls } = recordingFetch(() => {
      callIndex += 1;
      if (callIndex === 1) return response(429, {}, { 'retry-after': '0' });
      return response(200, { issues: cloudPage(1) });
    });
    const issues = await createJiraClient(cloudConn(), fetch).search({ jql: 'x' });
    expect(issues).toHaveLength(1);
    expect(calls).toHaveLength(2); // retried exactly once

    const { fetch: fetch429 } = recordingFetch(() => response(429, {}, { 'retry-after': '0' }));
    const err = await searchFailure(cloudConn(), fetch429);
    expect(err.kind).toBe('rateLimit');
    expect(err.status).toBe(429);
  });

  it('abort/timeout → timeout', async () => {
    const timeoutFetch: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted by test')));
      });
    try {
      await createJiraClient(cloudConn({ proxyUrl: 'https://proxy.example.com' }), timeoutFetch).search({ jql: 'x', timeoutMs: 20 });
      throw new Error('expected search to reject');
    } catch (e) {
      const err = e as JiraClientError;
      expect(err.kind).toBe('timeout');
      expect(err.message).toContain('timed out');
    }
  });

  it('a TypeError with no response on Cloud without a proxy → cors (with the proxy hint)', async () => {
    const corsFetch: FetchLike = async () => {
      throw new TypeError('Failed to fetch');
    };
    const err = await searchFailure(cloudConn(), corsFetch, 'x');
    expect(err.kind).toBe('cors');
    expect(err.message).toContain('proxy');
  });

  it('a TypeError with no response on Data Center without a proxy → also cors (JIRA DC does not enable CORS by default)', async () => {
    const networkFetch: FetchLike = async () => {
      throw new TypeError('Failed to fetch');
    };
    expect((await searchFailure(dcConn(), networkFetch, 'x')).kind).toBe('cors');
    // Cloud WITH a proxy is a network failure, not CORS.
    expect((await searchFailure(cloudConn({ proxyUrl: 'https://proxy.example.com' }), networkFetch, 'x')).kind).toBe('network');
  });

  it('missing base URL or missing credentials → notConfigured', async () => {
    const { fetch } = recordingFetch(() => response(200, { issues: [] }));
    const noBase = await searchFailure({ baseUrl: '' }, fetch, 'x');
    expect(noBase.kind).toBe('notConfigured');
    const noCloudCreds = await searchFailure({ baseUrl: CLOUD, email: 'sv@acme.example' }, fetch, 'x');
    expect(noCloudCreds.kind).toBe('notConfigured');
    const noDcToken = await searchFailure({ baseUrl: 'https://jira.acme.local' }, fetch, 'x');
    expect(noDcToken.kind).toBe('notConfigured');
  });
});

// ---- ADF walker ----------------------------------------------------------------

describe('adfToPlainText', () => {
  it('joins block-level content with newlines', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'First line' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second line' }] },
      ],
    };
    expect(adfToPlainText(doc)).toBe('First line\nSecond line');
  });

  it('flattens nested content (lists, code blocks, mentions, hard breaks)', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'One' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Two' }] }] },
          ],
        },
        { type: 'codeBlock', content: [{ type: 'text', text: 'const x = 1;' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Hi ' },
            { type: 'mention', attrs: { id: '1' } },
            { type: 'hardBreak' },
            { type: 'text', text: 'bye' },
          ],
        },
      ],
    };
    expect(adfToPlainText(doc)).toBe('One\nTwo\nconst x = 1;\nHi \nbye');
  });

  it('tables put cell text on one line (cells joined by space) and rows on separate lines', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Name' }] }] },
                { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Result' }] }] },
              ],
            },
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }] },
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Pass' }] }] },
              ],
            },
          ],
        },
      ],
    };
    expect(adfToPlainText(doc)).toBe('Name Result\nA Pass');
  });

  it('passes plain strings through and tolerates empty/garbage nodes', () => {
    expect(adfToPlainText('plain description')).toBe('plain description');
    expect(adfToPlainText(null)).toBe('');
    expect(adfToPlainText({ type: 'doc' })).toBe('');
    expect(adfToPlainText(42)).toBe('');
  });

  it('cleanPlainText trims and collapses blank runs', () => {
    expect(cleanPlainText('  a  \n\n\n\n  b  ')).toBe('a\n\nb');
    expect(cleanPlainText('  plain text  ')).toBe('plain text');
  });
});
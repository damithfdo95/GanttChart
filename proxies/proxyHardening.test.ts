/**
 * Negative tests for both integration proxies: fixed upstream, read-only methods, path allow-list, encoded-traversal rejection,
 * minimal forwarded headers, no credential logging. CORS is a browser policy, not authentication - these tests pin what the
 * workers themselves refuse.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- plain-JS Cloudflare workers, outside the TS project
import jiraWorker from '../jira-proxy/src/worker.js';
// @ts-expect-error -- plain-JS Cloudflare workers, outside the TS project
import testrailWorker from '../testrail-proxy/src/worker.js';

const JIRA_ORIGIN = 'https://jira.example.com/jira';
const TESTRAIL_ORIGIN = 'https://qa.testrail.example';
const jira = (path: string, init: RequestInit = {}) => jiraWorker.fetch(new Request(`https://jira-proxy.test${path}`, init), { JIRA_ORIGIN });
const testrail = (path: string, init: RequestInit = {}) => testrailWorker.fetch(new Request(`https://testrail-proxy.test${path}`, init), { TESTRAIL_ORIGIN });

const originalFetch = globalThis.fetch;
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});
const upstreamCalls = () => (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;

describe('jira-proxy', () => {
  it('rejects traversal and encoded bypass attempts before anything is forwarded', async () => {
    for (const path of ['/rest/%2e%2e/secure/admin', '/rest/api%2f..%2fadmin', '/rest/api/2/search%00', '/rest/..%5cadmin']) {
      const res = await jira(path);
      expect(res.status, path).toBe(404);
    }
    expect(upstreamCalls()).toHaveLength(0);
  });

  it('a literal or %2e-encoded dot segment cannot leave /rest/ (the URL parser folds it before the check)', async () => {
    expect((await jira('/rest/../secure/Dashboard.jspa')).status).toBe(404);
    expect(upstreamCalls()).toHaveLength(0);
    await jira('/rest/api/2/%2E%2E/%2E%2E/x');
    expect(String(upstreamCalls()[0]?.[0])).toBe(`${JIRA_ORIGIN}/rest/x`);
    // a backslash is a path separator to the URL parser, so it folds the same way and never leaves /rest/
    await jira('/rest/api\\..\\x');
    expect(String(upstreamCalls()[1]?.[0])).toBe(`${JIRA_ORIGIN}/rest/x`);
  });

  it('is read-only: no PUT / DELETE / PATCH, and POST only for the JQL search', async () => {
    for (const method of ['PUT', 'DELETE', 'PATCH']) expect((await jira('/rest/api/2/issue/ABC-1', { method, body: '{}' })).status, method).toBe(405);
    expect((await jira('/rest/api/2/issue', { method: 'POST', body: '{}' })).status).toBe(405);
    expect((await jira('/rest/api/2/search', { method: 'POST', body: '{}' })).status).toBe(200);
    expect((await jira('/rest/api/3/search/jql', { method: 'POST', body: '{}' })).status).toBe(200);
    expect(upstreamCalls()).toHaveLength(2);
  });

  it('always forwards to the fixed upstream origin - an absolute URL in the path cannot change the destination', async () => {
    await jira('/rest/api/2/serverInfo');
    await jira('/rest//evil.example.com/x');
    for (const call of upstreamCalls()) expect(String(call[0]).startsWith(`${JIRA_ORIGIN}/rest/`)).toBe(true);
  });

  it('relays only Authorization (never cookies or custom headers) and never logs it', async () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')].map((s) => s.mockImplementation(() => {}));
    await jira('/rest/api/2/myself', { headers: { Authorization: 'Bearer TOP-SECRET-PAT', Cookie: 'JSESSIONID=abc', 'X-Forwarded-For': '1.2.3.4' } });
    const sent = upstreamCalls()[0]?.[1].headers as Record<string, string>;
    expect(Object.keys(sent).sort()).toEqual(['Accept', 'Authorization']);
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain('TOP-SECRET-PAT');
  });
});

describe('testrail-proxy', () => {
  it('rejects encoded traversal in the API method', async () => {
    for (const path of ['/index.php?/api/v2/%2e%2e/admin', '/index.php?/api/v2/get_run%2f..%2f..%2fadmin', '/index.php?/api/v2/get_run%00', '/index.php?/api/v2/..%5cadmin']) {
      expect((await testrail(path)).status, path).toBe(404);
    }
    expect(upstreamCalls()).toHaveLength(0);
  });

  it('is read-only: only GET and HEAD are forwarded', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      expect((await testrail('/index.php?/api/v2/get_run/1', { method, body: '{}' })).status, method).toBe(405);
    }
    expect((await testrail('/index.php?/api/v2/get_run/1')).status).toBe(200);
    expect(upstreamCalls()).toHaveLength(1);
  });

  it('the documented contract passes through untouched: get_cases/{project}&suite_id={suite}', async () => {
    await testrail('/index.php?/api/v2/get_cases/12&suite_id=34&limit=250&offset=0');
    expect(upstreamCalls()[0]?.[0]).toBe(`${TESTRAIL_ORIGIN}/index.php?/api/v2/get_cases/12&suite_id=34&limit=250&offset=0`);
  });

  it('relays only Authorization and never logs it', async () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')].map((s) => s.mockImplementation(() => {}));
    await testrail('/index.php?/api/v2/get_run/1', { headers: { Authorization: 'Basic U0VDUkVU', Cookie: 'x=y' } });
    const sent = upstreamCalls()[0]?.[1].headers as Record<string, string>;
    expect(Object.keys(sent).sort()).toEqual(['Accept', 'Authorization']);
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain('U0VDUkVU');
  });
});

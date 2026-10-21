/**
 * Unit tests for the JIRA CORS forwarder worker (jira-proxy/src/worker.js).
 *
 * The upstream fetch is stubbed so no network is used; these tests pin the
 * security-relevant behavior: path filtering, CORS scoping to APP_ORIGIN,
 * preflight handling, header relay and upstream URL construction.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error -- plain-JS Cloudflare worker, outside the TS project
import worker from '../jira-proxy/src/worker.js';

const APP_ORIGIN = 'https://ganttchart.damithfdo.workers.dev';
const JIRA_ORIGIN = 'https://jira.example.com';

function makeRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`https://jira-proxy.test${path}`, init);
}

describe('jira-proxy worker', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } })),
    );
  });

  it('answers preflight from the app origin with CORS headers', async () => {
    const res = await worker.fetch(makeRequest('/rest/api/2/search', { method: 'OPTIONS', headers: { Origin: APP_ORIGIN } }), {});
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });

  it('refuses preflight from any other origin', async () => {
    const res = await worker.fetch(
      makeRequest('/rest/api/2/search', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }),
      {},
    );
    expect(res.status).toBe(403);
  });

  it('404s paths outside /rest/*', async () => {
    for (const path of ['/', '/admin', '/secure/Dashboard.jspa', '/restful/', '/rest']) {
      const res = await worker.fetch(makeRequest(path), { JIRA_ORIGIN });
      expect(res.status, path).toBe(404);
    }
  });

  it('reports 500 when JIRA_ORIGIN is not configured', async () => {
    const res = await worker.fetch(makeRequest('/rest/api/2/myself'), {});
    expect(res.status).toBe(500);
  });

  it('forwards /rest/* to the upstream with the Authorization header', async () => {
    const res = await worker.fetch(
      makeRequest('/rest/api/2/search?jql=project=X', { headers: { Authorization: 'Bearer pat' } }),
      { JIRA_ORIGIN },
    );
    expect(res.status).toBe(200);
    const called = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(called[0]).toBe(`${JIRA_ORIGIN}/rest/api/2/search?jql=project=X`);
    expect(called[1].headers.Authorization).toBe('Bearer pat');
    expect(called[1].headers.Accept).toBe('application/json');
  });

  it('strips a trailing slash from the configured origin', async () => {
    await worker.fetch(makeRequest('/rest/api/2/myself'), { JIRA_ORIGIN: `${JIRA_ORIGIN}/` });
    const called = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(called[0]).toBe(`${JIRA_ORIGIN}/rest/api/2/myself`);
  });

  it('relays POST bodies and the Content-Type header', async () => {
    const res = await worker.fetch(
      makeRequest('/rest/api/2/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN },
        body: JSON.stringify({ jql: 'project=X' }),
      }),
      { JIRA_ORIGIN },
    );
    expect(res.status).toBe(200);
    const called = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(called[1].method).toBe('POST');
    expect(called[1].headers['Content-Type']).toBe('application/json');
    expect(called[1].body).toBeDefined();
  });

  it('adds CORS headers to responses only for the app origin', async () => {
    const withOrigin = await worker.fetch(
      makeRequest('/rest/api/2/myself', { headers: { Origin: APP_ORIGIN } }),
      { JIRA_ORIGIN },
    );
    expect(withOrigin.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN);

    const bare = await worker.fetch(makeRequest('/rest/api/2/myself'), { JIRA_ORIGIN });
    expect(bare.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('does not relay cookie or unrelated headers upstream', async () => {
    await worker.fetch(
      makeRequest('/rest/api/2/myself', { headers: { Cookie: 'session=secret', 'X-Custom': 'x' } }),
      { JIRA_ORIGIN },
    );
    const called = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(called[1].headers.Cookie).toBeUndefined();
    expect(called[1].headers['X-Custom']).toBeUndefined();
  });

  it('honors an APP_ORIGIN override from the environment', async () => {
    const custom = 'https://custom.example.org';
    const preflight = await worker.fetch(
      makeRequest('/rest/api/2/search', { method: 'OPTIONS', headers: { Origin: custom } }),
      { APP_ORIGIN: custom },
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(custom);

    const res = await worker.fetch(makeRequest('/rest/api/2/myself', { headers: { Origin: custom } }), {
      JIRA_ORIGIN,
      APP_ORIGIN: custom,
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(custom);
  });

  it('rate-limits a client that exceeds the per-minute budget', async () => {
    let last: Response | null = null;
    for (let i = 0; i < 130; i += 1) {
      last = await worker.fetch(makeRequest('/rest/api/2/myself'), { JIRA_ORIGIN });
    }
    expect(last?.status).toBe(429);
  });
});

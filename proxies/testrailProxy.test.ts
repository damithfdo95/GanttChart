/**
 * Unit tests for the TestRail CORS forwarder worker (testrail-proxy/src/worker.js).
 *
 * The upstream fetch is stubbed so no network is used; these tests pin the
 * security-relevant behavior: the strict /index.php?/api/v2/* path+query
 * filter, CORS scoping to APP_ORIGIN, preflight handling and header relay.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error -- plain-JS Cloudflare worker, outside the TS project
import worker from '../testrail-proxy/src/worker.js';

const APP_ORIGIN = 'https://ganttchart.damithfdo.workers.dev';
const TESTRAIL_ORIGIN = 'https://rkong.testrail.com';

function makeRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`https://testrail-proxy.test${path}`, init);
}

describe('testrail-proxy worker', () => {
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
    const res = await worker.fetch(
      makeRequest('/index.php?/api/v2/get_run/103', { method: 'OPTIONS', headers: { Origin: APP_ORIGIN } }),
      {},
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN);
  });

  it('refuses preflight from any other origin', async () => {
    const res = await worker.fetch(
      makeRequest('/index.php?/api/v2/get_run/103', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }),
      {},
    );
    expect(res.status).toBe(403);
  });

  it('forwards only the documented API shape: /index.php with ?/api/v2/…', async () => {
    const ok = await worker.fetch(makeRequest('/index.php?/api/v2/get_run/103'), { TESTRAIL_ORIGIN });
    expect(ok.status).toBe(200);

    for (const path of [
      '/',
      '/index.php',
      '/index.php?/api/v1/get_run/103',
      '/index.php?/admin',
      '/api/v2/get_run/103',
      '/files/index.php?/api/v2/x',
    ]) {
      const res = await worker.fetch(makeRequest(path), { TESTRAIL_ORIGIN });
      expect(res.status, path).toBe(404);
    }
  });

  it('reports 500 when TESTRAIL_ORIGIN is not configured', async () => {
    const res = await worker.fetch(makeRequest('/index.php?/api/v2/get_run/103'), {});
    expect(res.status).toBe(500);
  });

  it('forwards the request with the Authorization header and full query', async () => {
    await worker.fetch(
      makeRequest('/index.php?/api/v2/get_runs/7&limit=5', { headers: { Authorization: 'Basic dXNlcjprZXk=' } }),
      { TESTRAIL_ORIGIN },
    );
    const called = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(called[0]).toBe(`${TESTRAIL_ORIGIN}/index.php?/api/v2/get_runs/7&limit=5`);
    expect(called[1].headers.Authorization).toBe('Basic dXNlcjprZXk=');
    expect(called[1].headers.Accept).toBe('application/json');
  });

  it('adds CORS headers to responses only for the app origin', async () => {
    const withOrigin = await worker.fetch(
      makeRequest('/index.php?/api/v2/get_run/103', { headers: { Origin: APP_ORIGIN } }),
      { TESTRAIL_ORIGIN },
    );
    expect(withOrigin.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN);

    const bare = await worker.fetch(makeRequest('/index.php?/api/v2/get_run/103'), { TESTRAIL_ORIGIN });
    expect(bare.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('does not relay cookie or unrelated headers upstream', async () => {
    await worker.fetch(
      makeRequest('/index.php?/api/v2/get_run/103', { headers: { Cookie: 'session=secret', 'X-Custom': 'x' } }),
      { TESTRAIL_ORIGIN },
    );
    const called = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(called[1].headers.Cookie).toBeUndefined();
    expect(called[1].headers['X-Custom']).toBeUndefined();
  });

  it('honors an APP_ORIGIN override from the environment', async () => {
    const custom = 'https://custom.example.org';
    const preflight = await worker.fetch(
      makeRequest('/index.php?/api/v2/get_run/103', { method: 'OPTIONS', headers: { Origin: custom } }),
      { APP_ORIGIN: custom },
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(custom);
  });

  it('rate-limits a client that exceeds the per-minute budget', async () => {
    let last: Response | null = null;
    for (let i = 0; i < 130; i += 1) {
      last = await worker.fetch(makeRequest('/index.php?/api/v2/get_run/103'), { TESTRAIL_ORIGIN });
    }
    expect(last?.status).toBe(429);
  });
});

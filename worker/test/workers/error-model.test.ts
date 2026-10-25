import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { BASE, SUPER, call, get } from './tenancy-harness';

/** The safe error model through the real Worker entry: a stable code, a request id, and nothing technical. */

describe('API errors carry a request id and never a stack trace', () => {
  it('a refused request answers with a code, a requestId in the body and the X-Request-Id header', async () => {
    const res = await exports.default.fetch(new Request(`${BASE}/api/whoami`, { headers: { 'x-dev-email': `stranger-${crypto.randomUUID().slice(0, 6)}@example.com` } }));
    expect(res.status).toBe(403);
    const header = res.headers.get('X-Request-Id');
    expect(header).toMatch(/^[0-9a-f-]{36}$/);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('forbidden');
    expect(body.requestId).toBe(header);
    expect(JSON.stringify(body)).not.toMatch(/stack|at \w+ \(|\.ts:\d+|node_modules/i);
  });

  it('a not-found API path and a successful call also get the header; ids differ between requests', async () => {
    const missing = await call(SUPER, 'GET', '/api/does-not-exist');
    expect(missing.status).toBe(404);
    expect(missing.json).toMatchObject({ error: 'Not found' });
    expect(typeof (missing.json as { requestId?: unknown }).requestId).toBe('string');
    const ok = await exports.default.fetch(new Request(`${BASE}/api/whoami`, { headers: { 'x-dev-email': SUPER } }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('X-Request-Id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(ok.headers.get('X-Request-Id')).not.toBe(missing.json && (missing.json as { requestId?: string }).requestId);
  });

  it('a successful JSON body is not given an error field', async () => {
    const who = await get(SUPER, '/api/whoami');
    expect(who.status).toBe(200);
    expect(who.json).not.toHaveProperty('requestId');
  });
});

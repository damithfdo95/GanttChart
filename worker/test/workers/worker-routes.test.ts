import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../../../shared/protocol';
import { wrap } from './helpers';

// Requests go through the REAL Worker entry (auth, origin checks, routing)
// with the development identity (ENVIRONMENT=development, localhost only).
const HOST = 'http://localhost:8787';
const get = (path: string, init: RequestInit = {}) => exports.default.fetch(new Request(`${HOST}${path}`, init));

describe('HTTP API', () => {
  it('whoami returns the verified (dev) identity with security headers', async () => {
    const res = await get('/api/whoami');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: 'dev@localhost', role: 'admin' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('refuses the development identity on a non-local host (fails closed)', async () => {
    const res = await exports.default.fetch(new Request('https://gantt.example.com/api/whoami'));
    expect(res.status).toBe(403);
  });

  it('exports, lists revisions and 404s unknown routes', async () => {
    expect(await (await get('/api/export')).json()).toEqual({ revision: 0, records: [] });
    expect(await (await get('/api/revisions')).json()).toEqual([]);
    expect((await get('/api/nope')).status).toBe(404);
    expect((await get('/api/revisions/abc')).status).toBe(400);
    expect((await get('/api/revisions/7')).status).toBe(404);
  });

  it('protects state-changing requests: needs same-origin Origin AND the intent header', async () => {
    const restore = (headers: Record<string, string>) => get('/api/revisions/1/restore', { method: 'POST', headers });
    expect((await restore({})).status).toBe(403); // no Origin
    expect((await restore({ Origin: 'https://evil.example' })).status).toBe(403);
    expect((await restore({ Origin: HOST })).status).toBe(403); // no intent header
    const ok = await restore({ Origin: HOST, 'X-GC-Intent': 'restore' });
    expect(ok.status).toBe(409); // authorized; revision 1 simply does not exist
  });
});

describe('WebSocket through the Worker', () => {
  const upgrade = (headers: Record<string, string>) => get('/ws', { headers: { Upgrade: 'websocket', ...headers } });

  it('rejects upgrades from other origins and upgrades without an Origin', async () => {
    expect((await upgrade({ Origin: 'https://evil.example' })).status).toBe(403);
    expect((await upgrade({})).status).toBe(403);
    expect((await get('/ws')).status).toBe(426);
  });

  it('accepts a same-origin upgrade and ignores identity headers sent by the client', async () => {
    const res = await upgrade({ Origin: HOST, 'x-gc-verified-email': 'attacker@evil.example', 'x-gc-verified-role': 'admin' });
    expect(res.status).toBe(101);
    const sock = wrap(res.webSocket!, 'dev');
    sock.send({ t: 'hello', v: PROTOCOL_VERSION, clientId: 'route-test', lastRevision: null });
    const ready = await sock.next('ready');
    expect(ready.you).toEqual({ email: 'dev@localhost', role: 'admin' }); // the verified identity, not the spoofed one
    sock.close();
  });
});

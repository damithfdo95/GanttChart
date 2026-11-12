import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { SESSION_RECHECK_MS } from '../../src/workspaceRoomShared';
import { commitMsg, identityHeaders, join, newWorkspace, rec } from './helpers';

/**
 * Defence in depth for the live-sync WebSocket: the registry closes a person's
 * sockets when their session is revoked (the push), but if that push ever raced
 * or failed, the NEXT MESSAGE still re-checks the session row in the registry
 * (the pull, cached for SESSION_RECHECK_MS). These tests go straight to the
 * Durable Object with the internal headers the Worker sets after verifying a
 * password sign-in — including x-gc-session, the session id.
 */

const registry = () => env.REGISTRY.getByName('registry');

/** Seed a real session row in the registry (what POST /api/auth/login does), with the tenant + user it references. */
async function seedSession(id: string, userId: string, email: string): Promise<void> {
  const tenantId = `ten_${userId.slice(0, 24)}`;
  const now = new Date().toISOString();
  await runInDurableObject(registry(), async (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO tenants (id, name, storage_mode, status, created_at, updated_at) VALUES (?, ?, 'web', 'active', ?, ?)`,
      tenantId,
      `WS recheck ${id}`,
      now,
      now,
    );
    state.storage.sql.exec(
      `INSERT INTO users (id, email, tenant_id, role, access, status, created_at, updated_at) VALUES (?, ?, ?, 'user', 'editor', 'active', ?, ?)`,
      userId,
      email,
      tenantId,
      now,
      now,
    );
    state.storage.sql.exec(
      `INSERT INTO sessions (id, user_id, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
      id,
      userId,
      email,
      now,
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    );
  });
}

/** Delete a session row (what a revocation does server-side). */
async function revokeSession(id: string): Promise<void> {
  await runInDurableObject(registry(), async (_instance, state) => {
    state.storage.sql.exec(`DELETE FROM sessions WHERE id = ?`, id);
  });
}

/** Connect with a session id header (the Worker sets it from the verified token's sid). */
async function connectWithSession(ws: ReturnType<typeof newWorkspace>, sessionId: string | null, email = 'alice@example.com') {
  const headers = { ...identityHeaders(ws, email, 'admin'), ...(sessionId === null ? {} : { 'x-gc-session': sessionId }) };
  const res = await ws.fetch(new Request('http://localhost/ws', { headers }));
  if (res.status !== 101 || res.webSocket === null) throw new Error(`upgrade failed: ${res.status}`);
  return res;
}

describe('WebSocket session re-check (defence in depth)', () => {
  it('a socket without a session id (dev identity / sid-less Access JWT) is unaffected', async () => {
    const ws = newWorkspace();
    const { sock } = await join(ws, 'dev@example.com'); // no x-gc-session header
    await sock.next('snapshot');
    sock.send(commitMsg(0, [rec('project', 'a', 1)]));
    expect((await sock.next('ack')).revision).toBe(1); // commits keep working
    sock.close();
  });

  it('a live session id is accepted: commits keep working', async () => {
    const ws = newWorkspace();
    const sid = `sess-${crypto.randomUUID()}`;
    await seedSession(sid, 'usr_test_alice@example.com', 'alice@example.com');
    const res = await connectWithSession(ws, sid);
    res.webSocket!.accept();
    const { wrap } = await import('./helpers');
    const sock = wrap(res.webSocket!, 'alice@example.com');
    sock.send({ t: 'hello', v: 1, clientId: 'c1', lastRevision: null });
    await sock.next('ready');
    await sock.next('snapshot');
    sock.send(commitMsg(0, [rec('project', 'a', 1)]));
    expect((await sock.next('ack')).revision).toBe(1);
    sock.close();
  });

  it('a revoked session is refused on its next message: session_expired + close 4401, the write is NOT applied', async () => {
    const ws = newWorkspace();
    const sid = `sess-${crypto.randomUUID()}`;
    await seedSession(sid, 'usr_test_bob@example.com', 'bob@example.com');
    const res = await connectWithSession(ws, sid, 'bob@example.com');
    const { wrap } = await import('./helpers');
    const sock = wrap(res.webSocket!, 'bob@example.com');
    sock.send({ t: 'hello', v: 1, clientId: 'c1', lastRevision: null });
    await sock.next('ready');
    await sock.next('snapshot');
    sock.send(commitMsg(0, [rec('project', 'a', 1)]));
    expect((await sock.next('ack')).revision).toBe(1); // still valid at this point

    await revokeSession(sid); // the push-close is NOT simulated: only the row is gone
    await new Promise((r) => setTimeout(r, 350)); // the re-check cache TTL (SESSION_RECHECK_MS=300 in the test config)
    sock.send(commitMsg(1, [rec('project', 'a', 2)]));
    expect(await sock.next('error')).toMatchObject({ code: 'session_expired' });
    expect((await sock.closed).code).toBe(4401);
    expect((await ws.exportAll()).records[0].json).toBe('1'); // the late write was NOT applied
  });

  it('a passed check is cached: a second message within the TTL does not re-query the registry', async () => {
    const ws = newWorkspace();
    const sid = `sess-${crypto.randomUUID()}`;
    await seedSession(sid, 'usr_test_carol@example.com', 'carol@example.com');
    const res = await connectWithSession(ws, sid, 'carol@example.com');
    const { wrap } = await import('./helpers');
    const sock = wrap(res.webSocket!, 'carol@example.com');
    sock.send({ t: 'hello', v: 1, clientId: 'c1', lastRevision: null });
    await sock.next('ready');
    await sock.next('snapshot');
    sock.send(commitMsg(0, [rec('project', 'a', 1)]));
    expect((await sock.next('ack')).revision).toBe(1); // first message: registry queried, result cached

    // The session row disappears, but the cache is still warm (SESSION_RECHECK_MS).
    await revokeSession(sid);
    sock.send(commitMsg(1, [rec('project', 'a', 2)]));
    expect((await sock.next('ack')).revision).toBe(2); // accepted from the cache
    sock.close();
    expect(SESSION_RECHECK_MS).toBeGreaterThan(0); // the TTL the test relies on
  });
});

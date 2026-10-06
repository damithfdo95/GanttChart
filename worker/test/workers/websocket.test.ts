import { evictDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, LIMITS } from '../../../shared/protocol';
import { commitMsg, connect, join, newWorkspace, rec } from './helpers';

describe('connect + hello', () => {
  it('refuses plain HTTP and upgrades without a verified identity', async () => {
    const ws = newWorkspace();
    expect((await ws.fetch(new Request('http://localhost/ws'))).status).toBe(426);
    const noIdentity = await ws.fetch(new Request('http://localhost/ws', { headers: { Upgrade: 'websocket' } }));
    expect(noIdentity.status).toBe(401);
    const badRole = await ws.fetch(
      new Request('http://localhost/ws', { headers: { Upgrade: 'websocket', 'x-gc-verified-email': 'a@b.c', 'x-gc-verified-role': 'root' } }),
    );
    expect(badRole.status).toBe(401);
  });

  it('first connect gets ready (with identity) then an empty snapshot', async () => {
    const { sock, ready } = await join(newWorkspace(), 'alice@example.com');
    expect(ready).toEqual({ t: 'ready', v: PROTOCOL_VERSION, revision: 0, you: { email: 'alice@example.com', role: 'editor' } });
    expect(await sock.next('snapshot')).toEqual({ t: 'snapshot', revision: 0, records: [] });
    sock.close();
  });

  it('answers ping with pong', async () => {
    const { sock } = await join(newWorkspace());
    sock.send({ t: 'ping' });
    expect(await sock.next('pong')).toEqual({ t: 'pong' });
    sock.close();
  });
});

describe('commit, ack and broadcast to multiple clients', () => {
  it('acks the sender, broadcasts to everyone else (not back to the sender), with the actor', async () => {
    const ws = newWorkspace();
    const alice = (await join(ws, 'alice@example.com')).sock;
    const bob = (await join(ws, 'bob@example.com')).sock;
    const carol = (await join(ws, 'carol@example.com')).sock;
    await Promise.all([alice.next('snapshot'), bob.next('snapshot'), carol.next('snapshot')]);

    alice.send(commitMsg(0, [rec('project', 'p1', { name: 'Login' })], [], 'c-1'));
    expect(await alice.next('ack')).toEqual({ t: 'ack', id: 'c-1', revision: 1, changed: true });

    for (const other of [bob, carol]) {
      const changes = await other.next('changes');
      expect(changes).toMatchObject({ revision: 1, actor: 'alice@example.com', puts: [{ kind: 'project', id: 'p1' }], deletes: [] });
      expect(changes.catchUp).toBeUndefined();
    }
    await alice.expectNone('changes'); // no echo to the author
    [alice, bob, carol].forEach((s) => s.close());
  });

  it('a late joiner sees everything committed so far in its snapshot', async () => {
    const ws = newWorkspace();
    const alice = (await join(ws)).sock;
    await alice.next('snapshot');
    alice.send(commitMsg(0, [rec('project', 'p1', 1), rec('report', 'r1', 1)]));
    await alice.next('ack');
    const { sock: dave } = await join(ws, 'dave@example.com');
    const snap = await dave.next('snapshot');
    expect(snap.revision).toBe(1);
    expect(snap.records.map((r) => `${r.kind}:${r.id}`)).toEqual(['project:p1', 'report:r1']);
  });
});

describe('conflicts and duplicate commits', () => {
  it('merges edits to different records and rejects the same record with the server version', async () => {
    const ws = newWorkspace();
    const alice = (await join(ws, 'alice@example.com')).sock;
    const bob = (await join(ws, 'bob@example.com')).sock;
    await Promise.all([alice.next('snapshot'), bob.next('snapshot')]);
    alice.send(commitMsg(0, [rec('project', 'a', 0), rec('project', 'b', 0)]));
    await alice.next('ack');
    await bob.next('changes');

    // Both edit on base 1: different records → both accepted.
    alice.send(commitMsg(1, [rec('project', 'a', 'alice')], [], 'a-1'));
    bob.send(commitMsg(1, [rec('project', 'b', 'bob')], [], 'b-1'));
    const [ackA, ackB] = await Promise.all([alice.next('ack'), bob.next('ack')]);
    expect([ackA.revision, ackB.revision].sort()).toEqual([2, 3]);

    // Same record on a stale base → conflict, nothing applied.
    bob.send(commitMsg(1, [rec('project', 'a', 'bob-late')], [], 'b-2'));
    const reject = await bob.next('reject');
    expect(reject).toMatchObject({ id: 'b-2', reason: 'conflict', revision: 3, conflicts: [{ kind: 'project', id: 'a', json: '"alice"' }] });
    expect((await ws.exportAll()).records.find((r) => r.id === 'a')?.json).toBe('"alice"');
  });

  it('applies a duplicate commit once and does not re-broadcast it', async () => {
    const ws = newWorkspace();
    const alice = (await join(ws, 'alice@example.com')).sock;
    const bob = (await join(ws, 'bob@example.com')).sock;
    await Promise.all([alice.next('snapshot'), bob.next('snapshot')]);

    const msg = commitMsg(0, [rec('member', 'm1', 1)], [], 'same-id');
    alice.send(msg);
    alice.send(msg); // network retry
    const first = await alice.next('ack');
    const second = await alice.next('ack');
    expect(first.revision).toBe(1);
    expect(second.revision).toBe(1);
    expect((await bob.next('changes')).revision).toBe(1);
    await bob.expectNone('changes');
    expect((await ws.stats()).revision).toBe(1);
  });

  it('does not create a revision for a no-op commit', async () => {
    const ws = newWorkspace();
    const alice = (await join(ws)).sock;
    await alice.next('snapshot');
    alice.send(commitMsg(0, [rec('member', 'm', 1)]));
    await alice.next('ack');
    alice.send(commitMsg(1, [rec('member', 'm', 1)]));
    expect(await alice.next('ack')).toMatchObject({ revision: 1, changed: false });
  });
});

describe('permissions and protocol errors', () => {
  it('viewers receive broadcasts but cannot write', async () => {
    const ws = newWorkspace();
    const editor = (await join(ws, 'editor@example.com')).sock;
    const viewer = (await join(ws, 'viewer@example.com', null, 'viewer')).sock;
    await Promise.all([editor.next('snapshot'), viewer.next('snapshot')]);
    viewer.send(commitMsg(0, [rec('project', 'x', 1)], [], 'v-1'));
    expect(await viewer.next('reject')).toMatchObject({ id: 'v-1', reason: 'forbidden' });
    expect((await ws.stats()).revision).toBe(0);
    editor.send(commitMsg(0, [rec('project', 'y', 1)]));
    await editor.next('ack');
    expect((await viewer.next('changes')).revision).toBe(1);
  });

  it('requires hello before commit', async () => {
    const sock = await connect(newWorkspace());
    sock.send(commitMsg(0, [rec('project', 'x', 1)]));
    expect(await sock.next('error')).toMatchObject({ code: 'hello_required' });
  });

  it('reports bad frames but keeps the connection usable', async () => {
    const { sock } = await join(newWorkspace());
    await sock.next('snapshot');
    sock.sendRaw('not json');
    expect(await sock.next('error')).toMatchObject({ code: 'bad_message' });
    sock.send({ t: 'commit', id: 'x', baseRevision: 0, puts: [{ kind: 'nope', id: 'a', json: '{}' }], deletes: [] });
    expect(await sock.next('error')).toMatchObject({ code: 'bad_message' });
    sock.send({ t: 'ping' });
    expect(await sock.next('pong')).toEqual({ t: 'pong' });
  });

  it('closes on binary frames and on oversize frames', async () => {
    const binary = (await join(newWorkspace())).sock;
    binary.sendRaw(new ArrayBuffer(4));
    expect((await binary.closed).code).toBe(1003);
    const big = (await join(newWorkspace())).sock;
    big.sendRaw('x'.repeat(LIMITS.maxMessageChars + 1));
    expect((await big.closed).code).toBe(1009);
  });
});

describe('disconnect and reconnect', () => {
  it('a reconnecting client receives exactly what it missed (puts and deletes) as catch-up', async () => {
    const ws = newWorkspace();
    const alice = (await join(ws, 'alice@example.com')).sock;
    const bob = (await join(ws, 'bob@example.com')).sock;
    await Promise.all([alice.next('snapshot'), bob.next('snapshot')]);
    alice.send(commitMsg(0, [rec('project', 'a', 1), rec('project', 'gone', 1)]));
    await alice.next('ack');
    await bob.next('changes');

    bob.close(); // Bob drops off at revision 1
    await bob.closed;

    alice.send(commitMsg(1, [rec('project', 'a', 2)], [{ kind: 'project', id: 'gone' }]));
    await alice.next('ack');
    alice.send(commitMsg(2, [rec('report', 'r', 1)]));
    await alice.next('ack');

    const { sock: bob2, ready } = await join(ws, 'bob@example.com', 1);
    expect(ready.revision).toBe(3);
    const catchUp = await bob2.next('changes');
    expect(catchUp).toMatchObject({ revision: 3, catchUp: true, deletes: [{ kind: 'project', id: 'gone' }] });
    expect(catchUp.puts.map((p) => `${p.kind}:${p.id}=${p.json}`).sort()).toEqual(['project:a=2', 'report:r=1']);
    // …and is live again afterwards.
    alice.send(commitMsg(3, [rec('report', 'r', 2)]));
    await alice.next('ack');
    expect((await bob2.next('changes')).revision).toBe(4);
  });

  it('a client claiming a revision from the future gets a full snapshot', async () => {
    const ws = newWorkspace();
    const alice = (await join(ws)).sock;
    await alice.next('snapshot');
    alice.send(commitMsg(0, [rec('project', 'a', 1)]));
    await alice.next('ack');
    const { sock } = await join(ws, 'bob@example.com', 999);
    expect((await sock.next('snapshot')).records).toHaveLength(1);
  });

  it('keeps serving the others when a client disconnects', async () => {
    const ws = newWorkspace();
    const alice = (await join(ws, 'alice@example.com')).sock;
    const bob = (await join(ws, 'bob@example.com')).sock;
    await Promise.all([alice.next('snapshot'), bob.next('snapshot')]);
    bob.close();
    await bob.closed;
    alice.send(commitMsg(0, [rec('project', 'a', 1)]));
    expect((await alice.next('ack')).revision).toBe(1);
    await waitFor(async () => expect((await ws.stats()).connections).toBe(1));
  });
});

describe('Access session lifetime', () => {
  it('refuses a connection whose Access session has already ended', async () => {
    const ws = newWorkspace();
    const res = await ws.fetch(
      new Request('http://localhost/ws', {
        headers: { Upgrade: 'websocket', 'x-gc-verified-email': 'a@b.c', 'x-gc-verified-role': 'editor', 'x-gc-verified-exp': String(Date.now() - 1000) },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('closes a socket whose session ends: next message gets session_expired + close 4401', async () => {
    const ws = newWorkspace();
    const { sock } = await join(ws, 'alice@example.com', null, 'editor', Date.now() + 1200);
    await sock.next('snapshot');
    sock.send(commitMsg(0, [rec('project', 'a', 1)]));
    expect((await sock.next('ack')).revision).toBe(1); // still valid
    await new Promise((r) => setTimeout(r, 1400)); // the session ends
    sock.send(commitMsg(1, [rec('project', 'a', 2)]));
    expect(await sock.next('error')).toMatchObject({ code: 'session_expired' });
    expect((await sock.closed).code).toBe(4401);
    expect((await ws.exportAll()).records[0].json).toBe('1'); // the late write was NOT applied
  });

  it('never delivers a broadcast to an expired session, and closes it', async () => {
    const ws = newWorkspace();
    const writer = (await join(ws, 'writer@example.com')).sock;
    const short = (await join(ws, 'short@example.com', null, 'editor', Date.now() + 1000)).sock;
    await Promise.all([writer.next('snapshot'), short.next('snapshot')]);
    await new Promise((r) => setTimeout(r, 1200)); // short's session has ended (it never sent anything)
    writer.send(commitMsg(0, [rec('project', 'secret', 'classified')]));
    await writer.next('ack');
    expect((await short.closed).code).toBe(4401);
    await short.expectNone('changes'); // it never saw the data
  });
});

describe('closing', () => {
  it('completes the close handshake promptly and frees the connection (no half-closed lingering)', async () => {
    const ws = newWorkspace();
    const { sock } = await join(ws, 'alice@example.com');
    await sock.next('snapshot');
    expect((await ws.stats()).connections).toBe(1);
    const started = Date.now();
    sock.close(1000);
    await sock.closed;
    expect(Date.now() - started).toBeLessThan(2000); // used to take ~10 s
    await waitFor(async () => expect((await ws.stats()).connections).toBe(0), 2000);
  });

  it('answers a close with an application code (e.g. 4002) the same way', async () => {
    const ws = newWorkspace();
    const { sock } = await join(ws);
    await sock.next('snapshot');
    const started = Date.now();
    sock.close(4002);
    expect((await sock.closed).code).toBe(4002);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('hibernation / eviction', () => {
  it('a hibernated connection keeps its session: commits and broadcasts work without a new hello', async () => {
    const ws = newWorkspace();
    const alice = (await join(ws, 'alice@example.com')).sock;
    const bob = (await join(ws, 'bob@example.com')).sock;
    await Promise.all([alice.next('snapshot'), bob.next('snapshot')]);
    alice.send(commitMsg(0, [rec('project', 'a', 1)]));
    await alice.next('ack');
    await bob.next('changes');

    await evictDurableObject(ws); // object leaves memory; sockets hibernate

    alice.send(commitMsg(1, [rec('project', 'a', 2)], [], 'after-evict'));
    expect(await alice.next('ack')).toMatchObject({ id: 'after-evict', revision: 2 });
    expect(await bob.next('changes')).toMatchObject({ revision: 2, actor: 'alice@example.com' });
    expect(alice.isOpen && bob.isOpen).toBe(true);
    // Data survived the eviction.
    expect((await ws.exportAll()).records[0].json).toBe('2');
  });

  it('when sockets are closed during eviction, clients reconnect and catch up', async () => {
    const ws = newWorkspace();
    const alice = (await join(ws, 'alice@example.com')).sock;
    await alice.next('snapshot');
    alice.send(commitMsg(0, [rec('project', 'a', 1)]));
    await alice.next('ack');
    await evictDurableObject(ws, { webSockets: 'close' });
    await alice.closed;
    const { sock, ready } = await join(ws, 'alice@example.com', 1);
    expect(ready.revision).toBe(1);
    expect((await sock.next('changes')).puts).toEqual([]);
  });

  it('retention alarm runs and leaves the workspace intact', async () => {
    const ws = newWorkspace();
    const alice = (await join(ws)).sock;
    await alice.next('snapshot');
    alice.send(commitMsg(0, [rec('project', 'a', 1)]));
    await alice.next('ack');
    expect(await runDurableObjectAlarm(ws)).toBe(true);
    expect((await ws.exportAll()).revision).toBe(1);
    expect(await ws.listRevisions(10)).toHaveLength(1); // recent history is never pruned
  });
});

describe('server-side restore', () => {
  it('restores an old revision as a new one and pushes it to every connected client', async () => {
    const ws = newWorkspace();
    const alice = (await join(ws, 'alice@example.com')).sock;
    const bob = (await join(ws, 'bob@example.com')).sock;
    await Promise.all([alice.next('snapshot'), bob.next('snapshot')]);
    alice.send(commitMsg(0, [rec('project', 'a', 'v1')]));
    await alice.next('ack');
    alice.send(commitMsg(1, [rec('project', 'a', 'v2')]));
    await alice.next('ack');
    await bob.next('changes');
    await bob.next('changes');

    expect(await ws.restoreRevision(1, 'admin@example.com')).toEqual({ ok: true, revision: 3 });
    for (const s of [alice, bob]) {
      expect(await s.next('changes')).toMatchObject({ revision: 3, actor: 'admin@example.com', puts: [{ id: 'a', json: '"v1"' }] });
    }
    expect(await ws.restoreRevision(99, 'admin@example.com')).toEqual({ ok: false, error: 'revision-unavailable' });
    expect((await ws.listRevisions(10)).map((r) => r.revision)).toEqual([3, 2, 1]);
  });
});

async function waitFor(assertion: () => Promise<void>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

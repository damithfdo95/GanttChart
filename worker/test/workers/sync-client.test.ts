import { evictDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { SyncClient, type StashedEdit, type SyncHost, type SyncNotice, type SyncSocket, type SyncState } from '../../../src/lib/sync/client';
import { recordKey, type RecordKey } from '../../../src/lib/sync/records';
import type { RecordDelete, RecordPut, Role } from '../../../shared/protocol';
import { identityHeaders, newWorkspace, rec, type Workspace } from './helpers';

/**
 * The REAL SyncClient talking to the REAL Durable Object (workerd): the
 * exact protocol, per-record concurrency, broadcast and hibernation, with no
 * mocks on either side. Only the transport is adapted: instead of dialing a
 * URL, the socket is opened through the Durable Object stub.
 */

interface LiveSocket extends SyncSocket {
  /** Simulate the network dropping (abnormal close). */
  drop(): void;
}

function socketFactory(workspace: Workspace, email: string, role: Role = 'editor') {
  const opened: LiveSocket[] = [];
  const create = (): SyncSocket => {
    let ws: WebSocket | null = null;
    const sock: LiveSocket = {
      readyState: 0,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: (data) => ws?.send(data),
      close: (code, reason) => {
        if (ws !== null && sock.readyState !== 3) ws.close(code === undefined || code === 1005 ? 1000 : code, reason);
      },
      drop: () => ws?.close(4002, 'test: network drop'),
    };
    opened.push(sock);
    void workspace
      .fetch(new Request('http://localhost/ws', { headers: identityHeaders(workspace, email, role) }))
      .then((res) => {
        ws = res.webSocket!;
        ws.accept();
        ws.addEventListener('message', (e) => sock.onmessage?.({ data: e.data }));
        ws.addEventListener('close', (e) => {
          (sock as { readyState: number }).readyState = 3;
          sock.onclose?.({ code: e.code });
        });
        (sock as { readyState: number }).readyState = 1;
        sock.onopen?.();
      });
    return sock;
  };
  return { create, opened };
}

class Device implements SyncHost {
  records = new Map<RecordKey, RecordPut>();
  state: SyncState | null = null;
  notices: SyncNotice[] = [];
  stash: StashedEdit[] = [];
  client: SyncClient;
  private factory: ReturnType<typeof socketFactory>;

  constructor(
    workspace: Workspace,
    readonly email: string,
    opts: { role?: Role; firstState?: 'apply' | 'overwrite'; local?: RecordPut[] } = {},
  ) {
    for (const r of opts.local ?? []) this.records.set(recordKey(r.kind, r.id), r);
    this.factory = socketFactory(workspace, email, opts.role);
    this.client = new SyncClient({
      url: 'ws://test/ws',
      host: this,
      createSocket: this.factory.create,
      clientId: `device-${email}-${crypto.randomUUID()}`,
      firstState: opts.firstState,
      stashEdit: (e) => this.stash.push(e),
      commitDebounceMs: 20,
      heartbeatMs: 600_000,
      random: () => 0, // shortest backoff (500 ms) so reconnect tests stay quick
    });
  }

  readRecords() {
    return this.records;
  }
  applyRemote(puts: RecordPut[], deletes: RecordDelete[]) {
    for (const p of puts) this.records.set(recordKey(p.kind, p.id), p);
    for (const d of deletes) this.records.delete(recordKey(d.kind, d.id));
  }
  onState(state: SyncState) {
    this.state = state;
  }
  onNotice(notice: SyncNotice) {
    this.notices.push(notice);
  }

  edit(kind: RecordPut['kind'], id: string, value: unknown) {
    this.records.set(recordKey(kind, id), rec(kind, id, value));
    this.client.notifyLocalChange();
  }
  remove(kind: RecordPut['kind'], id: string) {
    this.records.delete(recordKey(kind, id));
    this.client.notifyLocalChange();
  }
  json(kind: RecordPut['kind'], id: string) {
    return this.records.get(recordKey(kind, id))?.json;
  }
  ids(kind: RecordPut['kind']) {
    return [...this.records.values()].filter((r) => r.kind === kind).map((r) => r.id).sort();
  }
  get sockets() {
    return this.factory.opened;
  }
}

const devices: Device[] = [];
function device(ws: Workspace, email: string, opts?: ConstructorParameters<typeof Device>[2]): Device {
  const d = new Device(ws, email, opts);
  devices.push(d);
  return d;
}
afterEach(() => {
  for (const d of devices.splice(0)) d.client.stop();
});

async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const settled = (d: Device) => () => d.state?.status === 'synced' && d.state.pending === 0;
const sameData = (a: Device, b: Device) => () =>
  a.records.size === b.records.size && [...a.records].every(([k, v]) => b.records.get(k)?.json === v.json);

describe('two devices on the real Durable Object', () => {
  it('converge: edits to DIFFERENT records on both sides merge with no conflict', async () => {
    const ws = newWorkspace();
    const alice = device(ws, 'alice@example.com');
    const bob = device(ws, 'bob@example.com');
    alice.client.start();
    bob.client.start();
    await until(() => alice.state?.status === 'synced' && bob.state?.status === 'synced', 'both connected');

    alice.edit('project', 'p-alice', { by: 'alice' });
    bob.edit('project', 'p-bob', { by: 'bob' });
    await until(() => alice.ids('project').length === 2 && bob.ids('project').length === 2, 'both see both projects');
    await until(() => settled(alice)() && settled(bob)(), 'quiescent');

    expect(sameData(alice, bob)()).toBe(true);
    expect(alice.notices).toEqual([]);
    expect(bob.notices).toEqual([]);
    expect((await ws.exportAll()).records.map((r) => r.id).sort()).toEqual(['p-alice', 'p-bob']);
  });

  it('a late-joining device receives the existing workspace', async () => {
    const ws = newWorkspace();
    const alice = device(ws, 'alice@example.com');
    alice.client.start();
    await until(() => alice.state?.status === 'synced', 'alice connected');
    alice.edit('project', 'p1', 1);
    alice.edit('report', 'r1', 1);
    await until(settled(alice), 'alice saved');
    const carol = device(ws, 'carol@example.com');
    carol.client.start();
    await until(() => carol.ids('project').length === 1 && carol.ids('report').length === 1, 'carol caught up');
  });

  it('SAME record edited on both: exactly one version wins everywhere; the loser is told and keeps a copy', async () => {
    const ws = newWorkspace();
    const alice = device(ws, 'alice@example.com');
    const bob = device(ws, 'bob@example.com');
    alice.client.start();
    bob.client.start();
    await until(() => alice.state?.status === 'synced' && bob.state?.status === 'synced', 'connected');
    alice.edit('project', 'shared', 'v0');
    await until(() => bob.json('project', 'shared') === '"v0"', 'bob has v0');
    await until(() => settled(alice)() && settled(bob)(), 'quiet');

    // Both edit the same record before either sees the other's change.
    alice.edit('project', 'shared', 'alice-edit');
    bob.edit('project', 'shared', 'bob-edit');
    await until(() => alice.json('project', 'shared') === bob.json('project', 'shared') && settled(alice)() && settled(bob)(), 'converged');

    const winner = alice.json('project', 'shared');
    expect(['"alice-edit"', '"bob-edit"']).toContain(winner);
    const loser = winner === '"alice-edit"' ? bob : alice;
    expect(loser.notices.some((n) => n.kind === 'conflict')).toBe(true);
    expect(loser.stash.some((s) => s.id === 'shared')).toBe(true);
    expect((await ws.exportAll()).records.find((r) => r.id === 'shared')?.json).toBe(winner);
  });

  it('a delete on one device removes the record on the other', async () => {
    const ws = newWorkspace();
    const alice = device(ws, 'alice@example.com');
    const bob = device(ws, 'bob@example.com');
    alice.client.start();
    bob.client.start();
    await until(() => alice.state?.status === 'synced' && bob.state?.status === 'synced', 'connected');
    alice.edit('topic', 't1', 1);
    await until(() => bob.json('topic', 't1') !== undefined, 'bob has it');
    await until(settled(alice), 'saved');
    alice.remove('topic', 't1');
    await until(() => bob.json('topic', 't1') === undefined, 'bob lost it');
  });
});

describe('reconnecting', () => {
  it('a device that drops catches up on what it missed and delivers its own offline edits', async () => {
    const ws = newWorkspace();
    const alice = device(ws, 'alice@example.com');
    const bob = device(ws, 'bob@example.com');
    alice.client.start();
    bob.client.start();
    await until(() => alice.state?.status === 'synced' && bob.state?.status === 'synced', 'connected');
    alice.edit('project', 'base', 1);
    await until(() => bob.json('project', 'base') === '1', 'bob has base');
    await until(() => settled(alice)() && settled(bob)(), 'quiet');

    bob.sockets[bob.sockets.length - 1].drop(); // network drop
    await until(() => bob.state?.status === 'offline', 'bob offline');
    bob.edit('report', 'bob-offline', 'written while offline'); // kept locally
    alice.edit('project', 'while-bob-away', 2); // bob misses this
    await until(() => settled(alice)(), 'alice saved');

    await until(() => bob.json('project', 'while-bob-away') === '2' && settled(bob)(), 'bob caught up and synced', 8000);
    await until(() => alice.json('report', 'bob-offline') !== undefined, "alice received bob's offline edit");
    expect(sameData(alice, bob)()).toBe(true);
    expect(bob.notices).toEqual([]); // different records: no conflict
  });

  it('keeps working through an eviction (hibernation): commits and broadcasts continue without a reconnect', async () => {
    const ws = newWorkspace();
    const alice = device(ws, 'alice@example.com');
    const bob = device(ws, 'bob@example.com');
    alice.client.start();
    bob.client.start();
    await until(() => alice.state?.status === 'synced' && bob.state?.status === 'synced', 'connected');
    alice.edit('project', 'a', 1);
    await until(() => bob.json('project', 'a') === '1' && settled(alice)(), 'first edit synced');

    await evictDurableObject(ws.stub);

    alice.edit('project', 'a', 2);
    await until(() => bob.json('project', 'a') === '2' && settled(alice)(), 'edit after eviction synced');
    expect(alice.sockets).toHaveLength(1); // no reconnect was needed
    expect(bob.sockets).toHaveLength(1);
  });

  it('survives the server closing every socket (eviction with close): both devices reconnect and converge', async () => {
    const ws = newWorkspace();
    const alice = device(ws, 'alice@example.com');
    const bob = device(ws, 'bob@example.com');
    alice.client.start();
    bob.client.start();
    await until(() => alice.state?.status === 'synced' && bob.state?.status === 'synced', 'connected');
    alice.edit('project', 'a', 1);
    await until(() => bob.json('project', 'a') === '1' && settled(alice)(), 'synced');

    await evictDurableObject(ws.stub, { webSockets: 'close' });
    alice.edit('project', 'a', 'after-close');
    await until(() => bob.json('project', 'a') === '"after-close"' && settled(alice)() && settled(bob)(), 'converged after reconnect', 9000);
    expect(alice.sockets.length).toBeGreaterThan(1);
  });
});

describe('linking a device to a workspace that already has data', () => {
  const server = [rec('project', 'srv-1', 'S1'), rec('project', 'shared', 'server-version'), rec('report', 'srv-r', 'SR')];
  const local = [rec('project', 'loc-1', 'L1'), rec('project', 'shared', 'local-version')];

  async function seededServer(): Promise<Workspace> {
    const ws = newWorkspace();
    const seeder = device(ws, 'seed@example.com', { local: server });
    seeder.client.start();
    await until(() => settled(seeder)() && seeder.state?.revision === 1, 'server seeded');
    seeder.client.stop();
    return ws;
  }

  it('MERGE (apply): server records are adopted, local-only records are added, nothing on the server is overwritten', async () => {
    const ws = await seededServer();
    const dev = device(ws, 'alice@example.com', { local });
    dev.client.start();
    await until(() => settled(dev)() && dev.ids('project').length === 3, 'merged');
    const onServer = (await ws.exportAll()).records;
    expect(onServer.map((r) => r.id).sort()).toEqual(['loc-1', 'shared', 'srv-1', 'srv-r']);
    expect(onServer.find((r) => r.id === 'shared')?.json).toBe('"server-version"'); // the shared version won
    expect(dev.json('project', 'shared')).toBe('"server-version"');
    expect(dev.stash.some((s) => s.id === 'shared' && s.json === '"local-version"')).toBe(true); // local copy kept
  });

  it('REPLACE (overwrite): the server becomes exactly the local data, and the old state stays in history', async () => {
    const ws = await seededServer();
    const dev = device(ws, 'admin@example.com', { local, firstState: 'overwrite' });
    dev.client.start();
    await until(() => settled(dev)() && (dev.state?.revision ?? 0) >= 2, 'replaced');
    const onServer = (await ws.exportAll()).records;
    expect(onServer.map((r) => r.id).sort()).toEqual(['loc-1', 'shared']);
    expect(onServer.find((r) => r.id === 'shared')?.json).toBe('"local-version"');
    expect(dev.notices).toEqual([]);
    // Recoverable: the pre-replace workspace is still a revision.
    const before = await ws.previewRevision(1);
    expect(before?.map((r) => r.id).sort()).toEqual(['shared', 'srv-1', 'srv-r']);
  });

  it('ADOPT (empty local): a fresh device simply receives the shared workspace and sends nothing', async () => {
    const ws = await seededServer();
    const dev = device(ws, 'new@example.com');
    dev.client.start();
    await until(() => dev.ids('project').length === 2 && settled(dev)(), 'adopted');
    expect((await ws.exportAll()).revision).toBe(1); // no new revision: nothing was pushed
  });
});

describe('permissions end to end', () => {
  it('a read-only device receives live changes but its edits are never sent', async () => {
    const ws = newWorkspace();
    const alice = device(ws, 'alice@example.com');
    const viewer = device(ws, 'viewer@example.com', { role: 'viewer' });
    alice.client.start();
    viewer.client.start();
    await until(() => alice.state?.status === 'synced' && viewer.state?.status === 'readonly', 'connected');
    alice.edit('project', 'p', 1);
    await until(() => viewer.json('project', 'p') === '1', 'viewer sees alice');
    viewer.edit('project', 'p', 'viewer-tamper');
    await new Promise((r) => setTimeout(r, 150));
    expect((await ws.exportAll()).records.find((r) => r.id === 'p')?.json).toBe('1');
  });
});

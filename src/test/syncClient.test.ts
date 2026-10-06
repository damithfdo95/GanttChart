import { beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, LIMITS, type CommitMessage } from '../../shared/protocol';
import { SyncClient, type PersistedMirror, type SessionProbe, type StashedEdit, type SyncLogEvent } from '../lib/sync/client';
import { recordKey } from '../lib/sync/records';
import { FakeHost, FakeSocket, ManualTimers, rec } from './helpers/syncHarness';

const YOU = { email: 'alice@example.com', role: 'editor' as const };

interface Rig {
  host: FakeHost;
  timers: ManualTimers;
  sockets: FakeSocket[];
  stash: StashedEdit[];
  mirrors: PersistedMirror[];
  logs: SyncLogEvent[];
  client: SyncClient;
  socket(): FakeSocket;
}

function rig(opts: { initial?: PersistedMirror | null; firstState?: 'apply' | 'overwrite'; probe?: () => Promise<SessionProbe>; role?: 'editor' | 'viewer' } = {}): Rig {
  const host = new FakeHost();
  const timers = new ManualTimers();
  const sockets: FakeSocket[] = [];
  const stash: StashedEdit[] = [];
  const mirrors: PersistedMirror[] = [];
  const logs: SyncLogEvent[] = [];
  let ids = 0;
  const client = new SyncClient({
    url: 'wss://app.example/ws',
    host,
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    clientId: 'client-1',
    initial: opts.initial ?? null,
    firstState: opts.firstState,
    persistMirror: (m) => mirrors.push(m),
    stashEdit: (e) => stash.push(e),
    probeSession: opts.probe,
    log: (e) => logs.push(e),
    timers,
    random: () => 1, // no jitter: delay = base
    now: () => 1_000_000 + timers.time,
    newId: () => `commit-${++ids}`,
  });
  return { host, timers, sockets, stash, mirrors, logs, client, socket: () => sockets[sockets.length - 1] };
}

/** Connect, handshake and deliver the first state. */
function connect(r: Rig, records = [] as ReturnType<typeof rec>[], revision = 0, role: 'editor' | 'viewer' = 'editor'): FakeSocket {
  r.client.start();
  const s = r.socket();
  s.serverOpen();
  s.serverSend({ t: 'ready', v: PROTOCOL_VERSION, revision, you: { ...YOU, role } });
  s.serverSend({ t: 'snapshot', revision, records });
  return s;
}

const lastOf = <T,>(items: T[]): T => items[items.length - 1];
const lastCommit = (s: FakeSocket): CommitMessage => lastOf(s.messages('commit'));
const debounce = (r: Rig) => r.timers.advance(1500);

describe('connecting', () => {
  it('says hello (no revision yet), shows connecting, then applies the first state', () => {
    const r = rig();
    r.client.start();
    expect(r.host.status).toBe('connecting');
    const s = r.socket();
    expect(s.url).toBe('wss://app.example/ws');
    s.serverOpen();
    expect(s.sent[0]).toEqual({ t: 'hello', v: PROTOCOL_VERSION, clientId: 'client-1', lastRevision: null });
    s.serverSend({ t: 'ready', v: PROTOCOL_VERSION, revision: 3, you: YOU });
    s.serverSend({ t: 'snapshot', revision: 3, records: [rec('project', 'p1', { n: 1 })] });
    expect(r.host.json('project', 'p1')).toBe('{"n":1}');
    expect(r.host.status).toBe('synced');
    expect(r.host.last).toMatchObject({ revision: 3, you: YOU, pending: 0, reconnectAttempt: 0 });
  });

  it('a persisted mirror makes the hello resume from its revision', () => {
    const r = rig({ initial: { revision: 7, records: { [recordKey('project', 'p1')]: '{"n":1}' } } });
    r.client.start();
    r.socket().serverOpen();
    expect(r.socket().sent[0]).toMatchObject({ t: 'hello', lastRevision: 7 });
  });
});

describe('sending local edits', () => {
  let r: Rig;
  let s: FakeSocket;
  beforeEach(() => {
    r = rig();
    s = connect(r, [rec('project', 'a', 1), rec('project', 'b', 1)], 5);
  });

  it('coalesces edits made within the debounce window into ONE commit of only what changed', () => {
    r.host.edit('project', 'a', 2);
    r.client.notifyLocalChange();
    r.timers.advance(1000);
    r.host.edit('project', 'a', 3);
    r.client.notifyLocalChange(); // restarts the window
    r.timers.advance(1000);
    expect(s.messages('commit')).toHaveLength(0);
    r.timers.advance(500);
    expect(s.messages('commit')).toHaveLength(1);
    expect(lastCommit(s)).toMatchObject({ id: 'commit-1', baseRevision: 5, puts: [rec('project', 'a', 3)], deletes: [] });
    expect(r.host.status).toBe('syncing');
  });

  it('sends deletions for records removed locally', () => {
    r.host.remove('project', 'b');
    r.client.notifyLocalChange();
    debounce(r);
    expect(lastCommit(s)).toMatchObject({ puts: [], deletes: [{ kind: 'project', id: 'b' }] });
  });

  it('after the ack the mirror and revision advance and the status returns to synced', () => {
    r.host.edit('project', 'a', 2);
    r.client.notifyLocalChange();
    debounce(r);
    s.serverSend({ t: 'ack', id: 'commit-1', revision: 6, changed: true });
    expect(r.host.status).toBe('synced');
    expect(r.host.last).toMatchObject({ revision: 6, pending: 0 });
    expect(r.client.getMirror().get(recordKey('project', 'a'))).toBe('2');
    r.timers.advance(1000);
    expect(lastOf(r.mirrors)).toMatchObject({ revision: 6 }); // persisted for offline start
  });

  it('keeps exactly one commit in flight; edits made meanwhile go out after the ack on the new base', () => {
    r.host.edit('project', 'a', 2);
    r.client.notifyLocalChange();
    debounce(r);
    r.host.edit('project', 'b', 9);
    r.client.notifyLocalChange();
    debounce(r);
    expect(s.messages('commit')).toHaveLength(1); // still waiting for the first ack
    s.serverSend({ t: 'ack', id: 'commit-1', revision: 6, changed: true });
    expect(s.messages('commit')).toHaveLength(2);
    expect(lastCommit(s)).toMatchObject({ id: 'commit-2', baseRevision: 6, puts: [rec('project', 'b', 9)] });
  });

  it('does nothing when the local state already equals the server', () => {
    r.client.notifyLocalChange();
    debounce(r);
    expect(s.messages('commit')).toHaveLength(0);
    expect(r.host.status).toBe('synced');
  });

  it('splits an oversized change set across commits, each within the server limit', () => {
    for (let i = 0; i < LIMITS.maxCommitRecords + 20; i++) r.host.edit('report', `r${i}`, i);
    r.client.notifyLocalChange();
    debounce(r);
    const first = lastCommit(s);
    expect(first.puts.length + first.deletes.length).toBe(LIMITS.maxCommitRecords);
    s.serverSend({ t: 'ack', id: first.id, revision: 6, changed: true });
    const second = lastCommit(s);
    expect(second.id).not.toBe(first.id);
    expect(second.puts.length).toBe(20);
  });
});

describe('remote changes', () => {
  it('applies changes to records the user has not touched, without a notice', () => {
    const r = rig();
    const s = connect(r, [rec('project', 'a', 1)], 1);
    s.serverSend({ t: 'changes', revision: 2, actor: 'bob@example.com', at: 'x', puts: [rec('project', 'a', 2), rec('report', 'r', 1)], deletes: [] });
    expect(r.host.json('project', 'a')).toBe('2');
    expect(r.host.json('report', 'r')).toBe('1');
    expect(r.host.notices).toEqual([]);
    expect(r.host.last.revision).toBe(2);
  });

  it('keeps unsent local edits to OTHER records and sends them afterwards', () => {
    const r = rig();
    const s = connect(r, [rec('project', 'a', 1), rec('project', 'b', 1)], 1);
    r.host.edit('project', 'b', 'mine');
    r.client.notifyLocalChange();
    s.serverSend({ t: 'changes', revision: 2, actor: 'bob@example.com', at: 'x', puts: [rec('project', 'a', 2)], deletes: [] });
    expect(r.host.json('project', 'b')).toBe('"mine"');
    debounce(r);
    expect(lastCommit(s)).toMatchObject({ baseRevision: 2, puts: [rec('project', 'b', 'mine')] });
  });

  it('shared version wins when the SAME record was edited locally: notice + the lost edit is stashed', () => {
    const r = rig();
    const s = connect(r, [rec('project', 'a', 1)], 1);
    r.host.edit('project', 'a', 'mine');
    s.serverSend({ t: 'changes', revision: 2, actor: 'bob@example.com', at: 'x', puts: [rec('project', 'a', 'bobs')], deletes: [] });
    expect(r.host.json('project', 'a')).toBe('"bobs"');
    expect(r.host.notices).toEqual([{ kind: 'conflict', keys: [{ kind: 'project', id: 'a' }] }]);
    expect(r.stash).toMatchObject([{ kind: 'project', id: 'a', json: '"mine"' }]);
    debounce(r);
    expect(s.messages('commit')).toHaveLength(0); // nothing of mine is pending any more
  });

  it('is not a conflict when both sides made the identical edit', () => {
    const r = rig();
    const s = connect(r, [rec('project', 'a', 1)], 1);
    r.host.edit('project', 'a', 'same');
    s.serverSend({ t: 'changes', revision: 2, actor: 'bob@example.com', at: 'x', puts: [rec('project', 'a', 'same')], deletes: [] });
    expect(r.host.notices).toEqual([]);
    expect(r.stash).toEqual([]);
  });

  it('a remote delete of a record being edited locally is a conflict (the delete wins)', () => {
    const r = rig();
    const s = connect(r, [rec('report', 'r', 1)], 1);
    r.host.edit('report', 'r', 'edited');
    s.serverSend({ t: 'changes', revision: 2, actor: 'bob@example.com', at: 'x', puts: [], deletes: [{ kind: 'report', id: 'r' }] });
    expect(r.host.json('report', 'r')).toBeUndefined();
    expect(r.host.notices[0]).toMatchObject({ kind: 'conflict' });
  });
});

describe('server rejections', () => {
  it('conflict: loads the shared versions, tells the user, and re-sends the rest on the new base', () => {
    const r = rig();
    const s = connect(r, [rec('project', 'a', 1), rec('project', 'b', 1)], 1);
    r.host.edit('project', 'a', 'mine');
    r.host.edit('project', 'b', 'mine-too');
    r.client.notifyLocalChange();
    debounce(r);
    const c = lastCommit(s);
    s.serverSend({ t: 'reject', id: c.id, reason: 'conflict', revision: 4, conflicts: [{ kind: 'project', id: 'a', json: '"theirs"' }] });
    expect(r.host.json('project', 'a')).toBe('"theirs"');
    expect(r.host.json('project', 'b')).toBe('"mine-too"'); // not conflicting: kept
    expect(r.host.notices).toEqual([{ kind: 'conflict', keys: [{ kind: 'project', id: 'a' }] }]);
    expect(r.stash).toMatchObject([{ kind: 'project', id: 'a', json: '"mine"' }]);
    const retry = lastCommit(s);
    expect(retry.id).not.toBe(c.id);
    expect(retry).toMatchObject({ baseRevision: 4, puts: [rec('project', 'b', 'mine-too')] });
  });

  it('conflict on a record the server deleted removes it locally', () => {
    const r = rig();
    const s = connect(r, [rec('report', 'x', 1)], 1);
    r.host.edit('report', 'x', 'edited');
    r.client.notifyLocalChange();
    debounce(r);
    s.serverSend({ t: 'reject', id: lastCommit(s).id, reason: 'conflict', revision: 3, conflicts: [{ kind: 'report', id: 'x', json: null }] });
    expect(r.host.json('report', 'x')).toBeUndefined();
  });

  it('stale base: asks for a full re-sync instead of retrying blindly', () => {
    const r = rig();
    const s = connect(r, [rec('project', 'a', 1)], 1);
    r.host.edit('project', 'a', 2);
    r.client.notifyLocalChange();
    debounce(r);
    s.serverSend({ t: 'reject', id: lastCommit(s).id, reason: 'stale', revision: 9, conflicts: [] });
    expect(lastOf(s.messages('hello'))).toMatchObject({ lastRevision: null });
    s.serverSend({ t: 'snapshot', revision: 9, records: [rec('project', 'a', 1)] });
    expect(lastCommit(s)).toMatchObject({ baseRevision: 9, puts: [rec('project', 'a', 2)] }); // my edit survives the re-sync
  });

  it('forbidden: the device becomes read-only, says so, and stops sending', () => {
    const r = rig();
    const s = connect(r, [rec('project', 'a', 1)], 1);
    r.host.edit('project', 'a', 2);
    r.client.notifyLocalChange();
    debounce(r);
    s.serverSend({ t: 'reject', id: lastCommit(s).id, reason: 'forbidden', revision: 1, conflicts: [] });
    expect(r.host.notices).toEqual([{ kind: 'readonly' }]);
    expect(r.host.status).toBe('readonly');
    r.host.edit('project', 'a', 3);
    r.client.notifyLocalChange();
    debounce(r);
    expect(s.messages('commit')).toHaveLength(1);
  });

  it('a viewer identity is read-only from the start and never sends', () => {
    const r = rig();
    const s = connect(r, [rec('project', 'a', 1)], 1, 'viewer');
    r.host.edit('project', 'a', 2);
    r.client.notifyLocalChange();
    debounce(r);
    expect(s.messages('commit')).toHaveLength(0);
    expect(r.host.status).toBe('readonly');
  });

  it('invalid: reports an error and backs off 10 s before retrying', () => {
    const r = rig();
    const s = connect(r, [rec('project', 'a', 1)], 1);
    r.host.edit('project', 'a', 2);
    r.client.notifyLocalChange();
    debounce(r);
    s.serverSend({ t: 'reject', id: lastCommit(s).id, reason: 'invalid', revision: 1, conflicts: [], message: 'nope' });
    expect(r.host.status).toBe('error');
    expect(lastOf(r.host.notices)).toEqual({ kind: 'error', message: 'nope' });
    r.timers.advance(9_000);
    expect(s.messages('commit')).toHaveLength(1);
    r.timers.advance(1_500);
    expect(s.messages('commit')).toHaveLength(2);
  });
});

describe('connection loss and reconnect', () => {
  it('goes offline, keeps editing locally, backs off exponentially, and resumes from its revision', () => {
    const r = rig();
    const s1 = connect(r, [rec('project', 'a', 1)], 4);
    s1.serverDrop();
    expect(r.host.status).toBe('offline');
    r.host.edit('project', 'a', 'offline-edit');
    r.client.notifyLocalChange();

    r.timers.advance(999);
    expect(r.sockets).toHaveLength(1);
    r.timers.advance(1);
    expect(r.sockets).toHaveLength(2); // 1st retry after 1 s
    expect(s1.messages('commit')).toHaveLength(0); // nothing is sent while offline
    r.socket().serverDrop(); // fails again
    r.timers.advance(2000);
    expect(r.sockets).toHaveLength(3); // 2nd retry after 2 s
    expect(r.host.last.reconnectAttempt).toBe(2);

    const s3 = r.socket();
    s3.serverOpen();
    expect(s3.sent[0]).toMatchObject({ t: 'hello', lastRevision: 4 });
    s3.serverSend({ t: 'ready', v: PROTOCOL_VERSION, revision: 6, you: YOU });
    s3.serverSend({ t: 'changes', revision: 6, actor: 'server', at: 'x', puts: [rec('report', 'r', 1)], deletes: [], catchUp: true });
    expect(r.host.json('report', 'r')).toBe('1'); // caught up
    expect(r.host.json('project', 'a')).toBe('"offline-edit"'); // offline edit kept
    expect(lastCommit(s3)).toMatchObject({ baseRevision: 6, puts: [rec('project', 'a', 'offline-edit')] });
    expect(r.host.last.reconnectAttempt).toBe(0);
  });

  it('caps the backoff at 30 s', () => {
    const r = rig();
    r.client.start();
    for (let i = 0; i < 10; i++) {
      r.socket().serverDrop();
      r.timers.advance(30_000);
    }
    expect(r.host.last.reconnectAttempt).toBeGreaterThanOrEqual(9);
    const before = r.sockets.length;
    r.socket().serverDrop();
    r.timers.advance(29_999);
    expect(r.sockets.length).toBe(before);
    r.timers.advance(1);
    expect(r.sockets.length).toBe(before + 1);
  });

  it('lost ack: the in-flight commit is re-sent with the SAME id after reconnecting', () => {
    const r = rig();
    const s1 = connect(r, [rec('project', 'a', 1)], 1);
    r.host.edit('project', 'a', 2);
    r.client.notifyLocalChange();
    debounce(r);
    const first = lastCommit(s1);
    s1.serverDrop(); // ack never arrives
    r.timers.advance(1000);
    const s2 = r.socket();
    s2.serverOpen();
    s2.serverSend({ t: 'ready', v: PROTOCOL_VERSION, revision: 2, you: YOU });
    // The server DID apply it: catch-up carries my own change back.
    s2.serverSend({ t: 'changes', revision: 2, actor: 'alice@example.com', at: 'x', puts: [rec('project', 'a', 2)], deletes: [], catchUp: true });
    expect(r.host.notices).toEqual([]); // my own edit is not a conflict with itself
    const resent = lastCommit(s2);
    expect(resent.id).toBe(first.id);
    expect(resent).toEqual(first);
    s2.serverSend({ t: 'ack', id: first.id, revision: 2, changed: true });
    expect(r.host.status).toBe('synced');
  });

  it('a commit that is never answered closes the connection and retries', () => {
    const r = rig();
    const s1 = connect(r, [rec('project', 'a', 1)], 1);
    r.host.edit('project', 'a', 2);
    r.client.notifyLocalChange();
    debounce(r);
    r.timers.advance(20_000);
    expect(s1.closedWith).toMatchObject({ code: 4001 });
  });

  it('a silent (half-open) connection is detected by the heartbeat and closed', () => {
    const r = rig();
    const s = connect(r, [], 1);
    r.timers.advance(25_000);
    expect(s.messages('ping')).toHaveLength(1);
    r.timers.advance(10_000);
    expect(s.closedWith).toMatchObject({ code: 4000 });
  });

  it('any server message counts as proof of life for the heartbeat', () => {
    const r = rig();
    const s = connect(r, [], 1);
    r.timers.advance(25_000);
    s.serverSend({ t: 'pong' });
    r.timers.advance(10_000);
    expect(s.closedWith).toBeNull();
  });

  it('networkOnline() reconnects immediately instead of waiting out the backoff', () => {
    const r = rig();
    r.client.start();
    r.socket().serverDrop();
    r.timers.advance(1000);
    r.socket().serverDrop();
    expect(r.sockets).toHaveLength(2);
    r.client.networkOnline();
    expect(r.sockets).toHaveLength(3);
  });
});

describe('connection ended on purpose by the server', () => {
  const cases: Array<[number, string]> = [
    [4403, 'access-revoked'],
    [4410, 'storage-moved'],
    [4411, 'tenant-deleted'],
  ];
  for (const [code, status] of cases) {
    it(`close code ${code} reports ${status}, never reconnects and never sends again`, () => {
      const r = rig();
      const s = connect(r, [], 1);
      const sent = s.sent.length;
      s.serverDrop(code);
      expect(r.host.status).toBe(status);
      r.timers.advance(300_000);
      r.client.networkOnline();
      r.client.notifyLocalChange();
      r.timers.advance(300_000);
      expect(r.sockets).toHaveLength(1);
      expect(s.sent.length).toBe(sent);
      expect(r.client.getState().status).toBe(status);
    });
  }

  it('an ordinary drop still reconnects', () => {
    const r = rig();
    const s = connect(r, [], 1);
    s.serverDrop(1006);
    r.timers.advance(60_000);
    expect(r.sockets.length).toBeGreaterThan(1);
  });
});

describe('expired Access session', () => {
  it('close code 4401 stops reconnecting and reports session-expired', () => {
    const r = rig();
    const s = connect(r, [], 1);
    s.serverDrop(4401);
    expect(r.host.status).toBe('session-expired');
    r.timers.advance(120_000);
    expect(r.sockets).toHaveLength(1);
  });

  it('a session_expired error message does the same', () => {
    const r = rig();
    const s = connect(r, [], 1);
    s.serverSend({ t: 'error', code: 'session_expired', message: 'x' });
    expect(r.host.status).toBe('session-expired');
  });

  it('repeated connection failures probe the session; an expired verdict stops the retries', async () => {
    const r = rig({ probe: async () => 'expired' });
    r.client.start();
    for (let i = 0; i < 3; i++) {
      r.socket().serverDrop();
      r.timers.advance(30_000);
      await Promise.resolve();
    }
    await Promise.resolve();
    expect(r.host.status).toBe('session-expired');
  });

  it('an unreachable verdict keeps retrying (it is just offline)', async () => {
    const r = rig({ probe: async () => 'unreachable' });
    r.client.start();
    for (let i = 0; i < 4; i++) {
      r.socket().serverDrop();
      r.timers.advance(30_000);
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(r.host.status).not.toBe('session-expired');
    expect(r.sockets.length).toBeGreaterThanOrEqual(4);
  });
});

describe('first state modes (linking a device)', () => {
  it('apply (default): the shared records land in the local state alongside local-only ones (merge)', () => {
    const r = rig();
    r.host.edit('project', 'local-only', 1);
    const s = connect(r, [rec('project', 'shared', 1)], 3);
    expect(r.host.json('project', 'shared')).toBe('1');
    debounce(r);
    expect(lastCommit(s)).toMatchObject({ baseRevision: 3, puts: [rec('project', 'local-only', 1)], deletes: [] }); // added, nothing overwritten
  });

  it('overwrite: the server state becomes the baseline WITHOUT touching local data; the commit then replaces it', () => {
    const r = rig({ firstState: 'overwrite' });
    r.host.edit('project', 'mine', 1);
    r.host.edit('project', 'same', 'v-local');
    const s = connect(r, [rec('project', 'server-only', 1), rec('project', 'same', 'v-server')], 8);
    expect(r.host.applied).toEqual([]); // nothing from the server was applied
    expect(r.host.json('project', 'server-only')).toBeUndefined();
    debounce(r);
    const c = lastCommit(s);
    expect(c.baseRevision).toBe(8);
    expect(c.puts.map((p) => p.id).sort()).toEqual(['mine', 'same']);
    expect(c.deletes).toEqual([{ kind: 'project', id: 'server-only' }]);
  });

  it('overwrite applies only to the FIRST state; later server changes are applied normally', () => {
    const r = rig({ firstState: 'overwrite' });
    const s = connect(r, [], 1);
    s.serverSend({ t: 'changes', revision: 2, actor: 'bob@example.com', at: 'x', puts: [rec('report', 'r', 1)], deletes: [] });
    expect(r.host.json('report', 'r')).toBe('1');
  });

  it('offline start from a persisted mirror: edits made while closed are detected as pending', () => {
    const r = rig({ initial: { revision: 7, records: { [recordKey('project', 'a')]: '1' } } });
    r.host.edit('project', 'a', 'changed-while-closed');
    r.client.start();
    const s = r.socket();
    s.serverOpen();
    s.serverSend({ t: 'ready', v: PROTOCOL_VERSION, revision: 7, you: YOU });
    s.serverSend({ t: 'changes', revision: 7, actor: 'server', at: 'x', puts: [], deletes: [], catchUp: true });
    expect(lastCommit(s)).toMatchObject({ baseRevision: 7, puts: [rec('project', 'a', 'changed-while-closed')] });
  });
});

describe('stop()', () => {
  it('closes the socket, cancels timers and ignores later activity', () => {
    const r = rig();
    const s = connect(r, [], 1);
    r.host.edit('project', 'a', 1);
    r.client.notifyLocalChange();
    r.client.stop();
    expect(s.closedWith).toMatchObject({ code: 1000 });
    expect(r.host.status).toBe('stopped');
    r.timers.advance(120_000);
    expect(s.messages('commit')).toHaveLength(0);
    expect(r.sockets).toHaveLength(1);
  });
});

describe('stale-revert guard (never push an old copy over a newer one)', () => {
  const V2 = { n: 'v2', updatedAt: '2026-10-06T13:31:55.269Z' };
  const V3 = { n: 'v3', updatedAt: '2026-10-06T13:32:49.000Z' };

  function connected() {
    const r = rig();
    const s = connect(r, [rec('project', 'p', V2)], 2);
    s.serverSend({ t: 'changes', revision: 3, actor: 'bob@example.com', at: 'x', puts: [rec('project', 'p', V3)], deletes: [] });
    return { r, s };
  }

  it('blocks an exact copy of a superseded version, repairs the local copy, and sends nothing', () => {
    const { r, s } = connected();
    expect(r.host.json('project', 'p')).toBe(JSON.stringify(V3));
    // Something (a stale cache, a stale closure…) puts the OLD record back into local state.
    r.host.edit('project', 'p', V2);
    r.client.notifyLocalChange();
    debounce(r);
    expect(s.messages('commit')).toHaveLength(0);
    expect(r.host.json('project', 'p')).toBe(JSON.stringify(V3)); // repaired to the current shared version
    expect(r.logs.some((l) => l.event === 'stale-revert-blocked')).toBe(true);
    expect(r.host.notices).toEqual([]); // silent: nothing the user did was lost
  });

  it('still sends a genuine edit (a new version with a fresh timestamp)', () => {
    const { r, s } = connected();
    r.host.edit('project', 'p', { n: 'mine', updatedAt: '2026-10-06T13:40:00.000Z' });
    r.client.notifyLocalChange();
    debounce(r);
    expect(lastCommit(s).puts[0].json).toContain('mine');
  });

  it('still sends an edit whose timestamp is OLDER only because this device’s clock is behind', () => {
    const { r, s } = connected();
    r.host.edit('project', 'p', { n: 'skewed-clock edit', updatedAt: '2026-10-06T13:00:00.000Z' }); // < V3, but not an old copy
    r.client.notifyLocalChange();
    debounce(r);
    expect(lastCommit(s).puts[0].json).toContain('skewed-clock edit');
    expect(r.logs.some((l) => l.event === 'stale-revert-blocked')).toBe(false);
  });

  it('does NOT apply to records without timestamps: changing a setting back to an earlier value is a real edit', () => {
    const r = rig();
    const s = connect(r, [rec('settings', 'settings', { supervisorName: 'X' })], 1);
    s.serverSend({ t: 'changes', revision: 2, actor: 'bob@example.com', at: 'x', puts: [rec('settings', 'settings', { supervisorName: 'Y' })], deletes: [] });
    r.host.edit('settings', 'settings', { supervisorName: 'X' }); // back to the earlier value
    r.client.notifyLocalChange();
    debounce(r);
    expect(lastCommit(s).puts).toEqual([rec('settings', 'settings', { supervisorName: 'X' })]);
  });

  it('does NOT apply to members either (same reasoning)', () => {
    const r = rig();
    const s = connect(r, [rec('member', 'm', { name: 'Old' })], 1);
    s.serverSend({ t: 'changes', revision: 2, actor: 'bob@example.com', at: 'x', puts: [rec('member', 'm', { name: 'New' })], deletes: [] });
    r.host.edit('member', 'm', { name: 'Old' });
    r.client.notifyLocalChange();
    debounce(r);
    expect(lastCommit(s).puts).toEqual([rec('member', 'm', { name: 'Old' })]);
  });

  it('after a successful ack the replaced version is also remembered (own edits count as superseded too)', () => {
    const r = rig();
    const s = connect(r, [rec('project', 'p', V2)], 2);
    const mine = { n: 'mine', updatedAt: '2026-10-06T13:50:00.000Z' };
    r.host.edit('project', 'p', mine);
    r.client.notifyLocalChange();
    debounce(r);
    s.serverSend({ t: 'ack', id: lastCommit(s).id, revision: 3, changed: true });
    r.host.edit('project', 'p', V2); // reverting to the pre-edit copy WITHOUT a new timestamp
    r.client.notifyLocalChange();
    debounce(r);
    expect(s.messages('commit')).toHaveLength(1); // only my real edit was ever sent
    expect(r.host.json('project', 'p')).toBe(JSON.stringify(mine));
  });

  it('records a breadcrumb trail for diagnosis', () => {
    const { r } = connected();
    const events = r.logs.map((l) => l.event);
    expect(events).toContain('connect');
    expect(events).toContain('state');
    expect(events).toContain('changes');
  });
});

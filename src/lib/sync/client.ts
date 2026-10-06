/**
 * SyncClient — keeps this browser's copy of the shared workspace in step with
 * the server over one WebSocket.
 *
 * Model
 *   mirror     what the server is known to hold (key → JSON) at `revision`
 *   desired    what the local app state says (via host.readRecords())
 *   pending    desired ≠ mirror → local edits not yet on the server
 *
 * One commit is in flight at a time. Edits are coalesced (debounce) and sent
 * as the difference between desired and mirror, based on the revision the
 * mirror reflects. The server accepts it unless one of the touched records
 * changed in between (per-record optimistic concurrency).
 *
 * Remote changes are applied record by record. If this device has an unsent
 * edit to the SAME record, the shared version wins (nobody is silently
 * overwritten on the server), the user is told, and their version is stashed
 * so it can be recovered. Edits to other records are untouched.
 *
 * Everything impure — the socket, timers, randomness, persistence — is
 * injected, so the failure paths (lost acks, reconnects, conflicts, expired
 * sessions) are tested deterministically.
 */

import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type CommitMessage,
  type Identity,
  type RecordDelete,
  type RecordPut,
  type RecordVersion,
  type ServerMessage,
  LIMITS,
} from '../../../shared/protocol';
import { recordKey, splitRecordKey, type RecordKey } from './records';

export type SyncStatus =
  | 'connecting' // opening the socket / waiting for the first state
  | 'synced' // connected, nothing waiting to be sent
  | 'syncing' // an edit is being sent or waiting to be sent
  | 'offline' // not connected; edits are kept locally and sent on reconnect
  | 'readonly' // connected, but this person may not edit
  | 'session-expired' // the Access sign-in ended; the page must be reloaded
  | 'error' // the server refused something unexpected
  | 'stopped';

export interface SyncState {
  status: SyncStatus;
  /** Records waiting to be sent (0 when everything is saved to the server). */
  pending: number;
  /** Server revision this device has applied (null before the first state). */
  revision: number | null;
  you: Identity | null;
  /** Consecutive failed connection attempts. */
  reconnectAttempt: number;
  /** ms epoch of the last successful exchange with the server. */
  lastSyncedAt: number | null;
}

export type SyncNotice =
  | { kind: 'conflict'; keys: Array<{ kind: RecordVersion['kind']; id: string }> }
  | { kind: 'readonly' }
  | { kind: 'error'; message: string };

/** What the client needs from the app. */
export interface SyncHost {
  /** The shared records of the CURRENT local state (must reflect the latest edits synchronously). */
  readRecords(): Map<RecordKey, RecordPut>;
  /** Apply remote changes to the local state. Must update what readRecords() returns before returning. */
  applyRemote(puts: RecordPut[], deletes: RecordDelete[]): void;
  onState(state: SyncState): void;
  onNotice(notice: SyncNotice): void;
}

export interface SyncSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event?: unknown) => void) | null;
}

export interface PersistedMirror {
  revision: number;
  records: Record<RecordKey, string>;
}

export interface StashedEdit {
  at: string;
  kind: RecordVersion['kind'];
  id: string;
  /** The local version that was replaced by the shared one. */
  json: string | null;
}

export type SessionProbe = 'ok' | 'expired' | 'unreachable';

export interface SyncTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SyncClientOptions {
  url: string;
  host: SyncHost;
  createSocket(url: string): SyncSocket;
  clientId: string;
  /** Previously persisted mirror (offline start / reload). */
  initial?: PersistedMirror | null;
  /**
   * How the FIRST server state is treated:
   *  'apply'     the server's records are applied to local state (adopt / merge).
   *  'overwrite' the server's records become the mirror WITHOUT touching local
   *              state, so the next commit makes the server equal to local
   *              (deliberate replace of the shared workspace).
   */
  firstState?: 'apply' | 'overwrite';
  persistMirror?(mirror: PersistedMirror): void;
  stashEdit?(edit: StashedEdit): void;
  /** Asks whether the Access session is still valid (HTTP probe); optional. */
  probeSession?(): Promise<SessionProbe>;
  timers?: SyncTimers;
  random?: () => number;
  now?: () => number;
  newId?: () => string;
  commitDebounceMs?: number;
  heartbeatMs?: number;
  heartbeatTimeoutMs?: number;
  commitTimeoutMs?: number;
  /** Failed attempts after which the session is probed. */
  probeAfterAttempts?: number;
}

const WS_OPEN = 1;
const CLOSE_SESSION_EXPIRED = 4401;
const CLOSE_HEARTBEAT = 4000;
const CLOSE_COMMIT_TIMEOUT = 4001;

export class SyncClient {
  private readonly o: Required<Pick<SyncClientOptions, 'commitDebounceMs' | 'heartbeatMs' | 'heartbeatTimeoutMs' | 'commitTimeoutMs' | 'probeAfterAttempts'>> &
    SyncClientOptions;
  private readonly timers: SyncTimers;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly newId: () => string;

  private socket: SyncSocket | null = null;
  private stopped = false;
  private expired = false;
  private readOnly = false;
  private loaded = false; // received the first state on the CURRENT connection
  private firstStatePending: boolean;
  private mirror = new Map<RecordKey, string>();
  private revision: number | null = null;
  private inflight: CommitMessage | null = null;
  private you: Identity | null = null;
  private attempts = 0;
  private lastSyncedAt: number | null = null;
  private pending = 0;
  private status: SyncStatus = 'connecting';
  private sentKeys = new Set<RecordKey>();
  private noticedKeys = new Set<RecordKey>();

  private flushTimer: unknown = null;
  private reconnectTimer: unknown = null;
  private heartbeatTimer: unknown = null;
  private heartbeatTimeout: unknown = null;
  private commitTimer: unknown = null;
  private persistTimer: unknown = null;
  private hadState = false;

  constructor(options: SyncClientOptions) {
    this.o = {
      commitDebounceMs: 1500,
      heartbeatMs: 25_000,
      heartbeatTimeoutMs: 10_000,
      commitTimeoutMs: 20_000,
      probeAfterAttempts: 3,
      ...options,
    };
    this.timers = options.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.firstStatePending = options.firstState === 'overwrite';
    if (options.initial) {
      this.mirror = new Map(Object.entries(options.initial.records));
      this.revision = options.initial.revision;
      this.hadState = true;
    }
  }

  // ---- lifecycle -------------------------------------------------------------

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      detach(socket);
      try {
        socket.close(1000, 'client stopped');
      } catch {
        /* already closed */
      }
    }
    this.setStatus('stopped');
  }

  /** Call after every local change to the shared state; edits are coalesced. */
  notifyLocalChange(): void {
    if (this.stopped || this.expired) return;
    if (this.flushTimer !== null) this.timers.clearTimeout(this.flushTimer);
    this.flushTimer = this.timers.setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.o.commitDebounceMs);
    if (this.loaded && !this.readOnly && this.status === 'synced') this.setStatus('syncing');
  }

  /** Send pending edits now (used on page hide / explicit "sync now"). */
  flushNow(): void {
    if (this.flushTimer !== null) {
      this.timers.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }

  getState(): SyncState {
    return this.snapshotState();
  }

  /** Test/diagnostic view of the server copy this device believes in. */
  getMirror(): ReadonlyMap<RecordKey, string> {
    return this.mirror;
  }

  /** The network just came back: do not wait for the backoff timer. */
  networkOnline(): void {
    if (this.stopped || this.expired || this.socket !== null) return;
    if (this.reconnectTimer !== null) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connect();
  }

  // ---- connection ------------------------------------------------------------

  private connect(): void {
    if (this.stopped || this.expired) return;
    this.loaded = false;
    this.setStatus(this.hadState ? 'offline' : 'connecting');
    let socket: SyncSocket;
    try {
      socket = this.o.createSocket(this.o.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.sendMessage({ t: 'hello', v: PROTOCOL_VERSION, clientId: this.o.clientId, lastRevision: this.revision });
      this.armHeartbeat();
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.clearHeartbeatTimeout();
      this.onFrame(event.data);
    };
    socket.onerror = () => {
      /* followed by onclose */
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.loaded = false;
      this.clearHeartbeat();
      if (this.commitTimer !== null) {
        this.timers.clearTimeout(this.commitTimer);
        this.commitTimer = null;
      }
      if (this.stopped) return;
      if (event.code === CLOSE_SESSION_EXPIRED) {
        this.markExpired();
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.expired) return;
    this.attempts += 1;
    this.setStatus('offline');
    const base = Math.min(30_000, 1000 * 2 ** Math.min(this.attempts - 1, 5));
    const delay = Math.round(base * (0.5 + this.random() / 2));
    if (this.reconnectTimer !== null) this.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, delay);
  }

  private async reconnect(): Promise<void> {
    if (this.stopped || this.expired) return;
    if (this.attempts >= this.o.probeAfterAttempts && this.o.probeSession !== undefined) {
      // Repeated failures can mean the Access session ended (the upgrade is
      // answered with a login redirect). Ask over plain HTTP before hammering.
      let verdict: SessionProbe = 'unreachable';
      try {
        verdict = await this.o.probeSession();
      } catch {
        verdict = 'unreachable';
      }
      if (this.stopped || this.expired) return;
      if (verdict === 'expired') {
        this.markExpired();
        return;
      }
    }
    this.connect();
  }

  private markExpired(): void {
    this.expired = true;
    this.clearTimers();
    this.setStatus('session-expired');
  }

  private armHeartbeat(): void {
    if (this.heartbeatTimer !== null) this.timers.clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = this.timers.setTimeout(() => {
      this.heartbeatTimer = null;
      if (this.socket === null || this.socket.readyState !== WS_OPEN) return;
      this.sendMessage({ t: 'ping' });
      this.clearHeartbeatTimeout();
      this.heartbeatTimeout = this.timers.setTimeout(() => {
        this.heartbeatTimeout = null;
        this.socket?.close(CLOSE_HEARTBEAT, 'heartbeat timeout'); // half-open connection
      }, this.o.heartbeatTimeoutMs);
      this.armHeartbeat();
    }, this.o.heartbeatMs);
  }

  private clearHeartbeatTimeout(): void {
    if (this.heartbeatTimeout !== null) {
      this.timers.clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) this.timers.clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.clearHeartbeatTimeout();
  }

  private clearTimers(): void {
    for (const key of ['flushTimer', 'reconnectTimer', 'commitTimer', 'persistTimer'] as const) {
      if (this[key] !== null) this.timers.clearTimeout(this[key]);
      this[key] = null;
    }
    this.clearHeartbeat();
  }

  // ---- incoming --------------------------------------------------------------

  private onFrame(data: unknown): void {
    if (typeof data !== 'string') return;
    let msg: ServerMessage;
    try {
      msg = JSON.parse(data) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.t) {
      case 'ready':
        this.you = msg.you;
        this.readOnly = msg.you.role === 'viewer';
        return;
      case 'snapshot':
        this.onSnapshot(msg.records, msg.revision);
        return;
      case 'changes':
        this.onChanges(msg.puts, msg.deletes, msg.revision);
        return;
      case 'ack':
        this.onAck(msg.id, msg.revision);
        return;
      case 'reject':
        this.onReject(msg);
        return;
      case 'pong':
        return;
      case 'error':
        if (msg.code === 'session_expired') this.markExpired();
        else this.o.host.onNotice({ kind: 'error', message: msg.message });
        return;
    }
  }

  private onSnapshot(records: RecordPut[], revision: number): void {
    const next = new Map<RecordKey, string>();
    for (const r of records) next.set(recordKey(r.kind, r.id), r.json);

    if (this.firstStatePending) {
      // Deliberate replace: adopt the server's state as the baseline WITHOUT
      // applying it, so the next commit overwrites the server with local data.
      this.firstStatePending = false;
      this.mirror = next;
      this.revision = revision;
    } else {
      const puts: RecordPut[] = [];
      const deletes: RecordDelete[] = [];
      for (const [key, json] of next) {
        if (this.mirror.get(key) !== json) puts.push({ ...splitRecordKey(key), json });
      }
      for (const key of this.mirror.keys()) if (!next.has(key)) deletes.push(splitRecordKey(key));
      this.integrateRemote(puts, deletes);
      this.mirror = next;
      this.revision = revision;
    }
    this.afterServerState();
  }

  private onChanges(puts: RecordPut[], deletes: RecordDelete[], revision: number): void {
    this.integrateRemote(puts, deletes);
    for (const p of puts) this.mirror.set(recordKey(p.kind, p.id), p.json);
    for (const d of deletes) this.mirror.delete(recordKey(d.kind, d.id));
    this.revision = Math.max(this.revision ?? 0, revision);
    this.afterServerState();
  }

  /**
   * Apply remote changes to local state, detecting unsent local edits to the
   * same records. Shared versions win; the lost local versions are stashed.
   */
  private integrateRemote(puts: RecordPut[], deletes: RecordDelete[]): void {
    if (puts.length + deletes.length === 0) return;
    const desired = this.o.host.readRecords();
    const lost: RecordKey[] = [];
    const consider = (key: RecordKey, remoteJson: string | null): void => {
      const local = desired.get(key)?.json ?? null;
      const known = this.mirror.get(key) ?? null;
      if (local === known) return; // no unsent local edit to this record
      if (local === remoteJson) return; // both sides already agree
      lost.push(key);
      this.o.stashEdit?.({ at: new Date(this.now()).toISOString(), ...splitRecordKey(key), json: local });
    };
    for (const p of puts) consider(recordKey(p.kind, p.id), p.json);
    for (const d of deletes) consider(recordKey(d.kind, d.id), null);
    this.o.host.applyRemote(puts, deletes);
    this.noticeConflicts(lost);
  }

  private noticeConflicts(keys: RecordKey[]): void {
    const fresh = keys.filter((k) => !this.noticedKeys.has(k));
    if (fresh.length === 0) return;
    for (const k of fresh) this.noticedKeys.add(k);
    this.o.host.onNotice({ kind: 'conflict', keys: fresh.map(splitRecordKey) });
  }

  private afterServerState(): void {
    this.loaded = true;
    this.attempts = 0; // a connection that delivers state is a healthy one
    this.lastSyncedAt = this.now();
    this.hadState = true;
    this.schedulePersist();
    if (this.inflight !== null) {
      // A commit was in flight when the connection dropped: resend it verbatim.
      // The server recognises its id, so it is never applied twice.
      this.sendInflight();
    } else {
      this.flush();
    }
    this.publish();
  }

  private onAck(id: string, revision: number): void {
    if (this.inflight === null || this.inflight.id !== id) return;
    for (const p of this.inflight.puts) this.mirror.set(recordKey(p.kind, p.id), p.json);
    for (const d of this.inflight.deletes) this.mirror.delete(recordKey(d.kind, d.id));
    this.revision = Math.max(this.revision ?? 0, revision);
    this.endCommit();
    this.lastSyncedAt = this.now();
    this.schedulePersist();
    this.flush();
  }

  private onReject(msg: Extract<ServerMessage, { t: 'reject' }>): void {
    if (this.inflight === null || this.inflight.id !== msg.id) return;
    this.endCommit();
    switch (msg.reason) {
      case 'conflict': {
        const puts: RecordPut[] = [];
        const deletes: RecordDelete[] = [];
        const lost: RecordKey[] = [];
        const desired = this.o.host.readRecords();
        for (const c of msg.conflicts) {
          const key = recordKey(c.kind, c.id);
          const local = desired.get(key)?.json ?? null;
          if (local !== c.json && !this.noticedKeys.has(key)) {
            lost.push(key);
            this.o.stashEdit?.({ at: new Date(this.now()).toISOString(), kind: c.kind, id: c.id, json: local });
          }
          if (c.json === null) {
            deletes.push({ kind: c.kind, id: c.id });
            this.mirror.delete(key);
          } else {
            puts.push({ kind: c.kind, id: c.id, json: c.json });
            this.mirror.set(key, c.json);
          }
        }
        this.o.host.applyRemote(puts, deletes);
        this.revision = Math.max(this.revision ?? 0, msg.revision);
        this.noticeConflicts(lost);
        this.schedulePersist();
        this.flush(); // the non-conflicting remainder is sent again, on the new base
        return;
      }
      case 'stale':
        // Our base is unusable (history pruned / server restored): re-sync the full state.
        this.inflight = null;
        this.sendMessage({ t: 'hello', v: PROTOCOL_VERSION, clientId: this.o.clientId, lastRevision: null });
        return;
      case 'forbidden':
        this.readOnly = true;
        this.o.host.onNotice({ kind: 'readonly' });
        this.publish();
        return;
      case 'invalid':
        this.o.host.onNotice({ kind: 'error', message: msg.message ?? 'The server could not apply the change.' });
        this.setStatus('error');
        // Back off before retrying so a persistent problem cannot become a hot loop.
        this.flushTimer = this.timers.setTimeout(() => {
          this.flushTimer = null;
          this.flush();
        }, 10_000);
        return;
    }
  }

  // ---- outgoing --------------------------------------------------------------

  private diff(): { puts: RecordPut[]; deletes: RecordDelete[] } {
    const desired = this.o.host.readRecords();
    const puts: RecordPut[] = [];
    const deletes: RecordDelete[] = [];
    for (const [key, rec] of desired) {
      if (this.mirror.get(key) !== rec.json) puts.push(rec);
    }
    for (const key of this.mirror.keys()) {
      if (!desired.has(key)) deletes.push(splitRecordKey(key));
    }
    return { puts, deletes };
  }

  private flush(): void {
    if (this.stopped || this.expired || !this.loaded || this.inflight !== null) {
      this.publish();
      return;
    }
    const { puts, deletes } = this.diff();
    this.pending = puts.length + deletes.length;
    if (this.pending === 0) {
      this.noticedKeys.clear();
      this.publish();
      return;
    }
    if (this.readOnly) {
      this.publish();
      return;
    }
    // Chunk to the server's per-commit limit; the rest follows after the ack.
    const room = LIMITS.maxCommitRecords;
    const sendPuts = puts.slice(0, room);
    const sendDeletes = deletes.slice(0, Math.max(0, room - sendPuts.length));
    this.inflight = {
      t: 'commit',
      id: this.newId(),
      baseRevision: this.revision ?? 0,
      puts: sendPuts,
      deletes: sendDeletes,
      reason: 'edit',
    };
    this.sentKeys = new Set([...sendPuts.map((p) => recordKey(p.kind, p.id)), ...sendDeletes.map((d) => recordKey(d.kind, d.id))]);
    this.sendInflight();
    this.publish();
  }

  private sendInflight(): void {
    if (this.inflight === null) return;
    if (this.socket === null || this.socket.readyState !== WS_OPEN) return;
    this.sendMessage(this.inflight);
    if (this.commitTimer !== null) this.timers.clearTimeout(this.commitTimer);
    this.commitTimer = this.timers.setTimeout(() => {
      this.commitTimer = null;
      // No answer: assume a dead connection, reconnect and retry the same commit.
      this.socket?.close(CLOSE_COMMIT_TIMEOUT, 'commit timeout');
    }, this.o.commitTimeoutMs);
  }

  private endCommit(): void {
    this.inflight = null;
    this.sentKeys.clear();
    if (this.commitTimer !== null) this.timers.clearTimeout(this.commitTimer);
    this.commitTimer = null;
  }

  private sendMessage(message: ClientMessage): void {
    try {
      this.socket?.send(JSON.stringify(message));
    } catch {
      /* the close handler reconnects */
    }
  }

  // ---- state publishing ------------------------------------------------------

  private schedulePersist(): void {
    if (this.o.persistMirror === undefined || this.persistTimer !== null) return;
    this.persistTimer = this.timers.setTimeout(() => {
      this.persistTimer = null;
      if (this.revision !== null) this.o.persistMirror?.({ revision: this.revision, records: Object.fromEntries(this.mirror) });
    }, 1000);
  }

  private computeStatus(): SyncStatus {
    if (this.stopped) return 'stopped';
    if (this.expired) return 'session-expired';
    if (this.socket === null || !this.loaded) return this.hadState ? 'offline' : 'connecting';
    if (this.status === 'error') return 'error';
    if (this.readOnly) return 'readonly';
    return this.inflight !== null || this.pending > 0 ? 'syncing' : 'synced';
  }

  private publish(): void {
    if (this.status === 'error' && this.inflight === null && this.pending === 0) this.status = 'synced';
    this.setStatus(this.computeStatus());
  }

  private setStatus(status: SyncStatus): void {
    this.status = status;
    this.o.host.onState(this.snapshotState());
  }

  private snapshotState(): SyncState {
    return {
      status: this.status,
      pending: this.pending,
      revision: this.revision,
      you: this.you,
      reconnectAttempt: this.attempts,
      lastSyncedAt: this.lastSyncedAt,
    };
  }
}

function detach(socket: SyncSocket): void {
  socket.onopen = null;
  socket.onmessage = null;
  socket.onclose = null;
  socket.onerror = null;
}

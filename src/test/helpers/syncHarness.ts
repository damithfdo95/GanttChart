import type { ClientMessage, RecordDelete, RecordPut, ServerMessage } from '../../../shared/protocol';
import type { PersistedMirror, StashedEdit, SyncHost, SyncNotice, SyncSocket, SyncState, SyncTimers } from '../../lib/sync/client';
import { recordKey, splitRecordKey, type RecordKey } from '../../lib/sync/records';

/** Deterministic timers: nothing fires until the test advances the clock. */
export class ManualTimers implements SyncTimers {
  private nextId = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();
  time = 0;

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  get pending(): number {
    return this.timers.size;
  }

  /** Advance the clock, firing due timers in order (timers may schedule more). */
  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      let nextId: number | null = null;
      let nextAt = Infinity;
      for (const [id, t] of this.timers) {
        if (t.at <= target && t.at < nextAt) {
          nextAt = t.at;
          nextId = id;
        }
      }
      if (nextId === null) break;
      const t = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.time = Math.max(this.time, t.at);
      t.fn();
    }
    this.time = target;
  }
}

/** A socket the test controls: it records what the client sends and lets the test play the server. */
export class FakeSocket implements SyncSocket {
  readyState = 0;
  sent: ClientMessage[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ClientMessage);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.closedWith = { code, reason };
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code: code ?? 1005 }));
  }

  // ---- test controls ----
  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  serverSend(message: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  /** The network/server drops the connection. */
  serverDrop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  messages<T extends ClientMessage['t']>(type: T): Array<Extract<ClientMessage, { t: T }>> {
    return this.sent.filter((m): m is Extract<ClientMessage, { t: T }> => m.t === type);
  }
}

/** A stand-in for the app: holds the shared records and records what the client tells it. */
export class FakeHost implements SyncHost {
  records = new Map<RecordKey, RecordPut>();
  states: SyncState[] = [];
  notices: SyncNotice[] = [];
  applied: Array<{ puts: RecordPut[]; deletes: RecordDelete[] }> = [];

  readRecords(): Map<RecordKey, RecordPut> {
    return this.records;
  }

  applyRemote(puts: RecordPut[], deletes: RecordDelete[]): void {
    this.applied.push({ puts, deletes });
    for (const p of puts) this.records.set(recordKey(p.kind, p.id), p);
    for (const d of deletes) this.records.delete(recordKey(d.kind, d.id));
  }

  onState(state: SyncState): void {
    this.states.push(state);
  }

  onNotice(notice: SyncNotice): void {
    this.notices.push(notice);
  }

  get status(): SyncState['status'] {
    return this.states[this.states.length - 1]?.status ?? 'connecting';
  }

  get last(): SyncState {
    return this.states[this.states.length - 1];
  }

  /** The user edits (or adds) a record locally. */
  edit(kind: RecordPut['kind'], id: string, value: unknown): void {
    this.records.set(recordKey(kind, id), { kind, id, json: JSON.stringify(value) });
  }

  remove(kind: RecordPut['kind'], id: string): void {
    this.records.delete(recordKey(kind, id));
  }

  json(kind: RecordPut['kind'], id: string): string | undefined {
    return this.records.get(recordKey(kind, id))?.json;
  }
}

export const rec = (kind: RecordPut['kind'], id: string, value: unknown): RecordPut => ({ kind, id, json: JSON.stringify(value) });

export interface Storage2 {
  mirrors: PersistedMirror[];
  stash: StashedEdit[];
}

export { splitRecordKey };

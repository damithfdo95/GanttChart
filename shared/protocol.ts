/**
 * Sync protocol shared by the browser client and the Worker / Durable Object.
 * Plain TypeScript with no dependencies so both bundles can import it.
 *
 * The shared workspace is a set of opaque JSON records keyed by (kind, id).
 * The server never interprets record contents; it only versions, orders and
 * broadcasts them. Validation of the domain shape stays in the client's
 * existing normalize/validate code.
 */

export const PROTOCOL_VERSION = 1;

/** Record kinds that make up the shared workspace (see docs/CLOUD_ARCHITECTURE.md §5). */
export const RECORD_KINDS = [
  'project',
  'report',
  'attendance',
  'topic',
  'assignment',
  'review',
  'member',
  'identityAudit',
  'externalIdentity',
  'settings',
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

const RECORD_KIND_SET: ReadonlySet<string> = new Set(RECORD_KINDS);
export function isRecordKind(value: unknown): value is RecordKind {
  return typeof value === 'string' && RECORD_KIND_SET.has(value);
}

/** Hard limits enforced by the server (and respected by the client). */
export const LIMITS = {
  /** One record's JSON text. DO SQLite rows are limited to 2 MB. */
  maxRecordChars: 1_000_000,
  maxCommitRecords: 500,
  maxMessageChars: 8_000_000,
  maxIdChars: 200,
  maxClientIdChars: 100,
  maxCommitIdChars: 100,
  maxReasonChars: 100,
} as const;

export type Role = 'admin' | 'editor' | 'viewer';

export interface Identity {
  email: string;
  role: Role;
}

export interface RecordPut {
  kind: RecordKind;
  id: string;
  /** The record serialized with JSON.stringify — opaque to the server. */
  json: string;
}

export interface RecordDelete {
  kind: RecordKind;
  id: string;
}

/** The server's current version of a record; json null = it was deleted / never existed. */
export interface RecordVersion {
  kind: RecordKind;
  id: string;
  json: string | null;
}

// ---- client → server ----

export interface HelloMessage {
  t: 'hello';
  v: number;
  clientId: string;
  /** Last revision this client has applied; null when it has nothing yet. */
  lastRevision: number | null;
}

export interface CommitMessage {
  t: 'commit';
  /** Client-generated id; makes retries after a lost ack idempotent. */
  id: string;
  /** The server revision the client's edits were made on top of. */
  baseRevision: number;
  puts: RecordPut[];
  deletes: RecordDelete[];
  reason?: string;
}

export interface PingMessage {
  t: 'ping';
}

export type ClientMessage = HelloMessage | CommitMessage | PingMessage;

// ---- server → client ----

export interface ReadyMessage {
  t: 'ready';
  v: number;
  revision: number;
  you: Identity;
}

/** Full state; sent on first connect or when the client is too far behind. */
export interface SnapshotMessage {
  t: 'snapshot';
  revision: number;
  records: RecordPut[];
}

/** Committed changes; live broadcast and reconnect catch-up. */
export interface ChangesMessage {
  t: 'changes';
  revision: number;
  actor: string;
  at: string;
  puts: RecordPut[];
  deletes: RecordDelete[];
  /** True when this is catch-up for a (re)connecting client, not a live edit. */
  catchUp?: boolean;
}

export interface AckMessage {
  t: 'ack';
  id: string;
  revision: number;
  /** False when the commit changed nothing (every put equalled the server copy). */
  changed: boolean;
}

export type RejectReason = 'conflict' | 'stale' | 'forbidden' | 'invalid';

export interface RejectMessage {
  t: 'reject';
  id: string;
  reason: RejectReason;
  revision: number;
  /** For 'conflict': the server's current version of each contested record. */
  conflicts: RecordVersion[];
  message?: string;
}

export interface PongMessage {
  t: 'pong';
}

export interface ErrorMessage {
  t: 'error';
  code: string;
  message: string;
}

export type ServerMessage =
  | ReadyMessage
  | SnapshotMessage
  | ChangesMessage
  | AckMessage
  | RejectMessage
  | PongMessage
  | ErrorMessage;

// ---- runtime validation (server side, but usable anywhere) ----

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseKey(raw: unknown): { kind: RecordKind; id: string } | string {
  if (!isObject(raw)) return 'record must be an object';
  if (!isRecordKind(raw.kind)) return 'unknown record kind';
  if (typeof raw.id !== 'string' || raw.id.length === 0 || raw.id.length > LIMITS.maxIdChars) return 'invalid record id';
  return { kind: raw.kind, id: raw.id };
}

export function parsePuts(raw: unknown): ParseResult<RecordPut[]> {
  if (!Array.isArray(raw)) return { ok: false, error: 'puts must be an array' };
  const out: RecordPut[] = [];
  for (const item of raw) {
    const key = parseKey(item);
    if (typeof key === 'string') return { ok: false, error: key };
    const json = (item as Record<string, unknown>).json;
    if (typeof json !== 'string' || json.length === 0) return { ok: false, error: 'put.json must be a non-empty string' };
    if (json.length > LIMITS.maxRecordChars) return { ok: false, error: 'record too large' };
    out.push({ ...key, json });
  }
  return { ok: true, value: out };
}

export function parseDeletes(raw: unknown): ParseResult<RecordDelete[]> {
  if (!Array.isArray(raw)) return { ok: false, error: 'deletes must be an array' };
  const out: RecordDelete[] = [];
  for (const item of raw) {
    const key = parseKey(item);
    if (typeof key === 'string') return { ok: false, error: key };
    out.push(key);
  }
  return { ok: true, value: out };
}

/** Parse and validate one client frame. Never throws. */
export function parseClientMessage(text: string): ParseResult<ClientMessage> {
  if (text.length > LIMITS.maxMessageChars) return { ok: false, error: 'message too large' };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  if (!isObject(raw) || typeof raw.t !== 'string') return { ok: false, error: 'missing message type' };

  switch (raw.t) {
    case 'ping':
      return { ok: true, value: { t: 'ping' } };
    case 'hello': {
      if (raw.v !== PROTOCOL_VERSION) return { ok: false, error: 'unsupported protocol version' };
      if (typeof raw.clientId !== 'string' || raw.clientId.length === 0 || raw.clientId.length > LIMITS.maxClientIdChars) {
        return { ok: false, error: 'invalid clientId' };
      }
      const last = raw.lastRevision;
      if (last !== null && !(typeof last === 'number' && Number.isSafeInteger(last) && last >= 0)) {
        return { ok: false, error: 'invalid lastRevision' };
      }
      return { ok: true, value: { t: 'hello', v: PROTOCOL_VERSION, clientId: raw.clientId, lastRevision: last } };
    }
    case 'commit': {
      if (typeof raw.id !== 'string' || raw.id.length === 0 || raw.id.length > LIMITS.maxCommitIdChars) {
        return { ok: false, error: 'invalid commit id' };
      }
      const base = raw.baseRevision;
      if (!(typeof base === 'number' && Number.isSafeInteger(base) && base >= 0)) {
        return { ok: false, error: 'invalid baseRevision' };
      }
      const puts = parsePuts(raw.puts);
      if (!puts.ok) return puts;
      const deletes = parseDeletes(raw.deletes);
      if (!deletes.ok) return deletes;
      if (puts.value.length + deletes.value.length === 0) return { ok: false, error: 'empty commit' };
      if (puts.value.length + deletes.value.length > LIMITS.maxCommitRecords) return { ok: false, error: 'too many records' };
      const seen = new Set<string>();
      for (const rec of [...puts.value, ...deletes.value]) {
        const key = `${rec.kind}\u0000${rec.id}`;
        if (seen.has(key)) return { ok: false, error: 'duplicate record in commit' };
        seen.add(key);
      }
      let reason: string | undefined;
      if (raw.reason !== undefined) {
        if (typeof raw.reason !== 'string' || raw.reason.length > LIMITS.maxReasonChars) return { ok: false, error: 'invalid reason' };
        reason = raw.reason;
      }
      return {
        ok: true,
        value: { t: 'commit', id: raw.id, baseRevision: base, puts: puts.value, deletes: deletes.value, ...(reason !== undefined ? { reason } : {}) },
      };
    }
    default:
      return { ok: false, error: 'unknown message type' };
  }
}

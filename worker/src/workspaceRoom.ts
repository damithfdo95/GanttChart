/**
 * WorkspaceRoom — the single Durable Object that owns the shared workspace.
 *
 * It is the coordination atom: every commit is applied here, one at a time,
 * against SQLite storage in the same object, and each committed change is
 * broadcast to the connected sockets in commit order. Sockets use the
 * hibernation API, so an idle workspace costs nothing while clients stay
 * connected.
 *
 * Identity is NOT decided here: the Worker verifies the Cloudflare Access JWT
 * and passes the verified email/role in internal headers. This object is only
 * reachable through the Worker's binding.
 */

import { DurableObject } from 'cloudflare:workers';
import {
  PROTOCOL_VERSION,
  parseClientMessage,
  type ChangesMessage,
  type CommitMessage,
  type Identity,
  type RecordPut,
  type Role,
  type ServerMessage,
} from '../../shared/protocol';
import { WorkspaceStore, type CommitResult, type RevisionInfo } from './store';

/** Per-connection state that survives hibernation (limit: 16 KB). */
interface Attachment {
  email: string;
  role: Role;
  /** Set by the client's hello; commits before it are refused. */
  clientId: string | null;
  /** End of the Access session (ms epoch); null for the local dev identity. */
  expiresAt: number | null;
}

const IDENTITY_EMAIL_HEADER = 'x-gc-verified-email';
const IDENTITY_ROLE_HEADER = 'x-gc-verified-role';
const IDENTITY_EXPIRES_HEADER = 'x-gc-verified-exp';
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Default history retention. Kept at 30 days (not longer) so the full-record
 * history stays far below the Workers Free 5 GB storage cap even with heavy use.
 */
const DEFAULT_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 365;
/** Above this database size the alarm prunes harder (Workers Free storage cap is 5 GB). */
const SIZE_GUARD_BYTES = 2 * 1024 * 1024 * 1024;
const SIZE_GUARD_RETENTION_DAYS = 7;
const WS_CLOSE_SESSION_EXPIRED = 4401;
const WS_CLOSE_UNSUPPORTED_DATA = 1003;
const WS_CLOSE_MESSAGE_TOO_BIG = 1009;

export { IDENTITY_EMAIL_HEADER, IDENTITY_EXPIRES_HEADER, IDENTITY_ROLE_HEADER };

function isExpired(attachment: Attachment): boolean {
  return attachment.expiresAt !== null && Date.now() > attachment.expiresAt;
}

function isRole(value: string | null): value is Role {
  return value === 'admin' || value === 'editor' || value === 'viewer';
}

export class WorkspaceRoom extends DurableObject<Env> {
  private readonly store: WorkspaceStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new WorkspaceStore({
      sql: ctx.storage.sql,
      transactionSync: (fn) => ctx.storage.transactionSync(fn),
    });
    // Heartbeats are answered by the runtime without waking a hibernated object.
    // The frames must match JSON.stringify of the protocol's ping/pong exactly.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(JSON.stringify({ t: 'ping' }), JSON.stringify({ t: 'pong' })));
    // Schema setup only — never held across I/O besides the alarm lookup.
    ctx.blockConcurrencyWhile(async () => {
      this.store.init();
      if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now() + DAY_MS);
    });
  }

  // ---- WebSocket entry (called by the Worker with verified identity headers) ----

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    const email = request.headers.get(IDENTITY_EMAIL_HEADER);
    const role = request.headers.get(IDENTITY_ROLE_HEADER);
    if (email === null || email === '' || !isRole(role)) return new Response('Unauthenticated', { status: 401 });
    const expRaw = request.headers.get(IDENTITY_EXPIRES_HEADER);
    const expiresAt = expRaw === null ? null : Number(expRaw);
    if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) {
      return new Response('Session expired', { status: 401 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const attachment: Attachment = { email, role, clientId: null, expiresAt };
    server.serializeAttachment(attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') {
      ws.close(WS_CLOSE_UNSUPPORTED_DATA, 'text frames only');
      return;
    }
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (attachment === null) {
      ws.close(1008, 'no session');
      return;
    }
    if (isExpired(attachment)) {
      this.send(ws, { t: 'error', code: 'session_expired', message: 'Your sign-in session has ended; reload to sign in again.' });
      ws.close(WS_CLOSE_SESSION_EXPIRED, 'session expired');
      return;
    }
    const parsed = parseClientMessage(message);
    if (!parsed.ok) {
      if (parsed.error === 'message too large') {
        ws.close(WS_CLOSE_MESSAGE_TOO_BIG, 'message too large');
        return;
      }
      this.send(ws, { t: 'error', code: 'bad_message', message: parsed.error });
      return;
    }
    const msg = parsed.value;
    switch (msg.t) {
      case 'ping':
        this.send(ws, { t: 'pong' });
        return;
      case 'hello': {
        ws.serializeAttachment({ ...attachment, clientId: msg.clientId } satisfies Attachment);
        const you: Identity = { email: attachment.email, role: attachment.role };
        this.send(ws, { t: 'ready', v: PROTOCOL_VERSION, revision: this.store.revision(), you });
        if (msg.lastRevision === null) {
          const snap = this.store.snapshot();
          this.send(ws, { t: 'snapshot', revision: snap.revision, records: snap.records });
          return;
        }
        const missed = this.store.changesSince(msg.lastRevision);
        if (missed.kind === 'snapshot') {
          this.send(ws, { t: 'snapshot', revision: missed.revision, records: missed.records });
        } else {
          this.send(ws, {
            t: 'changes',
            revision: missed.revision,
            actor: 'server',
            at: new Date().toISOString(),
            puts: missed.puts,
            deletes: missed.deletes,
            catchUp: true,
          });
        }
        return;
      }
      case 'commit':
        this.handleCommit(ws, attachment, msg);
        return;
    }
  }

  override async webSocketClose(): Promise<void> {
    // Nothing to clean up: all session state lives in the socket attachment.
    // (The runtime auto-replies to the Close frame for compatibility dates >= 2026-04-07.)
  }

  override async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
    console.error(JSON.stringify({ event: 'ws_error', error: String(error) }));
  }

  private handleCommit(ws: WebSocket, attachment: Attachment, msg: CommitMessage): void {
    if (attachment.clientId === null) {
      this.send(ws, { t: 'error', code: 'hello_required', message: 'send hello first' });
      return;
    }
    if (attachment.role === 'viewer') {
      this.send(ws, { t: 'reject', id: msg.id, reason: 'forbidden', revision: this.store.revision(), conflicts: [], message: 'read-only access' });
      return;
    }
    let result: CommitResult;
    try {
      result = this.store.commit({
        commitId: msg.id,
        baseRevision: msg.baseRevision,
        puts: msg.puts,
        deletes: msg.deletes,
        actor: attachment.email,
        reason: msg.reason ?? 'edit',
        now: new Date().toISOString(),
      });
    } catch (error) {
      // transactionSync rolled back: nothing was applied.
      console.error(JSON.stringify({ event: 'commit_failed', error: String(error) }));
      this.send(ws, { t: 'reject', id: msg.id, reason: 'invalid', revision: this.store.revision(), conflicts: [], message: 'commit failed' });
      return;
    }
    if (!result.ok) {
      this.send(ws, {
        t: 'reject',
        id: msg.id,
        reason: result.reason,
        revision: result.revision,
        conflicts: result.reason === 'conflict' ? result.conflicts : [],
      });
      return;
    }
    this.send(ws, { t: 'ack', id: msg.id, revision: result.revision, changed: result.changed });
    if (result.changed && !result.duplicate) {
      this.broadcast(
        { t: 'changes', revision: result.revision, actor: attachment.email, at: result.at, puts: result.puts, deletes: result.deletes },
        ws,
      );
    }
  }

  // ---- RPC methods (called by the Worker for the HTTP API) ----

  async exportAll(): Promise<{ revision: number; records: RecordPut[] }> {
    return this.store.snapshot();
  }

  async listRevisions(limit: number, before?: number): Promise<RevisionInfo[]> {
    return this.store.listRevisions(limit, before);
  }

  async previewRevision(revision: number): Promise<RecordPut[] | null> {
    return this.store.reconstruct(revision);
  }

  /** Restore an old revision as a NEW revision and push the difference to every connected client. */
  async restoreRevision(revision: number, actor: string): Promise<{ ok: true; revision: number } | { ok: false; error: string }> {
    const commitId = `restore-${revision}-${crypto.randomUUID()}`;
    const result = this.store.restoreAsNewRevision(revision, actor, new Date().toISOString(), commitId);
    if (result === null) return { ok: false, error: 'revision-unavailable' };
    if (!result.ok) return { ok: false, error: result.reason };
    if (result.changed) {
      this.broadcast({ t: 'changes', revision: result.revision, actor, at: result.at, puts: result.puts, deletes: result.deletes });
    }
    return { ok: true, revision: result.revision };
  }

  async stats(): Promise<{ revision: number; floor: number; connections: number; bytes: number }> {
    return {
      revision: this.store.revision(),
      floor: this.store.historyFloor(),
      connections: this.ctx.getWebSockets().length,
      bytes: this.ctx.storage.sql.databaseSize,
    };
  }

  // ---- retention ----

  override async alarm(): Promise<void> {
    const days = Number(this.env.HISTORY_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS);
    let retention = Number.isFinite(days) && days >= 7 ? Math.min(days, MAX_RETENTION_DAYS) : DEFAULT_RETENTION_DAYS;
    if (this.ctx.storage.sql.databaseSize > SIZE_GUARD_BYTES) {
      console.warn(JSON.stringify({ event: 'size_guard', bytes: this.ctx.storage.sql.databaseSize }));
      retention = Math.min(retention, SIZE_GUARD_RETENTION_DAYS);
    }
    this.store.prune(new Date(Date.now() - retention * DAY_MS).toISOString());
    await this.ctx.storage.setAlarm(Date.now() + DAY_MS);
  }

  // ---- helpers ----

  private send(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // The socket is closing; the close handler / client reconnect logic takes over.
    }
  }

  private broadcast(message: ChangesMessage, except?: WebSocket): void {
    const frame = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except) continue;
      try {
        // A revoked/expired Access session must stop receiving data immediately.
        const attachment = socket.deserializeAttachment() as Attachment | null;
        if (attachment === null || isExpired(attachment)) {
          socket.close(WS_CLOSE_SESSION_EXPIRED, 'session expired');
          continue;
        }
        socket.send(frame);
      } catch {
        // dead socket — ignored, it will be cleaned up by the runtime
      }
    }
  }
}


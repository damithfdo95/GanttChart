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
import type { Env } from './env';

/** Per-connection state that survives hibernation (limit: 16 KB). */
interface Attachment {
  email: string;
  role: Role;
  /** Set by the client's hello; commits before it are refused. */
  clientId: string | null;
}

const IDENTITY_EMAIL_HEADER = 'x-gc-verified-email';
const IDENTITY_ROLE_HEADER = 'x-gc-verified-role';
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;
const WS_CLOSE_UNSUPPORTED_DATA = 1003;
const WS_CLOSE_MESSAGE_TOO_BIG = 1009;

export { IDENTITY_EMAIL_HEADER, IDENTITY_ROLE_HEADER };

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

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const attachment: Attachment = { email, role, clientId: null };
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
    const retention = Number.isFinite(days) && days >= 7 ? days : DEFAULT_RETENTION_DAYS;
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
        socket.send(frame);
      } catch {
        // dead socket — ignored, it will be cleaned up by the runtime
      }
    }
  }
}


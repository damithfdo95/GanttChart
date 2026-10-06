/**
 * WorkspaceRoom — ONE Durable Object PER TENANT. It owns that tenant's shared
 * workspace and nothing else.
 *
 * Isolation by construction: the object is addressed by the tenant id
 * (`getByName(tenantId)`), so state, history, sockets and broadcasts of one
 * tenant live in a different object than any other tenant's. As a second line
 * of defence the object verifies, on every entry point, that the tenant the
 * caller claims is the tenant this object IS (its own name). A routing bug can
 * therefore never serve the wrong tenant's data: it fails with an error.
 *
 * It is the coordination atom for that tenant: every commit is applied here,
 * one at a time, against SQLite storage in the same object, and each committed
 * change is broadcast to this object's own sockets in commit order. Sockets use
 * the hibernation API, so an idle workspace costs nothing.
 *
 * Identity and tenant are NOT decided here: the Worker verifies the Access JWT,
 * resolves the caller through the registry and passes the result in internal
 * headers. This object is only reachable through the Worker's binding.
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
import { CLOSE_CODES, canonicalRecordsHash, isTenantId, recordsHaveData, summarizeRecords, validateImportRecords } from '../../shared/tenancy';
import { WorkspaceStore, type CommitResult, type RevisionInfo } from './store';

/** Per-connection state that survives hibernation (limit: 16 KB). */
interface Attachment {
  email: string;
  userId: string;
  tenantId: string;
  role: Role;
  /** Set by the client's hello; commits before it are refused. */
  clientId: string | null;
  /** End of the Access session (ms epoch); null for the local dev identity. */
  expiresAt: number | null;
}

const IDENTITY_EMAIL_HEADER = 'x-gc-verified-email';
const IDENTITY_ROLE_HEADER = 'x-gc-verified-role';
const IDENTITY_EXPIRES_HEADER = 'x-gc-verified-exp';
const IDENTITY_USER_HEADER = 'x-gc-user';
const TENANT_HEADER = 'x-gc-tenant';
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
const WS_CLOSE_UNSUPPORTED_DATA = 1003;
const WS_CLOSE_MESSAGE_TOO_BIG = 1009;
/** The instance that served the pre-tenant (Stage 4) single workspace. */
export const LEGACY_WORKSPACE_NAME = 'workspace';
const FROZEN_FLAG = 'frozen';

export { IDENTITY_EMAIL_HEADER, IDENTITY_EXPIRES_HEADER, IDENTITY_ROLE_HEADER, IDENTITY_USER_HEADER, TENANT_HEADER };

function isExpired(attachment: Attachment): boolean {
  return attachment.expiresAt !== null && Date.now() > attachment.expiresAt;
}

function isRole(value: string | null): value is Role {
  return value === 'admin' || value === 'editor' || value === 'viewer';
}

export interface WorkspaceState {
  revision: number;
  hash: string;
  counts: Record<string, number>;
  hasData: boolean;
  frozen: boolean;
}

export type ImportInput = {
  /** Client-generated; repeating an import with the same id never applies it twice. */
  migrationId: string;
  records: unknown;
  /** The server revision the uploader inspected. A mismatch means someone else changed it. */
  expectedRevision: number;
  /** Replace existing server data (the caller has already verified the typed confirmation). */
  replace: boolean;
  actor: string;
};

export type ImportResult =
  | { ok: true; revision: number; hash: string; counts: Record<string, number>; alreadyApplied: boolean }
  | { ok: false; error: 'invalid' | 'revision_mismatch' | 'server_not_empty' | 'failed'; message?: string; revision?: number };

export class WorkspaceRoom extends DurableObject<Env> {
  private readonly store: WorkspaceStore;
  private frozen = false;

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
      this.frozen = this.store.readFlag(FROZEN_FLAG) === '1';
      if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now() + DAY_MS);
    });
  }

  // ---- tenant binding ----------------------------------------------------------

  /** The tenant this object IS: the id it was addressed by. Anything else fails closed. */
  private ownTenantId(): string {
    const name = this.ctx.id.name;
    if (typeof name !== 'string' || !isTenantId(name)) throw new Error('workspace is not bound to a tenant');
    return name;
  }

  /** Every RPC passes the tenant it believes it is talking to; a mismatch is an error, never data. */
  private assertTenant(claimed: string): void {
    if (claimed !== this.ownTenantId()) throw new Error('tenant mismatch');
  }

  // ---- WebSocket entry (called by the Worker with verified identity headers) ----

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    const tenantId = request.headers.get(TENANT_HEADER);
    if (tenantId === null || tenantId !== this.ownTenantId()) return new Response('Tenant mismatch', { status: 403 });
    const email = request.headers.get(IDENTITY_EMAIL_HEADER);
    const userId = request.headers.get(IDENTITY_USER_HEADER);
    const role = request.headers.get(IDENTITY_ROLE_HEADER);
    if (email === null || email === '' || userId === null || userId === '' || !isRole(role)) return new Response('Unauthenticated', { status: 401 });
    const expRaw = request.headers.get(IDENTITY_EXPIRES_HEADER);
    const expiresAt = expRaw === null ? null : Number(expRaw);
    if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) {
      return new Response('Session expired', { status: 401 });
    }
    if (this.frozen) return new Response('Workspace is archived', { status: 409 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const attachment: Attachment = { email, userId, tenantId, role, clientId: null, expiresAt };
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
    // A socket that is not THIS tenant's can never be served (defence in depth).
    if (attachment.tenantId !== this.ownTenantId()) {
      ws.close(CLOSE_CODES.accessRevoked, 'tenant mismatch');
      return;
    }
    if (isExpired(attachment)) {
      this.send(ws, { t: 'error', code: 'session_expired', message: 'Your sign-in session has ended; reload to sign in again.' });
      ws.close(CLOSE_CODES.sessionExpired, 'session expired');
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

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // All session state lives in the socket attachment, so there is nothing to
    // clean up — but the closing handshake must be completed explicitly: without
    // it the socket lingers half-closed (it stayed in getWebSockets() for ~10 s
    // in the runtime tests). Reserved codes (1005/1006/1015) cannot be sent.
    this.finishClose(ws, code, reason);
  }

  override async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error(JSON.stringify({ event: 'ws_error', error: String(error) }));
    this.finishClose(ws, 1011, 'error');
  }

  private finishClose(ws: WebSocket, code: number, reason: string): void {
    const sendable = code === 1005 || code === 1006 || code === 1015 || code < 1000 ? 1000 : code;
    try {
      ws.close(sendable, reason);
    } catch {
      // already closed
    }
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
    if (this.frozen) {
      this.send(ws, { t: 'reject', id: msg.id, reason: 'forbidden', revision: this.store.revision(), conflicts: [], message: 'workspace is archived' });
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

  // ---- RPC: reads --------------------------------------------------------------

  async exportAll(tenantId: string): Promise<{ revision: number; records: RecordPut[] }> {
    this.assertTenant(tenantId);
    return this.store.snapshot();
  }

  async listRevisions(tenantId: string, limit: number, before?: number): Promise<RevisionInfo[]> {
    this.assertTenant(tenantId);
    return this.store.listRevisions(limit, before);
  }

  async previewRevision(tenantId: string, revision: number): Promise<RecordPut[] | null> {
    this.assertTenant(tenantId);
    return this.store.reconstruct(revision);
  }

  /** Restore an old revision as a NEW revision and push the difference to every connected client. */
  async restoreRevision(tenantId: string, revision: number, actor: string): Promise<{ ok: true; revision: number } | { ok: false; error: string }> {
    this.assertTenant(tenantId);
    if (this.frozen) return { ok: false, error: 'archived' };
    const commitId = `restore-${revision}-${crypto.randomUUID()}`;
    const result = this.store.restoreAsNewRevision(revision, actor, new Date().toISOString(), commitId);
    if (result === null) return { ok: false, error: 'revision-unavailable' };
    if (!result.ok) return { ok: false, error: result.reason };
    if (result.changed) {
      this.broadcast({ t: 'changes', revision: result.revision, actor, at: result.at, puts: result.puts, deletes: result.deletes });
    }
    return { ok: true, revision: result.revision };
  }

  async stats(tenantId: string): Promise<{ revision: number; floor: number; connections: number; bytes: number; frozen: boolean }> {
    this.assertTenant(tenantId);
    return {
      revision: this.store.revision(),
      floor: this.store.historyFloor(),
      connections: this.ctx.getWebSockets().length,
      bytes: this.ctx.storage.sql.databaseSize,
      frozen: this.frozen,
    };
  }

  /** Revision + content hash + counts of the CURRENT state (used to verify a migration). */
  async verifyState(tenantId: string): Promise<WorkspaceState> {
    this.assertTenant(tenantId);
    return this.describeState();
  }

  private async describeState(): Promise<WorkspaceState> {
    const snap = this.store.snapshot();
    return {
      revision: snap.revision,
      hash: await canonicalRecordsHash(snap.records),
      counts: summarizeRecords(snap.records),
      hasData: recordsHaveData(snap.records),
      frozen: this.frozen,
    };
  }

  // ---- RPC: migration ----------------------------------------------------------

  /**
   * Atomic upload of a whole workspace as ONE revision.
   *  - never overwrites existing data unless `replace` is set (the caller has
   *    verified the typed confirmation); the previous state stays in history
   *  - `expectedRevision` must still be the current revision, otherwise someone
   *    else changed the workspace since it was inspected
   *  - retry-safe: the same content (or the same migration id) is a no-op
   */
  async importWorkspace(tenantId: string, input: ImportInput): Promise<ImportResult> {
    this.assertTenant(tenantId);
    const valid = validateImportRecords(input.records);
    if (!valid.ok) return { ok: false, error: 'invalid', message: valid.error };

    const before = this.store.snapshot();
    const [importHash, currentHash] = await Promise.all([canonicalRecordsHash(valid.records), canonicalRecordsHash(before.records)]);

    // The same content is already there: nothing to do (an interrupted upload that is retried).
    if (importHash === currentHash) {
      return { ok: true, revision: before.revision, hash: currentHash, counts: summarizeRecords(before.records), alreadyApplied: true };
    }
    // Everything below is synchronous: nothing can change between these checks and the commit.
    const head = this.store.revision();
    if (head !== before.revision || head !== input.expectedRevision) return { ok: false, error: 'revision_mismatch', revision: head };
    const current = this.store.snapshot().records;
    if (recordsHaveData(current) && !input.replace) return { ok: false, error: 'server_not_empty', revision: head };

    const wanted = new Map(valid.records.map((r) => [`${r.kind}\u0000${r.id}`, r]));
    const have = new Map(current.map((r) => [`${r.kind}\u0000${r.id}`, r]));
    const puts = valid.records.filter((r) => have.get(`${r.kind}\u0000${r.id}`)?.json !== r.json);
    const deletes = input.replace ? current.filter((r) => !wanted.has(`${r.kind}\u0000${r.id}`)).map((r) => ({ kind: r.kind, id: r.id })) : [];

    let result: CommitResult;
    try {
      result = this.store.commit({
        commitId: input.migrationId,
        baseRevision: head,
        puts,
        deletes,
        actor: input.actor,
        reason: input.replace ? 'migration-replace' : 'migration-import',
        now: new Date().toISOString(),
      });
    } catch (error) {
      console.error(JSON.stringify({ event: 'import_failed', error: String(error) }));
      return { ok: false, error: 'failed' };
    }
    if (!result.ok) return { ok: false, error: 'failed', message: result.reason, revision: result.revision };
    if (result.changed && !result.duplicate) {
      this.broadcast({ t: 'changes', revision: result.revision, actor: input.actor, at: result.at, puts: result.puts, deletes: result.deletes });
    }
    const after = await this.describeState();
    return { ok: true, revision: after.revision, hash: after.hash, counts: after.counts, alreadyApplied: result.duplicate };
  }

  /**
   * Archive the workspace for a switch to local mode: only if it is EXACTLY the
   * state the caller downloaded (revision and hash), refuse further commits,
   * and close every live connection. The data is kept.
   */
  async freezeIfUnchanged(tenantId: string, expected: { revision: number; hash: string }): Promise<{ ok: true } | { ok: false; error: 'workspace_changed' }> {
    this.assertTenant(tenantId);
    const snap = this.store.snapshot();
    const hash = await canonicalRecordsHash(snap.records);
    // Synchronous from here on: no commit can slip in between the check and the freeze.
    if (this.store.revision() !== snap.revision || snap.revision !== expected.revision || hash !== expected.hash) {
      return { ok: false, error: 'workspace_changed' };
    }
    this.store.writeFlag(FROZEN_FLAG, '1');
    this.frozen = true;
    this.closeAll(CLOSE_CODES.storageMoved, 'workspace moved to local storage');
    return { ok: true };
  }

  async thaw(tenantId: string): Promise<void> {
    this.assertTenant(tenantId);
    this.store.writeFlag(FROZEN_FLAG, null);
    this.frozen = false;
  }

  // ---- RPC: access control -----------------------------------------------------

  /** Close every live connection of one user (disabled, role changed). */
  async disconnectUser(tenantId: string, userId: string, code: number, reason: string): Promise<number> {
    this.assertTenant(tenantId);
    let closed = 0;
    for (const socket of this.ctx.getWebSockets()) {
      const a = socket.deserializeAttachment() as Attachment | null;
      if (a !== null && a.userId === userId) {
        this.finishClose(socket, code, reason);
        closed += 1;
      }
    }
    return closed;
  }

  /** Close every live connection of this tenant (deactivated, storage moved, deleted). */
  async disconnectAll(tenantId: string, code: number, reason: string): Promise<number> {
    this.assertTenant(tenantId);
    return this.closeAll(code, reason);
  }

  private closeAll(code: number, reason: string): number {
    const sockets = this.ctx.getWebSockets();
    for (const s of sockets) this.finishClose(s, code, reason);
    return sockets.length;
  }

  /** Permanently remove everything this tenant has stored (approved deletion). */
  async destroy(tenantId: string): Promise<void> {
    this.assertTenant(tenantId);
    this.closeAll(CLOSE_CODES.tenantDeleted, 'workspace deleted');
    await this.ctx.storage.deleteAll();
  }

  /**
   * Read the pre-tenant (Stage 4) workspace so a Super Admin can adopt it. Only
   * the legacy instance answers; a tenant's own object never does.
   */
  async exportLegacy(): Promise<{ revision: number; records: RecordPut[] }> {
    if (this.ctx.id.name !== LEGACY_WORKSPACE_NAME) throw new Error('not the legacy workspace');
    return this.store.snapshot();
  }

  // ---- retention ----------------------------------------------------------------

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

  // ---- helpers ----------------------------------------------------------------

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
          socket.close(CLOSE_CODES.sessionExpired, 'session expired');
          continue;
        }
        socket.send(frame);
      } catch {
        // dead socket — ignored, it will be cleaned up by the runtime
      }
    }
  }
}

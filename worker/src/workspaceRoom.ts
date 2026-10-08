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
import { qaCommitError } from '../../shared/qaRules';
import { memberRoleOf } from '../../shared/members';
import { SV_ONLY_KINDS } from '../../shared/testerRules';
import { businessClock, businessDate } from '../../shared/businessTime';
import { ackId, ackIsPrunable, audienceIncludes, checkNotification, checkNotificationAck, isAckableOccurrence, type NotificationAck, type NotificationDef, type NotificationFields, type Recipient } from '../../shared/notifications';
import { checkLogo, type BrandingRecord } from '../../shared/branding';
import { DEFAULT_PLAN_RETENTION_DAYS, RETENTION_CHOICES, retentionCutoff } from '../../shared/meeting';
import { TM_KINDS, authorizedScopeIds, filterForTester, testerMaySee } from '../../shared/testManagementAccess';
import { CLOSE_CODES, canonicalRecordsHash, isTenantId, recordsHaveData, summarizeRecords, validateImportRecords } from '../../shared/tenancy';
import { WorkspaceStore, type CommitResult, type RevisionFilter, type RevisionInfo } from './store';

/** A Team Member profile as the Worker reads it (the fields it needs to decide; never the whole record). */
export interface MemberInfo {
  id: string;
  name: string;
  email?: string;
  /** The word stored on the profile ("SV" / "Tester", or an older free-text role). */
  role: string;
  active: boolean;
  userId?: string;
}

type LinkError = 'member_not_found' | 'member_already_linked' | 'account_already_linked' | 'member_inactive' | 'member_email_mismatch' | 'member_email_taken' | 'archived' | 'failed';
type LinkResult = { ok: true; memberId: string; created: boolean; assignments: number } | { ok: false; error: LinkError };

function toMemberInfo(id: string, o: Record<string, unknown>): MemberInfo {
  return {
    id,
    name: typeof o.name === 'string' ? o.name : '',
    ...(typeof o.email === 'string' ? { email: o.email } : {}),
    role: typeof o.role === 'string' ? o.role : '',
    active: o.active !== false,
    ...(typeof o.userId === 'string' && o.userId !== '' ? { userId: o.userId } : {}),
  };
}

/**
 * A Tester receives the roster (names, for showing who did what) but NOT other people's email addresses: the email belongs to the
 * directory an SV manages. Their own profile keeps its email.
 */
function redactMemberEmail<T extends { kind: string; json?: string }>(item: T, userId: string): T {
  if (item.kind !== 'member' || item.json === undefined) return item;
  try {
    const o = JSON.parse(item.json) as Record<string, unknown>;
    if (o.email === undefined || (userId !== '' && o.userId === userId)) return item;
    const { email: _email, ...rest } = o;
    return { ...item, json: JSON.stringify(rest) };
  } catch {
    return item;
  }
}

/** The date (business time) of the last housekeeping run: it runs at most once a day. */
const RETENTION_FLAG = 'retention-last-run';

/** Does this stored definition address this person (and is it on)? Unreadable definitions reach nobody. */
function definitionReaches(json: string | undefined, who: Recipient): boolean {
  if (json === undefined) return false;
  try {
    const c = checkNotification(JSON.parse(json));
    return c.ok && c.value.enabled && audienceIncludes(c.value.audience, who);
  } catch {
    return false;
  }
}

/** The parts of a Team Member profile that follow its login account, and so are not undone by restoring an older revision. */
const ACCOUNT_FIELDS = ['userId', 'email', 'role', 'active', 'endDate', 'removedAt'] as const;

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

/** What a Tester receives: everything except the SV-only kinds (reviews, identity logs, reports, topics). */
function visibleTo<T extends { kind: string }>(role: Role, items: T[]): T[] {
  return role === 'admin' ? items : items.filter((i) => !SV_ONLY_KINDS.has(i.kind));
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
          this.send(ws, { t: 'snapshot', revision: snap.revision, records: this.visibleFor(attachment, snap.records) });
          return;
        }
        const missed = this.store.changesSince(msg.lastRevision);
        // What a Tester may read depends on their assignments: if any assignment or scope changed while they were away, a catch-up
        // of "what changed" cannot say what became visible, so they get the whole (filtered) picture instead.
        const visibilityMoved = attachment.role !== 'admin' && missed.kind === 'changes' && [...missed.puts, ...missed.deletes].some((r) => r.kind === 'assignment' || r.kind === 'scope' || r.kind === 'notification' || r.kind === 'member');
        if (missed.kind === 'snapshot' || visibilityMoved) {
          const snap = missed.kind === 'snapshot' ? missed : { revision: missed.revision, records: this.store.snapshot().records };
          this.send(ws, { t: 'snapshot', revision: snap.revision, records: this.visibleFor(attachment, snap.records) });
        } else {
          this.send(ws, {
            t: 'changes',
            revision: missed.revision,
            actor: 'server',
            at: new Date().toISOString(),
            ...this.viewFor(attachment, missed.puts, missed.deletes),
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
        // Who may change what, and what may refer to what (shared/qaRules.ts).
        rules: ({ puts, deletes, get, list }) => qaCommitError({ role: attachment.role, userId: attachment.userId, today: businessDate(), puts, deletes, view: { get, list } }),
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
        ...(result.reason === 'invalid' ? { message: result.message } : {}),
      });
      return;
    }
    this.send(ws, { t: 'ack', id: msg.id, revision: result.revision, changed: result.changed });
    if (result.changed && !result.duplicate && msg.puts.some((p) => p.kind === 'dailyPlan' || p.kind === 'meetingNote')) this.maybeRunRetention(Date.now());
    if (result.changed && !result.duplicate) {
      this.broadcast(
        { t: 'changes', revision: result.revision, actor: attachment.email, at: result.at, puts: result.puts, deletes: result.deletes },
        ws,
      );
    }
  }

  // ---- RPC: Tester assignment ----------------------------------------------------

  /**
   * Assign a Tester ACCOUNT to a project of this workspace as one ordinary revision (the Worker has already checked the account
   * against the registry). Idempotent: an assignment that is already current is returned as it is. The project must exist HERE,
   * so a project of another workspace can never be named.
   */
  async assignTester(
    tenantId: string,
    input: { projectId: string; userId: string; testerName: string; actor: string; today: string; scopeId?: string },
  ): Promise<{ ok: true; assignment: { id: string; projectId: string; userId: string; scopeId?: string }; revision: number; created: boolean } | { ok: false; error: 'project_not_found' | 'scope_not_found' | 'scope_archived' | 'archived' | 'failed' }> {
    this.assertTenant(tenantId);
    if (this.frozen) return { ok: false, error: 'archived' };
    if (this.store.findProjectByStableId(input.projectId) === null) return { ok: false, error: 'project_not_found' };
    // A scope-level assignment names a scope of THIS project that can still receive work.
    if (input.scopeId !== undefined) {
      const scope = this.store.recordsOfKind('scope').map((r) => JSON.parse(r.json) as { id?: string; projectId?: string; status?: string }).find((s) => s.id === input.scopeId);
      if (scope === undefined || scope.projectId !== input.projectId) return { ok: false, error: 'scope_not_found' };
      if (scope.status === 'archived') return { ok: false, error: 'scope_archived' };
    }
    const existing = this.store
      .recordsOfKind('assignment')
      .map((r) => ({ id: r.id, ...(JSON.parse(r.json) as { projectId?: string; userId?: string; scopeId?: string; active?: boolean; endDate?: string; startDate?: string }) }))
      .find((a) => a.projectId === input.projectId && a.userId === input.userId && (a.scopeId ?? null) === (input.scopeId ?? null) && a.active === true && (a.endDate === undefined || a.endDate === '' || a.endDate >= input.today));
    if (existing !== undefined) return { ok: true, assignment: { id: existing.id, projectId: input.projectId, userId: input.userId, ...(input.scopeId === undefined ? {} : { scopeId: input.scopeId }) }, revision: this.store.revision(), created: false };

    const id = crypto.randomUUID();
    const json = JSON.stringify({ id, projectId: input.projectId, userId: input.userId, testerName: input.testerName, startDate: input.today, active: true, ...(input.scopeId === undefined ? {} : { scopeId: input.scopeId }) });
    const now = new Date().toISOString();
    let result: CommitResult;
    try {
      result = this.store.commit({
        commitId: `assign-${crypto.randomUUID()}`,
        baseRevision: this.store.revision(),
        puts: [{ kind: 'assignment', id, json }],
        deletes: [],
        actor: input.actor,
        reason: 'assign',
        now,
      });
    } catch {
      return { ok: false, error: 'failed' };
    }
    if (!result.ok) return { ok: false, error: 'failed' };
    if (result.changed && !result.duplicate) this.broadcast({ t: 'changes', revision: result.revision, actor: input.actor, at: result.at, puts: result.puts, deletes: result.deletes });
    return { ok: true, assignment: { id, projectId: input.projectId, userId: input.userId, ...(input.scopeId === undefined ? {} : { scopeId: input.scopeId }) }, revision: result.revision, created: true };
  }

  /**
   * Assign a Team Member PROFILE that has no account yet to a project (or one scope of it): the business assignment exists now and
   * becomes usable by the person automatically when their account is linked (the link stamps the account id onto it). It grants
   * nothing until then, because execution rights are decided by account id only. Idempotent.
   */
  async assignMember(
    tenantId: string,
    input: { memberId: string; projectId: string; scopeId?: string; today: string; actor: string },
  ): Promise<{ ok: true; assignment: { id: string; projectId: string; memberId: string; scopeId?: string }; revision: number; created: boolean } | { ok: false; error: 'member_not_found' | 'member_inactive' | 'member_not_tester' | 'member_linked' | 'project_not_found' | 'scope_not_found' | 'scope_archived' | 'archived' | 'failed' }> {
    this.assertTenant(tenantId);
    if (this.frozen) return { ok: false, error: 'archived' };
    const member = this.memberRows().find((m) => m.id === input.memberId);
    if (member === undefined) return { ok: false, error: 'member_not_found' };
    if (member.o.active === false) return { ok: false, error: 'member_inactive' };
    if (memberRoleOf(member.o.role) !== 'tester') return { ok: false, error: 'member_not_tester' };
    if (typeof member.o.userId === 'string' && member.o.userId !== '') return { ok: false, error: 'member_linked' };
    if (this.store.findProjectByStableId(input.projectId) === null) return { ok: false, error: 'project_not_found' };
    if (input.scopeId !== undefined) {
      const scope = this.store.recordsOfKind('scope').map((r) => JSON.parse(r.json) as { id?: string; projectId?: string; status?: string }).find((x) => x.id === input.scopeId);
      if (scope === undefined || scope.projectId !== input.projectId) return { ok: false, error: 'scope_not_found' };
      if (scope.status === 'archived') return { ok: false, error: 'scope_archived' };
    }
    const existing = this.store
      .recordsOfKind('assignment')
      .map((r) => ({ id: r.id, ...(JSON.parse(r.json) as { projectId?: string; memberId?: string; userId?: string; scopeId?: string; active?: boolean; endDate?: string }) }))
      .find((a) => a.projectId === input.projectId && a.memberId === input.memberId && a.userId === undefined && (a.scopeId ?? null) === (input.scopeId ?? null) && a.active === true && (a.endDate === undefined || a.endDate === '' || a.endDate >= input.today));
    const scopePart = input.scopeId === undefined ? {} : { scopeId: input.scopeId };
    if (existing !== undefined) return { ok: true, assignment: { id: existing.id, projectId: input.projectId, memberId: input.memberId, ...scopePart }, revision: this.store.revision(), created: false };
    const id = crypto.randomUUID();
    const json = JSON.stringify({ id, projectId: input.projectId, memberId: input.memberId, testerName: typeof member.o.name === 'string' ? member.o.name : '', startDate: input.today, active: true, ...scopePart });
    if (!this.commitServerChange('assign-member', [{ kind: 'assignment', id, json }], [], input.actor)) return { ok: false, error: 'failed' };
    return { ok: true, assignment: { id, projectId: input.projectId, memberId: input.memberId, ...scopePart }, revision: this.store.revision(), created: true };
  }

  // ---- RPC: Team Member profiles -------------------------------------------------

  /** Every profile with its parsed content (the roster records of this workspace). */
  private memberRows(): Array<{ id: string; o: Record<string, unknown> }> {
    const out: Array<{ id: string; o: Record<string, unknown> }> = [];
    for (const m of this.store.recordsOfKind('member')) {
      try {
        const o: unknown = JSON.parse(m.json);
        if (typeof o === 'object' && o !== null && !Array.isArray(o)) out.push({ id: m.id, o: o as Record<string, unknown> });
      } catch {
        /* an unreadable record is not a profile */
      }
    }
    return out;
  }

  /** The next profile id, following the existing USER0001 convention (internal; never shown). */
  private nextMemberId(): string {
    let max = 0;
    for (const m of this.store.recordsOfKind('member')) {
      const n = /^USER(\d+)$/.exec(m.id);
      if (n !== null) max = Math.max(max, Number(n[1]));
    }
    return `USER${String(max + 1).padStart(4, '0')}`;
  }

  /** One profile of this workspace as the Worker needs it, or null (another workspace's id is simply unknown here). */
  async readMember(tenantId: string, memberId: string): Promise<MemberInfo | null> {
    this.assertTenant(tenantId);
    const row = this.memberRows().find((m) => m.id === memberId);
    return row === undefined ? null : toMemberInfo(row.id, row.o);
  }

  /** Every profile, for the Worker's reconciliation checks (for example which unlinked profile carries an email). */
  async listMembers(tenantId: string): Promise<MemberInfo[]> {
    this.assertTenant(tenantId);
    return this.memberRows().map((m) => toMemberInfo(m.id, m.o));
  }

  /**
   * Create a Team Member PROFILE (no account): a person of this workspace who can be chosen in dropdowns, assigned and reported on.
   * The email, when given, is normalised by the Worker and must be unique among this workspace's profiles. Display names are never
   * compared: two people may share one.
   */
  async createMemberProfile(
    tenantId: string,
    input: { name: string; email?: string; role: 'SV' | 'Tester'; team?: string; today: string; actor: string },
  ): Promise<{ ok: true; memberId: string } | { ok: false; error: 'member_email_taken' | 'archived' | 'failed' }> {
    this.assertTenant(tenantId);
    if (this.frozen) return { ok: false, error: 'archived' };
    const rows = this.memberRows();
    if (input.email !== undefined && rows.some((m) => m.o.email === input.email)) return { ok: false, error: 'member_email_taken' };
    const id = this.nextMemberId();
    const json = JSON.stringify({ id, name: input.name, team: input.team ?? 'RCS', role: input.role, startDate: input.today, active: true, ...(input.email === undefined ? {} : { email: input.email }) });
    return this.commitServerChange('member-create', [{ kind: 'member', id, json }], [], input.actor) ? { ok: true, memberId: id } : { ok: false, error: 'failed' };
  }

  /**
   * A profile for an ACCOUNT the Worker has just created. Idempotent and never guesses:
   *  - the account already has a profile: that one is returned;
   *  - otherwise an UNLINKED, active profile with the same normalised email is linked (the person already existed in the directory);
   *  - otherwise a new profile is created.
   * A profile found by email that is removed, or already linked to someone else, is reported instead of being touched.
   */
  async ensureMemberProfile(
    tenantId: string,
    input: { userId: string; name: string; email?: string; role: 'SV' | 'Tester'; today: string; actor: string },
  ): Promise<{ ok: true; memberId: string; created: boolean; linked: boolean } | { ok: false; error: 'archived' | 'failed' | 'member_removed' | 'member_already_linked' }> {
    this.assertTenant(tenantId);
    if (this.frozen) return { ok: false, error: 'archived' };
    const rows = this.memberRows();
    const own = rows.find((m) => m.o.userId === input.userId);
    if (own !== undefined) return { ok: true, memberId: own.id, created: false, linked: false };
    if (input.email !== undefined) {
      const byEmail = rows.find((m) => m.o.email === input.email);
      if (byEmail !== undefined) {
        if (typeof byEmail.o.userId === 'string' && byEmail.o.userId !== '') return { ok: false, error: 'member_already_linked' };
        if (byEmail.o.active === false) return { ok: false, error: 'member_removed' };
        const done = this.linkRows(rows, byEmail.id, { userId: input.userId, email: input.email, role: input.role, actor: input.actor });
        return done.ok ? { ok: true, memberId: byEmail.id, created: false, linked: true } : { ok: false, error: 'failed' };
      }
    }
    const id = this.nextMemberId();
    const json = JSON.stringify({ id, name: input.name, team: 'RCS', role: input.role, startDate: input.today, active: true, userId: input.userId, ...(input.email === undefined ? {} : { email: input.email }) });
    return this.commitServerChange('member-profile', [{ kind: 'member', id, json }], [], input.actor) ? { ok: true, memberId: id, created: true, linked: false } : { ok: false, error: 'failed' };
  }

  /**
   * Link an existing UNLINKED profile to an account of this workspace (an SV's explicit decision; nothing is guessed from names). The
   * account's email becomes the profile's email (a profile that already has a DIFFERENT email is refused), the profile takes the
   * account's real role, and every assignment that already named this person (by profile) becomes usable by the account in the SAME
   * commit - nothing is duplicated or recreated.
   */
  async linkMember(
    tenantId: string,
    input: { memberId: string; userId: string; email: string; role: 'SV' | 'Tester'; actor: string },
  ): Promise<LinkResult> {
    this.assertTenant(tenantId);
    if (this.frozen) return { ok: false, error: 'archived' };
    return this.linkRows(this.memberRows(), input.memberId, input);
  }

  private linkRows(rows: Array<{ id: string; o: Record<string, unknown> }>, memberId: string, input: { userId: string; email: string; role: 'SV' | 'Tester'; actor: string }): LinkResult {
    const target = rows.find((m) => m.id === memberId);
    if (target === undefined) return { ok: false, error: 'member_not_found' };
    if (target.o.userId === input.userId) return { ok: true, memberId, created: false, assignments: 0 };
    if (typeof target.o.userId === 'string' && target.o.userId !== '') return { ok: false, error: 'member_already_linked' };
    if (rows.some((m) => m.o.userId === input.userId)) return { ok: false, error: 'account_already_linked' };
    if (target.o.active === false) return { ok: false, error: 'member_inactive' };
    if (typeof target.o.email === 'string' && target.o.email !== input.email) return { ok: false, error: 'member_email_mismatch' };
    if (rows.some((m) => m.id !== memberId && m.o.email === input.email)) return { ok: false, error: 'member_email_taken' };
    const puts: RecordPut[] = [{ kind: 'member', id: memberId, json: JSON.stringify({ ...target.o, userId: input.userId, email: input.email, role: input.role }) }];
    // Assignments made for this PROFILE before it had an account now belong to the account, by stamping the account id onto them.
    let stamped = 0;
    for (const r of this.store.recordsOfKind('assignment')) {
      let a: Record<string, unknown>;
      try {
        a = JSON.parse(r.json) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (a.memberId === memberId && (a.userId === undefined || a.userId === '')) {
        puts.push({ kind: 'assignment', id: r.id, json: JSON.stringify({ ...a, userId: input.userId }) });
        stamped += 1;
      }
    }
    return this.commitServerChange('member-link', puts, [], input.actor) ? { ok: true, memberId, created: true, assignments: stamped } : { ok: false, error: 'failed' };
  }

  /** Change the intended / account role word on a profile (the account side was already changed by the Worker for a linked profile). */
  async setMemberRole(tenantId: string, input: { memberId: string; role: 'SV' | 'Tester'; actor: string }): Promise<{ ok: true; changed: boolean } | { ok: false; error: 'member_not_found' | 'archived' | 'failed' }> {
    this.assertTenant(tenantId);
    if (this.frozen) return { ok: false, error: 'archived' };
    const row = this.memberRows().find((m) => m.id === input.memberId);
    if (row === undefined) return { ok: false, error: 'member_not_found' };
    if (row.o.role === input.role) return { ok: true, changed: false };
    return this.commitServerChange('member-role', [{ kind: 'member', id: row.id, json: JSON.stringify({ ...row.o, role: input.role }) }], [], input.actor) ? { ok: true, changed: true } : { ok: false, error: 'failed' };
  }

  /**
   * Remove a profile from active use (never a deletion: attendance, tickets, performance, assignments and results keep pointing at it,
   * so history still shows the person). Reactivating restores the same identity. The account, if any, is handled by the Worker.
   */
  async setMemberActive(tenantId: string, input: { memberId: string; active: boolean; today: string; actor: string }): Promise<{ ok: true; changed: boolean } | { ok: false; error: 'member_not_found' | 'archived' | 'failed' }> {
    this.assertTenant(tenantId);
    if (this.frozen) return { ok: false, error: 'archived' };
    const row = this.memberRows().find((m) => m.id === input.memberId);
    if (row === undefined) return { ok: false, error: 'member_not_found' };
    if ((row.o.active !== false) === input.active) return { ok: true, changed: false };
    const next: Record<string, unknown> = { ...row.o };
    if (input.active) {
      next.active = true;
      delete next.endDate;
      delete next.removedAt;
    } else {
      next.active = false;
      next.removedAt = new Date().toISOString();
      const started = typeof next.startDate === 'string' ? next.startDate : input.today;
      next.endDate = input.today < started ? started : input.today;
    }
    return this.commitServerChange(input.active ? 'member-reactivate' : 'member-remove', [{ kind: 'member', id: row.id, json: JSON.stringify(next) }], [], input.actor) ? { ok: true, changed: true } : { ok: false, error: 'failed' };
  }

  /**
   * Edit what an SV may change about a profile through the API (so it lands in the administrative trail): the display name, the team
   * and - for a profile with NO account - the email. A name change keeps the old name in the profile's name history, so older records
   * still resolve to the same person.
   */
  async editMemberProfile(
    tenantId: string,
    input: { memberId: string; name?: string; team?: string; email?: string | null; startDate?: string; endDate?: string | null; nameHistory?: Array<{ name: string; fromDate?: string; toDate?: string }>; today: string; actor: string },
  ): Promise<{ ok: true; changed: boolean; fields: string[] } | { ok: false; error: 'member_not_found' | 'member_email_taken' | 'member_email_locked' | 'archived' | 'failed' }> {
    this.assertTenant(tenantId);
    if (this.frozen) return { ok: false, error: 'archived' };
    const rows = this.memberRows();
    const row = rows.find((m) => m.id === input.memberId);
    if (row === undefined) return { ok: false, error: 'member_not_found' };
    const linked = typeof row.o.userId === 'string' && row.o.userId !== '';
    const next: Record<string, unknown> = { ...row.o };
    const fields: string[] = [];
    if (input.name !== undefined && input.name !== row.o.name) {
      // An explicit history (the profile form sends one) is the SV's own; otherwise the old name is kept so older records still resolve.
      const history = Array.isArray(row.o.nameHistory) ? [...(row.o.nameHistory as unknown[])] : [];
      if (input.nameHistory === undefined && typeof row.o.name === 'string' && row.o.name !== '') history.push({ name: row.o.name, toDate: input.today });
      next.name = input.name;
      next.nameHistory = history;
      fields.push('name');
    }
    if (input.nameHistory !== undefined && JSON.stringify(input.nameHistory) !== JSON.stringify(row.o.nameHistory ?? [])) {
      if (input.nameHistory.length === 0) delete next.nameHistory;
      else next.nameHistory = input.nameHistory;
      fields.push('nameHistory');
    }
    if (input.startDate !== undefined && input.startDate !== row.o.startDate) {
      next.startDate = input.startDate;
      fields.push('startDate');
    }
    if (input.endDate !== undefined && (input.endDate ?? undefined) !== row.o.endDate) {
      if (input.endDate === null) delete next.endDate;
      else next.endDate = input.endDate;
      fields.push('endDate');
    }
    if (input.team !== undefined && input.team !== row.o.team) {
      next.team = input.team;
      fields.push('team');
    }
    if (input.email !== undefined && (input.email ?? null) !== (row.o.email ?? null)) {
      if (linked) return { ok: false, error: 'member_email_locked' };
      if (input.email !== null && rows.some((m) => m.id !== row.id && m.o.email === input.email)) return { ok: false, error: 'member_email_taken' };
      if (input.email === null) delete next.email;
      else next.email = input.email;
      fields.push('email');
    }
    if (fields.length === 0) return { ok: true, changed: false, fields };
    return this.commitServerChange('member-edit', [{ kind: 'member', id: row.id, json: JSON.stringify(next) }], [], input.actor) ? { ok: true, changed: true, fields } : { ok: false, error: 'failed' };
  }

  /** Undo a profile created moments ago in the same request (the account meant to go with it could not be created). A linked profile is never deleted. */
  async discardMemberProfile(tenantId: string, memberId: string, actor: string): Promise<boolean> {
    this.assertTenant(tenantId);
    const row = this.memberRows().find((m) => m.id === memberId);
    if (row === undefined) return true;
    if (typeof row.o.userId === 'string' && row.o.userId !== '') return false;
    return this.commitServerChange('member-discard', [], [{ kind: 'member', id: memberId }], actor);
  }

  /** One server-originated revision (no client rules: the caller has already validated), pushed live to everyone connected. */
  private commitServerChange(reason: string, puts: RecordPut[], deletes: Array<{ kind: RecordPut['kind']; id: string }>, actor: string): boolean {
    let result: CommitResult;
    try {
      result = this.store.commit({ commitId: `${reason}-${crypto.randomUUID()}`, baseRevision: this.store.revision(), puts, deletes, actor, reason, now: new Date().toISOString() });
    } catch {
      return false;
    }
    if (!result.ok) return false;
    if (result.changed && !result.duplicate) this.broadcast({ t: 'changes', revision: result.revision, actor, at: result.at, puts: result.puts, deletes: result.deletes });
    return true;
  }

  // ---- RPC: scheduled notifications, logo, retention (Stage 8E) --------------------------------

  /** Who a person is for audience purposes: their role, and their Team Member profile (and whether it is active) if they have one. */
  private recipientFor(who: { role: Role; userId: string }, members?: Array<{ id: string; o: Record<string, unknown> }>): Recipient {
    const rows = members ?? this.memberRows();
    const m = who.userId === '' ? undefined : rows.find((x) => x.o.userId === who.userId);
    return { role: who.role === 'admin' ? 'admin' : 'user', memberId: m?.id ?? null, memberActive: m === undefined ? true : m.o.active !== false };
  }

  private notificationRows(): Array<{ id: string; def: NotificationDef }> {
    const out: Array<{ id: string; def: NotificationDef }> = [];
    for (const r of this.store.recordsOfKind('notification')) {
      try {
        const c = checkNotification(JSON.parse(r.json));
        if (c.ok) out.push({ id: r.id, def: c.value });
      } catch {
        /* an unreadable definition does not exist */
      }
    }
    return out;
  }

  /**
   * Create or change a definition. The fields come from the SV's request; everything about WHO did it is the server's: the actor's account id
   * is stamped here from the verified caller. Returns what happened so the Worker can write the right audit line.
   */
  async saveNotification(
    tenantId: string,
    input: { id?: string; fields: NotificationFields; actor: { userId: string; email: string } },
  ): Promise<{ ok: true; id: string; action: 'created' | 'updated' | 'enabled' | 'disabled' } | { ok: false; error: string }> {
    this.assertTenant(tenantId);
    if (this.frozen) return { ok: false, error: 'archived' };
    const now = new Date().toISOString();
    const prev = input.id === undefined ? undefined : this.notificationRows().find((r) => r.id === input.id)?.def;
    if (input.id !== undefined && prev === undefined) return { ok: false, error: 'notification_not_found' };
    const def: NotificationDef = {
      ...input.fields,
      id: prev?.id ?? `ntf_${crypto.randomUUID()}`,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      createdByUserId: prev?.createdByUserId ?? input.actor.userId,
      updatedByUserId: input.actor.userId,
    };
    const checked = checkNotification(def);
    if (!checked.ok) return { ok: false, error: checked.error };
    if (def.audience.kind === 'members') {
      const known = new Set(this.memberRows().map((m) => m.id));
      if (!(def.audience.memberIds ?? []).every((m) => known.has(m))) return { ok: false, error: 'notification_member_not_found' };
    }
    if (!this.commitServerChange('notification-save', [{ kind: 'notification', id: def.id, json: JSON.stringify(def) }], [], input.actor.email)) return { ok: false, error: 'failed' };
    const action = prev === undefined ? 'created' : prev.enabled !== def.enabled ? (def.enabled ? 'enabled' : 'disabled') : 'updated';
    return { ok: true, id: def.id, action };
  }

  async deleteNotification(tenantId: string, input: { id: string; actor: { email: string } }): Promise<{ ok: true; title: string } | { ok: false; error: string }> {
    this.assertTenant(tenantId);
    if (this.frozen) return { ok: false, error: 'archived' };
    const prev = this.notificationRows().find((r) => r.id === input.id);
    if (prev === undefined) return { ok: false, error: 'notification_not_found' };
    // Its acknowledgments go with it (they mean nothing without it).
    const acks = this.store.recordsOfKind('notificationAck').filter((r) => r.id.startsWith(`na_${input.id}_`)).map((r) => ({ kind: 'notificationAck' as const, id: r.id }));
    for (let i = 0; i < acks.length; i += 400) this.commitServerChange('notification-acks-removed', [], acks.slice(i, i + 400), input.actor.email);
    if (!this.commitServerChange('notification-delete', [], [{ kind: 'notification', id: input.id }], input.actor.email)) return { ok: false, error: 'failed' };
    return { ok: true, title: prev.def.title };
  }

  /**
   * One person closes one occurrence. Everything is decided here: the person is the authenticated caller, the definition must exist, be on and
   * address them, and the occurrence must be a real one that is already due by the SERVER's clock. Closing it again changes nothing.
   */
  async acknowledgeNotification(
    tenantId: string,
    input: { userId: string; role: Role; notificationId: string; occurrence: string; nowMs: number; email: string },
  ): Promise<{ ok: true; created: boolean } | { ok: false; error: 'notification_not_found' | 'not_addressed' | 'invalid_occurrence' | 'archived' | 'failed' }> {
    this.assertTenant(tenantId);
    if (this.frozen) return { ok: false, error: 'archived' };
    const def = this.notificationRows().find((r) => r.id === input.notificationId)?.def;
    if (def === undefined || !def.enabled) return { ok: false, error: 'notification_not_found' };
    if (!audienceIncludes(def.audience, this.recipientFor({ role: input.role, userId: input.userId }))) return { ok: false, error: 'not_addressed' };
    if (!isAckableOccurrence(def, input.occurrence, businessClock(input.nowMs))) return { ok: false, error: 'invalid_occurrence' };
    const id = ackId(def.id, input.occurrence, input.userId);
    if (this.store.recordsOfKind('notificationAck').some((r) => r.id === id)) return { ok: true, created: false };
    const ack: NotificationAck = { id, notificationId: def.id, occurrence: input.occurrence, userId: input.userId, at: new Date(input.nowMs).toISOString() };
    if (!this.commitServerChange('notification-ack', [{ kind: 'notificationAck', id, json: JSON.stringify(ack) }], [], input.email)) return { ok: false, error: 'failed' };
    this.maybeRunRetention(input.nowMs);
    return { ok: true, created: true };
  }

  /** Set or replace the workspace logo (validated again here, whatever the browser did). */
  async setBranding(tenantId: string, input: { mime: string; data: string; actor: { userId: string; email: string } }): Promise<{ ok: true; bytes: number } | { ok: false; error: string }> {
    this.assertTenant(tenantId);
    if (this.frozen) return { ok: false, error: 'archived' };
    const check = checkLogo(input.mime, input.data);
    if (!check.ok) return { ok: false, error: check.error };
    const record: BrandingRecord = { id: 'branding', mime: input.mime as BrandingRecord['mime'], data: input.data, bytes: check.bytes, updatedAt: new Date().toISOString(), updatedByUserId: input.actor.userId };
    return this.commitServerChange('branding-set', [{ kind: 'branding', id: 'branding', json: JSON.stringify(record) }], [], input.actor.email) ? { ok: true, bytes: check.bytes } : { ok: false, error: 'failed' };
  }

  async removeBranding(tenantId: string, input: { actor: { email: string } }): Promise<{ ok: true; removed: boolean } | { ok: false; error: string }> {
    this.assertTenant(tenantId);
    if (this.frozen) return { ok: false, error: 'archived' };
    if (!this.store.recordsOfKind('branding').some((r) => r.id === 'branding')) return { ok: true, removed: false };
    return this.commitServerChange('branding-remove', [], [{ kind: 'branding', id: 'branding' }], input.actor.email) ? { ok: true, removed: true } : { ok: false, error: 'failed' };
  }

  /** The days of meeting plans and notes this workspace keeps: its setting (90, 180, 365 or 730), else 365. */
  private planRetentionDays(): number {
    const row = this.store.recordsOfKind('settings').find((r) => r.id === 'settings');
    try {
      const days = row === undefined ? undefined : (JSON.parse(row.json) as { planRetentionDays?: unknown }).planRetentionDays;
      return typeof days === 'number' && (RETENTION_CHOICES as readonly number[]).includes(days) ? days : DEFAULT_PLAN_RETENTION_DAYS;
    } catch {
      return DEFAULT_PLAN_RETENTION_DAYS;
    }
  }

  /**
   * Housekeeping, at most once per business day (a stored date guards it; calling it again the same day does nothing and reads one flag):
   *  - meeting plans and notes dated before today minus the retention days are deleted (today and the future are never touched);
   *  - acknowledgments that can never matter again are deleted (old AND superseded; see shared/notifications.ts).
   * Test cases, projects, scopes, people and the administrative audit are never touched. Runs from the daily alarm, after a plan or an
   * acknowledgment is saved, and when an SV opens Meeting History. No cron product is involved.
   */
  private maybeRunRetention(nowMs: number): { ran: boolean; plans: number; notes: number; acks: number } {
    const clock = businessClock(nowMs);
    if (this.store.readFlag(RETENTION_FLAG) === clock.date) return { ran: false, plans: 0, notes: 0, acks: 0 };
    this.store.writeFlag(RETENTION_FLAG, clock.date); // first, so a second call (or a failure half way) never repeats the day's work
    const cutoff = retentionCutoff(clock.date, this.planRetentionDays());
    const stale = (kind: 'dailyPlan' | 'meetingNote'): Array<{ kind: RecordPut['kind']; id: string }> => {
      const out: Array<{ kind: RecordPut['kind']; id: string }> = [];
      for (const r of this.store.recordsOfKind(kind)) {
        try {
          const date = (JSON.parse(r.json) as { date?: unknown }).date;
          if (typeof date === 'string' && date < cutoff) out.push({ kind, id: r.id });
        } catch {
          /* leave what cannot be read */
        }
      }
      return out;
    };
    const plans = stale('dailyPlan');
    const notes = stale('meetingNote');
    const defs = new Map(this.notificationRows().map((r) => [r.id, r.def]));
    const acks: Array<{ kind: RecordPut['kind']; id: string }> = [];
    for (const r of this.store.recordsOfKind('notificationAck')) {
      try {
        const c = checkNotificationAck(JSON.parse(r.json));
        if (c.ok && ackIsPrunable(c.value, defs.get(c.value.notificationId), clock)) acks.push({ kind: 'notificationAck', id: r.id });
      } catch {
        /* leave what cannot be read */
      }
    }
    const all = [...plans, ...notes, ...acks];
    for (let i = 0; i < all.length; i += 400) this.commitServerChange('retention', [], all.slice(i, i + 400), 'retention');
    return { ran: true, plans: plans.length, notes: notes.length, acks: acks.length };
  }

  /** The once-a-day housekeeping, callable by the Worker (an SV opening Meeting History) and by tests with a controlled clock. */
  async runRetention(tenantId: string, nowMs: number = Date.now()): Promise<{ ran: boolean; plans: number; notes: number; acks: number }> {
    this.assertTenant(tenantId);
    if (this.frozen) return { ran: false, plans: 0, notes: 0, acks: 0 };
    return this.maybeRunRetention(nowMs);
  }

  // ---- RPC: reads --------------------------------------------------------------

  async exportAll(tenantId: string, role: Role = 'admin', userId?: string): Promise<{ revision: number; records: RecordPut[] }> {
    this.assertTenant(tenantId);
    const snap = this.store.snapshot();
    // An account the server cannot name gets nothing of Test Management (fail closed).
    return { revision: snap.revision, records: this.visibleFor({ role, userId: userId ?? '' }, snap.records) };
  }

  async listRevisions(tenantId: string, limit: number, before?: number, filter: RevisionFilter = {}): Promise<RevisionInfo[]> {
    this.assertTenant(tenantId);
    return this.store.listRevisions(limit, before, filter);
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
    // The links between Team Member profiles and accounts are not QA history: an older revision must not undo them.
    const links = this.store
      .recordsOfKind('member')
      .map((m) => ({ m, parsed: JSON.parse(m.json) as Record<string, unknown> }))
      .filter((x) => typeof x.parsed.userId === 'string');
    const result = this.store.restoreAsNewRevision(revision, actor, new Date().toISOString(), commitId);
    if (result === null) return { ok: false, error: 'revision-unavailable' };
    if (!result.ok) return { ok: false, error: result.reason };
    if (result.changed) {
      this.broadcast({ t: 'changes', revision: result.revision, actor, at: result.at, puts: result.puts, deletes: result.deletes });
    }
    let head = result.revision;
    if (links.length > 0) {
      const now = new Map(this.store.recordsOfKind('member').map((m) => [m.id, m]));
      const repair: RecordPut[] = [];
      for (const { m, parsed } of links) {
        const have = now.get(m.id);
        if (have === undefined) {
          repair.push(m);
          continue;
        }
        // What belongs to the ACCOUNT (the link, the email, the role, the active state) stays as it is now; the rest of the profile may go back.
        const restored = JSON.parse(have.json) as Record<string, unknown>;
        const next: Record<string, unknown> = { ...restored };
        for (const f of ACCOUNT_FIELDS) {
          if (parsed[f] === undefined) delete next[f];
          else next[f] = parsed[f];
        }
        if (JSON.stringify(next) !== JSON.stringify(restored)) repair.push({ kind: 'member', id: m.id, json: JSON.stringify(next) });
      }
      if (repair.length > 0 && this.commitServerChange('restore-keep-links', repair, [], actor)) head = this.store.revision();
    }
    return { ok: true, revision: head };
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
    this.maybeRunRetention(Date.now());
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

  /** What this person may receive: everything for an SV; for anyone else the SV-only kinds and unauthorised Test Management are removed. */
  private visibleFor<T extends { kind: string; id: string; json?: string }>(who: { role: Role; userId: string }, items: T[]): T[] {
    // Everybody, an SV too, receives only THEIR OWN notification acknowledgments (they name a person).
    let base = items.some((i) => i.kind === 'notificationAck') ? items.filter((i) => i.kind !== 'notificationAck' || i.id.endsWith(`_${who.userId}`)) : items;
    if (who.role === 'admin') return base;
    base = visibleTo(who.role, base).map((i) => redactMemberEmail(i, who.userId));
    // A Tester receives a notification definition only if it is switched on and addresses them.
    if (base.some((i) => i.kind === 'notification')) {
      const recipient = this.recipientFor(who);
      base = base.filter((i) => i.kind !== 'notification' || definitionReaches(i.json, recipient));
    }
    if (!base.some((i) => TM_KINDS.has(i.kind) || i.kind === 'assignment')) return base;
    return filterForTester(base, this.authorizedFor(who.userId), who.userId);
  }

  /** The same filtering for a change message: what to put, and what to delete (a definition that stopped addressing someone is deleted from their copy). */
  private viewFor(who: { role: Role; userId: string }, puts: RecordPut[], deletes: Array<{ kind: RecordPut['kind']; id: string }>): { puts: RecordPut[]; deletes: Array<{ kind: RecordPut['kind']; id: string }> } {
    const seen = this.visibleFor(who, puts);
    const kept = new Set(seen.map((p) => `${p.kind}\u0000${p.id}`));
    const hidden = who.role === 'admin' ? [] : puts.filter((p) => p.kind === 'notification' && !kept.has(`${p.kind}\u0000${p.id}`)).map((p) => ({ kind: p.kind, id: p.id }));
    const allowed = visibleTo(who.role, deletes).filter((d) => d.kind !== 'notificationAck' || d.id.endsWith(`_${who.userId}`));
    return { puts: seen, deletes: [...allowed, ...hidden] };
  }

  private authorizedFor(userId: string): Set<string> {
    if (userId === '') return new Set();
    return authorizedScopeIds(
      this.store.recordsOfKind('assignment').map((r) => r.json),
      this.store.recordsOfKind('scope').map((r) => r.json),
      userId,
      businessDate(),
    );
  }

  private broadcast(message: ChangesMessage, except?: WebSocket): void {
    const frames = new Map<string, string>();
    const perPerson = [...message.puts, ...message.deletes].some((r) => r.kind === 'notificationAck');
    const frameFor = (att: Attachment): string => {
      const shared = att.role === 'admin' && !perPerson;
      const key = shared ? 'admin' : `u:${att.role}:${att.userId}`;
      let f = frames.get(key);
      if (f === undefined) {
        f = JSON.stringify(shared ? message : { ...message, ...this.viewFor(att, message.puts, message.deletes) });
        frames.set(key, f);
      }
      return f;
    };
    // An assignment or a scope changed: what each Tester may read changed with it. They are sent the full authorised picture of Test
    // Management (what they may now see, and removal of everything else), which is idempotent for what they already have.
    const visibilityMoved = [...message.puts, ...message.deletes].some((r) => r.kind === 'assignment' || r.kind === 'scope');
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except) continue;
      try {
        // A revoked/expired Access session must stop receiving data immediately.
        const attachment = socket.deserializeAttachment() as Attachment | null;
        if (attachment === null || isExpired(attachment)) {
          socket.close(CLOSE_CODES.sessionExpired, 'session expired');
          continue;
        }
        socket.send(frameFor(attachment));
        if (visibilityMoved && attachment.role !== 'admin') this.resyncTester(socket, attachment, message.revision);
      } catch {
        // dead socket — ignored, it will be cleaned up by the runtime
      }
    }
  }

  /** Bring one Tester's Test Management view in line with their current assignments. */
  private resyncTester(socket: WebSocket, attachment: Attachment, revision: number): void {
    const auth = this.authorizedFor(attachment.userId);
    const all = this.store.snapshot().records.filter((r) => TM_KINDS.has(r.kind));
    const puts = all.filter((r) => testerMaySee(r, auth, attachment.userId));
    const deletes = all.filter((r) => !testerMaySee(r, auth, attachment.userId)).map((r) => ({ kind: r.kind, id: r.id }));
    if (puts.length === 0 && deletes.length === 0) return;
    this.send(socket, { t: 'changes', revision, actor: 'server', at: new Date().toISOString(), puts, deletes, catchUp: true });
  }
}

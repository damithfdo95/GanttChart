/**
 * WorkspaceStore — the shared workspace's storage and commit rules.
 *
 * Pure logic over a minimal SQL interface (no `cloudflare:workers` import), so
 * the SAME code runs inside the Durable Object (`ctx.storage.sql`) and in
 * unit tests (sql.js). All writes for one commit happen inside a single
 * synchronous transaction: records, history, revision row and metadata
 * either all commit or none do.
 *
 * Model (docs/CLOUD_ARCHITECTURE.md §5):
 *   records         current state, one row per (kind, id)
 *   record_history  append-only log; json NULL = deleted at that revision
 *   revisions       one row per commit (who / when / why / size)
 *   meta            history floor (written only when history is pruned)
 *
 * Write budget (Workers Free plan: 100,000 rows written per day, indexes
 * count): a single-record commit writes exactly 3 rows — records,
 * record_history, revisions — because the first two are WITHOUT ROWID tables
 * keyed directly (no second index entry), `revisions.rev` is the rowid, and
 * the revision counter is derived (MAX(rev)) instead of stored.
 */

import type { RecordDelete, RecordKind, RecordPut, RecordVersion } from '../../shared/protocol';

export type SqlValue = string | number | null | ArrayBuffer;

export interface SqlCursor<T> {
  toArray(): T[];
  one(): T;
}

/** The subset of `ctx.storage.sql` the store needs. */
export interface SqlLike {
  exec<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): SqlCursor<T>;
}

export interface StoreStorage {
  sql: SqlLike;
  transactionSync<T>(fn: () => T): T;
}

export interface CommitInput {
  /** Client commit id — repeating a commit that already succeeded returns the original result. */
  commitId: string;
  baseRevision: number;
  puts: RecordPut[];
  deletes: RecordDelete[];
  actor: string;
  reason: string;
  /** ISO timestamp (injected so tests are deterministic). */
  now: string;
  /**
   * Rules beyond "well-formed": references between records and who may change what. Called with the commit's
   * effective changes (no-ops already dropped) before anything is written; a string refuses the whole commit.
   */
  rules?: (view: { puts: RecordPut[]; deletes: RecordDelete[]; get: (kind: string, id: string) => string | null }) => string | null;
}

export type CommitResult =
  | {
      ok: true;
      revision: number;
      changed: boolean;
      /** True when this commit id had already been applied (a retry) — nothing new to broadcast. */
      duplicate: boolean;
      puts: RecordPut[];
      deletes: RecordDelete[];
      at: string;
    }
  | { ok: false; reason: 'conflict'; revision: number; conflicts: RecordVersion[] }
  | { ok: false; reason: 'stale'; revision: number }
  | { ok: false; reason: 'invalid'; revision: number; message: string };

export interface RevisionInfo {
  revision: number;
  committedAt: string;
  actor: string;
  reason: string;
  puts: number;
  deletes: number;
  summary: Array<{ kind: RecordKind; puts: number; deletes: number }>;
}

export type ChangesSince =
  | { kind: 'snapshot'; revision: number; records: RecordPut[] }
  | { kind: 'changes'; revision: number; puts: RecordPut[]; deletes: RecordDelete[] };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS records (
     kind TEXT NOT NULL,
     id   TEXT NOT NULL,
     json TEXT NOT NULL,
     rev  INTEGER NOT NULL,
     PRIMARY KEY (kind, id)
   ) WITHOUT ROWID`,
  // PK order (kind, id, rev) makes "latest revision of a key" an index seek.
  `CREATE TABLE IF NOT EXISTS record_history (
     kind TEXT NOT NULL,
     id   TEXT NOT NULL,
     rev  INTEGER NOT NULL,
     json TEXT,
     PRIMARY KEY (kind, id, rev)
   ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS revisions (
     rev              INTEGER PRIMARY KEY,
     committed_at     TEXT NOT NULL,
     actor            TEXT NOT NULL,
     reason           TEXT NOT NULL,
     puts             INTEGER NOT NULL,
     deletes          INTEGER NOT NULL,
     summary          TEXT NOT NULL,
     client_commit_id TEXT
   )`,
];

const META_FLOOR = 'history_floor';

/** A retried commit is recognised among this many most recent revisions (no index needed). */
const IDEMPOTENCY_WINDOW = 50;

type KeyRow = { kind: string; id: string };

function keyOf(kind: string, id: string): string {
  return `${kind}\u0000${id}`;
}

export class WorkspaceStore {
  constructor(private readonly storage: StoreStorage) {}

  /** Create tables (idempotent). Call once from the DO constructor. */
  init(): void {
    // Reads only once the schema exists: this runs on every wake from hibernation.
    for (const statement of SCHEMA) this.storage.sql.exec(statement);
  }

  /** Small string flags kept with the workspace (e.g. "frozen" while archived). Written rarely. */
  readFlag(key: string): string | null {
    const row = this.storage.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, `flag:${key}`).toArray()[0];
    return row === undefined ? null : row.value;
  }

  writeFlag(key: string, value: string | null): void {
    if (value === null) this.storage.sql.exec(`DELETE FROM meta WHERE key = ?`, `flag:${key}`);
    else this.storage.sql.exec(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, `flag:${key}`, value);
  }

  private metaNumber(key: string): number {
    const row = this.storage.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key).toArray()[0];
    return row === undefined ? 0 : Number(row.value);
  }

  private setMeta(key: string, value: number): void {
    this.storage.sql.exec(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, String(value));
  }

  /** Current committed revision (0 = empty workspace). */
  revision(): number {
    const row = this.storage.sql.exec<{ m: number | null }>(`SELECT MAX(rev) AS m FROM revisions`).toArray()[0];
    return row?.m ?? 0;
  }

  /** Oldest revision whose full state / deltas are still reconstructable. */
  historyFloor(): number {
    return this.metaNumber(META_FLOOR);
  }

  /** Every current record. */
  snapshot(): { revision: number; records: RecordPut[] } {
    const rows = this.storage.sql.exec<{ kind: RecordKind; id: string; json: string }>(`SELECT kind, id, json FROM records ORDER BY kind, id`).toArray();
    return { revision: this.revision(), records: rows.map((r) => ({ kind: r.kind, id: r.id, json: r.json })) };
  }

  /**
   * What a client at `since` is missing. Falls back to a full snapshot when
   * history older than `since` has been pruned (or the client claims a
   * revision from the future, e.g. after a server restore).
   */
  changesSince(since: number): ChangesSince {
    const head = this.revision();
    if (since > head || since < this.historyFloor()) {
      const snap = this.snapshot();
      return { kind: 'snapshot', revision: snap.revision, records: snap.records };
    }
    if (since === head) return { kind: 'changes', revision: head, puts: [], deletes: [] };
    // Latest change per key after `since`.
    const rows = this.storage.sql
      .exec<{ kind: RecordKind; id: string; json: string | null }>(
        `SELECT h.kind AS kind, h.id AS id, h.json AS json
           FROM record_history h
           JOIN (SELECT kind, id, MAX(rev) AS m FROM record_history WHERE rev > ? GROUP BY kind, id) x
             ON h.kind = x.kind AND h.id = x.id AND h.rev = x.m
          ORDER BY h.kind, h.id`,
        since,
      )
      .toArray();
    const puts: RecordPut[] = [];
    const deletes: RecordDelete[] = [];
    for (const r of rows) {
      if (r.json === null) deletes.push({ kind: r.kind, id: r.id });
      else puts.push({ kind: r.kind, id: r.id, json: r.json });
    }
    return { kind: 'changes', revision: head, puts, deletes };
  }

  private latestRevOfKey(kind: string, id: string): number {
    const row = this.storage.sql
      .exec<{ m: number | null }>(`SELECT MAX(rev) AS m FROM record_history WHERE kind = ? AND id = ?`, kind, id)
      .toArray()[0];
    return row?.m ?? 0;
  }

  private currentJson(kind: string, id: string): string | null {
    const row = this.storage.sql.exec<{ json: string }>(`SELECT json FROM records WHERE kind = ? AND id = ?`, kind, id).toArray()[0];
    return row === undefined ? null : row.json;
  }

  /**
   * Apply one commit atomically.
   *
   * Accepted iff no touched record changed after `baseRevision` (per-record
   * optimistic concurrency). No-op puts (identical JSON) and deletes of
   * records that do not exist are dropped; a commit that ends up empty
   * creates no revision.
   */
  commit(input: CommitInput): CommitResult {
    return this.storage.transactionSync(() => this.applyCommit(input));
  }

  /** The commit rules WITHOUT a transaction wrapper — callers must already be inside one. */
  private applyCommit(input: CommitInput): CommitResult {
    {
      const head = this.revision();

      // Idempotent retry: this commit id already produced a revision.
      const prior = this.storage.sql
        .exec<{ rev: number }>(
          `SELECT rev FROM revisions WHERE rev > ? AND client_commit_id = ?`,
          Math.max(0, head - IDEMPOTENCY_WINDOW),
          input.commitId,
        )
        .toArray()[0];
      if (prior !== undefined) {
        return { ok: true as const, revision: prior.rev, changed: true, duplicate: true, puts: [], deletes: [], at: input.now };
      }

      if (input.baseRevision > head || input.baseRevision < this.historyFloor()) {
        return { ok: false as const, reason: 'stale' as const, revision: head };
      }

      // Per-record conflict detection against the append-only history.
      const conflicts: RecordVersion[] = [];
      const touched: KeyRow[] = [...input.puts, ...input.deletes];
      for (const t of touched) {
        if (this.latestRevOfKey(t.kind, t.id) > input.baseRevision) {
          conflicts.push({ kind: t.kind as RecordKind, id: t.id, json: this.currentJson(t.kind, t.id) });
        }
      }
      if (conflicts.length > 0) return { ok: false as const, reason: 'conflict' as const, revision: head, conflicts };

      // Drop no-ops.
      const puts = input.puts.filter((p) => this.currentJson(p.kind, p.id) !== p.json);
      const deletes = input.deletes.filter((d) => this.currentJson(d.kind, d.id) !== null);
      if (puts.length + deletes.length === 0) {
        return { ok: true as const, revision: head, changed: false, duplicate: false, puts: [], deletes: [], at: input.now };
      }

      if (input.rules !== undefined) {
        const problem = input.rules({ puts, deletes, get: (kind, id) => this.currentJson(kind, id) });
        if (problem !== null) return { ok: false as const, reason: 'invalid' as const, revision: head, message: problem };
      }

      const rev = head + 1;
      for (const p of puts) {
        this.storage.sql.exec(
          `INSERT INTO records (kind, id, json, rev) VALUES (?, ?, ?, ?)
             ON CONFLICT(kind, id) DO UPDATE SET json = excluded.json, rev = excluded.rev`,
          p.kind,
          p.id,
          p.json,
          rev,
        );
        this.storage.sql.exec(`INSERT INTO record_history (rev, kind, id, json) VALUES (?, ?, ?, ?)`, rev, p.kind, p.id, p.json);
      }
      for (const d of deletes) {
        this.storage.sql.exec(`DELETE FROM records WHERE kind = ? AND id = ?`, d.kind, d.id);
        this.storage.sql.exec(`INSERT INTO record_history (rev, kind, id, json) VALUES (?, ?, ?, NULL)`, rev, d.kind, d.id);
      }

      const perKind = new Map<string, { kind: RecordKind; puts: number; deletes: number }>();
      for (const p of puts) {
        const e = perKind.get(p.kind) ?? { kind: p.kind, puts: 0, deletes: 0 };
        e.puts += 1;
        perKind.set(p.kind, e);
      }
      for (const d of deletes) {
        const e = perKind.get(d.kind) ?? { kind: d.kind, puts: 0, deletes: 0 };
        e.deletes += 1;
        perKind.set(d.kind, e);
      }
      this.storage.sql.exec(
        `INSERT INTO revisions (rev, committed_at, actor, reason, puts, deletes, summary, client_commit_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        rev,
        input.now,
        input.actor,
        input.reason,
        puts.length,
        deletes.length,
        JSON.stringify([...perKind.values()]),
        input.commitId,
      );
      return { ok: true as const, revision: rev, changed: true, duplicate: false, puts, deletes, at: input.now };
    }
  }

  /** The current JSON of the project with this STABLE project id ("PRJ-001"), or null. Projects are few; a scan is fine. */
  findProjectByStableId(stableId: string): { id: string; json: string } | null {
    const rows = this.storage.sql.exec<{ id: string; json: string }>(`SELECT id, json FROM records WHERE kind = 'project'`).toArray();
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.json) as { projectId?: unknown };
        if (parsed.projectId === stableId) return row;
      } catch {
        /* an unreadable record is simply not a match */
      }
    }
    return null;
  }

  /** Newest-first list of retained revisions (metadata only). */
  listRevisions(limit = 100, before?: number): RevisionInfo[] {
    const rows = this.storage.sql
      .exec<{ rev: number; committed_at: string; actor: string; reason: string; puts: number; deletes: number; summary: string }>(
        `SELECT rev, committed_at, actor, reason, puts, deletes, summary FROM revisions
          WHERE rev < ? ORDER BY rev DESC LIMIT ?`,
        before ?? Number.MAX_SAFE_INTEGER,
        Math.min(Math.max(1, limit), 500),
      )
      .toArray();
    return rows.map((r) => ({
      revision: r.rev,
      committedAt: r.committed_at,
      actor: r.actor,
      reason: r.reason,
      puts: r.puts,
      deletes: r.deletes,
      summary: JSON.parse(r.summary) as RevisionInfo['summary'],
    }));
  }

  /** Full workspace state as of `revision`; null when pruned or from the future. */
  reconstruct(revision: number): RecordPut[] | null {
    if (revision < this.historyFloor() || revision > this.revision()) return null;
    const rows = this.storage.sql
      .exec<{ kind: RecordKind; id: string; json: string }>(
        `SELECT h.kind AS kind, h.id AS id, h.json AS json
           FROM record_history h
           JOIN (SELECT kind, id, MAX(rev) AS m FROM record_history WHERE rev <= ? GROUP BY kind, id) x
             ON h.kind = x.kind AND h.id = x.id AND h.rev = x.m
          WHERE h.json IS NOT NULL
          ORDER BY h.kind, h.id`,
        revision,
      )
      .toArray();
    return rows.map((r) => ({ kind: r.kind, id: r.id, json: r.json }));
  }

  /**
   * Restore the workspace to its state at `target` as a NEW revision (history
   * stays append-only). Returns the commit result, or null if `target` is not
   * reconstructable.
   */
  restoreAsNewRevision(target: number, actor: string, now: string, commitId: string): CommitResult | null {
    const state = this.reconstruct(target);
    if (state === null) return null;
    return this.storage.transactionSync(() => {
      const head = this.revision();
      const wanted = new Map(state.map((r) => [keyOf(r.kind, r.id), r]));
      const current = this.snapshot().records;
      const puts: RecordPut[] = [];
      const deletes: RecordDelete[] = [];
      for (const r of wanted.values()) if (this.currentJson(r.kind, r.id) !== r.json) puts.push(r);
      for (const c of current) if (!wanted.has(keyOf(c.kind, c.id))) deletes.push({ kind: c.kind, id: c.id });
      return this.applyCommit({ commitId, baseRevision: head, puts, deletes, actor, reason: `restore:${target}`, now });
    });
  }

  /**
   * Retention: forget history older than `cutoffIso`, keeping the state at the
   * new floor reconstructable. Returns the new floor (unchanged when nothing
   * is old enough).
   */
  prune(cutoffIso: string): number {
    return this.storage.transactionSync(() => {
      const row = this.storage.sql
        .exec<{ r: number | null }>(`SELECT MAX(rev) AS r FROM revisions WHERE committed_at < ?`, cutoffIso)
        .toArray()[0];
      const floor = row?.r ?? 0;
      if (floor <= this.historyFloor()) return this.historyFloor();
      // Keep only the newest row per key at or below the floor (the baseline);
      // drop baseline tombstones, they carry no state.
      this.storage.sql.exec(
        `DELETE FROM record_history
          WHERE rev <= ?
            AND (rev, kind, id) NOT IN (
                  SELECT m, kind, id FROM (
                    SELECT MAX(rev) AS m, kind, id FROM record_history WHERE rev <= ? GROUP BY kind, id))`,
        floor,
        floor,
      );
      this.storage.sql.exec(`DELETE FROM record_history WHERE rev <= ? AND json IS NULL`, floor);
      this.storage.sql.exec(`DELETE FROM revisions WHERE rev < ?`, floor);
      this.setMeta(META_FLOOR, floor);
      return floor;
    });
  }
}

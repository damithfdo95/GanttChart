# Local Database (IndexedDB) — V6.6 Storage Migration + V6.7 Integrity, Revisioning & Recovery + V6.8 Revision History & Point-in-Time Recovery

GanttChart persists all application data **locally in the browser**. Since the
V6.6 storage migration the primary persistence backend is **IndexedDB**;
`localStorage` (the pre-V6.6 backend) is retained as a fallback/recovery copy
with explicit revision tracking. Since V6.7 every committed workspace carries
a monotonic **revision**, structural **integrity** is verified on every
commit, and fallback/recovery is deterministic — a stale local copy can never
silently roll the user backward. Since V6.8 every successful commit also
leaves durable **revision-history evidence** (an append-only local change
journal with full workspace snapshots), historical revisions can be
reconstructed, and users can explicitly **restore** a previous valid state
without destroying newer history. There is no server, no network persistence,
no telemetry — the journal is intentionally local and is the designed
foundation for a possible future external synchronization layer.

## Where is the data?

| Backend | Role |
| --- | --- |
| IndexedDB database `GanttChartDB` | **Primary** persistence (all workspace data + persistence manifest + revision journal) |
| `localStorage` keys (`ganttchart.*`) | Fallback copy + revision bookkeeping + clear-all tombstone + recovery snapshots (never the journal) |
| Exported JSON backups | Portable full/workspace/project backups (`kind: 'backup'`) and history backups (`kind: 'history-backup'`), independent of IndexedDB |

## Database

- **Name:** `GanttChartDB`
- **IndexedDB schema version:** `2` (v1: original V6.6 stores; v2 adds the `revisionHistory` journal store — an additive upgrade that never touches existing data)
- **Object stores:**

| Store | Key | Contents |
| --- | --- | --- |
| `projects` | `id` (keyPath) | One record per portfolio project (full `ProjectRecord`, snapshots stripped) |
| `reports` | `id` (keyPath) | Daily reports (incl. frozen snapshots and activities) |
| `dailyActuals` | `projectId::id` (out-of-line composite) | V6.5 execution-history snapshot rows (`{...snapshot, projectId, order}`) |
| `attendance` | `id` (keyPath) | Attendance records (workspace level) |
| `topics` | `id` (keyPath) | Daily topics (workspace level) |
| `metadata` | string keys (out-of-line) | `appState`, `reportsCore`, workspace collections, `persistenceMeta` (the V6.7 manifest), `storageMigration` (the V6.6 migration marker) |
| `revisionHistory` | `revision` (keyPath) | **V6.8** — the append-only revision journal (one record per committed revision) |

- **Indexes:** `projectId` on `projects`, `reports` and `dailyActuals`.

The mapping between the domain workspace (AppState + ReportsState) and these
records lives in exactly one place: `src/lib/storage/db/workspace.ts`.

## Workspace revision (V6.7)

- **What it is:** a monotonic counter of successful canonical workspace
  commits. Revision 1 is established at migration (an existing valid
  localStorage revision is preserved, never reset). Every successful save
  increments it by exactly one.
- **Where it lives:** in the persistence manifest — `metadata.persistenceMeta`:

  ```ts
  {
    schemaVersion: 1,          // MANIFEST format version (PERSISTENCE_SCHEMA_VERSION)
    revision: 42,              // workspace revision
    committedAt: '<ISO>',      // commit timestamp (diagnostics; ordering is by revision)
    lastSavedAt: 1730000000000, // UX last-saved epoch ms (kept from V6.6)
    backend: 'indexeddb',      // backend that committed this revision
    integrityStatus: 'verified' | 'warning' | 'failed',
    lastMigrationAt?: '<ISO>',
    lastRecoveryAt?: '<ISO>',
  }
  ```

- **Atomicity:** the manifest is appended to the same write plan as the
  workspace records and committed in ONE IndexedDB transaction — revision and
  state can never disagree after a successful commit. A failed write advances
  nothing.
- **What it does NOT mean:** it is not the IndexedDB schema version, not the
  application data schema version, and not a per-project counter. It is
  global to the workspace. Timestamps are stored for humans, never for
  ordering.

Three separate concepts — never conflate them:
`IndexedDB schema version` (object-store layout) ≠ `application data schema
versions` (localStorage key versions, reports `schemaVersion`, backup
`version`, manifest `schemaVersion`) ≠ `workspace revision` (commit ordering).

## Integrity (V6.7)

`src/lib/storage/db/integrity.ts` — a pure, diagnostic-only structural
checker over the canonical workspace:

- **Projects:** duplicate record ids, duplicate stable ids, malformed
  records, active project pointing at a missing project (warning).
- **Reports:** duplicate ids, malformed records, orphaned project references
  (warning — evidence is preserved, never deleted or re-attached).
- **Daily actuals:** duplicate snapshot ids within a project, malformed
  records, orphaned store rows (warning).
- **Attendance / topics:** duplicate ids, malformed records.
- **Metadata/manifest:** invalid revision, invalid schema version, malformed
  or impossible manifest states.
- **Identity data:** duplicate member/assignment/review/external-identity
  ids, broken member/project references (warnings — never repaired or
  inferred).

The checker never mutates data and diagnostic messages reference record ids
only, never user content. Results are structured
(`{status: 'verified'|'warning'|'failed', issues: [{code, category, severity,
store, recordId, message}]}`).

**When it runs:** every save verifies the in-memory workspace plus the
prospective manifest before committing — a `failed` result blocks the commit
entirely (nothing written, revision not advanced); a `warning` commits with
`integrityStatus: 'warning'` recorded. Migration additionally gates on
integrity before writing, and the migration marker is only written after
data write + revision write + integrity verification + reassembly
verification all succeed.

## localStorage fallback & revision comparison (V6.7)

While IndexedDB is authoritative, localStorage keeps:

- the pre-migration workspace copy (`ganttchart.v2` / `ganttchart.reports.v1`),
- the **fallback record** `ganttchart.fallback.v1`:
  `{ revision: <copy's revision>, authoritativeRevision: <last revision known committed to IndexedDB>, committedAt }`.

After every IndexedDB commit the fallback record is updated with the new
`authoritativeRevision` (a tiny metadata write — the full workspace copy is
NOT re-written on every change). While localStorage is the live backend
(fallback mode), both revisions advance together — the copy is current.

**Comparison rule:** the localStorage copy is *current* when
`revision === authoritativeRevision` and stale when
`authoritativeRevision > revision`. The workspace with the highest committed
revision is authoritative; ties go to IndexedDB.

## Recovery (V6.7)

Startup states (`PersistenceHealth`):

| State | Meaning |
| --- | --- |
| `healthy` | IndexedDB loaded normally — authoritative |
| `fresh` | Nothing committed yet (first run / intentional clear-all) |
| `fallback-current` | IndexedDB unavailable, localStorage copy is known-current — usable fallback |
| `recovery-required` | IndexedDB unavailable/corrupt AND the local copy is stale — loaded as best-available data, clearly surfaced, never silently treated as current; commits continue from the last known revision |
| `recovered` | A newer localStorage workspace was promoted forward into the database with a new revision (never a rollback) |
| `recovery-stash` | Both sources unreadable — existing V6.3 corruption-stash path |

### Unexpected database loss

```
IndexedDB deleted (revision 20) → localStorage copy is revision 15
startup: no marker, localStorage keys, fallback record {revision: 15, authoritativeRevision: 20}
→ stale detected → NO migration, NO rollback
→ recovery-required: stale copy loaded as best-available data, preserved verbatim,
  banner: "The local database is unavailable. A previous local copy exists,
  but it may not contain your latest changes."
→ further saves continue from revision 20 (monotonic)
```

### Corruption

IndexedDB records unreadable → same decision tree (fallback-current or
recovery-required depending on the record); the database is quarantined —
a stale copy never overwrites it. Both corrupt → recovery-stash defaults +
V6.3 corruption banner with export option.

### Recovery snapshots

`ganttchart.recoverySnapshot.v1.<id>` — full workspace copies taken at
meaningful lifecycle events only (never per keystroke), capped at 5:
`{id, createdAt, source, revision, reason, appState, reportsState}` with
reasons `clear-all | import-replacement | migration-failure | integrity-failure | fallback | manual`.
They are restored only through explicit user action.

### Clear-all tombstone (intentional deletion)

`Clear All Local Data`:
1. creates a `clear-all` recovery snapshot of the current workspace,
2. removes every GanttChart localStorage key and older snapshots, removes the fallback record,
3. closes and deletes `GanttChartDB`,
4. writes the tombstone `ganttchart.cleared.v1 = {clearedAt, previousRevision}` — it SURVIVES the clear.

```
tombstone + empty IndexedDB = intentional empty workspace
→ old localStorage data is never re-migrated/resurrected
```

**Tombstone lifecycle:** removed automatically once a new workspace revision
commits to IndexedDB (fresh data after a clear supersedes the marker), and by
explicit import/recovery. A later explicit import or snapshot recovery
restores data normally.

## Revision journal (V6.8)

`src/lib/storage/db/journal.ts`, `diff.ts`, `revisionHistory.ts` — the durable
append-only local change history. Every **successful** canonical workspace
commit receives exactly one journal record in the `revisionHistory` store,
written in the SAME IndexedDB transaction as the workspace records and the
manifest:

```ts
{
  schemaVersion: 1,                 // JOURNAL_SCHEMA_VERSION
  revision: 42,                     // == manifest.revision of that commit (single counter, §7)
  committedAt: '<ISO>',
  reason: 'edit',                   // controlled union, see below
  affectedProjectIds: ['PRJ-001'],  // stable Project IDs
  restoredFromRevision?: 40,        // only on reason='recovery'
  changeSummary: { ... } | null,     // null on anchor entries (initial/migration)
  integrityStatus: 'verified' | 'warning',
  snapshot: { appState, reportsState }, // full verbatim workspace at that revision
}
```

**Reasons** (controlled union, never free-form): `initial`, `edit`,
`project-created`, `project-deleted`, `report-created`, `report-updated`,
`report-deleted`, `attendance-updated`, `topic-updated`, `identity-updated`,
`import`, `recovery`, `migration`, `clear-all`, `system`. Normal saves are
classified deterministically from the workspace diff; lifecycle operations
(restore/import) pass their reason explicitly.

### Revision semantics

- The **manifest remains the single authoritative revision counter**; journal
  entries simply mirror it. There is no second counter.
- Revision is **not** a timestamp, **not** a user-action id, and **not**
  per-project — it is global monotonic commit ordering.
- **Failed transactions create no history**: an aborted/failed save advances
  neither the manifest nor the journal; the next successful save continues
  the sequence (no durable gaps from failures).
- A no-op save (unchanged records) creates no revision and no entry.

### Change summaries (deterministic domain diff)

`diff.ts` compares the **previous canonical persisted state** with the next
one — never UI events. It reports project/report create/update/delete lists,
snapshot/attendance/topic/identity/assignment/review change flags, and splits
AppState changes into execution/planning/settings groups. The same two states
always produce the same summary. Persistence internals (mirrors, manifest
bookkeeping, fallback records) are invisible to the diff.

### Reconstruction & restore

- **Design (confirmed):** every retained revision stores a **full verbatim
  workspace snapshot**. Restoration is exact — V6.4 granular execution
  numbers, V6.5 legacy snapshot unknown fields (missing granular values stay
  missing, never inferred) and V6.9-B identity data all survive bit-for-bit.
  Growth is bounded by retention instead of delta complexity.
- `reconstructRevision(n)` validates the stored snapshot with the existing
  `isAppState`/`isReportsState` + integrity guards and returns the state
  without recomputing anything. Pruned/invalid revisions return typed errors
  (`pruned` / `not-found` / `invalid`).
- **Restore is an explicit user action** (Settings → Revision History →
  confirm). `createRestoreRevision(n)` creates a NEW revision (N+1) whose
  state equals revision N, records `reason: 'recovery'` with
  `restoredFromRevision: n`, and **never deletes newer history** — history is
  append-only. The restore commit goes through the same serialized save queue
  as every other save.

### Retention & compaction

The latest **100** revisions are retained (`REVISION_HISTORY_RETENTION`).
Pruning runs after each successful commit in its own transaction (failure is
harmless — the next commit retries) and never deletes the current revision.
Because every entry is a full snapshot there are no deltas and no compaction
correctness risk: pruning simply removes the oldest entries, and restoring a
pruned revision reports it as clearly unavailable. Journal integrity allows
strictly-ascending unique revisions with gaps (pruning removes the oldest
end; a history import may create interior gaps).

### Journal integrity

`verifyJournalIntegrity` extends the V6.7 integrity system: revision
validity, monotonic ordering, duplicate detection, and the manifest↔journal
cross-check. Mismatches are **reported, never silently rewritten**:

- manifest ahead of journal → `journal.behind-manifest` (history degraded)
- journal ahead of manifest → `journal.ahead-of-manifest` (integrity attention)
- current revision missing from the journal → `journal.missing-current`

When the current workspace is valid but the journal is damaged, the app keeps
working normally and diagnostics report `History Integrity: Warning`.

### V6.7 → V6.8 migration (adoption anchor)

On startup, a database whose journal is **completely empty** (a V6.7
installation adopting V6.8) receives ONE anchor entry at its CURRENT manifest
revision with `reason: 'migration'` and the current known workspace — the
existing revision number is preserved, never reset, and no historical change
events before the adoption point are fabricated (they were never stored). A
non-empty journal that is behind the manifest is degraded and reported — it
is never auto-repaired to make the numbers match.

## Recovery with history (V6.8)

The V6.7 startup decision tree is unchanged, with one addition: when the
current workspace records are unreadable/invalid but the journal holds valid
snapshots, and the journal's latest valid revision is NEWER than the retained
localStorage copy (or no usable copy exists), the app boots with the journal
snapshot as best-available data, flagged `recovery-required` — never silently
current, never auto-committed. The user then restores explicitly. A corrupt
localStorage payload keeps the existing V6.3 recovery-stash path (evidence
preserved). Manifest corruption is never auto-fabricated: the journal may
inform the newest known revision so numbering never moves backwards, but a
new manifest only exists after the next successful commit.

Clear-all destroys the journal together with the intentionally deleted
database — the tombstone and the pre-clear recovery snapshot prevent
accidental resurrection, and a fresh journal starts at revision 1
(`initial`). `localStorage` never receives journal data; the fallback remains
a current/best-available workspace copy whose staleness detection is
unchanged.

## History backup (V6.8)

`kind: 'history-backup'` (in addition to the unchanged `kind: 'backup'`
current-state format): the current normalized state plus the retained journal
entries, with no IndexedDB internals (no store names, database ids,
transaction ids or internal keys). Import: `JSON → parse (every entry
strictly validated, strictly ascending) → install journal entries → persist
the imported current state as a new revision (reason 'import')`. Revision
numbering continues from the larger of the current and imported heads so the
manifest/journal pair converges monotonically.

## Future external synchronization (deliberate boundary)

The journal is intentionally shaped so a future external adapter could ask
"give me the changes after revision N" (`getRevisionsAfter`) — but **no
external synchronization exists in V6.8** (no JIRA, no APIs, no network).
V6.8 remains 100% local.

## Backup

Backups are built from the canonical in-memory state and contain no
IndexedDB internals (object stores/keys never appear in the JSON). Imports
follow `JSON → parse → validate → normalize → canonical state → persist
through the normal save queue` — each successful import results in a new
committed workspace revision, and a failed import leaves the current
workspace intact.

## Architecture

```
React / Features
      │
App State Layer (state-contexts.tsx)
      │
Persistence API (lib/storage/db/*)
      │  repository.ts    open/upgrade/CRUD (schema v2: + revisionHistory)
      │  workspace.ts     domain ↔ record split/assemble
      │  workspaceIo.ts   read + diffed atomic write plans (+ journal put)
      │  manifest.ts      revision/manifest model
      │  journal.ts       V6.8 journal record types + validation
      │  diff.ts          V6.8 deterministic domain diff
      │  revisionHistory.ts  V6.8 query/reconstruct/retention/integrity
      │  integrity.ts     structural integrity checker
      │  recovery.ts      fallback record, tombstone, snapshots
      │  migration.ts     localStorage → IndexedDB migration
      │  persistenceBackend.ts  queue, save, restore, journal, clear-all, diagnostics
      │  bootstrap.ts     startup decision tree (+ V6.8 anchor / journal recovery)
      ▼
GanttChartDB (primary)  +  localStorage (fallback/recovery artifacts)
```

React components never touch IndexedDB; everything flows through
`persistWorkspaceAsync` / `initPersistence` / `clearAllLocalDataAsync` /
`getStorageDiagnostics`.

## Adding a future database schema version

1. Bump `DB_VERSION` in `src/lib/storage/db/repository.ts`.
2. Add a step to `upgradeSchema()` guarded by the previous version. Create
   stores/indexes only when missing; never delete stores holding user data
   unless the step explicitly preserves their contents.
3. Application-level data migrations stay in the existing V6.3
   validation/normalization layer — raw records are normalized after loading.
4. The manifest (`PERSISTENCE_SCHEMA_VERSION`) changes only when the
   manifest *format* changes — bump it and extend `parseManifest`/`buildManifest`
   accordingly; old manifests parse to null and the revision counter starts
   from the stored records.

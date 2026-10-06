/**
 * IndexedDB persistence backend (V6.6 §16–§25, V6.7 §2–§6).
 *
 * The V6.3 persistence API keeps its shape but its underlying
 * implementation becomes IndexedDB after the startup migration:
 *
 *   V6.3:  writePersistedWorkspace() → localStorage (still the fallback)
 *   V6.6:  persistWorkspaceAsync()  → IndexedDB (primary)
 *
 * Writes are asynchronous and serialized through an ordered queue: the
 * latest application state always wins and an older state can never commit
 * after a newer one. Saves are diffed against the last-written mirror —
 * unchanged records are not written at all. Save failures never touch the
 * in-memory state.
 *
 * V6.7 adds workspace revisioning: every successful commit advances a
 * monotonic revision recorded in the persistence manifest, written in the
 * SAME transaction as the workspace records (revision and state can never
 * disagree). Failed writes do not advance the committed revision, and a
 * workspace whose integrity check fails is not committed at all. After each
 * IndexedDB commit the localStorage fallback record is updated so a stale
 * fallback is always detectable.
 */

import type { AppState, ReportsState } from '../../../types';
import { isAppState, normalizeAppState, DEMO_STATE } from '../storage';
import { isReportsState, normalizeReportsState, defaultReportsState } from '../reports';
import { clearAllPersistence, readPersistenceMeta, writePersistedWorkspace } from '../persistence';
import {
  DB_NAME,
  META_KEY_PERSISTENCE_META,
  STORE_METADATA,
  closeGanttChartDb,
  deleteGanttChartDb,
  getFromStore,
  isGanttChartDbOpen,
  isIndexedDbAvailable,
  openGanttChartDb,
} from './repository';
import { readStorageMigrationRecord, type StorageMigrationRecord } from './migration';
import {
  appendJournalPut,
  appendMetadataPut,
  applyWorkspaceWritePlan,
  mirrorFromRead,
  mirrorFromWorkspace,
  planWorkspaceWrite,
  readWorkspaceFromDb,
  type WorkspaceMirror,
  type WorkspaceDbRead,
} from './workspaceIo';
import { assembleReportsState } from './workspace';
import { buildManifest, parseManifest, type IntegrityStatus, type PersistenceManifest } from './manifest';
import { verifyWorkspaceIntegrity } from './integrity';
import { buildRevisionEntry, JOURNAL_SCHEMA_VERSION, type RevisionReason, type WorkspaceRevision } from './journal';
import { diffWorkspaces, type CanonicalWorkspace } from './diff';
import {
  getRevisionsAfter,
  readJournalIntegrity,
  reconstructRevision,
  pruneRevisionHistory,
  replaceJournalEntries,
  REVISION_HISTORY_RETENTION,
} from './revisionHistory';
import {
  clearClearAllTombstone,
  clearMigrationFailureRecord,
  createRecoverySnapshot,
  listRecoverySnapshots,
  readClearAllTombstone,
  readLocalFallbackRecord,
  removeLocalFallbackRecord,
  removeRecoverySnapshot,
  writeClearAllTombstone,
  writeLocalFallbackRecord,
} from './recovery';

export type PersistenceBackendMode = 'indexeddb' | 'localstorage';

/** Overall persistence/recovery state (V6.7 §7). */
export type PersistenceHealth = 'healthy' | 'fresh' | 'fallback-current' | 'recovery-required' | 'recovered' | 'recovery-stash';

/** Explicit commit intent for the revision journal (V6.8 §12). */
export interface PersistOptions {
  /** Controlled reason recorded in the journal; defaults to the diff-classified domain reason. */
  reason?: RevisionReason;
  /** Only for reason='recovery': the revision whose state is being restored. */
  restoredFrom?: number;
  /** Force a new revision even when the record plan is unchanged (restore/import of identical state). */
  forceRevision?: boolean;
}

export interface WorkspacePersistResult {
  ok: boolean;
  changed: boolean;
  lastSavedAt: number | null;
  /** Committed workspace revision (unchanged when the save failed). */
  revision: number;
  integrityStatus: IntegrityStatus;
}

export type WorkspaceLoadResult =
  | { ok: true; app: AppState; reports: ReportsState; empty: boolean; read: WorkspaceDbRead }
  | { ok: false };

let activeMode: PersistenceBackendMode = 'localstorage';
let mirror: WorkspaceMirror | null = null;
let migrationRecord: StorageMigrationRecord | null = null;
let lastSavedAt: number | null = null;
/** Last committed workspace revision (0 = nothing committed yet). */
let currentRevision = 0;
/** Revision of the full workspace copy held in localStorage (0 = none). */
let fallbackCopyRevision = 0;
let manifest: PersistenceManifest | null = null;
let health: PersistenceHealth = 'fresh';
/** Previous canonical persisted state — the deterministic diff baseline (V6.8 §9). */
let lastCommittedWorkspace: CanonicalWorkspace | null = null;

export function getPersistenceMode(): PersistenceBackendMode {
  return activeMode;
}

export function getMigrationRecord(): StorageMigrationRecord | null {
  return migrationRecord;
}

export function getLastSavedAtSync(): number | null {
  return lastSavedAt;
}

/** Current committed workspace revision (V6.7 §2). */
export function getWorkspaceRevision(): number {
  return currentRevision;
}

export function getPersistenceHealth(): PersistenceHealth {
  return health;
}

/** Override the persistence health (used by the bootstrap promotion path). */
export function setPersistenceHealth(value: PersistenceHealth): void {
  health = value;
}

export function getPersistenceManifest(): PersistenceManifest | null {
  return manifest;
}

/** The persistence manifest stored in the database (null when absent/invalid/legacy). */
export async function readPersistenceManifestFromDb(): Promise<PersistenceManifest | null> {
  const raw = await getFromStore<unknown>(STORE_METADATA, META_KEY_PERSISTENCE_META);
  return parseManifest(raw);
}

/** Sets the backend mode/mirror/revision after bootstrap decided the startup path. Only the options actually provided are touched. */
export function configureBackend(
  mode: PersistenceBackendMode,
  options: {
    mirrorFrom?: { app: AppState; reports: ReportsState };
    mirrorFromRead?: WorkspaceDbRead;
    migration?: StorageMigrationRecord | null;
    lastSavedAt?: number | null;
    revision?: number;
    fallbackRevision?: number;
    manifest?: PersistenceManifest | null;
    health?: PersistenceHealth;
    /** The previously committed canonical workspace (journal diff baseline); null when nothing is committed. */
    committedWorkspace?: CanonicalWorkspace | null;
  } = {},
): void {
  activeMode = mode;
  if (options.migration !== undefined) migrationRecord = options.migration;
  if (options.lastSavedAt !== undefined) lastSavedAt = options.lastSavedAt;
  if (options.revision !== undefined) currentRevision = options.revision;
  if (options.fallbackRevision !== undefined) fallbackCopyRevision = options.fallbackRevision;
  if (options.manifest !== undefined) manifest = options.manifest;
  if (options.health !== undefined) health = options.health;
  if (options.committedWorkspace !== undefined) lastCommittedWorkspace = options.committedWorkspace;
  if (options.mirrorFromRead !== undefined) {
    mirror = mirrorFromRead(options.mirrorFromRead);
  } else if (options.mirrorFrom !== undefined) {
    mirror = mirrorFromWorkspace(options.mirrorFrom.app, options.mirrorFrom.reports);
  }
}

/** Ordered save queue — serializes IndexedDB writes so the latest state wins. */
class SerializedQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

const writeQueue = new SerializedQueue();

async function persistToIndexedDb(
  app: AppState,
  reports: ReportsState,
  options?: PersistOptions,
): Promise<WorkspacePersistResult> {
  return writeQueue.run(async () => {
    if (mirror === null) {
      // Defensive: prime from the database when no mirror exists yet.
      mirror = mirrorFromRead(await readWorkspaceFromDb());
    }
    // Integrity gate (§11): a workspace that is known to be structurally
    // invalid is not committed, and its revision is not advanced (§2).
    const candidate = buildManifest({
      revision: currentRevision + 1,
      backend: 'indexeddb',
      integrityStatus: 'verified',
      committedAt: new Date().toISOString(),
      lastSavedAt: Date.now(),
      lastMigrationAt: manifest?.lastMigrationAt,
      lastRecoveryAt: manifest?.lastRecoveryAt,
    });
    const integrity = verifyWorkspaceIntegrity(reports, candidate);
    if (integrity.status === 'failed') {
      return { ok: false, changed: false, lastSavedAt, revision: currentRevision, integrityStatus: 'failed' };
    }
    const plan = planWorkspaceWrite(app, reports, mirror);
    if (!plan.changed && options?.forceRevision !== true) {
      return { ok: true, changed: false, lastSavedAt, revision: currentRevision, integrityStatus: manifest?.integrityStatus ?? 'verified' };
    }
    // Deterministic domain diff against the previously committed canonical
    // state — the journal NEVER infers changes from UI events (V6.8 §9).
    const diff = diffWorkspaces(lastCommittedWorkspace, { app, reports });
    const reason: RevisionReason =
      options?.reason ?? (lastCommittedWorkspace === null ? 'initial' : diff.reason);
    // The manifest AND the journal entry are appended to the SAME plan, so
    // revision, state and history commit atomically in one transaction
    // (V6.7 §4, V6.8 §5/§21). A failed transaction leaves no journal entry.
    const nextManifest = buildManifest({
      revision: candidate.revision,
      backend: 'indexeddb',
      integrityStatus: integrity.status,
      committedAt: candidate.committedAt,
      lastSavedAt: candidate.lastSavedAt,
      lastMigrationAt: manifest?.lastMigrationAt,
      lastRecoveryAt: manifest?.lastRecoveryAt,
    });
    appendMetadataPut(plan, META_KEY_PERSISTENCE_META, nextManifest);
    const entry: WorkspaceRevision & { schemaVersion: number } = buildRevisionEntry({
      revision: nextManifest.revision,
      committedAt: nextManifest.committedAt,
      reason,
      affectedProjectIds: diff.affectedProjectIds,
      changeSummary: lastCommittedWorkspace === null ? null : diff.summary,
      integrityStatus: integrity.status,
      snapshot: { appState: app, reportsState: reports },
      ...(reason === 'recovery' && options?.restoredFrom !== undefined
        ? { restoredFromRevision: options.restoredFrom }
        : {}),
    });
    appendJournalPut(plan, { ...entry, schemaVersion: JOURNAL_SCHEMA_VERSION });
    await applyWorkspaceWritePlan(plan);
    currentRevision = nextManifest.revision;
    manifest = nextManifest;
    mirror = mirrorFromWorkspace(app, reports);
    lastSavedAt = nextManifest.lastSavedAt;
    lastCommittedWorkspace = { app, reports };
    // Track the committed revision in the localStorage fallback record so a
    // stale fallback can never be mistaken for current (§5/§6).
    writeLocalFallbackRecord({
      revision: fallbackCopyRevision,
      authoritativeRevision: currentRevision,
      committedAt: nextManifest.committedAt,
    });
    // A new committed workspace supersedes an intentional clear-all tombstone.
    clearClearAllTombstone();
    // Retention pruning (V6.8 §17) — its own transaction; a failure is
    // harmless (the next commit retries) and never touches the current revision.
    void pruneRevisionHistory(currentRevision, REVISION_HISTORY_RETENTION).catch(() => undefined);
    return { ok: true, changed: true, lastSavedAt, revision: currentRevision, integrityStatus: integrity.status };
  });
}

function persistToLocalStorage(app: AppState, reports: ReportsState): WorkspacePersistResult {
  // The V6.3 synchronous localStorage implementation, reused verbatim in
  // fallback mode. While localStorage is the live backend, its full workspace
  // copy is current, so both fallback revisions advance together (§5).
  const integrity = verifyWorkspaceIntegrity(reports, null);
  if (integrity.status === 'failed') {
    return { ok: false, changed: false, lastSavedAt: readPersistenceMeta().lastSavedAt, revision: currentRevision, integrityStatus: 'failed' };
  }
  const result = writePersistedWorkspace(app, reports);
  if (result.ok && result.changed) {
    currentRevision += 1;
    fallbackCopyRevision = currentRevision;
    const committedAt = new Date().toISOString();
    writeLocalFallbackRecord({ revision: currentRevision, authoritativeRevision: currentRevision, committedAt });
    manifest = buildManifest({
      revision: currentRevision,
      backend: 'localStorage',
      integrityStatus: integrity.status,
      committedAt,
      lastSavedAt: readPersistenceMeta().lastSavedAt,
    });
  } else if (result.ok) {
    // A no-op save still confirms the localStorage copy as the current
    // workspace: heal a stale fallback record (e.g. left behind by a direct
    // localStorage restore) so a false recovery-required state cannot
    // survive a boot cycle. In fallback mode the copy is always current
    // after a successful save — the record's staleness is only meaningful
    // while IndexedDB is the live backend (§5/§6).
    const record = readLocalFallbackRecord();
    if (record === null || record.revision !== currentRevision || record.authoritativeRevision !== currentRevision) {
      fallbackCopyRevision = currentRevision;
      writeLocalFallbackRecord({
        revision: currentRevision,
        authoritativeRevision: currentRevision,
        committedAt: new Date().toISOString(),
      });
    }
  }
  return {
    ok: result.ok,
    changed: result.changed,
    lastSavedAt: readPersistenceMeta().lastSavedAt,
    revision: currentRevision,
    integrityStatus: integrity.status,
  };
}

/**
 * Persist the canonical workspace through the active backend. Never
 * throws — a failed save keeps the in-memory state usable and is reported
 * through ok:false. Only a committed transaction advances the revision
 * and creates the journal entry (V6.8 §6: a failed save leaves NO committed
 * history). In localStorage fallback mode no journal is kept — the fallback
 * remains a current/best-available workspace copy only (V6.8 §22).
 */
export async function persistWorkspaceAsync(
  app: AppState,
  reports: ReportsState,
  options?: PersistOptions,
): Promise<WorkspacePersistResult> {
  if (activeMode === 'indexeddb') {
    try {
      return await persistToIndexedDb(app, reports, options);
    } catch {
      return { ok: false, changed: false, lastSavedAt, revision: currentRevision, integrityStatus: manifest?.integrityStatus ?? 'verified' };
    }
  }
  return persistToLocalStorage(app, reports);
}

/** Outcome of an explicit point-in-time restore (V6.8 §13/§14). */
export type RestoreRevisionResult =
  | { ok: true; revision: number; restoredFrom: number; app: AppState; reports: ReportsState }
  | { ok: false; error: 'not-found' | 'pruned' | 'invalid' | 'unavailable' | 'write-failed' };

/**
 * Explicit point-in-time restore (V6.8 §13/§14/§29): create a NEW current
 * revision whose state equals the selected historical revision. History is
 * append-only — newer revisions are never deleted. The user must explicitly
 * request restoration; nothing here runs automatically. The restore commit
 * goes through the same serialized queue as every other save (§38), and the
 * restored state is returned so the caller can refresh the React state.
 */
export async function createRestoreRevision(revision: number): Promise<RestoreRevisionResult> {
  if (activeMode !== 'indexeddb') return { ok: false, error: 'unavailable' };
  const reconstructed = await reconstructRevision(revision).catch(() => null);
  if (reconstructed === null) return { ok: false, error: 'invalid' };
  if (!reconstructed.ok) return { ok: false, error: reconstructed.error };
  const result = await persistWorkspaceAsync(reconstructed.app, reconstructed.reports, {
    reason: 'recovery',
    restoredFrom: revision,
    forceRevision: true,
  });
  if (!result.ok) return { ok: false, error: 'write-failed' };
  return {
    ok: true,
    revision: result.revision,
    restoredFrom: revision,
    app: reconstructed.app,
    reports: reconstructed.reports,
  };
}

/** Read the retained journal entries (ascending) for a history backup export (V6.8 §30). */
export async function exportRevisionHistoryForBackup(): Promise<WorkspaceRevision[]> {
  return getRevisionsAfter(0);
}

/** Outcome of a history-backup import (V6.8 §30). */
export type HistoryImportResult =
  | { ok: true; revision: number }
  | { ok: false; error: 'invalid' | 'write-failed' | 'unavailable' };

/**
 * Import a validated history-backup payload (V6.8 §30): install the retained
 * journal entries, then persist the imported current state as a NEW revision
 * (reason 'import'). Revision numbering continues from the larger of the
 * current and imported heads so the manifest/journal pair converges on the
 * next commit and stays monotonic.
 */
export async function importHistoryWorkspace(data: {
  appState: AppState;
  reportsState: ReportsState;
  revisions: WorkspaceRevision[];
}): Promise<HistoryImportResult> {
  if (activeMode !== 'indexeddb') return { ok: false, error: 'unavailable' };
  const importedHead = data.revisions.length > 0 ? data.revisions[data.revisions.length - 1].revision : 0;
  const replaced = await replaceJournalEntries(data.revisions);
  if (!replaced) return { ok: false, error: 'write-failed' };
  if (importedHead > currentRevision) currentRevision = importedHead;
  const result = await persistWorkspaceAsync(data.appState, data.reportsState, {
    reason: 'import',
    forceRevision: true,
  });
  if (!result.ok) return { ok: false, error: 'write-failed' };
  return { ok: true, revision: result.revision };
}

/**
 * Load the workspace from IndexedDB and apply the existing V6.3
 * validation/normalization on top of the raw records:
 * raw record → application schema migration → normalize → domain state.
 * A workspace whose records do not validate is reported as an error — the
 * caller falls back to the retained localStorage data instead of silently
 * resetting.
 */
export async function loadWorkspaceFromIndexedDb(): Promise<WorkspaceLoadResult> {
  const read = await readWorkspaceFromDb();
  const hasData = read.appState !== undefined || read.parts.core.settings !== undefined;
  if (!hasData) {
    return { ok: true, app: { ...DEMO_STATE }, reports: defaultReportsState(), empty: true, read };
  }
  let app: AppState;
  if (read.appState === undefined) {
    app = { ...DEMO_STATE };
  } else if (isAppState(read.appState)) {
    app = normalizeAppState(read.appState);
  } else {
    return { ok: false };
  }
  const reports = assembleReportsState(read.parts);
  if (!isReportsState(reports)) return { ok: false };
  return { ok: true, app, reports: normalizeReportsState(reports), empty: false, read };
}

/**
 * Clear All Local Data (V6.6 §30, V6.7 §16–§17):
 *   1. create a recovery snapshot of the current workspace (recoverable)
 *   2. remove every GanttChart localStorage key/recovery stash (old snapshots
 *      except the new one)
 *   3. close + delete the IndexedDB database
 *   4. write the intentional clear-all tombstone (survives the clear so old
 *      localStorage data can never be resurrected as current on startup)
 *
 * "empty database + tombstone" is a valid, intentional state.
 *
 * Result: 'cleared' when everything was removed, 'partial' when the clear
 * ran but a step failed, and 'aborted' when a readable workspace with data
 * could not be preserved in a recovery snapshot (e.g. localStorage quota) —
 * in that case NOTHING is deleted, so the clear can never silently become
 * unrecoverable.
 */
export type ClearAllResult = 'cleared' | 'partial' | 'aborted';

export async function clearAllLocalDataAsync(): Promise<ClearAllResult> {
  // Recovery snapshot where practical (§16): the pre-clear workspace.
  const read = await readWorkspaceFromDb().catch(() => null);
  let snapshotId: string | null = null;
  if (read !== null) {
    const hasData = read.appState !== undefined || read.parts.core.settings !== undefined;
    const snapshot = createRecoverySnapshot(
      'clear-all',
      currentRevision,
      read.appState as AppState,
      assembleReportsState(read.parts),
      new Date().toISOString(),
    );
    if (snapshot === null && hasData) return 'aborted';
    snapshotId = snapshot?.id ?? null;
  }
  // Remove older recovery snapshots; keep the one just created.
  for (const info of listRecoverySnapshots()) {
    if (info.id !== snapshotId) {
      removeRecoverySnapshot(info.id);
    }
  }
  const lsOk = clearAllPersistence();
  removeLocalFallbackRecord();
  clearMigrationFailureRecord();
  let dbOk = true;
  if (isGanttChartDbOpen() || isIndexedDbAvailable()) {
    closeGanttChartDb();
    try {
      await deleteGanttChartDb();
    } catch {
      dbOk = false;
    }
  }
  writeClearAllTombstone({ clearedAt: new Date().toISOString(), previousRevision: currentRevision });
  // The journal dies with the intentionally deleted database (V6.8 §40) —
  // the tombstone + localStorage recovery snapshot preserve the pre-clear
  // state and prevent accidental history resurrection.
  mirror = null;
  migrationRecord = null;
  lastSavedAt = null;
  currentRevision = 0;
  fallbackCopyRevision = 0;
  manifest = null;
  lastCommittedWorkspace = null;
  return lsOk && dbOk ? 'cleared' : 'partial';
}

/** Developer-oriented storage diagnostics — metadata only, never raw records. */
export interface StorageDiagnostics {
  mode: PersistenceBackendMode;
  database: string | null;
  databaseVersion: number | null;
  migrationStatus: string | null;
  lastSavedAt: number | null;
  health: PersistenceHealth;
  revision: number;
  integrityStatus: IntegrityStatus | null;
  /** Revision of the localStorage workspace copy (null when none). */
  fallbackRevision: number | null;
  /** Number of retained recovery snapshots. */
  recoverySnapshots: number;
  /** Last revision known to be committed to IndexedDB (from the fallback record). */
  authoritativeRevision: number | null;
  /** Revision journal state (V6.8). */
  history: {
    available: boolean;
    entryCount: number;
    /** Latest committed journal revision (null when none). */
    latestRevision: number | null;
    integrity: 'verified' | 'warning' | 'unavailable';
    issues: string[];
  };
}

export async function getStorageDiagnostics(): Promise<StorageDiagnostics> {
  const record = readLocalFallbackRecord();
  const snapshotCount = listRecoverySnapshots().length;
  let history: StorageDiagnostics['history'] = {
    available: false,
    entryCount: 0,
    latestRevision: null,
    integrity: 'unavailable',
    issues: [],
  };
  if (activeMode === 'indexeddb') {
    try {
      const journal = await readJournalIntegrity(currentRevision);
      history = {
        available: journal.entryCount > 0,
        entryCount: journal.entryCount,
        latestRevision: journal.latestRevision > 0 ? journal.latestRevision : null,
        integrity: journal.status,
        issues: journal.issues,
      };
    } catch {
      // history stays unavailable — reported, never fatal
    }
  }
  const base = {
    lastSavedAt,
    health,
    revision: currentRevision,
    integrityStatus: manifest === null ? null : manifest.integrityStatus,
    fallbackRevision: record === null || record.revision === 0 ? null : record.revision,
    recoverySnapshots: snapshotCount,
    authoritativeRevision: record === null ? null : record.authoritativeRevision,
    history,
  };
  if (activeMode !== 'indexeddb') {
    return { mode: activeMode, database: null, databaseVersion: null, migrationStatus: null, ...base };
  }
  try {
    const db = await openGanttChartDb();
    const marker = migrationRecord ?? (await readStorageMigrationRecord());
    return {
      mode: activeMode,
      database: DB_NAME,
      databaseVersion: db.version,
      migrationStatus: marker === null ? null : marker.status,
      ...base,
    };
  } catch {
    return { mode: activeMode, database: DB_NAME, databaseVersion: null, migrationStatus: null, ...base };
  }
}

/** True when an intentional clear-all tombstone is present (diagnostics/tests). */
export function hasClearAllTombstone(): boolean {
  return readClearAllTombstone() !== null;
}

/** Test hook: reset all backend state (closes any open connection). */
export function resetPersistenceBackendForTests(): void {
  closeGanttChartDb();
  activeMode = 'localstorage';
  mirror = null;
  migrationRecord = null;
  lastSavedAt = null;
  currentRevision = 0;
  fallbackCopyRevision = 0;
  manifest = null;
  health = 'fresh';
  lastCommittedWorkspace = null;
}

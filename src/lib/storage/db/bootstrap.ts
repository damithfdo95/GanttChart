/**
 * Application startup persistence sequence (V6.6 §18–§22, V6.7 §6–§7, §16–§18).
 *
 *   1. Open IndexedDB (running schema upgrades when required)
 *   2. Check the migration marker and the persistence manifest
 *   3. When not migrated: read localStorage → integrity gate → migrate →
 *      verify → establish revision 1 (or the preserved localStorage
 *      revision) → mark complete
 *   4. Load the application state from IndexedDB
 *   5. Hand the workspace + recovery state to the React application
 *
 * V6.7 makes fallback deterministic (§6/§7):
 *   - IndexedDB valid                          → healthy (IndexedDB authoritative)
 *   - IndexedDB unavailable + fallback current  → fallback-current (usable)
 *   - IndexedDB unavailable + fallback stale   → recovery-required — the
 *     stale copy is loaded as best-available data but NEVER treated as
 *     current, and the state is surfaced to the user
 *   - localStorage newer than IndexedDB         → recovered (promoted forward
 *     with a new revision — never a rollback)
 *   - both sources unreadable                   → existing recovery-stash path
 *   - intentional clear-all (tombstone)         → fresh empty workspace, old
 *     data is never resurrected
 */

import type { AppState, ReportsState } from '../../../types';
import { loadState, STORAGE_KEY, LEGACY_STORAGE_KEY } from '../storage';
import { loadReportsState, REPORTS_STORAGE_KEY } from '../reports';
import { readPersistenceMeta } from '../persistence';
import { hasCorruptionEvents } from '../corruption';
import { isIndexedDbAvailable, openGanttChartDb } from './repository';
import { hasLegacyLocalStorageData, migrateLocalStorageToIndexedDb, readStorageMigrationRecord } from './migration';
import { readWorkspaceFromDb, type WorkspaceDbRead } from './workspaceIo';
import {
  configureBackend,
  getPersistenceMode,
  loadWorkspaceFromIndexedDb,
  persistWorkspaceAsync,
  readPersistenceManifestFromDb,
  setPersistenceHealth,
  type PersistenceBackendMode,
  type PersistenceHealth,
} from './persistenceBackend';
import { getLatestRevision, getRevisionHistory, reconstructRevision, writeJournalAnchor } from './revisionHistory';
import {
  clearMigrationFailureRecord,
  readClearAllTombstone,
  readLocalFallbackRecord,
  writeMigrationFailureRecord,
  type MigrationFailureReason,
} from './recovery';

export type MigrationStatus = 'completed' | 'skipped-empty' | 'failed' | 'not-run' | 'db-error';

export interface PersistenceBoot {
  mode: PersistenceBackendMode;
  workspace: { app: AppState; reports: ReportsState };
  migrationStatus: MigrationStatus;
  /** Why the migration failed (set only when migrationStatus is 'failed'). */
  migrationFailureReason?: MigrationFailureReason;
  lastSavedAt: number | null;
  /** Overall persistence/recovery state (V6.7 §7). */
  health: PersistenceHealth;
  /** Committed revision of the loaded workspace (0 = nothing committed). */
  revision: number;
}

/** True when localStorage holds a GanttChart workspace copy at all. */
function hasLocalStorageWorkspace(): boolean {
  return hasLegacyLocalStorageData();
}

/**
 * V6.8 §42/§43: establish the first history anchor for a database whose
 * revision predates the journal. The CURRENT manifest revision is reused
 * (never reset, never advanced) with reason 'migration' and the current
 * known workspace — no historical revisions before the V6.8 adoption point
 * are fabricated.
 *
 * The anchor is written ONLY when the journal is completely empty (a V6.7
 * installation adopting V6.8). A non-empty journal that is behind the
 * manifest is NEVER silently rewritten to make the numbers match (§20) — it
 * is reported as degraded through diagnostics instead.
 */
async function ensureV68JournalAnchor(
  revision: number,
  committedAt: string,
  app: AppState,
  reports: ReportsState,
  integrityStatus: 'verified' | 'warning' = 'verified',
): Promise<void> {
  if (revision < 1) return;
  try {
    const latest = await getLatestRevision();
    if (latest !== 0) return; // journal already adopted (or degraded — reported, never repaired here)
    await writeJournalAnchor(revision, committedAt, 'migration', { app, reports }, integrityStatus);
  } catch {
    // Journal unavailable — history stays degraded, workspace unaffected.
  }
}

/**
 * V6.8 §23: the current workspace records are unreadable/invalid, but the
 * journal is independent evidence. Return the latest valid historical
 * snapshot (newest first) as best-available data — never auto-committed;
 * the user restores explicitly (§29).
 */
async function loadBestAvailableFromJournal(): Promise<{ app: AppState; reports: ReportsState; revision: number } | null> {
  try {
    const metas = await getRevisionHistory();
    for (const meta of metas) {
      const reconstructed = await reconstructRevision(meta.revision).catch(() => null);
      if (reconstructed !== null && reconstructed.ok) {
        return { app: reconstructed.app, reports: reconstructed.reports, revision: meta.revision };
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** Classify localStorage after the V6.3 loaders ran (peek, no consume). */
function classifyLocalStorage(): 'absent' | 'corrupt' | 'valid' {
  if (!hasLocalStorageWorkspace()) return 'absent';
  return hasCorruptionEvents() ? 'corrupt' : 'valid';
}

/**
 * Cheap raw peek used BEFORE the V6.3 loaders ran: an unparsable retained
 * payload must keep the existing recovery-stash path (evidence preserved).
 * Deep validation stays with the loaders; this only routes the bootstrap.
 */
function isLocalStorageUnparsable(): boolean {
  try {
    for (const key of [STORAGE_KEY, LEGACY_STORAGE_KEY, REPORTS_STORAGE_KEY]) {
      const raw = window.localStorage.getItem(key);
      if (raw !== null) JSON.parse(raw);
    }
    return false;
  } catch {
    return true;
  }
}

/** The V6.3 startup path: localStorage loaders + sync persistence, unchanged. */
function localStorageBoot(
  migrationStatus: MigrationStatus,
  revision: number,
  fallbackRevision: number,
  migrationFailureReason: MigrationFailureReason | null = null,
): PersistenceBoot {
  const app = loadState();
  const reports = loadReportsState();
  const lsState = classifyLocalStorage();
  const health: PersistenceHealth =
    lsState === 'corrupt'
      ? 'recovery-stash'
      : lsState === 'absent'
        ? 'fresh'
        : 'fallback-current';
  configureBackend('localstorage', { revision, fallbackRevision, health });
  return {
    mode: 'localstorage',
    workspace: { app, reports },
    migrationStatus,
    ...(migrationFailureReason !== null ? { migrationFailureReason } : {}),
    lastSavedAt: readPersistenceMeta().lastSavedAt,
    health,
    revision,
  };
}

/**
 * IndexedDB cannot be used (unavailable, open failure or unreadable records).
 * Decide between a usable current fallback and an explicit recovery state —
 * a stale localStorage copy is never silently treated as current (§6/§18).
 */
function localStorageRecoveryBoot(
  migrationStatus: MigrationStatus,
  migrationFailureReason: MigrationFailureReason | null = null,
): PersistenceBoot {
  const record = readLocalFallbackRecord();
  const stale = record !== null && record.authoritativeRevision > record.revision;
  if (!stale) {
    return localStorageBoot(migrationStatus, record?.revision ?? 0, record?.revision ?? 0, migrationFailureReason);
  }
  // Recovery-required: the stale copy is preserved and loaded as
  // best-available data, clearly flagged, and future commits continue from
  // the last known revision so ordering stays monotonic. Nothing newer is
  // overwritten by it.
  const revision = record!.authoritativeRevision;
  const boot = localStorageBoot(migrationStatus, revision, record!.revision, migrationFailureReason);
  if (boot.health === 'recovery-stash') return boot; // unreadable fallback dominates (§7 F)
  configureBackend('localstorage', { revision, fallbackRevision: record!.revision, health: 'recovery-required' });
  return { ...boot, health: 'recovery-required', revision };
}

/**
 * The migration attempt failed: remember WHY (console warning for immediate
 * F12 visibility + a localStorage record for the banner and Settings
 * diagnostics) and boot on the preserved localStorage copy. The record is
 * cleared by the next successful migration/bootstrap into IndexedDB.
 */
function migrationFailureBoot(reason: MigrationFailureReason): PersistenceBoot {
  console.warn(`[persistence] localStorage → IndexedDB migration failed (${reason})`);
  writeMigrationFailureRecord({ reason, at: new Date().toISOString() });
  return localStorageRecoveryBoot('failed', reason);
}

/**
 * Initialize persistence before the React application renders. Never throws —
 * every failure path degrades to a safe, explicitly-surfaced state.
 */
export async function initPersistence(): Promise<PersistenceBoot> {
  if (!isIndexedDbAvailable()) return localStorageRecoveryBoot('not-run');

  try {
    await openGanttChartDb();
  } catch {
    // Database open failure / blocked upgrade / private-mode limitation.
    return localStorageRecoveryBoot('not-run');
  }

  let marker: Awaited<ReturnType<typeof readStorageMigrationRecord>>;
  try {
    marker = await readStorageMigrationRecord();
  } catch {
    // IndexedDB exists but is unreadable — keep the localStorage copy (§20).
    return localStorageRecoveryBoot('db-error');
  }

  if (marker !== null) {
    // IndexedDB already migrated — load it, never recreate it from localStorage (§19).
    let loaded: Awaited<ReturnType<typeof loadWorkspaceFromIndexedDb>>;
    try {
      loaded = await loadWorkspaceFromIndexedDb();
    } catch {
      loaded = { ok: false };
    }
    if (!loaded.ok) {
      // Current records unreadable/invalid. Recovery order (V6.7 §6/§7 + V6.8 §22/§23):
      //   1. A CORRUPT localStorage payload keeps the existing V6.3
      //      recovery-stash path (evidence preserved verbatim).
      //   2. The journal is independent durable evidence: when its latest
      //      valid revision is NEWER than the retained localStorage copy
      //      (or no usable copy exists), boot with that snapshot as
      //      best-available data, flagged recovery-required — never silently
      //      current, never auto-committed (§29).
      //   3. Otherwise the existing V6.7 localStorage fallback paths apply.
      const lsState = classifyLocalStorage();
      if (lsState === 'corrupt' || isLocalStorageUnparsable()) {
        return localStorageRecoveryBoot('db-error');
      }
      const journalBest = await loadBestAvailableFromJournal();
      const fallbackRecord = readLocalFallbackRecord();
      const journalIsFresher =
        journalBest !== null && (lsState === 'absent' || (fallbackRecord?.revision ?? 0) < journalBest.revision);
      if (journalBest !== null && journalIsFresher) {
        let read: WorkspaceDbRead | null = null;
        try {
          read = await readWorkspaceFromDb();
        } catch {
          read = null;
        }
        if (read !== null) {
          let manifest = null as Awaited<ReturnType<typeof readPersistenceManifestFromDb>>;
          try {
            manifest = await readPersistenceManifestFromDb();
          } catch {
            manifest = null;
          }
          // Continue numbering from the newest known revision so a valid
          // manifest is never rolled backwards (§24).
          const revision = Math.max(manifest?.revision ?? 0, journalBest.revision);
          clearMigrationFailureRecord();
          configureBackend('indexeddb', {
            mirrorFromRead: read,
            revision,
            fallbackRevision: fallbackRecord?.revision ?? 0,
            health: 'recovery-required',
            committedWorkspace: { app: journalBest.app, reports: journalBest.reports },
          });
          return {
            mode: getPersistenceMode(),
            workspace: { app: journalBest.app, reports: journalBest.reports },
            migrationStatus: 'completed',
            lastSavedAt: null,
            health: 'recovery-required',
            revision,
          };
        }
      }
      // IndexedDB records are unreadable/invalid: keep the localStorage copy
      // when one exists, otherwise the existing loaders fall back to defaults
      // with the V6.3 corruption notice (§20). The database is quarantined —
      // a stale copy never overwrites it.
      return localStorageRecoveryBoot('db-error');
    }
    let manifest = null as Awaited<ReturnType<typeof readPersistenceManifestFromDb>>;
    let idbRevision = 0;
    try {
      manifest = await readPersistenceManifestFromDb();
      idbRevision = manifest?.revision ?? 0;
    } catch {
      manifest = null;
    }
    const record = readLocalFallbackRecord();
    // localStorage holds a NEWER committed workspace than the database (a
    // fallback-mode session wrote revisions while IndexedDB was down):
    // promote it forward with a new revision — never a rollback (§7).
    if (record !== null && record.revision > idbRevision && record.revision > 0 && hasLocalStorageWorkspace()) {
      const lsApp = loadState();
      const lsReports = loadReportsState();
      if (classifyLocalStorage() !== 'corrupt') {
        let read: WorkspaceDbRead;
        try {
          read = await readWorkspaceFromDb();
        } catch {
          return localStorageRecoveryBoot('db-error');
        }
        // Diff against the DATABASE mirror so stale database records are
        // replaced/deleted correctly by the promoted workspace.
        configureBackend('indexeddb', {
          mirrorFromRead: read,
          revision: record.revision,
          fallbackRevision: record.revision,
          health: 'recovery-required',
        });
        const promoted = await persistWorkspaceAsync(lsApp, lsReports, { reason: 'recovery' });
        if (promoted.ok) {
          setPersistenceHealth('recovered');
          clearMigrationFailureRecord();
          return {
            mode: getPersistenceMode(),
            workspace: { app: lsApp, reports: lsReports },
            migrationStatus: 'completed',
            lastSavedAt: promoted.lastSavedAt,
            health: 'recovered',
            revision: promoted.revision,
          };
        }
      }
      return localStorageRecoveryBoot('db-error');
    }
    const health: PersistenceHealth = loaded.empty ? 'fresh' : 'healthy';
    const lastSavedAt = manifest?.lastSavedAt ?? readPersistenceMeta().lastSavedAt;
    clearMigrationFailureRecord();
    configureBackend('indexeddb', {
      // The mirror reflects the DATABASE records, not the loaded workspace —
      // a fresh/empty database must not appear to already contain the demo
      // defaults, or those records would never be written.
      mirrorFromRead: loaded.read,
      manifest,
      lastSavedAt,
      revision: idbRevision,
      fallbackRevision: record?.revision ?? 0,
      health,
      // Diff baseline for the journal: the previously committed canonical
      // state (nothing yet on a fresh database → first save is 'initial').
      committedWorkspace: idbRevision > 0 ? { app: loaded.app, reports: loaded.reports } : null,
    });
    // V6.8 §42/§43: a V6.7 installation adopts the journal at its current
    // revision with a migration anchor — no fabricated earlier history.
    if (idbRevision > 0) {
      await ensureV68JournalAnchor(
        idbRevision,
        manifest?.committedAt ?? new Date().toISOString(),
        loaded.app,
        loaded.reports,
        manifest?.integrityStatus === 'warning' ? 'warning' : 'verified',
      );
    }
    return {
      mode: getPersistenceMode(),
      workspace: { app: loaded.app, reports: loaded.reports },
      migrationStatus: 'completed',
      lastSavedAt,
      health,
      revision: idbRevision,
    };
  }

  // No migration marker yet.
  const tombstone = readClearAllTombstone();
  if (hasLocalStorageWorkspace()) {
    const record = readLocalFallbackRecord();
    if (record !== null && record.authoritativeRevision > record.revision) {
      // V6.7 §18: IndexedDB was lost after commits existed; the retained
      // localStorage copy is stale. Never silently migrate it back in.
      return migrationFailureBoot('stale-fallback');
    }
    if (tombstone !== null && record === null) {
      // V6.7 §17: localStorage data predates an intentional clear-all and no
      // newer authoritative source exists — intentional empty workspace,
      // old data is not resurrected.
      return freshBoot();
    }
    // Pre-V6.7 localStorage user (or a current fallback-mode session that
    // wrote revisions while IndexedDB was gone): migrate, preserving any
    // existing valid revision.
    const outcome = await migrateLocalStorageToIndexedDb(new Date().toISOString());
    if (outcome.status === 'failed') {
      // localStorage stays untouched and remains the persistence backend.
      return migrationFailureBoot(outcome.reason);
    }
    if (outcome.status === 'skipped-empty') {
      return freshBoot();
    }
    // Migration completed and verified — IndexedDB becomes the primary source
    // at the established revision.
    clearMigrationFailureRecord();
    const migratedManifest = await readPersistenceManifestFromDb();
    const lastSavedAt = readPersistenceMeta().lastSavedAt;
    configureBackend('indexeddb', {
      mirrorFrom: { app: outcome.appState, reports: outcome.reports },
      migration: outcome.record,
      manifest: migratedManifest,
      lastSavedAt,
      revision: outcome.revision,
      fallbackRevision: outcome.revision,
      health: 'healthy',
      committedWorkspace: { app: outcome.appState, reports: outcome.reports },
    });
    // V6.8: the migrated workspace becomes the first history anchor at the
    // preserved revision (localStorage-revision continuity, §43).
    await ensureV68JournalAnchor(
      outcome.revision,
      migratedManifest?.committedAt ?? new Date().toISOString(),
      outcome.appState,
      outcome.reports,
      migratedManifest?.integrityStatus === 'warning' ? 'warning' : 'verified',
    );
    return {
      mode: getPersistenceMode(),
      workspace: { app: outcome.appState, reports: outcome.reports },
      migrationStatus: 'completed',
      lastSavedAt,
      health: 'healthy',
      revision: outcome.revision,
    };
  }

  // No localStorage data anywhere: first-time user, or an intentional
  // clear-all (the tombstone prevents resurrection of removed data, §17).
  const outcome = await migrateLocalStorageToIndexedDb(new Date().toISOString());
  if (outcome.status === 'skipped-empty') {
    return freshBoot();
  }
  if (outcome.status === 'failed') {
    return migrationFailureBoot(outcome.reason);
  }
  return freshBoot();
}

/** Fresh startup path: IndexedDB primary; the revision comes from the stored manifest (0 when nothing is committed). */
async function freshBoot(): Promise<PersistenceBoot> {
  let loaded: Awaited<ReturnType<typeof loadWorkspaceFromIndexedDb>>;
  try {
    loaded = await loadWorkspaceFromIndexedDb();
  } catch {
    loaded = { ok: false };
  }
  if (!loaded.ok) {
    return localStorageRecoveryBoot('db-error');
  }
  let manifest = null as Awaited<ReturnType<typeof readPersistenceManifestFromDb>>;
  try {
    manifest = await readPersistenceManifestFromDb();
  } catch {
    manifest = null;
  }
  const revision = manifest?.revision ?? 0;
  const health: PersistenceHealth = loaded.empty && revision === 0 ? 'fresh' : 'healthy';
  clearMigrationFailureRecord();
  configureBackend('indexeddb', {
    // Mirror from the database read (see the marker path above for why).
    mirrorFromRead: loaded.read,
    manifest,
    lastSavedAt: manifest?.lastSavedAt ?? null,
    revision,
    fallbackRevision: readLocalFallbackRecord()?.revision ?? 0,
    health,
    committedWorkspace: revision > 0 ? { app: loaded.app, reports: loaded.reports } : null,
  });
  if (revision > 0) {
    await ensureV68JournalAnchor(
      revision,
      manifest?.committedAt ?? new Date().toISOString(),
      loaded.app,
      loaded.reports,
      manifest?.integrityStatus === 'warning' ? 'warning' : 'verified',
    );
  }
  return {
    mode: getPersistenceMode(),
    workspace: { app: loaded.app, reports: loaded.reports },
    migrationStatus: 'skipped-empty',
    lastSavedAt: manifest?.lastSavedAt ?? null,
    health,
    revision,
  };
}

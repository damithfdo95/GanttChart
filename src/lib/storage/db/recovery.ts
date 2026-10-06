/**
 * localStorage fallback revisioning & recovery artifacts (V6.7 §5–§7, §16–§19).
 *
 * localStorage never receives full workspace writes while IndexedDB is
 * authoritative (V6.6 §16) — but it carries:
 *
 *   - `ganttchart.fallback.v1`: the fallback record — revision of the full
 *     workspace copy held in localStorage and the last revision known to be
 *     committed to the authoritative IndexedDB backend. This is what makes
 *     a stale fallback detectable instead of silently authoritative (§5/§6).
 *   - `ganttchart.cleared.v1`: the clear-all tombstone — intentional
 *     deletion marker distinguishing "user chose to delete everything" from
 *     "database was lost" (§16/§17).
 *   - `ganttchart.recoverySnapshot.v1.<id>`: recovery snapshots of the
 *     workspace taken at meaningful lifecycle events (clear-all, import
 *     replacement, manual) — never per keystroke (§19).
 *
 * All writes are best-effort: a blocked localStorage never breaks the app.
 */

import type { AppState, ReportsState } from '../../../types';
import { generateId } from '../../id';
import type { TranslationKey } from '../../../i18n';

/** localStorage key holding the fallback revision record (V6.7 §5). */
export const FALLBACK_RECORD_KEY = 'ganttchart.fallback.v1';

/** localStorage key holding the intentional clear-all tombstone (V6.7 §17). */
export const CLEAR_ALL_TOMBSTONE_KEY = 'ganttchart.cleared.v1';

/** localStorage key holding the last migration-failure reason (diagnostics only). */
export const MIGRATION_FAILURE_KEY = 'ganttchart.migrationFailure.v1';

/** Why the localStorage → IndexedDB migration failed at startup. */
export type MigrationFailureReason =
  | 'invalid-local-storage'
  | 'write-failed'
  | 'verification-failed'
  | 'integrity-failed'
  | 'stale-fallback';

/** UI label key per migration failure reason (banner + Settings diagnostics). */
export const MIGRATION_FAILURE_LABEL_KEY: Record<MigrationFailureReason, TranslationKey> = {
  'invalid-local-storage': 'persistence.migrationReason.invalidLocalStorage',
  'write-failed': 'persistence.migrationReason.writeFailed',
  'verification-failed': 'persistence.migrationReason.verificationFailed',
  'integrity-failed': 'persistence.migrationReason.integrityFailed',
  'stale-fallback': 'persistence.migrationReason.staleFallback',
};

export interface MigrationFailureRecord {
  reason: MigrationFailureReason;
  /** ISO timestamp of the failed startup attempt. */
  at: string;
}

/** Read the last migration-failure record (null when absent or malformed). */
export function readMigrationFailureRecord(): MigrationFailureRecord | null {
  const raw = readRaw(MIGRATION_FAILURE_KEY);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      (typeof parsed.reason !== 'string' || !(parsed.reason in MIGRATION_FAILURE_LABEL_KEY)) ||
      typeof parsed.at !== 'string'
    ) {
      return null;
    }
    return { reason: parsed.reason as MigrationFailureReason, at: parsed.at };
  } catch {
    return null;
  }
}

/** Best-effort write of the last migration-failure record. */
export function writeMigrationFailureRecord(record: MigrationFailureRecord): boolean {
  return writeRaw(MIGRATION_FAILURE_KEY, JSON.stringify(record));
}

/** Remove the migration-failure record (successful migration / clear-all). */
export function clearMigrationFailureRecord(): void {
  removeRaw(MIGRATION_FAILURE_KEY);
}

/** localStorage key prefix for recovery snapshots (V6.7 §19). */
export const RECOVERY_SNAPSHOT_PREFIX = 'ganttchart.recoverySnapshot.v1.';

/** Recovery snapshots are capped — they hold full workspace copies. */
export const MAX_RECOVERY_SNAPSHOTS = 5;

export interface LocalFallbackRecord {
  /** Revision of the full workspace copy held in localStorage (0 = no copy). */
  revision: number;
  /** Last revision known to be committed to the authoritative IndexedDB backend. */
  authoritativeRevision: number;
  committedAt: string;
}

export interface ClearAllTombstone {
  clearedAt: string;
  /** Workspace revision that was cleared (0 when none was committed). */
  previousRevision: number;
}

export type RecoveryReason = 'migration-failure' | 'import-replacement' | 'clear-all' | 'integrity-failure' | 'fallback' | 'manual';

export interface RecoverySnapshotRecord {
  id: string;
  createdAt: string;
  source: 'indexeddb' | 'localStorage';
  revision: number;
  reason: RecoveryReason;
  appState: AppState;
  reportsState: ReportsState;
}

/** Metadata-only view of a recovery snapshot (listings never load full payloads). */
export interface RecoverySnapshotInfo {
  id: string;
  createdAt: string;
  revision: number;
  reason: RecoveryReason;
}

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function removeRaw(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // best effort
  }
}

/** Read the fallback revision record (null when absent or malformed). */
export function readLocalFallbackRecord(): LocalFallbackRecord | null {
  const raw = readRaw(FALLBACK_RECORD_KEY);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof parsed.revision !== 'number' ||
      !Number.isInteger(parsed.revision) ||
      parsed.revision < 0 ||
      typeof parsed.authoritativeRevision !== 'number' ||
      !Number.isInteger(parsed.authoritativeRevision) ||
      parsed.authoritativeRevision < 0 ||
      typeof parsed.committedAt !== 'string'
    ) {
      return null;
    }
    return {
      revision: parsed.revision,
      authoritativeRevision: parsed.authoritativeRevision,
      committedAt: parsed.committedAt,
    };
  } catch {
    return null;
  }
}

/** Best-effort write of the fallback revision record. */
export function writeLocalFallbackRecord(record: LocalFallbackRecord): boolean {
  return writeRaw(FALLBACK_RECORD_KEY, JSON.stringify(record));
}

/** Remove the fallback record (Clear All Local Data). */
export function removeLocalFallbackRecord(): void {
  removeRaw(FALLBACK_RECORD_KEY);
}

/** Read the clear-all tombstone (null when absent or malformed). */
export function readClearAllTombstone(): ClearAllTombstone | null {
  const raw = readRaw(CLEAR_ALL_TOMBSTONE_KEY);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.clearedAt !== 'string' || typeof parsed.previousRevision !== 'number') return null;
    return { clearedAt: parsed.clearedAt, previousRevision: parsed.previousRevision };
  } catch {
    return null;
  }
}

/** Write the clear-all tombstone — must SURVIVE the clear operation (§17). */
export function writeClearAllTombstone(tombstone: ClearAllTombstone): boolean {
  return writeRaw(CLEAR_ALL_TOMBSTONE_KEY, JSON.stringify(tombstone));
}

/** Remove the tombstone — a new committed IndexedDB workspace supersedes it (§17 lifecycle). */
export function clearClearAllTombstone(): void {
  removeRaw(CLEAR_ALL_TOMBSTONE_KEY);
}

function parseSnapshot(raw: string): RecoverySnapshotRecord | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof parsed.id !== 'string' ||
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.revision !== 'number' ||
      typeof parsed.reason !== 'string' ||
      (parsed.source !== 'indexeddb' && parsed.source !== 'localStorage')
    ) {
      return null;
    }
    return parsed as unknown as RecoverySnapshotRecord;
  } catch {
    return null;
  }
}

/**
 * Create a recovery snapshot of the current workspace (V6.7 §19). Snapshots
 * are full copies taken at meaningful lifecycle events only — never per
 * keystroke. The workspace passed in is serialized; it is never mutated.
 */
export function createRecoverySnapshot(
  reason: RecoveryReason,
  revision: number,
  appState: AppState,
  reportsState: ReportsState,
  nowIso: string,
): RecoverySnapshotRecord | null {
  const snapshot: RecoverySnapshotRecord = {
    id: `rec-${generateId()}`,
    createdAt: nowIso,
    source: 'indexeddb',
    revision,
    reason,
    appState,
    reportsState,
  };
  if (!writeRaw(RECOVERY_SNAPSHOT_PREFIX + snapshot.id, JSON.stringify(snapshot))) return null;
  pruneRecoverySnapshots();
  return snapshot;
}

/** List recovery snapshot metadata (ids/reasons/revisions only). */
export function listRecoverySnapshots(): RecoverySnapshotInfo[] {
  const infos: RecoverySnapshotInfo[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key === null || !key.startsWith(RECOVERY_SNAPSHOT_PREFIX)) continue;
      const snapshot = parseSnapshot(readRaw(key) ?? '');
      if (snapshot === null) continue;
      infos.push({ id: snapshot.id, createdAt: snapshot.createdAt, revision: snapshot.revision, reason: snapshot.reason });
    }
  } catch {
    // listing is best effort
  }
  return infos.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Read one full recovery snapshot (explicit recovery/import flows only). */
export function readRecoverySnapshot(id: string): RecoverySnapshotRecord | null {
  const raw = readRaw(RECOVERY_SNAPSHOT_PREFIX + id);
  if (raw === null) return null;
  return parseSnapshot(raw);
}

/** Remove one recovery snapshot. */
export function removeRecoverySnapshot(id: string): void {
  removeRaw(RECOVERY_SNAPSHOT_PREFIX + id);
}

/** Remove all recovery snapshots (Clear All Local Data). */
export function clearRecoverySnapshots(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key !== null && key.startsWith(RECOVERY_SNAPSHOT_PREFIX)) keys.push(key);
    }
    for (const key of keys) removeRaw(key);
  } catch {
    // best effort
  }
}

/** Keep only the most recent snapshots (unbounded growth guard). */
function pruneRecoverySnapshots(): void {
  const infos = listRecoverySnapshots();
  for (const info of infos.slice(MAX_RECOVERY_SNAPSHOTS)) {
    removeRecoverySnapshot(info.id);
  }
}

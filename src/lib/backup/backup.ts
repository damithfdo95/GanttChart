import type { AppState, ReportsState } from '../../types';
import { isAppState, normalizeAppState } from '../storage/storage';
import { isReportsState, normalizeReportsState } from '../storage/reports';
import { parseRevisionEntry, type WorkspaceRevision } from '../storage/db/journal';

/**
 * Full-data backup: everything the local-first app persists, in one portable
 * JSON file (both storages). SQLite is not available in a browser-only app,
 * so the JSON full-data backup is the canonical backup format.
 */

export interface BackupPayload {
  app: 'ganttchart';
  kind: 'backup';
  version: 1;
  exportedAt: string;
  data: {
    appState: AppState;
    reportsState: ReportsState;
  };
}

export type BackupParseResult =
  | { ok: true; data: BackupPayload['data'] }
  | { ok: false; error: 'invalid' };

const SUPPORTED_BACKUP_VERSIONS: readonly number[] = [1];

/**
 * Versioned migration pipeline (V6.3 §7): detect the payload version → run
 * migrations → return the migrated data for normalization. Version 1 is the
 * oldest schema so no explicit steps run yet; unsupported (e.g. newer)
 * versions are rejected clearly instead of being silently accepted (§11).
 */
function migrateBackupData(parsed: Record<string, unknown>): { appState: AppState; reportsState: ReportsState } | null {
  if (typeof parsed.version !== 'number' || !SUPPORTED_BACKUP_VERSIONS.includes(parsed.version)) {
    return null;
  }
  const data = parsed.data;
  if (typeof data !== 'object' || data === null) return null;
  return data as { appState: AppState; reportsState: ReportsState };
}

/**
 * Build the backup payload from canonical, normalized data (V6.3 §25): the
 * export path normalizes exactly like the restore path, so an
 * export → import → export round-trip is byte-equivalent and legacy records
 * (e.g. without spoAssigned) are exported with their safe defaults filled.
 */
/**
 * The reports state as a backup carries it: no acknowledgments (see below) and no JIRA connection.
 * The connection holds a credential and belongs to the device, so a backup file never contains it
 * (restoring keeps the device's own, see sanitizeRestoredAccountLinks).
 */
function backupReportsState(reportsState: ReportsState): ReportsState {
  const normalized = normalizeReportsState(reportsState);
  const { jira: _jira, ...settings } = normalized.settings;
  return { ...normalized, settings, notificationAcks: [] };
}

export function createBackupPayload(appState: AppState, reportsState: ReportsState): BackupPayload {
  return {
    app: 'ganttchart',
    kind: 'backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    data: {
      appState: normalizeAppState(appState),
      // Stage 8E: a backup file never contains acknowledgments — they are the
      // workspace's own per-person state (sanitizeRestoredAccountLinks keeps
      // the workspace's acks on restore); only definitions and the logo travel.
      reportsState: backupReportsState(reportsState),
    },
  };
}

/** Strict validation — a bad file is rejected clearly, never half-imported. */
export function parseBackupPayload(text: string): BackupParseResult {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return { ok: false, error: 'invalid' };
    const p = parsed as Record<string, unknown>;
    if (p.app !== 'ganttchart' || p.kind !== 'backup') return { ok: false, error: 'invalid' };
    const migrated = migrateBackupData(p);
    if (migrated === null) return { ok: false, error: 'invalid' };
    if (!isAppState(migrated.appState) || !isReportsState(migrated.reportsState)) {
      return { ok: false, error: 'invalid' };
    }
    // Old backups without portfolio fields are migrated immediately so the
    // restored data (incl. stable Project IDs) is complete on write.
    return {
      ok: true,
      data: {
        appState: normalizeAppState(migrated.appState),
        reportsState: normalizeReportsState(migrated.reportsState),
      },
    };
  } catch {
    return { ok: false, error: 'invalid' };
  }
}

// ---- V6.8 history backup (current state + retained revision journal) ----

/**
 * History backup (V6.8 §30): the current canonical state PLUS the retained
 * revision journal entries. The payload stays portable — it contains no
 * IndexedDB store names, browser database ids, transaction ids or internal
 * keys; importing never requires IndexedDB internals.
 */
export interface HistoryBackupPayload {
  app: 'ganttchart';
  kind: 'history-backup';
  version: 1;
  exportedAt: string;
  data: {
    appState: AppState;
    reportsState: ReportsState;
    /** Retained journal entries, ascending by revision. */
    revisions: WorkspaceRevision[];
  };
}

export type HistoryBackupParseResult =
  | { ok: true; data: HistoryBackupPayload['data'] }
  | { ok: false; error: 'invalid' };

export function createHistoryBackupPayload(
  appState: AppState,
  reportsState: ReportsState,
  revisions: WorkspaceRevision[],
): HistoryBackupPayload {
  return {
    app: 'ganttchart',
    kind: 'history-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    data: {
      appState: normalizeAppState(appState),
      // Stage 8E: same acknowledgment rule as the full backup.
      reportsState: backupReportsState(reportsState),
      // Re-stamp the journal format version so the portable file round-trips
      // through the strict parser (no browser internals involved).
      revisions: [...revisions]
        .sort((a, b) => a.revision - b.revision)
        .map((entry) => ({ ...entry, schemaVersion: 1 })),
    },
  };
}

/** Strict validation of a history backup file (every journal entry must parse). */
export function parseHistoryBackupPayload(text: string): HistoryBackupParseResult {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return { ok: false, error: 'invalid' };
    const p = parsed as Record<string, unknown>;
    if (p.app !== 'ganttchart' || p.kind !== 'history-backup') return { ok: false, error: 'invalid' };
    if (typeof p.version !== 'number' || !SUPPORTED_BACKUP_VERSIONS.includes(p.version)) {
      return { ok: false, error: 'invalid' };
    }
    const data = p.data;
    if (typeof data !== 'object' || data === null) return { ok: false, error: 'invalid' };
    const d = data as Record<string, unknown>;
    if (!isAppState(d.appState) || !isReportsState(d.reportsState)) return { ok: false, error: 'invalid' };
    if (!Array.isArray(d.revisions)) return { ok: false, error: 'invalid' };
    const revisions: WorkspaceRevision[] = [];
    let previous = 0;
    for (const raw of d.revisions) {
      const entry = parseRevisionEntry(raw);
      if (entry === null) return { ok: false, error: 'invalid' };
      if (entry.revision <= previous) return { ok: false, error: 'invalid' }; // strictly ascending
      previous = entry.revision;
      revisions.push(entry);
    }
    return {
      ok: true,
      data: {
        appState: normalizeAppState(d.appState),
        reportsState: normalizeReportsState(d.reportsState),
        revisions,
      },
    };
  } catch {
    return { ok: false, error: 'invalid' };
  }
}

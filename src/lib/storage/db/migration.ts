/**
 * localStorage →IndexedDB migration (V6.6 database migration, §10–§15).
 *
 * One-time, idempotent, transaction-safe migration of the V6.3 centralized
 * localStorage persistence into GanttChartDB:
 *
 *   read localStorage →validate (existing V6.3 guards) →normalize
 *   →single IndexedDB transaction →verify →mark complete
 *
 * localStorage is NEVER deleted or rewritten —it is retained as the
 * migration safety fallback (§15). Success is tracked exclusively in the
 * IndexedDB `metadata` store, never by inferring from localStorage content
 * (§12).
 */

import type { AppState, ReportsState } from '../../../types';
import {
  isAppState,
  isLegacyAppState,
  migrateLegacyState,
  normalizeAppState,
  LEGACY_STORAGE_KEY,
  STORAGE_KEY,
  DEMO_STATE,
} from '../storage';
import { isReportsState, normalizeReportsState, defaultReportsState, REPORTS_STORAGE_KEY } from '../reports';
import { readPersistenceMeta } from '../persistence';
import { hasRecoveryPayload, stashCorruptedRaw } from '../corruption';
import {
  META_KEY_APP_STATE,
  META_KEY_COLLECTION,
  META_KEY_PERSISTENCE_META,
  META_KEY_REPORTS_CORE,
  META_KEY_STORAGE_MIGRATION,
  STORE_ATTENDANCE,
  STORE_DAILY_ACTUALS,
  STORE_METADATA,
  STORE_PROJECTS,
  STORE_REPORTS,
  STORE_REVISION_HISTORY,
  STORE_TOPICS,
  getFromStore,
  withReadWriteTx,
} from './repository';
import { assembleReportsState, dailyActualRowKey, jsonEquals, splitWorkspace, type WorkspaceParts } from './workspace';
import { readWorkspaceFromDb } from './workspaceIo';
import { buildManifest, parseManifest, type PersistenceManifest } from './manifest';
import { verifyWorkspaceIntegrity } from './integrity';
import { readLocalFallbackRecord, writeLocalFallbackRecord } from './recovery';

/** Explicit migration map of every discovered V6.3 localStorage key (§10). */
export const LOCAL_STORAGE_MIGRATION_MAP = {
  /** Active-project editing surface (AppState, V2 shape). */
  [STORAGE_KEY]: 'metadata.appState',
  /** Pre-V2 AppState —forward-migrated with the existing migrateLegacyState. */
  [LEGACY_STORAGE_KEY]: 'metadata.appState (forward-migrated to V2)',
  /** Daily-report workspace (ReportsState) —split across projects/reports/dailyActuals/attendance/topics/metadata. */
  [REPORTS_STORAGE_KEY]: 'projects, reports, dailyActuals, attendance, topics, metadata',
  /** UX save metadata (lastSavedAt) —cosmetic only. */
  'ganttchart.meta.v1': 'metadata.persistenceMeta',
  /** Corruption recovery stashes —retained in localStorage verbatim (never auto-loaded, manual recovery only). */
  'ganttchart.recovery.*': 'retained in place (recovery fallback)',
} as const;

/** Migration marker stored in the metadata store once migration completed (§11–§12). */
export interface StorageMigrationRecord {
  source: 'localStorage';
  target: 'indexeddb';
  version: 1;
  status: 'completed' | 'skipped-empty';
  migratedAt: string;
  details: {
    projects: number;
    reports: number;
    snapshots: number;
    attendance: number;
    topics: number;
  };
}

export type MigrationOutcome =
  | { status: 'skipped-empty' }
  | { status: 'completed'; appState: AppState; reports: ReportsState; record: StorageMigrationRecord; revision: number }
  | {
      status: 'failed';
      reason: 'invalid-local-storage' | 'write-failed' | 'verification-failed' | 'integrity-failed' | 'stale-fallback';
    };

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Parse+validate the localStorage app-state keys using the exact V6.3
 * guards (v2 first, then the legacy v1 forward migration). Returns the
 * normalized AppState, `null` when no key exists, or `'invalid'` —invalid
 * payloads are preserved under a recovery key first (existing §22 behavior).
 * localStorage is never modified (unlike loadState, which persists the v1→2
 * migration —here IndexedDB receives the migrated shape instead).
 */
function readAppStateFromLocalStorage(): AppState | null | 'invalid' {
  const rawV2 = readRaw(STORAGE_KEY);
  if (rawV2 !== null) {
    try {
      const parsed: unknown = JSON.parse(rawV2);
      if (isAppState(parsed)) return normalizeAppState(parsed);
    } catch {
      // fall through to the invalid handling below
    }
    if (!hasRecoveryPayload(STORAGE_KEY)) stashCorruptedRaw(STORAGE_KEY, rawV2);
    return 'invalid';
  }
  const rawV1 = readRaw(LEGACY_STORAGE_KEY);
  if (rawV1 !== null) {
    try {
      const parsed: unknown = JSON.parse(rawV1);
      if (isLegacyAppState(parsed)) return migrateLegacyState(parsed);
    } catch {
      // fall through to the invalid handling below
    }
    if (!hasRecoveryPayload(LEGACY_STORAGE_KEY)) stashCorruptedRaw(LEGACY_STORAGE_KEY, rawV1);
    return 'invalid';
  }
  return null;
}

/** Parse+validate the reports payload with the existing guard (recovery-stash on invalid). */
function readReportsStateFromLocalStorage(): ReportsState | null | 'invalid' {
  const raw = readRaw(REPORTS_STORAGE_KEY);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isReportsState(parsed)) return normalizeReportsState(parsed);
  } catch {
    // fall through to the invalid handling below
  }
  if (!hasRecoveryPayload(REPORTS_STORAGE_KEY)) stashCorruptedRaw(REPORTS_STORAGE_KEY, raw);
  return 'invalid';
}

/** True when the browser holds any GanttChart application localStorage key. */
export function hasLegacyLocalStorageData(): boolean {
  try {
    return (
      window.localStorage.getItem(STORAGE_KEY) !== null ||
      window.localStorage.getItem(LEGACY_STORAGE_KEY) !== null ||
      window.localStorage.getItem(REPORTS_STORAGE_KEY) !== null
    );
  } catch {
    return false;
  }
}

function collectionEntries(parts: WorkspaceParts): Array<[string, unknown]> {
  return [
    [META_KEY_COLLECTION.testerAssignments, parts.collections.testerAssignments],
    [META_KEY_COLLECTION.reviews, parts.collections.reviews],
    [META_KEY_COLLECTION.rcsMembers, parts.collections.rcsMembers],
    [META_KEY_COLLECTION.identityAuditLog, parts.collections.identityAuditLog],
    [META_KEY_COLLECTION.externalIdentities, parts.collections.externalIdentities],
    [META_KEY_COLLECTION.cycles, parts.collections.cycles],
    [META_KEY_COLLECTION.scopes, parts.collections.scopes],
    [META_KEY_COLLECTION.testCases, parts.collections.testCases],
    [META_KEY_COLLECTION.caseResults, parts.collections.caseResults],
  ];
}

/** Everything the migration/persistence layer persists, read back from the database. */
export interface WorkspaceDbReadAll {
  appState: unknown;
  parts: WorkspaceParts;
  /** Null when the reports core record was never written (empty database). */
  core: WorkspaceParts['core'] | null;
}

export async function readAllFromDb(): Promise<WorkspaceDbReadAll> {
  const read = await readWorkspaceFromDb();
  const core = read.parts.core.settings !== undefined ? read.parts.core : null;
  return { appState: read.appState, parts: read.parts, core };
}

/**
 * Post-write verification (§14): project/report/snapshot counts and IDs,
 * granular execution fields (via full record fidelity), the reassembled
 * domain state and the committed revision/manifest (V6.7 §4/§12). Reads
 * run after the migration transaction committed.
 */
export async function verifyMigration(
  appState: AppState,
  parts: WorkspaceParts,
  manifest?: PersistenceManifest,
): Promise<boolean> {
  /** Log the exact failed check so a verification-failed banner is traceable in F12. */
  const fail = (reason: string): false => {
    console.warn(`[persistence] migration verification failed: ${reason}`);
    return false;
  };
  const read = await readAllFromDb();
  if (read.core === null) return fail('reports core record missing');
  const byId = <T extends { id: string }>(rows: T[]): Map<string, T> => new Map(rows.map((row) => [row.id, row]));

  // Counts (§14).
  if (read.parts.projects.length !== parts.projects.length) {
    return fail(`projects count: stored ${read.parts.projects.length}, expected ${parts.projects.length}`);
  }
  if (read.parts.reports.length !== parts.reports.length) {
    return fail(`reports count: stored ${read.parts.reports.length}, expected ${parts.reports.length}`);
  }
  if (read.parts.dailyActuals.length !== parts.dailyActuals.length) {
    return fail(`dailyActuals count: stored ${read.parts.dailyActuals.length}, expected ${parts.dailyActuals.length}`);
  }
  if (read.parts.attendance.length !== parts.attendance.length) {
    return fail(`attendance count: stored ${read.parts.attendance.length}, expected ${parts.attendance.length}`);
  }
  if (read.parts.topics.length !== parts.topics.length) {
    return fail(`topics count: stored ${read.parts.topics.length}, expected ${parts.topics.length}`);
  }

  // IDs + full record fidelity (covers the granular execution fields, §14).
  const groups: Array<[string, Array<{ id: string }>, Map<string, unknown>]> = [
    ['projects', parts.projects, byId(read.parts.projects)],
    ['reports', parts.reports, byId(read.parts.reports)],
    ['attendance', parts.attendance, byId(read.parts.attendance)],
    ['topics', parts.topics, byId(read.parts.topics)],
  ];
  for (const [label, expected, actual] of groups) {
    for (const row of expected) {
      const stored = actual.get(row.id);
      if (stored === undefined) return fail(`${label} record ${row.id} missing in database`);
      if (!jsonEquals(stored, row)) return fail(`${label} record ${row.id} differs from the written record`);
    }
  }
  // Snapshots are keyed by the composite projectId::id (ids are unique per project only).
  const snapshotKeys = new Set(read.parts.dailyActuals.map(dailyActualRowKey));
  if (snapshotKeys.size !== read.parts.dailyActuals.length) {
    return fail('dailyActuals composite keys are not unique (duplicate snapshot id within a project?)');
  }
  for (const row of parts.dailyActuals) {
    const key = dailyActualRowKey(row);
    if (!snapshotKeys.has(key)) return fail(`dailyActuals record ${key} missing in database`);
    const stored = read.parts.dailyActuals.find((candidate) => dailyActualRowKey(candidate) === key);
    if (stored === undefined) return fail(`dailyActuals record ${key} missing in database`);
    if (!jsonEquals(stored, row)) return fail(`dailyActuals record ${key} differs from the written record`);
  }

  // Workspace-level parts and the reassembled domain state.
  if (!jsonEquals(read.parts.core, parts.core)) return fail('reports core record differs');
  if (!jsonEquals(read.appState, appState)) return fail('appState record differs');
  if (!jsonEquals(read.parts.collections.testerAssignments, parts.collections.testerAssignments)) {
    return fail('testerAssignments collection differs');
  }
  if (!jsonEquals(read.parts.collections.reviews, parts.collections.reviews)) return fail('reviews collection differs');
  if (!jsonEquals(read.parts.collections.rcsMembers, parts.collections.rcsMembers)) {
    return fail('rcsMembers collection differs');
  }
  if (!jsonEquals(read.parts.collections.identityAuditLog, parts.collections.identityAuditLog)) {
    return fail('identityAuditLog collection differs');
  }
  if (!jsonEquals(read.parts.collections.externalIdentities, parts.collections.externalIdentities)) {
    return fail('externalIdentities collection differs');
  }
  if (!jsonEquals(read.parts.collections.cycles, parts.collections.cycles)) return fail('cycles collection differs');
  if (!jsonEquals(read.parts.collections.scopes, parts.collections.scopes)) return fail('scopes collection differs');
  if (!jsonEquals(read.parts.collections.testCases, parts.collections.testCases)) return fail('testCases collection differs');
  if (!jsonEquals(read.parts.collections.caseResults, parts.collections.caseResults)) return fail('caseResults collection differs');
  if (!jsonEquals(assembleReportsState(read.parts), assembleReportsState(parts))) {
    return fail('reassembled workspace differs from the migrated workspace');
  }
  // V6.7 §4/§12: the committed revision and its manifest must round-trip.
  if (manifest !== undefined) {
    const storedManifest = await getFromStore<unknown>(STORE_METADATA, META_KEY_PERSISTENCE_META);
    const parsed = parseManifest(storedManifest);
    if (parsed === null) return fail('persistence manifest unreadable after write');
    if (!jsonEquals(parsed, manifest)) return fail('persistence manifest differs from the written manifest');
  }
  return true;
}

/**
 * Prepare and run the full migration. All stores — including the persistence
 * manifest that establishes the workspace revision — are written in ONE
 * IndexedDB transaction: on any failure nothing is persisted and localStorage
 * stays untouched (§13). The completion marker is only written AFTER the
 * post-write verification succeeded (§14) and only when the prepared
 * workspace passed the integrity gate (V6.7 §12).
 */
export async function migrateLocalStorageToIndexedDb(nowIso: string): Promise<MigrationOutcome> {
  const appState = readAppStateFromLocalStorage();
  if (appState === 'invalid') return { status: 'failed', reason: 'invalid-local-storage' };
  const reports = readReportsStateFromLocalStorage();
  if (reports === 'invalid') return { status: 'failed', reason: 'invalid-local-storage' };

  if (appState === null && reports === null) {
    // First-time user: nothing to migrate —initialize IndexedDB normally (§19).
    const record: StorageMigrationRecord = {
      source: 'localStorage',
      target: 'indexeddb',
      version: 1,
      status: 'skipped-empty',
      migratedAt: nowIso,
      details: { projects: 0, reports: 0, snapshots: 0, attendance: 0, topics: 0 },
    };
    await withReadWriteTx([STORE_METADATA], (get) => {
      get(STORE_METADATA).put(record, META_KEY_STORAGE_MIGRATION);
    });
    return { status: 'skipped-empty' };
  }

  // V6.7 §5/§12: never migrate a localStorage copy that is known to be stale.
  const fallbackRecord = readLocalFallbackRecord();
  if (fallbackRecord !== null && fallbackRecord.authoritativeRevision > fallbackRecord.revision) {
    return { status: 'failed', reason: 'stale-fallback' };
  }
  // Preserve an existing valid revision (e.g. a localStorage-backend session
  // that wrote revisions before IndexedDB came back); never reset it to zero.
  const initialRevision = fallbackRecord !== null && fallbackRecord.revision > 0 ? fallbackRecord.revision : 1;

  // Exactly what the V6.3 loaders would return —including forward migration
  // of legacy shapes and backfilled defaults —persisted into IndexedDB.
  const preparedApp: AppState = appState ?? { ...DEMO_STATE };
  const preparedReports: ReportsState = reports ?? defaultReportsState();
  const { parts } = splitWorkspace(preparedApp, preparedReports);

  // Integrity gate (V6.7 §12): a structurally invalid workspace is not
  // migrated, and the source data is left untouched.
  const manifest = buildManifest({
    revision: initialRevision,
    backend: 'indexeddb',
    integrityStatus: 'verified',
    committedAt: nowIso,
    lastSavedAt: readPersistenceMeta().lastSavedAt,
    lastMigrationAt: nowIso,
  });
  const integrity = verifyWorkspaceIntegrity(preparedReports, manifest, parts.dailyActuals);
  if (integrity.status === 'failed') {
    return { status: 'failed', reason: 'integrity-failed' };
  }
  const migrationManifest = buildManifest({
    revision: initialRevision,
    backend: 'indexeddb',
    integrityStatus: integrity.status,
    committedAt: nowIso,
    lastSavedAt: readPersistenceMeta().lastSavedAt,
    lastMigrationAt: nowIso,
  });

  try {
    await withReadWriteTx(
      [STORE_PROJECTS, STORE_REPORTS, STORE_DAILY_ACTUALS, STORE_ATTENDANCE, STORE_TOPICS, STORE_METADATA, STORE_REVISION_HISTORY],
      (get) => {
        // A marker-less database is NOT a committed workspace (§11–§12): it
        // may hold leftover rows from an interrupted earlier attempt or a
        // partially reset browser profile. Clear every store first so the
        // migration rebuilds the database EXACTLY from localStorage —
        // otherwise leftover rows survive the put-only writes, the read-back
        // verification fails on the count mismatch, and the app is stuck in
        // a permanent verification-failed retry loop.
        for (const store of [
          STORE_PROJECTS,
          STORE_REPORTS,
          STORE_DAILY_ACTUALS,
          STORE_ATTENDANCE,
          STORE_TOPICS,
          STORE_METADATA,
          STORE_REVISION_HISTORY,
        ]) {
          get(store).clear();
        }
        const projects = get(STORE_PROJECTS);
        for (const project of parts.projects) projects.put(project);
        const dailyActuals = get(STORE_DAILY_ACTUALS);
        for (const row of parts.dailyActuals) dailyActuals.put(row, dailyActualRowKey(row));
        const reportStore = get(STORE_REPORTS);
        for (const report of parts.reports) reportStore.put(report);
        const attendance = get(STORE_ATTENDANCE);
        for (const record of parts.attendance) attendance.put(record);
        const topics = get(STORE_TOPICS);
        for (const topic of parts.topics) topics.put(topic);
        const meta = get(STORE_METADATA);
        meta.put(preparedApp, META_KEY_APP_STATE);
        meta.put(parts.core, META_KEY_REPORTS_CORE);
        for (const [key, value] of collectionEntries(parts)) meta.put(value, key);
        // The manifest commits in the same transaction as the data (V6.7 §4/§12).
        meta.put(migrationManifest, META_KEY_PERSISTENCE_META);
      },
    );
  } catch {
    return { status: 'failed', reason: 'write-failed' };
  }

  let verified = false;
  try {
    verified = await verifyMigration(preparedApp, parts, migrationManifest);
  } catch {
    verified = false;
  }
  if (!verified) return { status: 'failed', reason: 'verification-failed' };

  const record: StorageMigrationRecord = {
    source: 'localStorage',
    target: 'indexeddb',
    version: 1,
    status: 'completed',
    migratedAt: nowIso,
    details: {
      projects: parts.projects.length,
      reports: parts.reports.length,
      snapshots: parts.dailyActuals.length,
      attendance: parts.attendance.length,
      topics: parts.topics.length,
    },
  };
  try {
    await withReadWriteTx([STORE_METADATA], (get) => {
      get(STORE_METADATA).put(record, META_KEY_STORAGE_MIGRATION);
    });
  } catch {
    return { status: 'failed', reason: 'write-failed' };
  }

  // V6.7 §5: the retained localStorage copy is now exactly revision
  // `initialRevision` — record it so staleness is detectable later.
  writeLocalFallbackRecord({ revision: initialRevision, authoritativeRevision: initialRevision, committedAt: nowIso });

  return { status: 'completed', appState: preparedApp, reports: preparedReports, record, revision: initialRevision };
}

/** Read the current migration marker (null when migration has not run yet). */
export async function readStorageMigrationRecord(): Promise<StorageMigrationRecord | null> {
  const record = await getFromStore<StorageMigrationRecord>(STORE_METADATA, META_KEY_STORAGE_MIGRATION);
  return record ?? null;
}

/** Test hook: read the database back and rebuild the domain ReportsState. */
export async function readMigratedReportsForTests(): Promise<ReportsState | null> {
  const read = await readAllFromDb();
  if (read.core === null) return null;
  return assembleReportsState(read.parts);
}

/** Test hook: read the stored AppState record. */
export async function readMigratedAppStateForTests(): Promise<AppState | null> {
  const appState = await getFromStore<AppState>(STORE_METADATA, META_KEY_APP_STATE);
  return appState ?? null;
}

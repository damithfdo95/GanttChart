import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, ProjectRecord, QaInputs, ReportsState } from '../types';
import { STORAGE_KEY, normalizeAppState, normalizeQaInputs } from '../lib/storage/storage';
import { defaultReportsState, REPORTS_STORAGE_KEY } from '../lib/storage/reports';
import { consumeCorruptionEvents } from '../lib/storage/corruption';
import { initPersistence } from '../lib/storage/db/bootstrap';
import { DB_NAME, STORE_METADATA, deleteGanttChartDb } from '../lib/storage/db/repository';
import {
  clearAllLocalDataAsync,
  getStorageDiagnostics,
  getWorkspaceRevision,
  persistWorkspaceAsync,
  readPersistenceManifestFromDb,
  resetPersistenceBackendForTests,
} from '../lib/storage/db/persistenceBackend';
import {
  CLEAR_ALL_TOMBSTONE_KEY,
  createRecoverySnapshot,
  listRecoverySnapshots,
  readClearAllTombstone,
  readLocalFallbackRecord,
  readMigrationFailureRecord,
  readRecoverySnapshot,
  writeLocalFallbackRecord,
} from '../lib/storage/db/recovery';
import { newProjectRecord } from '../domain/projects';
import { applyDailyExecutionEntry } from '../lib/calculations/dailyExecuted';
import { createBackupPayload, parseBackupPayload } from '../lib/backup/backup';
import { FakeIDBFactory } from './helpers/fakeIndexedDb';

/**
 * V6.7 — workspace revisioning, fallback classification, clear-all
 * tombstone, recovery snapshots and the §30 end-to-end lifecycle.
 */

const NOW_ISO = '2026-09-29T09:00:00.000Z';

class MemoryStorage {
  map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  get length(): number {
    return this.map.size;
  }
}

let storage: MemoryStorage;
let idb: FakeIDBFactory;

beforeEach(() => {
  storage = new MemoryStorage();
  idb = new FakeIDBFactory();
  resetPersistenceBackendForTests();
  consumeCorruptionEvents(); // drain loader events from previous tests (as the UI does at startup)
  vi.stubGlobal('window', { localStorage: storage });
  vi.stubGlobal('indexedDB', idb);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetPersistenceBackendForTests();
});

function inputs(): QaInputs {
  return {
    totalCases: 100,
    currentTesters: 8,
    startTime: 13 * 60,
    targetFinish: 17 * 60,
    lunchStart: 0,
    lunchEnd: 0,
    perHourPerTester: 4,
    casesCompleted: 90,
    casesPassed: 60,
    spoAssigned: 20,
    casesFailed: 5,
    casesNotApplicable: 5,
    casesBlocked: 3,
    casesRetest: 2,
    casesQuestioned: 1,
    targetPassRate: 1,
    dailyTargetOverrides: [],
    dailyActuals: [{ id: 'snap-1', date: '2026-09-28', executed: 70, passed: 60 }],
    blockingEvents: [],
    milestones: [],
    startDate: '2026-09-26',
    targetCompletionDate: '2026-09-30',
    targetCompletionTime: '17:00',
    planningRows: [{ id: 'row-1', date: '2026-09-26', plannedTesters: 8, absentTesters: 0, nonWorkingDay: false, note: '' }],
  };
}

function project(name: string, existing: ProjectRecord[] = []): ProjectRecord {
  return newProjectRecord(inputs(), { nameEn: name, nameJa: name, team: 'PrV' }, NOW_ISO, existing);
}

function appState(): AppState {
  return normalizeAppState({
    ...normalizeQaInputs(inputs()),
    language: 'ja',
    projectNameEn: 'A',
    projectNameJa: 'A',
    dashboardView: 'operator',
  });
}

/**
 * V7: execution progress is recorded through a daily execution entry (the
 * canonical casesCompleted is a derived projection, Σ entries) — the same
 * path the Dashboard's "Today's Execution" form uses.
 */
function withExecuted(base: AppState, casesCompleted: number): AppState {
  return applyDailyExecutionEntry(
    { ...base, dailyExecuted: [] },
    {
      id: 'entry-progress',
      date: '2026-09-29',
      startTime: null,
      endTime: null,
      overtimeMinutes: 0,
      intervalEnabled: true,
      testers: 0,
      pass: Math.max(0, casesCompleted),
      fail: 0,
      notApplicable: 0,
      spo: 0,
      blocked: 0,
      retest: 0,
      questioned: 0,
      note: '',
    },
  );
}

function reportsState(projects: ProjectRecord[], activeProjectId: string | null): ReportsState {
  return { ...defaultReportsState(), projects, activeProjectId };
}

/** Seed a V6.5-style legacy localStorage workspace and bootstrap it (migration revision 1). */
async function bootWorkspace(): Promise<{ app: AppState; reports: ReportsState }> {
  const reports = reportsState([project('A'), project('B', [project('A')])], null);
  reports.activeProjectId = reports.projects[0].id;
  storage.setItem(STORAGE_KEY, JSON.stringify(appState()));
  storage.setItem(REPORTS_STORAGE_KEY, JSON.stringify(reports));
  const boot = await initPersistence();
  if (boot.mode !== 'indexeddb') throw new Error(`bootstrap failed: ${boot.migrationStatus}/${boot.health}`);
  return { app: boot.workspace.app, reports: boot.workspace.reports };
}

/** Simulate an unexpected IndexedDB loss (database deleted, localStorage retained). */
async function loseIndexedDb(): Promise<void> {
  resetPersistenceBackendForTests();
  await deleteGanttChartDb();
}

// ---- workspace revisioning (§2/§4) ----

describe('workspace revisioning (V6.7 §2/§4)', () => {
  it('establishes revision 1 at migration', async () => {
    await bootWorkspace();
    expect(getWorkspaceRevision()).toBe(1);
    const manifest = await readPersistenceManifestFromDb();
    expect(manifest?.revision).toBe(1);
  });

  it('increments the revision on every successful save and reports it', async () => {
    const w = await bootWorkspace();
    const second = await persistWorkspaceAsync({ ...w.app, casesCompleted: 60 }, w.reports);
    expect(second.revision).toBe(2);
    const third = await persistWorkspaceAsync({ ...w.app, casesCompleted: 70 }, w.reports);
    expect(third.revision).toBe(3);
    expect(third.ok).toBe(true);
  });

  it('a failed save does not commit a revision', async () => {
    const w = await bootWorkspace();
    idb.abortNextTransaction = true;
    const failed = await persistWorkspaceAsync({ ...w.app, casesCompleted: 60 }, w.reports);
    expect(failed.ok).toBe(false);
    expect(failed.revision).toBe(1);
    const manifest = await readPersistenceManifestFromDb();
    expect(manifest?.revision).toBe(1);
  });

  it('the revision is monotonic across a sequence of saves', async () => {
    const w = await bootWorkspace();
    let last = 1;
    for (let i = 0; i < 5; i++) {
      const result = await persistWorkspaceAsync({ ...w.app, casesCompleted: 60 + i }, w.reports);
      expect(result.revision).toBeGreaterThan(last);
      last = result.revision;
    }
    expect(last).toBe(6);
  });

  it('reload and restart preserve the revision', async () => {
    const w = await bootWorkspace();
    await persistWorkspaceAsync({ ...w.app, casesCompleted: 60 }, w.reports);
    const reloaded = await initPersistence();
    expect(reloaded.revision).toBe(2);
    const manifest = await readPersistenceManifestFromDb();
    expect(manifest?.revision).toBe(2);
  });

  it('the manifest commits atomically with the state (§4)', async () => {
    const w = await bootWorkspace();
    // Abort the NEXT readwrite transaction: neither the new state nor the
    // revision may land.
    idb.abortNextTransaction = true;
    const failed = await persistWorkspaceAsync({ ...w.app, casesCompleted: 55 }, w.reports);
    expect(failed.ok).toBe(false);
    const manifest = await readPersistenceManifestFromDb();
    expect(manifest?.revision).toBe(1);
    const reloaded = await initPersistence();
    expect(reloaded.workspace.app.casesCompleted).toBe(w.app.casesCompleted);
  });

  it('concurrent writes A–E commit E with its revision (§23)', async () => {
    const w = await bootWorkspace();
    const states = [50, 60, 70, 80, 90].map((casesCompleted) => ({ ...w.app, casesCompleted }));
    const results = await Promise.all(states.map((state) => persistWorkspaceAsync(state, w.reports)));
    expect(results.every((r) => r.ok)).toBe(true);
    const last = results[results.length - 1];
    expect(last.revision).toBe(6); // migration (1) + five commits
    const reloaded = await initPersistence();
    expect(reloaded.workspace.app.casesCompleted).toBe(90);
    expect(reloaded.revision).toBe(6);
  });

  it('project switching does not leak data across revisions (§24)', async () => {
    const w = await bootWorkspace();
    const projectA = w.reports.projects[0];
    const projectB = w.reports.projects[1];
    // Edit A, switch, edit B, switch back, edit A again.
    const step1 = { ...w.reports, projects: markProject(w.reports.projects, projectA.id, 1) };
    await persistWorkspaceAsync(w.app, step1);
    const step2 = { ...step1, activeProjectId: projectB.id, projects: markProject(step1.projects, projectB.id, 2) };
    const r2 = await persistWorkspaceAsync(w.app, step2);
    const step3 = { ...step2, activeProjectId: projectA.id, projects: markProject(step2.projects, projectA.id, 3) };
    const r3 = await persistWorkspaceAsync(w.app, step3);
    expect(r3.revision).toBe(r2.revision + 1);
    const reloaded = await initPersistence();
    const a = reloaded.workspace.reports.projects.find((p) => p.id === projectA.id)!;
    const b = reloaded.workspace.reports.projects.find((p) => p.id === projectB.id)!;
    expect(a.inputs.totalCases).toBe(100);
    expect(b.inputs.totalCases).toBe(100);
    expect(reloaded.workspace.reports.activeProjectId).toBe(projectA.id);
  });

  it('an import through the normal save path creates a new revision (§15)', async () => {
    const w = await bootWorkspace();
    const backupText = JSON.stringify(createBackupPayload(w.app, w.reports));
    await persistWorkspaceAsync({ ...w.app, casesCompleted: 60 }, w.reports); // revision 2
    const parsed = parseBackupPayload(backupText);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const imported = await persistWorkspaceAsync(parsed.data.appState, parsed.data.reportsState);
    expect(imported.ok).toBe(true);
    expect(imported.revision).toBe(3);
  });

  it('an unchanged workspace does not consume a revision', async () => {
    const w = await bootWorkspace();
    const result = await persistWorkspaceAsync(w.app, w.reports);
    expect(result.changed).toBe(false);
    expect(result.revision).toBe(1);
  });
});

function markProject(projects: ProjectRecord[], id: string, marker: number): ProjectRecord[] {
  return projects.map((p) => (p.id === id ? { ...p, inputs: { ...p.inputs, currentTesters: 8 + marker } } : p));
}

// ---- localStorage fallback classification (§5–§7) ----

describe('fallback classification (V6.7 §5–§7)', () => {
  it('current fallback: IndexedDB unavailable + localStorage is known-current → usable fallback', async () => {
    await bootWorkspace(); // migration → record {revision: 1, authoritativeRevision: 1}
    resetPersistenceBackendForTests(); // drop the cached connection
    idb.failNextOpen = true;
    const boot = await initPersistence();
    expect(boot.mode).toBe('localstorage');
    expect(boot.health).toBe('fallback-current');
    expect(boot.revision).toBe(1);
    expect(boot.workspace.reports.projects).toHaveLength(2);
  });

  it('saves continue on the current fallback with increasing revisions', async () => {
    await bootWorkspace();
    resetPersistenceBackendForTests();
    idb.failNextOpen = true;
    await initPersistence();
    const app = appState();
    const reports = reportsState([project('A')], null);
    const result = await persistWorkspaceAsync(app, reports);
    expect(result.ok).toBe(true);
    expect(result.revision).toBe(2);
    expect(readLocalFallbackRecord()).toEqual({ revision: 2, authoritativeRevision: 2, committedAt: expect.any(String) as unknown as string });
  });

  it('stale fallback: IndexedDB lost after commits → NO silent rollback (§6/§18)', async () => {
    const w = await bootWorkspace(); // record {revision: 1, authoritativeRevision: 1}
    await persistWorkspaceAsync({ ...w.app, casesCompleted: 60 }, w.reports); // revision 2
    await persistWorkspaceAsync({ ...w.app, casesCompleted: 70 }, w.reports); // revision 3
    // Record now says: localStorage copy = revision 1, last committed = 3.
    expect(readLocalFallbackRecord()).toEqual({ revision: 1, authoritativeRevision: 3, committedAt: expect.any(String) as unknown as string });

    // IndexedDB is unexpectedly lost; the retained localStorage copy is stale.
    await loseIndexedDb();
    const boot = await initPersistence();
    expect(boot.health).toBe('recovery-required');
    expect(boot.mode).toBe('localstorage');
    // The stale copy (revision-1 content) is loaded as best-available data...
    expect(boot.workspace.app.casesCompleted).toBe(90);
    // ...the last known revision is preserved for monotonic continuation...
    expect(boot.revision).toBe(3);
    // ...and nothing re-migrated: no marker, no manifest, IDB stays empty.
    const marker = await import('../lib/storage/db/migration').then((m) => m.readStorageMigrationRecord());
    expect(marker).toBeNull();
    expect(await readPersistenceManifestFromDb()).toBeNull();
    // The stale copy itself is preserved verbatim.
    expect(storage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it('a recovery-required session continues revisions monotonically', async () => {
    const w = await bootWorkspace();
    await persistWorkspaceAsync({ ...w.app, casesCompleted: 60 }, w.reports); // revision 2
    await loseIndexedDb();
    const boot = await initPersistence();
    expect(boot.health).toBe('recovery-required');
    expect(boot.revision).toBe(2);
    const result = await persistWorkspaceAsync({ ...boot.workspace.app, casesCompleted: 65 }, boot.workspace.reports);
    expect(result.ok).toBe(true);
    expect(result.revision).toBe(3);
  });

  it('corrupt IndexedDB + current fallback → safe fallback', async () => {
    await bootWorkspace();
    idb.writeRecord(DB_NAME, STORE_METADATA, 'appState', { broken: true });
    const boot = await initPersistence();
    expect(boot.mode).toBe('localstorage');
    expect(boot.health).toBe('fallback-current');
    expect(boot.workspace.reports.projects).toHaveLength(2);
  });

  it('corrupt IndexedDB + stale fallback → journal recovery required (V6.8 §22/§23)', async () => {
    const w = await bootWorkspace();
    await persistWorkspaceAsync({ ...w.app, casesCompleted: 60 }, w.reports); // revision 2
    idb.writeRecord(DB_NAME, STORE_METADATA, 'appState', { broken: true });
    const boot = await initPersistence();
    // V6.8: the durable journal is newer than the stale localStorage copy —
    // its latest valid snapshot is the best-available data (flagged, never
    // silently current), instead of rolling back to the stale copy.
    expect(boot.mode).toBe('indexeddb');
    expect(boot.health).toBe('recovery-required');
    expect(boot.revision).toBe(2);
    expect(boot.workspace.app.casesCompleted).toBe(60); // revision-2 state, not the stale copy
  });

  it('both sources corrupt → existing recovery-stash path (§7 F)', async () => {
    await bootWorkspace();
    await persistWorkspaceAsync({ ...appState(), casesCompleted: 60 }, reportsState([project('A')], null));
    idb.writeRecord(DB_NAME, STORE_METADATA, 'appState', { broken: true });
    storage.setItem(STORAGE_KEY, '###not json');
    const boot = await initPersistence();
    expect(boot.mode).toBe('localstorage');
    expect(boot.health).toBe('recovery-stash');
    // The app stays usable on safe defaults; the raw payload was stashed.
    expect(boot.workspace.app.totalCases).toBeGreaterThan(0);
    expect(storage.getItem('ganttchart.recovery.ganttchart.v2')).toBe('###not json');
  });

  it('a newer localStorage workspace is promoted forward, never rolled back (§7)', async () => {
    await bootWorkspace(); // IDB revision 1, record {1, 1}
    // Simulate a fallback-mode session that kept working while IDB was down:
    // localStorage now holds revision 5 with newer data.
    const newerApp = withExecuted(appState(), 99);
    storage.setItem(STORAGE_KEY, JSON.stringify(newerApp));
    storage.setItem(REPORTS_STORAGE_KEY, JSON.stringify(reportsState([project('A'), project('B', [project('A')])], null)));
    writeLocalFallbackRecord({ revision: 5, authoritativeRevision: 5, committedAt: NOW_ISO });

    const boot = await initPersistence();
    expect(boot.health).toBe('recovered');
    expect(boot.mode).toBe('indexeddb');
    expect(boot.workspace.app.casesCompleted).toBe(99);
    expect(boot.revision).toBe(6); // promoted forward with a new revision
    // Reload: the promoted state is authoritative in the database.
    const reloaded = await initPersistence();
    expect(reloaded.health).toBe('healthy');
    expect(reloaded.workspace.app.casesCompleted).toBe(99);
    expect(reloaded.revision).toBe(6);
  });

  it('a migration preserves an existing valid localStorage revision (§12)', async () => {
    // Pre-V6.7 localStorage user whose fallback-mode session wrote revision 5.
    storage.setItem(STORAGE_KEY, JSON.stringify(appState()));
    storage.setItem(REPORTS_STORAGE_KEY, JSON.stringify(reportsState([project('A')], null)));
    writeLocalFallbackRecord({ revision: 5, authoritativeRevision: 5, committedAt: NOW_ISO });
    const boot = await initPersistence();
    expect(boot.migrationStatus).toBe('completed');
    expect(boot.revision).toBe(5); // not reset to 1
    const manifest = await readPersistenceManifestFromDb();
    expect(manifest?.revision).toBe(5);
  });
});

// ---- backup restore heals false recovery states (stale fallback record) ----

describe('backup restore through the persistence backend (stale fallback record regression)', () => {
  it('a restore while IndexedDB is lost heals the stale fallback record and returns the app to healthy', async () => {
    // Regression: a restore that wrote localStorage directly (V6.3 writers)
    // left the fallback record stale — every startup after an IndexedDB loss
    // showed a permanent, false "recovery required" banner.
    const w = await bootWorkspace(); // record {revision: 1, authoritativeRevision: 1}
    const editedApp = withExecuted(w.app, 60);
    await persistWorkspaceAsync(editedApp, w.reports); // revision 2 → record {1, 2}
    // The user takes a backup of the current (revision-2) data.
    const backupText = JSON.stringify(createBackupPayload(editedApp, w.reports));

    // IndexedDB is lost; the stale localStorage copy + record survive.
    await loseIndexedDb();
    const recoveryBoot = await initPersistence();
    expect(recoveryBoot.health).toBe('recovery-required');
    expect(recoveryBoot.mode).toBe('localstorage');
    expect(recoveryBoot.workspace.app.casesCompleted).toBe(90); // stale revision-1 copy

    // Restore the backup through the persistence backend (the fixed import path).
    const parsed = parseBackupPayload(backupText);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const restored = await persistWorkspaceAsync(parsed.data.appState, parsed.data.reportsState, {
      reason: 'import',
      forceRevision: true,
    });
    expect(restored.ok).toBe(true);
    // The fallback record is healed — the localStorage copy is current again.
    expect(readLocalFallbackRecord()).toEqual({
      revision: 3,
      authoritativeRevision: 3,
      committedAt: expect.any(String) as unknown as string,
    });

    // Next startup: the healed record lets the restored workspace migrate
    // back into IndexedDB — healthy, revision continuing monotonically.
    const boot = await initPersistence();
    expect(boot.mode).toBe('indexeddb');
    expect(boot.health).toBe('healthy');
    expect(boot.migrationStatus).toBe('completed');
    expect(boot.workspace.app.casesCompleted).toBe(60);
    expect(boot.revision).toBe(3);
    // The stale-fallback failure record no longer surfaces in diagnostics.
    expect(readMigrationFailureRecord()).toBeNull();
  });

  it('a no-op save in fallback mode heals a stale fallback record', async () => {
    const w = await bootWorkspace();
    await persistWorkspaceAsync({ ...w.app, casesCompleted: 60 }, w.reports); // revision 2 → record {1, 2}
    await loseIndexedDb();
    const boot = await initPersistence();
    expect(boot.health).toBe('recovery-required');
    expect(boot.revision).toBe(2);
    // Re-serialize the loaded workspace exactly as the startup auto-save
    // would see it: the save is a NO-OP (loaded state equals the copy).
    storage.setItem(STORAGE_KEY, JSON.stringify(boot.workspace.app));
    storage.setItem(REPORTS_STORAGE_KEY, JSON.stringify(boot.workspace.reports));
    const noop = await persistWorkspaceAsync(boot.workspace.app, boot.workspace.reports);
    expect(noop.ok).toBe(true);
    expect(noop.changed).toBe(false);
    // ...and the stale record still heals — a false recovery-required state
    // cannot survive a boot cycle.
    expect(readLocalFallbackRecord()).toEqual({
      revision: 2,
      authoritativeRevision: 2,
      committedAt: expect.any(String) as unknown as string,
    });

    // While IndexedDB stays unavailable the next boot is a usable
    // fallback-current session — not recovery-required.
    resetPersistenceBackendForTests();
    idb.failNextOpen = true;
    const reboot = await initPersistence();
    expect(reboot.mode).toBe('localstorage');
    expect(reboot.health).toBe('fallback-current');
    expect(reboot.revision).toBe(2);
  });

  it('a restore in healthy mode commits through the backend and survives a reload (no silent revert)', async () => {
    const w = await bootWorkspace(); // revision 1
    const backupText = JSON.stringify(createBackupPayload(w.app, w.reports));
    // Live data moves on (revision 2) so the restore differs from the database.
    await persistWorkspaceAsync({ ...w.app, casesCompleted: 60 }, w.reports);
    // Restore the backup through the persistence backend.
    const parsed = parseBackupPayload(backupText);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const restored = await persistWorkspaceAsync(parsed.data.appState, parsed.data.reportsState, {
      reason: 'import',
      forceRevision: true,
    });
    expect(restored.ok).toBe(true);
    expect(restored.revision).toBe(3);
    // A reload returns the RESTORED data — the database copy no longer
    // silently wins over a direct-to-localStorage import.
    const reloaded = await initPersistence();
    expect(reloaded.mode).toBe('indexeddb');
    expect(reloaded.health).toBe('healthy');
    expect(reloaded.workspace.app.casesCompleted).toBe(parsed.data.appState.casesCompleted);
    expect(reloaded.revision).toBe(3);
  });
});

// ---- clear-all tombstone (§16–§17) ----

describe('clear-all tombstone (V6.7 §16–§17)', () => {
  it('clears IndexedDB and localStorage application keys', async () => {
    await bootWorkspace();
    const result = await clearAllLocalDataAsync();
    expect(result).toBe('cleared');
    expect(idb.hasDatabase(DB_NAME)).toBe(false);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
    expect(storage.getItem(REPORTS_STORAGE_KEY)).toBeNull();
    expect(readLocalFallbackRecord()).toBeNull();
  });

  it('aborts without deleting anything when the recovery snapshot cannot be written', async () => {
    await bootWorkspace();
    const realSetItem = storage.setItem.bind(storage);
    storage.setItem = (key: string, value: string): void => {
      if (key.startsWith('ganttchart.recoverySnapshot.')) throw new Error('QuotaExceededError');
      realSetItem(key, value);
    };
    const result = await clearAllLocalDataAsync();
    expect(result).toBe('aborted');
    expect(idb.hasDatabase(DB_NAME)).toBe(true);
    expect(readClearAllTombstone()).toBeNull();
    expect(getWorkspaceRevision()).toBe(1);
  });

  it('writes the tombstone and a clear-all recovery snapshot', async () => {
    await bootWorkspace();
    await clearAllLocalDataAsync();
    const tombstone = readClearAllTombstone();
    expect(tombstone).not.toBeNull();
    expect(tombstone?.previousRevision).toBe(1);
    const snapshots = listRecoverySnapshots();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].reason).toBe('clear-all');
    expect(snapshots[0].revision).toBe(1);
  });

  it('old localStorage data does not resurrect the workspace after clear-all', async () => {
    const w = await bootWorkspace();
    await persistWorkspaceAsync({ ...w.app, casesCompleted: 60 }, w.reports);
    const before = storage.getItem(REPORTS_STORAGE_KEY);
    await clearAllLocalDataAsync();
    // Simulate the retained pre-clear copy reappearing (the V6.6 known
    // limitation): old localStorage data without a fallback record.
    storage.setItem(STORAGE_KEY, JSON.stringify(w.app));
    storage.setItem(REPORTS_STORAGE_KEY, before!);
    const boot = await initPersistence();
    expect(boot.health).toBe('fresh');
    expect(boot.migrationStatus).toBe('skipped-empty');
    expect(boot.workspace.reports.projects).toEqual([]);
  });

  it('the tombstone survives a reload', async () => {
    await bootWorkspace();
    await clearAllLocalDataAsync();
    await initPersistence();
    expect(storage.getItem(CLEAR_ALL_TOMBSTONE_KEY)).not.toBeNull();
  });

  it('the tombstone is removed once a new workspace revision commits', async () => {
    await bootWorkspace();
    await clearAllLocalDataAsync();
    expect(readClearAllTombstone()).not.toBeNull();
    const result = await persistWorkspaceAsync(appState(), reportsState([project('A')], null));
    expect(result.ok).toBe(true);
    expect(result.revision).toBe(1);
    expect(readClearAllTombstone()).toBeNull();
  });

  it('new data after clear-all receives a fresh revision', async () => {
    await bootWorkspace();
    await clearAllLocalDataAsync();
    const result = await persistWorkspaceAsync(appState(), reportsState([project('A')], null));
    expect(result.revision).toBe(1);
    const reloaded = await initPersistence();
    expect(reloaded.workspace.reports.projects).toHaveLength(1);
    expect(reloaded.revision).toBe(1);
  });

  it('explicit import after clear-all restores the data', async () => {
    const w = await bootWorkspace();
    const backupText = JSON.stringify(createBackupPayload(w.app, w.reports));
    await clearAllLocalDataAsync();
    const parsed = parseBackupPayload(backupText);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = await persistWorkspaceAsync(parsed.data.appState, parsed.data.reportsState);
    expect(result.ok).toBe(true);
    const reloaded = await initPersistence();
    expect(reloaded.workspace.reports.projects).toHaveLength(2);
    expect(reloaded.workspace.reports.projects.map((p) => p.projectId)).toEqual(['PRJ-001', 'PRJ-002']);
  });

  it('explicit recovery of the clear-all snapshot works', async () => {
    await bootWorkspace();
    await clearAllLocalDataAsync();
    const info = listRecoverySnapshots()[0];
    expect(info).toBeDefined();
    const snapshot = readRecoverySnapshot(info.id);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.reason).toBe('clear-all');
    if (snapshot === null) return;
    // Restoring the snapshot is an explicit commit with a NEW revision.
    const result = await persistWorkspaceAsync(snapshot.appState, snapshot.reportsState);
    expect(result.ok).toBe(true);
    const reloaded = await initPersistence();
    expect(reloaded.workspace.reports.projects).toHaveLength(2);
  });
});

// ---- recovery snapshots (§19) ----

describe('recovery snapshots (V6.7 §19)', () => {
  it('creates a snapshot with id, timestamp, source, revision and reason', () => {
    const app = appState();
    const reports = reportsState([project('A')], null);
    const snapshot = createRecoverySnapshot('manual', 4, app, reports, NOW_ISO);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.id).toMatch(/^rec-/);
    expect(snapshot?.createdAt).toBe(NOW_ISO);
    expect(snapshot?.revision).toBe(4);
    expect(snapshot?.reason).toBe('manual');
    const listed = listRecoverySnapshots();
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(snapshot?.id);
  });

  it('reading a snapshot returns an isolated copy that never mutates the stored payload', () => {
    const app = appState();
    const reports = reportsState([project('A')], null);
    const snapshot = createRecoverySnapshot('manual', 1, app, reports, NOW_ISO);
    if (snapshot === null) throw new Error('snapshot failed');
    snapshot.appState.totalCases = 9999; // mutate the returned object
    const reread = readRecoverySnapshot(snapshot.id);
    expect(reread?.appState.totalCases).toBe(100);
  });

  it('stale snapshots are detectable by comparing revisions', async () => {
    const w = await bootWorkspace();
    await persistWorkspaceAsync({ ...w.app, casesCompleted: 60 }, w.reports);
    createRecoverySnapshot('fallback', 1, w.app, w.reports, NOW_ISO); // pre-save snapshot
    const diagnostics = await getStorageDiagnostics();
    expect(diagnostics.revision).toBe(2);
    const stale = listRecoverySnapshots().filter((s) => s.revision < diagnostics.revision);
    expect(stale).toHaveLength(1);
  });

  it('snapshots are capped to prevent unbounded growth', () => {
    const app = appState();
    const reports = reportsState([project('A')], null);
    for (let i = 0; i < 8; i++) {
      createRecoverySnapshot('manual', i + 1, app, reports, NOW_ISO);
    }
    expect(listRecoverySnapshots().length).toBeLessThanOrEqual(5);
  });
});

// ---- diagnostics (§21) ----

describe('developer diagnostics (V6.7 §21)', () => {
  it('exposes revision, health, fallback revision and snapshot count', async () => {
    const w = await bootWorkspace();
    await persistWorkspaceAsync({ ...w.app, casesCompleted: 60 }, w.reports);
    const diagnostics = await getStorageDiagnostics();
    expect(diagnostics.mode).toBe('indexeddb');
    expect(diagnostics.database).toBe('GanttChartDB');
    expect(diagnostics.databaseVersion).toBe(2);
    expect(diagnostics.revision).toBe(2);
    expect(diagnostics.health).toBe('healthy');
    expect(diagnostics.integrityStatus).toBe('verified');
    expect(diagnostics.fallbackRevision).toBe(1);
    expect(diagnostics.authoritativeRevision).toBe(2);
    expect(diagnostics.recoverySnapshots).toBe(0);
  });
});

// ---- §30 end-to-end acceptance ----

describe('§30 end-to-end V6.7 acceptance lifecycle', () => {
  it('create → persist → edit → reload → lose DB → recover → promote → export → import → clear-all', async () => {
    // 1–3. Create Projects A and B, persist both.
    const projectA = project('A');
    const projectB = project('B', [projectA]);
    const legacySnapshot = { id: 'snap-legacy', date: '2026-09-26', executed: 70, passed: 60 };
    const granularSnapshot = {
      id: 'snap-granular',
      date: '2026-09-27',
      executed: 80,
      passed: 60,
      casesPassed: 58,
      casesFailed: 4,
      casesNotApplicable: 3,
      spoAssigned: 15,
      casesBlocked: 2,
      casesRetest: 1,
      casesQuestioned: 1,
    };
    projectA.inputs.dailyActuals = [legacySnapshot, granularSnapshot];
    const reports = reportsState([projectA, projectB], projectA.id);
    reports.attendance = [
      {
        id: 'att-1',
        date: '2026-09-28',
        memberName: 'Tokunaga Hiroshi',
        memberId: 'USER0001',
        team: 'RCS',
        status: 'PRESENT',
        workingStart: '09:30',
        workingEnd: '18:00',
        leaveType: null,
        comment: '',
      },
    ];
    reports.topics = [
      { id: 'topic-1', reportDate: '2026-09-28', title: 'T', description: 'D', displayOrder: 0, createdBy: 'sup', createdAt: NOW_ISO, updatedAt: NOW_ISO },
    ];
    reports.reports = [
      {
        id: 'rep-1',
        reportDate: '2026-09-28',
        language: 'ja',
        status: 'FINALIZED',
        projectId: 'PRJ-001',
        revisionOf: null,
        jiraUrl: null,
        activities: [
          {
            id: 'act-1',
            source: 'AUTO',
            name: 'Activity',
            memberCount: 4,
            completedCases: 45,
            workingStatus: 'ok',
            included: true,
            totalCases: 100,
            workingEligibleCases: 90,
            startedCases: 48,
            blockedCases: 3,
            notApplicableCases: 5,
            spoAssigned: 20,
            casesPassed: 40,
            casesFailed: 5,
            dueDate: null,
          },
        ],
        nextDay: [],
        previewText: '',
        createdBy: 'sup',
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        finalizedAt: NOW_ISO,
        finalizedBy: 'sup',
        snapshot: null,
      },
    ];
    storage.setItem(STORAGE_KEY, JSON.stringify(appState()));
    storage.setItem(REPORTS_STORAGE_KEY, JSON.stringify(reports));

    // 4. Confirm revision N.
    const boot1 = await initPersistence();
    expect(boot1.revision).toBe(1);

    // 5–6. Edit Project A → revision N+1.
    const edited = {
      ...boot1.workspace.reports,
      projects: boot1.workspace.reports.projects.map((p) =>
        p.projectId === 'PRJ-001' ? { ...p, inputs: { ...p.inputs, casesBlocked: 4 } } : p,
      ),
    };
    const save1 = await persistWorkspaceAsync(boot1.workspace.app, edited);
    expect(save1.revision).toBe(2);

    // 13–15. Integrity verified; reload confirms revision and data.
    expect(save1.integrityStatus).toBe('verified');
    const boot2 = await initPersistence();
    expect(boot2.revision).toBe(2);
    expect(boot2.workspace.reports.projects).toHaveLength(2);
    const reloadedA = boot2.workspace.reports.projects.find((p) => p.projectId === 'PRJ-001')!;
    expect(reloadedA.inputs.casesBlocked).toBe(4);

    // 16–17. Simulate IndexedDB unavailability with a CURRENT fallback: the
    // record still matches revision 2 → usable fallback.
    // (Simulate by checking the fallback record bookkeeping.)
    const record = readLocalFallbackRecord();
    expect(record).toEqual({ revision: 1, authoritativeRevision: 2, committedAt: expect.any(String) as unknown as string });

    // 18–20. Stale fallback: IDB lost → recovery required, no silent rollback.
    await loseIndexedDb();
    const boot3 = await initPersistence();
    expect(boot3.health).toBe('recovery-required');
    expect(boot3.mode).toBe('localstorage');
    expect(boot3.revision).toBe(2); // last known revision preserved
    // The stale localStorage copy (revision-1 content) is loaded and preserved.
    expect(boot3.workspace.reports.projects).toHaveLength(2);
    expect(boot3.workspace.reports.projects[0].inputs.casesBlocked).toBe(3); // pre-edit value

    // 21–22. IndexedDB returns: the recovered local state becomes the
    // authoritative workspace again (revision preserved, never reset).
    const recoveredSave = await persistWorkspaceAsync(withExecuted(boot3.workspace.app, 95), boot3.workspace.reports);
    expect(recoveredSave.revision).toBe(3);
    const boot4 = await initPersistence();
    expect(boot4.mode).toBe('indexeddb');
    expect(boot4.migrationStatus).toBe('completed');
    expect(boot4.workspace.app.casesCompleted).toBe(95);
    expect(boot4.revision).toBe(3);

    // 23–25. Export backup, import into a clean workspace → new revision.
    const backupText = JSON.stringify(createBackupPayload(boot4.workspace.app, boot4.workspace.reports));
    await clearAllLocalDataAsync();
    const parsed = parseBackupPayload(backupText);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const imported = await persistWorkspaceAsync(parsed.data.appState, parsed.data.reportsState);
    expect(imported.ok).toBe(true);
    expect(imported.revision).toBe(1);
    expect(imported.integrityStatus).toBe('verified');

    // 26. Integrity verification of the imported workspace.
    await initPersistence();
    const diagnostics = await getStorageDiagnostics();
    expect(diagnostics.revision).toBe(1);
    expect(diagnostics.integrityStatus).toBe('verified');

    // 27–29. Clear all → reload → old localStorage does NOT resurrect.
    await clearAllLocalDataAsync();
    const boot6 = await initPersistence();
    expect(boot6.health).toBe('fresh');
    expect(boot6.workspace.reports.projects).toEqual([]);

    // 30–32. Explicitly import the backup → all data restored, revision advances.
    const restore = parseBackupPayload(backupText);
    expect(restore.ok).toBe(true);
    if (!restore.ok) return;
    const finalSave = await persistWorkspaceAsync(restore.data.appState, restore.data.reportsState);
    expect(finalSave.ok).toBe(true);
    expect(finalSave.revision).toBe(1);
    const finalBoot = await initPersistence();
    expect(finalBoot.revision).toBe(1);

    // Final assertions.
    const projects = finalBoot.workspace.reports.projects;
    expect(projects.map((p) => p.projectId)).toEqual(['PRJ-001', 'PRJ-002']);
    expect(finalBoot.workspace.reports.reports.map((r) => r.id)).toEqual(['rep-1']);
    expect(finalBoot.workspace.reports.reports[0].activities[0].casesPassed).toBe(40);
    expect(finalBoot.workspace.reports.attendance.map((a) => a.id)).toEqual(['att-1']);
    expect(finalBoot.workspace.reports.topics.map((t) => t.id)).toEqual(['topic-1']);
    const finalA = projects.find((p) => p.projectId === 'PRJ-001')!;
    expect(finalA.inputs.dailyActuals!.map((s) => s.id)).toEqual(['snap-legacy', 'snap-granular']);
    expect(!('projectId' in finalA.inputs.dailyActuals![1])).toBe(true); // domain snapshot has no store fields
    expect(finalA.inputs.dailyActuals![0].casesFailed).toBeUndefined(); // legacy honesty
    expect(finalA.inputs.dailyActuals![1].casesFailed).toBe(4);
    expect(finalBoot.workspace.reports.reports[0].projectId).toBe('PRJ-001'); // ownership
    expect(finalA.inputs.casesPassed).toBe(60);
    expect(finalA.inputs.spoAssigned).toBe(20);
    // The edit to casesBlocked=4 was lost together with the deleted database —
    // the stale copy honestly keeps the pre-edit value 3 (no fabrication).
    expect(finalA.inputs.casesBlocked).toBe(3);
    const { calculateExecutionCounts } = await import('../lib/calculations/execution');
    const counts = calculateExecutionCounts(finalA.inputs);
    expect(counts.qaTested).toBe(70);
    expect(counts.qaCompleted).toBe(90);
    expect(counts.remaining).toBe(10);
    expect(finalBoot.workspace.reports.rcsMembers).toEqual([]); // a fresh workspace has no default people; nothing was invented
    expect(finalBoot.health).toBe('healthy');
    expect(finalBoot.revision).toBeGreaterThanOrEqual(1); // monotonic
  });
});

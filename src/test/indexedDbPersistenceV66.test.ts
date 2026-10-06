import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, ProjectRecord, QaInputs, ReportsState } from '../types';
import { STORAGE_KEY, normalizeAppState, normalizeQaInputs, loadState } from '../lib/storage/storage';
import { applyDailyExecutionEntry } from '../lib/calculations/dailyExecuted';
import { REPORTS_STORAGE_KEY, defaultReportsState, loadReportsState } from '../lib/storage/reports';
import { META_STORAGE_KEY } from '../lib/storage/persistence';
import { initPersistence } from '../lib/storage/db/bootstrap';
import {
  DB_NAME,
  DB_VERSION,
  STORE_ATTENDANCE,
  STORE_DAILY_ACTUALS,
  STORE_METADATA,
  STORE_PROJECTS,
  STORE_REPORTS,
  STORE_REVISION_HISTORY,
  STORE_TOPICS,
  openGanttChartDb,
  resetGanttChartDbForTests,
} from '../lib/storage/db/repository';
import {
  clearAllLocalDataAsync,
  getStorageDiagnostics,
  persistWorkspaceAsync,
  resetPersistenceBackendForTests,
} from '../lib/storage/db/persistenceBackend';
import { mirrorFromWorkspace, planWorkspaceWrite } from '../lib/storage/db/workspaceIo';
import { readStorageMigrationRecord } from '../lib/storage/db/migration';
import { newProjectRecord } from '../domain/projects';
import { createBackupPayload, parseBackupPayload } from '../lib/backup/backup';
import { FakeIDBFactory } from './helpers/fakeIndexedDb';

/**
 * V6.6 database migration — IndexedDB persistence tests: database schema,
 * async round-trips, ordered concurrent saves, project isolation, backup
 * compatibility, Clear All Local Data and the localStorage fallback.
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
    planningRows: [
      { id: 'row-1', date: '2026-09-26', plannedTesters: 8, absentTesters: 0, nonWorkingDay: false, note: '' },
    ],
  };
}

function workspace(): { app: AppState; reports: ReportsState } {
  const projectA = newProjectRecord(inputs(), { nameEn: 'A', nameJa: 'A', team: 'PrV' }, NOW_ISO, []);
  const projectB = newProjectRecord(
    { ...inputs(), totalCases: 50, casesCompleted: 30 },
    { nameEn: 'B', nameJa: 'B', team: 'RCS' },
    NOW_ISO,
    [projectA],
  );
  const app: AppState = {
    ...normalizeQaInputs(inputs()),
    language: 'ja',
    projectNameEn: 'A',
    projectNameJa: 'A',
    dashboardView: 'operator',
  };
  const reports: ReportsState = {
    ...defaultReportsState(),
    projects: [projectA, projectB],
    activeProjectId: projectA.id,    reports: [
      {
        id: 'rep-1',
        reportDate: '2026-09-28',
        language: 'ja',
        status: 'FINALIZED',
        projectId: projectA.projectId,
        revisionOf: null,
        jiraUrl: null,
        activities: [],
        nextDay: [],
        previewText: '',
        createdBy: 'sup',
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        finalizedAt: NOW_ISO,
        finalizedBy: 'sup',
        snapshot: null,
      },
    ],
    attendance: [
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
    ],
    topics: [
      {
        id: 'topic-1',
        reportDate: '2026-09-28',
        title: 'T',
        description: 'D',
        displayOrder: 0,
        createdBy: 'sup',
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      },
    ],
  };
  return { app: normalizeAppState(app), reports };
}

/** Bootstrap an already-migrated IndexedDB workspace (seeded from localStorage once). */
async function bootWorkspace(): Promise<{ app: AppState; reports: ReportsState }> {
  const w = workspace();
  storage.setItem(STORAGE_KEY, JSON.stringify(w.app));
  storage.setItem(REPORTS_STORAGE_KEY, JSON.stringify(w.reports));
  const boot = await initPersistence();
  if (boot.mode !== 'indexeddb') throw new Error(`bootstrap failed: ${boot.migrationStatus}`);
  return { app: boot.workspace.app, reports: boot.workspace.reports };
}

function storedKeys(store: string): unknown[] {
  return idb.listKeys(DB_NAME, store);
}

/**
 * V7: execution progress is recorded through a daily execution entry (the
 * canonical casesCompleted is a derived projection, Σ entries).
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

// ---- database schema ----

describe('database schema (§4–§5/§26)', () => {
  it('opens GanttChartDB with the current schema version (v2: + revisionHistory)', async () => {
    const db = await openGanttChartDb();
    expect(db.name).toBe('GanttChartDB');
    expect(db.version).toBe(DB_VERSION);
    expect(DB_VERSION).toBe(2);
  });

  it('creates all six object stores with their records', async () => {
    const w = await bootWorkspace();
    expect(storedKeys(STORE_PROJECTS)).toHaveLength(2);
    expect(storedKeys(STORE_REPORTS)).toHaveLength(1);
    expect(storedKeys(STORE_DAILY_ACTUALS)).toHaveLength(2);
    expect(storedKeys(STORE_ATTENDANCE)).toHaveLength(1);
    expect(storedKeys(STORE_TOPICS)).toHaveLength(1);
    expect(storedKeys(STORE_METADATA).length).toBeGreaterThan(0);
    expect(w.reports.projects).toHaveLength(2);
  });

  it('reopening the existing database does not recreate or clear its stores', async () => {
    await bootWorkspace();
    resetGanttChartDbForTests();
    await openGanttChartDb();
    expect(storedKeys(STORE_PROJECTS)).toHaveLength(2);
    expect(storedKeys(STORE_REPORTS)).toHaveLength(1);
  });

  it('a failed open rejects and the caller can fall back (§21)', async () => {
    idb.failNextOpen = true;
    await expect(openGanttChartDb()).rejects.toBeTruthy();
  });
});

// ---- persistence round-trip ----

describe('persistence round-trip (§16)', () => {
  it('persists state → IndexedDB → reload → state restored', async () => {
    const w = await bootWorkspace();
    const modified = { ...w.reports, activeProjectId: w.reports.projects[1].id };
    const result = await persistWorkspaceAsync(w.app, modified);
    expect(result.ok).toBe(true);
    const reloaded = await initPersistence();
    expect(reloaded.workspace.app).toEqual(w.app);
    expect(reloaded.workspace.reports).toEqual(modified);
  });

  it('multiple sequential writes A → B → C leave C in the database', async () => {
    const w = await bootWorkspace();
    await persistWorkspaceAsync(w.app, w.reports);
    const b = withExecuted(w.app, 60);
    await persistWorkspaceAsync(b, w.reports);
    const c = withExecuted(w.app, 70);
    await persistWorkspaceAsync(c, w.reports);
    const reloaded = await initPersistence();
    expect(reloaded.workspace.app.casesCompleted).toBe(70);
  });

  it('concurrent rapid writes never let an older state commit last (§25)', async () => {
    const w = await bootWorkspace();
    const states = [50, 60, 70, 80, 90].map((casesCompleted) => withExecuted(w.app, casesCompleted));
    await Promise.all(states.map((state) => persistWorkspaceAsync(state, w.reports)));
    const reloaded = await initPersistence();
    expect(reloaded.workspace.app.casesCompleted).toBe(90);
  });

  it('an unchanged workspace writes nothing and keeps lastSavedAt (§27/§37)', async () => {
    const w = await bootWorkspace();
    const first = await persistWorkspaceAsync(w.app, w.reports);
    expect(first.ok).toBe(true);
    const second = await persistWorkspaceAsync(w.app, w.reports);
    expect(second.ok).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.lastSavedAt).toBe(first.lastSavedAt);
  });

  it('a changed workspace refreshes lastSavedAt (§17)', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-29T10:00:00Z'));
      const w = await bootWorkspace();
      const first = await persistWorkspaceAsync({ ...w.app, casesCompleted: 60 }, w.reports);
      vi.setSystemTime(new Date('2026-09-29T10:05:00Z'));
      const second = await persistWorkspaceAsync({ ...w.app, casesCompleted: 70 }, w.reports);
      expect(second.lastSavedAt!).toBeGreaterThan(first.lastSavedAt!);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a save failure is reported and the in-memory state stays usable (§21)', async () => {
    const w = await bootWorkspace();
    idb.abortNextTransaction = true;
    const result = await persistWorkspaceAsync(w.app, { ...w.reports, activeProjectId: w.reports.projects[1].id });
    expect(result.ok).toBe(false);
    // The in-memory workspace object is untouched.
    expect(w.reports.activeProjectId).toBe(w.reports.projects[0].id);
    expect(w.app.totalCases).toBe(100);
    // The next save recovers.
    const retry = await persistWorkspaceAsync(w.app, w.reports);
    expect(retry.ok).toBe(true);
  });

  it('targeted writes: changing one project rewrites only that project (§37)', async () => {
    const w = await bootWorkspace();
    await persistWorkspaceAsync(w.app, w.reports);
    const modified = {
      ...w.reports,
      projects: w.reports.projects.map((p: ProjectRecord, i: number) =>
        i === 0 ? { ...p, inputs: { ...p.inputs, casesBlocked: 4 } } : p,
      ),
    };
    const mirror = mirrorFromWorkspace(w.app, w.reports);
    const plan = planWorkspaceWrite(w.app, modified, mirror);
    expect(plan.changed).toBe(true);
    // Only the changed project record is put — nothing else is written.
    expect([...plan.puts.values()].flat().filter((put) => put.key === undefined && typeof put.value === 'object' && 'inputs' in (put.value as object)).length).toBe(1);
    const result = await persistWorkspaceAsync(w.app, modified);
    expect(result.ok).toBe(true);
    const reloaded = await initPersistence();
    expect(reloaded.workspace.reports.projects[0].inputs.casesBlocked).toBe(4);
    expect(reloaded.workspace.reports.projects[1].inputs.casesBlocked).toBe(w.reports.projects[1].inputs.casesBlocked);
  });

  it('deleting a project removes its records, reports and snapshots from the database', async () => {
    const w = await bootWorkspace();
    const removedId = w.reports.projects[0].id;
    const modified = {
      ...w.reports,
      projects: w.reports.projects.filter((p) => p.id !== removedId),
      reports: w.reports.reports.filter((r) => r.projectId !== w.reports.projects[0].projectId),
    };
    const result = await persistWorkspaceAsync(w.app, modified);
    expect(result.ok).toBe(true);
    expect(storedKeys(STORE_PROJECTS)).toHaveLength(1);
    expect(storedKeys(STORE_REPORTS)).toHaveLength(0);
    // Project B's snapshot survives under its composite key; project A's was deleted.
    const remainingSnapshot = idb.readRecord(STORE_DAILY_ACTUALS, 'PRJ-002::snap-1');
    expect(remainingSnapshot).toBeDefined();
    const reloaded = await initPersistence();
    expect(reloaded.workspace.reports.projects).toHaveLength(1);
    expect(reloaded.workspace.reports.projects[0].projectId).toBe('PRJ-002');
  });
});

// ---- project switching isolation (§32) ----

describe('project switching isolation (§32)', () => {
  it('modifying one project leaves the other untouched in the database', async () => {
    const w = await bootWorkspace();
    const projectA = w.reports.projects[0];
    const projectB = w.reports.projects[1];
    const switched = {
      ...w.reports,
      activeProjectId: projectB.id,
      projects: w.reports.projects.map((p) =>
        p.id === projectB.id ? { ...p, inputs: { ...p.inputs, totalCases: 999 } } : p,
      ),
    };
    await persistWorkspaceAsync(w.app, switched);
    const reloaded = await initPersistence();
    const a = reloaded.workspace.reports.projects.find((p) => p.id === projectA.id)!;
    const b = reloaded.workspace.reports.projects.find((p) => p.id === projectB.id)!;
    expect(b.inputs.totalCases).toBe(999);
    expect(a.inputs.totalCases).toBe(projectA.inputs.totalCases);
    expect(a.inputs.dailyActuals).toEqual(projectA.inputs.dailyActuals);
  });

  it('snapshot records stay distinct even when two projects reuse the same snapshot id', async () => {
    await bootWorkspace();
    await initPersistence();
    // Both fixtures use the snapshot id 'snap-1' — the composite key keeps them distinct.
    const keys = storedKeys(STORE_DAILY_ACTUALS);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('the active project always references an existing project', async () => {
    const w = await bootWorkspace();
    await persistWorkspaceAsync(w.app, w.reports);
    const reloaded = await initPersistence();
    const ids = reloaded.workspace.reports.projects.map((p) => p.id);
    expect(ids).toContain(reloaded.workspace.reports.activeProjectId);
  });
});

// ---- backup compatibility (§28/§29) ----

describe('backup compatibility (§28/§29)', () => {
  it('IndexedDB → export → wipe → import → IndexedDB preserves all data', async () => {
    const w = await bootWorkspace();
    await persistWorkspaceAsync(w.app, w.reports);
    const backupText = JSON.stringify(createBackupPayload(w.app, w.reports));
    await clearAllLocalDataAsync();
    const parsed = parseBackupPayload(backupText);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Imported backups go through validation + normalization, then persist.
    const write = await persistWorkspaceAsync(parsed.data.appState, parsed.data.reportsState);
    expect(write.ok).toBe(true);
    const reloaded = await initPersistence();
    expect(reloaded.workspace.reports.projects.map((p) => p.projectId).sort()).toEqual(['PRJ-001', 'PRJ-002']);
    expect(reloaded.workspace.reports.projects[0].inputs.spoAssigned).toBe(20);
    expect(reloaded.workspace.reports.projects[0].inputs.casesBlocked).toBe(3);
    expect(reloaded.workspace.reports.projects[0].inputs.dailyActuals!.map((s) => s.id)).toEqual(['snap-1']);
    expect(reloaded.workspace.reports.reports.map((r) => r.id)).toEqual(['rep-1']);
    expect(reloaded.workspace.reports.attendance.map((a) => a.id)).toEqual(['att-1']);
    expect(reloaded.workspace.reports.topics.map((t) => t.id)).toEqual(['topic-1']);
  });

  it('the backup format carries no IndexedDB internals', async () => {
    const w = await bootWorkspace();
    const payload = createBackupPayload(w.app, w.reports);
    const text = JSON.stringify(payload);
    expect(text).not.toContain('GanttChartDB');
    expect(text).not.toContain('indexeddb');
    expect(payload.data.appState).toEqual(w.app);
    expect(payload.data.reportsState).toEqual(w.reports);
  });
});

// ---- Clear All Local Data (§30) ----

describe('Clear All Local Data (§30)', () => {
  it('clears IndexedDB, migration metadata and localStorage application keys', async () => {
    await bootWorkspace();
    await clearAllLocalDataAsync();
    expect(idb.hasDatabase(DB_NAME)).toBe(false);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
    expect(storage.getItem(REPORTS_STORAGE_KEY)).toBeNull();
    expect(storage.getItem(META_STORAGE_KEY)).toBeNull();
  });

  it('old data does not reappear after Clear All + fresh first run', async () => {
    await bootWorkspace();
    await clearAllLocalDataAsync();
    const boot = await initPersistence();
    expect(boot.migrationStatus).toBe('skipped-empty');
    expect(boot.workspace.reports.projects).toEqual([]);
    expect(boot.workspace.app.totalCases).toBe(100 * 0 + 36); // demo default
    const marker = await readStorageMigrationRecord();
    expect(marker?.status).toBe('skipped-empty');
  });

  it('clears recovery stashes together with the application keys', async () => {
    await bootWorkspace();
    storage.setItem('ganttchart.recovery.ganttchart.v2', '{corrupt');
    await clearAllLocalDataAsync();
    expect(storage.getItem('ganttchart.recovery.ganttchart.v2')).toBeNull();
  });
});

// ---- fallback (§22) ----

describe('localStorage fallback (§22)', () => {
  it('runs on the V6.3 localStorage persistence when IndexedDB is unavailable', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('window', { localStorage: storage });
    const w = workspace();
    storage.setItem(STORAGE_KEY, JSON.stringify(w.app));
    storage.setItem(REPORTS_STORAGE_KEY, JSON.stringify(w.reports));
    const boot = await initPersistence();
    expect(boot.mode).toBe('localstorage');
    expect(boot.workspace.app).toEqual(w.app);
    // Saves keep working through the localStorage backend.
    const result = await persistWorkspaceAsync(w.app, w.reports);
    expect(result.ok).toBe(true);
    expect(storage.getItem(STORAGE_KEY)).not.toBeNull();
    expect(loadState()).toEqual(w.app);
    expect(loadReportsState().projects).toHaveLength(2);
  });

  it('falls back when the database cannot be opened', async () => {
    const w = workspace();
    storage.setItem(STORAGE_KEY, JSON.stringify(w.app));
    storage.setItem(REPORTS_STORAGE_KEY, JSON.stringify(w.reports));
    idb.failNextOpen = true;
    const boot = await initPersistence();
    expect(boot.mode).toBe('localstorage');
    expect(boot.workspace.app).toEqual(w.app);
  });

  it('falls back to the retained localStorage when IndexedDB records become unreadable (§20)', async () => {
    const w = await bootWorkspace();
    // Corrupt the stored AppState record.
    idb.writeRecord(DB_NAME, STORE_METADATA, 'appState', { broken: true });
    const boot = await initPersistence();
    expect(boot.mode).toBe('localstorage');
    expect(boot.workspace.app).toEqual(w.app);
  });

  it('reports a database error when IndexedDB is unreadable and no fallback or journal exists', async () => {
    await bootWorkspace();
    storage.removeItem(STORAGE_KEY);
    storage.removeItem(REPORTS_STORAGE_KEY);
    idb.writeRecord(DB_NAME, STORE_METADATA, 'appState', 42);
    // No durable journal either → the V6.7 db-error path applies unchanged.
    for (const key of idb.listKeys(DB_NAME, STORE_REVISION_HISTORY)) {
      idb.deleteRecord(DB_NAME, STORE_REVISION_HISTORY, key);
    }
    const boot = await initPersistence();
    expect(boot.mode).toBe('localstorage');
    expect(boot.migrationStatus).toBe('db-error');
    // The app still starts with safe defaults (never silently reset data it cannot read).
    expect(boot.workspace.app.totalCases).toBeGreaterThan(0);
  });
});

// ---- diagnostics (§31) ----

describe('storage diagnostics (§31)', () => {
  it('exposes mode, database version and migration status metadata', async () => {
    await bootWorkspace();
    const diagnostics = await getStorageDiagnostics();
    expect(diagnostics.mode).toBe('indexeddb');
    expect(diagnostics.database).toBe('GanttChartDB');
    expect(diagnostics.databaseVersion).toBe(2);
    expect(diagnostics.migrationStatus).toBe('completed');
  });

  it('shows the fallback mode with no database in localStorage mode', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('window', { localStorage: storage });
    await initPersistence();
    const diagnostics = await getStorageDiagnostics();
    expect(diagnostics.mode).toBe('localstorage');
    expect(diagnostics.database).toBeNull();
  });
});

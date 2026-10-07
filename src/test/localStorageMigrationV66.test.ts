import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppState,
  AttendanceRecord,
  DailyReport,
  DailyTopic,
  ProjectRecord,
  QaInputs,
  ReportsState,
} from '../types';
import { seedRcsMembers } from '../domain/members';
import { DEMO_STATE, STORAGE_KEY, LEGACY_STORAGE_KEY, normalizeAppState, normalizeQaInputs } from '../lib/storage/storage';
import {
  defaultReportsState,
  REPORTS_STORAGE_KEY,
} from '../lib/storage/reports';
import { META_STORAGE_KEY } from '../lib/storage/persistence';
import { hasRecoveryPayload } from '../lib/storage/corruption';
import { initPersistence } from '../lib/storage/db/bootstrap';
import {
  LOCAL_STORAGE_MIGRATION_MAP,
  migrateLocalStorageToIndexedDb,
  readStorageMigrationRecord,
  verifyMigration,
} from '../lib/storage/db/migration';
import {
  DB_NAME,
  STORE_ATTENDANCE,
  STORE_DAILY_ACTUALS,
  STORE_METADATA,
  STORE_PROJECTS,
  STORE_REPORTS,
  STORE_REVISION_HISTORY,
  STORE_TOPICS,
} from '../lib/storage/db/repository';
import { splitWorkspace } from '../lib/storage/db/workspace';
import { resetPersistenceBackendForTests } from '../lib/storage/db/persistenceBackend';
import {
  MIGRATION_FAILURE_KEY,
  readMigrationFailureRecord,
} from '../lib/storage/db/recovery';
import { newProjectRecord } from '../domain/projects';
import { calculateExecutionCounts } from '../lib/calculations/execution';
import { createBackupPayload, parseBackupPayload } from '../lib/backup/backup';
import { FakeIDBFactory } from './helpers/fakeIndexedDb';

/**
 * V6.6 database migration — localStorage → IndexedDB migration tests:
 * detection, correctness, historical honesty, idempotency, transaction
 * safety, verification and the §35 end-to-end acceptance scenario.
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

// ---- §35-style legacy V6.5 workspace fixtures ----

/** Project A: 100 total, Pass 60 / Fail 5 / NA 5 / SPO 20 / Blocked 3 / Retest 2 / Questioned 1. */
function projectInputs(): QaInputs {
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
    dailyTargetOverrides: [{ id: 'ovr-1', date: '2026-09-28', plannedExecute: 60, plannedPass: 50 }],
    dailyActuals: [
      // Legacy V6.4-style snapshot — only executed/passed (historical honesty, §8).
      { id: 'snap-legacy-1', date: '2026-09-26', executed: 70, passed: 60 },
      // V6.5 granular snapshot.
      {
        id: 'snap-granular-1',
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
      },
    ],
    blockingEvents: [
      { id: 'blk-1', date: '2026-09-27', category: 'ENVIRONMENT', minutes: 45, note: 'staging down' },
    ],
    milestones: [],
    startDate: '2026-09-26',
    targetCompletionDate: '2026-09-30',
    targetCompletionTime: '17:00',
    planningRows: [
      { id: 'row-1', date: '2026-09-26', plannedTesters: 8, absentTesters: 0, nonWorkingDay: false, note: '' },
      { id: 'row-2', date: '2026-09-29', plannedTesters: 8, absentTesters: 1, nonWorkingDay: false, note: '' },
    ],
  };
}

function projectBInputs(): QaInputs {
  return {
    ...projectInputs(),
    totalCases: 50,
    casesCompleted: 30,
    casesPassed: 25,
    spoAssigned: 5,
    casesFailed: 2,
    casesNotApplicable: 3,
    casesBlocked: 0,
    casesRetest: 0,
    casesQuestioned: 0,
    dailyActuals: [{ id: 'snap-b-1', date: '2026-09-27', executed: 30, passed: 25 }],
    dailyTargetOverrides: [],
  };
}

function legacyWorkspace(): { app: AppState; reports: ReportsState } {
  const inputs = projectInputs();
  const projectA = newProjectRecord(inputs, { nameEn: 'Project A', nameJa: 'プロジェクトA', team: 'PrV' }, NOW_ISO, []);
  const projectB = newProjectRecord(projectBInputs(), { nameEn: 'Project B', nameJa: 'プロジェクトB', team: 'RCS' }, NOW_ISO, [projectA]);
  const attendance: AttendanceRecord[] = [
    {
      id: 'att-1',
      date: '2026-09-29',
      memberName: 'Tokunaga Hiroshi',
      memberId: 'USER0001',
      team: 'RCS',
      status: 'PRESENT',
      workingStart: '09:30',
      workingEnd: '18:00',
      leaveType: null,
      comment: '',
    },
    {
      id: 'att-2',
      date: '2026-09-29',
      memberName: 'Yamauchi Kentaro',
      memberId: 'USER0003',
      team: 'RCS',
      status: 'ABSENT',
      workingStart: null,
      workingEnd: null,
      leaveType: 'PAID_LEAVE',
      comment: '',
    },
  ];
  const topics: DailyTopic[] = [
    {
      id: 'topic-1',
      reportDate: '2026-09-29',
      title: 'Staging environment instability',
      description: 'Investigating intermittent 500s.',
      displayOrder: 0,
      createdBy: 'sup',
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    },
  ];
  const reports: DailyReport[] = [
    {
      id: 'rep-1',
      reportDate: '2026-09-28',
      language: 'ja',
      status: 'FINALIZED',
      projectId: projectA.projectId,
      revisionOf: null,
      jiraUrl: null,
      activities: [
        {
          id: 'act-1',
          source: 'AUTO',
          name: 'Android 4.1 sanity',
          memberCount: 4,
          completedCases: 45,
          workingStatus: 'on schedule',
          included: true,
          totalCases: 100,
          workingEligibleCases: 90,
          startedCases: 48,
          blockedCases: 3,
          notApplicableCases: 5,
          spoAssigned: 20,
          casesPassed: 40,
          casesFailed: 5,
          casesRetest: 2,
          casesQuestioned: 1,
          dueDate: null,
        },
      ],
      nextDay: [{ id: 'next-1', text: 'Retest failed cases', source: 'SUGGESTED' }],
      previewText: 'preview',
      createdBy: 'sup',
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
      finalizedAt: NOW_ISO,
      finalizedBy: 'sup',
      snapshot: null,
    },
    {
      id: 'rep-2',
      reportDate: '2026-09-29',
      language: 'en',
      status: 'DRAFT',
      projectId: projectB.projectId,
      revisionOf: null,
      jiraUrl: null,
      activities: [],
      nextDay: [],
      previewText: '',
      createdBy: 'sup',
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
      finalizedAt: null,
      finalizedBy: null,
      snapshot: null,
    },
  ];
  const app: AppState = {
    ...normalizeQaInputs(inputs),
    language: 'ja',
    projectNameEn: 'Project A',
    projectNameJa: 'プロジェクトA',
    dashboardView: 'operator',
  };
  const reportsState: ReportsState = {
    ...defaultReportsState(),
    projects: [projectA, projectB],
    activeProjectId: projectA.id,
    attendance,
    topics,
    reports,
  };
  return { app: normalizeAppState(app), reports: reportsState };
}

/** Populate localStorage exactly as a V6.5 browser would have persisted it. */
function seedLegacyLocalStorage(workspace = legacyWorkspace()): { app: AppState; reports: ReportsState } {
  storage.setItem(STORAGE_KEY, JSON.stringify(workspace.app));
  storage.setItem(REPORTS_STORAGE_KEY, JSON.stringify(workspace.reports));
  storage.setItem(META_STORAGE_KEY, JSON.stringify({ lastSavedAt: 12345 }));
  return workspace;
}

function storedKeys(store: string): unknown[] {
  return idb.listKeys(DB_NAME, store);
}

// ---- first-time user & detection ----

describe('first-time user (§19)', () => {
  it('initializes IndexedDB normally with demo defaults when no data exists anywhere', async () => {
    const boot = await initPersistence();
    expect(boot.mode).toBe('indexeddb');
    expect(boot.migrationStatus).toBe('skipped-empty');
    expect(boot.workspace.app.totalCases).toBe(DEMO_STATE.totalCases);
    expect(boot.workspace.reports.projects).toEqual([]);
    const marker = await readStorageMigrationRecord();
    expect(marker).not.toBeNull();
    expect(marker?.status).toBe('skipped-empty');
  });

  it('creates all object stores on first open', async () => {
    await initPersistence();
    for (const store of [STORE_PROJECTS, STORE_REPORTS, STORE_DAILY_ACTUALS, STORE_ATTENDANCE, STORE_TOPICS, STORE_METADATA]) {
      expect(storedKeys(store)).toBeDefined();
    }
  });
});

describe('migration detection (§12/§18)', () => {
  it('detects legacy localStorage data and migrates it', async () => {
    const workspace = seedLegacyLocalStorage();
    const boot = await initPersistence();
    expect(boot.mode).toBe('indexeddb');
    expect(boot.migrationStatus).toBe('completed');
    expect(boot.workspace.app).toEqual(workspace.app);
    expect(boot.workspace.reports).toEqual(workspace.reports);
  });

  it('writes explicit migration metadata (source, target, version, status, timestamp)', async () => {
    seedLegacyLocalStorage();
    await initPersistence();
    const marker = await readStorageMigrationRecord();
    expect(marker).toEqual({
      source: 'localStorage',
      target: 'indexeddb',
      version: 1,
      status: 'completed',
      migratedAt: expect.any(String) as unknown as string,
      details: { projects: 2, reports: 2, snapshots: 3, attendance: 2, topics: 1 },
    });
  });

  it('does not repeat a completed migration on the next startup', async () => {
    seedLegacyLocalStorage();
    await initPersistence();
    const marker = await readStorageMigrationRecord();
    // Simulate a later session: localStorage retained, DB already migrated.
    await initPersistence();
    const markerAfter = await readStorageMigrationRecord();
    expect(markerAfter).toEqual(marker);
    expect(storedKeys(STORE_PROJECTS)).toHaveLength(2);
    expect(storedKeys(STORE_REPORTS)).toHaveLength(2);
    expect(storedKeys(STORE_DAILY_ACTUALS)).toHaveLength(3);
  });

  it('reloads from IndexedDB after migration — later localStorage edits are ignored', async () => {
    const workspace = seedLegacyLocalStorage();
    await initPersistence();
    // Tamper with the retained localStorage copy: IndexedDB is primary (§16).
    storage.setItem(STORAGE_KEY, JSON.stringify({ ...workspace.app, totalCases: 999 }));
    const boot = await initPersistence();
    expect(boot.workspace.app.totalCases).toBe(workspace.app.totalCases);
  });

  it('exposes an explicit migration map of the real V6.3 keys', () => {
    expect(LOCAL_STORAGE_MIGRATION_MAP['ganttchart.v2']).toContain('metadata.appState');
    expect(LOCAL_STORAGE_MIGRATION_MAP['ganttchart.v1']).toContain('forward-migrated');
    expect(LOCAL_STORAGE_MIGRATION_MAP['ganttchart.reports.v1']).toContain('dailyActuals');
    expect(LOCAL_STORAGE_MIGRATION_MAP['ganttchart.meta.v1']).toContain('persistenceMeta');
  });
});

// ---- migration correctness (§14 data coverage) ----

describe('migration correctness (§9/§14)', () => {
  it('preserves projects with their stable IDs and lifecycle', async () => {
    const workspace = seedLegacyLocalStorage();
    await initPersistence();
    const boot2 = await initPersistence(); // read from IndexedDB
    const migrated = boot2.workspace.reports.projects;
    expect(migrated.map((p) => p.projectId).sort()).toEqual(['PRJ-001', 'PRJ-002']);
    expect(migrated.map((p) => p.id).sort()).toEqual(workspace.reports.projects.map((p) => p.id).sort());
    expect(migrated[0].statusHistory).toEqual(workspace.reports.projects[0].statusHistory);
    expect(migrated[0].createdAt).toBe(workspace.reports.projects[0].createdAt);
  });

  it('preserves the active project reference', async () => {
    const workspace = seedLegacyLocalStorage();
    await initPersistence();
    const boot2 = await initPersistence();
    expect(boot2.workspace.reports.activeProjectId).toBe(workspace.reports.projects[0].id);
  });

  it('preserves daily reports with activities and execution values', async () => {
    const workspace = seedLegacyLocalStorage();
    await initPersistence();
    const boot2 = await initPersistence();
    expect(boot2.workspace.reports.reports).toEqual(workspace.reports.reports);
    const activity = boot2.workspace.reports.reports[0].activities[0];
    expect(activity.casesPassed).toBe(40);
    expect(activity.spoAssigned).toBe(20);
    expect(activity.blockedCases).toBe(3);
  });

  it('preserves attendance and topics', async () => {
    const workspace = seedLegacyLocalStorage();
    await initPersistence();
    const boot2 = await initPersistence();
    expect(boot2.workspace.reports.attendance).toEqual(workspace.reports.attendance);
    expect(boot2.workspace.reports.topics).toEqual(workspace.reports.topics);
  });

  it('preserves the app state editing surface including language', async () => {
    const workspace = seedLegacyLocalStorage();
    await initPersistence();
    const boot2 = await initPersistence();
    expect(boot2.workspace.app.language).toBe('ja');
    expect(boot2.workspace.app.projectNameJa).toBe('プロジェクトA');
    expect(boot2.workspace.app.planningRows).toEqual(workspace.app.planningRows);
  });

  it('preserves tester assignments, reviews and the RCS member master', async () => {
    const workspace = seedLegacyLocalStorage();
    const workspaceWithCollections: ReportsState = {
      ...workspace.reports,
      rcsMembers: seedRcsMembers(),
      testerAssignments: [
        {
          id: 'asg-1',
          projectId: workspace.reports.projects[0].projectId,
          memberId: 'USER0003',
          team: 'RCS',
          startDate: '2026-09-26',
          active: true,
        },
      ],
      reviews: [
        {
          id: 'rev-1',
          memberId: 'USER0003',
          testerName: 'Yamauchi Kentaro',
          periodType: 'month',
          periodStart: '2026-09-01',
          periodEnd: '2026-09-30',
          status: 'draft',
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
        },
      ],
    };
    seedLegacyLocalStorage({ app: workspace.app, reports: workspaceWithCollections });
    await initPersistence();
    const boot2 = await initPersistence();
    expect(boot2.workspace.reports.testerAssignments!).toHaveLength(1);
    expect(boot2.workspace.reports.testerAssignments![0].memberId).toBe('USER0003');
    expect(boot2.workspace.reports.reviews!).toHaveLength(1);
    expect(boot2.workspace.reports.rcsMembers!).toHaveLength(8);
  });

  it('keeps every report attached to the correct project', async () => {
    seedLegacyLocalStorage();
    await initPersistence();
    const boot2 = await initPersistence();
    const projectIds = new Set(boot2.workspace.reports.projects.map((p) => p.projectId));
    for (const report of boot2.workspace.reports.reports) {
      expect(projectIds.has(report.projectId as string)).toBe(true);
    }
    const reportA = boot2.workspace.reports.reports.find((r) => r.id === 'rep-1');
    expect(reportA?.projectId).toBe('PRJ-001');
  });
});

// ---- granular execution + historical honesty (§8/§33) ----

describe('granular execution & historical honesty (§8/§33)', () => {
  it('preserves the V6.4 granular execution fields exactly', async () => {
    seedLegacyLocalStorage();
    await initPersistence();
    const boot2 = await initPersistence();
    const projectA = boot2.workspace.reports.projects.find((p) => p.projectId === 'PRJ-001')!;
    expect(projectA.inputs.casesPassed).toBe(60);
    expect(projectA.inputs.casesFailed).toBe(5);
    expect(projectA.inputs.casesNotApplicable).toBe(5);
    expect(projectA.inputs.spoAssigned).toBe(20);
    expect(projectA.inputs.casesBlocked).toBe(3);
    expect(projectA.inputs.casesRetest).toBe(2);
    expect(projectA.inputs.casesQuestioned).toBe(1);
    // V6.4/V6.5 semantics unchanged.
    const counts = calculateExecutionCounts(projectA.inputs);
    expect(counts.qaTested).toBe(70);
    expect(counts.qaCompleted).toBe(90);
    expect(counts.remaining).toBe(10);
  });

  it('never fabricates missing historical granular values (executed 70 / passed 60)', async () => {
    seedLegacyLocalStorage();
    await initPersistence();
    const row = idb.readRecord(STORE_DAILY_ACTUALS, 'PRJ-001::snap-legacy-1') as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.executed).toBe(70);
    expect(row.passed).toBe(60);
    expect('casesPassed' in row).toBe(false);
    expect('casesFailed' in row).toBe(false);
    expect('casesNotApplicable' in row).toBe(false);
    expect('spoAssigned' in row).toBe(false);
  });

  it('preserves granular snapshot values exactly where present', async () => {
    seedLegacyLocalStorage();
    await initPersistence();
    const row = idb.readRecord(STORE_DAILY_ACTUALS, 'PRJ-001::snap-granular-1') as Record<string, unknown>;
    expect(row.casesPassed).toBe(58);
    expect(row.casesFailed).toBe(4);
    expect(row.casesNotApplicable).toBe(3);
    expect(row.spoAssigned).toBe(15);
    expect(row.casesBlocked).toBe(2);
    expect(row.casesRetest).toBe(1);
    expect(row.casesQuestioned).toBe(1);
  });

  it('keeps snapshot list order and project ownership across the store split', async () => {
    seedLegacyLocalStorage();
    await initPersistence();
    const boot2 = await initPersistence();
    const projectA = boot2.workspace.reports.projects.find((p) => p.projectId === 'PRJ-001')!;
    expect(projectA.inputs.dailyActuals!.map((s) => s.id)).toEqual(['snap-legacy-1', 'snap-granular-1']);
    const projectB = boot2.workspace.reports.projects.find((p) => p.projectId === 'PRJ-002')!;
    expect(projectB.inputs.dailyActuals!.map((s) => s.id)).toEqual(['snap-b-1']);
    const rowB = idb.readRecord(STORE_DAILY_ACTUALS, 'PRJ-002::snap-b-1') as Record<string, unknown>;
    expect(rowB.projectId).toBe('PRJ-002');
  });

  it('stores projects with their snapshots split out of the inputs (single source of truth)', async () => {
    seedLegacyLocalStorage();
    await initPersistence();
    const keys = storedKeys(STORE_PROJECTS) as string[];
    expect(keys).toHaveLength(2);
    const stored = idb.readRecord(STORE_PROJECTS, keys[0]) as Record<string, unknown>;
    expect((stored.inputs as Record<string, unknown>).dailyActuals).toEqual([]);
  });
});

// ---- idempotency (§12) ----

describe('migration idempotency (§12)', () => {
  it('running the migration twice does not duplicate any record', async () => {
    seedLegacyLocalStorage();
    await migrateLocalStorageToIndexedDb(NOW_ISO);
    await migrateLocalStorageToIndexedDb(NOW_ISO);
    expect(storedKeys(STORE_PROJECTS)).toHaveLength(2);
    expect(storedKeys(STORE_REPORTS)).toHaveLength(2);
    expect(storedKeys(STORE_DAILY_ACTUALS)).toHaveLength(3);
    expect(storedKeys(STORE_ATTENDANCE)).toHaveLength(2);
    expect(storedKeys(STORE_TOPICS)).toHaveLength(1);
  });

  it('re-running the migration leaves the same final workspace state', async () => {
    seedLegacyLocalStorage();
    const first = await migrateLocalStorageToIndexedDb(NOW_ISO);
    const second = await migrateLocalStorageToIndexedDb(NOW_ISO);
    expect(second.status).toBe('completed');
    if (first.status !== 'completed' || second.status !== 'completed') return;
    expect(second.reports).toEqual(first.reports);
    expect(second.appState).toEqual(first.appState);
  });
});

// ---- transaction safety & corruption (§13/§20/§21) ----

describe('transaction safety (§13)', () => {
  it('a failed transaction persists nothing and leaves localStorage intact', async () => {
    seedLegacyLocalStorage();
    idb.abortNextTransaction = true;
    const outcome = await migrateLocalStorageToIndexedDb(NOW_ISO);
    expect(outcome.status).toBe('failed');
    expect(storedKeys(STORE_PROJECTS)).toHaveLength(0);
    expect(storedKeys(STORE_REPORTS)).toHaveLength(0);
    expect(storedKeys(STORE_DAILY_ACTUALS)).toHaveLength(0);
    expect(storedKeys(STORE_METADATA)).toHaveLength(0);
    expect(storage.getItem(STORAGE_KEY)).not.toBeNull();
    expect(storage.getItem(REPORTS_STORAGE_KEY)).not.toBeNull();
  });

  it('the completion marker is not written when the transaction fails', async () => {
    seedLegacyLocalStorage();
    idb.abortNextTransaction = true;
    await migrateLocalStorageToIndexedDb(NOW_ISO);
    const marker = await readStorageMigrationRecord();
    expect(marker).toBeNull();
  });

  it('a failed migration falls back to localStorage for the session', async () => {
    const workspace = seedLegacyLocalStorage();
    idb.abortNextTransaction = true;
    const boot = await initPersistence();
    expect(boot.mode).toBe('localstorage');
    expect(boot.migrationStatus).toBe('failed');
    expect(boot.workspace.app).toEqual(workspace.app);
    expect(boot.workspace.reports).toEqual(workspace.reports);
  });

  it('an interrupted migration can be retried safely on a later startup', async () => {
    seedLegacyLocalStorage();
    idb.abortNextTransaction = true;
    await migrateLocalStorageToIndexedDb(NOW_ISO); // interrupted
    const outcome = await migrateLocalStorageToIndexedDb(NOW_ISO); // retry
    expect(outcome.status).toBe('completed');
    expect(storedKeys(STORE_PROJECTS)).toHaveLength(2);
  });
});

// ---- migration failure reason diagnostics (banner + Settings) ----

describe('migration failure reason diagnostics', () => {
  it('a write failure surfaces the reason on the boot and records it for Settings', async () => {
    seedLegacyLocalStorage();
    idb.abortNextTransaction = true;
    const boot = await initPersistence();
    expect(boot.migrationStatus).toBe('failed');
    expect(boot.migrationFailureReason).toBe('write-failed');
    const record = readMigrationFailureRecord();
    expect(record).not.toBeNull();
    expect(record?.reason).toBe('write-failed');
    expect(typeof record?.at).toBe('string');
    // The raw record lives under the dedicated diagnostics key only.
    expect(storage.getItem(MIGRATION_FAILURE_KEY)).not.toBeNull();
  });

  it('invalid localStorage surfaces the invalid-local-storage reason', async () => {
    storage.setItem(STORAGE_KEY, '###');
    const boot = await initPersistence();
    expect(boot.migrationStatus).toBe('failed');
    expect(boot.migrationFailureReason).toBe('invalid-local-storage');
    expect(readMigrationFailureRecord()?.reason).toBe('invalid-local-storage');
  });

  it('a stale fallback record surfaces the stale-fallback reason without migrating', async () => {
    const workspace = seedLegacyLocalStorage();
    // The database previously held a higher authoritative revision than the
    // retained localStorage copy — the copy must never be migrated back in.
    storage.setItem(
      'ganttchart.fallback.v1',
      JSON.stringify({ revision: 3, authoritativeRevision: 7, committedAt: NOW_ISO }),
    );
    const boot = await initPersistence();
    expect(boot.migrationStatus).toBe('failed');
    expect(boot.migrationFailureReason).toBe('stale-fallback');
    expect(boot.workspace.app).toEqual(workspace.app);
    // No migration marker was written.
    expect(await readStorageMigrationRecord()).toBeNull();
  });

  it('a successful later migration clears the failure record', async () => {
    seedLegacyLocalStorage();
    idb.abortNextTransaction = true;
    const failedBoot = await initPersistence();
    expect(failedBoot.migrationStatus).toBe('failed');
    expect(readMigrationFailureRecord()).not.toBeNull();

    // Next startup: the write succeeds and the migration completes.
    idb.abortNextTransaction = false;
    const boot = await initPersistence();
    expect(boot.migrationStatus).toBe('completed');
    expect(boot.migrationFailureReason).toBeUndefined();
    expect(readMigrationFailureRecord()).toBeNull();
  });
});

describe('corrupted localStorage (§20/§21)', () => {
  it('invalid app-state JSON fails the migration and preserves the raw data under a recovery key', async () => {
    storage.setItem(STORAGE_KEY, '{not json');
    const outcome = await migrateLocalStorageToIndexedDb(NOW_ISO);
    expect(outcome.status).toBe('failed');
    expect(storage.getItem(STORAGE_KEY)).toBe('{not json');
    expect(hasRecoveryPayload(STORAGE_KEY)).toBe(true);
  });

  it('an invalid reports schema fails the migration without touching localStorage', async () => {
    storage.setItem(STORAGE_KEY, JSON.stringify(legacyWorkspace().app));
    storage.setItem(REPORTS_STORAGE_KEY, JSON.stringify({ schemaVersion: 99, nope: true }));
    const outcome = await migrateLocalStorageToIndexedDb(NOW_ISO);
    expect(outcome.status).toBe('failed');
    expect(storage.getItem(REPORTS_STORAGE_KEY)).not.toBeNull();
    expect(hasRecoveryPayload(REPORTS_STORAGE_KEY)).toBe(true);
  });

  it('corrupted data does not silently become an empty migrated database', async () => {
    storage.setItem(STORAGE_KEY, '###');
    const boot = await initPersistence();
    expect(boot.migrationStatus).toBe('failed');
    const marker = await readStorageMigrationRecord();
    expect(marker).toBeNull();
    expect(storedKeys(STORE_PROJECTS)).toHaveLength(0);
  });

  it('the app stays usable (V6.3 fallback loaders) when migration cannot run', async () => {
    storage.setItem(STORAGE_KEY, '###');
    const boot = await initPersistence();
    expect(boot.mode).toBe('localstorage');
    expect(boot.workspace.app.totalCases).toBe(DEMO_STATE.totalCases);
    expect(boot.workspace.reports.projects).toEqual([]);
  });
});

// ---- verification (§14) ----

describe('migration verification (§14)', () => {
  it('verifies the written records against the prepared parts', async () => {
    seedLegacyLocalStorage();
    const outcome = await migrateLocalStorageToIndexedDb(NOW_ISO);
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    const { parts } = splitWorkspace(outcome.appState, outcome.reports);
    expect(await verifyMigration(outcome.appState, parts)).toBe(true);
  });

  it('detects a missing project record', async () => {
    seedLegacyLocalStorage();
    const outcome = await migrateLocalStorageToIndexedDb(NOW_ISO);
    if (outcome.status !== 'completed') throw new Error('migration failed');
    // Tamper: remove one project record from the database.
    const keys = storedKeys(STORE_PROJECTS) as string[];
    idb.deleteRecord(DB_NAME, STORE_PROJECTS, keys[0]);
    const { parts } = splitWorkspace(outcome.appState, outcome.reports);
    expect(await verifyMigration(outcome.appState, parts)).toBe(false);
  });

  it('detects a modified granular execution value', async () => {
    seedLegacyLocalStorage();
    const outcome = await migrateLocalStorageToIndexedDb(NOW_ISO);
    if (outcome.status !== 'completed') throw new Error('migration failed');
    const key = storedKeys(STORE_PROJECTS)[0] as string;
    const project = idb.readRecord(STORE_PROJECTS, key) as unknown as ProjectRecord;
    project.inputs.casesPassed = 61;
    idb.writeRecord(DB_NAME, STORE_PROJECTS, key, project);
    const { parts } = splitWorkspace(outcome.appState, outcome.reports);
    expect(await verifyMigration(outcome.appState, parts)).toBe(false);
  });
});

// ---- dirty marker-less database (verification-failed retry loop regression) ----

describe('dirty marker-less database (self-healing migration)', () => {
  it('clears leftover rows and rebuilds the database from localStorage', async () => {
    // Regression: a marker-less database holding rows NOT present in the
    // localStorage workspace made every migration attempt fail the read-back
    // verification (count mismatch) — a permanent "verification-failed"
    // retry loop with no self-recovery.
    const workspace = seedLegacyLocalStorage();
    const boot = await initPersistence();
    expect(boot.migrationStatus).toBe('completed'); // establishes the stores

    // Simulate the marker loss with leftovers: drop ONLY the migration
    // marker and plant rows the localStorage workspace does not have.
    idb.deleteRecord(DB_NAME, STORE_METADATA, 'storageMigration');
    idb.writeRecord(DB_NAME, STORE_PROJECTS, 'PRJ-OLD', { id: 'PRJ-OLD', projectId: 'PRJ-OLD' });
    idb.writeRecord(DB_NAME, STORE_REVISION_HISTORY, 99, { revision: 99, committedAt: NOW_ISO, reason: 'edit' });

    // Restart: the migration retries on the dirty database, clears the
    // leftovers, rebuilds from localStorage and passes verification.
    const retry = await initPersistence();
    expect(retry.migrationStatus).toBe('completed');
    expect(retry.mode).toBe('indexeddb');
    expect(retry.health).toBe('healthy');
    expect(retry.workspace.reports.projects).toHaveLength(2);
    // The leftover project row is gone — not resurrected as a phantom project.
    expect(storedKeys(STORE_PROJECTS)).toHaveLength(2);
    expect(idb.readRecord(STORE_PROJECTS, 'PRJ-OLD')).toBeUndefined();
    // Stale journal history did not survive either.
    expect(storedKeys(STORE_REVISION_HISTORY)).not.toContain(99);
    // The workspace is exactly the retained localStorage copy (§13/§15).
    expect(retry.workspace.app).toEqual(workspace.app);
    expect(retry.workspace.reports).toEqual(workspace.reports);
    const marker = await readStorageMigrationRecord();
    expect(marker?.status).toBe('completed');
  });
});

// ---- legacy v1 app state (§10) ----

describe('legacy v1 localStorage key (ganttchart.v1)', () => {
  it('forward-migrates the pre-V2 app state into IndexedDB', async () => {
    const workspace = legacyWorkspace();
    const raw = JSON.parse(JSON.stringify(workspace.app)) as Record<string, unknown>;
    delete raw.startDate;
    delete raw.targetCompletionDate;
    delete raw.targetCompletionTime;
    delete raw.planningRows;
    delete raw.projectNameEn;
    delete raw.projectNameJa;
    storage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(raw));
    storage.setItem(REPORTS_STORAGE_KEY, JSON.stringify(workspace.reports));
    const boot = await initPersistence();
    expect(boot.migrationStatus).toBe('completed');
    expect(boot.mode).toBe('indexeddb');
    expect(boot.workspace.app.totalCases).toBe(100);
    expect(boot.workspace.app.planningRows.length).toBeGreaterThan(0);
    expect(boot.workspace.reports.projects).toHaveLength(2);
    // The legacy key is retained as the migration fallback (§15).
    expect(storage.getItem(LEGACY_STORAGE_KEY)).not.toBeNull();
  });
});

// ---- localStorage retention (§15) ----

describe('localStorage retention (§15)', () => {
  it('never deletes localStorage data after a successful migration', async () => {
    const workspace = seedLegacyLocalStorage();
    await initPersistence();
    expect(storage.getItem(STORAGE_KEY)).toBe(JSON.stringify(workspace.app));
    expect(storage.getItem(REPORTS_STORAGE_KEY)).toBe(JSON.stringify(workspace.reports));
    expect(storage.getItem(META_STORAGE_KEY)).not.toBeNull();
  });
});

// ---- §35 end-to-end acceptance ----

describe('§35 end-to-end migration acceptance', () => {
  it('migrate → reload → edit → export → wipe → import preserves everything', async () => {
    // 1–4. Populate localStorage (V6.5 format) and start the application.
    const workspace = seedLegacyLocalStorage();
    const boot = await initPersistence();

    // 5. Migration completed.
    expect(boot.migrationStatus).toBe('completed');
    const marker = await readStorageMigrationRecord();
    expect(marker?.status).toBe('completed');

    // 6–7. Reload: the same workspace loads from IndexedDB.
    const reloaded = await initPersistence();
    expect(reloaded.workspace.app).toEqual(workspace.app);
    expect(reloaded.workspace.reports).toEqual(workspace.reports);

    // 8–9. Modify Project A and persist; granular semantics stay intact.
    const projectA = reloaded.workspace.reports.projects[0];
    const modifiedProjects = reloaded.workspace.reports.projects.map((p) =>
      p.id === projectA.id ? { ...p, inputs: { ...p.inputs, casesBlocked: 4 } } : p,
    );
    const { persistWorkspaceAsync } = await import('../lib/storage/db/persistenceBackend');
    const modifiedReports = { ...reloaded.workspace.reports, projects: modifiedProjects };
    const writeResult = await persistWorkspaceAsync(reloaded.workspace.app, modifiedReports);
    expect(writeResult.ok).toBe(true);

    // 10. Reload again — Project B unchanged, Project A modified.
    const third = await initPersistence();
    const reloadedA = third.workspace.reports.projects.find((p) => p.projectId === 'PRJ-001')!;
    const reloadedB = third.workspace.reports.projects.find((p) => p.projectId === 'PRJ-002')!;
    expect(reloadedA.inputs.casesBlocked).toBe(4);
    expect(reloadedB.inputs.casesBlocked).toBe(workspace.reports.projects[1].inputs.casesBlocked);
    const counts = calculateExecutionCounts(reloadedA.inputs);
    expect(counts.qaTested).toBe(70);
    expect(counts.qaCompleted).toBe(90);
    expect(counts.remaining).toBe(10);

    // 11. Export a workspace backup (portable JSON, no IndexedDB internals).
    const backupText = JSON.stringify(createBackupPayload(third.workspace.app, third.workspace.reports));
    const parsed = parseBackupPayload(backupText);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // 12. Clear all local application data.
    const { clearAllLocalDataAsync } = await import('../lib/storage/db/persistenceBackend');
    await clearAllLocalDataAsync();
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
    expect(storage.getItem(REPORTS_STORAGE_KEY)).toBeNull();
    expect(idb.hasDatabase(DB_NAME)).toBe(false);

    // 13–14. Import the backup through the normal validation/normalization path.
    const imported = parseBackupPayload(backupText);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const write = await persistWorkspaceAsync(imported.data.appState, imported.data.reportsState);
    expect(write.ok).toBe(true);
    const afterImport = await initPersistence();
    expect(afterImport.workspace.reports.projects).toHaveLength(2);
    const finalA = afterImport.workspace.reports.projects.find((p) => p.projectId === 'PRJ-001')!;
    expect(finalA.inputs.casesPassed).toBe(60);
    expect(finalA.inputs.casesFailed).toBe(5);
    expect(finalA.inputs.casesNotApplicable).toBe(5);
    expect(finalA.inputs.spoAssigned).toBe(20);
    expect(finalA.inputs.casesBlocked).toBe(4);
    expect(finalA.inputs.casesRetest).toBe(2);
    expect(finalA.inputs.casesQuestioned).toBe(1);
    expect(afterImport.workspace.reports.reports.map((r) => r.id).sort()).toEqual(['rep-1', 'rep-2']);
    expect(afterImport.workspace.reports.attendance).toHaveLength(2);
    expect(afterImport.workspace.reports.topics).toHaveLength(1);
    expect(finalA.inputs.dailyActuals!.map((s) => s.id)).toEqual(['snap-legacy-1', 'snap-granular-1']);
  });
});

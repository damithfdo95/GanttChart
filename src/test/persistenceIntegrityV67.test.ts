import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, ProjectRecord, QaInputs, ReportsState } from '../types';
import { STORAGE_KEY, normalizeAppState, normalizeQaInputs } from '../lib/storage/storage';
import { defaultReportsState, REPORTS_STORAGE_KEY } from '../lib/storage/reports';
import { initPersistence } from '../lib/storage/db/bootstrap';
import { verifyWorkspaceIntegrity } from '../lib/storage/db/integrity';
import { buildManifest, parseManifest, PERSISTENCE_SCHEMA_VERSION, type PersistenceManifest } from '../lib/storage/db/manifest';
import { getStorageDiagnostics, persistWorkspaceAsync, readPersistenceManifestFromDb, resetPersistenceBackendForTests } from '../lib/storage/db/persistenceBackend';
import { newProjectRecord } from '../domain/projects';
import { FakeIDBFactory } from './helpers/fakeIndexedDb';

/**
 * V6.7 — centralized persistence integrity layer: structural checks on
 * projects/reports/snapshots/attendance/topics/identity/metadata, the
 * manifest model, and save-time / migration-time integrity gating.
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
    planningRows: [{ id: 'row-1', date: '2026-09-26', plannedTesters: 8, absentTesters: 0, nonWorkingDay: false, note: '' }],
  };
}

function reportsState(projects: ProjectRecord[], activeProjectId: string | null): ReportsState {
  return { ...defaultReportsState(), projects, activeProjectId };
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

/** Boot an already-migrated IndexedDB workspace from a seeded localStorage copy. */
async function bootWorkspace(): Promise<{ app: AppState; reports: ReportsState }> {
  const reports = reportsState([project('A'), project('B', [project('A')])], null);
  reports.activeProjectId = reports.projects[0].id;
  storage.setItem(STORAGE_KEY, JSON.stringify(appState()));
  storage.setItem(REPORTS_STORAGE_KEY, JSON.stringify(reports));
  const boot = await initPersistence();
  if (boot.mode !== 'indexeddb') throw new Error(`bootstrap failed: ${boot.migrationStatus}/${boot.health}`);
  return { app: boot.workspace.app, reports: boot.workspace.reports };
}

// ---- manifest model ----

describe('persistence manifest (V6.7 §3)', () => {
  it('builds a valid manifest with revision, backend and integrity status', () => {
    const manifest = buildManifest({
      revision: 7,
      backend: 'indexeddb',
      integrityStatus: 'verified',
      committedAt: NOW_ISO,
      lastSavedAt: 12345,
    });
    expect(manifest.schemaVersion).toBe(PERSISTENCE_SCHEMA_VERSION);
    expect(manifest.revision).toBe(7);
    expect(manifest.backend).toBe('indexeddb');
    expect(manifest.integrityStatus).toBe('verified');
  });

  it('round-trips through parse', () => {
    const manifest = buildManifest({
      revision: 3,
      backend: 'indexeddb',
      integrityStatus: 'warning',
      committedAt: NOW_ISO,
      lastSavedAt: null,
      lastMigrationAt: NOW_ISO,
    });
    expect(parseManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
  });

  it('rejects legacy V6.6 persistenceMeta payloads (no revision)', () => {
    expect(parseManifest({ lastSavedAt: 12345 })).toBeNull();
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest('nope')).toBeNull();
  });

  it('rejects invalid revisions, schema versions and backends', () => {
    const base = { revision: 1, committedAt: NOW_ISO, lastSavedAt: null, integrityStatus: 'verified', backend: 'indexeddb' } as const;
    expect(parseManifest({ ...base, schemaVersion: 1, revision: 0 })).toBeNull();
    expect(parseManifest({ ...base, schemaVersion: 1, revision: -1 })).toBeNull();
    expect(parseManifest({ ...base, schemaVersion: 1, revision: 1.5 })).toBeNull();
    expect(parseManifest({ ...base, schemaVersion: 1, revision: '2' })).toBeNull();
    expect(parseManifest({ ...base, schemaVersion: 2, revision: 2 })).toBeNull();
    expect(parseManifest({ ...base, schemaVersion: 1, backend: 'cloud' })).toBeNull();
    expect(parseManifest({ ...base, schemaVersion: 1, integrityStatus: 'great' })).toBeNull();
    expect(parseManifest({ ...base, schemaVersion: 1, committedAt: '' })).toBeNull();
  });

  it('keeps manifest schema version, DB schema version and workspace revision separate', async () => {
    await bootWorkspace();
    await persistWorkspaceAsync(appState(), reportsState([project('A')], null));
    const manifest = await readPersistenceManifestFromDb();
    expect(manifest).not.toBeNull();
    expect(manifest!.schemaVersion).toBe(1);
    expect(manifest!.revision).toBe(2);
    expect(idb.hasDatabase('GanttChartDB')).toBe(true);
  });

  it('persists the manifest in the database after migration and after saves', async () => {
    await bootWorkspace();
    let manifest = await readPersistenceManifestFromDb();
    expect(manifest?.revision).toBe(1);
    await persistWorkspaceAsync(appState(), reportsState([project('A')], null));
    manifest = await readPersistenceManifestFromDb();
    expect(manifest?.revision).toBe(2);
    expect(manifest?.backend).toBe('indexeddb');
    expect(typeof manifest?.committedAt).toBe('string');
  });
});

// ---- integrity: pure structural checks ----

describe('integrity checker (V6.7 §8–§10)', () => {
  const manifest = buildManifest({ revision: 1, backend: 'indexeddb', integrityStatus: 'verified', committedAt: NOW_ISO, lastSavedAt: null });

  it('reports a valid workspace as verified with no issues', () => {
    const result = verifyWorkspaceIntegrity(reportsState([project('A')], null), manifest);
    expect(result.status).toBe('verified');
    expect(result.issues).toEqual([]);
    expect(result.revision).toBe(1);
  });

  it('detects duplicate project record ids as a failure', () => {
    const a = project('A');
    const duplicate = { ...a, projectId: 'PRJ-099', nameEn: 'Copy', nameJa: 'Copy' };
    const result = verifyWorkspaceIntegrity(reportsState([a, duplicate], null), manifest);
    expect(result.status).toBe('failed');
    expect(result.issues.some((i) => i.code === 'projects.duplicate-id')).toBe(true);
  });

  it('detects duplicate stable project ids as a failure', () => {
    const a = project('A');
    const duplicate = { ...a, id: 'other-id' };
    const result = verifyWorkspaceIntegrity(reportsState([a, duplicate], null), manifest);
    expect(result.status).toBe('failed');
    expect(result.issues.some((i) => i.code === 'projects.duplicate-project-id')).toBe(true);
  });

  it('detects malformed project records (missing id, missing inputs)', () => {
    const a = project('A');
    const broken = { ...a, id: '' };
    const broken2 = { ...a, inputs: undefined as unknown as ProjectRecord['inputs'] };
    const result = verifyWorkspaceIntegrity(reportsState([a, broken, broken2], null), manifest);
    expect(result.status).toBe('failed');
    expect(result.issues.filter((i) => i.code === 'projects.malformed-record').length).toBeGreaterThanOrEqual(2);
  });

  it('reports the active project pointing at a missing project as a warning', () => {
    const result = verifyWorkspaceIntegrity(reportsState([project('A')], 'missing-id'), manifest);
    expect(result.status).toBe('warning');
    expect(result.issues.some((i) => i.code === 'projects.active-missing' && i.severity === 'warning')).toBe(true);
  });

  it('detects duplicate report ids as a failure', () => {
    const state = reportsState([project('A')], null);
    const report = {
      id: 'rep-1',
      reportDate: '2026-09-28',
      language: 'ja' as const,
      status: 'FINALIZED' as const,
      projectId: 'PRJ-001',
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
    };
    state.reports = [report, { ...report }];
    const result = verifyWorkspaceIntegrity(state, manifest);
    expect(result.status).toBe('failed');
    expect(result.issues.some((i) => i.code === 'reports.duplicate-id')).toBe(true);
  });

  it('reports an orphan report as a warning (evidence preserved, §26)', () => {
    const state = reportsState([project('A')], null);
    state.reports = [
      {
        id: 'rep-1',
        reportDate: '2026-09-28',
        language: 'ja',
        status: 'DRAFT',
        projectId: 'PRJ-999',
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
    const result = verifyWorkspaceIntegrity(state, manifest);
    expect(result.status).toBe('warning');
    expect(result.issues.some((i) => i.code === 'reports.orphan-project' && i.severity === 'warning')).toBe(true);
  });

  it('detects duplicate snapshot ids within one project as a failure', () => {
    const a = project('A');
    a.inputs.dailyActuals = [
      { id: 'snap-1', date: '2026-09-26', executed: 10, passed: 5 },
      { id: 'snap-1', date: '2026-09-27', executed: 20, passed: 8 },
    ];
    const result = verifyWorkspaceIntegrity(reportsState([a], null), manifest);
    expect(result.status).toBe('failed');
    expect(result.issues.some((i) => i.code === 'dailyActuals.duplicate-id-in-project')).toBe(true);
  });

  it('detects orphan snapshot rows (store level) as a warning', () => {
    const result = verifyWorkspaceIntegrity(reportsState([project('A')], null), manifest, [
      { id: 'snap-x', date: '2026-09-26', executed: 1, passed: 1, projectId: 'PRJ-999', order: 0 },
    ]);
    expect(result.status).toBe('warning');
    expect(result.issues.some((i) => i.code === 'dailyActuals.orphan-project')).toBe(true);
  });

  it('detects duplicate attendance and topic ids as failures', () => {
    const state = reportsState([project('A')], null);
    state.attendance = [
      {
        id: 'att-1',
        date: '2026-09-28',
        memberName: 'X',
        team: 'RCS',
        status: 'PRESENT',
        workingStart: null,
        workingEnd: null,
        leaveType: null,
        comment: '',
      },
      {
        id: 'att-1',
        date: '2026-09-28',
        memberName: 'Y',
        team: 'RCS',
        status: 'ABSENT',
        workingStart: null,
        workingEnd: null,
        leaveType: null,
        comment: '',
      },
    ];
    state.topics = [
      { id: 'topic-1', reportDate: '2026-09-28', title: 'T', description: '', displayOrder: 0, createdBy: 'sup', createdAt: NOW_ISO, updatedAt: NOW_ISO },
      { id: 'topic-1', reportDate: '2026-09-28', title: 'T2', description: '', displayOrder: 1, createdBy: 'sup', createdAt: NOW_ISO, updatedAt: NOW_ISO },
    ];
    const result = verifyWorkspaceIntegrity(state, manifest);
    expect(result.status).toBe('failed');
    expect(result.issues.some((i) => i.code === 'attendance.duplicate-id')).toBe(true);
    expect(result.issues.some((i) => i.code === 'topics.duplicate-id')).toBe(true);
  });

  it('flags an invalid manifest revision / schema version as metadata failures', () => {
    const state = reportsState([project('A')], null);
    const badRevision = { ...manifest, revision: 0 } as PersistenceManifest;
    const badSchema = { ...manifest, schemaVersion: 0 } as PersistenceManifest;
    expect(verifyWorkspaceIntegrity(state, badRevision).issues.some((i) => i.code === 'metadata.invalid-revision')).toBe(true);
    expect(verifyWorkspaceIntegrity(state, badSchema).issues.some((i) => i.code === 'metadata.invalid-schema-version')).toBe(true);
  });

  it('flags a manifest claiming a failed-integrity commit as impossible', () => {
    const failedManifest = buildManifest({ revision: 1, backend: 'indexeddb', integrityStatus: 'failed', committedAt: NOW_ISO, lastSavedAt: null });
    const result = verifyWorkspaceIntegrity(reportsState([project('A')], null), failedManifest);
    expect(result.issues.some((i) => i.code === 'metadata.manifest-impossible')).toBe(true);
  });

  it('treats an absent manifest as no metadata issue', () => {
    const result = verifyWorkspaceIntegrity(reportsState([project('A')], null), null);
    expect(result.status).toBe('verified');
  });

  it('reports broken identity references without inventing replacements (§25/§26)', () => {
    const state = reportsState([project('A')], null);
    state.rcsMembers = [
      { id: 'USER0001', name: 'A', team: 'RCS', role: 'SV', startDate: '2026-07-01', active: true },
      { id: 'USER0001', name: 'A2', team: 'RCS', role: 'SV', startDate: '2026-07-01', active: true },
    ];
    state.externalIdentities = [
      { id: 'ext-1', provider: 'jira', externalId: 'jira-x', memberId: 'USER9999', active: true, linkedAt: NOW_ISO },
    ];
    state.testerAssignments = [
      { id: 'asg-1', projectId: 'PRJ-999', memberId: 'USER0001', startDate: '2026-09-26', active: true },
    ];
    const result = verifyWorkspaceIntegrity(state, manifest);
    expect(result.status).toBe('failed');
    expect(result.issues.some((i) => i.code === 'identity.duplicate-member-id')).toBe(true);
    expect(result.issues.some((i) => i.code === 'identity.external-identity-broken-member' && i.severity === 'warning')).toBe(true);
    expect(result.issues.some((i) => i.code === 'identity.assignment-orphan-project' && i.severity === 'warning')).toBe(true);
  });

  it('aggregates multiple simultaneous issues with correct severities', () => {
    const a = project('A');
    a.inputs.dailyActuals = [
      { id: 'snap-1', date: '2026-09-26', executed: 1, passed: 1 },
      { id: 'snap-1', date: '2026-09-27', executed: 2, passed: 2 },
    ];
    const state = reportsState([a], 'missing-active');
    state.reports = [
      {
        id: 'rep-1',
        reportDate: '2026-09-28',
        language: 'ja',
        status: 'DRAFT',
        projectId: 'PRJ-999',
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
    const result = verifyWorkspaceIntegrity(state, manifest);
    expect(result.status).toBe('failed');
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain('dailyActuals.duplicate-id-in-project');
    expect(codes).toContain('reports.orphan-project');
    expect(codes).toContain('projects.active-missing');
    expect(result.issues.every((i) => i.severity === 'failure' || i.severity === 'warning')).toBe(true);
  });

  it('never mutates the workspace it inspects (§9)', () => {
    const state = reportsState([project('A')], null);
    const before = JSON.stringify(state);
    verifyWorkspaceIntegrity(state, manifest);
    verifyWorkspaceIntegrity(state, null);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('issue messages reference record ids only, never user content', () => {
    const a = project('A');
    const duplicate = { ...a, projectId: 'PRJ-099', nameEn: 'SECRET PROJECT NAME', nameJa: '秘密' };
    const result = verifyWorkspaceIntegrity(reportsState([a, duplicate], null), manifest);
    const json = JSON.stringify(result.issues);
    expect(json).not.toContain('SECRET PROJECT NAME');
    expect(json).not.toContain('秘密');
  });
});

// ---- integrity during save / migration (§11/§12) ----

describe('integrity gating during persistence (V6.7 §11–§13)', () => {
  it('blocks a save whose workspace fails integrity and does not advance the revision', async () => {
    const w = await bootWorkspace();
    const a = w.reports.projects[0];
    const broken = { ...w.reports, projects: [a, { ...a, projectId: 'PRJ-099' }] };
    const before = await readPersistenceManifestFromDb();
    const result = await persistWorkspaceAsync(w.app, broken);
    expect(result.ok).toBe(false);
    expect(result.integrityStatus).toBe('failed');
    const after = await readPersistenceManifestFromDb();
    expect(after?.revision).toBe(before?.revision);
    // The corrupted state never reached the database.
    const reloaded = await initPersistence();
    expect(reloaded.workspace.reports.projects).toHaveLength(2);
  });

  it('commits a workspace that only has warnings, recording the warning status', async () => {
    const w = await bootWorkspace();
    const orphaned = {
      ...w.reports,
      reports: [
        ...w.reports.reports,
        {
          id: 'rep-orphan',
          reportDate: '2026-09-28',
          language: 'ja' as const,
          status: 'DRAFT' as const,
          projectId: 'PRJ-999',
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
      ],
    };
    const result = await persistWorkspaceAsync(w.app, orphaned);
    expect(result.ok).toBe(true);
    expect(result.integrityStatus).toBe('warning');
    const manifest = await readPersistenceManifestFromDb();
    expect(manifest?.integrityStatus).toBe('warning');
  });

  it('surfaces the integrity status through the diagnostics', async () => {
    const w = await bootWorkspace();
    await persistWorkspaceAsync(w.app, w.reports);
    const diagnostics = await getStorageDiagnostics();
    expect(diagnostics.integrityStatus).toBe('verified');
    expect(diagnostics.revision).toBeGreaterThan(0);
  });

  it('blocks migration when the localStorage source is structurally invalid', async () => {
    const reports = reportsState([project('A')], null);
    const duplicate = { ...reports.projects[0], projectId: 'PRJ-099' };
    storage.setItem(STORAGE_KEY, JSON.stringify(appState()));
    storage.setItem(REPORTS_STORAGE_KEY, JSON.stringify({ ...reports, projects: [...reports.projects, duplicate] }));
    const boot = await initPersistence();
    expect(boot.migrationStatus).toBe('failed');
    expect(boot.mode).toBe('localstorage');
    // The invalid source data is preserved untouched.
    expect(storage.getItem(REPORTS_STORAGE_KEY)).not.toBeNull();
  });

  it('does not mark migration complete when integrity fails', async () => {
    const reports = reportsState([project('A')], null);
    const duplicate = { ...reports.projects[0], projectId: 'PRJ-099' };
    storage.setItem(STORAGE_KEY, JSON.stringify(appState()));
    storage.setItem(REPORTS_STORAGE_KEY, JSON.stringify({ ...reports, projects: [...reports.projects, duplicate] }));
    await initPersistence();
    const { readStorageMigrationRecord } = await import('../lib/storage/db/migration');
    expect(await readStorageMigrationRecord()).toBeNull();
  });

  it('migration of a warning-only workspace completes with a warning manifest', async () => {
    const reports = reportsState([project('A')], 'missing-active');
    storage.setItem(STORAGE_KEY, JSON.stringify(appState()));
    storage.setItem(REPORTS_STORAGE_KEY, JSON.stringify(reports));
    const boot = await initPersistence();
    expect(boot.migrationStatus).toBe('completed');
    const manifest = await readPersistenceManifestFromDb();
    expect(manifest?.integrityStatus).toBe('warning');
  });
});

// ---- historical honesty through integrity/recovery (§25) ----

describe('historical honesty through the V6.7 layers (§25)', () => {
  it('keeps legacy snapshot fields unknown through migration, save, reload and backup import', async () => {
    const a = project('A');
    a.inputs.dailyActuals = [{ id: 'snap-legacy', date: '2026-09-26', executed: 70, passed: 60 }];
    const b = project('B', [a]);
    b.inputs.dailyActuals = [
      {
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
      },
    ];
    const reports = reportsState([a, b], a.id);
    storage.setItem(STORAGE_KEY, JSON.stringify(appState()));
    storage.setItem(REPORTS_STORAGE_KEY, JSON.stringify(reports));
    await initPersistence();

    // Reload: unknown granular values stay unknown.
    let reloaded = await initPersistence();
    let legacy = reloaded.workspace.reports.projects[0].inputs.dailyActuals![0];
    expect(legacy.executed).toBe(70);
    expect(legacy.passed).toBe(60);
    expect('casesFailed' in legacy).toBe(false);

    // Save + reload: unchanged.
    await persistWorkspaceAsync(reloaded.workspace.app, reloaded.workspace.reports);
    reloaded = await initPersistence();
    legacy = reloaded.workspace.reports.projects[0].inputs.dailyActuals![0];
    expect('casesFailed' in legacy).toBe(false);
    expect(reloaded.workspace.reports.projects[1].inputs.dailyActuals![0].casesPassed).toBe(58);

    // Backup export → import: still unknown.
    const { createBackupPayload, parseBackupPayload } = await import('../lib/backup/backup');
    const backup = parseBackupPayload(JSON.stringify(createBackupPayload(reloaded.workspace.app, reloaded.workspace.reports)));
    expect(backup.ok).toBe(true);
    if (!backup.ok) return;
    const imported = await persistWorkspaceAsync(backup.data.appState, backup.data.reportsState);
    expect(imported.ok).toBe(true);
    reloaded = await initPersistence();
    legacy = reloaded.workspace.reports.projects[0].inputs.dailyActuals![0];
    expect('casesFailed' in legacy).toBe(false);
    expect(legacy.executed).toBe(70);
    expect(legacy.passed).toBe(60);
  });

  it('never changes V6.4 granular execution values through persistence', async () => {
    const a = project('A');
    const reports = reportsState([a], a.id);
    storage.setItem(STORAGE_KEY, JSON.stringify(appState()));
    storage.setItem(REPORTS_STORAGE_KEY, JSON.stringify(reports));
    await initPersistence();
    const reloaded = await initPersistence();
    const { calculateExecutionCounts } = await import('../lib/calculations/execution');
    const counts = calculateExecutionCounts(reloaded.workspace.reports.projects[0].inputs);
    expect(counts.qaTested).toBe(70);
    expect(counts.qaCompleted).toBe(90);
    expect(counts.remaining).toBe(10);
    expect(counts.pass).toBe(60);
    expect(counts.fail).toBe(5);
    expect(counts.notApplicable).toBe(5);
    expect(counts.blocked).toBe(3);
    expect(counts.retest).toBe(2);
    expect(counts.questioned).toBe(1);
  });
});

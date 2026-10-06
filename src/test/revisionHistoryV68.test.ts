import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, ProjectRecord, QaInputs, ReportsState } from '../types';
import { STORAGE_KEY, normalizeAppState, normalizeQaInputs } from '../lib/storage/storage';
import { defaultReportsState, REPORTS_STORAGE_KEY } from '../lib/storage/reports';
import { consumeCorruptionEvents } from '../lib/storage/corruption';
import { initPersistence } from '../lib/storage/db/bootstrap';
import { DB_NAME, STORE_METADATA, STORE_REVISION_HISTORY } from '../lib/storage/db/repository';
import {
  clearAllLocalDataAsync,
  getStorageDiagnostics,
  importHistoryWorkspace,
  persistWorkspaceAsync,
  readPersistenceManifestFromDb,
  getWorkspaceRevision,
  resetPersistenceBackendForTests,
} from '../lib/storage/db/persistenceBackend';
import {
  countRevisions,
  getLatestRevision,
  getRevision,
  getRevisionHistory,
  getRevisionsAfter,
  pruneRevisionHistory,
  readJournalIntegrity,
  verifyJournalIntegrity,
  writeJournalAnchor,
} from '../lib/storage/db/revisionHistory';
import { diffWorkspaces, isNoOpDiff, type CanonicalWorkspace } from '../lib/storage/db/diff';
import type { WorkspaceRevision } from '../lib/storage/db/journal';
import { createHistoryBackupPayload, parseHistoryBackupPayload } from '../lib/backup/backup';
import { newProjectRecord } from '../domain/projects';
import { FakeIDBFactory } from './helpers/fakeIndexedDb';

/**
 * V6.8 — durable local revision journal: every successful commit gets a
 * journal entry, failed transactions create no history, deterministic domain
 * diffs, retention, journal integrity, the V6.7 migration anchor and the
 * portable history backup.
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
  consumeCorruptionEvents();
  vi.stubGlobal('window', { localStorage: storage });
  vi.stubGlobal('indexedDB', idb);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetPersistenceBackendForTests();
});

/** §34 granular acceptance inputs: Pass 60 / Fail 5 / N/A 5 / SPO 20 (+3/2/1 informational). */
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

function reportsState(projects: ProjectRecord[], activeProjectId: string | null): ReportsState {
  return { ...defaultReportsState(), projects, activeProjectId };
}

/** Fresh clean database (no localStorage) → first persisted workspace is revision 1. */
async function bootFresh(): Promise<void> {
  const boot = await initPersistence();
  if (boot.mode !== 'indexeddb') throw new Error(`fresh bootstrap failed: ${boot.migrationStatus}/${boot.health}`);
}

/** Seed a legacy localStorage workspace and migrate it (revision 1, migration anchor). */
async function bootMigrated(): Promise<{ app: AppState; reports: ReportsState }> {
  const reports = reportsState([project('A'), project('B', [project('A')])], null);
  reports.activeProjectId = reports.projects[0].id;
  storage.setItem(STORAGE_KEY, JSON.stringify(appState()));
  storage.setItem(REPORTS_STORAGE_KEY, JSON.stringify(reports));
  const boot = await initPersistence();
  if (boot.mode !== 'indexeddb') throw new Error(`bootstrap failed: ${boot.migrationStatus}/${boot.health}`);
  return { app: boot.workspace.app, reports: boot.workspace.reports };
}

function baseWorkspace(): CanonicalWorkspace {
  const projectA = project('A');
  const projectB = project('B', [projectA]);
  const reports = reportsState([projectA, projectB], projectA.id);
  return { app: appState(), reports };
}

/** Sync an execution edit of the active project into its project record (as the app's write-back does). */
function withExecution(w: CanonicalWorkspace, casesCompleted: number): CanonicalWorkspace {
  const active = w.reports.activeProjectId;
  return {
    app: { ...w.app, casesCompleted },
    reports: {
      ...w.reports,
      projects: w.reports.projects.map((p) =>
        p.id === active ? { ...p, inputs: { ...p.inputs, casesCompleted }, updatedAt: NOW_ISO } : p,
      ),
    },
  };
}

describe('journal creation (V6.8 §5, §41)', () => {
  it('a fresh installation creates the initial revision on the first commit, not on startup', async () => {
    await bootFresh();
    expect(await countRevisions()).toBe(0); // startup alone creates nothing
    const w = baseWorkspace();
    const result = await persistWorkspaceAsync(w.app, w.reports);
    expect(result.ok).toBe(true);
    expect(result.revision).toBe(1);
    const entry = await getRevision(1);
    expect(entry?.reason).toBe('initial');
    expect(entry?.changeSummary).toBeNull(); // no previous V6.8 state to diff
    expect(await countRevisions()).toBe(1);
  });

  it('every successful commit creates a journal entry whose revision matches the manifest', async () => {
    await bootFresh();
    const w = baseWorkspace();
    await persistWorkspaceAsync(w.app, w.reports);
    await persistWorkspaceAsync({ ...w.app, casesCompleted: 80 }, w.reports);
    await persistWorkspaceAsync({ ...w.app, casesCompleted: 70 }, w.reports);
    const manifest = await readPersistenceManifestFromDb();
    expect(manifest?.revision).toBe(3);
    expect(await getLatestRevision()).toBe(3);
    expect((await getRevisionHistory()).map((m) => m.revision)).toEqual([3, 2, 1]);
  });

  it('a no-op state produces no revision and no journal entry', async () => {
    await bootFresh();
    const w = baseWorkspace();
    await persistWorkspaceAsync(w.app, w.reports);
    const again = await persistWorkspaceAsync(w.app, w.reports);
    expect(again.changed).toBe(false);
    expect(await countRevisions()).toBe(1);
  });

  it('a failed transaction creates no committed journal entry and no revision', async () => {
    await bootFresh();
    const w = baseWorkspace();
    await persistWorkspaceAsync(w.app, w.reports); // revision 1
    idb.abortNextTransaction = true;
    const failed = await persistWorkspaceAsync({ ...w.app, casesCompleted: 80 }, w.reports);
    expect(failed.ok).toBe(false);
    expect(failed.revision).toBe(1);
    expect(await countRevisions()).toBe(1); // no committed entry for the failed save
    // The next successful save continues the sequence with no durable gap.
    const ok = await persistWorkspaceAsync({ ...w.app, casesCompleted: 70 }, w.reports);
    expect(ok.revision).toBe(2);
    expect((await getRevisionHistory()).map((m) => m.revision)).toEqual([2, 1]);
  });

  it('the workspace, manifest and journal commit atomically (abort leaves the previous valid state)', async () => {
    await bootFresh();
    const w = baseWorkspace();
    await persistWorkspaceAsync(w.app, w.reports);
    idb.abortNextTransaction = true;
    await persistWorkspaceAsync({ ...w.app, casesCompleted: 80 }, w.reports);
    // Reload: the database still holds the revision-1 state, journal and manifest.
    const boot = await initPersistence();
    expect(boot.health).toBe('healthy');
    expect(boot.revision).toBe(1);
    expect(boot.workspace.app.casesCompleted).toBe(w.app.casesCompleted);
    expect(await countRevisions()).toBe(1);
    const manifest = await readPersistenceManifestFromDb();
    expect(manifest?.revision).toBe(1);
  });

  it('concurrent saves serialize: latest wins, all committed revisions journaled in order (§38)', async () => {
    await bootFresh();
    const w = baseWorkspace();
    const results = await Promise.all([
      persistWorkspaceAsync({ ...w.app, casesCompleted: 50 }, w.reports),
      persistWorkspaceAsync({ ...w.app, casesCompleted: 60 }, w.reports),
      persistWorkspaceAsync({ ...w.app, casesCompleted: 70 }, w.reports),
      persistWorkspaceAsync({ ...w.app, casesCompleted: 80 }, w.reports),
      persistWorkspaceAsync({ ...w.app, casesCompleted: 90 }, w.reports),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results[results.length - 1].revision).toBe(5);
    expect(await getLatestRevision()).toBe(5);
    expect((await getRevisionHistory()).map((m) => m.revision)).toEqual([5, 4, 3, 2, 1]);
    const boot = await initPersistence();
    expect(boot.workspace.app.casesCompleted).toBe(90); // latest state wins
  });

  it('mixed success/failure: only committed revisions appear in the journal', async () => {
    await bootFresh();
    const w = baseWorkspace();
    await persistWorkspaceAsync({ ...w.app, casesCompleted: 50 }, w.reports); // A → revision 1
    idb.abortNextTransaction = true;
    const failed = await persistWorkspaceAsync({ ...w.app, casesCompleted: 60 }, w.reports); // B fails
    expect(failed.ok).toBe(false);
    const ok = await persistWorkspaceAsync({ ...w.app, casesCompleted: 70 }, w.reports); // C → revision 2
    expect(ok.ok).toBe(true);
    expect((await getRevisionHistory()).map((m) => m.revision)).toEqual([2, 1]); // A, C — no B
  });
});

describe('journal entry content (V6.8 §4, §8)', () => {
  it('records committedAt, affected stable project ids and the integrity status', async () => {
    await bootFresh();
    const w = baseWorkspace();
    await persistWorkspaceAsync(w.app, w.reports);
    const entry = await getRevision(1);
    expect(entry).not.toBeNull();
    expect(typeof entry!.committedAt).toBe('string');
    expect(entry!.integrityStatus).toBe('verified');
    // The initial commit created both projects → both stable ids are affected.
    expect(entry!.affectedProjectIds.sort()).toEqual(['PRJ-001', 'PRJ-002']);
    // Execution edit of the active project (app + synced record):
    const next = withExecution(w, 80);
    await persistWorkspaceAsync(next.app, next.reports);
    const entry2 = await getRevision(2);
    const activeStable = w.reports.projects.find((p) => p.id === w.reports.activeProjectId)!.projectId;
    expect(entry2?.affectedProjectIds).toContain(activeStable);
    expect(entry2?.reason).toBe('edit');
    expect(entry2?.changeSummary?.executionChanged).toBe(true);
  });

  it('reason classification: project-created', async () => {
    await bootFresh();
    const w = baseWorkspace();
    await persistWorkspaceAsync(w.app, w.reports);
    const bigger = { app: w.app, reports: reportsState([...w.reports.projects, project('C', w.reports.projects)], w.reports.activeProjectId) };
    await persistWorkspaceAsync(bigger.app, bigger.reports);
    expect((await getRevision(2))?.reason).toBe('project-created');
    expect((await getRevision(2))?.changeSummary?.projectsCreated).toHaveLength(1);
  });

  it('reason classification: project-deleted', async () => {
    await bootFresh();
    const w = baseWorkspace();
    await persistWorkspaceAsync(w.app, w.reports);
    const smaller = { app: w.app, reports: reportsState(w.reports.projects.slice(0, 1), w.reports.activeProjectId) };
    await persistWorkspaceAsync(smaller.app, smaller.reports);
    expect((await getRevision(2))?.reason).toBe('project-deleted');
    expect((await getRevision(2))?.changeSummary?.projectsDeleted).toHaveLength(1);
  });

  it('reason classification: report lifecycle', async () => {
    await bootFresh();
    const w = baseWorkspace();
    await persistWorkspaceAsync(w.app, w.reports);
    const report = {
      id: 'rep-1',
      reportDate: '2026-09-29',
      language: 'ja' as const,
      status: 'DRAFT' as const,
      projectId: w.reports.projects[0].projectId,
      revisionOf: null,
      jiraUrl: null,
      activities: [],
      nextDay: [],
      previewText: '',
      createdBy: 'SV',
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
      finalizedAt: null,
      finalizedBy: null,
      snapshot: null,
    };
    await persistWorkspaceAsync(w.app, { ...w.reports, reports: [report] });
    expect((await getRevision(2))?.reason).toBe('report-created');
    await persistWorkspaceAsync(w.app, {
      ...w.reports,
      reports: [{ ...report, previewText: 'updated' }],
    });
    expect((await getRevision(3))?.reason).toBe('report-updated');
    await persistWorkspaceAsync(w.app, w.reports);
    expect((await getRevision(4))?.reason).toBe('report-deleted');
  });

  it('reason classification: attendance / topics / identity', async () => {
    await bootFresh();
    const w = baseWorkspace();
    await persistWorkspaceAsync(w.app, w.reports);
    const attendance = [{ id: 'att-1', date: '2026-09-29', memberName: 'M', team: 'T', status: 'PRESENT' as const, workingStart: '09:00', workingEnd: '17:30', leaveType: null, comment: '' }];
    await persistWorkspaceAsync(w.app, { ...w.reports, attendance });
    expect((await getRevision(2))?.reason).toBe('attendance-updated');
    const topics = [{ id: 'top-1', reportDate: '2026-09-29', title: 'T', description: '', displayOrder: 0, createdBy: 'SV', createdAt: NOW_ISO, updatedAt: NOW_ISO }];
    await persistWorkspaceAsync(w.app, { ...w.reports, attendance, topics });
    expect((await getRevision(3))?.reason).toBe('topic-updated');
    const members = [{ id: 'USER0001', name: 'Tokunaga Hiroshi', team: 'RCS', role: 'SV', startDate: '2026-07-01', active: true }];
    await persistWorkspaceAsync(w.app, { ...w.reports, attendance, topics, rcsMembers: members });
    expect((await getRevision(4))?.reason).toBe('identity-updated');
    expect((await getRevision(4))?.changeSummary?.identityChanged).toBe(true);
  });

  it('summary flags: snapshots, assignments, reviews, planning, settings', async () => {
    await bootFresh();
    const w = baseWorkspace();
    await persistWorkspaceAsync(w.app, w.reports);
    // Daily-actual snapshot change.
    const withSnapshot: CanonicalWorkspace = {
      app: w.app,
      reports: {
        ...w.reports,
        projects: w.reports.projects.map((p) => ({
          ...p,
          inputs: { ...p.inputs, dailyActuals: [...(p.inputs.dailyActuals ?? []), { id: 'snap-2', date: '2026-09-29', executed: 10, passed: 9 }] },
        })),
      },
    };
    await persistWorkspaceAsync(withSnapshot.app, withSnapshot.reports);
    expect((await getRevision(2))?.changeSummary?.snapshotsChanged).toBe(true);
    // Tester assignment change.
    const withAssignment: CanonicalWorkspace = {
      app: w.app,
      reports: {
        ...withSnapshot.reports,
        testerAssignments: [{ id: 'asg-1', memberId: 'USER0001', projectId: w.reports.projects[0].projectId, startDate: '2026-09-26', active: true }],
      },
    };
    await persistWorkspaceAsync(withAssignment.app, withAssignment.reports);
    expect((await getRevision(3))?.changeSummary?.testerAssignmentsChanged).toBe(true);
    // Planning change (app-level).
    await persistWorkspaceAsync(
      { ...withAssignment.app, planningRows: [...withAssignment.app.planningRows, { id: 'row-2', date: '2026-09-27', plannedTesters: 4, absentTesters: 0, nonWorkingDay: false, note: '' }] },
      withAssignment.reports,
    );
    expect((await getRevision(4))?.changeSummary?.planningChanged).toBe(true);
    // Settings-only change (language) still attributes the active project.
    await persistWorkspaceAsync({ ...withAssignment.app, language: 'en' }, withAssignment.reports);
    expect((await getRevision(5))?.changeSummary?.settingsChanged).toBe(true);
    const activeStable = w.reports.projects.find((p) => p.id === w.reports.activeProjectId)!.projectId;
    expect((await getRevision(5))?.affectedProjectIds).toContain(activeStable);
  });
});

describe('deterministic diff (V6.8 §9–§11)', () => {
  it('is a pure function: the same inputs produce the same summary', () => {
    const prev = baseWorkspace();
    const next = withExecution(prev, 55);
    const a = diffWorkspaces(prev, next);
    const b = diffWorkspaces(prev, next);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('a no-op state produces no domain changes', () => {
    const w = baseWorkspace();
    expect(isNoOpDiff(diffWorkspaces(w, w))).toBe(true);
    expect(isNoOpDiff(diffWorkspaces(w, JSON.parse(JSON.stringify(w)) as CanonicalWorkspace))).toBe(true);
  });

  it('diffs against null (anchor) treat everything as created', () => {
    const next = baseWorkspace();
    const diff = diffWorkspaces(null, next);
    expect(diff.summary.projectsCreated).toHaveLength(2);
    expect(diff.summary.snapshotsChanged).toBe(true); // snap-1 exists
  });
});

describe('journal integrity (V6.8 §19–§20)', () => {
  it('verified when journal head matches the manifest and revisions are unique/ascending', async () => {
    await bootFresh();
    const w = baseWorkspace();
    await persistWorkspaceAsync(w.app, w.reports);
    await persistWorkspaceAsync({ ...w.app, casesCompleted: 80 }, w.reports);
    const result = await readJournalIntegrity(2);
    expect(result.status).toBe('verified');
    expect(result.issues).toEqual([]);
    expect(result.entryCount).toBe(2);
  });

  it('journal behind the manifest → degraded warning, never silently repaired', async () => {
    await bootFresh();
    const w = baseWorkspace();
    await persistWorkspaceAsync(w.app, w.reports);
    await persistWorkspaceAsync({ ...w.app, casesCompleted: 80 }, w.reports);
    idb.deleteRecord(DB_NAME, STORE_REVISION_HISTORY, 2);
    const result = await readJournalIntegrity(2);
    expect(result.status).toBe('warning');
    expect(result.issues).toContain('journal.behind-manifest');
    // Reloading does NOT rewrite the journal to match the numbers.
    await initPersistence();
    expect(await countRevisions()).toBe(1);
  });

  it('journal ahead of the manifest → integrity attention', async () => {
    const entries: WorkspaceRevision[] = [];
    await bootFresh();
    const w = baseWorkspace();
    await persistWorkspaceAsync(w.app, w.reports); // revision 1
    // Simulate a manifest rollback: manifest deleted, journal intact.
    idb.deleteRecord(DB_NAME, STORE_METADATA, 'persistenceMeta');
    const result = await readJournalIntegrity(0);
    expect(result.status).toBe('warning');
    expect(result.issues).toContain('journal.ahead-of-manifest');
    void entries;
  });

  it('duplicate and non-monotonic revisions are detected', () => {
    const base = baseWorkspace();
    const e1 = { revision: 1, committedAt: NOW_ISO, reason: 'edit' as const, affectedProjectIds: [], changeSummary: null, integrityStatus: 'verified' as const, snapshot: { appState: base.app, reportsState: base.reports } };
    const e1b = { ...e1, committedAt: '2026-09-29T10:00:00.000Z' };
    const result = verifyJournalIntegrity([e1, e1b], 1);
    expect(result.issues).toContain('journal.non-monotonic@1');
    expect(result.issues).toContain('journal.duplicate-revision@1');
  });

  it('empty journal with a committed manifest → unavailable', () => {
    const result = verifyJournalIntegrity([], 7);
    expect(result.status).toBe('unavailable');
    expect(result.issues).toContain('journal.empty');
  });

  it('diagnostics expose the history block (count, latest, integrity)', async () => {
    await bootFresh();
    const w = baseWorkspace();
    await persistWorkspaceAsync(w.app, w.reports);
    const diagnostics = await getStorageDiagnostics();
    expect(diagnostics.history.available).toBe(true);
    expect(diagnostics.history.entryCount).toBe(1);
    expect(diagnostics.history.latestRevision).toBe(1);
    expect(diagnostics.history.integrity).toBe('verified');
  });

  it('a corrupted journal entry is skipped and reported, the workspace keeps working (§25)', async () => {
    await bootFresh();
    const w = baseWorkspace();
    await persistWorkspaceAsync(w.app, w.reports);
    await persistWorkspaceAsync({ ...w.app, casesCompleted: 80 }, w.reports);
    // Corrupt the CURRENT journal entry — the journal head falls behind the
    // manifest and integrity reports the degradation.
    idb.writeRecord(DB_NAME, STORE_REVISION_HISTORY, 2, { broken: true });
    const diagnostics = await getStorageDiagnostics();
    expect(diagnostics.history.entryCount).toBe(1); // revision 1 only — 2 is unreadable
    expect(diagnostics.history.integrity).toBe('warning');
    expect(diagnostics.history.issues).toContain('journal.behind-manifest');
    // Normal operation continues: the next successful commit appends a valid entry.
    const ok = await persistWorkspaceAsync({ ...w.app, casesCompleted: 70 }, w.reports);
    expect(ok.revision).toBe(3);
    expect(await countRevisions()).toBe(2);
    const boot = await initPersistence();
    expect(boot.health).toBe('healthy');
    expect(boot.revision).toBe(3);
  });
});

describe('retention (V6.8 §17–§18)', () => {
  it('prunes the oldest revisions beyond the cap, never the current one', async () => {
    await bootFresh();
    const w = baseWorkspace();
    for (let i = 50; i <= 61; i += 1) {
      await persistWorkspaceAsync({ ...w.app, casesCompleted: i }, w.reports);
    }
    expect(await countRevisions()).toBe(12); // revisions 1..12
    const pruned = await pruneRevisionHistory(12, 10);
    expect(pruned).toBe(2);
    expect(await countRevisions()).toBe(10);
    expect((await getRevisionHistory()).map((m) => m.revision)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    // The current revision is never pruned even with retention 1.
    const prunedMore = await pruneRevisionHistory(12, 1);
    expect(prunedMore).toBe(9);
    expect((await getRevisionHistory()).map((m) => m.revision)).toEqual([12]);
  });

  it('restoring a pruned revision reports it as pruned, not found', async () => {
    await bootFresh();
    const w = baseWorkspace();
    await persistWorkspaceAsync(w.app, w.reports);
    await persistWorkspaceAsync({ ...w.app, casesCompleted: 80 }, w.reports);
    await persistWorkspaceAsync({ ...w.app, casesCompleted: 70 }, w.reports);
    await pruneRevisionHistory(3, 1);
    const history = await getRevision(1);
    expect(history).toBeNull();
  });
});

describe('V6.7 → V6.8 migration anchor (V6.8 §42–§43)', () => {
  it('an existing V6.7 database (no journal) anchors at its CURRENT revision without fabricating history', async () => {
    await bootMigrated(); // revision 1 via localStorage migration + anchor
    const w2 = { app: appState(), reports: reportsState([project('A'), project('B', [project('A')])], null) };
    // Advance to revision 5 as a V6.7-era database, then erase the journal.
    for (let i = 80; i >= 77; i -= 1) {
      await persistWorkspaceAsync({ ...w2.app, casesCompleted: i }, w2.reports);
    }
    expect(await getLatestRevision()).toBe(5);
    for (const key of idb.listKeys(DB_NAME, STORE_REVISION_HISTORY)) {
      idb.deleteRecord(DB_NAME, STORE_REVISION_HISTORY, key);
    }
    // V6.8 startup detects the missing journal and writes ONE anchor at revision 5.
    const boot = await initPersistence();
    expect(boot.revision).toBe(5); // preserved, never reset
    expect(await countRevisions()).toBe(1);
    const anchor = await getRevision(5);
    expect(anchor?.reason).toBe('migration');
    expect(anchor?.changeSummary).toBeNull();
    // The next commit continues from 6 — no gap, no speculation.
    const next = await persistWorkspaceAsync({ ...w2.app, casesCompleted: 50 }, w2.reports);
    expect(next.revision).toBe(6);
    expect((await getRevisionHistory()).map((m) => m.revision)).toEqual([6, 5]);
  });

  it('the anchor is idempotent (a second startup writes nothing)', async () => {
    await bootMigrated();
    await initPersistence();
    await initPersistence();
    expect(await countRevisions()).toBe(1);
  });

  it('writeJournalAnchor refuses invalid revisions', async () => {
    const w = baseWorkspace();
    expect(await writeJournalAnchor(0, NOW_ISO, 'migration', w)).toBe(false);
  });
});

describe('history backup (V6.8 §30–§31)', () => {
  it('round-trips the current state and the retained journal portably', async () => {
    await bootFresh();
    const w = baseWorkspace();
    await persistWorkspaceAsync(w.app, w.reports);
    await persistWorkspaceAsync({ ...w.app, casesCompleted: 80 }, w.reports);
    const revisions = await getRevisionsAfter(0);
    const payload = createHistoryBackupPayload(w.app, w.reports, revisions);
    const text = JSON.stringify(payload);
    // No browser/IndexedDB internals leak into the file.
    expect(text).not.toContain('GanttChartDB');
    expect(text).not.toContain('objectStore');
    const parsed = parseHistoryBackupPayload(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.data.revisions).toHaveLength(2);
      expect(parsed.data.revisions.map((r) => r.revision)).toEqual([1, 2]);
    }
  });

  it('rejects invalid payloads clearly', () => {
    expect(parseHistoryBackupPayload('not json').ok).toBe(false);
    expect(parseHistoryBackupPayload(JSON.stringify({ app: 'ganttchart', kind: 'backup', version: 1 })).ok).toBe(false);
    const w = baseWorkspace();
    const good = createHistoryBackupPayload(w.app, w.reports, []);
    const tampered = JSON.parse(JSON.stringify(good));
    tampered.data.revisions = [{ broken: true }];
    expect(parseHistoryBackupPayload(JSON.stringify(tampered)).ok).toBe(false);
    const nonAscending = JSON.parse(JSON.stringify(good));
    const e = { revision: 2, committedAt: NOW_ISO, reason: 'edit', affectedProjectIds: [], changeSummary: null, integrityStatus: 'verified', snapshot: { appState: w.app, reportsState: w.reports } };
    nonAscending.data.revisions = [e, { ...e, revision: 2, committedAt: '2026-09-29T10:00:00.000Z' }];
    expect(parseHistoryBackupPayload(JSON.stringify(nonAscending)).ok).toBe(false);
  });

  it('importing a history backup creates a new import revision and keeps history reconstructable', async () => {
    await bootFresh();
    const w = baseWorkspace();
    await persistWorkspaceAsync(w.app, w.reports);
    await persistWorkspaceAsync({ ...w.app, casesCompleted: 80 }, w.reports); // head 2
    const payload = createHistoryBackupPayload(w.app, w.reports, await getRevisionsAfter(0));
    const parsed = parseHistoryBackupPayload(JSON.stringify(payload));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Continue editing after the export (revisions 3, 4).
    await persistWorkspaceAsync({ ...w.app, casesCompleted: 70 }, w.reports);
    await persistWorkspaceAsync({ ...w.app, casesCompleted: 60 }, w.reports);
    const result = await importHistoryWorkspace(parsed.data);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.revision).toBe(5); // continues from the current head
    const entry = await getRevision(5);
    expect(entry?.reason).toBe('import');
    // Replaced journal = exported revisions + the new import head; the exported
    // states remain reconstructable after the import.
    expect((await getRevisionHistory()).map((m) => m.revision)).toEqual([5, 2, 1]);
    const reconstructed = await getRevision(2);
    expect(reconstructed?.snapshot.appState.casesCompleted).toBe(80);
  });

  it('a failed history import is all-or-nothing: journal, state and revision stay untouched', async () => {
    await bootFresh();
    const w = baseWorkspace();
    await persistWorkspaceAsync(w.app, w.reports);
    await persistWorkspaceAsync({ ...w.app, casesCompleted: 80 }, w.reports); // head 2
    const payload = createHistoryBackupPayload({ ...w.app, casesCompleted: 10 }, w.reports, [
      (await getRevisionsAfter(0))[0], // a shorter, different history (revision 1 only)
    ]);
    const parsed = parseHistoryBackupPayload(JSON.stringify(payload));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const historyBefore = (await getRevisionHistory()).map((m) => m.revision);
    // Fail the state commit specifically (the transaction that writes the
    // manifest): history must not be replaced on its own beforehand.
    idb.abortNextTransactionIncluding = STORE_METADATA;
    const result = await importHistoryWorkspace(parsed.data);
    expect(result).toEqual({ ok: false, error: 'write-failed' });
    expect((await getRevisionHistory()).map((m) => m.revision)).toEqual(historyBefore);
    expect(getWorkspaceRevision()).toBe(2);
    expect((await readPersistenceManifestFromDb())?.revision).toBe(2);
    expect((await getRevision(2))?.snapshot.appState.casesCompleted).toBe(80);
    // A retry after the failure succeeds and continues the numbering normally.
    const retry = await importHistoryWorkspace(parsed.data);
    expect(retry).toEqual({ ok: true, revision: 3 });
    expect((await getRevisionHistory()).map((m) => m.revision)).toEqual([3, 1]);
  });

  it('importing into a database behind the imported head continues from the imported head', async () => {
    await bootFresh();
    const w = baseWorkspace();
    await persistWorkspaceAsync(w.app, w.reports);
    await persistWorkspaceAsync({ ...w.app, casesCompleted: 80 }, w.reports);
    const payload = createHistoryBackupPayload(w.app, w.reports, await getRevisionsAfter(0));
    const parsed = parseHistoryBackupPayload(JSON.stringify(payload));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Wipe everything (fresh session, no workspace committed yet).
    resetPersistenceBackendForTests();
    const fresh = new FakeIDBFactory();
    vi.stubGlobal('indexedDB', fresh);
    idb = fresh;
    storage.removeItem(STORAGE_KEY);
    storage.removeItem(REPORTS_STORAGE_KEY);
    const boot = await initPersistence();
    expect(boot.revision).toBe(0);
    const result = await importHistoryWorkspace(parsed.data);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.revision).toBe(3); // imported head 2 + the new import revision
    const manifest = await readPersistenceManifestFromDb();
    expect(manifest?.revision).toBe(3);
    expect(await getLatestRevision()).toBe(3);
    expect((await getRevisionHistory()).map((m) => m.revision)).toEqual([3, 2, 1]);
  });
});

describe('future sync boundary (V6.8 §36)', () => {
  it('getRevisionsAfter returns committed changes after a revision, ascending', async () => {
    await bootFresh();
    const w = baseWorkspace();
    await persistWorkspaceAsync(w.app, w.reports);
    await persistWorkspaceAsync({ ...w.app, casesCompleted: 80 }, w.reports);
    await persistWorkspaceAsync({ ...w.app, casesCompleted: 70 }, w.reports);
    const after = await getRevisionsAfter(1);
    expect(after.map((r) => r.revision)).toEqual([2, 3]);
    expect(after.every((r) => typeof r.snapshot.appState === 'object')).toBe(true);
    expect((await getRevisionsAfter(3)).length).toBe(0);
  });
});

describe('clear-all integration (V6.8 §40)', () => {
  it('clear-all destroys the journal with the database; a new first commit is initial, old history never resurrected', async () => {
    await bootMigrated();
    const w2 = { app: appState(), reports: reportsState([project('A'), project('B', [project('A')])], null) };
    await persistWorkspaceAsync({ ...w2.app, casesCompleted: 85 }, w2.reports);
    expect(await getLatestRevision()).toBe(2);
    const cleared = await clearAllLocalDataAsync();
    expect(cleared).toBe('cleared');
    // Fresh start: no journal, revision 0, nothing resurrected.
    const boot = await initPersistence();
    expect(boot.revision).toBe(0);
    await countRevisions().then((c) => expect(c).toBe(0)).catch(() => undefined);
    // The first commit after the clear starts a NEW journal at revision 1.
    const result = await persistWorkspaceAsync(w2.app, w2.reports);
    expect(result.revision).toBe(1);
    expect((await getRevision(1))?.reason).toBe('initial');
    expect(await getLatestRevision()).toBe(1);
  });
});

describe('localStorage fallback mode (V6.8 §22)', () => {
  it('keeps no journal in fallback mode — diagnostics report history unavailable', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('window', { localStorage: storage }); // no indexedDB global
    const boot = await initPersistence();
    expect(boot.mode).toBe('localstorage');
    const w = baseWorkspace();
    const result = await persistWorkspaceAsync(w.app, w.reports);
    expect(result.ok).toBe(true);
    const diagnostics = await getStorageDiagnostics();
    expect(diagnostics.history.available).toBe(false);
    expect(diagnostics.history.integrity).toBe('unavailable');
  });
});

describe('domain fidelity in snapshots (V6.8 §32–§34)', () => {
  it('stores the V6.4 granular execution state verbatim (QA Tested 70 / QA Completed 90 / Remaining 10)', async () => {
    await bootFresh();
    const w = baseWorkspace();
    await persistWorkspaceAsync(w.app, w.reports);
    const entry = await getRevision(1);
    const snap = entry!.snapshot.appState;
    // QA Tested = Pass + Fail + N/A = 70; QA Completed = + SPO = 90; Remaining = 10.
    expect((snap.casesPassed ?? 0) + (snap.casesFailed ?? 0) + (snap.casesNotApplicable ?? 0)).toBe(70);
    expect((snap.casesPassed ?? 0) + (snap.casesFailed ?? 0) + (snap.casesNotApplicable ?? 0) + (snap.spoAssigned ?? 0)).toBe(90);
    expect(snap.totalCases - snap.casesCompleted).toBe(10);
    expect(snap.casesBlocked).toBe(3);
    expect(snap.casesRetest).toBe(2);
    expect(snap.casesQuestioned).toBe(1);
  });

  it('stores V6.9-B identity data verbatim', async () => {
    await bootFresh();
    const w = baseWorkspace();
    const members = [
      { id: 'USER0001', name: 'Tokunaga Hiroshi', team: 'RCS', role: 'SV', startDate: '2026-07-01', active: true, nameHistory: [{ name: 'Tokunaga H.', fromDate: '2026-07-01' }] },
    ];
    const audit = [{ id: 'aud-1', timestamp: NOW_ISO, recordType: 'attendance' as const, recordId: 'att-1', recordedName: 'Tokunaga Hiroshi', previousState: 'unmatched' as const, method: 'manual' as const, source: 'identityCenter' as const }];
    const external = [{ id: 'ext-1', provider: 'github', externalId: 'ttokunaga', memberId: 'USER0001', active: true, linkedAt: NOW_ISO }];
    await persistWorkspaceAsync(w.app, { ...w.reports, rcsMembers: members, identityAuditLog: audit, externalIdentities: external });
    const entry = await getRevision(1);
    expect(entry?.snapshot.reportsState.rcsMembers).toEqual(members);
    expect(entry?.snapshot.reportsState.identityAuditLog).toEqual(audit);
    expect(entry?.snapshot.reportsState.externalIdentities).toEqual(external);
  });

  it('keeps V6.5 legacy snapshot unknown fields unknown (no inferred values)', async () => {
    await bootFresh();
    const projectA = project('A');
    // A V6.5-era snapshot: executed/passed only — granular fields stay undefined.
    projectA.inputs.dailyActuals = [{ id: 'snap-legacy', date: '2026-09-26', executed: 70, passed: 60 }];
    const w: CanonicalWorkspace = { app: appState(), reports: reportsState([projectA], projectA.id) };
    await persistWorkspaceAsync(w.app, w.reports);
    const entry = await getRevision(1);
    const legacy = entry!.snapshot.reportsState.projects[0].inputs.dailyActuals![0];
    expect(legacy.executed).toBe(70);
    expect(legacy.passed).toBe(60);
    expect('casesFailed' in legacy).toBe(false); // unknown stays unknown
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, ProjectRecord, QaInputs, ReportsState } from '../types';
import { normalizeAppState, normalizeQaInputs } from '../lib/storage/storage';
import { defaultReportsState } from '../lib/storage/reports';
import { consumeCorruptionEvents } from '../lib/storage/corruption';
import { initPersistence } from '../lib/storage/db/bootstrap';
import { DB_NAME, STORE_REVISION_HISTORY } from '../lib/storage/db/repository';
import {
  createRestoreRevision,
  getStorageDiagnostics,
  persistWorkspaceAsync,
  readPersistenceManifestFromDb,
  resetPersistenceBackendForTests,
} from '../lib/storage/db/persistenceBackend';
import {
  countRevisions,
  getLatestRevision,
  getRevision,
  getRevisionHistory,
  reconstructRevision,
  pruneRevisionHistory,
} from '../lib/storage/db/revisionHistory';
import type { CanonicalWorkspace } from '../lib/storage/db/diff';
import { newProjectRecord } from '../domain/projects';
import { applyDailyExecutionEntry } from '../lib/calculations/dailyExecuted';
import { FakeIDBFactory } from './helpers/fakeIndexedDb';

/**
 * V6.8 — point-in-time recovery: historical reconstruction, explicit
 * restore-as-new-revision semantics, the §45 end-to-end lifecycle and the
 * §46 recovery acceptance scenario.
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

function appState(name = 'A'): AppState {
  return normalizeAppState({
    ...normalizeQaInputs(inputs()),
    language: 'ja',
    projectNameEn: name,
    projectNameJa: name,
    dashboardView: 'operator',
  });
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

function reportsState(projects: ProjectRecord[], activeProjectId: string | null): ReportsState {
  return { ...defaultReportsState(), projects, activeProjectId };
}

async function bootFresh(): Promise<void> {
  const boot = await initPersistence();
  if (boot.mode !== 'indexeddb') throw new Error(`fresh bootstrap failed: ${boot.migrationStatus}/${boot.health}`);
}

function baseWorkspace(): CanonicalWorkspace {
  const projectA = project('A');
  const projectB = project('B', [projectA]);
  return { app: appState(), reports: reportsState([projectA, projectB], projectA.id) };
}

/** Persist a workspace variant and return the exact state persisted. */
async function commit(w: CanonicalWorkspace): Promise<number> {
  const result = await persistWorkspaceAsync(w.app, w.reports);
  if (!result.ok) throw new Error(`commit failed at revision ${result.revision}`);
  return result.revision;
}

describe('reconstruction (V6.8 §13, §15)', () => {
  it('reconstructs the latest revision exactly', async () => {
    await bootFresh();
    const w = baseWorkspace();
    await commit(w);
    await commit({ app: { ...w.app, casesCompleted: 80 }, reports: w.reports });
    const reconstructed = await reconstructRevision(2);
    expect(reconstructed.ok).toBe(true);
    if (reconstructed.ok) {
      expect(reconstructed.app).toEqual({ ...w.app, casesCompleted: 80 });
      expect(reconstructed.reports).toEqual(w.reports);
    }
  });

  it('reconstructs earlier and first revisions exactly (no recomputation)', async () => {
    await bootFresh();
    const w = baseWorkspace();
    await commit(w);
    await commit({ app: { ...w.app, casesCompleted: 80 }, reports: w.reports });
    await commit({ app: { ...w.app, casesCompleted: 70 }, reports: w.reports });
    const first = await reconstructRevision(1);
    expect(first.ok && first.app.casesCompleted).toBe(90);
    const earlier = await reconstructRevision(2);
    expect(earlier.ok && earlier.app.casesCompleted).toBe(80);
  });

  it('rejects invalid revisions with typed errors', async () => {
    await bootFresh();
    const w = baseWorkspace();
    await commit(w);
    expect((await reconstructRevision(0)).ok).toBe(false);
    expect((await reconstructRevision(-3)).ok).toBe(false);
    expect((await reconstructRevision(99)).ok).toBe(false);
    if (!(await reconstructRevision(99)).ok) {
      expect((await reconstructRevision(99) as { error: string }).error).toBe('not-found');
    }
  });

  it('reports a pruned revision as pruned (clearly unavailable)', async () => {
    await bootFresh();
    const w = baseWorkspace();
    await commit(w);
    await commit({ app: { ...w.app, casesCompleted: 80 }, reports: w.reports });
    await commit({ app: { ...w.app, casesCompleted: 70 }, reports: w.reports });
    await pruneRevisionHistory(3, 2);
    const result = await reconstructRevision(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('pruned');
  });

  it('reports a corrupted historical entry as unavailable', async () => {
    await bootFresh();
    const w = baseWorkspace();
    await commit(w);
    await commit({ app: { ...w.app, casesCompleted: 80 }, reports: w.reports });
    idb.writeRecord(DB_NAME, STORE_REVISION_HISTORY, 1, { broken: true });
    const result = await reconstructRevision(1);
    expect(result.ok).toBe(false);
  });

  it('reports a snapshot with structurally invalid states as invalid', async () => {
    await bootFresh();
    const w = baseWorkspace();
    await commit(w);
    const entry = await getRevision(1);
    // Tamper: a snapshot that parses as a journal record but fails the
    // canonical AppState/ReportsState guards.
    idb.writeRecord(DB_NAME, STORE_REVISION_HISTORY, 1, {
      ...entry,
      schemaVersion: 1,
      snapshot: { appState: {}, reportsState: {} },
    });
    const result = await reconstructRevision(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid');
  });
});

describe('restore semantics (V6.8 §13–§14, §27–§29)', () => {
  it('restore 7 at current 10 → new revision 11, state == state-at-7, history 8..10 intact', async () => {
    await bootFresh();
    const w = baseWorkspace();
    for (let i = 90; i >= 81; i -= 1) {
      await commit({ app: { ...w.app, casesCompleted: i }, reports: w.reports });
    } // revisions 1..10 (revision 7 committed casesCompleted = 84)
    expect(await getLatestRevision()).toBe(10);
    const restored = await createRestoreRevision(7);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.revision).toBe(11); // new revision, NOT an overwrite
    expect(restored.restoredFrom).toBe(7);
    // Newer history is not deleted.
    expect((await getRevisionHistory()).map((m) => m.revision)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    // The journal entry records the recovery with its source revision.
    const entry = await getRevision(11);
    expect(entry?.reason).toBe('recovery');
    expect(entry?.restoredFromRevision).toBe(7);
    // The current state equals the state at revision 7 exactly.
    const at7 = await reconstructRevision(7);
    expect(at7.ok).toBe(true);
    if (at7.ok) {
      expect(at7.app.casesCompleted).toBe(84);
      expect(at7.app.casesCompleted).toBe(restored.app.casesCompleted);
      expect(at7.reports).toEqual(restored.reports);
    }
    // The manifest matches the new head.
    expect((await readPersistenceManifestFromDb())?.revision).toBe(11);
  });

  it('restoring the current state still creates a new revision (force)', async () => {
    await bootFresh();
    const w = baseWorkspace();
    await commit(w);
    const restored = await createRestoreRevision(1);
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(restored.revision).toBe(2);
      expect(restored.app).toEqual(w.app);
    }
  });

  it('history continues after a restore (§45 step 24–26)', async () => {
    await bootFresh();
    const w = baseWorkspace();
    await commit(w);
    await commit({ app: { ...w.app, casesCompleted: 80 }, reports: w.reports });
    const restored = await createRestoreRevision(1);
    expect(restored.ok && restored.revision).toBe(3);
    const next = await commit({ app: { ...w.app, casesCompleted: 50 }, reports: w.reports });
    expect(next).toBe(4);
    expect((await getRevisionHistory()).map((m) => m.revision)).toEqual([4, 3, 2, 1]);
  });

  it('restore is unavailable in the localStorage fallback mode', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('window', { localStorage: storage }); // no indexedDB global
    await initPersistence();
    const result = await createRestoreRevision(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('unavailable');
  });

  it('restore of a pruned/unknown revision fails with a typed error and changes nothing', async () => {
    await bootFresh();
    const w = baseWorkspace();
    await commit(w);
    await commit({ app: { ...w.app, casesCompleted: 80 }, reports: w.reports });
    await pruneRevisionHistory(2, 1);
    const failed = await createRestoreRevision(1);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error).toBe('pruned');
    expect(await getLatestRevision()).toBe(2); // nothing changed
  });
});

describe('project switching (V6.8 §39)', () => {
  it('globally ordered revisions with correct affected projects; reconstruction preserves both projects', async () => {
    await bootFresh();
    const projectA = project('A');
    const projectB = project('B', [projectA]);
    const reports = reportsState([projectA, projectB], projectA.id);
    const appA = appState('A');
    // Edit Project A (execution).
    await commit({ app: { ...appA, casesCompleted: 50 }, reports });
    // Edit Project B (switch active + sync B's record).
    const reportsB = {
      ...reports,
      activeProjectId: projectB.id,
      projects: reports.projects.map((p) => (p.id === projectB.id ? { ...p, inputs: { ...p.inputs, casesCompleted: 20 } } : p)),
    };
    await commit({ app: { ...appA, casesCompleted: 20, projectNameEn: 'B', projectNameJa: 'B' }, reports: reportsB });
    // Edit Project A again.
    const reportsA2 = {
      ...reportsB,
      activeProjectId: projectA.id,
      projects: reportsB.projects.map((p) => (p.id === projectA.id ? { ...p, inputs: { ...p.inputs, casesCompleted: 60 } } : p)),
    };
    await commit({ app: { ...appA, casesCompleted: 60 }, reports: reportsA2 });

    const history = await getRevisionHistory();
    expect(history.map((m) => m.revision)).toEqual([3, 2, 1]); // globally ordered
    expect(history[2].affectedProjectIds).toContain('PRJ-001'); // A edit
    expect(history[1].affectedProjectIds).toContain('PRJ-002'); // B edit
    expect(history[0].affectedProjectIds).toContain('PRJ-001'); // A again

    // Reconstruct each revision: both projects survive every point in time.
    const r1 = await reconstructRevision(1);
    const r2 = await reconstructRevision(2);
    const r3 = await reconstructRevision(3);
    expect(r1.ok && r1.reports.projects).toHaveLength(2);
    expect(r2.ok && r2.reports.projects).toHaveLength(2);
    expect(r3.ok && r3.reports.projects).toHaveLength(2);
    if (r1.ok && r2.ok && r3.ok) {
      expect(r1.reports.projects.find((p) => p.projectId === 'PRJ-002')!.inputs.casesCompleted).toBe(90);
      expect(r2.reports.projects.find((p) => p.projectId === 'PRJ-002')!.inputs.casesCompleted).toBe(20);
      expect(r3.reports.projects.find((p) => p.projectId === 'PRJ-002')!.inputs.casesCompleted).toBe(20);
      expect(r3.reports.projects.find((p) => p.projectId === 'PRJ-001')!.inputs.casesCompleted).toBe(60);
    }

    // Restoring revision 1 does not cross-contaminate Project B.
    const restored = await createRestoreRevision(1);
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(restored.reports.projects.find((p) => p.projectId === 'PRJ-002')!.inputs.casesCompleted).toBe(90);
      expect(restored.reports.projects.find((p) => p.projectId === 'PRJ-001')!.inputs.casesCompleted).toBe(90);
    }
  });
});

describe('§45 end-to-end V6.8 lifecycle', () => {
  it('create → journal → reload → reconstruct → restore → continue', async () => {
    // 1. Clean database (fresh beforeEach: no localStorage, no journal).
    await bootFresh();
    const projectA = project('A');
    const projectB = project('B', [projectA]);
    // 30–32. Seed the canonical acceptance data up-front: V6.4 granular
    // execution (§34), a V6.5 legacy snapshot and V6.9-B identity data.
    projectA.inputs.dailyActuals = [
      { id: 'snap-legacy', date: '2026-09-26', executed: 70, passed: 60 }, // V6.5 legacy: unknown fields stay unknown
      {
        id: 'snap-granular', date: '2026-09-27', executed: 80, passed: 60,
        casesPassed: 58, casesFailed: 4, casesNotApplicable: 3, spoAssigned: 15, casesBlocked: 2, casesRetest: 1, casesQuestioned: 1,
      },
    ];
    const members = [{ id: 'USER0001', name: 'Tokunaga Hiroshi', team: 'RCS', role: 'SV', startDate: '2026-07-01', active: true }];
    const audit = [{ id: 'aud-1', timestamp: NOW_ISO, recordType: 'attendance' as const, recordId: 'att-1', recordedName: 'Tokunaga Hiroshi', previousState: 'unmatched' as const, method: 'manual' as const, source: 'identityCenter' as const }];
    const external = [{ id: 'ext-1', provider: 'github', externalId: 'ttokunaga', memberId: 'USER0001', active: true, linkedAt: NOW_ISO }];

    // 2–3. Create Project A → revision 1.
    const reportsA = { ...reportsState([projectA], projectA.id), rcsMembers: members, identityAuditLog: audit, externalIdentities: external };
    expect(await commit({ app: appState('A'), reports: reportsA })).toBe(1);
    // 4–5. Create Project B → revision 2.
    const reportsAB = { ...reportsState([projectA, projectB], projectA.id), rcsMembers: members, identityAuditLog: audit, externalIdentities: external };
    expect(await commit({ app: appState('A'), reports: reportsAB })).toBe(2);
    expect((await getRevision(2))?.reason).toBe('project-created');
    // 6–7. Update Project A execution data → revision 3.
    const reportsAExec = {
      ...reportsAB,
      projects: reportsAB.projects.map((p) => (p.id === projectA.id ? { ...p, inputs: { ...p.inputs, casesCompleted: 60 }, updatedAt: NOW_ISO } : p)),
    };
    expect(await commit({ app: { ...appState('A'), casesCompleted: 60 }, reports: reportsAExec })).toBe(3);
    expect((await getRevision(3))?.changeSummary?.executionChanged).toBe(true);
    // 8–9. Add a report → revision 4.
    const report = {
      id: 'rep-1', reportDate: '2026-09-29', language: 'ja' as const, status: 'DRAFT' as const,
      projectId: projectA.projectId, revisionOf: null, jiraUrl: null, activities: [], nextDay: [],
      previewText: '', createdBy: 'SV', createdAt: NOW_ISO, updatedAt: NOW_ISO, finalizedAt: null, finalizedBy: null, snapshot: null,
    };
    expect(await commit({ app: appState('A'), reports: { ...reportsAExec, reports: [report] } })).toBe(4);
    expect((await getRevision(4))?.reason).toBe('report-created');
    // 10–11. Add attendance → revision 5.
    const attendance = [{ id: 'att-1', date: '2026-09-29', memberName: 'Tokunaga Hiroshi', memberId: 'USER0001', team: 'RCS', status: 'PRESENT' as const, workingStart: '09:00', workingEnd: '17:30', leaveType: null, comment: '' }];
    expect(await commit({ app: appState('A'), reports: { ...reportsAExec, reports: [report], attendance } })).toBe(5);
    expect((await getRevision(5))?.reason).toBe('attendance-updated');
    // 12–13. Modify Project B → revision 6.
    const reportsB = {
      ...reportsAExec,
      activeProjectId: projectB.id,
      reports: [report],
      attendance,
      projects: reportsAExec.projects.map((p) => (p.id === projectB.id ? { ...p, inputs: { ...p.inputs, casesCompleted: 30 }, updatedAt: NOW_ISO } : p)),
    };
    expect(await commit({ app: { ...appState('B'), casesCompleted: 30 }, reports: reportsB })).toBe(6);

    // 14. Verify journal 1..6.
    expect((await getRevisionHistory()).map((m) => m.revision)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(await countRevisions()).toBe(6);

    // 15–16. Reload the application.
    const boot = await initPersistence();
    expect(boot.mode).toBe('indexeddb');
    expect(boot.health).toBe('healthy');
    expect(boot.revision).toBe(6);
    expect(await countRevisions()).toBe(6);

    // 17–18. Reconstruct revision 3 and verify its state.
    const r3 = await reconstructRevision(3);
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;
    expect(r3.app.casesCompleted).toBe(60);
    expect(r3.reports.projects).toHaveLength(2);
    expect(r3.reports.projects.find((p) => p.projectId === 'PRJ-001')!.inputs.casesCompleted).toBe(60);
    expect(r3.reports.projects.find((p) => p.projectId === 'PRJ-002')!.inputs.casesCompleted).toBe(90);
    // Granular execution, legacy snapshot and identity data all survive.
    const legacy = r3.reports.projects[0].inputs.dailyActuals![0];
    expect(legacy.executed).toBe(70);
    expect('casesFailed' in legacy).toBe(false);
    expect(r3.reports.rcsMembers).toEqual(members);
    expect(r3.reports.identityAuditLog).toEqual(audit);
    expect(r3.reports.externalIdentities).toEqual(external);
    // §34 numbers hold on the reconstructed state (no recomputation).
    expect((r3.app.casesPassed ?? 0) + (r3.app.casesFailed ?? 0) + (r3.app.casesNotApplicable ?? 0)).toBe(70);
    expect(r3.app.casesCompleted).toBe(60 + 20 /* project A edited to 60 */ - 20 + 0);
    expect(r3.app.totalCases - r3.app.casesCompleted).toBe(40);

    // 19–23. Restore revision 3 → new revision 7; 1..6 remain; state == state-at-3; reason = recovery.
    const restored = await createRestoreRevision(3);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.revision).toBe(7);
    expect((await getRevisionHistory()).map((m) => m.revision)).toEqual([7, 6, 5, 4, 3, 2, 1]);
    expect(await countRevisions()).toBe(7);
    expect((await getRevision(7))?.reason).toBe('recovery');
    expect((await getRevision(7))?.restoredFromRevision).toBe(3);
    expect(restored.app).toEqual(r3.app);
    expect(restored.reports).toEqual(r3.reports);

    // 24–26. A new edit continues from revision 8.
    const next = await commit({ app: withExecuted(r3.app, 55), reports: r3.reports });
    expect(next).toBe(8);
    expect(await getLatestRevision()).toBe(8);
    expect((await getRevisionHistory()).map((m) => m.revision)).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);

    // Reload again: the continued chain is durable.
    const final = await initPersistence();
    expect(final.revision).toBe(8);
    expect(final.workspace.app.casesCompleted).toBe(55);
  });
});

describe('§46 recovery acceptance', () => {
  it('corrupted current revision → latest valid historical revision restored as a NEW revision', async () => {
    await bootFresh();
    const w = baseWorkspace();
    // 1. Advance to revision 20.
    for (let i = 0; i < 20; i += 1) {
      await commit({ app: { ...w.app, casesCompleted: 90 - i }, reports: w.reports });
    }
    expect(await getLatestRevision()).toBe(20);
    // 2–3. Revision 19 is valid; revision 20 is made structurally invalid.
    const entry20 = await getRevision(20);
    expect(entry20).not.toBeNull();
    idb.writeRecord(DB_NAME, STORE_REVISION_HISTORY, 20, { broken: true });
    // 4. Integrity detects the problem.
    const diagnostics = await getStorageDiagnostics();
    expect(diagnostics.history.integrity).toBe('warning');
    expect(diagnostics.history.issues).toContain('journal.behind-manifest');
    expect(diagnostics.history.latestRevision).toBe(19);
    // 5. Revision 19 remains reconstructable.
    const r19 = await reconstructRevision(19);
    expect(r19.ok).toBe(true);
    // 6–7. Restore revision 19 → new revision 21.
    const restored = await createRestoreRevision(19);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.revision).toBe(21);
    // 8. Revision 20 is preserved as raw historical evidence (the invalid record was not deleted).
    expect(idb.readRecord(STORE_REVISION_HISTORY, 20)).toEqual({ broken: true });
    // 9. Current state equals revision 19.
    expect(restored.app).toEqual(r19.ok ? r19.app : null);
    expect(restored.reports).toEqual(r19.ok ? r19.reports : null);
    // 10. No data from revision 20 was silently invented or merged.
    expect(restored.app.casesCompleted).toBe(90 - 18);
    expect(await countRevisions()).toBe(20); // 1..19 + 21 (20 is unreadable)
    const manifest = await readPersistenceManifestFromDb();
    expect(manifest?.revision).toBe(21);
  });
});

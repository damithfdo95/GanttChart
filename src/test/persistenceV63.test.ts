import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, DailyReport, ProjectRecord, QaInputs, ReportsState } from '../types';
import { DEMO_STATE, loadState, normalizeAppState, normalizeQaInputs, STORAGE_KEY } from '../lib/storage/storage';
import { REPORTS_STORAGE_KEY, defaultReportsState, loadReportsState } from '../lib/storage/reports';
import {
  META_STORAGE_KEY,
  clearAllPersistence,
  readPersistenceMeta,
  writePersistedWorkspace,
} from '../lib/storage/persistence';
import { consumeCorruptionEvents, hasRecoveryPayload } from '../lib/storage/corruption';
import { createBackupPayload, parseBackupPayload } from '../lib/backup/backup';
import {
  createProjectBackupPayload,
  importProjectIntoRegistry,
  parseProjectBackupPayload,
} from '../lib/backup/projectBackup';
import { detectImportFile } from '../lib/backup/importFile';
import { removeProjectFromRegistry } from '../domain/projects/lifecycle';
import { newProjectRecord } from '../domain/projects';
import { calculateExecutionCounts } from '../lib/calculations/execution';
import { createExportPayload } from '../lib/jsonio/jsonio';

/**
 * V6.3 — UX & local persistence improvements: centralized workspace
 * persistence (save-status semantics, last-saved metadata), corruption
 * recovery stash, project backup export/import with deterministic
 * duplicate-ID policy, project deletion fallback, full local reset, and the
 * §26 end-to-end acceptance scenario. All dates/times are deterministic.
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

class ThrowingSetStorage extends MemoryStorage {
  override setItem(): void {
    throw new Error('storage blocked');
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal('window', { localStorage: storage });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function appState(inputs: QaInputs): AppState {
  // Normalize so the fixture matches the persisted/loaded canonical shape
  // (V6.4 added casesFailed/…/casesQuestioned with default 0 on load).
  return {
    ...normalizeQaInputs(inputs),
    language: 'ja',
    projectNameEn: 'V6.3 Project',
    projectNameJa: 'V6.3プロジェクト',
    dashboardView: 'operator',
  };
}

/** The §26 acceptance project: 100 total, Pass 50, Fail 5, NA 5, SPO対応 20. */
function acceptanceInputs(): QaInputs {
  return {
    totalCases: 100,
    currentTesters: 8,
    startTime: 13 * 60,
    targetFinish: 17 * 60,
    lunchStart: 0,
    lunchEnd: 0,
    perHourPerTester: 4,
    casesCompleted: 80,
    casesPassed: 50,
    spoAssigned: 20,
    targetPassRate: 1,
    dailyTargetOverrides: [{ id: 'ovr-1', date: '2026-09-29', plannedExecute: 60, plannedPass: 50 }],
    dailyActuals: [{ id: 'act-1', date: '2026-09-28', executed: 20, passed: 15 }],
    blockingEvents: [],
    milestones: [],
    startDate: '2026-09-29',
    targetCompletionDate: '2026-09-30',
    targetCompletionTime: '17:00',
    planningRows: [
      { id: 'row-1', date: '2026-09-29', plannedTesters: 8, absentTesters: 0, nonWorkingDay: false, note: '' },
      { id: 'row-2', date: '2026-09-30', plannedTesters: 8, absentTesters: 0, nonWorkingDay: false, note: '' },
    ],
  };
}

function report(id: string, projectId: string | null): DailyReport {
  return {
    id,
    reportDate: '2026-09-29',
    language: 'ja',
    status: 'FINALIZED',
    projectId,
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
}

describe('centralized workspace persistence', () => {
  it('saves the initial state correctly (both storages + metadata)', () => {
    const state = appState(acceptanceInputs());
    const reports = defaultReportsState();
    const result = writePersistedWorkspace(state, reports);
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    // V7: a legacy payload loads in its migrated form (daily entries, same
    // totals) — normalizeAppState is the exact load-time pipeline.
    expect(loadState()).toEqual(normalizeAppState(state));
    expect(loadReportsState()).toEqual(reports);
    expect(readPersistenceMeta().lastSavedAt).not.toBeNull();
  });

  it('persists state changes', () => {
    const state = appState(acceptanceInputs());
    writePersistedWorkspace(state, defaultReportsState());
    const next = { ...state, casesCompleted: 90, spoAssigned: 20 };
    writePersistedWorkspace(next, defaultReportsState());
    expect(loadState().casesCompleted).toBe(90);
    expect(loadState().spoAssigned).toBe(20);
  });

  it('skips no-op writes and keeps the last-saved timestamp', () => {
    const state = appState(acceptanceInputs());
    writePersistedWorkspace(state, defaultReportsState());
    const first = readPersistenceMeta().lastSavedAt;
    expect(first).not.toBeNull();
    const result = writePersistedWorkspace({ ...state }, defaultReportsState());
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
    expect(readPersistenceMeta().lastSavedAt).toBe(first);
  });

  it('updates the last-saved timestamp after a real change', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-29T10:00:00Z'));
      const state = appState(acceptanceInputs());
      writePersistedWorkspace(state, defaultReportsState());
      const first = readPersistenceMeta().lastSavedAt;
      vi.setSystemTime(new Date('2026-09-29T10:05:00Z'));
      writePersistedWorkspace({ ...state, casesCompleted: 90 }, defaultReportsState());
      expect(readPersistenceMeta().lastSavedAt!).toBeGreaterThan(first!);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports save failure without touching the in-memory state', () => {
    vi.stubGlobal('window', { localStorage: new ThrowingSetStorage() });
    const state = appState(acceptanceInputs());
    const result = writePersistedWorkspace(state, defaultReportsState());
    expect(result.ok).toBe(false);
    // The canonical in-memory state is untouched and still usable.
    expect(state.casesCompleted).toBe(80);
    expect(state.spoAssigned).toBe(20);
    expect(calculateExecutionCounts(state).qaTested).toBe(60);
  });

  it('restores the full workspace on reload (refresh/restart compatible)', () => {
    const state = appState(acceptanceInputs());
    const reports: ReportsState = {
      ...defaultReportsState(),
      projects: [newProjectRecord(acceptanceInputs(), { nameEn: 'A', nameJa: 'A' }, NOW_ISO, [])],
    };
    reports.activeProjectId = reports.projects[0].id;
    writePersistedWorkspace(state, reports);
    // V7: the load-time pipeline migrates legacy payloads identically.
    expect(loadState()).toEqual(normalizeAppState(state));
    const reloadedReports = loadReportsState();
    expect(reloadedReports.projects).toEqual(reports.projects);
    expect(reloadedReports.activeProjectId).toBe(reports.activeProjectId);
  });
});

describe('corruption recovery (§22)', () => {
  it('stashes unreadable app-state data before falling back to defaults', () => {
    storage.setItem(STORAGE_KEY, '{not json');
    const state = loadState();
    expect(state.totalCases).toBe(DEMO_STATE.totalCases); // app stays usable
    expect(hasRecoveryPayload(STORAGE_KEY)).toBe(true);
    const events = consumeCorruptionEvents();
    expect(events).toHaveLength(1);
    expect(events[0].key).toBe(STORAGE_KEY);
    expect(events[0].raw).toBe('{not json');
  });

  it('stashes an invalid-schema reports payload before resetting to defaults', () => {
    storage.setItem(REPORTS_STORAGE_KEY, JSON.stringify({ schemaVersion: 99, nope: true }));
    const reports = loadReportsState();
    expect(reports.projects).toEqual([]); // safe defaults
    expect(hasRecoveryPayload(REPORTS_STORAGE_KEY)).toBe(true);
    expect(consumeCorruptionEvents()).toHaveLength(1);
  });

  it('does not report corruption for valid persisted data', () => {
    writePersistedWorkspace(appState(acceptanceInputs()), defaultReportsState());
    loadState();
    loadReportsState();
    expect(consumeCorruptionEvents()).toHaveLength(0);
  });
});

describe('project export (§8)', () => {
  const project = newProjectRecord(acceptanceInputs(), { nameEn: 'A', nameJa: 'A' }, NOW_ISO, []);

  it('exports the project with its reports only', () => {
    const mine = report('rep-1', project.projectId);
    const other = report('rep-2', 'PRJ-999');
    const payload = createProjectBackupPayload(project, [mine, other], NOW_ISO);
    expect(payload.data.project).toEqual(project);
    expect(payload.data.reports.map((r) => r.id)).toEqual(['rep-1']);
    expect(payload.app).toBe('ganttchart');
    expect(payload.kind).toBe('project');
  });

  it('preserves project ID, SPO対応, execution state, planning and overrides', () => {
    const payload = createProjectBackupPayload(project, [], NOW_ISO);
    expect(payload.data.project.projectId).toBe(project.projectId);
    expect(payload.data.project.inputs.spoAssigned).toBe(20);
    expect(payload.data.project.inputs.casesCompleted).toBe(80);
    expect(payload.data.project.inputs.casesPassed).toBe(50);
    expect(payload.data.project.inputs.dailyTargetOverrides).toEqual(project.inputs.dailyTargetOverrides);
    expect(payload.data.project.inputs.planningRows).toHaveLength(2);
  });

  it('round-trips through parse (SPO, overrides, reports, IDs all survive)', () => {
    const payload = createProjectBackupPayload(project, [report('rep-1', project.projectId)], NOW_ISO);
    const parsed = parseProjectBackupPayload(JSON.stringify(payload));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.project).toEqual(project);
    expect(parsed.data.project.inputs.spoAssigned).toBe(20);
    expect(parsed.data.project.inputs.dailyTargetOverrides).toEqual(project.inputs.dailyTargetOverrides);
    expect(parsed.data.reports).toHaveLength(1);
  });

  it('defaults missing spoAssigned to 0 (legacy project backup)', () => {
    const legacy = JSON.parse(JSON.stringify(project)) as ProjectRecord;
    delete legacy.inputs.spoAssigned;
    const text = JSON.stringify({
      app: 'ganttchart',
      kind: 'project',
      version: 1,
      exportedAt: NOW_ISO,
      data: { project: legacy, reports: [] },
    });
    const parsed = parseProjectBackupPayload(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.data.project.inputs.spoAssigned).toBe(0);
  });

  it('is idempotent: parse(export(project)) twice yields identical data', () => {
    const text = JSON.stringify(createProjectBackupPayload(project, [report('rep-1', project.projectId)], NOW_ISO));
    const first = parseProjectBackupPayload(text);
    const second = parseProjectBackupPayload(
      JSON.stringify(createProjectBackupPayload(first.ok ? first.data.project : project, first.ok ? first.data.reports : [], NOW_ISO)),
    );
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.data).toEqual(first.data);
  });
});

describe('workspace export (§9)', () => {
  it('exports and restores the complete workspace (backup round-trip)', () => {
    const state = appState(acceptanceInputs());
    const reports: ReportsState = {
      ...defaultReportsState(),
      projects: [newProjectRecord(acceptanceInputs(), { nameEn: 'A', nameJa: 'A' }, NOW_ISO, [])],
      reports: [report('rep-1', 'PRJ-001')],
    };
    const backupText = JSON.stringify(createBackupPayload(state, reports));
    const parsed = parseBackupPayload(backupText);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Round-trip twice: migration is idempotent (§24).
    const secondText = JSON.stringify(createBackupPayload(parsed.data.appState, parsed.data.reportsState));
    const second = parseBackupPayload(secondText);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.data).toEqual(parsed.data);
    expect(parsed.data.reportsState.projects[0].inputs.spoAssigned).toBe(20);
  });

  it('migrates V6.2 backups without spoAssigned (legacy, §21–§23)', () => {
    const state = appState(acceptanceInputs());
    const v62Project = newProjectRecord(acceptanceInputs(), { nameEn: 'A', nameJa: 'A' }, NOW_ISO, []);
    const rawProject = JSON.parse(JSON.stringify(v62Project)) as ProjectRecord;
    delete rawProject.inputs.spoAssigned;
    const reports = { ...defaultReportsState(), projects: [rawProject] };
    const parsed = parseBackupPayload(JSON.stringify(createBackupPayload(state, reports as ReportsState)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.data.reportsState.projects[0].inputs.spoAssigned).toBe(0);
  });

  it('imports old backups without the portfolio registry', () => {
    const state = appState(acceptanceInputs());
    const oldShape = JSON.parse(
      JSON.stringify({ ...defaultReportsState(), projects: undefined }),
    ) as unknown as ReportsState;
    const parsed = parseBackupPayload(JSON.stringify(createBackupPayload(state, oldShape)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.data.reportsState.projects).toEqual([]);
  });
});

describe('import dispatcher (§10–§11, §20)', () => {
  const project = newProjectRecord(acceptanceInputs(), { nameEn: 'A', nameJa: 'A' }, NOW_ISO, []);

  it('accepts full workspace backups', () => {
    const text = JSON.stringify(createBackupPayload(appState(acceptanceInputs()), defaultReportsState()));
    const result = detectImportFile(text);
    expect(result.kind).toBe('backup');
  });

  it('accepts single-project backups', () => {
    const text = JSON.stringify(createProjectBackupPayload(project, [], NOW_ISO));
    const result = detectImportFile(text);
    expect(result.kind).toBe('project');
    if (result.kind === 'project') expect(result.data.project.projectId).toBe(project.projectId);
  });

  it('accepts legacy app-state exports (V6.2 Dashboard format)', () => {
    const text = JSON.stringify(createExportPayload(appState(acceptanceInputs())));
    const result = detectImportFile(text);
    expect(result.kind).toBe('appstate');
  });

  it('rejects invalid JSON without touching current state', () => {
    const before = storage.map;
    expect(detectImportFile('not json').kind).toBe('invalid');
    expect(detectImportFile('[]').kind).toBe('invalid');
    expect(storage.map).toBe(before);
  });

  it('rejects invalid schemas safely', () => {
    expect(detectImportFile(JSON.stringify({ app: 'other' })).kind).toBe('invalid');
    expect(detectImportFile(JSON.stringify({ app: 'ganttchart', kind: 'backup', version: 99 })).kind).toBe('invalid');
    expect(
      detectImportFile(JSON.stringify({ app: 'ganttchart', kind: 'project', version: 99, data: {} })).kind,
    ).toBe('invalid');
    expect(detectImportFile(JSON.stringify({ app: 'ganttchart', kind: 'project', version: 1, data: {} })).kind).toBe(
      'invalid',
    );
  });
});

describe('project import with duplicate-ID policy (§11, §19)', () => {
  const existing = newProjectRecord(acceptanceInputs(), { nameEn: 'A', nameJa: 'A' }, NOW_ISO, []);

  it('imports into an empty registry keeping the original stable ID', () => {
    const incoming = JSON.parse(JSON.stringify(existing)) as ProjectRecord;
    const merged = importProjectIntoRegistry([], [], { project: incoming, reports: [] });
    expect(merged.projects).toHaveLength(1);
    expect(merged.importedProject.projectId).toBe(existing.projectId);
    expect(merged.importedProject.id).toBe(existing.id);
  });

  it('re-IDs a duplicate project as a new project (never overwrites)', () => {
    const incoming = JSON.parse(JSON.stringify(existing)) as ProjectRecord;
    const other = newProjectRecord(acceptanceInputs(), { nameEn: 'B', nameJa: 'B' }, NOW_ISO, [existing]);
    const merged = importProjectIntoRegistry([existing, other], [report('rep-0', existing.projectId)], {
      project: incoming,
      reports: [report('rep-1', incoming.projectId)],
    });
    expect(merged.projects).toHaveLength(3);
    expect(merged.projects[0]).toBe(existing); // untouched by reference
    expect(merged.importedProject.projectId).not.toBe(existing.projectId);
    expect(merged.importedProject.projectId).toMatch(/^PRJ-\d+$/);
    // Reports are re-keyed to the new stable project ID.
    expect(merged.newReports.every((r) => r.projectId === merged.importedProject.projectId)).toBe(true);
    // The existing project's own report survives untouched.
    expect(merged.reports.some((r) => r.id === 'rep-0')).toBe(true);
  });

  it('regenerates colliding report ids without a project-ID collision', () => {
    const other = newProjectRecord(acceptanceInputs(), { nameEn: 'B', nameJa: 'B' }, NOW_ISO, [existing]);
    const incoming = JSON.parse(JSON.stringify(existing)) as ProjectRecord;
    incoming.id = 'fresh-internal-id';
    const merged = importProjectIntoRegistry([other], [report('rep-1', 'PRJ-999')], {
      project: incoming,
      reports: [report('rep-1', incoming.projectId)],
    });
    // The colliding incoming report id is regenerated; the existing report is untouched.
    expect(merged.reports.filter((r) => r.id === 'rep-1')).toHaveLength(1);
    expect(merged.reports).toHaveLength(2);
    expect(merged.newReports[0].id).not.toBe('rep-1');
  });

  it('never mutates the caller arrays on import', () => {
    const incoming = JSON.parse(JSON.stringify(existing)) as ProjectRecord;
    const projectsBefore = [existing];
    const reportsBefore = [report('rep-0', existing.projectId)];
    importProjectIntoRegistry(projectsBefore, reportsBefore, { project: incoming, reports: [report('rep-1', incoming.projectId)] });
    expect(projectsBefore).toEqual([existing]);
    expect(reportsBefore.map((r) => r.id)).toEqual(['rep-0']);
  });
});

describe('project deletion (§12)', () => {
  const a = newProjectRecord(acceptanceInputs(), { nameEn: 'A', nameJa: 'A' }, NOW_ISO, []);
  const b = newProjectRecord(acceptanceInputs(), { nameEn: 'B', nameJa: 'B' }, NOW_ISO, [a]);
  const c = newProjectRecord(acceptanceInputs(), { nameEn: 'C', nameJa: 'C' }, NOW_ISO, [a, b]);
  const reports = [report('rep-a', a.projectId), report('rep-b', b.projectId), report('rep-c', c.projectId)];

  it('removes the project and only its reports', () => {
    const removal = removeProjectFromRegistry([a, b, c], reports, a.id, b.id);
    expect(removal.projects.map((p) => p.id)).toEqual([a.id, c.id]);
    expect(removal.reports.map((r) => r.id)).toEqual(['rep-a', 'rep-c']);
    expect(removal.nextActiveProjectId).toBe(a.id); // active id unchanged (a was not removed)
  });

  it('falls back to the first remaining project when the active one is deleted', () => {
    const removal = removeProjectFromRegistry([a, b, c], reports, b.id, b.id);
    expect(removal.nextActiveProjectId).not.toBeNull();
    const activeRemoval = removeProjectFromRegistry([a, b, c], reports, a.id, a.id);
    expect(activeRemoval.nextActiveProjectId).toBe(b.id);
  });

  it('deleting the last project leaves an empty registry with no active id', () => {
    const removal = removeProjectFromRegistry([a], [report('rep-a', a.projectId)], a.id, a.id);
    expect(removal.projects).toEqual([]);
    expect(removal.reports).toEqual([]);
    expect(removal.nextActiveProjectId).toBeNull();
  });

  it('deletion persists across reload', () => {
    const removal = removeProjectFromRegistry([a, b, c], reports, c.id, c.id);
    const reportsState: ReportsState = {
      ...defaultReportsState(),
      projects: removal.projects,
      reports: removal.reports,
      activeProjectId: removal.nextActiveProjectId,
    };
    writePersistedWorkspace(appState(acceptanceInputs()), reportsState);
    const reloaded = loadReportsState();
    expect(reloaded.projects.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
    expect(reloaded.reports.map((r) => r.id).sort()).toEqual(['rep-a', 'rep-b'].sort());
  });

  it('removing an unknown id is a no-op', () => {
    const removal = removeProjectFromRegistry([a, b], reports, 'nope', 'nope');
    expect(removal.projects).toEqual([a, b]);
    expect(removal.nextActiveProjectId).toBe('nope');
  });
});

describe('full local reset (§13)', () => {
  it('clears every persisted key including recovery payloads and metadata', () => {
    storage.setItem(STORAGE_KEY, '{corrupt');
    loadState(); // stashes a recovery payload
    writePersistedWorkspace(appState(acceptanceInputs()), defaultReportsState());
    expect(storage.getItem(STORAGE_KEY)).not.toBeNull();
    expect(storage.getItem(REPORTS_STORAGE_KEY)).not.toBeNull();
    expect(storage.getItem(META_STORAGE_KEY)).not.toBeNull();
    expect(clearAllPersistence()).toBe(true);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
    expect(storage.getItem(REPORTS_STORAGE_KEY)).toBeNull();
    expect(storage.getItem(META_STORAGE_KEY)).toBeNull();
    expect(Array.from(storage.map.keys()).some((key) => key.startsWith('ganttchart.recovery.'))).toBe(false);
  });

  it('the application returns to its initial state after the reset', () => {
    writePersistedWorkspace(appState(acceptanceInputs()), defaultReportsState());
    clearAllPersistence();
    // The reset flow writes the fresh initial state (like a first run).
    const fresh: AppState = { ...DEMO_STATE, language: 'en', dashboardView: 'operator', dailyOvertimeMinutes: 0 };
    writePersistedWorkspace(fresh, defaultReportsState());
    // V7: the raw legacy payload loads in the migrated form — same totals,
    // now carried by one opening daily execution entry.
    const loaded = loadState();
    expect(loaded.totalCases).toBe(fresh.totalCases);
    expect(loaded.language).toBe(fresh.language);
    expect(loaded.dashboardView).toBe(fresh.dashboardView);
    expect(loaded.casesCompleted).toBe(fresh.casesCompleted);
    expect(loaded.casesPassed).toBe(fresh.casesPassed);
    expect(loaded.dailyExecuted).toHaveLength(1);
    expect(loadReportsState().projects).toEqual([]);
  });
});

describe('§26 end-to-end acceptance scenario', () => {
  it('export → wipe → import preserves the full project (SPO, overrides, reports, IDs)', () => {
    // Total 100 / Pass 50 / Fail 5 / NA 5 / SPO 20 → QA Tested 60, QA Completed 80.
    const project = newProjectRecord(acceptanceInputs(), { nameEn: 'A', nameJa: 'A' }, NOW_ISO, []);
    const projectReport = report('rep-1', project.projectId);
    const exportText = JSON.stringify(createProjectBackupPayload(project, [projectReport], NOW_ISO));

    // Wipe local state, then import into an empty registry.
    clearAllPersistence();
    const parsed = parseProjectBackupPayload(exportText);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const merged = importProjectIntoRegistry([], [], parsed.data);

    const restored = merged.importedProject;
    const counts = calculateExecutionCounts(restored.inputs);
    expect(restored.projectId).toBe(project.projectId);
    expect(restored.inputs.totalCases).toBe(100);
    expect(restored.inputs.casesCompleted).toBe(80);
    expect(restored.inputs.casesPassed).toBe(50);
    expect(restored.inputs.spoAssigned).toBe(20);
    expect(counts.qaTested).toBe(60);
    expect(counts.spoAssigned).toBe(20);
    expect(counts.qaCompleted).toBe(80);
    expect(counts.remaining).toBe(20);
    expect(counts.qaTestedRatio).toBe(0.6);
    expect(counts.qaCompletedRatio).toBe(0.8);
    // Manual planning overrides unchanged.
    expect(restored.inputs.dailyTargetOverrides).toEqual(project.inputs.dailyTargetOverrides);
    // Reports survive.
    expect(merged.newReports).toHaveLength(1);
    expect(merged.newReports[0].projectId).toBe(restored.projectId);
    // And the restored workspace persists.
    const reportsState: ReportsState = {
      ...defaultReportsState(),
      projects: merged.projects,
      reports: merged.reports,
      activeProjectId: restored.id,
    };
    writePersistedWorkspace(appState(restored.inputs), reportsState);
    expect(loadReportsState().projects[0].inputs.spoAssigned).toBe(20);
  });
});

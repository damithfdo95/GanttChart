import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, DailyActualSnapshot, QaInputs, ReportsState } from '../types';
import {
  buildExecutionHistory,
  createExecutionSnapshot,
  executionTrendPoints,
  latestSnapshot,
  snapshotPass,
  type ExecutionHistoryRow,
} from '../lib/calculations/history';
import { calculateExecutionCounts } from '../lib/calculations/execution';
import { calculateExecutiveSummary } from '../lib/calculations/executive';
import { calculateRequiredHours, calculateRequiredTesters, calculateTeamCapacity } from '../lib/calculations/capacity';
import { calculateExpectedFinish } from '../lib/calculations/schedule';
import { validateInputs } from '../lib/validation/validate';
import { normalizeQaInputs, saveState, loadState } from '../lib/storage/storage';
import { defaultReportsState, loadReportsState, saveReportsState } from '../lib/storage/reports';
import { createExportPayload, parseImportPayload } from '../lib/jsonio/jsonio';
import { createBackupPayload, parseBackupPayload } from '../lib/backup/backup';
import { createProjectBackupPayload, importProjectIntoRegistry, parseProjectBackupPayload } from '../lib/backup/projectBackup';
import { applyActiveProjectSync, qaInputsFromAppState } from '../domain/projects';
import { newProjectRecord } from '../domain/projects/lifecycle';
import { executionHistorySheet } from '../lib/export/exportData';
import { renderProgressSection } from '../lib/reporting/sections';
import { DEFAULT_PROGRESS_RULES } from '../lib/reporting/progress';
import type { ReportActivity } from '../types';

/**
 * V6.5 — Execution History & Risk Dashboard.
 *
 * Snapshots are frozen copies of the canonical granular state; aggregates
 * (QA Tested / QA Completed / Remaining) are derived with the SAME existing
 * execution logic. Legacy snapshots are never reconstructed: unknown
 * granular values stay unknown (null / "—"), never a false zero.
 *
 * Acceptance scenario (§22): Total 100.
 *   Day 1: Pass 30 / Fail 2 / N/A 3 / SPO 5 / Blocked 4 / Retest 1 / Q 2
 *          → QA Tested 35, QA Completed 40, Remaining 60
 *   Day 2: Pass 60 / Fail 5 / N/A 5 / SPO 20 / Blocked 3 / Retest 2 / Q 1
 *          → QA Tested 70, QA Completed 90, Remaining 10
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
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal('window', { localStorage: storage });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function inputs(status: Partial<QaInputs> = {}): QaInputs {
  return normalizeQaInputs({
    totalCases: 100,
    currentTesters: 8,
    startTime: 13 * 60,
    targetFinish: 17 * 60,
    lunchStart: 0,
    lunchEnd: 0,
    perHourPerTester: 4,
    casesCompleted: 0,
    casesPassed: 0,
    startDate: '2026-09-28',
    targetCompletionDate: '2026-09-30',
    targetCompletionTime: '17:00',
    planningRows: [
      { id: 'row-1', date: '2026-09-28', plannedTesters: 8, absentTesters: 0, nonWorkingDay: false, note: '' },
      { id: 'row-2', date: '2026-09-29', plannedTesters: 8, absentTesters: 0, nonWorkingDay: false, note: '' },
    ],
    ...status,
  });
}

/** The §22 acceptance state for the given day. */
function dayInputs(day: 1 | 2): QaInputs {
  if (day === 1) {
    return inputs({
      casesCompleted: 40,
      casesPassed: 30,
      casesFailed: 2,
      casesNotApplicable: 3,
      spoAssigned: 5,
      casesBlocked: 4,
      casesRetest: 1,
      casesQuestioned: 2,
    });
  }
  return inputs({
    casesCompleted: 90,
    casesPassed: 60,
    casesFailed: 5,
    casesNotApplicable: 5,
    spoAssigned: 20,
    casesBlocked: 3,
    casesRetest: 2,
    casesQuestioned: 1,
  });
}

function daySnapshot(day: 1 | 2, date: string): DailyActualSnapshot {
  return createExecutionSnapshot(`snap-${day}`, date, dayInputs(day));
}

function appState(state: QaInputs): AppState {
  return {
    ...state,
    language: 'ja',
    projectNameEn: 'History Project',
    projectNameJa: '履歴プロジェクト',
    dashboardView: 'operator',
  };
}

function activity(overrides: Partial<ReportActivity> = {}): ReportActivity {
  return {
    id: 'act-1',
    source: 'AUTO',
    name: 'Sanity Testing',
    memberCount: 8,
    completedCases: 90,
    workingStatus: 'Working',
    included: true,
    totalCases: 100,
    workingEligibleCases: 100,
    startedCases: 90,
    blockedCases: 3,
    notApplicableCases: 5,
    spoAssigned: 20,
    casesPassed: 60,
    casesFailed: 5,
    casesRetest: 2,
    casesQuestioned: 1,
    dueDate: '2026-09-30',
    ...overrides,
  };
}

describe('snapshot creation', () => {
  it('captures all seven granular values from the current canonical state', () => {
    const snapshot = daySnapshot(1, '2026-09-28');
    expect(snapshot.executed).toBe(40);
    expect(snapshot.passed).toBe(30);
    expect(snapshot.casesPassed).toBe(30);
    expect(snapshot.casesFailed).toBe(2);
    expect(snapshot.casesNotApplicable).toBe(3);
    expect(snapshot.spoAssigned).toBe(5);
    expect(snapshot.casesBlocked).toBe(4);
    expect(snapshot.casesRetest).toBe(1);
    expect(snapshot.casesQuestioned).toBe(2);
  });

  it('is consistent by construction for granular states', () => {
    const snapshot = daySnapshot(2, '2026-09-29');
    expect(snapshot.casesPassed! + snapshot.casesFailed! + snapshot.casesNotApplicable! + snapshot.spoAssigned!).toBe(
      snapshot.executed,
    );
  });

  it('remains independent from later project edits (frozen copy)', () => {
    const source = dayInputs(1);
    const snapshot = createExecutionSnapshot('snap-1', '2026-09-28', source);
    // Mutating the project afterwards never touches the snapshot.
    source.casesCompleted = 99;
    source.casesPassed = 98;
    source.casesBlocked = 77;
    expect(snapshot.executed).toBe(40);
    expect(snapshot.casesPassed).toBe(30);
    expect(snapshot.casesBlocked).toBe(4);
  });

  it('records uncategorized completion honestly (consistency flag false, no repair)', () => {
    const legacyish = inputs({ casesCompleted: 15, casesPassed: 11, casesFailed: 0, casesNotApplicable: 0, spoAssigned: 0 });
    const snapshot = createExecutionSnapshot('snap-x', '2026-09-27', legacyish);
    expect(snapshot.executed).toBe(15); // authoritative aggregate kept verbatim
    const [row] = buildExecutionHistory([snapshot], 100);
    expect(row.granularConsistent).toBe(false); // 4 uncategorized completed cases
  });
});

describe('derived history values (existing execution logic)', () => {
  const history = buildExecutionHistory([daySnapshot(1, '2026-09-28'), daySnapshot(2, '2026-09-29')], 100);

  it('derives QA Tested = executed − SPO (= Pass + Fail + N/A)', () => {
    expect(history[0].qaTested).toBe(35);
    expect(history[1].qaTested).toBe(70);
  });

  it('derives QA Completed = executed', () => {
    expect(history[0].qaCompleted).toBe(40);
    expect(history[1].qaCompleted).toBe(90);
  });

  it('derives Remaining = Total − QA Completed', () => {
    expect(history[0].remaining).toBe(60);
    expect(history[1].remaining).toBe(10);
  });

  it('matches calculateExecutionCounts on the same source state', () => {
    for (const day of [1, 2] as const) {
      const counts = calculateExecutionCounts(dayInputs(day));
      const snapshot = createExecutionSnapshot(`s${day}`, '2026-09-28', dayInputs(day));
      const [row] = buildExecutionHistory([snapshot], 100);
      expect(row.qaTested).toBe(counts.qaTested);
      expect(row.qaCompleted).toBe(counts.qaCompleted);
      expect(row.remaining).toBe(counts.remaining);
    }
  });

  it('exposes deltas between consecutive snapshots', () => {
    expect(history[0].deltaQaCompleted).toBeNull(); // oldest snapshot
    expect(history[1].deltaQaCompleted).toBe(50);
    expect(history[1].deltaQaTested).toBe(35);
    expect(history[1].deltaRemaining).toBe(-50);
  });
});

describe('historical ordering', () => {
  it('sorts chronologically regardless of input order', () => {
    const history = buildExecutionHistory(
      [daySnapshot(2, '2026-09-29'), daySnapshot(1, '2026-09-28')],
      100,
    );
    expect(history.map((row) => row.date)).toEqual(['2026-09-28', '2026-09-29']);
  });

  it('identifies the newest snapshot', () => {
    const snapshots = [daySnapshot(1, '2026-09-28'), daySnapshot(2, '2026-09-29')];
    expect(latestSnapshot(snapshots)?.id).toBe('snap-2');
  });

  it('handles a single snapshot', () => {
    const history = buildExecutionHistory([daySnapshot(1, '2026-09-28')], 100);
    expect(history).toHaveLength(1);
    expect(history[0].deltaQaCompleted).toBeNull();
    expect(executionTrendPoints(history)).toHaveLength(1);
  });

  it('handles empty history gracefully', () => {
    expect(buildExecutionHistory([], 100)).toEqual([]);
    expect(latestSnapshot([])).toBeNull();
    expect(executionTrendPoints([])).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const snapshots = [daySnapshot(2, '2026-09-29'), daySnapshot(1, '2026-09-28')];
    buildExecutionHistory(snapshots, 100);
    expect(snapshots.map((s) => s.date)).toEqual(['2026-09-29', '2026-09-28']);
  });
});

describe('legacy compatibility (historical honesty)', () => {
  const legacy: DailyActualSnapshot = { id: 'old-1', date: '2026-09-27', executed: 70, passed: 60 };

  it('old snapshots load and derive from their recorded aggregates', () => {
    const [row] = buildExecutionHistory([legacy], 100);
    expect(row.qaCompleted).toBe(70);
    expect(row.qaTested).toBe(70); // no SPO recorded → tested = executed
    expect(row.remaining).toBe(30);
    expect(row.granularKnown).toBe(false);
    expect(row.granularConsistent).toBeNull();
  });

  it('never infers granular values from old aggregates', () => {
    const [row] = buildExecutionHistory([legacy], 100);
    // executed 70 / passed 60 must NOT become Fail = 10.
    expect(row.fail).toBeNull();
    expect(row.notApplicable).toBeNull();
    expect(row.spo).toBeNull();
    expect(row.blocked).toBeNull();
    expect(row.retest).toBeNull();
    expect(row.questioned).toBeNull();
  });

  it('uses the recorded legacy `passed` as the Pass display value', () => {
    expect(snapshotPass(legacy)).toBe(60);
    const [row] = buildExecutionHistory([legacy], 100);
    expect(row.pass).toBe(60);
  });

  it('old snapshots pass the shape guard and load from persisted projects', () => {
    const record = newProjectRecord(inputs(), { nameEn: 'A', nameJa: 'A' }, NOW_ISO, []);
    const state: ReportsState = {
      ...defaultReportsState(),
      projects: [{ ...record, inputs: { ...record.inputs, dailyActuals: [legacy] } }],
    };
    saveReportsState(state);
    const reloaded = loadReportsState();
    expect(reloaded.projects[0].inputs.dailyActuals).toHaveLength(1);
    expect(reloaded.projects[0].inputs.dailyActuals![0].executed).toBe(70);
    expect(reloaded.projects[0].inputs.dailyActuals![0].casesFailed).toBeUndefined();
  });

  it('mixed legacy + V6.5 histories keep both honest', () => {
    const history = buildExecutionHistory([legacy, daySnapshot(2, '2026-09-29')], 100);
    expect(history[0].fail).toBeNull();
    expect(history[1].fail).toBe(5);
    expect(history[0].granularKnown).toBe(false);
    expect(history[1].granularKnown).toBe(true);
  });
});

describe('project isolation', () => {
  it('each project keeps its own history through the write-back path', () => {
    const aInputs = { ...dayInputs(1), dailyActuals: [daySnapshot(1, '2026-09-28')] };
    const bInputs = { ...dayInputs(2), dailyActuals: [daySnapshot(2, '2026-09-29')] };
    const a = newProjectRecord(aInputs, { nameEn: 'A', nameJa: 'A' }, NOW_ISO, []);
    const b = newProjectRecord(bInputs, { nameEn: 'B', nameJa: 'B' }, NOW_ISO, [a]);
    // Switch to project B: the editing surface carries B's history only.
    const editing = appState(b.inputs);
    const synced = applyActiveProjectSync([a, b], b.id, editing.projectNameEn, editing.projectNameJa, qaInputsFromAppState(editing), NOW_ISO);
    expect(synced.find((p) => p.id === b.id)!.inputs.dailyActuals).toHaveLength(1);
    expect(synced.find((p) => p.id === b.id)!.inputs.dailyActuals![0].executed).toBe(90);
    // Project A is untouched by reference and value.
    expect(synced.find((p) => p.id === a.id)).toBe(a);
    expect(synced.find((p) => p.id === a.id)!.inputs.dailyActuals![0].executed).toBe(40);
  });
});

describe('informational statuses in history', () => {
  it('Blocked / Retest / 質問中 are preserved per snapshot', () => {
    const history = buildExecutionHistory([daySnapshot(1, '2026-09-28'), daySnapshot(2, '2026-09-29')], 100);
    expect(history[0].blocked).toBe(4);
    expect(history[0].retest).toBe(1);
    expect(history[0].questioned).toBe(2);
    expect(history[1].blocked).toBe(3);
    expect(history[1].retest).toBe(2);
    expect(history[1].questioned).toBe(1);
  });

  it('informational statuses never alter completion math', () => {
    const withInfo = buildExecutionHistory([daySnapshot(2, '2026-09-29')], 100)[0];
    const withoutInfo = buildExecutionHistory(
      [createExecutionSnapshot('s', '2026-09-29', { ...dayInputs(2), casesBlocked: 0, casesRetest: 0, casesQuestioned: 0 })],
      100,
    )[0];
    expect(withInfo.qaCompleted).toBe(withoutInfo.qaCompleted);
    expect(withInfo.remaining).toBe(withoutInfo.remaining);
    expect(withInfo.qaTested).toBe(withoutInfo.qaTested);
  });

  it('overlapping informational statuses are independent counts (no combined total)', () => {
    const snapshot = createExecutionSnapshot('s', '2026-09-29', {
      ...dayInputs(2),
      casesBlocked: 5,
      casesRetest: 4,
      casesQuestioned: 3,
    });
    const [row] = buildExecutionHistory([snapshot], 100);
    expect(row.blocked).toBe(5);
    expect(row.retest).toBe(4);
    expect(row.questioned).toBe(3);
    expect(row.remaining).toBe(10); // NOT 100 − 90 − 12
    expect(row.qaCompleted).toBe(90);
  });
});

describe('persistence round trips', () => {
  const snapshots = [daySnapshot(1, '2026-09-28'), daySnapshot(2, '2026-09-29')];

  it('survives localStorage (app state + portfolio)', () => {
    saveState(appState({ ...dayInputs(2), dailyActuals: snapshots }));
    const loaded = loadState();
    expect(loaded.dailyActuals).toEqual(snapshots);
    const record = newProjectRecord({ ...dayInputs(2), dailyActuals: snapshots }, { nameEn: 'A', nameJa: 'A' }, NOW_ISO, []);
    saveReportsState({ ...defaultReportsState(), projects: [record] });
    expect(loadReportsState().projects[0].inputs.dailyActuals).toEqual(snapshots);
  });

  it('survives JSON export/import', () => {
    const state = appState({ ...dayInputs(2), dailyActuals: snapshots });
    const result = parseImportPayload(JSON.stringify(createExportPayload(state)));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.dailyActuals).toEqual(snapshots);
      expect(result.data.dailyActuals![0].casesFailed).toBe(2);
      expect(result.data.dailyActuals![1].casesQuestioned).toBe(1);
    }
  });

  it('survives project backup → import (history identical)', () => {
    const project = newProjectRecord({ ...dayInputs(2), dailyActuals: snapshots }, { nameEn: 'A', nameJa: 'A' }, NOW_ISO, []);
    const parsed = parseProjectBackupPayload(JSON.stringify(createProjectBackupPayload(project, [], NOW_ISO)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const merged = importProjectIntoRegistry([], [], parsed.data);
    expect(merged.importedProject.inputs.dailyActuals).toEqual(snapshots);
  });

  it('survives workspace backup → import (history identical)', () => {
    const state = appState({ ...dayInputs(2), dailyActuals: snapshots });
    const reports: ReportsState = {
      ...defaultReportsState(),
      projects: [newProjectRecord({ ...dayInputs(2), dailyActuals: snapshots }, { nameEn: 'A', nameJa: 'A' }, NOW_ISO, [])],
    };
    const parsed = parseBackupPayload(JSON.stringify(createBackupPayload(state, reports)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.data.reportsState.projects[0].inputs.dailyActuals).toEqual(snapshots);
      expect(parsed.data.appState.dailyActuals).toEqual(snapshots);
    }
  });

  it('legacy snapshots survive every round trip without gaining fields', () => {
    const legacy: DailyActualSnapshot = { id: 'old-1', date: '2026-09-27', executed: 70, passed: 60 };
    const state = appState({ ...dayInputs(1), dailyActuals: [legacy] });
    const result = parseImportPayload(JSON.stringify(createExportPayload(state)));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.dailyActuals![0].casesFailed).toBeUndefined();
      expect(result.data.dailyActuals![0].executed).toBe(70);
    }
  });
});

describe('trend calculations', () => {
  const history = buildExecutionHistory([daySnapshot(1, '2026-09-28'), daySnapshot(2, '2026-09-29')], 100);

  it('produces chronological trend points with all three series', () => {
    const points = executionTrendPoints(history);
    expect(points.map((p) => p.date)).toEqual(['2026-09-28', '2026-09-29']);
    expect(points[0]).toEqual({ date: '2026-09-28', qaTested: 35, qaCompleted: 40, remaining: 60 });
    expect(points[1]).toEqual({ date: '2026-09-29', qaTested: 70, qaCompleted: 90, remaining: 10 });
  });

  it('uses snapshot values, not the current live state', () => {
    const points = executionTrendPoints(history);
    expect(points[1].qaCompleted).toBe(90); // snapshot value
  });

  it('first snapshot has no delta (empty initial state)', () => {
    expect(history[0].deltaQaCompleted).toBeNull();
  });
});

describe('executive summary breakdown (§10)', () => {
  it('exposes the granular values derived from the canonical state', () => {
    const summary = calculateExecutiveSummary(dayInputs(2), 14 * 60);
    expect(summary.pass).toBe(60);
    expect(summary.fail).toBe(5);
    expect(summary.notApplicable).toBe(5);
    expect(summary.spoAssigned).toBe(20);
    expect(summary.blocked).toBe(3);
    expect(summary.retest).toBe(2);
    expect(summary.questioned).toBe(1);
    expect(summary.qaTested).toBe(70);
    expect(summary.casesCompleted).toBe(90); // QA Completed (existing field)
  });

  it('zero-state shows all zeros without changing the schedule math', () => {
    const zero = calculateExecutiveSummary(inputs(), 14 * 60);
    expect([zero.pass, zero.fail, zero.notApplicable, zero.spoAssigned, zero.blocked, zero.retest, zero.questioned]).toEqual(
      [0, 0, 0, 0, 0, 0, 0],
    );
    expect(zero.casesRemaining).toBe(100);
  });

  it('reuses calculateExecutionCounts (no duplicate calculation path)', () => {
    const summary = calculateExecutiveSummary(dayInputs(2), 14 * 60);
    const counts = calculateExecutionCounts(dayInputs(2));
    expect(summary.pass).toBe(counts.pass);
    expect(summary.qaTested).toBe(counts.qaTested);
    expect(summary.casesCompleted).toBe(counts.qaCompleted);
  });
});

describe('engine safety (V6.5 changes no calculation semantics)', () => {
  it('capacity / required hours / testers / expected finish are unchanged', () => {
    const withInfo = dayInputs(2);
    const withoutInfo = inputs({
      casesCompleted: 90,
      casesPassed: 60,
      casesFailed: 5,
      casesNotApplicable: 5,
      spoAssigned: 20,
    });
    const lunch = { start: 0, end: 0 };
    for (const state of [withInfo, withoutInfo]) {
      expect(calculateTeamCapacity(state.currentTesters, state.perHourPerTester)).toBe(32);
      expect(calculateRequiredHours(state.totalCases, 32)).toBeCloseTo(3.125, 6);
      expect(calculateRequiredTesters(state.totalCases, state.perHourPerTester, 4)).toBe(7);
      expect(calculateExpectedFinish(state.startTime, 3.125 * 60, lunch)).toBeCloseTo(780 + 187.5, 6);
    }
    expect(validateInputs(withInfo).isValid).toBe(true);
  });
});

describe('Excel export (§18)', () => {
  it('history sheet has the granular columns and correct derived values', () => {
    const sheet = executionHistorySheet('en', [daySnapshot(1, '2026-09-28'), daySnapshot(2, '2026-09-29')], 100);
    expect(sheet.headers).toEqual([
      'Date', 'Pass', 'Fail', 'N/A', 'SPO', 'Tested (excl. SPO)', 'Completed (incl. SPO)', 'Remaining Test Cases',
      'Blocked', 'Retest', 'Question (質問中)',
    ]);
    expect(sheet.rows[0]).toEqual([{ kind: 'date', value: '2026-09-28' }, 30, 2, 3, 5, 35, 40, 60, 4, 1, 2]);
    expect(sheet.rows[1]).toEqual([{ kind: 'date', value: '2026-09-29' }, 60, 5, 5, 20, 70, 90, 10, 3, 2, 1]);
  });

  it('legacy snapshots export "not available" — never a false zero', () => {
    const legacy: DailyActualSnapshot = { id: 'old-1', date: '2026-09-27', executed: 70, passed: 60 };
    const sheet = executionHistorySheet('en', [legacy], 100);
    expect(sheet.rows[0]).toEqual([{ kind: 'date', value: '2026-09-27' }, 60, '—', '—', '—', 70, 70, 30, '—', '—', '—']);
  });

  it('empty history yields a header-only sheet', () => {
    const sheet = executionHistorySheet('en', [], 100);
    expect(sheet.rows).toEqual([]);
    expect(sheet.headers).toHaveLength(11);
  });

  it('round-trip data preservation: sheet values match the snapshots', () => {
    const snapshots = [daySnapshot(1, '2026-09-28'), daySnapshot(2, '2026-09-29')];
    const sheet = executionHistorySheet('en', snapshots, 100);
    snapshots.forEach((snapshot, i) => {
      expect((sheet.rows[i][0] as { kind: 'date'; value: string }).value).toBe(snapshot.date);
      expect(sheet.rows[i][5]).toBe(snapshot.executed - snapshot.spoAssigned!);
      expect(sheet.rows[i][6]).toBe(snapshot.executed);
    });
  });
});

describe('daily report integration (§13)', () => {
  it('adds the QA Tested line when SPO > 0', () => {
    const text = renderProgressSection('en', [activity()], DEFAULT_PROGRESS_RULES);
    expect(text).toContain('QA Tested: 70');
  });

  it('omits the QA Tested line when SPO = 0 (Completed already covers it)', () => {
    const text = renderProgressSection('en', [activity({ spoAssigned: 0, completedCases: 70 })], DEFAULT_PROGRESS_RULES);
    expect(text).not.toContain('QA Tested:');
  });
});

describe('end-to-end acceptance (§22)', () => {
  it('records the two-day progression and preserves it through export/import', () => {
    const snapshots = [daySnapshot(1, '2026-09-28'), daySnapshot(2, '2026-09-29')];
    const state = appState({ ...dayInputs(2), dailyActuals: snapshots });
    const history = buildExecutionHistory(state.dailyActuals ?? [], state.totalCases);

    // Day 1: QA Tested 35 / QA Completed 40 / Remaining 60
    expect(history[0].qaTested).toBe(35);
    expect(history[0].qaCompleted).toBe(40);
    expect(history[0].remaining).toBe(60);
    // Day 2: QA Tested 70 / QA Completed 90 / Remaining 10
    expect(history[1].qaTested).toBe(70);
    expect(history[1].qaCompleted).toBe(90);
    expect(history[1].remaining).toBe(10);
    // Trend progression uses the snapshots.
    const points = executionTrendPoints(history);
    expect(points.map((p) => p.qaCompleted)).toEqual([40, 90]);
    expect(points.map((p) => p.remaining)).toEqual([60, 10]);

    // Export → wipe → import → identical history.
    const text = JSON.stringify(createExportPayload(state));
    storage.map.clear();
    const result = parseImportPayload(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const restored = buildExecutionHistory(result.data.dailyActuals ?? [], result.data.totalCases);
    expect(restored).toEqual(history as ExecutionHistoryRow[]);
    expect(restored[1].pass).toBe(60);
    expect(restored[1].fail).toBe(5);
    expect(restored[1].notApplicable).toBe(5);
    expect(restored[1].spo).toBe(20);
    expect(restored[1].blocked).toBe(3);
    expect(restored[1].retest).toBe(2);
    expect(restored[1].questioned).toBe(1);
  });
});

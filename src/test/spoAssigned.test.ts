import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calculateExecutionCounts } from '../lib/calculations/execution';
import { calculateExecutiveSummary } from '../lib/calculations/executive';
import { generateDailyPlan } from '../lib/calculations/dailyPlan';
import { validateInputs } from '../lib/validation/validate';
import { normalizeQaInputs, saveState, loadState, DEMO_STATE } from '../lib/storage/storage';
import { defaultReportsState, loadReportsState, saveReportsState } from '../lib/storage/reports';
import { createExportPayload, parseImportPayload } from '../lib/jsonio/jsonio';
import {
  applyActiveProjectSync,
  projectProgress,
  qaInputsFromAppState,
} from '../domain/projects';
import { newProjectRecord } from '../domain/projects/lifecycle';
import { seedAutoActivities } from '../lib/reporting/drafts';
import { buildProjectInputsFromForm, defaultNewProjectForm, validateNewProjectForm } from '../lib/validation/newProjectForm';
import type { AppState, ProjectRecord, QaInputs, ReportsState } from '../types';

/**
 * V6.3 — SPO Assigned / SPO対応 test-case handling.
 *
 * Canonical model:
 *   QA Tested    = casesCompleted − spoAssigned  (actually executed by QA)
 *   QA Completed = casesCompleted                 (tested + transferred to SPO)
 *   Remaining    = totalCases − casesCompleted
 *
 * The existing engine is untouched: casesCompleted continues to drive every
 * remaining/progress calculation, now under the QA-responsibility meaning.
 * All dates/times are deterministic.
 */

const NOW_ISO = '2026-09-29T09:00:00.000Z';
const NOW_MINUTES = 14 * 60; // 14:00, deterministic "now" for executive math

class MemoryStorage {
  private map = new Map<string, string>();
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

function baseInputs(overrides: Partial<QaInputs> = {}): QaInputs {
  return normalizeQaInputs({
    totalCases: 100,
    currentTesters: 8,
    startTime: 13 * 60,
    targetFinish: 17 * 60,
    lunchStart: 0,
    lunchEnd: 0,
    perHourPerTester: 4,
    casesCompleted: 0,
    startDate: '2026-09-29',
    targetCompletionDate: '2026-09-29',
    targetCompletionTime: '17:00',
    planningRows: [
      { id: 'row-1', date: '2026-09-29', plannedTesters: 8, absentTesters: 0, nonWorkingDay: false, note: '' },
    ],
    ...overrides,
  });
}

function appState(inputs: QaInputs): AppState {
  return {
    ...inputs,
    language: 'ja',
    projectNameEn: 'SPO Project',
    projectNameJa: 'SPOプロジェクト',
    dashboardView: 'operator',
  };
}

function project(inputs: QaInputs): ProjectRecord {
  return newProjectRecord(inputs, { nameEn: 'SPO Project', nameJa: 'SPOプロジェクト', status: 'ongoing' }, NOW_ISO, []);
}

describe('calculateExecutionCounts (SPO semantics)', () => {
  it('defaults SPO to zero when the field is absent', () => {
    const counts = calculateExecutionCounts({ totalCases: 100, casesCompleted: 60 });
    expect(counts.spoAssigned).toBe(0);
    expect(counts.qaTested).toBe(60);
    expect(counts.qaCompleted).toBe(60);
    expect(counts.remaining).toBe(40);
  });

  it('reflects an increased SPO assignment: tested drops, completed stays', () => {
    const before = calculateExecutionCounts({ totalCases: 100, casesCompleted: 70 });
    const after = calculateExecutionCounts({ totalCases: 100, casesCompleted: 70, spoAssigned: 20 });
    expect(after.spoAssigned).toBe(20);
    expect(after.qaTested).toBe(50);
    expect(after.qaCompleted).toBe(70);
    expect(after.qaTested).toBe(before.qaTested - 20);
    expect(after.remaining).toBe(before.remaining);
  });

  it('does not count SPO cases as QA-tested', () => {
    const counts = calculateExecutionCounts({ totalCases: 100, casesCompleted: 90, spoAssigned: 20 });
    expect(counts.qaTested).toBe(70);
  });

  it('counts SPO cases as QA-completed', () => {
    const counts = calculateExecutionCounts({ totalCases: 100, casesCompleted: 90, spoAssigned: 20 });
    expect(counts.qaCompleted).toBe(90);
    expect(counts.qaCompleted).toBe(counts.qaTested + counts.spoAssigned);
  });

  it('reduces the QA remaining workload by SPO-assigned cases', () => {
    // 20 of 100 transferred to SPO and nothing executed by QA yet:
    const counts = calculateExecutionCounts({ totalCases: 100, casesCompleted: 20, spoAssigned: 20 });
    expect(counts.remaining).toBe(80);
    // After QA completes 60 of the remaining 80:
    const later = calculateExecutionCounts({ totalCases: 100, casesCompleted: 80, spoAssigned: 20 });
    expect(later.qaTested).toBe(60);
    expect(later.remaining).toBe(20);
  });

  it('exposes both the QA-completed and QA-tested ratios separately', () => {
    const counts = calculateExecutionCounts({ totalCases: 100, casesCompleted: 80, spoAssigned: 20 });
    expect(counts.qaCompletedRatio).toBe(0.8);
    expect(counts.qaTestedRatio).toBe(0.6);
  });

  it('never double-counts: tested + SPO + remaining always equals total', () => {
    for (const [total, completed, spo] of [
      [100, 0, 0],
      [100, 20, 20],
      [100, 80, 20],
      [100, 100, 100],
      [100, 100, 0],
      [0, 0, 0],
    ] as const) {
      const counts = calculateExecutionCounts({ totalCases: total, casesCompleted: completed, spoAssigned: spo });
      expect(counts.qaTested + counts.spoAssigned + counts.remaining).toBe(total);
    }
  });

  it('returns null ratios for a zero-total project', () => {
    const counts = calculateExecutionCounts({ totalCases: 0, casesCompleted: 0, spoAssigned: 0 });
    expect(counts.qaCompletedRatio).toBeNull();
    expect(counts.qaTestedRatio).toBeNull();
  });
});

describe('acceptance scenario (100 total, Pass 50, SPO 20)', () => {
  // Fail 5 + NA 5 are inside casesCompleted like every existing project.
  const inputs = baseInputs({ casesCompleted: 80, casesPassed: 50, spoAssigned: 20 });
  const counts = calculateExecutionCounts(inputs);

  it('produces QA Tested 60 / SPO 20 / QA Completed 80 / Remaining 20', () => {
    expect(counts.qaTested).toBe(60);
    expect(counts.spoAssigned).toBe(20);
    expect(counts.qaCompleted).toBe(80);
    expect(counts.remaining).toBe(20);
  });

  it('reports 80% QA responsibility progress and 60% actual QA-tested ratio', () => {
    expect(counts.qaCompletedRatio).toBe(0.8);
    expect(counts.qaTestedRatio).toBe(0.6);
  });

  it('keeps the canonical inputs valid and Pass ⊆ QA Tested', () => {
    expect(validateInputs(inputs).isValid).toBe(true);
    expect(inputs.casesPassed!).toBeLessThanOrEqual(counts.qaTested);
  });

  it('feeds the existing engine unchanged (progress, remaining, projection)', () => {
    const progress = projectProgress(project(inputs));
    expect(progress.completed).toBe(80);
    expect(progress.remaining).toBe(20);
    expect(progress.ratio).toBe(0.8);
  });

  it('exposes the distinction in the executive summary', () => {
    const summary = calculateExecutiveSummary(inputs, NOW_MINUTES);
    expect(summary.casesCompleted).toBe(80);
    expect(summary.qaTested).toBe(60);
    expect(summary.spoAssigned).toBe(20);
    expect(summary.qaTestedRatio).toBe(0.6);
    expect(summary.progressRatio).toBe(0.8);
    expect(summary.casesRemaining).toBe(20);
  });
});

describe('validation rules', () => {
  it('rejects a negative SPO count', () => {
    const outcome = validateInputs(baseInputs({ casesCompleted: 10, spoAssigned: -5 }));
    expect(outcome.isValid).toBe(false);
    expect(outcome.errors.spoAssigned).toBe('errors.spoMin');
  });

  it('rejects SPO exceeding completed cases (no double-counting)', () => {
    const outcome = validateInputs(baseInputs({ casesCompleted: 10, spoAssigned: 11 }));
    expect(outcome.isValid).toBe(false);
    expect(outcome.errors.spoAssigned).toBe('errors.spoExceedsCompleted');
  });

  it('accepts SPO equal to completed cases (everything transferred)', () => {
    expect(validateInputs(baseInputs({ casesCompleted: 20, spoAssigned: 20 })).isValid).toBe(true);
  });

  it('rejects Pass exceeding the QA-tested remainder (SPO not merged into Pass)', () => {
    const outcome = validateInputs(baseInputs({ casesCompleted: 80, casesPassed: 50, spoAssigned: 35 }));
    expect(outcome.isValid).toBe(false);
    expect(outcome.errors.casesPassed).toBe('errors.passedExceedsTested');
  });

  it('keeps accepting pre-SPO payloads exactly as before (legacy equivalence)', () => {
    const legacy = baseInputs({ casesCompleted: 15, casesPassed: 11 });
    delete (legacy as Partial<QaInputs>).spoAssigned;
    const outcome = validateInputs(legacy);
    expect(outcome.isValid).toBe(true);
    expect(outcome.errors).toEqual({});
  });
});

describe('normalization and defaults', () => {
  it('normalizes a missing SPO field to 0', () => {
    const raw = { ...baseInputs({ casesCompleted: 15 }) };
    delete (raw as Partial<QaInputs>).spoAssigned;
    expect(normalizeQaInputs(raw).spoAssigned).toBe(0);
  });

  it('keeps an explicit SPO value untouched', () => {
    expect(normalizeQaInputs(baseInputs({ casesCompleted: 80, spoAssigned: 20 })).spoAssigned).toBe(20);
  });

  it('defaults new projects created through the V6.2 form to SPO = 0', () => {
    const form = { ...defaultNewProjectForm('2026-09-29'), name: 'P', totalCases: '436' };
    const validation = validateNewProjectForm(form);
    expect(validation.isValid).toBe(true);
    expect(validation.inputs!.spoAssigned).toBe(0);
    expect(buildProjectInputsFromForm(form).spoAssigned).toBe(0);
  });

  it('seeds daily-report activities with the current SPO count', () => {
    const state = appState(baseInputs({ casesCompleted: 80, spoAssigned: 20 }));
    const activities = seedAutoActivities('ja', state, '2026-09-29');
    expect(activities).toHaveLength(1);
    expect(activities[0].spoAssigned).toBe(20);
    expect(activities[0].completedCases).toBe(80);
  });
});

describe('persistence (localStorage reload)', () => {
  it('survives the app-state storage round-trip', () => {
    const state = appState(baseInputs({ casesCompleted: 80, casesPassed: 50, spoAssigned: 20 }));
    saveState(state);
    const reloaded = loadState();
    expect(reloaded.spoAssigned).toBe(20);
    expect(reloaded.casesCompleted).toBe(80);
    expect(reloaded.casesPassed).toBe(50);
  });

  it('survives the portfolio (reports) storage round-trip', () => {
    const record = project(baseInputs({ casesCompleted: 80, casesPassed: 50, spoAssigned: 20 }));
    const state: ReportsState = { ...defaultReportsState(), projects: [record], activeProjectId: record.id };
    saveReportsState(state);
    const reloaded = loadReportsState();
    expect(reloaded.projects[0].inputs.spoAssigned).toBe(20);
    expect(reloaded.projects[0].inputs.casesCompleted).toBe(80);
  });
});

describe('JSON export/import', () => {
  it('survives a full export/import round-trip', () => {
    const state = appState(baseInputs({ casesCompleted: 80, casesPassed: 50, spoAssigned: 20 }));
    const text = JSON.stringify(createExportPayload(state));
    const result = parseImportPayload(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.spoAssigned).toBe(20);
      expect(result.data.casesCompleted).toBe(80);
      expect(validateInputs(result.data).isValid).toBe(true);
    }
  });

  it('accepts legacy export files without the SPO field', () => {
    const state = appState(baseInputs({ casesCompleted: 15, casesPassed: 11 }));
    const payload = createExportPayload(state) as unknown as Record<string, unknown>;
    const data = payload.data as Record<string, unknown>;
    delete data.spoAssigned;
    const result = parseImportPayload(JSON.stringify(payload));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.spoAssigned).toBe(0);
  });
});

describe('legacy project compatibility', () => {
  it('loads pre-V6.3 projects with SPO = 0', () => {
    const legacy = JSON.parse(
      JSON.stringify({
        ...project(baseInputs({ casesCompleted: 15, casesPassed: 11 })),
        inputs: {
          totalCases: 100,
          currentTesters: 8,
          startTime: 780,
          targetFinish: 1020,
          lunchStart: 0,
          lunchEnd: 0,
          perHourPerTester: 4,
          casesCompleted: 15,
          casesPassed: 11,
          startDate: '2026-09-29',
          targetCompletionDate: '2026-09-29',
          targetCompletionTime: '17:00',
          planningRows: [{ id: 'row-1', date: '2026-09-29', plannedTesters: 8, absentTesters: 0, nonWorkingDay: false, note: '' }],
        },
      }),
    ) as ProjectRecord;
    const state: ReportsState = { ...defaultReportsState(), projects: [legacy] };
    saveReportsState(state);
    const reloaded = loadReportsState();
    expect(reloaded.projects[0].inputs.spoAssigned).toBe(0);
    expect(calculateExecutionCounts(reloaded.projects[0].inputs).qaTested).toBe(15);
  });

  it('keeps the demo state at SPO = 0', () => {
    expect(normalizeQaInputs(DEMO_STATE).spoAssigned).toBe(0);
  });
});

describe('project switching (write-back path)', () => {
  it('preserves each project\u2019s own SPO count through the canonical sync', () => {
    const a = project(baseInputs({ casesCompleted: 80, casesPassed: 50, spoAssigned: 20 }));
    const b = project(baseInputs({ totalCases: 200, casesCompleted: 40, casesPassed: 30, spoAssigned: 5 }));
    // Edit project A in the dashboard editing state (the app state IS project A).
    const editing = appState({ ...a.inputs, casesCompleted: 90, spoAssigned: 25 });
    const synced = applyActiveProjectSync([a, b], a.id, editing.projectNameEn, editing.projectNameJa, qaInputsFromAppState(editing), NOW_ISO);
    const syncedA = synced.find((p) => p.id === a.id)!;
    const syncedB = synced.find((p) => p.id === b.id)!;
    expect(syncedA.inputs.spoAssigned).toBe(25);
    expect(syncedA.inputs.casesCompleted).toBe(90);
    // The inactive project is untouched by reference and value.
    expect(syncedB).toBe(b);
    expect(syncedB.inputs.spoAssigned).toBe(5);
  });

  it('qaInputsFromAppState carries spoAssigned into the canonical inputs', () => {
    const extracted = qaInputsFromAppState(appState(baseInputs({ casesCompleted: 80, spoAssigned: 20 })));
    expect(extracted.spoAssigned).toBe(20);
    expect('language' in extracted).toBe(false);
  });
});

describe('manual planning overrides survive SPO changes', () => {
  it('keeps MANUAL daily-plan rows when SPO/completed counts change', () => {
    const inputs = baseInputs({
      totalCases: 436,
      targetCompletionDate: '2026-10-02',
      planningRows: [
        { id: 'row-1', date: '2026-09-29', plannedTesters: 8, absentTesters: 0, nonWorkingDay: false, note: '' },
        { id: 'row-2', date: '2026-09-30', plannedTesters: 8, absentTesters: 0, nonWorkingDay: false, note: '' },
      ],
      dailyTargetOverrides: [{ id: 'ovr-1', date: '2026-09-29', plannedExecute: 100, plannedPass: 90 }],
    });
    // Recording SPO assignments updates only the execution counters.
    const withSpo = normalizeQaInputs({ ...inputs, casesCompleted: 20, casesPassed: 0, spoAssigned: 20 });
    expect(withSpo.dailyTargetOverrides).toEqual(inputs.dailyTargetOverrides);
    const plan = generateDailyPlan(withSpo.planningRows, 4, 4, 436, 1, withSpo.dailyTargetOverrides ?? []);
    expect(plan[0].mode).toBe('MANUAL');
    expect(plan[0].plannedExecute).toBe(100);
    expect(plan[0].plannedPass).toBe(90);
    expect(plan[1].mode).toBe('AUTO');
  });
});

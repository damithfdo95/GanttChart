import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, QaInputs, ReportActivity, ReportsState } from '../types';
import {
  calculateExecutionCounts,
  composeGranularExecution,
  granularFromInputs,
  type GranularExecutionStatus,
} from '../lib/calculations/execution';
import { calculateExecutiveSummary } from '../lib/calculations/executive';
import { validateInputs } from '../lib/validation/validate';
import { normalizeQaInputs, saveState, loadState } from '../lib/storage/storage';
import { defaultReportsState, loadReportsState, saveReportsState } from '../lib/storage/reports';
import { createExportPayload, parseImportPayload } from '../lib/jsonio/jsonio';
import { createBackupPayload, parseBackupPayload } from '../lib/backup/backup';
import { createProjectBackupPayload, importProjectIntoRegistry, parseProjectBackupPayload } from '../lib/backup/projectBackup';
import { applyActiveProjectSync, qaInputsFromAppState } from '../domain/projects';
import { newProjectRecord } from '../domain/projects/lifecycle';
import { seedAutoActivities } from '../lib/reporting/drafts';
import { renderProgressSection } from '../lib/reporting/sections';
import { DEFAULT_PROGRESS_RULES } from '../lib/reporting/progress';
import { buildProjectInputsFromForm, defaultNewProjectForm, validateNewProjectForm } from '../lib/validation/newProjectForm';

/**
 * V6.4 — Granular execution status counts (Pass / Fail / N/A / SPO対応 /
 * Blocked / Retest / 質問中).
 *
 * Canonical composition (existing engine semantics, unchanged):
 *   casesCompleted = Pass + Fail + N/A + SPO対応
 *   QA Tested     = casesCompleted − spoAssigned = Pass + Fail + N/A
 *   QA Completed  = casesCompleted
 *   Remaining     = totalCases − casesCompleted
 *
 * Blocked / Retest / 質問中 are informational open-status tallies: they never
 * affect completion, remaining or schedule calculations, and may overlap.
 * All dates/times are deterministic.
 */

const NOW_ISO = '2026-09-29T09:00:00.000Z';
const NOW_MINUTES = 14 * 60;

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

/** The §13 acceptance project: 100 total, Pass 60 / Fail 5 / N/A 5 / SPO 20 / Blocked 3 / Retest 2 / 質問中 1. */
function baseInputs(overrides: Partial<QaInputs> = {}): QaInputs {
  return normalizeQaInputs({
    totalCases: 100,
    currentTesters: 8,
    startTime: 13 * 60,
    targetFinish: 17 * 60,
    lunchStart: 0,
    lunchEnd: 0,
    perHourPerTester: 4,
    casesCompleted: 90,
    casesPassed: 60,
    casesFailed: 5,
    casesNotApplicable: 5,
    spoAssigned: 20,
    casesBlocked: 3,
    casesRetest: 2,
    casesQuestioned: 1,
    targetPassRate: 1,
    startDate: '2026-09-29',
    targetCompletionDate: '2026-09-30',
    targetCompletionTime: '17:00',
    planningRows: [
      { id: 'row-1', date: '2026-09-29', plannedTesters: 8, absentTesters: 0, nonWorkingDay: false, note: '' },
      { id: 'row-2', date: '2026-09-30', plannedTesters: 8, absentTesters: 0, nonWorkingDay: false, note: '' },
    ],
    ...overrides,
  });
}

function appState(inputs: QaInputs): AppState {
  return {
    ...inputs,
    language: 'ja',
    projectNameEn: 'Granular Project',
    projectNameJa: '粒度プロジェクト',
    dashboardView: 'operator',
  };
}

function activity(overrides: Partial<ReportActivity> = {}): ReportActivity {
  return {
    id: 'act-1',
    source: 'AUTO',
    name: 'Android 4.1.0 R-can Sanity Testing',
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

describe('defaults', () => {
  it('normalizes all missing granular fields to 0', () => {
    const raw = baseInputs({ casesCompleted: 15, casesPassed: 11 });
    delete raw.casesFailed;
    delete raw.casesNotApplicable;
    delete raw.casesBlocked;
    delete raw.casesRetest;
    delete raw.casesQuestioned;
    const normalized = normalizeQaInputs(raw);
    expect(normalized.casesFailed).toBe(0);
    expect(normalized.casesNotApplicable).toBe(0);
    expect(normalized.casesBlocked).toBe(0);
    expect(normalized.casesRetest).toBe(0);
    expect(normalized.casesQuestioned).toBe(0);
  });

  it('new projects created through the form start with all granular counts at 0', () => {
    const form = { ...defaultNewProjectForm('2026-09-29'), name: 'P', totalCases: '436' };
    expect(validateNewProjectForm(form).isValid).toBe(true);
    const inputs = buildProjectInputsFromForm(form);
    expect(inputs.casesCompleted).toBe(0);
    expect(inputs.casesFailed).toBe(0);
    expect(inputs.casesNotApplicable).toBe(0);
    expect(inputs.casesBlocked).toBe(0);
    expect(inputs.casesRetest).toBe(0);
    expect(inputs.casesQuestioned).toBe(0);
  });

  it('legacy pre-V6.4 projects remain valid with zero defaults', () => {
    const legacy = baseInputs({ casesCompleted: 15, casesPassed: 11, spoAssigned: 0 });
    delete legacy.casesFailed;
    delete legacy.casesNotApplicable;
    delete legacy.casesBlocked;
    delete legacy.casesRetest;
    delete legacy.casesQuestioned;
    expect(validateInputs(legacy).isValid).toBe(true);
    const counts = calculateExecutionCounts(legacy);
    expect(counts.fail).toBe(0);
    expect(counts.notApplicable).toBe(0);
    // Missing historical values are never inferred.
    expect(counts.qaTested).toBe(15);
  });
});

describe('composition (Granular Inputs → Canonical QaInputs)', () => {
  it('composes casesCompleted = Pass + Fail + N/A + SPO対応', () => {
    const canonical = composeGranularExecution({
      pass: 60, fail: 5, notApplicable: 5, spo: 20, blocked: 3, retest: 2, questioned: 1,
    });
    expect(canonical.casesCompleted).toBe(90);
    expect(canonical.casesPassed).toBe(60);
    expect(canonical.casesFailed).toBe(5);
    expect(canonical.casesNotApplicable).toBe(5);
    expect(canonical.spoAssigned).toBe(20);
    expect(canonical.casesBlocked).toBe(3);
    expect(canonical.casesRetest).toBe(2);
    expect(canonical.casesQuestioned).toBe(1);
  });

  it('clamps negative and fractional inputs to non-negative integers', () => {
    const canonical = composeGranularExecution({
      pass: -5, fail: 2.7, notApplicable: 0, spo: 0, blocked: -1, retest: 0, questioned: 0,
    });
    expect(canonical.casesPassed).toBe(0);
    expect(canonical.casesFailed).toBe(3);
    expect(canonical.casesBlocked).toBe(0);
    expect(canonical.casesCompleted).toBe(3);
  });

  it('granularFromInputs reads the granular counts back from canonical state', () => {
    const granular = granularFromInputs(baseInputs());
    expect(granular).toEqual<GranularExecutionStatus>({
      pass: 60, fail: 5, notApplicable: 5, spo: 20, blocked: 3, retest: 2, questioned: 1,
    });
  });

  it('compose ∘ granular round trip is stable', () => {
    const roundTrip = granularFromInputs({ ...baseInputs(), ...composeGranularExecution(granularFromInputs(baseInputs())) });
    expect(roundTrip).toEqual(granularFromInputs(baseInputs()));
  });
});

describe('derived values (existing engine, extended breakdown)', () => {
  const counts = calculateExecutionCounts(baseInputs());

  it('Pass, Fail and N/A each contribute to QA Tested', () => {
    expect(counts.pass).toBe(60);
    expect(counts.fail).toBe(5);
    expect(counts.notApplicable).toBe(5);
    expect(counts.qaTested).toBe(70);
  });

  it('SPO対応 contributes to QA Completed but not QA Tested', () => {
    expect(counts.spoAssigned).toBe(20);
    expect(counts.qaCompleted).toBe(90);
    expect(counts.qaTested).toBe(70);
    expect(counts.qaTested).not.toBe(counts.qaCompleted);
  });

  it('exposes QA Tested / QA Completed / Remaining and both ratios', () => {
    expect(counts.qaTested).toBe(70);
    expect(counts.qaCompleted).toBe(90);
    expect(counts.remaining).toBe(10);
    expect(counts.qaTestedRatio).toBe(0.7);
    expect(counts.qaCompletedRatio).toBe(0.9);
  });

  it('matches the equivalent existing calculation qaTested = casesCompleted − spoAssigned', () => {
    const inputs = baseInputs();
    expect(counts.qaTested).toBe(inputs.casesCompleted - (inputs.spoAssigned ?? 0));
  });
});

describe('informational statuses (Blocked / Retest / 質問中)', () => {
  it('Blocked does not change Remaining', () => {
    expect(calculateExecutionCounts(baseInputs({ casesBlocked: 0 })).remaining).toBe(10);
    expect(calculateExecutionCounts(baseInputs({ casesBlocked: 50 })).remaining).toBe(10);
  });

  it('Retest does not change Remaining', () => {
    expect(calculateExecutionCounts(baseInputs({ casesRetest: 0 })).remaining).toBe(10);
    expect(calculateExecutionCounts(baseInputs({ casesRetest: 50 })).remaining).toBe(10);
  });

  it('質問中 does not change Remaining', () => {
    expect(calculateExecutionCounts(baseInputs({ casesQuestioned: 0 })).remaining).toBe(10);
    expect(calculateExecutionCounts(baseInputs({ casesQuestioned: 50 })).remaining).toBe(10);
  });

  it('does not change schedule calculations (executive summary identical)', () => {
    const without = calculateExecutiveSummary(baseInputs({ casesBlocked: 0, casesRetest: 0, casesQuestioned: 0 }), NOW_MINUTES);
    const withAll = calculateExecutiveSummary(baseInputs(), NOW_MINUTES);
    // V6.5 added the granular breakdown to the summary; the schedule math
    // itself must be identical — compare everything except those fields.
    const { pass: _p, fail: _f, notApplicable: _n, blocked: _b, retest: _r, questioned: _q, ...scheduleWith } = withAll;
    const { pass: _p2, fail: _f2, notApplicable: _n2, blocked: _b2, retest: _r2, questioned: _q2, ...scheduleWithout } = without;
    expect(scheduleWith).toEqual(scheduleWithout);
  });

  it('informational statuses can overlap without validation errors', () => {
    const overlapping = baseInputs({ casesBlocked: 30, casesRetest: 30, casesQuestioned: 30 });
    expect(validateInputs(overlapping).isValid).toBe(true);
    expect(calculateExecutionCounts(overlapping).remaining).toBe(10);
  });

  it('informational totals are never combined into Remaining', () => {
    const counts = calculateExecutionCounts(baseInputs());
    expect(counts.remaining).toBe(100 - 90);
    expect(counts.remaining).not.toBe(100 - 90 - 3 - 2 - 1);
  });
});

describe('validation', () => {
  it('rejects negative Fail', () => {
    const outcome = validateInputs(baseInputs({ casesFailed: -1 }));
    expect(outcome.isValid).toBe(false);
    expect(outcome.errors.casesFailed).toBe('errors.statusCountMin');
  });

  it('rejects negative N/A', () => {
    const outcome = validateInputs(baseInputs({ casesNotApplicable: -1 }));
    expect(outcome.errors.casesNotApplicable).toBe('errors.statusCountMin');
  });

  it('rejects negative Blocked', () => {
    const outcome = validateInputs(baseInputs({ casesBlocked: -1 }));
    expect(outcome.errors.casesBlocked).toBe('errors.statusCountMin');
  });

  it('rejects negative Retest', () => {
    const outcome = validateInputs(baseInputs({ casesRetest: -1 }));
    expect(outcome.errors.casesRetest).toBe('errors.statusCountMin');
  });

  it('rejects negative Questioned', () => {
    const outcome = validateInputs(baseInputs({ casesQuestioned: -1 }));
    expect(outcome.errors.casesQuestioned).toBe('errors.statusCountMin');
  });

  it('rejects Pass + Fail + N/A + SPO exceeding casesCompleted', () => {
    // 60 + 5 + 5 + 21 = 91 > 90
    const outcome = validateInputs(baseInputs({ spoAssigned: 21 }));
    expect(outcome.isValid).toBe(false);
    expect(outcome.errors.casesCompleted).toBe('errors.statusCountsExceedCompleted');
  });

  it('accepts the composition exactly equal to casesCompleted', () => {
    expect(validateInputs(baseInputs()).isValid).toBe(true);
    expect(validateInputs(baseInputs()).errors).toEqual({});
  });

  it('preserves existing validation precedence (passed > completed)', () => {
    const outcome = validateInputs(baseInputs({ casesCompleted: 62, casesPassed: 63 }));
    expect(outcome.errors.casesPassed).toBe('errors.passedExceedsCompleted');
    expect(outcome.errors.casesCompleted).toBe('errors.statusCountsExceedCompleted');
  });

  it('pre-V6.4 demo-style data (15/11, no granular fields) validates as before', () => {
    const legacy = baseInputs({
      totalCases: 36,
      casesCompleted: 15,
      casesPassed: 11,
      casesFailed: 0,
      casesNotApplicable: 0,
      spoAssigned: 0,
    });
    delete legacy.casesFailed;
    delete legacy.casesNotApplicable;
    delete legacy.casesBlocked;
    delete legacy.casesRetest;
    delete legacy.casesQuestioned;
    expect(validateInputs(legacy).errors).toEqual({});
  });
});

describe('persistence round trips', () => {
  it('survives localStorage (app state + portfolio)', () => {
    const state = appState(baseInputs());
    saveState(state);
    expect(loadState().casesFailed).toBe(5);
    expect(loadState().casesQuestioned).toBe(1);
    const record = newProjectRecord(baseInputs(), { nameEn: 'A', nameJa: 'A' }, NOW_ISO, []);
    const reports: ReportsState = { ...defaultReportsState(), projects: [record] };
    saveReportsState(reports);
    const reloaded = loadReportsState();
    expect(reloaded.projects[0].inputs.casesFailed).toBe(5);
    expect(reloaded.projects[0].inputs.casesBlocked).toBe(3);
  });

  it('survives JSON export/import', () => {
    const state = appState(baseInputs());
    const result = parseImportPayload(JSON.stringify(createExportPayload(state)));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.casesFailed).toBe(5);
      expect(result.data.casesNotApplicable).toBe(5);
      expect(result.data.casesRetest).toBe(2);
      expect(result.data.casesQuestioned).toBe(1);
      expect(validateInputs(result.data).isValid).toBe(true);
    }
  });

  it('survives project backup → import', () => {
    const project = newProjectRecord(baseInputs(), { nameEn: 'A', nameJa: 'A' }, NOW_ISO, []);
    const text = JSON.stringify(createProjectBackupPayload(project, [], NOW_ISO));
    const parsed = parseProjectBackupPayload(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const merged = importProjectIntoRegistry([], [], parsed.data);
    const restored = merged.importedProject.inputs;
    expect(restored.casesFailed).toBe(5);
    expect(restored.casesNotApplicable).toBe(5);
    expect(restored.casesBlocked).toBe(3);
    expect(restored.casesRetest).toBe(2);
    expect(restored.casesQuestioned).toBe(1);
    expect(restored.casesCompleted).toBe(90);
  });

  it('survives workspace backup → import', () => {
    const state = appState(baseInputs());
    const reports: ReportsState = {
      ...defaultReportsState(),
      projects: [newProjectRecord(baseInputs(), { nameEn: 'A', nameJa: 'A' }, NOW_ISO, [])],
    };
    const parsed = parseBackupPayload(JSON.stringify(createBackupPayload(state, reports)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.data.reportsState.projects[0].inputs.casesFailed).toBe(5);
      expect(parsed.data.reportsState.projects[0].inputs.casesQuestioned).toBe(1);
    }
  });

  it('survives project switching (write-back isolation)', () => {
    const a = newProjectRecord(baseInputs(), { nameEn: 'A', nameJa: 'A' }, NOW_ISO, []);
    const b = newProjectRecord(baseInputs({ casesFailed: 1, casesBlocked: 0 }), { nameEn: 'B', nameJa: 'B' }, NOW_ISO, [a]);
    const editing = appState({ ...a.inputs, casesFailed: 4 });
    const synced = applyActiveProjectSync([a, b], a.id, editing.projectNameEn, editing.projectNameJa, qaInputsFromAppState(editing), NOW_ISO);
    expect(synced.find((p) => p.id === a.id)!.inputs.casesFailed).toBe(4);
    expect(synced.find((p) => p.id === b.id)).toBe(b);
  });

  it('legacy backups without granular fields load with zero defaults (no inference)', () => {
    const state = appState(baseInputs({ casesCompleted: 15, casesPassed: 11, spoAssigned: 0 }));
    const payload = createBackupPayload(state, defaultReportsState()) as unknown as Record<string, unknown>;
    const data = payload.data as { appState: Record<string, unknown> };
    delete data.appState.casesFailed;
    delete data.appState.casesNotApplicable;
    delete data.appState.casesBlocked;
    delete data.appState.casesRetest;
    delete data.appState.casesQuestioned;
    // V7: a true legacy backup also predates the daily execution entries.
    delete data.appState.dailyExecuted;
    const parsed = parseBackupPayload(JSON.stringify(payload));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      // Import normalization fills the safe defaults; nothing is inferred.
      expect(parsed.data.appState.casesFailed).toBe(0);
      expect(calculateExecutionCounts(parsed.data.appState).fail).toBe(0);
      expect(calculateExecutionCounts(parsed.data.appState).qaTested).toBe(15);
    }
  });
});

describe('daily reports', () => {
  it('activity granular fields persist through the reports store', () => {
    const reports: ReportsState = { ...defaultReportsState() };
    const draft = {
      id: 'rep-1',
      reportDate: '2026-09-29',
      language: 'ja' as const,
      status: 'FINALIZED' as const,
      projectId: 'PRJ-001',
      revisionOf: null,
      jiraUrl: null,
      activities: [activity()],
      nextDay: [],
      previewText: '',
      createdBy: 'sup',
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
      finalizedAt: NOW_ISO,
      finalizedBy: 'sup',
      snapshot: null,
    };
    reports.reports.push(draft);
    saveReportsState(reports);
    const reloaded = loadReportsState();
    expect(reloaded.reports[0].activities[0].casesFailed).toBe(5);
    expect(reloaded.reports[0].activities[0].casesRetest).toBe(2);
    expect(reloaded.reports[0].activities[0].casesQuestioned).toBe(1);
    expect(reloaded.reports[0].activities[0].casesPassed).toBe(60);
  });

  it('legacy activities without the new fields still load (defaults apply at read time)', () => {
    const legacy = activity();
    delete legacy.casesPassed;
    delete legacy.casesFailed;
    delete legacy.casesRetest;
    delete legacy.casesQuestioned;
    const reports: ReportsState = { ...defaultReportsState() };
    reports.reports.push({
      id: 'rep-1',
      reportDate: '2026-09-29',
      language: 'ja',
      status: 'FINALIZED',
      projectId: 'PRJ-001',
      revisionOf: null,
      jiraUrl: null,
      activities: [legacy],
      nextDay: [],
      previewText: '',
      createdBy: 'sup',
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
      finalizedAt: NOW_ISO,
      finalizedBy: 'sup',
      snapshot: null,
    });
    saveReportsState(reports);
    expect(loadReportsState().reports[0].activities[0].casesFailed).toBeUndefined();
  });

  it('auto-seeded activities carry the granular values from project state', () => {
    const seeded = seedAutoActivities('ja', appState(baseInputs()), '2026-09-29');
    expect(seeded).toHaveLength(1);
    expect(seeded[0].completedCases).toBe(90);
    expect(seeded[0].casesPassed).toBe(60);
    expect(seeded[0].casesFailed).toBe(5);
    expect(seeded[0].notApplicableCases).toBe(5);
    expect(seeded[0].spoAssigned).toBe(20);
    expect(seeded[0].blockedCases).toBe(3);
    expect(seeded[0].casesRetest).toBe(2);
    expect(seeded[0].casesQuestioned).toBe(1);
  });

  it('report text includes non-zero status lines and omits zero ones', () => {
    const withStatuses = renderProgressSection('en', [activity()], DEFAULT_PROGRESS_RULES);
    expect(withStatuses).toContain('Fail: 5');
    expect(withStatuses).toContain('N/A: 5');
    expect(withStatuses).toContain('SPO assigned: 20');
    expect(withStatuses).toContain('Blocked: 3');
    expect(withStatuses).toContain('Retest: 2');
    expect(withStatuses).toContain('Question (質問中): 1');

    const clean = activity({
      casesFailed: 0, notApplicableCases: 0, spoAssigned: 0, blockedCases: 0, casesRetest: 0, casesQuestioned: 0,
    });
    const withoutStatuses = renderProgressSection('en', [clean], DEFAULT_PROGRESS_RULES);
    expect(withoutStatuses).not.toContain('Fail:');
    expect(withoutStatuses).not.toContain('Blocked:');
    expect(withoutStatuses).not.toContain('質問中');
  });
});

describe('end-to-end acceptance (§13)', () => {
  it('export → wipe → import preserves every granular value', () => {
    const project = newProjectRecord(baseInputs(), { nameEn: 'A', nameJa: 'A' }, NOW_ISO, []);
    const exportText = JSON.stringify(createProjectBackupPayload(project, [], NOW_ISO));
    storage.map.clear(); // wipe local state
    const parsed = parseProjectBackupPayload(exportText);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const merged = importProjectIntoRegistry([], [], parsed.data);
    const restored = merged.importedProject;
    const counts = calculateExecutionCounts(restored.inputs);

    expect(restored.projectId).toBe(project.projectId);
    expect(restored.inputs.totalCases).toBe(100);
    expect(counts.pass).toBe(60);
    expect(counts.fail).toBe(5);
    expect(counts.notApplicable).toBe(5);
    expect(counts.spoAssigned).toBe(20);
    expect(counts.blocked).toBe(3);
    expect(counts.retest).toBe(2);
    expect(counts.questioned).toBe(1);
    expect(counts.qaTested).toBe(70);
    expect(counts.qaCompleted).toBe(90);
    expect(counts.remaining).toBe(10);
    expect(counts.qaTestedRatio).toBe(0.7);
    expect(counts.qaCompletedRatio).toBe(0.9);
    expect(validateInputs(restored.inputs).isValid).toBe(true);
  });
});

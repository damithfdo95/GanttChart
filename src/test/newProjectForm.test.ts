import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROJECT_NAME_MAX_LENGTH,
  buildPlanningRows,
  buildProjectInputsFromForm,
  defaultNewProjectForm,
  validateNewProjectForm,
  type NewProjectForm as FormModel,
} from '../lib/validation/newProjectForm';
import { newProjectRecord } from '../domain/projects/lifecycle';
import { normalizeAppState, normalizeQaInputs, saveState, loadState } from '../lib/storage/storage';
import { defaultReportsState, loadReportsState, saveReportsState } from '../lib/storage/reports';
import { createExportPayload, parseImportPayload } from '../lib/jsonio/jsonio';
import { validateInputs } from '../lib/validation/validate';
import {
  calculateProductiveHours,
  calculateRequiredHours,
  calculateRequiredTesters,
  calculateTeamCapacity,
} from '../lib/calculations/capacity';
import { generateDailyPlan } from '../lib/calculations/dailyPlan';
import {
  WORK_DAY_END,
  WORK_DAY_START,
  WORK_LUNCH,
  WORK_PRODUCTIVE_HOURS,
  advanceOverWorkDays,
  workingEpochDays,
} from '../lib/calculations/workday';
import type { AppState, ProjectRecord, ReportsState } from '../types';

/**
 * V6.2 — New Project creation & initial planning tests (§26).
 * All dates are deterministic; no test reads the real clock.
 * The acceptance scenario (§31) is a single-day project:
 * 436 cases, 8 testers, 4 cases/h/tester, 2026-09-29, fixed workday
 * (9:00–17:30, lunch 12:00–13:00 → 7.5 productive hours/day).
 */

const START_DATE = '2026-09-29';
const NOW_ISO = '2026-09-29T09:00:00.000Z';

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

/** The §31 acceptance form: defaults already carry 8/4, todo, same-day target. */
function acceptanceForm(overrides: Partial<FormModel> = {}): FormModel {
  return {
    ...defaultNewProjectForm(START_DATE),
    name: 'Android 4.1.0 R-can Sanity Testing',
    totalCases: '436',
    ...overrides,
  };
}

function createRecord(form: FormModel = acceptanceForm()): ProjectRecord {
  const validation = validateNewProjectForm(form);
  expect(validation.isValid).toBe(true);
  return newProjectRecord(
    validation.inputs!,
    { nameEn: form.name.trim(), nameJa: form.name.trim(), status: form.status },
    NOW_ISO,
    [],
  );
}

function appStateFromRecord(record: ProjectRecord): AppState {
  return {
    ...normalizeQaInputs(record.inputs),
    language: 'ja',
    projectNameEn: record.nameEn,
    projectNameJa: record.nameJa,
    dashboardView: 'operator',
  };
}

describe('defaultNewProjectForm (§26.1, §20)', () => {
  it('defaults to status Scheduled (todo = created, not started)', () => {
    expect(defaultNewProjectForm(START_DATE).status).toBe('todo');
  });

  it('derives defaults from the DEMO_STATE configuration', () => {
    const form = defaultNewProjectForm(START_DATE);
    expect(form.currentTesters).toBe('8');
    expect(form.perHourPerTester).toBe('4');
    expect(form.startDate).toBe(START_DATE);
    expect(form.targetDate).toBe(START_DATE);
    expect(form.targetPassRate).toBe('100');
    expect(form.totalCases).toBe(''); // required — no silent default
    expect(form.name).toBe('');
  });
});

describe('project name (§26.2, §10)', () => {
  it('rejects an empty name', () => {
    const v = validateNewProjectForm(acceptanceForm({ name: '' }));
    expect(v.isValid).toBe(false);
    expect(v.errors.name).toBe('errors.projectNameRequired');
    expect(v.inputs).toBeNull();
  });

  it('rejects a whitespace-only name', () => {
    const v = validateNewProjectForm(acceptanceForm({ name: '   ' }));
    expect(v.isValid).toBe(false);
    expect(v.errors.name).toBe('errors.projectNameRequired');
  });

  it('rejects an over-long name', () => {
    const v = validateNewProjectForm(acceptanceForm({ name: 'x'.repeat(PROJECT_NAME_MAX_LENGTH + 1) }));
    expect(v.isValid).toBe(false);
    expect(v.errors.name).toBe('errors.projectNameTooLong');
  });

  it('accepts a name at the maximum length', () => {
    const v = validateNewProjectForm(acceptanceForm({ name: 'x'.repeat(PROJECT_NAME_MAX_LENGTH) }));
    expect(v.errors.name).toBeUndefined();
    expect(v.isValid).toBe(true);
  });
});

describe('total test cases (§26.3–4, §2)', () => {
  it('accepts a valid total', () => {
    const v = validateNewProjectForm(acceptanceForm());
    expect(v.isValid).toBe(true);
    expect(v.inputs!.totalCases).toBe(436);
  });

  it('rejects empty, text, fractional, infinite and negative values', () => {
    for (const totalCases of ['', 'abc', '1.5', 'Infinity', '-1']) {
      const v = validateNewProjectForm(acceptanceForm({ totalCases }));
      expect(v.isValid, `totalCases=${totalCases}`).toBe(false);
      expect(v.errors.totalCases, `totalCases=${totalCases}`).toBeDefined();
      expect(v.inputs).toBeNull();
    }
  });

  it('keeps the existing model behavior of allowing 0 cases', () => {
    const v = validateNewProjectForm(acceptanceForm({ totalCases: '0' }));
    expect(v.errors.totalCases).toBeUndefined();
    expect(v.isValid).toBe(true);
    expect(v.inputs!.totalCases).toBe(0);
  });
});

describe('tester count (§26.5, §3)', () => {
  it('accepts a valid tester count', () => {
    const v = validateNewProjectForm(acceptanceForm({ currentTesters: '8' }));
    expect(v.isValid).toBe(true);
    expect(v.inputs!.currentTesters).toBe(8);
  });

  it('rejects zero and negative testers via the shared rules', () => {
    for (const currentTesters of ['0', '-2']) {
      const v = validateNewProjectForm(acceptanceForm({ currentTesters }));
      expect(v.isValid, `testers=${currentTesters}`).toBe(false);
      expect(v.errors.currentTesters, `testers=${currentTesters}`).toBe('errors.testersMin');
    }
  });

  it('rejects non-integer and unparsable values', () => {
    for (const currentTesters of ['abc', '2.5', '']) {
      const v = validateNewProjectForm(acceptanceForm({ currentTesters }));
      expect(v.isValid, `testers=${currentTesters}`).toBe(false);
      expect(v.errors.currentTesters, `testers=${currentTesters}`).toBe('errors.numberInvalid');
    }
  });
});

describe('execution rate (§26.6, §4)', () => {
  it('accepts a valid rate', () => {
    const v = validateNewProjectForm(acceptanceForm({ perHourPerTester: '4' }));
    expect(v.isValid).toBe(true);
    expect(v.inputs!.perHourPerTester).toBe(4);
  });

  it('rejects zero, negative, empty and unparsable rates', () => {
    for (const perHourPerTester of ['0', '-1', '', 'abc', 'fast']) {
      const v = validateNewProjectForm(acceptanceForm({ perHourPerTester }));
      expect(v.isValid, `rate=${perHourPerTester}`).toBe(false);
      expect(v.errors.perHourPerTester, `rate=${perHourPerTester}`).toBeDefined();
    }
  });
});

describe('start date (§26.7, §5)', () => {
  it('parses the start date into the canonical inputs and applies the fixed workday', () => {
    const v = validateNewProjectForm(acceptanceForm());
    expect(v.inputs!.startDate).toBe(START_DATE);
    expect(v.inputs!.startTime).toBe(WORK_DAY_START);
    expect(v.inputs!.lunchStart).toBe(WORK_LUNCH.start);
    expect(v.inputs!.lunchEnd).toBe(WORK_LUNCH.end);
  });

  it('rejects an invalid calendar date', () => {
    const v = validateNewProjectForm(acceptanceForm({ startDate: '2026-02-30' }));
    expect(v.isValid).toBe(false);
    expect(v.errors.startDate).toBe('errors.dateInvalid');
  });

  it('rejects a malformed date format', () => {
    const v = validateNewProjectForm(acceptanceForm({ startDate: '29/09/2026' }));
    expect(v.errors.startDate).toBe('errors.dateInvalid');
  });

  it('rejects an empty date', () => {
    const v = validateNewProjectForm(acceptanceForm({ startDate: '' }));
    expect(v.errors.startDate).toBe('errors.dateRequired');
  });
});

describe('target finish (§26.8, §6)', () => {
  it('parses the target date into the canonical inputs with the fixed 17:30 work end', () => {
    const v = validateNewProjectForm(acceptanceForm());
    expect(v.inputs!.targetCompletionDate).toBe(START_DATE);
    expect(v.inputs!.targetCompletionTime).toBeNull();
    expect(v.inputs!.targetFinish).toBe(WORK_DAY_END);
  });

  it('rejects a target date before the start date', () => {
    const v = validateNewProjectForm(acceptanceForm({ targetDate: '2026-09-28' }));
    expect(v.isValid).toBe(false);
    expect(v.errors.targetDate).toBe('errors.targetDateBeforeStart');
  });
});

describe('multi-day projects (§26.9, §9)', () => {
  const multiDay = acceptanceForm({ targetDate: '2026-10-02' });

  it('accepts a later target date and generates one planning row per day', () => {
    const v = validateNewProjectForm(multiDay);
    expect(v.isValid).toBe(true);
    expect(v.inputs!.planningRows.map((r) => r.date)).toEqual([
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
    ]);
  });

  it('seeds each planning row with the current testers', () => {
    const rows = buildPlanningRows('2026-09-29', '2026-10-02', 8);
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.plannedTesters).toBe(8);
      expect(row.absentTesters).toBe(0);
      expect(row.nonWorkingDay).toBe(false);
    }
  });

  it('falls back to a single day when the target precedes the start', () => {
    expect(buildPlanningRows('2026-09-29', '2026-09-28', 8)).toHaveLength(1);
  });

  it('produces exactly one row for a same-day project', () => {
    expect(buildPlanningRows('2026-09-29', '2026-09-29', 8)).toHaveLength(1);
  });

  it('keeps every generated row structurally valid for the planning engine', () => {
    const v = validateNewProjectForm(multiDay);
    expect(v.inputs!.planningRows.every((row) => row.id !== '')).toBe(true);
    expect(v.inputs!.planningRows.every((row) => row.date > '')).toBe(true);
  });
});

describe('fixed workday (§26.10–12, §7)', () => {
  it('always applies the fixed 9:00–17:30 window with the 12:00–13:00 lunch', () => {
    const v = validateNewProjectForm(acceptanceForm());
    expect(v.isValid).toBe(true);
    expect(v.inputs!.startTime).toBe(9 * 60);
    expect(v.inputs!.targetFinish).toBe(17 * 60 + 30);
    expect(v.inputs!.lunchStart).toBe(12 * 60);
    expect(v.inputs!.lunchEnd).toBe(13 * 60);
  });

  it('yields 7.5 productive hours per day for the whole calculation', () => {
    expect(WORK_PRODUCTIVE_HOURS).toBe(7.5);
  });
});

describe('target pass rate (§26.13, §8)', () => {
  it('accepts 100 and maps it to the canonical 0–1 rate', () => {
    const v = validateNewProjectForm(acceptanceForm({ targetPassRate: '100' }));
    expect(v.isValid).toBe(true);
    expect(v.inputs!.targetPassRate).toBe(1);
  });

  it('accepts a value between 1 and 100', () => {
    const v = validateNewProjectForm(acceptanceForm({ targetPassRate: '50' }));
    expect(v.isValid).toBe(true);
    expect(v.inputs!.targetPassRate).toBe(0.5);
  });

  it('rejects out-of-range and unparsable values', () => {
    for (const targetPassRate of ['0', '101', 'abc', '-5']) {
      const v = validateNewProjectForm(acceptanceForm({ targetPassRate }));
      expect(v.isValid, `passRate=${targetPassRate}`).toBe(false);
      expect(v.errors.targetPassRate, `passRate=${targetPassRate}`).toBe('errors.passRateRange');
    }
  });
});

describe('calculation engine integration (§26.14–18, §31)', () => {
  // The form never calculates locally; these tests prove the canonical inputs
  // produced by the form drive the EXISTING engine to the expected values.
  const v = validateNewProjectForm(acceptanceForm());
  const inputs = v.inputs!;

  it('produces inputs that pass the existing validateInputs()', () => {
    expect(validateInputs(inputs).isValid).toBe(true);
  });

  it('derives team capacity 8 × 4 = 32 cases/hour', () => {
    expect(calculateTeamCapacity(inputs.currentTesters, inputs.perHourPerTester)).toBe(32);
  });

  it('derives 7.5 productive hours per day (9:00→17:30, lunch 12:00–13:00)', () => {
    expect(
      calculateProductiveHours(inputs.startTime, inputs.targetFinish, {
        start: inputs.lunchStart,
        end: inputs.lunchEnd,
      }),
    ).toBe(7.5);
  });

  it('derives required hours 436 / 32 = 13.625', () => {
    expect(calculateRequiredHours(inputs.totalCases, 32)).toBe(13.625);
  });

  it('derives required testers ceil(436 / (4 × 7.5)) = 15 for the single-day window', () => {
    expect(calculateRequiredTesters(inputs.totalCases, inputs.perHourPerTester, WORK_PRODUCTIVE_HOURS)).toBe(15);
  });

  it('derives the expected finish by walking the fixed workday calendar', () => {
    // 817.5 required minutes: day 1 fully consumed (450), the remaining
    // 367.5 minutes continue on the next calendar day 9:00 → 12:00 (180),
    // then 13:00 + 187.5 = 16:07:30.
    const requiredMinutes = calculateRequiredHours(inputs.totalCases, 32)! * 60;
    const workingDays = workingEpochDays(inputs.planningRows, inputs.startDate);
    expect(advanceOverWorkDays(requiredMinutes, workingDays, inputs.startDate)).toEqual({
      epochDay: workingDays[0] + 1,
      time: 967.5,
    });
  });
});

describe('initial daily plan (§26.19, §16)', () => {
  it('generates the AUTO single-day plan from the acceptance inputs', () => {
    const inputs = validateNewProjectForm(acceptanceForm()).inputs!;
    const plan = generateDailyPlan(inputs.planningRows, inputs.perHourPerTester, 4, inputs.totalCases, 1, []);
    expect(plan).toHaveLength(1);
    expect(plan[0].mode).toBe('AUTO');
    expect(plan[0].plannedExecute).toBe(128); // min(32 × 4, 436)
    expect(plan[0].cumulativeExecute).toBe(128);
  });

  it('spreads a multi-day project across the planning calendar', () => {
    const inputs = validateNewProjectForm(acceptanceForm({ targetDate: '2026-10-02' })).inputs!;
    const plan = generateDailyPlan(inputs.planningRows, inputs.perHourPerTester, 4, inputs.totalCases, 1, []);
    expect(plan).toHaveLength(4);
    expect(plan.map((r) => r.plannedExecute)).toEqual([128, 128, 128, 52]); // 436 total
    expect(plan[3].cumulativeExecute).toBe(436);
  });
});

describe('created project record (§26.24, §14, §15)', () => {
  const record = createRecord();

  it('creates the project as Scheduled with an audit-trail entry', () => {
    expect(record.status).toBe('todo');
    expect(record.statusHistory).toEqual([{ status: 'todo', changedAt: NOW_ISO }]);
    expect(record.completedAt).toBeNull();
    expect(record.completedBy).toBeNull();
  });

  it('assigns a stable unique project id', () => {
    expect(record.projectId).toBe('PRJ-001');
    const second = newProjectRecord(record.inputs, { nameEn: 'B', nameJa: 'B' }, NOW_ISO, [record]);
    expect(second.projectId).toBe('PRJ-002');
    expect(second.id).not.toBe(record.id);
  });

  it('contains no fabricated execution progress', () => {
    expect(record.inputs.casesCompleted).toBe(0);
    expect(record.inputs.casesPassed).toBe(0);
    expect(record.inputs.dailyActuals).toEqual([]);
    expect(record.inputs.blockingEvents).toEqual([]);
    expect(record.inputs.dailyTargetOverrides).toEqual([]);
  });

  it('initializes optional records with the existing defaults', () => {
    expect(record.inputs.milestones).toHaveLength(6);
    expect(record.inputs.targetPassRate).toBe(1);
    expect(record.inputs.planningRows).toHaveLength(1);
    expect(validateInputs(record.inputs).isValid).toBe(true);
  });

  it('keeps the canonical inputs as the single source of truth (no duplicate fields)', () => {
    const inputs = record.inputs;
    expect(inputs.totalCases).toBe(436);
    expect(inputs.currentTesters).toBe(8);
    expect(inputs.perHourPerTester).toBe(4);
    const keys = Object.keys(inputs as unknown as Record<string, unknown>);
    expect(keys.some((key) => key.startsWith('newProject'))).toBe(false);
  });
});

describe('persistence and reload (§26.20–21, §25)', () => {
  it('persists and reloads the created project through the app state store', () => {
    const record = createRecord();
    const appState = appStateFromRecord(record);
    saveState(appState);
    // V7: the created project has no execution yet, so the load-time
    // migration adds only the (empty) daily execution model.
    const loaded = loadState();
    expect(loaded.totalCases).toBe(appState.totalCases);
    expect(loaded.currentTesters).toBe(appState.currentTesters);
    expect(loaded.casesCompleted).toBe(0);
    expect(loaded.dailyExecuted).toEqual([]);
    expect(loaded.intervalEnabled).toBe(true);
    expect(loaded.planningRows).toEqual(appState.planningRows);
  });

  it('persists and reloads the created project through the portfolio store', () => {
    const record = createRecord();
    const state: ReportsState = { ...defaultReportsState(), projects: [record], activeProjectId: record.id };
    saveReportsState(state);
    const reloaded = loadReportsState();
    expect(reloaded.projects).toHaveLength(1);
    expect(reloaded.projects[0]).toEqual(record);
    expect(reloaded.activeProjectId).toBe(record.id);
  });
});

describe('JSON export/import round-trip (§26.22, §25)', () => {
  it('round-trips a project created from the form through the export envelope', () => {
    const appState = appStateFromRecord(createRecord());
    const text = JSON.stringify(createExportPayload(appState));
    const result = parseImportPayload(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual(normalizeAppState(appState));
    }
  });
});

describe('legacy project compatibility (§26.23, §25)', () => {
  it('loads a pre-V6.2 project record without the new optional fields', () => {
    const record = createRecord();
    const legacy = JSON.parse(
      JSON.stringify({
        ...record,
        description: undefined,
        owner: undefined,
        inputs: {
          totalCases: record.inputs.totalCases,
          currentTesters: record.inputs.currentTesters,
          startTime: record.inputs.startTime,
          targetFinish: record.inputs.targetFinish,
          lunchStart: record.inputs.lunchStart,
          lunchEnd: record.inputs.lunchEnd,
          perHourPerTester: record.inputs.perHourPerTester,
          casesCompleted: record.inputs.casesCompleted,
          startDate: record.inputs.startDate,
          targetCompletionDate: record.inputs.targetCompletionDate,
          targetCompletionTime: record.inputs.targetCompletionTime,
          planningRows: record.inputs.planningRows,
        },
      }),
    ) as ProjectRecord;
    const state: ReportsState = { ...defaultReportsState(), projects: [legacy] };
    saveReportsState(state);
    const reloaded = loadReportsState();
    expect(reloaded.projects).toHaveLength(1);
    expect(reloaded.projects[0].inputs.casesPassed).toBe(0);
    expect(reloaded.projects[0].inputs.targetPassRate).toBe(1);
    expect(reloaded.projects[0].inputs.dailyActuals).toEqual([]);
    expect(reloaded.projects[0].inputs.milestones).toHaveLength(6);
    expect(validateInputs(reloaded.projects[0].inputs).isValid).toBe(true);
  });
});

describe('manual daily-plan overrides survive recalculation (§26.25, §23)', () => {
  it('keeps MANUAL rows authoritative while AUTO rows follow parameter changes', () => {
    const inputs = validateNewProjectForm(acceptanceForm({ targetDate: '2026-10-02' })).inputs!;
    const overrides = [{ id: 'ovr-1', date: '2026-09-29', plannedExecute: 100, plannedPass: 90 }];
    const before = generateDailyPlan(inputs.planningRows, 4, 4, 436, 1, overrides);
    expect(before[0].mode).toBe('MANUAL');
    expect(before[0].plannedExecute).toBe(100);
    expect(before[0].plannedPass).toBe(90);

    // Simulate a planning-relevant edit: execution rate 4 → 5.
    const after = generateDailyPlan(inputs.planningRows, 5, 4, 436, 1, overrides);
    expect(after[0].mode).toBe('MANUAL');
    expect(after[0].plannedExecute).toBe(100);
    expect(after[0].plannedPass).toBe(90);
    expect(after[1].mode).toBe('AUTO');
    expect(after[1].plannedExecute).toBe(160); // 5 × 4 × 8 = 160
  });
});

describe('acceptance scenario (§31)', () => {
  const record = createRecord();
  const inputs = record.inputs;

  it('creates the project with every planned value derived from canonical state', () => {
    expect(record.nameEn).toBe('Android 4.1.0 R-can Sanity Testing');
    expect(record.status).toBe('todo');
    expect(inputs.totalCases).toBe(436);
    expect(inputs.currentTesters).toBe(8);
    expect(inputs.perHourPerTester).toBe(4);
    expect(inputs.startTime).toBe(WORK_DAY_START);
    expect(inputs.targetFinish).toBe(WORK_DAY_END);
    expect(inputs.startDate).toBe(START_DATE);
    expect(inputs.targetCompletionDate).toBe(START_DATE);
    expect(inputs.targetCompletionTime).toBeNull();
    expect(inputs.lunchStart).toBe(WORK_LUNCH.start);
    expect(inputs.lunchEnd).toBe(WORK_LUNCH.end);
  });

  it('produces a working planned timeline, daily plan and valid engine inputs immediately', () => {
    expect(inputs.planningRows).toHaveLength(1);
    expect(generateDailyPlan(inputs.planningRows, 4, 4, 436, 1, [])).toHaveLength(1);
    expect(validateInputs(inputs).isValid).toBe(true);
    expect(inputs.casesCompleted).toBe(0);
    expect(inputs.casesPassed).toBe(0);
  });
});

describe('buildProjectInputsFromForm totality (§21)', () => {
  it('falls back to neutral defaults for unparsable values instead of throwing', () => {
    const inputs = buildProjectInputsFromForm({ ...acceptanceForm(), totalCases: 'x', currentTesters: 'y' });
    expect(Number.isFinite(inputs.totalCases)).toBe(true);
    expect(Number.isFinite(inputs.currentTesters)).toBe(true);
    expect(inputs.casesCompleted).toBe(0);
  });
});

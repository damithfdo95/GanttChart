import { describe, expect, it } from 'vitest';
import { validateInputs } from '../lib/validation/validate';
import { DEMO_STATE } from '../lib/storage/storage';
import { createExportPayload, parseImportPayload } from '../lib/jsonio/jsonio';
import {
  calculateProductiveHours,
  calculateRequiredHours,
  calculateRequiredTesters,
  calculateTeamCapacity,
} from '../lib/calculations/capacity';
import { calculateExpectedFinish } from '../lib/calculations/schedule';
import { formatClock } from '../lib/formatting/format';
import type { QaInputs } from '../types';

function inputs(overrides: Partial<QaInputs>): QaInputs {
  const demo: QaInputs = {
    ...DEMO_STATE,
  };
  return { ...demo, ...overrides };
}

describe('validateInputs (§24)', () => {
  it('accepts the demo state (fixed workday lunch inside the work window)', () => {
    const outcome = validateInputs(inputs({}));
    expect(outcome.errors).toEqual({});
    expect(outcome.isValid).toBe(true);
  });

  it('accepts a real lunch inside the work window', () => {
    const outcome = validateInputs(inputs({ lunchStart: 13 * 60 + 30, lunchEnd: 14 * 60 + 30 }));
    expect(outcome.isValid).toBe(true);
  });

  it('rejects negative total cases', () => {
    expect(validateInputs(inputs({ totalCases: -1 })).errors.totalCases).toBeDefined();
  });

  it('rejects zero testers (>= 1 required)', () => {
    expect(validateInputs(inputs({ currentTesters: 0 })).errors.currentTesters).toBeDefined();
  });

  it('rejects zero productivity (> 0 required)', () => {
    expect(validateInputs(inputs({ perHourPerTester: 0 })).errors.perHourPerTester).toBeDefined();
  });

  it('rejects negative completed cases', () => {
    expect(validateInputs(inputs({ casesCompleted: -5 })).errors.casesCompleted).toBeDefined();
  });

  it('rejects completed > total', () => {
    expect(validateInputs(inputs({ casesCompleted: 37 })).errors.casesCompleted).toBeDefined();
  });

  it('accepts completed = total', () => {
    expect(validateInputs(inputs({ casesCompleted: 36 })).isValid).toBe(true);
  });

  it('rejects target before start', () => {
    expect(validateInputs(inputs({ targetFinish: 539 })).errors.targetFinish).toBeDefined();
  });

  it('accepts target equal to start (lunch fits inside)', () => {
    expect(validateInputs(inputs({ targetFinish: 780 })).isValid).toBe(true);
  });

  it('rejects an inverted lunch window (end < start)', () => {
    expect(validateInputs(inputs({ lunchStart: 14 * 60, lunchEnd: 13 * 60 })).errors.lunchEnd).toBeDefined();
  });

  it('treats equal lunch start/end (not only 0/0) as no lunch', () => {
    expect(validateInputs(inputs({ lunchStart: 12 * 60, lunchEnd: 12 * 60 })).isValid).toBe(true);
  });

  it('rejects a lunch window outside the work window', () => {
    expect(validateInputs(inputs({ lunchStart: 8 * 60, lunchEnd: 8 * 60 + 30 })).errors.lunchStart).toBeDefined();
  });

  it('rejects a plan start time after the lunch start', () => {
    expect(validateInputs(inputs({ startTime: 13 * 60 })).errors.startTime).toBe('errors.startAfterLunch');
  });

  it('accepts a plan start time at the lunch start', () => {
    expect(validateInputs(inputs({ startTime: 12 * 60 })).isValid).toBe(true);
  });

  it('collects multiple errors at once', () => {
    const outcome = validateInputs(inputs({ currentTesters: 0, casesCompleted: 99 }));
    expect(Object.keys(outcome.errors).sort()).toEqual(['casesCompleted', 'currentTesters']);
  });
});

describe('validateInputs Level 2 fields (§24 + V5)', () => {
  it('rejects negative passed cases', () => {
    expect(validateInputs(inputs({ casesPassed: -1 })).errors.casesPassed).toBe('errors.passedMin');
  });

  it('rejects passed > completed', () => {
    expect(validateInputs(inputs({ casesPassed: 16 })).errors.casesPassed).toBe('errors.passedExceedsCompleted');
  });

  it('accepts passed = completed', () => {
    expect(validateInputs(inputs({ casesPassed: 15 })).isValid).toBe(true);
  });

  it('rejects out-of-range target pass rates', () => {
    expect(validateInputs(inputs({ targetPassRate: 0 })).errors.targetPassRate).toBe('errors.passRateRange');
    expect(validateInputs(inputs({ targetPassRate: 1.5 })).errors.targetPassRate).toBe('errors.passRateRange');
  });

  it('accepts a fractional target pass rate', () => {
    expect(validateInputs(inputs({ targetPassRate: 0.9 })).isValid).toBe(true);
  });

  it('pre-Level-2 payloads without the new fields stay valid (defaults)', () => {
    const legacy = inputs({});
    delete (legacy as Partial<typeof legacy>).casesPassed;
    delete (legacy as Partial<typeof legacy>).targetPassRate;
    expect(validateInputs(legacy).isValid).toBe(true);
  });
});

describe('demo data (§26)', () => {
  it('matches the specified initial state', () => {
    expect(DEMO_STATE.totalCases).toBe(36);
    expect(DEMO_STATE.currentTesters).toBe(8);
    expect(DEMO_STATE.startTime).toBe(9 * 60); // fixed workday 9:00–17:30
    expect(DEMO_STATE.targetFinish).toBe(17 * 60 + 30);
    expect(DEMO_STATE.lunchStart).toBe(12 * 60); // lunch 12:00–13:00
    expect(DEMO_STATE.lunchEnd).toBe(13 * 60);
    expect(DEMO_STATE.perHourPerTester).toBe(4);
    expect(DEMO_STATE.casesCompleted).toBe(15);
  });

  it('defaults to Japanese (§20)', () => {
    expect(DEMO_STATE.language).toBe('ja');
  });

  it('produces the documented derived values', () => {
    const lunch = { start: DEMO_STATE.lunchStart, end: DEMO_STATE.lunchEnd };
    const capacityPerHour = calculateTeamCapacity(DEMO_STATE.currentTesters, DEMO_STATE.perHourPerTester);
    const productiveHours = calculateProductiveHours(DEMO_STATE.startTime, DEMO_STATE.targetFinish, lunch);
    const requiredHours = calculateRequiredHours(DEMO_STATE.totalCases, capacityPerHour);

    expect(capacityPerHour).toBe(32); // 8 × 4
    expect(productiveHours).toBe(7.5); // 17:30 − 9:00 − 1h lunch
    expect(capacityPerHour * productiveHours).toBe(240); // team capacity/day
    expect(calculateRequiredTesters(DEMO_STATE.totalCases, DEMO_STATE.perHourPerTester, productiveHours)).toBe(2);
    expect(requiredHours).toBe(1.125); // 36 / 32
    expect(DEMO_STATE.totalCases - DEMO_STATE.casesCompleted).toBe(21); // remaining

    const requiredMinutes = requiredHours === null ? null : requiredHours * 60;
    const expectedFinish = requiredMinutes === null ? null : calculateExpectedFinish(DEMO_STATE.startTime, requiredMinutes, lunch);
    expect(expectedFinish).toBe(9 * 60 + 67.5); // 10:07:30
    expect(formatClock(expectedFinish)).toBe('10:07'); // floored for display
  });

  it('exports and re-imports the demo state (fixed lunch survives the round trip)', () => {
    const payload = createExportPayload(DEMO_STATE);
    const result = parseImportPayload(JSON.stringify(payload));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.totalCases).toBe(36);
      expect(result.data.lunchStart).toBe(12 * 60);
      expect(result.data.lunchEnd).toBe(13 * 60);
      expect(result.data.language).toBe('ja');
    }
  });

  it('imports pre-Level-2 export files and backfills the new fields', () => {
    const legacy: Record<string, unknown> = { ...DEMO_STATE };
    delete legacy.casesPassed;
    delete legacy.targetPassRate;
    delete legacy.dailyTargetOverrides;
    delete legacy.dailyActuals;
    delete legacy.blockingEvents;
    delete legacy.milestones;
    const result = parseImportPayload(JSON.stringify({ app: 'ganttchart', version: 2, exportedAt: '2026-09-29T00:00:00.000Z', data: legacy }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.casesPassed).toBe(0);
      expect(result.data.targetPassRate).toBe(1);
      expect(result.data.dailyTargetOverrides).toEqual([]);
      expect(result.data.blockingEvents).toEqual([]);
      expect(result.data.milestones).toHaveLength(6); // seeded default milestone set
    }
  });
});

describe('sanity upper bounds', () => {
  it('rejects totals and tester counts above the limits, accepts the limits', () => {
    expect(validateInputs(inputs({ totalCases: 1_000_001 })).errors.totalCases).toBe('errors.totalCasesMax');
    expect(validateInputs(inputs({ totalCases: 1_000_000 })).errors.totalCases).toBeUndefined();
    expect(validateInputs(inputs({ currentTesters: 1_001 })).errors.currentTesters).toBe('errors.testersMax');
    expect(validateInputs(inputs({ currentTesters: 1_000 })).errors.currentTesters).toBeUndefined();
  });
});

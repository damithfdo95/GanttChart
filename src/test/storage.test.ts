import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatDate, todayEpochDays } from '../lib/dates/dates';
import { DEMO_STATE, isAppState, isLegacyAppState, loadState, migrateLegacyState, saveState } from '../lib/storage/storage';

const V2_KEY = 'ganttchart.v2';
const V1_KEY = 'ganttchart.v1';

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

const LEGACY = {
  totalCases: 80,
  currentTesters: 3,
  startTime: 540,
  targetFinish: 1020,
  lunchStart: 720,
  lunchEnd: 780,
  perHourPerTester: 3,
  casesCompleted: 10,
  language: 'en' as const,
};

describe('storage migration v1 → v2', () => {
  it('returns demo state when nothing is stored', () => {
    const state = loadState();
    expect(state.language).toBe('ja'); // Japanese default (§20)
    expect(state.totalCases).toBe(36); // §26 demo data
    expect(state.planningRows.length).toBe(5);
  });

  it('migrates v1 data, writes the v2 key and removes the v1 key', () => {
    storage.setItem(V1_KEY, JSON.stringify(LEGACY));
    const state = loadState();
    expect(state.totalCases).toBe(80);
    expect(state.currentTesters).toBe(3);
    expect(state.language).toBe('en');
    const today = formatDate(todayEpochDays());
    expect(state.startDate).toBe(today);
    expect(state.targetCompletionDate).toBe(today);
    expect(state.targetCompletionTime).toBe('17:00');
    expect(state.planningRows.length).toBe(1);
    expect(state.planningRows[0].plannedTesters).toBe(3);
    expect(state.planningRows[0].date).toBe(today);
    expect(state.planningRows[0].nonWorkingDay).toBe(false);
    expect(storage.getItem(V1_KEY)).toBeNull();
    expect(storage.getItem(V2_KEY)).not.toBeNull();
    expect(isAppState(JSON.parse(storage.getItem(V2_KEY)!))).toBe(true);
  });

  it('keeps the v1 key when the migrated v2 copy cannot be written (quota)', () => {
    storage.setItem(V1_KEY, JSON.stringify(LEGACY));
    const realSetItem = storage.setItem.bind(storage);
    storage.setItem = (key: string, value: string): void => {
      if (key === V2_KEY) throw new Error('QuotaExceededError');
      realSetItem(key, value);
    };
    const state = loadState();
    expect(state.totalCases).toBe(80); // still usable in memory
    expect(storage.getItem(V2_KEY)).toBeNull();
    expect(JSON.parse(storage.getItem(V1_KEY)!)).toEqual(LEGACY); // original data preserved
  });

  it('prefers valid v2 data over v1 data', () => {
    storage.setItem(V2_KEY, JSON.stringify({ ...DEMO_STATE, totalCases: 55 }));
    storage.setItem(V1_KEY, JSON.stringify(LEGACY));
    const state = loadState();
    expect(state.totalCases).toBe(55);
    expect(storage.getItem(V1_KEY)).not.toBeNull(); // untouched
  });

  it('falls back to v1 when the v2 payload is corrupted', () => {
    storage.setItem(V2_KEY, '{not json');
    storage.setItem(V1_KEY, JSON.stringify(LEGACY));
    const state = loadState();
    expect(state.totalCases).toBe(80);
    expect(state.planningRows.length).toBe(1);
  });

  it('falls back to demo when both keys are unusable', () => {
    storage.setItem(V2_KEY, '[]');
    storage.setItem(V1_KEY, 'garbage');
    const state = loadState();
    expect(state.totalCases).toBe(DEMO_STATE.totalCases);
    expect(state.planningRows.length).toBe(5);
  });
});

describe('saveState / loadState round-trip', () => {
  it('persists raw v2 state and loads it in the migrated V7 form (invariant-preserving)', () => {
    const state = { ...DEMO_STATE, totalCases: 42, targetCompletionTime: '16:00', dailyOvertimeMinutes: 0 };
    saveState(state);
    const loaded = loadState();
    expect(loaded.totalCases).toBe(42);
    expect(loaded.targetCompletionTime).toBe('16:00');
    expect(loaded.language).toBe(state.language);
    expect(loaded.projectNameEn).toBe(state.projectNameEn);
    // V7: a legacy payload loads as daily execution entries; the canonical
    // cumulative totals are preserved exactly (Σ entries).
    expect(loaded.intervalEnabled).toBe(true);
    expect(loaded.casesCompleted).toBe(state.casesCompleted);
    expect(loaded.casesPassed).toBe(state.casesPassed);
    expect(loaded.dailyExecuted).toHaveLength(1);
    expect(loaded.dailyExecuted![0].pass).toBe(state.casesPassed ?? 0);
    expect(loaded.dailyExecuted![0].uncategorizedCompleted).toBe(state.casesCompleted - (state.casesPassed ?? 0));
  });
});

describe('shape guards', () => {
  it('isLegacyAppState accepts v1 shapes and rejects broken ones', () => {
    expect(isLegacyAppState(LEGACY)).toBe(true);
    expect(isLegacyAppState({ ...LEGACY, language: 'fr' })).toBe(false);
    expect(isLegacyAppState({ totalCases: 1 })).toBe(false);
    expect(isLegacyAppState(null)).toBe(false);
  });

  it('isAppState rejects shapes missing planning data', () => {
    expect(isAppState({ ...DEMO_STATE, planningRows: [] })).toBe(false);
    expect(isAppState(LEGACY)).toBe(false);
    expect(isAppState({ ...DEMO_STATE, targetCompletionTime: 1700 })).toBe(false);
  });
});

describe('migrateLegacyState', () => {
  it('derives a single-day plan from v1 inputs and keeps every v1 field', () => {
    const migrated = migrateLegacyState(LEGACY);
    expect(migrated.casesCompleted).toBe(10);
    expect(migrated.perHourPerTester).toBe(3);
    expect(migrated.targetCompletionTime).toBe('17:00');
    expect(migrated.planningRows.length).toBe(1);
    expect(migrated.planningRows[0].id).not.toBe('');
    expect(migrated.planningRows[0].plannedTesters).toBe(3);
    expect(migrated.planningRows[0].absentTesters).toBe(0);
    expect(migrated.planningRows[0].nonWorkingDay).toBe(false);
    expect(migrated.planningRows[0].note).toBe('');
  });
});

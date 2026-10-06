import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, QaInputs, ReportsState, TesterDailyPerformance, TesterProjectAssignment, TesterReview } from '../types';
import { DEMO_STATE, isAppState, isTesterDailyPerformance, loadState, normalizeQaInputs, saveState } from '../lib/storage/storage';
import {
  defaultReportsState,
  isReportsState,
  isTesterProjectAssignment,
  isTesterReview,
  loadReportsState,
  saveReportsState,
} from '../lib/storage/reports';
import { createBackupPayload, parseBackupPayload } from '../lib/backup/backup';
import { upsertTesterDailyPerformance } from '../domain/performance';

/**
 * V6.7 — Persistence & backward compatibility: new source metadata,
 * workspace-level assignments/reviews, legacy V6.6 data loading, full backup
 * round-trips and JSON export/import.
 */

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

function assignment(overrides: Partial<TesterProjectAssignment> = {}): TesterProjectAssignment {
  return {
    id: 'assign-1',
    projectId: 'PRJ-001',
    testerName: 'Tanaka',
    startDate: '2026-09-01',
    active: true,
    ...overrides,
  };
}

function review(overrides: Partial<TesterReview> = {}): TesterReview {
  return {
    id: 'review-1',
    testerName: 'Tanaka',
    periodType: 'h2',
    periodStart: '2026-07-01',
    periodEnd: '2026-12-31',
    status: 'draft',
    summaryNote: 'Steady contributor',
    createdAt: '2026-12-20T00:00:00.000Z',
    updatedAt: '2026-12-20T00:00:00.000Z',
    ...overrides,
  };
}

// ---- Shape guards ---------------------------------------------------------------

describe('V6.7 shape guards', () => {
  it('accepts tester daily records with and without a source; rejects invalid sources', () => {
    const base = { id: 'r1', date: '2026-09-10', testerName: 'Sato', projectId: 'PRJ-001', casesTested: 5 };
    expect(isTesterDailyPerformance(base)).toBe(true); // legacy record without source
    expect(isTesterDailyPerformance({ ...base, source: 'automatic' })).toBe(true);
    expect(isTesterDailyPerformance({ ...base, source: 'assisted' })).toBe(true);
    expect(isTesterDailyPerformance({ ...base, source: 'manual' })).toBe(true);
    expect(isTesterDailyPerformance({ ...base, source: 'manualOverride' })).toBe(true);
    expect(isTesterDailyPerformance({ ...base, source: 'guessed' })).toBe(false);
  });

  it('validates tester assignments', () => {
    expect(isTesterProjectAssignment(assignment())).toBe(true);
    expect(isTesterProjectAssignment(assignment({ endDate: '2026-12-31', team: 'PrV' }))).toBe(true);
    expect(isTesterProjectAssignment(assignment({ active: 'yes' as unknown as boolean }))).toBe(false);
    expect(isTesterProjectAssignment(assignment({ startDate: 20260901 as unknown as string }))).toBe(false);
    expect(isTesterProjectAssignment(assignment({ testerName: '' }))).toBe(true); // shape-only; UI validates emptiness
  });

  it('validates tester reviews', () => {
    expect(isTesterReview(review())).toBe(true);
    expect(isTesterReview(review({ periodType: 'h1', status: 'completed', supervisorNote: 'x' }))).toBe(true);
    expect(isTesterReview(review({ periodType: 'quarter' as unknown as TesterReview['periodType'] }))).toBe(false);
    expect(isTesterReview(review({ status: 'approved' as unknown as TesterReview['status'] }))).toBe(false);
    expect(isTesterReview(review({ createdAt: null as unknown as string }))).toBe(false);
  });
});

// ---- Normalization & legacy loading ----------------------------------------------

describe('V6.7 normalization & legacy data', () => {
  it('keeps V6.6 records valid in the app-state shape check, with or without source', () => {
    const state: AppState = {
      ...DEMO_STATE,
      testerDailyPerformance: [
        { id: 'r1', date: '2026-09-10', testerName: 'Sato', projectId: 'PRJ-001', casesTested: 12 },
        { id: 'r2', date: '2026-09-10', testerName: 'Kim', projectId: 'PRJ-001', casesTested: 8, source: 'assisted' },
      ],
    };
    expect(isAppState(state)).toBe(true);
    const normalized = normalizeQaInputs(state);
    expect(normalized.testerDailyPerformance).toHaveLength(2);
    // Legacy records are NOT rewritten with a default source (§10).
    expect(normalized.testerDailyPerformance![0].source).toBeUndefined();
    expect(normalized.testerDailyPerformance![1].source).toBe('assisted');
  });

  it('drops records with an invalid source on normalize', () => {
    const inputs = {
      ...DEMO_STATE,
      testerDailyPerformance: [
        { id: 'ok', date: '2026-09-10', testerName: 'Sato', projectId: 'PRJ-001', casesTested: 1, source: 'manual' },
        { id: 'bad', date: '2026-09-10', testerName: 'Sato', projectId: 'PRJ-001', casesTested: 1, source: 'dream' },
      ],
    } as unknown as QaInputs;
    expect(normalizeQaInputs(inputs).testerDailyPerformance).toHaveLength(1);
  });

  it('normalizes a legacy V6.6 reports state (no assignments/reviews) to empty arrays', () => {
    const legacy = { ...defaultReportsState(), testerAssignments: undefined, reviews: undefined } as ReportsState;
    expect(isReportsState(legacy)).toBe(true);
    const normalized = loadReportsStateFrom(legacy);
    expect(normalized.testerAssignments).toEqual([]);
    expect(normalized.reviews).toEqual([]);
  });

  it('loads and saves assignments and reviews through the workspace persistence', () => {
    const state: ReportsState = {
      ...defaultReportsState(),
      testerAssignments: [assignment(), assignment({ id: 'assign-2', testerName: 'Sato', projectId: 'PRJ-002' })],
      reviews: [review(), review({ id: 'review-2', testerName: 'Sato', periodType: 'year', periodStart: '2026-01-01', periodEnd: '2026-12-31', status: 'completed' })],
    };
    expect(saveReportsState(state)).toBe(true);
    const loaded = loadReportsState();
    expect(loaded.testerAssignments ?? []).toHaveLength(2);
    expect(loaded.reviews ?? []).toHaveLength(2);
    expect(loaded.reviews!.find((r) => r.id === 'review-2')!.status).toBe('completed');
    expect(loaded.testerAssignments!.find((a) => a.id === 'assign-2')!.projectId).toBe('PRJ-002');
  });

  it('rejects a workspace with malformed assignment/review entries entirely (never half-loads)', () => {
    const state = {
      ...defaultReportsState(),
      testerAssignments: [assignment(), { id: 'bad', projectId: 'PRJ-001', testerName: 'X', startDate: 1, active: true }],
      reviews: [review()],
    } as unknown as ReportsState;
    // Same policy as every other module (V6.3 §25): a bad payload is
    // rejected clearly — the whole state falls back to defaults.
    const loaded = loadReportsStateFrom(state);
    expect(loaded.testerAssignments ?? []).toEqual([]);
    expect(loaded.reviews ?? []).toEqual([]);
    // A workspace with only well-formed V6.7 entries loads them all.
    const good = loadReportsStateFrom({ ...defaultReportsState(), testerAssignments: [assignment()], reviews: [review()] });
    expect(good.testerAssignments).toHaveLength(1);
    expect(good.reviews).toHaveLength(1);
  });

  it('round-trips V6.6 projects with tester daily records through loadState', () => {
    const state: AppState = {
      ...DEMO_STATE,
      testerDailyPerformance: [{ id: 'r1', date: '2026-09-10', testerName: 'Sato', projectId: 'PRJ-001', casesTested: 3 }],
    };
    saveState(state);
    const loaded = loadState();
    expect(loaded.testerDailyPerformance).toHaveLength(1);
    expect(loaded.testerDailyPerformance![0].source).toBeUndefined();
  });
});

// ---- Backup / JSON round-trips ----------------------------------------------------

describe('V6.7 backup round-trips', () => {
  it('preserves assignments, reviews and record sources in the full backup', () => {
    const appState: AppState = {
      ...DEMO_STATE,
      testerDailyPerformance: [
        { id: 'r1', date: '2026-09-10', testerName: 'Sato', projectId: 'PRJ-001', casesTested: 30, source: 'assisted' },
      ],
    };
    const reportsState: ReportsState = {
      ...defaultReportsState(),
      testerAssignments: [assignment()],
      reviews: [review({ status: 'completed', strengthsNote: 'Deep domain knowledge', improvementNote: 'More test design', supervisorNote: 'Recommended for recognition' })],
    };
    const payload = createBackupPayload(appState, reportsState);
    const text = JSON.stringify(payload);
    const parsed = parseBackupPayload(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.reportsState.testerAssignments).toHaveLength(1);
    expect(parsed.data.reportsState.reviews).toHaveLength(1);
    const restoredReview = parsed.data.reportsState.reviews![0];
    expect(restoredReview.strengthsNote).toBe('Deep domain knowledge');
    expect(restoredReview.supervisorNote).toBe('Recommended for recognition');
    expect(parsed.data.appState.testerDailyPerformance![0].source).toBe('assisted');
    // Export → import → export is stable.
    const payload2 = createBackupPayload(parsed.data.appState, parsed.data.reportsState);
    expect(payload2.data.reportsState.reviews).toHaveLength(1);
    expect(payload2.data.reportsState.testerAssignments).toHaveLength(1);
  });

  it('restores a V6.6 backup (no assignments/reviews) into the V6.7 application unchanged', () => {
    const v66Reports: ReportsState = {
      ...defaultReportsState(),
      testerAssignments: undefined,
      reviews: undefined,
    };
    const payload = createBackupPayload(DEMO_STATE, v66Reports);
    const parsed = parseBackupPayload(JSON.stringify(payload));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // V6.6 data loads; new fields are safe defaults.
    expect(parsed.data.reportsState.testerAssignments ?? []).toEqual([]);
    expect(parsed.data.reportsState.reviews ?? []).toEqual([]);
    expect(isAppState(parsed.data.appState)).toBe(true);
  });
});

// ---- Manual override source flow --------------------------------------------------

describe('V6.7 manual override source flow', () => {
  it('marks a correction of an assisted record as manualOverride and keeps the record id', () => {
    let records: TesterDailyPerformance[] = [
      { id: 'auto-1', date: '2026-09-10', testerName: 'Tanaka', projectId: 'PRJ-001', casesTested: 40, source: 'assisted' },
    ];
    records = upsertTesterDailyPerformance(records, 'PRJ-001', {
      date: '2026-09-10',
      testerName: 'Tanaka',
      casesTested: 42,
      source: 'manualOverride',
    });
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe('auto-1'); // stable id
    expect(records[0].casesTested).toBe(42);
    expect(records[0].source).toBe('manualOverride');
  });

  it('creates a manually entered record with source manual', () => {
    const records = upsertTesterDailyPerformance([], 'PRJ-001', {
      date: '2026-09-11',
      testerName: 'Sato',
      casesTested: 7,
      source: 'manual',
    });
    expect(records[0].source).toBe('manual');
  });
});

/** Normalize a reports state through the same loader path the app uses. */
function loadReportsStateFrom(state: ReportsState): ReportsState {
  saveReportsState(state);
  return loadReportsState();
}

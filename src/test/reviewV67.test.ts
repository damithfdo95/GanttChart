import { describe, expect, it } from 'vitest';
import type { BugTicket, TesterDailyPerformance, TesterReview } from '../types';
import {
  createTesterReview,
  findTesterReview,
  getTesterReviewHistory,
  removeTesterReview,
  upsertTesterReview,
} from '../domain/reviews';
import {
  comparePeriods,
  getPeriodRange,
  getPreviousPeriod,
  getTesterReviewMetrics,
} from '../lib/calculations/testerPerformance';

/**
 * V6.7 — Bonus Review workspace: review record model (independent H1/H2
 * storage), review metrics (recalculated from the evidence chain, never
 * stored), previous-period resolution and factual comparison. No scores,
 * no grades, no rankings anywhere.
 */

function record(overrides: Partial<TesterDailyPerformance> = {}): TesterDailyPerformance {
  return {
    id: 'r-' + Math.random().toString(36).slice(2, 8),
    date: '2026-09-10',
    testerName: 'Tanaka',
    projectId: 'PRJ-001',
    casesTested: 100,
    ...overrides,
  };
}

function ticket(overrides: Partial<BugTicket> = {}): BugTicket {
  return {
    id: 't-' + Math.random().toString(36).slice(2, 8),
    projectId: 'PRJ-001',
    title: 'A bug',
    url: 'https://jira.example.com/browse/ABC-1',
    createdAt: '2026-09-10',
    reportedBy: 'Tanaka',
    ...overrides,
  };
}

function review(overrides: Partial<TesterReview> = {}): TesterReview {
  return {
    id: 'rev-' + Math.random().toString(36).slice(2, 8),
    testerName: 'Tanaka',
    periodType: 'h2',
    periodStart: '2026-07-01',
    periodEnd: '2026-12-31',
    status: 'draft',
    createdAt: '2026-12-20T00:00:00.000Z',
    updatedAt: '2026-12-20T00:00:00.000Z',
    ...overrides,
  };
}

// ---- Review record model (§23–§25) ----------------------------------------------

describe('V6.7 review records', () => {
  it('creates a review with id and timestamps', () => {
    const created = createTesterReview(
      { testerName: 'Tanaka', periodType: 'h1', periodStart: '2026-01-01', periodEnd: '2026-06-30', status: 'draft', summaryNote: 'First half' },
      '2026-07-05T00:00:00.000Z',
    );
    expect(created.id).not.toBe('');
    expect(created.createdAt).toBe('2026-07-05T00:00:00.000Z');
    expect(created.testerName).toBe('Tanaka');
  });

  it('updates the same (tester, period) review in place, keeping id and createdAt', () => {
    const original = review({ id: 'rev-1', status: 'draft', createdAt: '2026-07-01T00:00:00.000Z' });
    let reviews = upsertTesterReview([], original);
    reviews = upsertTesterReview(reviews, { ...original, status: 'completed', supervisorNote: 'Done', updatedAt: '2026-12-20T00:00:00.000Z' });
    expect(reviews).toHaveLength(1);
    expect(reviews[0].id).toBe('rev-1');
    expect(reviews[0].createdAt).toBe('2026-07-01T00:00:00.000Z');
    expect(reviews[0].status).toBe('completed');
  });

  it('never overwrites the H1 review when the H2 review is created', () => {
    const h1 = review({ id: 'rev-h1', periodType: 'h1', periodStart: '2026-01-01', periodEnd: '2026-06-30', status: 'completed' });
    const h2 = review({ id: 'rev-h2', periodType: 'h2', periodStart: '2026-07-01', periodEnd: '2026-12-31' });
    const reviews = upsertTesterReview(upsertTesterReview([], h1), h2);
    expect(reviews).toHaveLength(2);
    expect(reviews.find((r) => r.id === 'rev-h1')?.status).toBe('completed');
    expect(reviews.find((r) => r.id === 'rev-h2')?.status).toBe('draft');
  });

  it('removes reviews by id and finds them by (tester, period)', () => {
    const h1 = review({ id: 'rev-h1', periodType: 'h1', periodStart: '2026-01-01', periodEnd: '2026-06-30' });
    const h2 = review({ id: 'rev-h2' });
    const reviews = upsertTesterReview(upsertTesterReview([], h1), h2);
    expect(findTesterReview(reviews, 'Tanaka', '2026-01-01', '2026-06-30')?.id).toBe('rev-h1');
    expect(findTesterReview(reviews, 'Tanaka', '2026-07-01', '2026-12-31')?.id).toBe('rev-h2');
    expect(findTesterReview(reviews, 'Sato', '2026-07-01', '2026-12-31')).toBeUndefined();
    expect(removeTesterReview(reviews, 'rev-h1')).toHaveLength(1);
  });

  it('preserves review history chronologically per tester', () => {
    const reviews = [
      review({ testerName: 'Tanaka', periodType: 'h2', periodStart: '2026-07-01', periodEnd: '2026-12-31' }),
      review({ testerName: 'Tanaka', periodType: 'h1', periodStart: '2026-01-01', periodEnd: '2026-06-30' }),
      review({ testerName: 'Tanaka', periodType: 'year', periodStart: '2025-01-01', periodEnd: '2025-12-31' }),
      review({ testerName: 'Sato', periodType: 'h1', periodStart: '2026-01-01', periodEnd: '2026-06-30' }),
    ];
    const history = getTesterReviewHistory(reviews, 'Tanaka');
    expect(history.map((r) => r.periodStart)).toEqual(['2025-01-01', '2026-01-01', '2026-07-01']);
  });
});

// ---- Previous period (§18/§21) ----------------------------------------------------

describe('V6.7 getPreviousPeriod', () => {
  it('resolves the previous month, including January → December of the previous year', () => {
    expect(getPreviousPeriod({ kind: 'month', year: 2026, month: 9 })).toEqual({ kind: 'month', year: 2026, month: 8 });
    expect(getPreviousPeriod({ kind: 'month', year: 2026, month: 1 })).toEqual({ kind: 'month', year: 2025, month: 12 });
  });

  it('resolves H2 → H1 of the same year and H1 → H2 of the previous year', () => {
    expect(getPreviousPeriod({ kind: 'halfYear', year: 2026, half: 2 })).toEqual({ kind: 'halfYear', year: 2026, half: 1 });
    expect(getPreviousPeriod({ kind: 'halfYear', year: 2026, half: 1 })).toEqual({ kind: 'halfYear', year: 2025, half: 2 });
  });

  it('resolves the previous year and no previous custom range', () => {
    expect(getPreviousPeriod({ kind: 'year', year: 2026 })).toEqual({ kind: 'year', year: 2025 });
    expect(getPreviousPeriod({ kind: 'custom', start: '2026-07-01', end: '2026-09-30' })).toBeNull();
  });
});

// ---- Review metrics (§20/§34) ------------------------------------------------------

describe('V6.7 getTesterReviewMetrics', () => {
  it('aggregates cross-project metrics for a period reproducibly', () => {
    const records = [
      record({ date: '2026-07-10', projectId: 'PRJ-001', casesTested: 400, casesPassed: 380 }),
      record({ date: '2026-08-11', projectId: 'PRJ-002', casesTested: 350 }),
      record({ date: '2026-07-11', testerName: 'Sato', casesTested: 999 }), // other tester
      record({ date: '2027-01-05', casesTested: 999 }), // outside the period
    ];
    const tickets = [
      ticket({ createdAt: '2026-08-01', reportedBy: 'Tanaka' }),
      ticket({ createdAt: '2026-09-01', reportedBy: 'Tanaka', projectId: 'PRJ-002' }),
      ticket({ createdAt: '2026-12-31', reportedBy: 'Tanaka' }),
      ticket({ createdAt: '2027-01-01', reportedBy: 'Tanaka' }), // outside
    ];
    const range = getPeriodRange({ kind: 'halfYear', year: 2026, half: 2 })!;
    const metrics = getTesterReviewMetrics(records, tickets, 'Tanaka', range);
    // Same source data + same period + same tester → same result (§34).
    expect(getTesterReviewMetrics(records, tickets, 'Tanaka', range)).toEqual(metrics);

    expect(metrics.row).not.toBeNull();
    expect(metrics.row!.casesTested).toBe(750);
    expect(metrics.row!.activeDays).toBe(2);
    expect(metrics.row!.bugsFound).toBe(3);
    expect(metrics.row!.bugDiscoveryRate).toBeCloseTo(4, 5);
    expect(metrics.breakdown.map((b) => b.projectId).sort()).toEqual(['PRJ-001', 'PRJ-002']);
    expect(metrics.breakdown.reduce((sum, b) => sum + b.casesTested, 0)).toBe(750);
  });

  it('supports month, year and custom periods with the same period logic as V6.6', () => {
    const records = [
      record({ date: '2026-02-01', casesTested: 10 }),
      record({ date: '2026-03-01', casesTested: 20 }),
    ];
    const month = getTesterReviewMetrics(records, [], 'Tanaka', getPeriodRange({ kind: 'month', year: 2026, month: 2 })!);
    expect(month.row!.casesTested).toBe(10);
    const year = getTesterReviewMetrics(records, [], 'Tanaka', getPeriodRange({ kind: 'year', year: 2026 })!);
    expect(year.row!.casesTested).toBe(30);
    const custom = getTesterReviewMetrics(records, [], 'Tanaka', getPeriodRange({ kind: 'custom', start: '2026-02-15', end: '2026-03-15' })!);
    expect(custom.row!.casesTested).toBe(20);
  });

  it('shows empty data (row null, breakdown empty) for a tester without evidence', () => {
    const metrics = getTesterReviewMetrics(
      [record({ testerName: 'Sato' })],
      [ticket({ reportedBy: 'Sato' })],
      'Tanaka',
      getPeriodRange({ kind: 'year', year: 2026 })!,
    );
    expect(metrics.row).toBeNull();
    expect(metrics.breakdown).toEqual([]);
  });

  it('shows zero cases with honest em-dark markers for bugs without execution (§42)', () => {
    const metrics = getTesterReviewMetrics(
      [],
      [ticket({ createdAt: '2026-08-05' }), ticket({ createdAt: '2026-08-06' })],
      'Tanaka',
      getPeriodRange({ kind: 'month', year: 2026, month: 8 })!,
    );
    expect(metrics.row).not.toBeNull();
    expect(metrics.row!.casesTested).toBe(0);
    expect(metrics.row!.bugsFound).toBe(2);
    expect(metrics.row!.bugDiscoveryRate).toBeNull(); // never divide by zero
    expect(metrics.row!.averageCasesPerDay).toBe(0);
    // Bug evidence still shows up in the per-project breakdown with zero cases.
    expect(metrics.breakdown).toEqual([{ projectId: 'PRJ-001', activeDays: 0, casesTested: 0, bugsFound: 2, averageCasesPerDay: 0 }]);
  });
});

// ---- Factual period comparison (§21) ----------------------------------------------

describe('V6.7 comparePeriods', () => {
  const current = {
    testerName: 'Tanaka', team: '', projectIds: [], activeDays: 9, casesTested: 450, casesPassed: 430,
    casesFailed: 12, casesNotApplicable: 4, casesBlocked: 2, casesRetest: 1, casesQuestioned: 1,
    casesSpoAssigned: 3, bugsFound: 5, averageCasesPerDay: 50, bugDiscoveryRate: 11.11, sources: [],
  } as const;
  const previous = {
    testerName: 'Tanaka', team: '', projectIds: [], activeDays: 8, casesTested: 400, casesPassed: 385,
    casesFailed: 10, casesNotApplicable: 5, casesBlocked: 1, casesRetest: 2, casesQuestioned: 2,
    casesSpoAssigned: 0, bugsFound: 4, averageCasesPerDay: 50, bugDiscoveryRate: 10, sources: [],
  } as const;

  it('produces factual numeric differences — never qualitative labels', () => {
    const entries = comparePeriods(previous as never, current as never);
    const byKey = new Map(entries.map((entry) => [entry.key, entry]));
    expect(byKey.get('casesTested')).toEqual({ key: 'casesTested', previous: 400, current: 450, difference: 50 });
    expect(byKey.get('bugsFound')!.difference).toBe(1);
    expect(byKey.get('activeDays')!.difference).toBe(1);
    // Only numbers — the model has no field for good/bad/improved/worse.
    for (const entry of entries) {
      expect(typeof entry.previous).toBe('number');
      expect(typeof entry.current).toBe('number');
      expect(entry.difference).toBe(entry.current - entry.previous);
    }
    expect(entries).toHaveLength(10);
  });

  it('compares against a tester with no previous-period evidence using zeros', () => {
    const entries = comparePeriods(null, current as never);
    expect(entries.every((entry) => entry.previous === 0)).toBe(true);
    expect(entries.find((entry) => entry.key === 'casesTested')!.current).toBe(450);
  });
});

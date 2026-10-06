import { describe, expect, it } from 'vitest';
import type { BugTicket, TesterDailyPerformance } from '../types';
import {
  aggregateTesterPerformance,
  calculateBugDiscoveryRate,
  dateInRange,
  getCustomRangePerformance,
  getHalfYearPerformance,
  getMonthlyPerformance,
  getPeriodRange,
  getTesterMonthlyTrend,
  getTesterProjectBreakdown,
  getYearlyPerformance,
  performanceSummary,
} from '../lib/calculations/testerPerformance';
import { testerDailyDetailSheet, testerPerformanceSheet } from '../lib/export/exportData';
import { newProjectRecord } from '../domain/projects/lifecycle';
import { normalizeQaInputs } from '../lib/storage/storage';
import type { ProjectRecord, QaInputs } from '../types';

/**
 * V6.6 — Tester performance calculation engine. All functions are pure:
 * no React, no storage, no clock, no browser APIs. Dates are plain
 * "YYYY-MM-DD" strings; periods are inclusive.
 */

function record(overrides: Partial<TesterDailyPerformance> = {}): TesterDailyPerformance {
  return {
    id: 'r-' + Math.random().toString(36).slice(2, 8),
    date: '2026-09-10',
    testerName: 'Sato',
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
    reportedBy: 'Sato',
    ...overrides,
  };
}

// ---- Period ranges (§15) ----------------------------------------------------

describe('period ranges', () => {
  it('resolves months, including leap-year February', () => {
    expect(getPeriodRange({ kind: 'month', year: 2026, month: 9 })).toEqual({
      start: '2026-09-01',
      end: '2026-09-30',
    });
    expect(getPeriodRange({ kind: 'month', year: 2024, month: 2 })).toEqual({
      start: '2024-02-01',
      end: '2024-02-29',
    });
    expect(getPeriodRange({ kind: 'month', year: 2023, month: 2 })).toEqual({
      start: '2023-02-01',
      end: '2023-02-28',
    });
    expect(getPeriodRange({ kind: 'month', year: 2026, month: 13 })).toBeNull();
  });

  it('resolves years and half-years', () => {
    expect(getPeriodRange({ kind: 'year', year: 2026 })).toEqual({ start: '2026-01-01', end: '2026-12-31' });
    expect(getPeriodRange({ kind: 'halfYear', year: 2026, half: 1 })).toEqual({ start: '2026-01-01', end: '2026-06-30' });
    expect(getPeriodRange({ kind: 'halfYear', year: 2026, half: 2 })).toEqual({ start: '2026-07-01', end: '2026-12-31' });
  });

  it('validates custom ranges', () => {
    expect(getPeriodRange({ kind: 'custom', start: '2026-07-01', end: '2026-09-30' })).toEqual({
      start: '2026-07-01',
      end: '2026-09-30',
    });
    expect(getPeriodRange({ kind: 'custom', start: '2026-09-30', end: '2026-07-01' })).toBeNull();
    expect(getPeriodRange({ kind: 'custom', start: '2026-02-30', end: '2026-03-01' })).toBeNull();
    expect(getPeriodRange({ kind: 'custom', start: '2026-07-01', end: '2026-07-01' })).not.toBeNull();
  });

  it('checks date inclusion inclusively', () => {
    const range = { start: '2026-07-01', end: '2026-12-31' };
    expect(dateInRange('2026-07-01', range)).toBe(true);
    expect(dateInRange('2026-12-31', range)).toBe(true);
    expect(dateInRange('2026-06-30', range)).toBe(false);
    expect(dateInRange('2027-01-01', range)).toBe(false);
  });
});

// ---- Aggregation (§17, §19, §21, §27) ----------------------------------------

describe('aggregateTesterPerformance', () => {
  it('aggregates a single tester with active days, average and bugs', () => {
    const records = [
      record({ date: '2026-09-01', casesTested: 40, casesPassed: 30, casesFailed: 5 }),
      record({ date: '2026-09-02', casesTested: 35, casesPassed: 28 }),
      record({ date: '2026-09-02', casesTested: 0 }), // second record same day: still one active day
    ];
    const tickets = [ticket({ createdAt: '2026-09-01' }), ticket({ createdAt: '2026-09-15' }), ticket({ createdAt: '2026-08-31' })];
    const rows = aggregateTesterPerformance(records, tickets);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.testerName).toBe('Sato');
    expect(row.activeDays).toBe(2);
    expect(row.casesTested).toBe(75);
    expect(row.casesPassed).toBe(58);
    expect(row.casesFailed).toBe(5);
    expect(row.bugsFound).toBe(3); // no range → all-time: 2026-09-01, 2026-09-15 and 2026-08-31
    expect(row.averageCasesPerDay).toBeCloseTo(37.5, 5);
  });

  it('aggregates multiple testers separately', () => {
    const records = [
      record({ testerName: 'Sato', casesTested: 100 }),
      record({ testerName: 'Kim', casesTested: 50 }),
    ];
    const rows = aggregateTesterPerformance(records, []);
    expect(rows.map((r) => r.testerName)).toEqual(['Kim', 'Sato']); // sorted by name, never ranked
    expect(rows[0].casesTested).toBe(50);
    expect(rows[1].casesTested).toBe(100);
  });

  it('sums the same tester across multiple projects only when no project scope is set', () => {
    const records = [
      record({ projectId: 'PRJ-001', date: '2026-09-01', casesTested: 60 }),
      record({ projectId: 'PRJ-002', date: '2026-09-01', casesTested: 40 }),
      record({ projectId: 'PRJ-002', date: '2026-09-02', casesTested: 20 }),
    ];
    const tickets = [
      ticket({ projectId: 'PRJ-001', reportedBy: 'Sato', createdAt: '2026-09-01' }),
      ticket({ projectId: 'PRJ-002', reportedBy: 'Sato', createdAt: '2026-09-02' }),
    ];
    const all = aggregateTesterPerformance(records, tickets);
    expect(all).toHaveLength(1);
    expect(all[0].casesTested).toBe(120);
    expect(all[0].bugsFound).toBe(2);
    expect(all[0].activeDays).toBe(2);
    expect(all[0].projectIds).toEqual(['PRJ-001', 'PRJ-002']);

    // Project scope: strict isolation (§27).
    const onlyA = aggregateTesterPerformance(records, tickets, { projectIds: ['PRJ-001'] });
    expect(onlyA[0].casesTested).toBe(60);
    expect(onlyA[0].bugsFound).toBe(1);
    expect(onlyA[0].projectIds).toEqual(['PRJ-001']);
  });

  it('never manufactures execution data for testers with only bugs (§29)', () => {
    const rows = aggregateTesterPerformance([], [ticket({ reportedBy: 'Ghost' })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].casesTested).toBe(0);
    expect(rows[0].activeDays).toBe(0);
    expect(rows[0].bugsFound).toBe(1);
    expect(rows[0].bugDiscoveryRate).toBeNull();
  });

  it('shows testers with execution but no bugs as Bugs Found = 0 (§29)', () => {
    const rows = aggregateTesterPerformance([record()], []);
    expect(rows[0].bugsFound).toBe(0);
    expect(rows[0].bugDiscoveryRate).toBe(0);
  });

  it('treats an empty dataset as empty', () => {
    expect(aggregateTesterPerformance([], [])).toEqual([]);
  });

  it('keeps the tester-entered total authoritative — breakdown never re-summed (§13)', () => {
    // casesTested=100 while breakdown tallies sum to 170 (overlays overlap).
    const records = [
      record({
        casesTested: 100,
        casesPassed: 50,
        casesFailed: 20,
        casesNotApplicable: 10,
        casesBlocked: 40,
        casesRetest: 30,
        casesQuestioned: 20,
        casesSpoAssigned: 0,
      }),
    ];
    const [row] = aggregateTesterPerformance(records, []);
    expect(row.casesTested).toBe(100);
    expect(row.casesPassed).toBe(50);
    expect(row.casesBlocked).toBe(40);
  });
});

// ---- Period selectors (§15) ---------------------------------------------------

describe('period aggregation', () => {
  const records = [
    record({ date: '2026-01-15', casesTested: 10 }),
    record({ date: '2026-06-30', casesTested: 20 }),
    record({ date: '2026-07-01', casesTested: 30 }),
    record({ date: '2026-09-20', casesTested: 40 }),
    record({ date: '2025-12-31', casesTested: 5 }),
    record({ testerName: 'Kim', date: '2026-03-10', casesTested: 7 }),
  ];
  const tickets = [
    ticket({ createdAt: '2026-02-01', reportedBy: 'Sato' }),
    ticket({ createdAt: '2026-07-15', reportedBy: 'Sato' }),
    ticket({ createdAt: '2025-12-01', reportedBy: 'Sato' }),
  ];

  const sum = (rows: { casesTested: number }[]): number => rows.reduce((s, r) => s + r.casesTested, 0);

  it('aggregates a month', () => {
    const sept = getMonthlyPerformance(records, tickets, 2026, 9);
    expect(sum(sept)).toBe(40);
    expect(sept[0].bugsFound).toBe(0);
    const feb = getMonthlyPerformance(records, tickets, 2026, 2);
    expect(feb[0].bugsFound).toBe(1);
    const invalid = getMonthlyPerformance(records, tickets, 2026, 13);
    expect(invalid).toEqual([]);
  });

  it('aggregates a year', () => {
    const y2026 = getYearlyPerformance(records, tickets, 2026);
    expect(sum(y2026)).toBe(107);
    expect(y2026.find((r) => r.testerName === 'Sato')!.bugsFound).toBe(2);
    expect(getYearlyPerformance(records, tickets, 2025)[0].bugsFound).toBe(1);
  });

  it('aggregates half-years', () => {
    expect(sum(getHalfYearPerformance(records, tickets, 2026, 1))).toBe(37);
    expect(sum(getHalfYearPerformance(records, tickets, 2026, 2))).toBe(70);
  });

  it('aggregates a custom range and rejects invalid ones', () => {
    expect(sum(getCustomRangePerformance(records, tickets, '2026-06-01', '2026-09-30'))).toBe(90);
    expect(getCustomRangePerformance(records, tickets, '2026-09-30', '2026-06-01')).toEqual([]);
  });

  it('scopes bugs and records by period even without execution records in it', () => {
    const march = getMonthlyPerformance([], tickets, 2026, 3);
    expect(march).toEqual([]);
    const feb = getMonthlyPerformance([], tickets, 2026, 2);
    expect(feb).toHaveLength(1);
    expect(feb[0].bugsFound).toBe(1);
  });
});

// ---- Bug discovery rate (§20) -------------------------------------------------

describe('bug discovery rate', () => {
  it('computes bugs per 1,000 cases from the example', () => {
    expect(calculateBugDiscoveryRate(21, 2430)).toBeCloseTo(8.642, 2);
  });

  it('returns null for zero cases and 0 for zero bugs', () => {
    expect(calculateBugDiscoveryRate(0, 0)).toBeNull();
    expect(calculateBugDiscoveryRate(5, 0)).toBeNull();
    expect(calculateBugDiscoveryRate(0, 500)).toBe(0);
  });
});

// ---- Project breakdown & monthly trend (§18, §21) ------------------------------

describe('tester project breakdown', () => {
  it('breaks one tester down per project', () => {
    const records = [
      record({ projectId: 'PRJ-001', date: '2026-09-01', casesTested: 30 }),
      record({ projectId: 'PRJ-001', date: '2026-09-02', casesTested: 20 }),
      record({ projectId: 'PRJ-002', date: '2026-09-02', casesTested: 50 }),
      record({ testerName: 'Kim', projectId: 'PRJ-001', date: '2026-09-02', casesTested: 99 }),
    ];
    const tickets = [
      ticket({ projectId: 'PRJ-001', reportedBy: 'Sato', createdAt: '2026-09-01' }),
      ticket({ projectId: 'PRJ-002', reportedBy: 'Sato', createdAt: '2026-09-02' }),
      ticket({ projectId: 'PRJ-002', reportedBy: 'Sato', createdAt: '2026-09-03' }),
    ];
    const rows = getTesterProjectBreakdown(records, tickets, 'Sato');
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.projectId === 'PRJ-001')!;
    const b = rows.find((r) => r.projectId === 'PRJ-002')!;
    expect(a.casesTested).toBe(50);
    expect(a.activeDays).toBe(2);
    expect(a.bugsFound).toBe(1);
    expect(a.averageCasesPerDay).toBe(25);
    expect(b.casesTested).toBe(50);
    expect(b.bugsFound).toBe(2);
    // Other testers' records never leak in.
    expect(rows.every((r) => r.projectId !== 'PRJ-003')).toBe(true);
  });

  it('shows a project with bugs but no execution for this tester', () => {
    const rows = getTesterProjectBreakdown([], [ticket({ projectId: 'PRJ-009' })], 'Sato');
    expect(rows).toEqual([{ projectId: 'PRJ-009', activeDays: 0, casesTested: 0, bugsFound: 1, averageCasesPerDay: 0 }]);
  });
});

describe('tester monthly trend', () => {
  it('groups by calendar month with bugs', () => {
    const records = [
      record({ date: '2026-07-01', casesTested: 10 }),
      record({ date: '2026-07-15', casesTested: 5 }),
      record({ date: '2026-08-01', casesTested: 20 }),
    ];
    const tickets = [ticket({ createdAt: '2026-07-02' }), ticket({ createdAt: '2026-07-03' })];
    const trend = getTesterMonthlyTrend(records, tickets, 'Sato');
    expect(trend).toEqual([
      { month: '2026-07', activeDays: 2, casesTested: 15, bugsFound: 2 },
      { month: '2026-08', activeDays: 1, casesTested: 20, bugsFound: 0 },
    ]);
  });

  it('respects the period scope', () => {
    const records = [record({ date: '2025-07-01', casesTested: 10 }), record({ date: '2026-07-01', casesTested: 5 })];
    const trend = getTesterMonthlyTrend(records, [], 'Sato', { range: { start: '2026-01-01', end: '2026-12-31' } });
    expect(trend).toEqual([{ month: '2026-07', activeDays: 1, casesTested: 5, bugsFound: 0 }]);
  });
});

// ---- Team summary (§16) --------------------------------------------------------

describe('performance summary', () => {
  it('sums team totals and counts projects/testers', () => {
    const records = [
      record({ testerName: 'Sato', projectId: 'PRJ-001', date: '2026-09-01', casesTested: 100, casesPassed: 90 }),
      record({ testerName: 'Sato', projectId: 'PRJ-002', date: '2026-09-02', casesTested: 50 }),
      record({ testerName: 'Kim', projectId: 'PRJ-001', date: '2026-09-01', casesTested: 30, casesFailed: 2 }),
    ];
    const tickets = [ticket({ projectId: 'PRJ-001', reportedBy: 'Sato' }), ticket({ projectId: 'PRJ-003', reportedBy: 'Kim' })];
    const summary = performanceSummary(records, tickets);
    expect(summary.totalTesters).toBe(2);
    expect(summary.totalCasesTested).toBe(180);
    expect(summary.totalBugs).toBe(2);
    expect(summary.activeTesterDays).toBe(3);
    expect(summary.projects).toBe(3);
    expect(summary.casesPassed).toBe(90);
    expect(summary.casesFailed).toBe(2);
  });

  it('handles an empty dataset', () => {
    const summary = performanceSummary([], []);
    expect(summary.totalTesters).toBe(0);
    expect(summary.totalCasesTested).toBe(0);
    expect(summary.activeTesterDays).toBe(0);
    expect(summary.projects).toBe(0);
  });
});

// ---- Export sheets (§24) -------------------------------------------------------

function baseQaInputs(): QaInputs {
  return normalizeQaInputs({
    totalCases: 10,
    currentTesters: 2,
    startTime: 9 * 60,
    targetFinish: 17 * 60,
    lunchStart: 0,
    lunchEnd: 0,
    perHourPerTester: 4,
    casesCompleted: 0,
    casesPassed: 0,
    startDate: '2026-09-01',
    targetCompletionDate: '2026-09-30',
    targetCompletionTime: null,
    planningRows: [{ id: 'p1', date: '2026-09-01', plannedTesters: 2, absentTesters: 0, nonWorkingDay: false, note: '' }],
  });
}

describe('tester performance export sheets', () => {
  const projects: ProjectRecord[] = [
    {
      ...newProjectRecord(baseQaInputs(), { nameEn: 'Alpha', nameJa: '', team: '', status: 'done' }, '2026-09-01T00:00:00.000Z'),
      projectId: 'PRJ-001',
    },
    {
      ...newProjectRecord(baseQaInputs(), { nameEn: 'Beta', nameJa: '', team: '', status: 'ongoing' }, '2026-09-01T00:00:00.000Z'),
      projectId: 'PRJ-002',
    },
  ];

  const records: TesterDailyPerformance[] = [
    { id: 'r1', date: '2026-09-01', testerName: 'Sato', team: 'PrV', projectId: 'PRJ-001', casesTested: 30, casesPassed: 25, casesFailed: 2 },
    { id: 'r2', date: '2026-09-01', testerName: 'Sato', team: 'PrV', projectId: 'PRJ-002', casesTested: 10 },
    { id: 'r3', date: '2026-09-02', testerName: 'Kim', projectId: 'PRJ-001', casesTested: 5 },
  ];
  const tickets: BugTicket[] = [
    { id: 't1', projectId: 'PRJ-001', title: 'A', url: 'https://x/1', createdAt: '2026-09-01', reportedBy: 'Sato' },
    { id: 't2', projectId: 'PRJ-001', title: 'B', url: 'https://x/2', createdAt: '2026-09-01', reportedBy: 'Sato' },
    { id: 't3', projectId: 'PRJ-002', title: 'C', url: 'https://x/3', createdAt: '2026-09-02', reportedBy: 'Kim' },
  ];

  it('builds the tester performance sheet with project names and evidence', () => {
    const rows = aggregateTesterPerformance(records, tickets);
    const sheet = testerPerformanceSheet('en', rows, projects, 'H2 2026');
    expect(sheet.name).toBe('Tester Performance');
    expect(sheet.headers).toContain('Period');
    expect(sheet.headers).toContain('Bugs Found');
    expect(sheet.headers).toContain('Avg / Day');
    expect(sheet.headers).toContain('Member ID'); // V6.8 identity column
    const sato = sheet.rows.find((row) => row[1] === 'Sato')!;
    expect(sato[0]).toBe('H2 2026');
    expect(sato[2]).toBe(''); // legacy tester without a member id
    expect(sato[4]).toBe('Alpha / Beta');
    expect(sato[6]).toBe(40);
    expect(sato[14]).toBe(2);
    expect(sato[15]).toBe(40); // 40 cases on one day (both projects on 2026-09-01)
  });

  it('builds the daily detail sheet with per-day bugs joined by reporter', () => {
    const sheet = testerDailyDetailSheet('en', records, tickets, projects);
    expect(sheet.name).toBe('Tester Daily Detail');
    expect(sheet.rows).toHaveLength(3);
    // Sorted by date then tester.
    const r1 = sheet.rows.find((row) => row[1] === 'Sato' && row[3] === 'Alpha')!;
    expect(r1[2]).toBe(''); // legacy tester without a member id (V6.8 column)
    expect(r1[4]).toBe(30);
    expect(r1[12]).toBe(2); // Sato filed 2 bugs on 2026-09-01 in PRJ-001
    const kim = sheet.rows.find((row) => row[1] === 'Kim')!;
    expect(kim[12]).toBe(0); // Kim's bug was in PRJ-002, but record is PRJ-001 → 0 for that row
    const kimPrj2 = sheet.rows.find((row) => row[1] === 'Kim' && row[3] === 'Beta');
    expect(kimPrj2).toBeUndefined(); // Kim has no PRJ-002 execution record
  });

  it('builds empty sheets for empty data', () => {
    expect(testerPerformanceSheet('en', [], projects, 'ALL').rows).toEqual([]);
    expect(testerDailyDetailSheet('en', [], [], projects).rows).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import type { BugTicket, RcsMember, TesterDailyPerformance } from '../types';
import {
  getTesterDailyBreakdown,
  getTesterWeeklyBreakdown,
} from '../lib/calculations/testerPerformance';
import { isoWeekKey, isoWeekNumber, isoWeekYear, getIsoWeekRange, getIsoWeekRangeByNumber } from '../lib/dates/weeks';
import { collectUnlinkedTesters, buildMergeNameHistoryEntry } from '../domain/identityResolution';

/**
 * V6.10 — day/week granularity and the unlinked-tester merge preview.
 * All functions are pure: no React, no storage, no clock.
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

function member(overrides: Partial<RcsMember> = {}): RcsMember {
  return {
    id: 'USER0003',
    name: 'Yamauchi K.',
    team: 'RCS',
    role: 'Tester',
    startDate: '2026-07-01',
    active: true,
    ...overrides,
  };
}

// ---- ISO week helpers ---------------------------------------------------------

describe('ISO week helpers', () => {
  it('computes the ISO week number and year of a date', () => {
    // 2026-09-10 is a Thursday in ISO week 37 of 2026.
    expect(isoWeekNumber(parseEpoch('2026-09-10'))).toBe(37);
    expect(isoWeekYear(parseEpoch('2026-09-10'))).toBe(2026);
    expect(isoWeekKey('2026-09-10')).toBe('2026-W37');
  });

  it('handles a year-boundary week (week 1 of the next ISO year)', () => {
    // 2027-01-01 is a Friday; ISO week 53 of 2026 (the week containing the
    // first Thursday of 2027 is week 1 of 2027).
    expect(isoWeekKey('2027-01-01')).toBe('2026-W53');
  });

  it('returns the Monday→Sunday range of a week', () => {
    expect(getIsoWeekRange('2026-09-10')).toEqual({ start: '2026-09-07', end: '2026-09-13' });
  });

  it('resolves a week by (year, weekNumber)', () => {
    expect(getIsoWeekRangeByNumber(2026, 37)).toEqual({ start: '2026-09-07', end: '2026-09-13' });
    expect(getIsoWeekRangeByNumber(2026, 0)).toBeNull();
    expect(getIsoWeekRangeByNumber(2026, 54)).toBeNull();
  });
});

function parseEpoch(date: string): number {
  const epoch = Date.parse(date + 'T00:00:00Z') / 86_400_000;
  return epoch;
}

// ---- Daily breakdown ----------------------------------------------------------

describe('getTesterDailyBreakdown', () => {
  it('aggregates per day with active days, cases and bugs', () => {
    const records = [
      record({ date: '2026-09-01', casesTested: 40, casesPassed: 30 }),
      record({ date: '2026-09-01', casesTested: 10 }), // same day: one active day
      record({ date: '2026-09-02', casesTested: 35 }),
    ];
    const tickets = [ticket({ createdAt: '2026-09-01' }), ticket({ createdAt: '2026-09-02' })];
    const rows = getTesterDailyBreakdown(records, tickets, 'Sato');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ date: '2026-09-01', activeDays: 1, casesTested: 50, casesPassed: 30, bugsFound: 1 });
    expect(rows[1]).toMatchObject({ date: '2026-09-02', activeDays: 1, casesTested: 35, bugsFound: 1 });
  });

  it('honours the period range', () => {
    const records = [record({ date: '2026-09-01' }), record({ date: '2026-10-01' })];
    const rows = getTesterDailyBreakdown(records, [], 'Sato', { range: { start: '2026-09-01', end: '2026-09-30' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe('2026-09-01');
  });
});

// ---- Weekly breakdown ---------------------------------------------------------

describe('getTesterWeeklyBreakdown', () => {
  it('groups records into ISO weeks', () => {
    const records = [
      record({ date: '2026-09-07', casesTested: 40 }), // Monday of W37
      record({ date: '2026-09-10', casesTested: 35 }), // Thursday of W37
      record({ date: '2026-09-14', casesTested: 20 }), // Monday of W38
    ];
    const rows = getTesterWeeklyBreakdown(records, [], 'Sato');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ week: '2026-W37', activeDays: 2, casesTested: 75 });
    expect(rows[1]).toMatchObject({ week: '2026-W38', activeDays: 1, casesTested: 20 });
  });

  it('counts bugs per week', () => {
    const records = [record({ date: '2026-09-10' })];
    const tickets = [ticket({ createdAt: '2026-09-10' }), ticket({ createdAt: '2026-09-11' })];
    const rows = getTesterWeeklyBreakdown(records, tickets, 'Sato');
    expect(rows[0].bugsFound).toBe(2);
  });
});

// ---- Unlinked-tester merge preview ---------------------------------------------

describe('collectUnlinkedTesters', () => {
  it('lists recorded names that match no member, with evidence', () => {
    const members = [member()];
    const records = [
      record({ testerName: 'Unknown Person', date: '2026-09-01', casesTested: 50 }),
      record({ testerName: 'Unknown Person', date: '2026-09-02', casesTested: 30 }),
      record({ testerName: 'Yamauchi K.', date: '2026-09-01' }), // linked — excluded
    ];
    const tickets = [ticket({ reportedBy: 'Unknown Person', createdAt: '2026-09-01' })];
    const unlinked = collectUnlinkedTesters(records, tickets, members);
    expect(unlinked).toHaveLength(1);
    expect(unlinked[0]).toMatchObject({ name: 'Unknown Person', activeDays: 2, casesTested: 80, bugsFound: 1 });
  });

  it('honours the project scope', () => {
    const members = [member()];
    const records = [
      record({ testerName: 'Unknown Person', projectId: 'PRJ-001' }),
      record({ testerName: 'Unknown Person', projectId: 'PRJ-002' }),
    ];
    const unlinked = collectUnlinkedTesters(records, [], members, { projectIds: ['PRJ-001'] });
    expect(unlinked).toHaveLength(1);
    expect(unlinked[0].projectIds).toEqual(['PRJ-001']);
  });
});

describe('buildMergeNameHistoryEntry', () => {
  it('returns a history entry for a recorded name not already on the member', () => {
    const m = member();
    expect(buildMergeNameHistoryEntry('Unknown Person', m)).toEqual({ name: 'Unknown Person' });
  });

  it('returns null when the name is the member current name or already in history', () => {
    const m = member({ nameHistory: [{ name: 'Old Name' }] });
    expect(buildMergeNameHistoryEntry('Yamauchi K.', m)).toBeNull();
    expect(buildMergeNameHistoryEntry('Old Name', m)).toBeNull();
    expect(buildMergeNameHistoryEntry('   ', m)).toBeNull();
  });
});
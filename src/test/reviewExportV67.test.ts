import { describe, expect, it } from 'vitest';
import type { ProjectRecord, TesterDailyPerformance, TesterReview } from '../types';
import { newProjectRecord } from '../domain/projects/lifecycle';
import { normalizeQaInputs } from '../lib/storage/storage';
import {
  bugTicketsSheet,
  reviewPeriodLabel,
  testerDailyDetailSheet,
  testerPerformanceSheet,
  testerReviewsSheet,
} from '../lib/export/exportData';
import { aggregateTesterPerformance } from '../lib/calculations/testerPerformance';

/**
 * V6.7 §27 — Export: the Tester Review worksheet (localized headers,
 * recalculated metrics, verbatim notes) plus confirmation that every
 * existing V6.6 worksheet still builds correctly.
 */

const NOW = '2026-09-30T00:00:00.000Z';

function project(projectId: string, overrides: { testerDailyPerformance?: TesterDailyPerformance[] } = {}, existing: readonly ProjectRecord[] = []): ProjectRecord {
  const record = newProjectRecord(
    normalizeQaInputs({
      totalCases: 100,
      currentTesters: 2,
      startTime: 9 * 60,
      targetFinish: 18 * 60,
      lunchStart: 0,
      lunchEnd: 0,
      perHourPerTester: 4,
      casesCompleted: 0,
      startDate: '2026-09-01',
      targetCompletionDate: '2026-09-30',
      targetCompletionTime: '18:00',
      planningRows: [{ id: 'row-1', date: '2026-09-01', plannedTesters: 2, absentTesters: 0, nonWorkingDay: false, note: '' }],
      testerDailyPerformance: overrides.testerDailyPerformance ?? [],
    }),
    { nameEn: `Project ${projectId}` },
    NOW,
    existing,
  );
  return { ...record, projectId };
}

function review(overrides: Partial<TesterReview> = {}): TesterReview {
  return {
    id: 'rev-1',
    testerName: 'Tanaka',
    periodType: 'h2',
    periodStart: '2026-07-01',
    periodEnd: '2026-12-31',
    status: 'completed',
    summaryNote: 'Reliable execution across both projects.',
    strengthsNote: 'Careful regression coverage.',
    improvementNote: 'More cross-device testing.',
    supervisorNote: 'Recognized by the team.',
    createdAt: '2026-12-20T09:00:00.000Z',
    updatedAt: '2026-12-21T10:00:00.000Z',
    ...overrides,
  };
}

describe('V6.7 review export labels', () => {
  it('labels each review period type', () => {
    expect(reviewPeriodLabel({ periodType: 'month', periodStart: '2026-09-01', periodEnd: '2026-09-30' })).toBe('2026-09');
    expect(reviewPeriodLabel({ periodType: 'h1', periodStart: '2026-01-01', periodEnd: '2026-06-30' })).toBe('H1 2026');
    expect(reviewPeriodLabel({ periodType: 'h2', periodStart: '2026-07-01', periodEnd: '2026-12-31' })).toBe('H2 2026');
    expect(reviewPeriodLabel({ periodType: 'year', periodStart: '2026-01-01', periodEnd: '2026-12-31' })).toBe('2026');
    expect(reviewPeriodLabel({ periodType: 'custom', periodStart: '2026-08-01', periodEnd: '2026-09-15' })).toBe('2026-08-01 ~ 2026-09-15');
  });
});

describe('V6.7 testerReviewsSheet', () => {
  const records: TesterDailyPerformance[] = [
    { id: 'r1', date: '2026-07-10', testerName: 'Tanaka', projectId: 'PRJ-001', casesTested: 400, casesPassed: 380, casesFailed: 20 },
    { id: 'r2', date: '2026-08-11', testerName: 'Tanaka', projectId: 'PRJ-002', casesTested: 350, casesPassed: 330, casesFailed: 20, source: 'assisted' },
    { id: 'r3', date: '2026-07-10', testerName: 'Sato', projectId: 'PRJ-001', casesTested: 10 },
  ];
  const tickets = [
    { id: 't1', projectId: 'PRJ-001', title: 'b1', url: 'https://jira.example.com/1', createdAt: '2026-08-01', reportedBy: 'Tanaka' },
    { id: 't2', projectId: 'PRJ-002', title: 'b2', url: 'https://jira.example.com/2', createdAt: '2026-09-01', reportedBy: 'Tanaka' },
  ];
  const projects = [project('PRJ-001', { testerDailyPerformance: [records[0], records[2]] }), project('PRJ-002', { testerDailyPerformance: [records[1]] })];

  it('exports one row per review with recalculated metrics and verbatim notes', () => {
    const sheet = testerReviewsSheet('en', [review()], records, tickets, projects);
    expect(sheet.name).toBe('Tester Review');
    expect(sheet.headers).toEqual([
      'Review Period', 'Tester', 'Member ID', 'Review Status', 'Projects', 'Active Days', 'Cases Tested', 'Avg / Day',
      'Pass', 'Fail', 'N/A', 'Blocked', 'Retest', 'Question (質問中)', 'SPO', 'Bugs Found',
      'Bug Discovery Rate (per 1,000 cases)', 'Summary', 'Strengths', 'Improvement', 'Supervisor Notes',
      'Date (created)', 'Date (updated)',
    ]);
    expect(sheet.rows).toHaveLength(1);
    const row = sheet.rows[0];
    expect(row[0]).toBe('H2 2026');
    expect(row[1]).toBe('Tanaka');
    expect(row[2]).toBe(''); // legacy review without a member id (V6.8 column)
    expect(row[3]).toBe('Completed');
    expect(row[4]).toBe('Project PRJ-001 / Project PRJ-002');
    expect(row[5]).toBe(2);
    expect(row[6]).toBe(750);
    expect(row[7]).toBe(375);
    expect(row[8]).toBe(710);
    expect(row[9]).toBe(40);
    expect(row[15]).toBe(2); // bugs found
    expect(row[16]).toBeCloseTo(2.67, 1);
    expect(row[17]).toBe('Reliable execution across both projects.');
    expect(row[18]).toBe('Careful regression coverage.');
    expect(row[19]).toBe('More cross-device testing.');
    expect(row[20]).toBe('Recognized by the team.');
    expect(row[21]).toEqual({ kind: 'date', value: '2026-12-20' });
    expect(row[22]).toEqual({ kind: 'date', value: '2026-12-21' });
  });

  it('exports localized headers in Japanese', () => {
    const sheet = testerReviewsSheet('ja', [review()], records, tickets, projects);
    expect(sheet.name).toBe('テスター評価');
    expect(sheet.headers[0]).toBe('評価期間');
    expect(sheet.headers[1]).toBe('テスター');
    expect(sheet.headers[2]).toBe('メンバーID');
    expect(sheet.headers[3]).toBe('評価ステータス');
    expect(sheet.headers[17]).toBe('総評');
    expect(sheet.headers[20]).toBe('上司コメント');
  });

  it('exports a draft review with an honest marker for a tester with no execution', () => {
    const sheet = testerReviewsSheet('en', [review({ testerName: 'Kimura', status: 'draft', periodType: 'month', periodStart: '2026-08-01', periodEnd: '2026-08-31', summaryNote: undefined })], records, tickets, projects);
    const row = sheet.rows[0];
    expect(row[0]).toBe('2026-08');
    expect(row[3]).toBe('Draft');
    expect(row[5]).toBe(0); // active days
    expect(row[6]).toBe(0); // cases tested
    expect(row[16]).toBe('—'); // no fake bug discovery rate
    expect(row[17]).toBe(''); // no note
  });

  it('exports multiple reviews sorted chronologically by period', () => {
    const reviews = [
      review({ id: 'r-h2', periodType: 'h2', periodStart: '2026-07-01', periodEnd: '2026-12-31' }),
      review({ id: 'r-h1', periodType: 'h1', periodStart: '2026-01-01', periodEnd: '2026-06-30' }),
    ];
    const sheet = testerReviewsSheet('en', reviews, records, tickets, projects);
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[0][0]).toBe('H1 2026');
    expect(sheet.rows[1][0]).toBe('H2 2026');
  });
});

describe('V6.7 existing V6.6 worksheets remain intact', () => {
  it('still builds Bug Tickets, Tester Performance and Tester Daily Detail sheets', () => {
    const records: TesterDailyPerformance[] = [
      { id: 'r1', date: '2026-09-10', testerName: 'Sato', projectId: 'PRJ-001', casesTested: 30, source: 'manual' },
    ];
    const tickets = [
      { id: 't1', projectId: 'PRJ-001', ticketKey: 'ABC-1', title: 'Bug', url: 'https://jira.example.com/1', createdAt: '2026-09-10', reportedBy: 'Sato' },
    ];
    const projects = [project('PRJ-001', { testerDailyPerformance: records })];

    const bugSheet = bugTicketsSheet('en', tickets, projects);
    expect(bugSheet.name).toBe('Bug Tickets');
    // V6.9-A adds Reporter Member ID / Reporter Name after the reporter;
    // V6.9-B adds the identity state column at the end.
    expect(bugSheet.headers).toHaveLength(12);

    const perfSheet = testerPerformanceSheet('en', aggregateTesterPerformance(records, tickets), projects, 'ALL');
    expect(perfSheet.name).toBe('Tester Performance');
    expect(perfSheet.headers).toHaveLength(17);
    expect(perfSheet.rows[0][1]).toBe('Sato');
    expect(perfSheet.rows[0][6]).toBe(30);

    const detailSheet = testerDailyDetailSheet('en', records, tickets, projects);
    expect(detailSheet.name).toBe('Tester Daily Detail');
    expect(detailSheet.rows[0][4]).toBe(30);
    expect(detailSheet.rows[0][12]).toBe(1); // bugs joined by project/tester/date
  });
});

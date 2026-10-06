import { describe, expect, it } from 'vitest';
import type { ProjectRecord, RcsMember, TesterProjectAssignment } from '../types';
import { newProjectRecord } from '../domain/projects/lifecycle';
import { normalizeQaInputs } from '../lib/storage/storage';
import { seedRcsMembers } from '../domain/members';
import {
  rcsMembersSheet,
  testerAssignmentsSheet,
  testerDailyDetailSheet,
  testerPerformanceSheet,
  testerReviewsSheet,
} from '../lib/export/exportData';
import { aggregateTesterPerformance } from '../lib/calculations/testerPerformance';

/**
 * V6.8 §25 — Exports: the RCS Members and Tester Assignments sheets, the
 * Member ID columns on the existing performance/detail/review sheets, and
 * confirmation that the V6.6/V6.7 sheets keep their meaning.
 */

const NOW = '2026-09-30T00:00:00.000Z';

function project(projectId: string, existing: readonly ProjectRecord[] = []): ProjectRecord {
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
    }),
    { nameEn: `Project ${projectId}` },
    NOW,
    existing,
  );
  return { ...record, projectId };
}

describe('V6.8 rcsMembersSheet', () => {
  it('exports the seed roster with identity columns in English', () => {
    const sheet = rcsMembersSheet('en', seedRcsMembers());
    expect(sheet.name).toBe('RCS Members');
    // V6.9-A appends the Name History column.
    expect(sheet.headers).toEqual(['Member ID', 'Name', 'Team', 'Role', 'Start Date', 'End Date', 'Status', 'Name History']);
    expect(sheet.rows).toHaveLength(8);
    const yamauchi = sheet.rows.find((row) => row[0] === 'USER0003')!;
    expect(yamauchi[1]).toBe('Yamauchi Kentaro');
    expect(yamauchi[2]).toBe('RCS');
    expect(yamauchi[3]).toBe('Tester');
    expect(yamauchi[6]).toBe('Active');
    expect(yamauchi[7]).toBe(''); // no history for the seed set
  });

  it('exports localized headers and inactive members in Japanese', () => {
    const inactive: RcsMember[] = [{ id: 'USER0003', name: 'Yamauchi Kentaro', team: 'RCS', role: 'Tester', startDate: '2026-07-01', endDate: '2026-09-30', active: false }];
    const sheet = rcsMembersSheet('ja', inactive);
    expect(sheet.headers).toEqual(['メンバーID', '氏名', 'チーム', '役割', '開始日', '終了日', 'ステータス', '氏名履歴']);
    expect(sheet.rows[0][6]).toBe('不在籍'); // inactive members remain exported (§9)
    expect(sheet.rows[0][5]).toEqual({ kind: 'date', value: '2026-09-30' });
    expect(sheet.rows[0][7]).toBe(''); // no history → empty cell
  });
});

describe('V6.8 testerAssignmentsSheet', () => {
  it('exports member identity alongside the assignment period', () => {
    const assignments: TesterProjectAssignment[] = [
      { id: 'asg-1', projectId: 'PRJ-001', memberId: 'USER0003', testerName: 'Yamauchi Kentaro', startDate: '2026-09-01', active: true },
      { id: 'asg-2', projectId: 'PRJ-001', testerName: 'Legacy Tester', startDate: '2026-08-01', endDate: '2026-08-31', active: false }, // unmigrated legacy
    ];
    const projects = [project('PRJ-001')];
    const sheet = testerAssignmentsSheet('en', assignments, seedRcsMembers(), projects);
    expect(sheet.name).toBe('Tester Assignments');
    expect(sheet.headers).toEqual([
      'Project', 'Member ID', 'Name', 'Team', 'Role', 'Assigned From', 'Assigned To', 'Status',
    ]);
    expect(sheet.rows).toHaveLength(2);
    const memberRow = sheet.rows.find((row) => row[1] === 'USER0003')!;
    expect(memberRow[0]).toBe('Project PRJ-001');
    expect(memberRow[2]).toBe('Yamauchi Kentaro');
    expect(memberRow[3]).toBe('RCS'); // team resolved through the master
    expect(memberRow[4]).toBe('Tester');
    expect(memberRow[5]).toEqual({ kind: 'date', value: '2026-09-01' });
    expect(memberRow[6]).toBe(''); // no end date
    expect(memberRow[7]).toBe('Active');
    const legacyRow = sheet.rows.find((row) => row[1] === '')!;
    expect(legacyRow[2]).toBe('Legacy Tester'); // legacy name preserved
  });

  it('exports localized headers in Japanese', () => {
    const sheet = testerAssignmentsSheet('ja', [], seedRcsMembers(), [project('PRJ-001')]);
    expect(sheet.headers[0]).toBe('プロジェクト');
    expect(sheet.headers[1]).toBe('メンバーID');
    expect(sheet.headers[2]).toBe('氏名');
  });
});

describe('V6.8 Member ID columns on existing sheets', () => {
  const records = [
    { id: 'r1', date: '2026-09-10', testerName: 'Yamauchi Kentaro', memberId: 'USER0003', projectId: 'PRJ-001', casesTested: 30, source: 'assisted' as const },
    { id: 'r2', date: '2026-09-10', testerName: 'Legacy Tester', projectId: 'PRJ-001', casesTested: 10 },
  ];
  const projects = [project('PRJ-001')];
  const members = seedRcsMembers();

  it('adds the Member ID column to the Tester Performance sheet', () => {
    const rows = aggregateTesterPerformance(records, [], { members });
    const sheet = testerPerformanceSheet('en', rows, projects, 'ALL');
    expect(sheet.headers[2]).toBe('Member ID');
    const yamauchi = sheet.rows.find((row) => row[2] === 'USER0003')!;
    expect(yamauchi[1]).toBe('Yamauchi Kentaro');
    const legacy = sheet.rows.find((row) => row[1] === 'Legacy Tester')!;
    expect(legacy[2]).toBe('');
  });

  it('adds the Member ID column to the Tester Daily Detail sheet', () => {
    const sheet = testerDailyDetailSheet('en', records, [], projects);
    expect(sheet.headers[2]).toBe('Member ID');
    expect(sheet.rows[0][2] === 'USER0003' || sheet.rows[1][2] === 'USER0003').toBe(true);
    const legacy = sheet.rows.find((row) => row[1] === 'Legacy Tester')!;
    expect(legacy[2]).toBe('');
  });

  it('adds the Member ID column to the Tester Review sheet', () => {
    const reviews = [
      {
        id: 'rev-1',
        testerName: 'Yamauchi Kentaro',
        memberId: 'USER0003',
        periodType: 'h2' as const,
        periodStart: '2026-07-01',
        periodEnd: '2026-12-31',
        status: 'completed' as const,
        createdAt: '2026-12-20T00:00:00.000Z',
        updatedAt: '2026-12-20T00:00:00.000Z',
      },
    ];
    const sheet = testerReviewsSheet('en', reviews, records, [], projects, members);
    expect(sheet.headers[2]).toBe('Member ID');
    expect(sheet.rows[0][2]).toBe('USER0003');
    // Metrics still recalculate from the evidence chain (member identity aware).
    expect(sheet.rows[0][6]).toBe(30); // USER0003's cases only (the legacy tester stays separate)
  });
});

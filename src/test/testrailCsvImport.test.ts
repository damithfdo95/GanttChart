import { describe, expect, it } from 'vitest';
import { testrailDayFromCsv } from '../domain/testrail/csvImport';
import { mergeTestRailTesterRecords } from '../domain/testrail';
import type { TesterDailyPerformance } from '../types';

const DATE = '2026-10-20';

const SUMMARY_CSV = [
  'Date,Tester,Tested,Passed,Failed,N/A,Blocked,Retest,Questioned,SPO',
  '2026-10-20,Suzuki,10,7,1,1,1,0,0,0',
  '2026-10-20,Tanaka,8,8,0,0,0,0,0,0',
].join('\r\n');

const RESULTS_CSV = [
  'Test Id,Status,Assigned To,Created On',
  '101,Passed,Suzuki,2026-10-20 10:00',
  '102,Failed,Suzuki,2026-10-20 11:00',
  '103,Passed,Tanaka,2026-10-20 12:00',
  '101,Failed,Suzuki,2026-10-20 13:00', // later result for test 101 wins
  '104,Untested,Suzuki,2026-10-20 14:00', // never counted
].join('\r\n');

describe('testrailDayFromCsv — per-tester summary dialect', () => {
  it('maps one row per tester into the day import', () => {
    const r = testrailDayFromCsv(SUMMARY_CSV, DATE);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.day?.date).toBe('2026-10-20');
    expect(r.day?.testers).toHaveLength(2);
    const suzuki = r.day?.testers.find((t) => t.testerName === 'Suzuki');
    expect(suzuki).toMatchObject({ casesTested: 10, casesPassed: 7, casesFailed: 1, casesNotApplicable: 1, casesBlocked: 1 });
    expect(r.day?.totals).toMatchObject({ executed: 18, pass: 15, fail: 1, testers: 2 });
  });

  it('uses the fallback date when there is no Date column', () => {
    const r = testrailDayFromCsv('Tester,Tested,Passed\nSuzuki,5,5', '2026-01-05');
    expect(r.day?.date).toBe('2026-01-05');
  });

  it('rows of a second date are reported and skipped (one day per import)', () => {
    const r = testrailDayFromCsv('Date,Tester,Tested\n2026-10-20,Suzuki,3\n2026-10-21,Suzuki,4', DATE);
    expect(r.ok).toBe(false);
    expect(r.day?.testers[0]?.casesTested).toBe(3);
    expect(r.errors).toEqual([{ record: 3, code: 'csv_bad_date', value: '2026-10-21' }]);
  });

  it('the same tester twice merges the counts', () => {
    const r = testrailDayFromCsv('Tester,Tested,Passed\nSuzuki,3,3\nSuzuki,2,2', DATE);
    expect(r.day?.testers).toHaveLength(1);
    expect(r.day?.testers[0]).toMatchObject({ casesTested: 5, casesPassed: 5 });
  });

  it('bad counts are reported per row and the row is skipped', () => {
    const r = testrailDayFromCsv('Tester,Tested,Passed\nSuzuki,many,3\nTanaka,2,2', DATE);
    expect(r.ok).toBe(false);
    expect(r.day?.testers.map((t) => t.testerName)).toEqual(['Tanaka']);
    expect(r.errors).toEqual([{ record: 2, code: 'csv_bad_count', value: 'many' }]);
  });
});

describe('testrailDayFromCsv — TestRail results export dialect', () => {
  it('aggregates with the live-fetch rules: latest per test, untested never counts', () => {
    const r = testrailDayFromCsv(RESULTS_CSV, DATE);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    const suzuki = r.day?.testers.find((t) => t.testerName === 'Suzuki');
    // test 101: latest (13:00) = Failed; test 102 Failed; 104 Untested skipped
    expect(suzuki).toMatchObject({ casesTested: 2, casesFailed: 2 });
    expect(r.day?.testers.find((t) => t.testerName === 'Tanaka')).toMatchObject({ casesTested: 1, casesPassed: 1 });
    expect(r.day?.skippedUntested).toBe(1);
    expect(r.day?.totals.executed).toBe(3);
  });

  it('status ids map like the built-in TestRail statuses', () => {
    const r = testrailDayFromCsv('Test Id,Status,Assigned To\n1,1,Suzuki\n2,5,Suzuki\n3,2,Suzuki', DATE);
    const suzuki = r.day?.testers[0];
    expect(suzuki).toMatchObject({ casesPassed: 1, casesFailed: 1, casesBlocked: 1, casesTested: 3 });
  });

  it('without timestamps the last row per test wins', () => {
    const r = testrailDayFromCsv('Test Id,Status,Assigned To\n1,Passed,Suzuki\n1,Failed,Suzuki', DATE);
    expect(r.day?.testers[0]).toMatchObject({ casesTested: 1, casesFailed: 1 });
  });

  it('unix-second Created On converts in the Tokyo timezone', () => {
    // 2026-10-20 01:00 UTC = 2026-10-20 10:00 Tokyo
    const r = testrailDayFromCsv('Test Id,Status,Assigned To,Created On\n1,Passed,Suzuki,1760922000', '2026-10-20');
    expect(r.day?.testers[0]?.casesTested).toBe(1);
  });
});

describe('testrailDayFromCsv — validation', () => {
  it('requires a tester column', () => {
    expect(testrailDayFromCsv('Tested,Passed\n3,3', DATE).errors[0]?.code).toBe('csv_no_tester_column');
  });

  it('requires counts (summary) or a status column (results)', () => {
    expect(testrailDayFromCsv('Date,Tester\n2026-10-20,Suzuki', DATE).errors[0]?.code).toBe('csv_no_counts');
  });

  it('empty text is fatal', () => {
    expect(testrailDayFromCsv('', DATE).errors[0]?.code).toBe('csv_empty');
  });
});

describe('testrailDayFromCsv — downstream merge (the live-fetch commit path)', () => {
  it('merges into tester records idempotently and keeps manual records', () => {
    const existing: TesterDailyPerformance[] = [
      {
        id: 'rec1',
        date: DATE,
        testerName: 'Suzuki',
        projectId: 'PRJ-001',
        casesTested: 99,
        source: 'manual',
      } as TesterDailyPerformance,
    ];
    const r = testrailDayFromCsv(SUMMARY_CSV, DATE);
    expect(r.day).not.toBeNull();
    if (r.day === null) return;
    // No TestRail users to link by email → the tester name is the identity.
    const merged = mergeTestRailTesterRecords(existing, 'PRJ-001', r.day);
    expect(merged.keptManual).toBe(1); // Suzuki's manual record was NOT overwritten
    expect(merged.records).toHaveLength(2); // manual kept + Tanaka imported
    const imported = merged.records.find((rec) => rec.id !== 'rec1');
    expect(imported).toMatchObject({ testerName: 'Tanaka', casesTested: 8, casesPassed: 8, source: 'testrail' });
  });
});

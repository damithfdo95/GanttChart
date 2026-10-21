import { describe, expect, it } from 'vitest';
import {
  analyzeResults,
  extractBuilds,
  extractRuns,
  parseResultExport,
  rowsFromApi,
  testRunLabel,
  type AnalysisOptions,
  type TestRailAnalysisRow,
} from '../domain/testrail/resultAnalysis';
import type { TestRailResultRow, TestRailRunRef, TestRailTestRow, TestRailUser } from '../../shared/testrail';

// ---- fixtures ------------------------------------------------------------------------

const TODAY = '2026-10-21';

const OPTS = (over: Partial<AnalysisOptions> = {}): AnalysisOptions => ({
  period: { kind: 'all' },
  excludedTesters: [],
  checkOs: true,
  builds: [],
  runs: [],
  today: TODAY,
  ...over,
});

const row = (over: Partial<TestRailAnalysisRow> = {}): TestRailAnalysisRow => ({
  testId: 1,
  caseId: 100,
  status: 'passed',
  stepsStatus: '',
  comment: 'Build: 10.1.0',
  run: '[iOS] Sanity',
  runConfig: 'English',
  defects: '',
  testedBy: 'Suzuki',
  testedOn: TODAY,
  assignedTo: 'Suzuki',
  ...over,
});

const CSV = [
  'ID,Case ID,Status,Steps (Status),Comment,Run,Run Configuration,Defects,Tested By,Tested On,Assigned To',
  'T1,C100,Passed,"1. Passed 2. Passed",Build: 10.1.0,[iOS] Sanity,English,,Suzuki,2026-10-21 10:00,Suzuki',
  'T2,C101,Failed,"1. Failed 2. Untested",,[iOS] Sanity,English,,Suzuki,2026-10-21 11:00,Suzuki',
  ',,Passed,"1. Passed",Build: 10.1.0,[iOS] Sanity,English,,Suzuki,2026-10-21 11:30,Suzuki',
  'T3,C102,Retest,"1. Passed",,[iOS] Sanity,English,,Tanaka,2026-10-20 09:00,Tanaka',
  'T4,C103,N/A,"1. Passed",,[iOS] Sanity,English,,Tanaka,2026-10-20 09:30,Tanaka',
].join('\n');

// ---- parseResultExport ---------------------------------------------------------------

describe('parseResultExport', () => {
  it('parses the TestRail results export dialect', () => {
    const r = parseResultExport(CSV);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.rows).toHaveLength(5);
    expect(r.rows[0]).toMatchObject({ testId: 1, caseId: 100, status: 'passed', run: '[iOS] Sanity', runConfig: 'English', testedOn: '2026-10-21' });
  });

  it('forward-fills nothing itself but keeps blank Test IDs as 0 (analyzeResults fills them)', () => {
    const r = parseResultExport(CSV);
    expect(r.rows[2]?.testId).toBe(0);
  });

  it('reports a missing status column', () => {
    const r = parseResultExport('ID,Comment\nT1,hello');
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe('csv_no_status_column');
  });

  it('skips and reports rows with an unknown status or date', () => {
    const r = parseResultExport('ID,Status,Tested On\nT1,Weird,2026-10-21\nT2,Passed,not-a-date\nT3,Passed,2026-10-21');
    expect(r.rows).toHaveLength(1);
    expect(r.errors.map((e) => e.code)).toEqual(['csv_bad_status', 'csv_bad_date']);
  });

  it('accepts status ids and unix-second dates', () => {
    const r = parseResultExport('ID,Status,Tested On\nT1,1,1760922000');
    expect(r.rows[0]).toMatchObject({ status: 'passed', testedOn: '2025-10-20' });
  });

  it('cleans HTML in comments', () => {
    const r = parseResultExport('ID,Status,Comment\nT1,Passed,"&lt;b&gt;Build: 10.1&lt;/b&gt;"');
    expect(r.rows[0]?.comment).toBe('Build: 10.1');
  });
});

// ---- rowsFromApi ----------------------------------------------------------------------

describe('rowsFromApi', () => {
  it('joins results to tests (caseId), runs (label) and users (names)', () => {
    const results: TestRailResultRow[] = [
      { id: 1, testId: 10, runId: 700, statusId: 1, createdOn: 1760922000, createdBy: 5, assignedToId: 5, comment: 'Build: 10.1', defects: '' },
    ];
    const tests: TestRailTestRow[] = [{ testId: 10, assignedToId: 5, statusId: 1, caseId: 900 }];
    const runs: TestRailRunRef[] = [{ id: 700, name: '[iOS] Sanity', config: 'English' }];
    const users: TestRailUser[] = [{ id: 5, name: 'Suzuki', email: 's@example.com' }];
    const rows = rowsFromApi(results, tests, runs, users);
    expect(rows[0]).toMatchObject({ testId: 10, caseId: 900, status: 'passed', run: '[iOS] Sanity', runConfig: 'English', testedBy: 'Suzuki', assignedTo: 'Suzuki' });
  });

  it('falls back to "User #id" names and custom statuses', () => {
    const results: TestRailResultRow[] = [
      { id: 2, testId: 11, runId: 700, statusId: 7, createdOn: 1760922000, createdBy: 9, assignedToId: null },
    ];
    const rows = rowsFromApi(results, [], [], []);
    expect(rows[0]).toMatchObject({ status: 'custom', testedBy: 'User #9', assignedTo: '' });
  });
});

// ---- extractors -----------------------------------------------------------------------

describe('extractBuilds / extractRuns', () => {
  it('extracts normalized, deduped, sorted Build names', () => {
    const rows = [row({ comment: 'Build: 10.2.0' }), row({ comment: 'build version： 10.1.0' }), row({ comment: 'Build: 10.2.0' })];
    expect(extractBuilds(rows)).toEqual(['10.1.0', '10.2.0']);
  });

  it('extracts TestRun labels', () => {
    const rows = [row({ run: 'A', runConfig: 'X' }), row({ run: 'A', runConfig: '' }), row({ run: '', runConfig: 'Y' })];
    expect(extractRuns(rows)).toEqual(['A', 'A(X)', 'Y']);
  });
});

describe('testRunLabel', () => {
  it('formats Run(Config) with either side empty', () => {
    expect(testRunLabel('A', 'X')).toBe('A(X)');
    expect(testRunLabel('A', '')).toBe('A');
    expect(testRunLabel('', 'X')).toBe('X');
  });
});

// ---- analyzeResults: the rules ---------------------------------------------------------

describe('analyzeResults — needs review rules', () => {
  it('flags Untested steps on every row of the test (ID forward-filled, broadcast like the tool)', () => {
    const rows = [
      row({ testId: 1, stepsStatus: '1. Passed 2. Untested' }),
      row({ testId: 0, stepsStatus: '1. Passed' }), // same test (ffill): also flagged
    ];
    const r = analyzeResults(rows, OPTS());
    expect(r.needsReview.map((f) => f.issues)).toEqual([['Untested'], ['Untested']]);
  });

  it('flags a Device mismatch (Android config vs iOS comment)', () => {
    const r = analyzeResults([row({ runConfig: 'Android', comment: 'checked on iPhone 15' })], OPTS());
    expect(r.needsReview[0]?.issues).toContain('Device');
    expect(r.needsReview[0]?.issues).not.toContain('NoComment');
  });

  it('does not flag Device when the check is off', () => {
    const r = analyzeResults([row({ runConfig: 'Android', comment: 'checked on iPhone 15' })], OPTS({ checkOs: false }));
    expect(r.needsReview).toHaveLength(0);
  });

  it('flags Passed without comment, but not other statuses', () => {
    const r = analyzeResults([row({ comment: '' }), row({ status: 'failed', comment: '', defects: 'JIRA-1' })], OPTS());
    expect(r.needsReview).toHaveLength(1);
    expect(r.needsReview[0]?.issues).toEqual(['NoComment']);
  });

  it('flags Failed without Defects', () => {
    const r = analyzeResults([row({ status: 'failed', comment: 'broken', defects: '' })], OPTS());
    expect(r.needsReview[0]?.issues).toEqual(['NoDefect']);
  });

  it('flags Passed missing a selected Build and lists it in buildCheck', () => {
    const r = analyzeResults([row({ comment: 'Build: 10.1.0' })], OPTS({ builds: ['10.2.0'] }));
    expect(r.needsReview[0]?.issues).toContain('Build');
    expect(r.buildCheck).toHaveLength(1);
  });

  it('combines multiple issues on one row', () => {
    const r = analyzeResults([row({ status: 'failed', comment: '', defects: '', stepsStatus: '1. Untested' })], OPTS());
    expect(r.needsReview[0]?.issues).toEqual(['Untested', 'NoDefect']);
  });

  it('excludes Retest and N/A rows from needs review (they go to other)', () => {
    const r = analyzeResults([row({ status: 'retest', comment: '' }), row({ status: 'na', comment: '' })], OPTS());
    expect(r.needsReview).toHaveLength(0);
    expect(r.retestNa.map((f) => f.issues[0])).toEqual(['Retest', 'N/A']);
  });
});

describe('analyzeResults — filters', () => {
  it('filters by the today period', () => {
    const rows = [row({ testedOn: TODAY }), row({ testedOn: '2026-10-19' })];
    const r = analyzeResults(rows, OPTS({ period: { kind: 'today' } }));
    expect(r.summary.executed).toBe(1);
  });

  it('filters by a custom period (inclusive)', () => {
    const rows = [row({ testedOn: '2026-10-19' }), row({ testedOn: '2026-10-20' }), row({ testedOn: '2026-10-21' })];
    const r = analyzeResults(rows, OPTS({ period: { kind: 'custom', from: '2026-10-20', to: '2026-10-21' } }));
    expect(r.summary.executed).toBe(2);
  });

  it('excludes testers by partial match on Assigned To', () => {
    const rows = [row({ assignedTo: 'Samad Rahman' }), row({ assignedTo: 'Suzuki' })];
    const r = analyzeResults(rows, OPTS({ excludedTesters: ['samad'] }));
    expect(r.summary.executed).toBe(1);
  });

  it('filters by selected TestRun labels', () => {
    const rows = [row({ run: 'A', runConfig: 'X' }), row({ run: 'B', runConfig: 'X' })];
    const r = analyzeResults(rows, OPTS({ runs: ['A(X)'] }));
    expect(r.summary.executed).toBe(1);
  });
});

describe('analyzeResults — consistency', () => {
  it('warns when one Case ID has both Passed and Failed, ignoring filters', () => {
    const rows = [
      row({ caseId: 500, status: 'passed', testedOn: '2026-10-19', assignedTo: 'Samad' }),
      row({ caseId: 500, status: 'failed', testedOn: '2026-10-20' }),
    ];
    const r = analyzeResults(rows, OPTS({ period: { kind: 'today' }, excludedTesters: ['samad'] }));
    expect(r.consistency).toHaveLength(1);
    expect(r.consistency[0]).toMatchObject({ caseId: 500, difference: 'Passed ×1, Failed ×1' });
  });

  it('does not warn when a case is only Passed', () => {
    const r = analyzeResults([row({ caseId: 500 }), row({ caseId: 500, testedOn: '2026-10-19' })], OPTS());
    expect(r.consistency).toHaveLength(0);
  });
});

describe('analyzeResults — achievements', () => {
  it('aggregates per tester × day with Retest counted in both columns', () => {
    const rows = [
      row({ testedBy: 'Suzuki', testedOn: TODAY }),
      row({ testId: 2, testedBy: 'Suzuki', testedOn: TODAY, status: 'retest' }),
      row({ testId: 3, testedBy: 'Tanaka', testedOn: '2026-10-20' }),
    ];
    const r = analyzeResults(rows, OPTS());
    expect(r.achievements).toEqual([
      { testedBy: 'Suzuki', date: TODAY, executed: 2, retest: 1 },
      { testedBy: 'Tanaka', date: '2026-10-20', executed: 1, retest: 0 },
    ]);
    expect(r.summary.executed).toBe(3);
  });
});

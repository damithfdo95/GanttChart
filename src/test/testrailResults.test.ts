import { describe, expect, it } from 'vitest';
import { caseStatusFromTestRail, planTestRailResultSync } from '../domain/testManagement/testrailResults';
import type { CaseResult, TestCase } from '../../shared/testManagement';
import type { TestRailResultRow, TestRailTestRow } from '../../shared/testrail';

// ---- fixtures ---------------------------------------------------------------

const testCase = (over: Partial<TestCase> = {}): TestCase => ({
  id: 'tc_1',
  projectId: 'PRJ-001',
  scopeId: 'sc_1',
  key: 'ECO-001',
  title: 'Login',
  priority: 'medium',
  ...(over.testrailCaseId !== undefined ? { testrailCaseId: over.testrailCaseId } : {}),
  status: 'active',
  order: 10,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const testRow = (over: Partial<TestRailTestRow> = {}): TestRailTestRow => ({
  testId: 500,
  assignedToId: 5,
  statusId: 1,
  ...(over.caseId !== undefined ? { caseId: over.caseId } : {}),
  ...over,
});

const resultRow = (over: Partial<TestRailResultRow> = {}): TestRailResultRow => ({
  id: 1,
  testId: 500,
  runId: 9001,
  statusId: 1,
  createdOn: 1770000000,
  createdBy: 5,
  assignedToId: 5,
  ...over,
});

const resultOf = (over: Partial<CaseResult> = {}): CaseResult => ({
  id: 'res_tc_1',
  projectId: 'PRJ-001',
  scopeId: 'sc_1',
  testCaseId: 'tc_1',
  status: 'notStarted',
  retest: false,
  question: false,
  updatedByUserId: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

// ---- tests ------------------------------------------------------------------

describe('caseStatusFromTestRail', () => {
  it('maps the built-in status ids', () => {
    expect(caseStatusFromTestRail(1)).toBe('pass');
    expect(caseStatusFromTestRail(2)).toBe('blocked');
    expect(caseStatusFromTestRail(3)).toBe('notStarted');
    expect(caseStatusFromTestRail(4)).toBe('inProgress');
    expect(caseStatusFromTestRail(5)).toBe('fail');
    expect(caseStatusFromTestRail(null)).toBe('notStarted');
  });

  it('maps custom statuses (≥ 6) to inProgress', () => {
    expect(caseStatusFromTestRail(6)).toBe('inProgress');
    expect(caseStatusFromTestRail(12)).toBe('inProgress');
  });
});

describe('planTestRailResultSync', () => {
  it('plans a patch per case whose status would change', () => {
    const cases = [testCase({ testrailCaseId: 101 }), testCase({ id: 'tc_2', key: 'ECO-002', testrailCaseId: 102 })];
    const tests = [testRow({ caseId: 101, statusId: 1 }), testRow({ testId: 501, caseId: 102, statusId: 5 })];
    const plan = planTestRailResultSync(tests, [], cases, new Map());
    expect(plan.patches).toHaveLength(2);
    expect(plan.patches[0]).toMatchObject({ testCase: cases[0], status: 'pass', customStatus: false });
    expect(plan.patches[1]).toMatchObject({ status: 'fail' });
    expect(plan.statusCounts.pass).toBe(1);
    expect(plan.statusCounts.fail).toBe(1);
    expect(plan.unchangedCount).toBe(0);
  });

  it('produces no patch when the status already matches', () => {
    const cases = [testCase({ testrailCaseId: 101 })];
    const tests = [testRow({ caseId: 101, statusId: 1 })];
    const byCase = new Map([['tc_1', resultOf({ status: 'pass' })]]);
    const plan = planTestRailResultSync(tests, [], cases, byCase);
    expect(plan.patches).toHaveLength(0);
    expect(plan.unchangedCount).toBe(1);
  });

  it('carries the latest result comment and defects as memo and ticketRef', () => {
    const cases = [testCase({ testrailCaseId: 101 })];
    const tests = [testRow({ caseId: 101, statusId: 5 })];
    const results = [
      resultRow({ testId: 500, createdOn: 1000, comment: 'old', defects: 'OLD-1' }),
      resultRow({ testId: 500, createdOn: 2000, comment: 'newest comment', defects: 'NEW-1, NEW-2' }),
    ];
    const plan = planTestRailResultSync(tests, results, cases, new Map());
    expect(plan.patches[0]?.memo).toBe('newest comment');
    expect(plan.patches[0]?.ticketRef).toBe('NEW-1, NEW-2');
  });

  it('lists tests whose case is not registered as unmatched (never guessed)', () => {
    const cases = [testCase({ testrailCaseId: 101 })];
    const tests = [testRow({ caseId: 101, statusId: 1 }), testRow({ testId: 501, caseId: 999, statusId: 1 })];
    const plan = planTestRailResultSync(tests, [], cases, new Map());
    expect(plan.unmatchedCaseIds).toEqual([999]);
    expect(plan.patches).toHaveLength(1);
  });

  it('ignores registered cases without a TestRail link or without a test in the run', () => {
    const cases = [testCase(), testCase({ id: 'tc_2', key: 'ECO-002', testrailCaseId: 102 })];
    const tests = [testRow({ caseId: 101, statusId: 1 })]; // no test for 102
    const plan = planTestRailResultSync(tests, [], cases, new Map());
    expect(plan.patches).toHaveLength(0);
    expect(plan.unmatchedCaseIds).toEqual([101]); // 101 has no registered case
  });

  it('counts custom-status patches separately', () => {
    const cases = [testCase({ testrailCaseId: 101 })];
    const tests = [testRow({ caseId: 101, statusId: 7 })];
    const plan = planTestRailResultSync(tests, [], cases, new Map());
    expect(plan.patches[0]?.status).toBe('inProgress');
    expect(plan.patches[0]?.customStatus).toBe(true);
    expect(plan.customStatusCount).toBe(1);
  });
});

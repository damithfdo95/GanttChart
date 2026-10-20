import { describe, expect, it } from 'vitest';
import { runProgressFromCounts, testerProgressFromTests, type TestRailTestRow } from '../../shared/testrail';

const row = (over: Partial<TestRailTestRow> = {}): TestRailTestRow => ({ testId: 1, assignedToId: null, statusId: 3, ...over });

describe('testerProgressFromTests (shared aggregator)', () => {
  it('groups by assignedToId and counts each status bucket', () => {
    const rows = [
      row({ testId: 1, assignedToId: 7, statusId: 1 }),
      row({ testId: 2, assignedToId: 7, statusId: 1 }),
      row({ testId: 3, assignedToId: 7, statusId: 2 }),
      row({ testId: 4, assignedToId: 7, statusId: 4 }),
      row({ testId: 5, assignedToId: 7, statusId: 5 }),
      row({ testId: 6, assignedToId: 7, statusId: 3 }),
      row({ testId: 7, assignedToId: 8, statusId: 5 }),
    ];
    expect(testerProgressFromTests(rows)).toEqual([
      { testerId: 7, passed: 2, blocked: 1, retest: 1, failed: 1, untested: 1, custom: 0, total: 6 },
      { testerId: 8, passed: 0, blocked: 0, retest: 0, failed: 1, untested: 0, custom: 0, total: 1 },
    ]);
  });

  it('keeps unassigned tests (null) in their own bucket, not a tester row', () => {
    const rows = [row({ testId: 1, assignedToId: null, statusId: 1 }), row({ testId: 2, assignedToId: null, statusId: 5 }), row({ testId: 3, assignedToId: 7, statusId: 3 })];
    const out = testerProgressFromTests(rows);
    const unassigned = out.find((r) => r.testerId === null);
    expect(unassigned).toEqual({ testerId: null, passed: 1, blocked: 0, retest: 0, failed: 1, untested: 0, custom: 0, total: 2 });
    expect(out.filter((r) => r.testerId === null)).toHaveLength(1);
  });

  it('counts status ids >= 6 as custom (and only those)', () => {
    const rows = [row({ testId: 1, assignedToId: 7, statusId: 6 }), row({ testId: 2, assignedToId: 7, statusId: 9 }), row({ testId: 3, assignedToId: 7, statusId: 5 })];
    expect(testerProgressFromTests(rows)[0]).toEqual({ testerId: 7, passed: 0, blocked: 0, retest: 0, failed: 1, untested: 0, custom: 2, total: 3 });
  });

  it('returns [] for an empty run', () => {
    expect(testerProgressFromTests([])).toEqual([]);
  });

  it('is defensive: unusable statuses land in untested, the run stays a complete partition', () => {
    const rows = [row({ testId: 1, assignedToId: 7, statusId: null }), row({ testId: 2, assignedToId: 7, statusId: 0 }), row({ testId: 3, assignedToId: 7, statusId: -3 })];
    expect(testerProgressFromTests(rows)[0]).toEqual({ testerId: 7, passed: 0, blocked: 0, retest: 0, failed: 0, untested: 3, custom: 0, total: 3 });
  });

  it('sorts by total descending with a deterministic tie-break, unassigned last', () => {
    const rows = [
      row({ testId: 1, assignedToId: 1, statusId: 1 }),
      row({ testId: 2, assignedToId: 10, statusId: 1 }),
      row({ testId: 3, assignedToId: 10, statusId: 5 }),
      row({ testId: 4, assignedToId: 5, statusId: 1 }),
      row({ testId: 5, assignedToId: 5, statusId: 1 }),
      row({ testId: 6, assignedToId: null, statusId: 1 }),
      row({ testId: 7, assignedToId: null, statusId: 5 }),
    ];
    const out = testerProgressFromTests(rows);
    // tester 5 (2) > tester 10 (2, tie-break by id) > tester 1 (1) > unassigned (2, pinned last)
    expect(out.map((r) => r.testerId)).toEqual([5, 10, 1, null]);
  });

  it('per-tester sums equal the run aggregate exactly', () => {
    const counts = { passed_count: 4, blocked_count: 2, retest_count: 1, failed_count: 3, untested_count: 5, custom_status1_count: 2, custom_status6_count: 1 };
    const aggregate = runProgressFromCounts(counts);
    const rows = [
      row({ testId: 1, assignedToId: 7, statusId: 1 }),
      row({ testId: 2, assignedToId: 7, statusId: 1 }),
      row({ testId: 3, assignedToId: 8, statusId: 1 }),
      row({ testId: 4, assignedToId: 8, statusId: 1 }),
      row({ testId: 5, assignedToId: 7, statusId: 2 }),
      row({ testId: 6, assignedToId: 8, statusId: 2 }),
      row({ testId: 7, assignedToId: 7, statusId: 4 }),
      row({ testId: 8, assignedToId: 8, statusId: 5 }),
      row({ testId: 9, assignedToId: null, statusId: 5 }),
      row({ testId: 10, assignedToId: null, statusId: 5 }),
      row({ testId: 11, assignedToId: 7, statusId: 3 }),
      row({ testId: 12, assignedToId: 8, statusId: 3 }),
      row({ testId: 13, assignedToId: null, statusId: 3 }),
      row({ testId: 14, assignedToId: null, statusId: 3 }),
      row({ testId: 15, assignedToId: null, statusId: 3 }),
      row({ testId: 16, assignedToId: 7, statusId: 6 }),
      row({ testId: 17, assignedToId: 8, statusId: 9 }),
      row({ testId: 18, assignedToId: 8, statusId: 10 }),
    ];
    const byTester = testerProgressFromTests(rows);
    const summed = byTester.reduce(
      (acc, r) => ({
        passed: acc.passed + r.passed,
        blocked: acc.blocked + r.blocked,
        retest: acc.retest + r.retest,
        failed: acc.failed + r.failed,
        untested: acc.untested + r.untested,
        custom: acc.custom + r.custom,
        total: acc.total + r.total,
      }),
      { passed: 0, blocked: 0, retest: 0, failed: 0, untested: 0, custom: 0, total: 0 },
    );
    expect(summed.passed).toBe(aggregate.passed);
    expect(summed.blocked).toBe(aggregate.blocked);
    expect(summed.retest).toBe(aggregate.retest);
    expect(summed.failed).toBe(aggregate.failed);
    expect(summed.untested).toBe(aggregate.untested);
    expect(summed.custom).toBe(aggregate.custom);
    expect(summed.total).toBe(aggregate.total);
  });
});
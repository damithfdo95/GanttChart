import { describe, expect, it } from 'vitest';
import type { TesterDailyPerformance, TesterReview } from '../types';
import { seedRcsMembers } from '../domain/members';
import {
  findTesterDailyPerformance,
  upsertTesterDailyPerformance,
} from '../domain/performance';
import {
  createTesterReview,
  findTesterReview,
  getTesterReviewHistory,
  upsertTesterReview,
} from '../domain/reviews';
import {
  aggregateTesterPerformance,
  getTesterReviewMetrics,
  getTesterProjectBreakdown,
} from '../lib/calculations/testerPerformance';
import { calculateAttendanceConsistency } from '../lib/calculations/testerAttribution';

/**
 * V6.8 — Member-based daily execution, performance resolution and review
 * identity. Historical name-based records keep working; new records carry
 * the stable memberId.
 */

const members = seedRcsMembers();

function record(overrides: Partial<TesterDailyPerformance> = {}): TesterDailyPerformance {
  return {
    id: 'r-' + Math.random().toString(36).slice(2, 8),
    date: '2026-09-10',
    testerName: 'Yamauchi Kentaro',
    projectId: 'PRJ-001',
    casesTested: 50,
    ...overrides,
  };
}

describe('V6.8 daily execution with member identity', () => {
  it('upserts a member-based record and persists the stable member id', () => {
    let records = upsertTesterDailyPerformance([], 'PRJ-001', {
      date: '2026-09-10',
      testerName: 'Yamauchi Kentaro',
      memberId: 'USER0003',
      casesTested: 42,
      source: 'manual',
    });
    expect(records[0].memberId).toBe('USER0003');
    expect(records[0].testerName).toBe('Yamauchi Kentaro'); // display snapshot
    expect(findTesterDailyPerformance(records, 'PRJ-001', '2026-09-10', 'Yamauchi Kentaro', 'USER0003')!.casesTested).toBe(42);
  });

  it('never creates a duplicate when the same member is recorded by name and by id', () => {
    let records = upsertTesterDailyPerformance([], 'PRJ-001', {
      date: '2026-09-10',
      testerName: 'Yamauchi Kentaro', // legacy path, no memberId
      casesTested: 10,
    });
    records = upsertTesterDailyPerformance(records, 'PRJ-001', {
      date: '2026-09-10',
      testerName: 'Yamauchi Kentaro',
      memberId: 'USER0003',
      casesTested: 12,
    });
    expect(records).toHaveLength(1); // one slot per (project, date, tester identity)
    expect(records[0].casesTested).toBe(12);
    expect(records[0].memberId).toBe('USER0003');
    expect(records[0].id).not.toBe(''); // stable id preserved on replacement
  });

  it('keeps historical name-based records untouched (no rewriting)', () => {
    const historical: TesterDailyPerformance[] = [
      record({ id: 'hist-1', testerName: 'Legacy Tester', casesTested: 7, source: undefined }),
    ];
    const next = upsertTesterDailyPerformance(historical, 'PRJ-001', {
      date: '2026-09-11',
      testerName: 'Yamauchi Kentaro',
      memberId: 'USER0003',
      casesTested: 5,
    });
    expect(next.find((r) => r.id === 'hist-1')).toEqual(historical[0]);
    expect(next).toHaveLength(2);
  });
});

describe('V6.8 performance resolves member identity (§15)', () => {
  it('aggregates by memberId and resolves display name, team and role through the master', () => {
    const records = [
      record({ testerName: 'Yamauchi Kentaro', memberId: 'USER0003', casesTested: 100, team: 'RCS' }),
      record({ date: '2026-09-11', testerName: 'Kobayashi Masashi', memberId: 'USER0004', casesTested: 80 }),
      record({ testerName: 'Legacy Tester', casesTested: 10 }), // no member — stays name-keyed
    ];
    const rows = aggregateTesterPerformance(records, [], { members });
    expect(rows).toHaveLength(3);
    const yamauchi = rows.find((r) => r.memberId === 'USER0003')!;
    expect(yamauchi.testerName).toBe('Yamauchi Kentaro');
    const kobayashi = rows.find((r) => r.memberId === 'USER0004')!;
    expect(kobayashi.testerName).toBe('Kobayashi Masashi');
    const legacy = rows.find((r) => r.testerName === 'Legacy Tester')!;
    expect(legacy.memberId).toBeUndefined();
  });

  it('joins bug reporters to members by unique name match', () => {
    const tickets = [
      { id: 't1', projectId: 'PRJ-001', title: 'A', url: 'https://x/1', createdAt: '2026-09-10', reportedBy: 'Osaki Kazuki' },
      { id: 't2', projectId: 'PRJ-001', title: 'B', url: 'https://x/2', createdAt: '2026-09-11', reportedBy: 'Ghost Reporter' },
    ];
    const records = [record({ testerName: 'Osaki Kazuki', memberId: 'USER0005', casesTested: 100 })];
    const rows = aggregateTesterPerformance(records, tickets, { members });
    const osaki = rows.find((r) => r.memberId === 'USER0005')!;
    expect(osaki.bugsFound).toBe(1);
    expect(rows.find((r) => r.testerName === 'Ghost Reporter')!.bugsFound).toBe(1);
  });

  it('keeps breakdown, trend and review metrics identity-aware', () => {
    const records = [
      record({ testerName: 'Yamauchi Kentaro', memberId: 'USER0003', casesTested: 100, projectId: 'PRJ-001' }),
      record({ date: '2026-09-11', testerName: 'Yamauchi Kentaro', memberId: 'USER0003', casesTested: 40, projectId: 'PRJ-002' }),
    ];
    const breakdown = getTesterProjectBreakdown(records, [], 'USER0003', { members });
    expect(breakdown.map((b) => b.projectId).sort()).toEqual(['PRJ-001', 'PRJ-002']);
    expect(breakdown.reduce((s, b) => s + b.casesTested, 0)).toBe(140);
    const metrics = getTesterReviewMetrics(records, [], 'USER0003', { start: '2026-09-01', end: '2026-09-30' }, members);
    expect(metrics.row!.casesTested).toBe(140);
    expect(metrics.row!.testerName).toBe('Yamauchi Kentaro');
  });

  it('flags inactive members never: attendance warnings stay non-destructive with identity', () => {
    const warnings = calculateAttendanceConsistency(
      [record({ testerName: 'Yamauchi Kentaro', memberId: 'USER0003' })],
      [{ id: 'a1', date: '2026-09-10', memberName: 'Yamauchi Kentaro', team: 'RCS', status: 'ABSENT', workingStart: null, workingEnd: null, leaveType: null, comment: '' }],
      members,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].kind).toBe('absent');
    expect(warnings[0].memberId).toBe('USER0003');
  });
});

describe('V6.8 review uses stable member identity (§22)', () => {
  it('saves and finds reviews by memberId, keeping historical name-based reviews', () => {
    let reviews: TesterReview[] = [
      { id: 'rev-legacy', testerName: 'Yamauchi Kentaro', periodType: 'h1', periodStart: '2026-01-01', periodEnd: '2026-06-30', status: 'completed', createdAt: '2026-07-05T00:00:00.000Z', updatedAt: '2026-07-05T00:00:00.000Z' },
    ];
    reviews = upsertTesterReview(
      reviews,
      createTesterReview(
        { testerName: 'Yamauchi Kentaro', memberId: 'USER0003', periodType: 'h2', periodStart: '2026-07-01', periodEnd: '2026-12-31', status: 'completed' },
        '2026-12-20T00:00:00.000Z',
      ),
      members,
    );
    expect(reviews).toHaveLength(2); // H1 preserved when H2 is created
    // Lookup by the stable member id finds BOTH the legacy name review and the member review.
    expect(findTesterReview(reviews, 'USER0003', '2026-01-01', '2026-06-30', members)!.id).toBe('rev-legacy');
    expect(findTesterReview(reviews, 'USER0003', '2026-07-01', '2026-12-31', members)!.memberId).toBe('USER0003');
    // History for the member id includes the legacy review (identity resolution).
    const history = getTesterReviewHistory(reviews, 'USER0003', members);
    expect(history.map((r) => r.periodStart)).toEqual(['2026-01-01', '2026-07-01']);
  });

  it('updates the same member review in place instead of recreating it', () => {
    const original = createTesterReview(
      { testerName: 'Yamauchi Kentaro', memberId: 'USER0003', periodType: 'h2', periodStart: '2026-07-01', periodEnd: '2026-12-31', status: 'draft' },
      '2026-12-20T00:00:00.000Z',
    );
    let reviews = upsertTesterReview([], original, members);
    reviews = upsertTesterReview(reviews, { ...original, status: 'completed', updatedAt: '2026-12-21T00:00:00.000Z' }, members);
    expect(reviews).toHaveLength(1);
    expect(reviews[0].id).toBe(original.id); // not deleted/recreated
    expect(reviews[0].status).toBe('completed');
  });

  it('shows inactive members in reviews (historical visibility, §9)', () => {
    const inactiveMembers = members.map((m) => (m.id === 'USER0003' ? { ...m, active: false } : m));
    const records = [record({ testerName: 'Yamauchi Kentaro', memberId: 'USER0003', casesTested: 10 })];
    const metrics = getTesterReviewMetrics(records, [], 'USER0003', { start: '2026-09-01', end: '2026-09-30' }, inactiveMembers);
    expect(metrics.row).not.toBeNull(); // still resolvable and visible
    expect(metrics.row!.casesTested).toBe(10);
  });
});

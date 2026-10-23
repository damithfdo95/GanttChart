import { describe, expect, it } from 'vitest';
import type { TestRailResultRow, TestRailUser } from '../../shared/testrail';
import type { DailyExecutionEntry, ExternalIdentity, RcsMember, TesterDailyPerformance } from '../types';
import { parseDate } from '../lib/dates/dates';
import {
  aggregateTestRailDay,
  applyTestRailDayToEntry,
  DEFAULT_TESTRAIL_STATUS_MAP,
  linkTestRailMembers,
  mergeTestRailTesterRecords,
  normalizeTestrailPlanUrl,
  parseTestRailUrl,
  testrailHostMatches,
  testrailTesterDisplayName,
  tokyoDayOf,
  tokyoDayStartUnix,
} from '../domain/testrail';

const DAY = '2026-10-19';
const DAY_START = tokyoDayStartUnix(DAY) as number;

const result = (over: Partial<TestRailResultRow> = {}): TestRailResultRow => ({
  id: 1,
  testId: 100,
  runId: 9001,
  statusId: 1,
  createdOn: DAY_START + 3600, // 01:00 Tokyo
  createdBy: 5,
  assignedToId: 5,
  ...over,
});

const USERS: TestRailUser[] = [
  { id: 5, name: 'Hana Sato', email: 'hana@example.com' },
  { id: 6, name: 'Ken Ito', email: 'ken@example.com' },
  { id: 7, name: 'Lead Yamada', email: 'lead@example.com' },
];

const MEMBERS: RcsMember[] = [
  { id: 'USER0001', name: 'Hana', team: 'PrV', role: 'Tester', startDate: '2026-01-01', active: true, email: 'hana@example.com' },
  { id: 'USER0002', name: 'Ken', team: 'RCS', role: 'Tester', startDate: '2026-01-01', active: true, email: 'ken@example.com' },
];

describe('TestRail URL link', () => {
  it('parses plan and run view URLs (the example URL included)', () => {
    expect(parseTestRailUrl('https://rkong.testrail.com/index.php?/plans/view/32716')).toEqual({ kind: 'plan', id: 32716 });
    expect(parseTestRailUrl('https://rkong.testrail.com/index.php?/runs/view/42')).toEqual({ kind: 'run', id: 42 });
    expect(parseTestRailUrl('https://rkong.testrail.com/index.php?/projects/view/1')).toBeNull();
    expect(parseTestRailUrl('not a url')).toBeNull();
    expect(parseTestRailUrl('https://rkong.testrail.com/index.php?/plans/view/abc')).toBeNull();
  });

  it('normalizes persisted link URLs and drops non-plan/run values', () => {
    expect(normalizeTestrailPlanUrl('  https://rkong.testrail.com/index.php?/plans/view/32716 ')).toBe(
      'https://rkong.testrail.com/index.php?/plans/view/32716',
    );
    expect(normalizeTestrailPlanUrl('https://rkong.testrail.com/dashboard')).toBe('');
    expect(normalizeTestrailPlanUrl('   ')).toBe('');
  });

  it('checks that the linked URL points at the configured instance', () => {
    expect(testrailHostMatches('https://rkong.testrail.com', 'https://rkong.testrail.com/index.php?/plans/view/1')).toBe(true);
    expect(testrailHostMatches('https://rkong.testrail.com/', 'https://RKONG.TESTRAIL.com/index.php?/plans/view/1')).toBe(true);
    expect(testrailHostMatches('https://other.testrail.com', 'https://rkong.testrail.com/index.php?/plans/view/1')).toBe(false);
    expect(testrailHostMatches('not a url', 'https://rkong.testrail.com/index.php?/plans/view/1')).toBe(false);
  });
});

describe('Tokyo day bounds', () => {
  it('starts a Tokyo day at 00:00 JST and ends before the next', () => {
    // 2026-10-19 00:00 JST == 2026-10-18 15:00 UTC.
    expect(new Date(DAY_START * 1000).toISOString()).toBe('2026-10-18T15:00:00.000Z');
    expect(tokyoDayOf(DAY_START)).toBe(parseDate('2026-10-19'));
    expect(tokyoDayOf(DAY_START - 1)).toBe(parseDate('2026-10-18'));
    expect(tokyoDayOf(DAY_START + 86_399)).toBe(parseDate('2026-10-19'));
    expect(tokyoDayOf(DAY_START + 86_400)).toBe(parseDate('2026-10-20'));
    expect(tokyoDayStartUnix('2026-13-99')).toBeNull();
  });
});

describe('aggregateTestRailDay', () => {
  it('keeps only the LATEST result per test per day (tie-break: result id)', () => {
    const day = aggregateTestRailDay(
      [
        result({ id: 10, testId: 100, statusId: 5, createdOn: DAY_START + 3600 }), // 01:00 Failed
        result({ id: 11, testId: 100, statusId: 1, createdOn: DAY_START + 7200 }), // 02:00 Passed → latest
        result({ id: 12, testId: 100, statusId: 5, createdOn: DAY_START + 5400, assignedToId: 6 }), // 01:30 ignored
      ],
      USERS,
      DEFAULT_TESTRAIL_STATUS_MAP,
      DAY,
    );
    expect(day.totals).toMatchObject({ pass: 1, fail: 0, executed: 1, testers: 1 });
    expect(day.testers[0]).toMatchObject({ testerName: 'Hana Sato', casesPassed: 1, casesTested: 1 });
  });

  it('attributes to the ASSIGNED tester, not the person who recorded the result', () => {
    const day = aggregateTestRailDay(
      [result({ testId: 100, statusId: 1, assignedToId: 5, createdBy: 7 })],
      USERS,
      DEFAULT_TESTRAIL_STATUS_MAP,
      DAY,
    );
    expect(day.testers.map((t) => t.testerName)).toEqual(['Hana Sato']);
  });

  it('counts unassigned results in the totals but never as a tester row', () => {
    const day = aggregateTestRailDay(
      [result({ testId: 100, statusId: 1, assignedToId: null }), result({ testId: 101, statusId: 5, assignedToId: 5 })],
      USERS,
      DEFAULT_TESTRAIL_STATUS_MAP,
      DAY,
    );
    expect(day.unassignedCount).toBe(1);
    expect(day.totals).toMatchObject({ pass: 1, fail: 1, executed: 2, testers: 1 });
    expect(day.testers.length).toBe(1);
  });

  it('skips tests whose latest status is Untested (3) or empty', () => {
    const day = aggregateTestRailDay(
      [result({ testId: 100, statusId: 3 }), result({ testId: 101, statusId: null })],
      USERS,
      DEFAULT_TESTRAIL_STATUS_MAP,
      DAY,
    );
    expect(day.skippedUntested).toBe(2);
    expect(day.totals.executed).toBe(0);
    expect(day.testers.length).toBe(0);
  });

  it('maps built-in statuses and counts unmapped custom statuses as uncategorized', () => {
    const day = aggregateTestRailDay(
      [
        result({ testId: 1, statusId: 1, assignedToId: 5 }), // Passed
        result({ testId: 2, statusId: 5, assignedToId: 5 }), // Failed
        result({ testId: 3, statusId: 2, assignedToId: 5 }), // Blocked (overlay)
        result({ testId: 4, statusId: 4, assignedToId: 5 }), // Retest (overlay)
        result({ testId: 5, statusId: 9, assignedToId: 5 }), // custom → uncategorized
      ],
      USERS,
      DEFAULT_TESTRAIL_STATUS_MAP,
      DAY,
    );
    expect(day.totals).toMatchObject({ pass: 1, fail: 1, blocked: 1, retest: 1, uncategorizedCompleted: 1, executed: 5 });
    const hana = day.testers[0];
    expect(hana?.casesTested).toBe(5); // every counted execution
    expect(hana?.casesPassed).toBe(1);
    expect(hana?.casesFailed).toBe(1);
    expect(hana?.casesBlocked).toBe(1);
    expect(hana?.casesRetest).toBe(1);
    expect(hana?.uncategorized).toBe(1);
  });

  it('honors a custom status map (e.g. custom status 6 → N/A)', () => {
    const day = aggregateTestRailDay(
      [result({ testId: 1, statusId: 6, assignedToId: 5 })],
      USERS,
      { ...DEFAULT_TESTRAIL_STATUS_MAP, 6: 'notApplicable' },
      DAY,
    );
    expect(day.totals.notApplicable).toBe(1);
    expect(day.testers[0]?.casesNotApplicable).toBe(1);
  });

  it('counts each config run execution separately (same case, different test ids)', () => {
    const day = aggregateTestRailDay(
      [
        result({ testId: 100, runId: 9001, statusId: 1, assignedToId: 5 }),
        result({ testId: 200, runId: 9002, statusId: 1, assignedToId: 5 }), // same case, Chrome + Android runs
      ],
      USERS,
      DEFAULT_TESTRAIL_STATUS_MAP,
      DAY,
    );
    expect(day.totals.pass).toBe(2);
    expect(day.testers[0]?.casesPassed).toBe(2);
  });

  it('excludes results outside the Tokyo day (23:30 UTC = next JST day edge)', () => {
    const lateUtcPreviousDay = tokyoDayStartUnix('2026-10-18')! + 86_400 - 1800; // 2026-10-18 23:30 UTC = 10-19 08:30 JST
    const earlyTokyoNextDay = DAY_START + 86_400 + 60; // 10-20 00:01 JST
    const day = aggregateTestRailDay(
      [
        result({ testId: 1, createdOn: lateUtcPreviousDay, statusId: 1, assignedToId: 5 }),
        result({ testId: 2, createdOn: earlyTokyoNextDay, statusId: 1, assignedToId: 5 }),
        result({ testId: 3, createdOn: DAY_START, statusId: 1, assignedToId: 5 }), // 00:00 JST inclusive
        result({ testId: 4, createdOn: DAY_START + 86_400 - 1, statusId: 1, assignedToId: 5 }), // 23:59:59 JST inclusive
      ],
      USERS,
      DEFAULT_TESTRAIL_STATUS_MAP,
      DAY,
    );
    expect(day.totals.pass).toBe(2);
  });

  it('aggregates several testers per day and orders rows by name', () => {
    const day = aggregateTestRailDay(
      [
        result({ testId: 1, statusId: 1, assignedToId: 6 }),
        result({ testId: 2, statusId: 1, assignedToId: 6 }),
        result({ testId: 3, statusId: 5, assignedToId: 5 }),
      ],
      USERS,
      DEFAULT_TESTRAIL_STATUS_MAP,
      DAY,
    );
    expect(day.testers.map((t) => t.testerName)).toEqual(['Hana Sato', 'Ken Ito']);
    expect(day.totals.testers).toBe(2);
    expect(day.testers.find((t) => t.testerName === 'Ken Ito')?.casesPassed).toBe(2);
  });
});

describe('linkTestRailMembers', () => {
  it('links a tester row to the Team Member with the same email (memberId + team)', () => {
    const day = aggregateTestRailDay([result({ testId: 1, statusId: 1, assignedToId: 5 })], USERS, DEFAULT_TESTRAIL_STATUS_MAP, DAY);
    const linked = linkTestRailMembers(day, USERS, MEMBERS);
    expect(linked.testers[0]).toMatchObject({ memberId: 'USER0001', team: 'PrV', testerName: 'Hana Sato' });
  });

  it('keeps unmatched testers unlinked and merges two accounts with the same member email', () => {
    const both: TestRailUser[] = [...USERS, { id: 9, name: 'Hana (contract)', email: 'hana@example.com' }];
    const day = aggregateTestRailDay(
      [
        result({ testId: 1, statusId: 1, assignedToId: 5 }),
        result({ testId: 2, statusId: 5, assignedToId: 9 }),
        result({ testId: 3, statusId: 1, assignedToId: 7 }), // Lead: no member profile
      ],
      both,
      DEFAULT_TESTRAIL_STATUS_MAP,
      DAY,
    );
    const linked = linkTestRailMembers(day, both, MEMBERS);
    expect(linked.testers.length).toBe(2); // merged Hana + Lead
    const hana = linked.testers.find((t) => t.memberId === 'USER0001');
    expect(hana?.casesTested).toBe(2);
    expect(hana?.casesPassed).toBe(1);
    expect(hana?.casesFailed).toBe(1);
    const lead = linked.testers.find((t) => t.testerName === 'Lead Yamada');
    expect(lead?.memberId).toBeUndefined();
  });

  it('resolves by an ACTIVE testrail external identity before email (the JIRA reporter rule)', () => {
    // Lead Yamada has NO member profile by email, but the SV linked his
    // TestRail id (7) to Ken explicitly — the link must win.
    const identities: ExternalIdentity[] = [
      { id: 'EI1', provider: 'testrail', externalId: '7', memberId: 'USER0002', displayName: 'Lead Yamada', active: true, linkedAt: '2026-10-01T00:00:00Z' },
    ];
    const day = aggregateTestRailDay([result({ testId: 3, statusId: 1, assignedToId: 7 })], USERS, DEFAULT_TESTRAIL_STATUS_MAP, DAY);
    const linked = linkTestRailMembers(day, USERS, MEMBERS, identities);
    expect(linked.testers[0]).toMatchObject({ memberId: 'USER0002', team: 'RCS' });
    expect(linked.testers.every((t) => t.memberId !== undefined)).toBe(true);
  });

  it('ignores retired testrail identities and other providers', () => {
    const identities: ExternalIdentity[] = [
      { id: 'EI1', provider: 'testrail', externalId: '7', memberId: 'USER0002', displayName: 'Lead Yamada', active: false, linkedAt: '2026-10-01T00:00:00Z' },
      { id: 'EI2', provider: 'jira', externalId: '7', memberId: 'USER0001', displayName: 'Lead Yamada', active: true, linkedAt: '2026-10-01T00:00:00Z' },
    ];
    const day = aggregateTestRailDay([result({ testId: 3, statusId: 1, assignedToId: 7 })], USERS, DEFAULT_TESTRAIL_STATUS_MAP, DAY);
    const linked = linkTestRailMembers(day, USERS, MEMBERS, identities);
    expect(linked.testers.find((t) => t.testerName === 'Lead Yamada')?.memberId).toBeUndefined();
  });

  it('an explicit identity link overrides a matching email', () => {
    // Hana's TestRail id (5) is linked to Ken — the SV's explicit link wins
    // even though Hana's email matches her own member profile.
    const identities: ExternalIdentity[] = [
      { id: 'EI1', provider: 'testrail', externalId: '5', memberId: 'USER0002', displayName: 'Hana Sato', active: true, linkedAt: '2026-10-01T00:00:00Z' },
    ];
    const day = aggregateTestRailDay([result({ testId: 1, statusId: 1, assignedToId: 5 })], USERS, DEFAULT_TESTRAIL_STATUS_MAP, DAY);
    const linked = linkTestRailMembers(day, USERS, MEMBERS, identities);
    expect(linked.testers[0]).toMatchObject({ memberId: 'USER0002', team: 'RCS' });
  });
});

describe('testrailTesterDisplayName', () => {
  it('prefers the linked Team Member name over the TestRail account label', () => {
    // The TestRail account shows an id-like label, but the SV linked it.
    const identities: ExternalIdentity[] = [
      { id: 'EI1', provider: 'testrail', externalId: '7', memberId: 'USER0002', displayName: 'Lead Yamada', active: true, linkedAt: '2026-10-01T00:00:00Z' },
    ];
    expect(testrailTesterDisplayName(7, USERS, MEMBERS, identities)).toBe('Ken');
  });

  it('falls back to the email match, then the TestRail name, then Tester #id', () => {
    expect(testrailTesterDisplayName(5, USERS, MEMBERS)).toBe('Hana'); // email match
    expect(testrailTesterDisplayName(7, USERS, MEMBERS)).toBe('Lead Yamada'); // no member, own name
    expect(testrailTesterDisplayName(99, USERS, MEMBERS)).toBe('Tester #99'); // unknown id
  });

  it('ignores retired links and other providers', () => {
    const identities: ExternalIdentity[] = [
      { id: 'EI1', provider: 'testrail', externalId: '7', memberId: 'USER0002', active: false, linkedAt: '2026-10-01T00:00:00Z' },
      { id: 'EI2', provider: 'jira', externalId: '7', memberId: 'USER0001', active: true, linkedAt: '2026-10-01T00:00:00Z' },
    ];
    expect(testrailTesterDisplayName(7, USERS, MEMBERS, identities)).toBe('Lead Yamada');
  });
});

describe('mergeTestRailTesterRecords', () => {
  const day = () =>
    linkTestRailMembers(
      aggregateTestRailDay(
        [result({ testId: 1, statusId: 1, assignedToId: 5 }), result({ testId: 2, statusId: 5, assignedToId: 6 })],
        USERS,
        DEFAULT_TESTRAIL_STATUS_MAP,
        DAY,
      ),
      USERS,
      MEMBERS,
    );

  const record = (over: Partial<TesterDailyPerformance> = {}): TesterDailyPerformance => ({
    id: 'rec-1',
    date: DAY,
    testerName: 'Hana Sato',
    memberId: 'USER0001',
    team: 'PrV',
    projectId: 'PRJ-001',
    casesTested: 9,
    source: 'manual',
    ...over,
  });

  it('imports each tester as a testrail-sourced record', () => {
    const merged = mergeTestRailTesterRecords([], 'PRJ-001', day());
    expect(merged.records.length).toBe(2);
    expect(merged.records.every((r) => r.source === 'testrail')).toBe(true);
    expect(merged.records.every((r) => r.projectId === 'PRJ-001' && r.date === DAY)).toBe(true);
    expect(merged.keptManual).toBe(0);
  });

  it('never overwrites manual or manualOverride records (V6.7 §10)', () => {
    const existing = [record(), record({ id: 'rec-2', testerName: 'Ken Ito', memberId: 'USER0002', source: 'manualOverride' })];
    const merged = mergeTestRailTesterRecords(existing, 'PRJ-001', day());
    expect(merged.keptManual).toBe(2);
    expect(merged.records.find((r) => r.id === 'rec-1')).toMatchObject({ casesTested: 9, source: 'manual' });
    expect(merged.records.find((r) => r.id === 'rec-2')).toMatchObject({ source: 'manualOverride' });
  });

  it('replaces existing testrail / automatic / assisted records, keeping their stable ids (idempotent re-import)', () => {
    // Start from one automatic record (Ken) and one manual record (Hana):
    // real data never holds two records for one (project, date, tester) key.
    const legacy = [
      record({ id: 'rec-auto', testerName: 'Ken Ito', memberId: 'USER0002', source: 'automatic', casesTested: 0 }),
      record(),
    ];
    const first = mergeTestRailTesterRecords(legacy, 'PRJ-001', day());
    expect(first.keptManual).toBe(1); // Hana's manual record survives
    expect(first.records.length).toBe(2); // Ken replaced, Hana kept
    expect(first.records.find((r) => r.id === 'rec-auto')?.source).toBe('testrail');
    const second = mergeTestRailTesterRecords(first.records, 'PRJ-001', day());
    expect(second.records.length).toBe(2); // no duplicates on re-import
    expect(second.records.find((r) => r.testerName === 'Ken Ito')?.id).toBe('rec-auto');
    // A third import of the same day changes nothing.
    const third = mergeTestRailTesterRecords(second.records, 'PRJ-001', day());
    expect(third.records).toEqual(second.records);
  });

  it('touches only the owning project and date', () => {
    const other = [record({ id: 'rec-other', projectId: 'PRJ-002', date: '2026-10-20', casesTested: 1 })];
    const merged = mergeTestRailTesterRecords(other, 'PRJ-001', day());
    expect(merged.records.find((r) => r.id === 'rec-other')).toBeDefined();
    expect(merged.records.length).toBe(3);
  });
});

describe('applyTestRailDayToEntry', () => {
  const day = aggregateTestRailDay(
    [
      result({ testId: 1, statusId: 1, assignedToId: 5 }),
      result({ testId: 2, statusId: 5, assignedToId: 6 }),
      result({ testId: 3, statusId: 2, assignedToId: 5 }),
    ],
    USERS,
    DEFAULT_TESTRAIL_STATUS_MAP,
    DAY,
  );

  const current: DailyExecutionEntry = {
    id: 'entry-1',
    date: DAY,
    startTime: 540,
    endTime: 1050,
    overtimeMinutes: 30,
    intervalEnabled: false,
    testers: 99,
    pass: 7,
    fail: 7,
    notApplicable: 7,
    spo: 7,
    blocked: 7,
    retest: 7,
    questioned: 7,
    uncategorizedCompleted: 7,
    note: 'typed by hand',
  };

  it('DAY mode replaces the counts and the tester count, preserving the time window and note', () => {
    const next = applyTestRailDayToEntry(current, day, { pass: 100, fail: 100, notApplicable: 100, spo: 100, blocked: 100, retest: 100, questioned: 100 }, 'DAY');
    expect(next).toMatchObject({
      id: 'entry-1',
      date: DAY,
      startTime: 540,
      endTime: 1050,
      overtimeMinutes: 30,
      intervalEnabled: false,
      testers: 2,
      pass: 1,
      fail: 1,
      blocked: 1,
      uncategorizedCompleted: 0,
      note: 'typed by hand',
    });
  });

  it('TOTAL mode adds the day on top of the previous cumulative (the day delta equals the import)', () => {
    const previous = { pass: 10, fail: 20, notApplicable: 30, spo: 40, blocked: 50, retest: 60, questioned: 70 };
    const next = applyTestRailDayToEntry(current, day, previous, 'TOTAL');
    expect(next.pass).toBe(11); // 10 + 1
    expect(next.fail).toBe(21); // 20 + 1
    expect(next.blocked).toBe(51); // 50 + 1
    expect(next.testers).toBe(2);
    // The form derives the day back as totals − previous.
    expect(next.pass - previous.pass).toBe(day.totals.pass);
    expect(next.fail - previous.fail).toBe(day.totals.fail);
  });
});

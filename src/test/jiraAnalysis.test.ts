import { describe, expect, it } from 'vitest';
import {
  analyzeTickets,
  buildTicketJql,
  isValidJiraProjectKey,
  normalizeJiraProjectKey,
  type TicketAnalysis,
} from '../domain/jira';
import type { JiraIssue } from '../../shared/jira';
import type { ExternalIdentity, RcsMember } from '../types';

const issue = (over: Partial<JiraIssue> = {}): JiraIssue => ({
  id: '10001',
  key: 'PROJ-42',
  summary: 'Login fails on Safari',
  statusName: 'Open',
  typeName: 'Bug',
  labels: [],
  affectedVersions: [],
  descriptionPlain: '',
  ...over,
});

const member = (over: Partial<RcsMember> = {}): RcsMember => ({
  id: 'USER0001',
  name: 'Yamauchi Kentaro',
  team: 'QA',
  role: 'Tester',
  startDate: '2026-01-01',
  active: true,
  ...over,
});

const identity = (over: Partial<ExternalIdentity> = {}): ExternalIdentity => ({
  id: 'ext_1',
  provider: 'jira',
  externalId: 'yamauchi',
  memberId: 'USER0001',
  displayName: 'Yamauchi Kentaro',
  active: true,
  linkedAt: '2026-09-01T00:00:00.000Z',
  ...over,
});

describe('buildTicketJql', () => {
  it('defaults to Bug issues created within the last 30 days', () => {
    expect(buildTicketJql({})).toBe('issuetype IN (Bug) AND created >= -30d ORDER BY created DESC');
    expect(buildTicketJql({ days: undefined })).toBe('issuetype IN (Bug) AND created >= -30d ORDER BY created DESC');
  });

  it('combines every filter into one ordered clause string', () => {
    expect(buildTicketJql({ projectKeys: ['ABC', 'DEF'], issueTypes: ['Bug'], days: 30 })).toBe(
      'project IN (ABC, DEF) AND issuetype IN (Bug) AND created >= -30d ORDER BY created DESC',
    );
  });

  it('from overrides days; to adds an inclusive upper bound', () => {
    expect(buildTicketJql({ from: '2026-10-01', to: '2026-10-15' })).toBe(
      'issuetype IN (Bug) AND created >= 2026-10-01 AND created <= 2026-10-15 ORDER BY created DESC',
    );
    expect(buildTicketJql({ from: '2026-10-01', days: 7 })).toBe(
      'issuetype IN (Bug) AND created >= 2026-10-01 ORDER BY created DESC',
    );
  });

  it('to is optional; without from, days still applies', () => {
    expect(buildTicketJql({ to: '2026-10-15' })).toBe(
      'issuetype IN (Bug) AND created >= -30d AND created <= 2026-10-15 ORDER BY created DESC',
    );
  });

  it('empty issueTypes means all issue types (no issuetype clause)', () => {
    expect(buildTicketJql({ issueTypes: [] })).toBe('created >= -30d ORDER BY created DESC');
    expect(buildTicketJql({ issueTypes: [], projectKeys: ['ABC'] })).toBe(
      'project IN (ABC) AND created >= -30d ORDER BY created DESC',
    );
  });

  it('empty and whitespace-only project keys and issue types are dropped', () => {
    expect(buildTicketJql({ projectKeys: ['ABC', ' ', ''], issueTypes: ['Bug', '  '] })).toBe(
      'project IN (ABC) AND issuetype IN (Bug) AND created >= -30d ORDER BY created DESC',
    );
  });

  it('normalizes project keys and quotes issue-type names that need it', () => {
    expect(buildTicketJql({ projectKeys: ['ab c'], issueTypes: ['UX Bug'] })).toBe(
      'project IN (ABC) AND issuetype IN ("UX Bug") AND created >= -30d ORDER BY created DESC',
    );
  });

  it('escapes embedded quotes inside quoted values', () => {
    expect(buildTicketJql({ issueTypes: ['A"B'] })).toBe(
      'issuetype IN ("A""B") AND created >= -30d ORDER BY created DESC',
    );
  });
});

describe('analyzeTickets reporter matching', () => {
  const issues = (reporter: string | undefined): JiraIssue[] => [issue({ reporterName: reporter })];

  it('matches a reporter by the jira externalId (case-insensitive, trimmed)', () => {
    const analysis = analyzeTickets(issues('  YAMAUCHI '), [member()], [identity({ externalId: 'yamauchi' })]);
    expect(analysis.tickets[0].memberId).toBe('USER0001');
    expect(analysis.tickets[0].memberName).toBe('Yamauchi Kentaro');
  });

  it('matches by the identity displayName as well', () => {
    const analysis = analyzeTickets(
      issues('yamauchi kentaro'),
      [member()],
      [identity({ externalId: 'not-the-account', displayName: 'Yamauchi Kentaro' })],
    );
    expect(analysis.tickets[0].memberId).toBe('USER0001');
  });

  it('falls back to a unique active-member name match when no identity matches', () => {
    const analysis = analyzeTickets(issues('  yamauchi   kentaro '), [member()], []);
    expect(analysis.tickets[0].memberId).toBe('USER0001');
  });

  it('an identity match takes precedence over the name fallback', () => {
    const members = [
      member({ id: 'USER0001', name: 'Yamauchi Kentaro' }),
      member({ id: 'USER0002', name: 'Someone Else' }),
    ];
    const analysis = analyzeTickets(
      issues('Yamauchi Kentaro'),
      members,
      [identity({ id: 'ext_2', memberId: 'USER0002', externalId: 'unrelated', displayName: 'Yamauchi Kentaro' })],
    );
    expect(analysis.tickets[0].memberId).toBe('USER0002'); // identity wins over the name that alone would resolve to USER0001
  });

  it('ambiguous name match → unmatched (never guessed)', () => {
    const members = [
      member({ id: 'USER0001', name: 'Yamauchi Kentaro' }),
      member({ id: 'USER0002', name: 'Yamauchi Kentaro' }),
    ];
    const analysis = analyzeTickets(issues('yamauchi kentaro'), members, []);
    expect(analysis.tickets[0].memberId).toBeUndefined();
    expect(analysis.unmatchedReporters).toEqual([{ reporterName: 'yamauchi kentaro', count: 1 }]);
  });

  it('an identity mapping shared by two members is ambiguous → unmatched', () => {
    const members = [member({ id: 'USER0001', name: 'One' }), member({ id: 'USER0002', name: 'Two' })];
    const analysis = analyzeTickets(
      issues('shared'),
      members,
      [
        identity({ id: 'ext_1', memberId: 'USER0001', externalId: 'shared' }),
        identity({ id: 'ext_2', memberId: 'USER0002', externalId: 'shared' }),
      ],
    );
    expect(analysis.tickets[0].memberId).toBeUndefined();
  });

  it('an inactive identity is always ignored', () => {
    const analysis = analyzeTickets(issues('Yamauchi'), [member()], [identity({ active: false })]);
    expect(analysis.tickets[0].memberId).toBeUndefined();
  });

  it('an inactive member cannot be matched by default (activeMembersOnly)', () => {
    const analysis = analyzeTickets(issues('yamauchi kentaro'), [member({ active: false })], []);
    expect(analysis.tickets[0].memberId).toBeUndefined();
  });

  it('activeMembersOnly: false lets inactive members match', () => {
    const analysis = analyzeTickets(
      issues('yamauchi kentaro'),
      [member({ active: false })],
      [],
      { activeMembersOnly: false },
    );
    expect(analysis.tickets[0].memberId).toBe('USER0001');
  });

  it('an identity pointing at an inactive member is ignored when activeMembersOnly', () => {
    const analysis = analyzeTickets(issues('Yamauchi'), [member({ active: false })], [identity()]);
    expect(analysis.tickets[0].memberId).toBeUndefined();
  });

  it('a missing reporterName never crashes: unmatched with the empty name', () => {
    const analysis = analyzeTickets([issue({ reporterName: undefined })], [member()], []);
    expect(analysis.tickets[0].reporterName).toBe('');
    expect(analysis.tickets[0].memberId).toBeUndefined();
    expect(analysis.tickets[0].memberName).toBeUndefined();
    expect(analysis.unmatchedReporters).toEqual([{ reporterName: '', count: 1 }]);
  });
});

describe('analyzeTickets aggregation', () => {
  const members = [member({ id: 'USER0001', name: 'A' }), member({ id: 'USER0002', name: 'B' })];
  const identities = [
    identity({ externalId: 'a', memberId: 'USER0001' }),
    identity({ id: 'ext_2', externalId: 'b', memberId: 'USER0002' }),
  ];

  function analysis(): TicketAnalysis {
    return analyzeTickets(
      [
        issue({ key: 'P-6', reporterName: 'a', statusCategoryName: 'Done', updated: '2026-10-06T00:00:00.000Z' }),
        issue({ key: 'P-5', reporterName: 'a', statusCategoryName: 'In Progress', updated: '2026-10-05T00:00:00.000Z' }),
        issue({ key: 'P-4', reporterName: 'a', statusCategoryName: 'To Do', updated: '2026-10-04T00:00:00.000Z' }),
        issue({ key: 'P-3', reporterName: 'b', statusCategoryName: 'Done', updated: '2026-10-03T00:00:00.000Z' }),
        issue({ key: 'P-2', reporterName: 'unknown', statusCategoryName: 'Done', updated: '2026-10-02T00:00:00.000Z' }),
        issue({ key: 'P-1', reporterName: 'unknown', statusCategoryName: undefined, updated: '2026-10-01T00:00:00.000Z' }),
      ],
      members,
      identities,
    );
  }

  it('computes per-member counts and the resolved rate', () => {
    const stats = analysis().memberStats;
    const user1 = stats.find((s) => s.memberId === 'USER0001')!;
    expect(user1.total).toBe(3);
    expect(user1.open).toBe(1);
    expect(user1.inProgress).toBe(1);
    expect(user1.done).toBe(1);
    expect(user1.resolvedRate).toBeCloseTo(1 / 3);
    const user2 = stats.find((s) => s.memberId === 'USER0002')!;
    expect(user2.total).toBe(1);
    expect(user2.done).toBe(1);
    expect(user2.resolvedRate).toBe(1);
  });

  it('resolvedRate is null (never NaN/Infinity) for members with no tickets, and lastActivity is absent', () => {
    const m = [member({ id: 'USER0001', name: 'A' }), member({ id: 'USER0009', name: 'No Tickets' })];
    const stats = analyzeTickets([issue({ reporterName: 'a' })], m, [identity({ externalId: 'a', memberId: 'USER0001' })]).memberStats;
    const empty = stats.find((s) => s.memberId === 'USER0009')!;
    expect(empty.total).toBe(0);
    expect(empty.resolvedRate).toBeNull();
    expect(empty.lastActivity).toBeUndefined();
  });

  it('lastActivity is the most recently updated ticket of the member', () => {
    expect(analysis().memberStats.find((s) => s.memberId === 'USER0001')!.lastActivity).toBe('2026-10-06T00:00:00.000Z');
  });

  it('totals reflect the full fetched set and the matched count', () => {
    expect(analysis().totals).toEqual({ fetched: 6, matched: 4, open: 2, inProgress: 1, done: 3 });
  });

  it('memberStats sort by total desc, then memberName asc', () => {
    expect(analysis().memberStats.map((s) => s.memberId)).toEqual(['USER0001', 'USER0002']);
    const tied = analyzeTickets(
      [
        issue({ key: 'K-1', reporterName: 'x', statusCategoryName: 'Done' }),
        issue({ key: 'K-2', reporterName: 'y', statusCategoryName: 'Done' }),
      ],
      [member({ id: 'USER0002', name: 'Zed' }), member({ id: 'USER0001', name: 'Alpha' })],
      [
        identity({ externalId: 'x', memberId: 'USER0001' }),
        identity({ id: 'ext_2', externalId: 'y', memberId: 'USER0002' }),
      ],
    );
    expect(tied.memberStats.map((s) => s.memberId)).toEqual(['USER0001', 'USER0002']); // same total → Alpha before Zed
  });

  it('tickets sort newest first (updated desc), then issueKey asc', () => {
    expect(analysis().tickets.map((t) => t.issueKey)).toEqual(['P-6', 'P-5', 'P-4', 'P-3', 'P-2', 'P-1']);
    const sameUpdated = analyzeTickets(
      [
        issue({ key: 'B-1', reporterName: 'x', updated: '2026-10-05T00:00:00.000Z' }),
        issue({ key: 'A-1', reporterName: 'x', updated: '2026-10-05T00:00:00.000Z' }),
      ],
      [member({ id: 'USER0001', name: 'A' })],
      [identity({ externalId: 'x', memberId: 'USER0001' })],
    );
    expect(sameUpdated.tickets.map((t) => t.issueKey)).toEqual(['A-1', 'B-1']);
  });

  it('status category falls back to todo when statusCategoryName is missing or unknown', () => {
    const { tickets } = analyzeTickets(
      [
        issue({ key: 'P-1', statusCategoryName: undefined }),
        issue({ key: 'P-2', statusCategoryName: 'Weird' }),
        issue({ key: 'P-3', statusCategoryName: 'Done' }),
        issue({ key: 'P-4', statusCategoryName: 'In Progress' }),
      ],
      [member({ id: 'USER0001', name: 'A' })],
      [identity({ externalId: 'x', memberId: 'USER0001' })],
    );
    const byKey = new Map(tickets.map((t) => [t.issueKey, t.statusCategory]));
    expect(byKey.get('P-1')).toBe('todo');
    expect(byKey.get('P-2')).toBe('todo');
    expect(byKey.get('P-3')).toBe('done');
    expect(byKey.get('P-4')).toBe('inProgress');
  });

  it('unmatched reporters are grouped by (trimmed) name, count desc, then name asc', () => {
    const { unmatchedReporters } = analyzeTickets(
      [
        issue({ key: 'K-1', reporterName: 'z' }),
        issue({ key: 'K-2', reporterName: 'z' }),
        issue({ key: 'K-3', reporterName: 'a' }),
        issue({ key: 'K-4', reporterName: '  matched  ' }),
      ],
      [member({ id: 'USER0001', name: 'X' })],
      [identity({ externalId: 'matched', memberId: 'USER0001' })],
    );
    expect(unmatchedReporters).toEqual([
      { reporterName: 'z', count: 2 },
      { reporterName: 'a', count: 1 },
    ]);
  });
});

describe('JIRA project key helpers', () => {
  it('normalizeJiraProjectKey uppercases, trims and removes inner spaces', () => {
    expect(normalizeJiraProjectKey('  qa  pj ')).toBe('QAPJ');
    expect(normalizeJiraProjectKey('ABC')).toBe('ABC');
    expect(normalizeJiraProjectKey('   ')).toBe('');
    expect(normalizeJiraProjectKey('')).toBe('');
  });

  it('isValidJiraProjectKey accepts the documented shape and rejects the rest (after normalization)', () => {
    expect(isValidJiraProjectKey('QA')).toBe(true);
    expect(isValidJiraProjectKey('abc')).toBe(true);
    expect(isValidJiraProjectKey('ABC123')).toBe(true);
    expect(isValidJiraProjectKey('A B')).toBe(true); // normalizes to AB
    expect(isValidJiraProjectKey('1ABC')).toBe(false);
    expect(isValidJiraProjectKey('ABC-1')).toBe(false);
    expect(isValidJiraProjectKey('')).toBe(false);
  });
});

describe('purity', () => {
  it('analyzeTickets is deterministic and never mutates its inputs (no clock, no random)', () => {
    const members = [member()];
    const identities = [identity()];
    const issues = [
      issue({ key: 'P-1', reporterName: 'Yamauchi Kentaro', statusCategoryName: 'To Do', updated: '2026-10-01T00:00:00.000Z' }),
      issue({ key: 'P-2', reporterName: undefined, statusCategoryName: 'Done' }),
    ];
    const snapshot = JSON.stringify(issues);
    const first = analyzeTickets(issues, members, identities);
    const second = analyzeTickets(issues, members, identities);
    expect(first).toEqual(second);
    expect(JSON.stringify(issues)).toBe(snapshot);
  });

  it('buildTicketJql is deterministic for identical filters', () => {
    const filters = { projectKeys: ['ABC'], issueTypes: ['Bug', 'UX Bug'], days: 30 };
    expect(buildTicketJql(filters)).toBe(buildTicketJql(filters));
  });
});
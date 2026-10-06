import { describe, expect, it } from 'vitest';
import type {
  AttendanceRecord,
  BugTicket,
  ExternalIdentity,
  ProjectRecord,
  QaInputs,
  RcsMember,
  TesterDailyPerformance,
} from '../types';
import { normalizeQaInputs } from '../lib/storage/storage';
import { newProjectRecord } from '../domain/projects/lifecycle';
import {
  buildAttributionAuditEntry,
  buildExternalIdentityLink,
  resolveAttribution,
  uniqueExternalIdentityMembers,
  validateAttributionIntegrity,
} from '../domain/attribution';
import { appendIdentityAuditEntries } from '../domain/identityResolution';
import { isExternalIdentity, isIdentityAuditEntry, isReportsState, normalizeReportsState } from '../lib/storage/reports';
import { aggregateTesterPerformance } from '../lib/calculations/testerPerformance';

/**
 * V6.9-B — attribution integrity & external-system readiness (§11).
 * Every attribution-sensitive record resolves to the canonical internal
 * memberId; names are display/history information only. Ambiguous and
 * unresolved identities are explicit, never guessed; invalid/orphaned
 * references are detected; external identities (JIRA-ready) model
 * mappings without any API integration.
 */

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

function attendance(overrides: Partial<AttendanceRecord> = {}): AttendanceRecord {
  return {
    id: 'att-1',
    date: '2026-09-10',
    memberName: 'Yamauchi K.',
    team: 'RCS',
    status: 'PRESENT',
    workingStart: null,
    workingEnd: null,
    leaveType: null,
    comment: '',
    ...overrides,
  };
}

function ticket(overrides: Partial<BugTicket> = {}): BugTicket {
  return {
    id: 't1',
    projectId: 'PRJ-001',
    title: 'Login fails',
    url: 'https://jira.example.com/browse/ABC-100',
    createdAt: '2026-09-10',
    reportedBy: 'Yamauchi K.',
    ...overrides,
  };
}

function baseInputs(): QaInputs {
  return normalizeQaInputs({
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
  });
}

function project(inputs: Partial<QaInputs> = {}): ProjectRecord {
  const record = newProjectRecord(
    { ...baseInputs(), ...inputs },
    { nameEn: 'Project A', nameJa: '', team: '', status: 'ongoing' },
    '2026-09-01T00:00:00.000Z',
    [],
  );
  return { ...record, projectId: 'PRJ-001' };
}

function jiraLink(overrides: Partial<ExternalIdentity> = {}): ExternalIdentity {
  return {
    ...buildExternalIdentityLink({
      provider: 'jira',
      externalId: 'yamauchi',
      memberId: 'USER0003',
      linkedAt: '2026-09-30T00:00:00.000Z',
    }),
    ...overrides,
  };
}

const AMBIGUOUS_MEMBERS = [
  member({ nameHistory: [{ name: 'Yamauchi Kentaro' }] }),
  member({ id: 'USER0012', name: 'Yamauchi Kentaro', team: 'Other Team', role: 'Tester' }),
];

describe('V6.9-B resolveAttribution (§3 resolution flow)', () => {
  it('direct identity: memberId → correct member, high confidence', () => {
    const resolution = resolveAttribution({ kind: 'memberId', memberId: 'USER0003' }, [member()]);
    expect(resolution.status).toBe('resolved');
    if (resolution.status !== 'resolved') return;
    expect(resolution.memberId).toBe('USER0003');
    expect(resolution.method).toBe('memberId');
    expect(resolution.confidence).toBe('high');
  });

  it('historical identity: old name → correct member (date-valid history)', () => {
    const members = [member({ name: 'Yamauchi Kentaro', nameHistory: [{ name: 'Yamauchi K.', fromDate: '2026-07-01', toDate: '2026-09-30' }] })];
    const resolution = resolveAttribution({ kind: 'name', name: 'Yamauchi K.', contextDate: '2026-09-10' }, members);
    expect(resolution.status).toBe('resolved');
    if (resolution.status !== 'resolved') return;
    expect(resolution.memberId).toBe('USER0003');
    expect(resolution.method).toBe('historicalName');
    expect(resolution.confidence).toBe('high');
  });

  it('ambiguous identity: same historical name on multiple members → AMBIGUOUS, never a guess', () => {
    const resolution = resolveAttribution({ kind: 'name', name: 'Yamauchi Kentaro' }, AMBIGUOUS_MEMBERS);
    expect(resolution.status).toBe('ambiguous');
    if (resolution.status !== 'ambiguous') return;
    expect(resolution.candidateMemberIds.sort()).toEqual(['USER0003', 'USER0012']);
  });

  it('unknown identity: unknown name or id → UNRESOLVED', () => {
    expect(resolveAttribution({ kind: 'name', name: 'Nobody' }, [member()]).status).toBe('unresolved');
    expect(resolveAttribution({ kind: 'memberId', memberId: 'USER9999' }, [member()]).status).toBe('unresolved');
  });

  it('external identity: externalId → mapped memberId (no API involved)', () => {
    const resolution = resolveAttribution({ kind: 'externalId', provider: 'jira', externalId: 'yamauchi' }, [member()], [jiraLink()]);
    expect(resolution.status).toBe('resolved');
    if (resolution.status !== 'resolved') return;
    expect(resolution.memberId).toBe('USER0003');
    expect(resolution.method).toBe('externalId');
    expect(resolution.confidence).toBe('high');
  });

  it('duplicate external identity: one account mapped to two members → AMBIGUOUS (conflict)', () => {
    const links = [
      jiraLink(),
      jiraLink({ id: 'ext-2', memberId: 'USER0012' }),
    ];
    const members = [member(), member({ id: 'USER0012', name: 'Other Person' })];
    const resolution = resolveAttribution({ kind: 'externalId', provider: 'jira', externalId: 'yamauchi' }, members, links);
    expect(resolution.status).toBe('ambiguous');
    expect(uniqueExternalIdentityMembers(links, 'jira', 'yamauchi', members)).toEqual(['USER0003', 'USER0012']);
  });

  it('inactive external identities and unknown members never resolve', () => {
    const members = [member()];
    expect(resolveAttribution({ kind: 'externalId', provider: 'jira', externalId: 'old' }, members, [jiraLink({ active: false, externalId: 'old' })]).status).toBe('unresolved');
    expect(resolveAttribution({ kind: 'externalId', provider: 'github', externalId: 'yamauchi' }, members, [jiraLink()]).status).toBe('unresolved');
  });
});

describe('V6.9-B attribution audit (§4)', () => {
  it('builds an append-only audit entry for an automated resolution with method and confidence', () => {
    const resolution = resolveAttribution({ kind: 'externalId', provider: 'jira', externalId: 'yamauchi' }, [member()], [jiraLink()]);
    const entry = buildAttributionAuditEntry({
      recordType: 'execution',
      recordId: 'perf-1',
      recordDate: '2026-09-10',
      recordedName: 'yamauchi',
      previousState: 'unmatched',
      resolution,
      timestamp: '2026-09-30T01:02:03.000Z',
    });
    expect(entry.method).toBe('externalId');
    expect(entry.confidence).toBe('high');
    expect(entry.source).toBe('attributionResolution');
    expect(entry.resolvedMemberId).toBe('USER0003');
    // The existing append helper stays the single write path.
    const log = appendIdentityAuditEntries(undefined, [entry]);
    expect(log).toHaveLength(1);
    expect(isIdentityAuditEntry(log[0])).toBe(true);
  });

  it('audits ambiguous and unresolved outcomes as such (never a picked member)', () => {
    const ambiguous = resolveAttribution({ kind: 'name', name: 'Yamauchi Kentaro' }, AMBIGUOUS_MEMBERS);
    const entry = buildAttributionAuditEntry({
      recordType: 'attendance',
      recordId: 'att-1',
      recordedName: 'Yamauchi Kentaro',
      previousState: 'ambiguous',
      resolution: ambiguous,
      timestamp: '2026-09-30T00:00:00.000Z',
    });
    expect(entry.method).toBe('unresolved');
    expect(entry.confidence).toBe('ambiguous');
    expect(entry.resolvedMemberId).toBeUndefined();
  });
});

describe('V6.9-B attribution integrity (§5/§6)', () => {
  it('flags nonexistent memberId references as orphaned — without repairing anything', () => {
    const report = validateAttributionIntegrity({
      members: [member()],
      attendance: [attendance({ memberId: 'USER9999' })],
      projects: [project({ bugTickets: [ticket({ reporterMemberId: 'USER9999' })] })],
      reviews: [
        { id: 'rev-1', memberId: 'USER9999', testerName: 'x', periodType: 'h1', periodStart: '2026-01-01', periodEnd: '2026-06-30', status: 'draft', createdAt: 't', updatedAt: 't' },
      ],
      assignments: [
        { id: 'asg-1', projectId: 'PRJ-001', memberId: 'USER9999', startDate: '2026-09-01', active: true },
      ],
    });
    const orphaned = report.issues.filter((issue) => issue.issueType === 'orphaned');
    expect(orphaned.map((issue) => issue.entityType).sort()).toEqual(['attendance', 'bug', 'execution', 'report']);
    expect(report.counts.orphaned).toBe(4);
    expect(report.counts.missing).toBe(0);
  });

  it('flags execution records whose tester name resolves to nobody as missing', () => {
    const report = validateAttributionIntegrity({
      members: [member()],
      attendance: [],
      projects: [project({
        testerDailyPerformance: [{ id: 'perf-1', date: '2026-09-10', testerName: 'Ghost Tester', projectId: 'PRJ-001', casesTested: 10, source: 'manual' }],
      })],
    });
    const missing = report.issues.filter((issue) => issue.issueType === 'missing');
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ entityType: 'execution', entityId: 'perf-1', originalValue: 'Ghost Tester' });
  });

  it('reports a resolvable-but-unattributed record as missing WITH its candidate (distinguishable)', () => {
    const report = validateAttributionIntegrity({
      members: [member()],
      attendance: [attendance({ memberName: 'Yamauchi K.' })], // resolves uniquely, but no memberId yet
      projects: [],
    });
    const missing = report.issues.filter((issue) => issue.issueType === 'missing');
    expect(missing).toHaveLength(1);
    expect(missing[0].candidateMemberIds).toEqual(['USER0003']); // the suggested member is carried
  });

  it('flags ambiguous names and member name collisions as conflicts — never merges the members', () => {
    const report = validateAttributionIntegrity({
      members: AMBIGUOUS_MEMBERS,
      attendance: [attendance({ memberName: 'Yamauchi Kentaro' })],
      projects: [],
    });
    // The attendance record is ambiguous (two possible members) …
    expect(report.issues.some((issue) => issue.issueType === 'ambiguous' && issue.entityType === 'attendance')).toBe(true);
    // … and the shared name itself is reported as a member-level conflict.
    const conflict = report.issues.find((issue) => issue.issueType === 'conflict' && issue.entityType === 'member');
    expect(conflict).toBeDefined();
    expect(conflict!.candidateMemberIds!.sort()).toEqual(['USER0003', 'USER0012']);
  });

  it('flags conflicting and orphaned external identities', () => {
    const report = validateAttributionIntegrity({
      members: [member()],
      attendance: [],
      projects: [],
      externalIdentities: [
        jiraLink(),
        jiraLink({ id: 'ext-2', externalId: 'other', memberId: 'USER9999' }), // orphaned member
        jiraLink({ id: 'ext-3', memberId: 'USER0012' }), // same account, second member → conflict
      ],
    });
    expect(report.issues.some((issue) => issue.issueType === 'orphaned' && issue.entityType === 'externalIdentity')).toBe(true);
    const conflict = report.issues.find((issue) => issue.issueType === 'conflict' && issue.entityType === 'externalIdentity');
    expect(conflict).toBeDefined();
    expect(conflict!.candidateMemberIds!.sort()).toEqual(['USER0003', 'USER0012']);
  });

  it('reports clean data with zero issues (deterministic, sorted)', () => {
    const report = validateAttributionIntegrity({
      members: [member()],
      attendance: [attendance({ memberId: 'USER0003' }), attendance({ id: 'att-2', memberId: 'USER0003' })],
      projects: [project({
        bugTickets: [ticket({ reporterMemberId: 'USER0003' })],
        testerDailyPerformance: [{ id: 'perf-1', date: '2026-09-10', testerName: 'Yamauchi K.', memberId: 'USER0003', projectId: 'PRJ-001', casesTested: 10, source: 'manual' }],
      })],
      reviews: [{ id: 'rev-1', memberId: 'USER0003', testerName: 'Yamauchi K.', periodType: 'h1', periodStart: '2026-01-01', periodEnd: '2026-06-30', status: 'draft', createdAt: 't', updatedAt: 't' }],
      assignments: [{ id: 'asg-1', projectId: 'PRJ-001', memberId: 'USER0003', startDate: '2026-09-01', active: true }],
      externalIdentities: [jiraLink()],
    });
    expect(report.issues).toEqual([]);
    expect(report.counts).toEqual({ missing: 0, invalid: 0, ambiguous: 0, conflict: 0, orphaned: 0 });
  });

  it('kept-unresolved human decisions are final — not integrity issues', () => {
    const kept = attendance({ memberName: 'External Visitor', identityResolution: { method: 'manual', resolvedAt: '2026-09-30T00:00:00.000Z' } });
    const report = validateAttributionIntegrity({ members: [member()], attendance: [kept], projects: [] });
    expect(report.issues.filter((issue) => issue.entityType === 'attendance')).toEqual([]);
  });
});

describe('V6.9-B historical continuity (§11)', () => {
  it("changing a member's current name never splits their historical data", () => {
    // The member was RENAMED: old records say "Yamauchi K.", the current
    // name is "Yamauchi Kentaro", and the old name is in the name history.
    const members = [member({ name: 'Yamauchi Kentaro', nameHistory: [{ name: 'Yamauchi K.' }] })];
    const records: TesterDailyPerformance[] = [
      { id: 'p1', date: '2026-09-10', testerName: 'Yamauchi K.', projectId: 'PRJ-001', casesTested: 30, source: 'manual', memberId: 'USER0003' },
      { id: 'p2', date: '2026-09-11', testerName: 'Yamauchi Kentaro', projectId: 'PRJ-001', casesTested: 20, source: 'manual' },
      // Legacy record without memberId — resolves through the name history.
      { id: 'p3', date: '2026-09-12', testerName: 'Yamauchi K.', projectId: 'PRJ-001', casesTested: 10, source: 'manual' },
    ];
    const rows = aggregateTesterPerformance(records, [], { members });
    expect(rows).toHaveLength(1); // one person, one row — no split
    expect(rows[0].memberId).toBe('USER0003');
    expect(rows[0].casesTested).toBe(60);
  });

  it('two different members with similar names are never merged', () => {
    const members = [member(), member({ id: 'USER0004', name: 'Yamauchi K.' })]; // same display name
    const records: TesterDailyPerformance[] = [
      { id: 'p1', date: '2026-09-10', testerName: 'Yamauchi K.', projectId: 'PRJ-001', casesTested: 30, source: 'manual', memberId: 'USER0003' },
      { id: 'p2', date: '2026-09-10', testerName: 'Yamauchi K.', projectId: 'PRJ-001', casesTested: 20, source: 'manual', memberId: 'USER0004' },
    ];
    const rows = aggregateTesterPerformance(records, [], { members });
    expect(rows).toHaveLength(2); // memberId keeps the two people apart
  });
});

describe('V6.9-B storage & migration safety (§8)', () => {
  it('external identities round-trip through normalization; old payloads stay valid', () => {
    const links = [jiraLink()];
    const normalized = normalizeReportsState({
      ...emptyReportsState(),
      externalIdentities: links,
    });
    expect(normalized.externalIdentities).toEqual(links);
    // Pre-V6.9-B payloads (no field) normalize to [].
    const legacy = normalizeReportsState({ ...emptyReportsState() });
    expect(legacy.externalIdentities).toEqual([]);
  });

  it('malformed external identities are filtered deterministically without crashing', () => {
    const legacy = emptyReportsState();
    const malformed = { provider: '', externalId: 'x', memberId: 'USER0003', active: true, linkedAt: 't' };
    const normalized = normalizeReportsState({
      ...legacy,
      externalIdentities: [malformed as unknown as ExternalIdentity, jiraLink()],
    });
    expect(normalized.externalIdentities).toHaveLength(1);
    expect(isExternalIdentity(malformed)).toBe(false);
  });

  it('extended audit entries (automated methods + confidence) pass the shape guard', () => {
    const resolution = resolveAttribution({ kind: 'name', name: 'Yamauchi K.' }, [member()]);
    const entry = buildAttributionAuditEntry({
      recordType: 'execution',
      recordId: 'perf-1',
      recordedName: 'Yamauchi K.',
      previousState: 'unmatched',
      resolution,
      timestamp: '2026-09-30T00:00:00.000Z',
    });
    expect(isIdentityAuditEntry(entry)).toBe(true);
    // V6.9-A entries (manual/bulk, no confidence) stay valid.
    expect(isIdentityAuditEntry({
      id: 'a1', timestamp: 't', recordType: 'attendance', recordId: 'r1', recordedName: 'x',
      previousState: 'unmatched', method: 'manual', source: 'identityCenter',
    })).toBe(true);
  });

  it('loads a legacy persisted state (no V6.9-B fields) without crashing', () => {
    // A pre-V6.9-B payload: neither externalIdentities nor identityAuditLog.
    const legacy = emptyReportsState();
    delete (legacy as Partial<typeof legacy>).externalIdentities;
    delete (legacy as Partial<typeof legacy>).identityAuditLog;
    expect(isReportsState(legacy)).toBe(true);
    const loaded = normalizeReportsState(legacy);
    expect(loaded.externalIdentities).toEqual([]);
    expect(loaded.identityAuditLog).toEqual([]);
  });
});

function emptyReportsState(): import('../types').ReportsState {
  return {
    schemaVersion: 1,
    settings: {
      teams: ['PrV', 'RCS'],
      holidays: [],
      supervisorName: '',
      projectJiraUrl: '',
      templates: { en: '', ja: '' },
      progressRules: { working: 'totalCases', complete: 'totalCases' },
    },
    attendance: [],
    topics: [],
    reports: [],
    projects: [],
    activeProjectId: null,
    testerAssignments: [],
    reviews: [],
    rcsMembers: [member()],
    identityAuditLog: [],
  };
}

import { describe, expect, it } from 'vitest';
import {
  deriveJiraProjectKey,
  issueToBugTicket,
  JIRA_PRIORITY_TO_SEVERITY,
  mapJiraSeverity,
  mapJiraStatus,
  mergeImportedTickets,
  routeIssuesToProjects,
} from '../domain/jira';
import type { JiraIssue } from '../../shared/jira';
import type { CycleRecord } from '../../shared/qaRules';
import type { BugTicket, ProjectRecord, QaInputs } from '../types';
import { newProjectRecord } from '../domain/projects/lifecycle';
import { normalizeQaInputs } from '../lib/storage/storage';

const NOW = '2026-10-07T09:00:00.000Z';

const issue = (over: Partial<JiraIssue> = {}): JiraIssue => ({
  id: '10001',
  key: 'ABC-123',
  summary: 'Login fails on Safari',
  statusName: 'Open',
  statusCategoryName: 'To Do',
  typeName: 'Bug',
  priorityName: 'High',
  reporterName: 'Ken Ito',
  labels: [],
  created: '2026-10-07T01:00:00.000Z',
  affectedVersions: ['4.2.0'],
  descriptionPlain: '',
  ...over,
});

function inputs(): QaInputs {
  return normalizeQaInputs({
    totalCases: 100,
    currentTesters: 8,
    startTime: 13 * 60,
    targetFinish: 17 * 60,
    lunchStart: 0,
    lunchEnd: 0,
    perHourPerTester: 4,
    casesCompleted: 0,
    casesPassed: 0,
    startDate: '2026-09-28',
    targetCompletionDate: '2026-09-30',
    targetCompletionTime: '17:00',
    planningRows: [
      { id: 'row-1', date: '2026-09-28', plannedTesters: 8, absentTesters: 0, nonWorkingDay: false, note: '' },
    ],
  });
}

let projectSeq = 0;
interface ProjectOverrides {
  jiraProjectKey?: string;
  nameEn?: string;
  projectId?: string;
  /** undefined = no cycle; pass a string (or null) explicitly to set one. */
  cycleId?: string | null;
}
function project(over: ProjectOverrides = {}): ProjectRecord {
  projectSeq += 1;
  return {
    ...newProjectRecord(inputs(), { nameEn: over.nameEn ?? `Project ${projectSeq}`, jiraProjectKey: over.jiraProjectKey ?? '' }, NOW, []),
    projectId: over.projectId ?? `PRJ-${String(projectSeq).padStart(3, '0')}`,
    ...(over.cycleId === undefined ? {} : { cycleId: over.cycleId }),
  };
}

const cyc = (over: Partial<CycleRecord> = {}): CycleRecord => ({
  id: 'cyc_1',
  name: 'Release 4.2.0',
  version: '4.2.0',
  status: 'active',
  plannedStart: '2026-10-01',
  plannedEnd: '2026-10-31',
  completedAt: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...over,
});

describe('deriveJiraProjectKey', () => {
  it('returns the dash prefix of an issue key', () => {
    expect(deriveJiraProjectKey('ABC-123')).toBe('ABC');
    expect(deriveJiraProjectKey('ABC-123-456')).toBe('ABC');
    expect(deriveJiraProjectKey('QA-1')).toBe('QA');
  });

  it('returns null when there is no dash-prefix shape', () => {
    expect(deriveJiraProjectKey('ABC')).toBeNull();
    expect(deriveJiraProjectKey('')).toBeNull();
    expect(deriveJiraProjectKey('-123')).toBeNull();
  });
});

describe('routeIssuesToProjects', () => {
  it('routes an issue by key + affected version to the matching project', () => {
    const projects = [project({ jiraProjectKey: 'ABC', cycleId: 'cyc_1' })];
    const cycles = [cyc({ version: '4.2.0' })];
    const result = routeIssuesToProjects([issue({ key: 'ABC-1' })], projects, cycles);
    expect(result.unroutable).toEqual([]);
    expect(result.routed).toEqual([{ projectId: projects[0]!.projectId, issues: [issue({ key: 'ABC-1' })] }]);
  });

  it('an issue with no affected versions routes by key when exactly one key candidate exists', () => {
    const projects = [project({ jiraProjectKey: 'ABC', cycleId: 'cyc_1' })];
    const result = routeIssuesToProjects([issue({ key: 'ABC-9', affectedVersions: [] })], projects, [cyc()]);
    expect(result.routed).toHaveLength(1);
    expect(result.routed[0]!.projectId).toBe(projects[0]!.projectId);
  });

  it('no project carries the key → noProjectKey with no candidates', () => {
    const projects = [project({ jiraProjectKey: 'XYZ', cycleId: 'cyc_1' })];
    const result = routeIssuesToProjects([issue({ key: 'ABC-1' })], projects, [cyc()]);
    expect(result.routed).toEqual([]);
    expect(result.unroutable).toEqual([
      { issue: issue({ key: 'ABC-1' }), reason: 'noProjectKey', candidates: [] },
    ]);
  });

  it('a key with no dash-prefix shape → noProjectKey', () => {
    const projects = [project({ jiraProjectKey: 'ABC', cycleId: 'cyc_1' })];
    const result = routeIssuesToProjects([issue({ key: 'ABC' })], projects, [cyc()]);
    expect(result.unroutable[0]!.reason).toBe('noProjectKey');
  });

  it('key matched but no version intersection → noVersionMatch with the key-matched project names', () => {
    const projects = [project({ jiraProjectKey: 'ABC', nameEn: 'E-commerce', cycleId: 'cyc_1' })];
    const cycles = [cyc({ version: '4.3.0' })];
    const result = routeIssuesToProjects([issue({ key: 'ABC-1', affectedVersions: ['4.2.0'] })], projects, cycles);
    expect(result.routed).toEqual([]);
    expect(result.unroutable).toEqual([
      { issue: issue({ key: 'ABC-1', affectedVersions: ['4.2.0'] }), reason: 'noVersionMatch', candidates: ['E-commerce'] },
    ]);
  });

  it('multiple key candidates without affected versions → noVersionMatch with all candidates', () => {
    const projects = [
      project({ jiraProjectKey: 'ABC', nameEn: 'E-commerce', cycleId: 'cyc_1' }),
      project({ jiraProjectKey: 'ABC', nameEn: 'Payments', cycleId: 'cyc_2' }),
    ];
    const cycles = [cyc({ id: 'cyc_1' }), cyc({ id: 'cyc_2', version: '5.0.0' })];
    const result = routeIssuesToProjects([issue({ key: 'ABC-1', affectedVersions: [] })], projects, cycles);
    expect(result.routed).toEqual([]);
    expect(result.unroutable).toEqual([
      { issue: issue({ key: 'ABC-1', affectedVersions: [] }), reason: 'noVersionMatch', candidates: ['E-commerce', 'Payments'] },
    ]);
  });

  it('more than one project surviving key+version → ambiguous with the survivors', () => {
    const projects = [
      project({ jiraProjectKey: 'ABC', nameEn: 'E-commerce', cycleId: 'cyc_1' }),
      project({ jiraProjectKey: 'ABC', nameEn: 'Payments', cycleId: 'cyc_2' }),
    ];
    const cycles = [cyc({ id: 'cyc_1', version: '4.2.0' }), cyc({ id: 'cyc_2', version: '4.2.0' })];
    const result = routeIssuesToProjects([issue({ key: 'ABC-1' })], projects, cycles);
    expect(result.routed).toEqual([]);
    expect(result.unroutable).toEqual([
      { issue: issue({ key: 'ABC-1' }), reason: 'ambiguous', candidates: ['E-commerce', 'Payments'] },
    ]);
  });

  it('a project without jiraProjectKey is never a candidate', () => {
    const projects = [
      project({ jiraProjectKey: 'ABC', nameEn: 'E-commerce', cycleId: 'cyc_1' }),
      project({ nameEn: 'Legacy (no key)', cycleId: 'cyc_2' }),
    ];
    const cycles = [cyc({ id: 'cyc_1' }), cyc({ id: 'cyc_2', version: '4.2.0' })];
    // The unkeyed project must not steal this issue (its version matches!).
    const result = routeIssuesToProjects([issue({ key: 'ABC-1', affectedVersions: [] })], projects, cycles);
    expect(result.routed).toHaveLength(1);
    expect(result.routed[0]!.projectId).toBe(projects[0]!.projectId);

    // An issue keyed to the unkeyed project has no candidates at all.
    const noKey = routeIssuesToProjects([issue({ key: 'LEG-1', affectedVersions: ['4.2.0'] })], projects, cycles);
    expect(noKey.unroutable[0]!.reason).toBe('noProjectKey');
  });

  it('a project whose cycle is missing matches by key but its missing version matches nothing', () => {
    const projects = [project({ jiraProjectKey: 'ABC', nameEn: 'E-commerce' })]; // no cycleId
    // With affectedVersions there is no version to intersect → noVersionMatch.
    const versioned = routeIssuesToProjects([issue({ key: 'ABC-1', affectedVersions: ['4.2.0'] })], projects, []);
    expect(versioned.routed).toEqual([]);
    expect(versioned.unroutable).toEqual([
      { issue: issue({ key: 'ABC-1', affectedVersions: ['4.2.0'] }), reason: 'noVersionMatch', candidates: ['E-commerce'] },
    ]);
    // Without affectedVersions the single key candidate still routes.
    const keyed = routeIssuesToProjects([issue({ key: 'ABC-1', affectedVersions: [] })], projects, []);
    expect(keyed.routed).toHaveLength(1);
    expect(keyed.routed[0]!.projectId).toBe(projects[0]!.projectId);
  });

  it('an archived cycle without a version still key-matches but never version-matches', () => {
    const projects = [
      project({ jiraProjectKey: 'ABC', nameEn: 'Current', cycleId: 'cyc_1' }),
      project({ jiraProjectKey: 'ABC', nameEn: 'Archived', cycleId: 'cyc_2' }),
    ];
    const cycles = [cyc({ id: 'cyc_1', version: '4.2.0' }), cyc({ id: 'cyc_2', status: 'archived', version: undefined })];
    // Current survives the version filter; the archived one matches nothing.
    const result = routeIssuesToProjects([issue({ key: 'ABC-1' })], projects, cycles);
    expect(result.routed).toHaveLength(1);
    expect(result.routed[0]!.projectId).toBe(projects[0]!.projectId);
    // For a version-less issue both are key candidates → noVersionMatch.
    const versionless = routeIssuesToProjects([issue({ key: 'ABC-1', affectedVersions: [] })], projects, cycles);
    expect(versionless.unroutable[0]!.reason).toBe('noVersionMatch');
    expect(versionless.unroutable[0]!.candidates).toEqual(['Current', 'Archived']);
  });

  it('archived cycles WITH a version still version-match (cycle status is irrelevant)', () => {
    const projects = [project({ jiraProjectKey: 'ABC', cycleId: 'cyc_1' })];
    const cycles = [cyc({ status: 'archived', version: '4.2.0' })];
    const result = routeIssuesToProjects([issue({ key: 'ABC-1' })], projects, cycles);
    expect(result.routed[0]!.projectId).toBe(projects[0]!.projectId);
  });

  it('cycles passed out of order still resolve per project.cycleId', () => {
    const projects = [
      project({ jiraProjectKey: 'ABC', cycleId: 'cyc_b' }),
      project({ jiraProjectKey: 'ABC', cycleId: 'cyc_a' }),
    ];
    const cycles = [cyc({ id: 'cyc_a', version: '4.2.0' }), cyc({ id: 'cyc_b', version: '9.9.9' })];
    const result = routeIssuesToProjects([issue({ key: 'ABC-1' })], projects, cycles);
    expect(result.routed).toHaveLength(1);
    expect(result.routed[0]!.projectId).toBe(projects[1]!.projectId); // cyc_b → 9.9.9 no match
  });

  it('groups routed issues by project in project order; unroutable keeps input order', () => {
    const p1 = project({ jiraProjectKey: 'ABC', nameEn: 'E-commerce', cycleId: 'cyc_1' });
    const p2 = project({ jiraProjectKey: 'XYZ', nameEn: 'Payments', cycleId: 'cyc_2' });
    const cycles = [cyc({ id: 'cyc_1', version: '4.2.0' }), cyc({ id: 'cyc_2', version: '3.1.0' })];
    const issues = [
      issue({ key: 'ABC-1' }),
      issue({ key: 'XYZ-7', affectedVersions: ['3.1.0'] }),
      issue({ key: 'ABC-2' }),
      issue({ key: 'NOPE-1', affectedVersions: ['3.1.0'] }),
    ];
    const result = routeIssuesToProjects(issues, [p1, p2], cycles);
    expect(result.routed.map((g) => g.projectId)).toEqual([p1.projectId, p2.projectId]);
    expect(result.routed[0]!.issues.map((i) => i.key)).toEqual(['ABC-1', 'ABC-2']);
    expect(result.routed[1]!.issues.map((i) => i.key)).toEqual(['XYZ-7']);
    expect(result.unroutable.map((u) => u.issue.key)).toEqual(['NOPE-1']);
    expect(result.unroutable[0]!.reason).toBe('noProjectKey');
  });

  it('is pure: inputs are never mutated', () => {
    const projects = [project({ jiraProjectKey: 'ABC', cycleId: 'cyc_1' })];
    const cycles = [cyc()];
    const issues = [issue({ key: 'ABC-1' })];
    const before = JSON.stringify({ projects, cycles, issues });
    routeIssuesToProjects(issues, projects, cycles);
    expect(JSON.stringify({ projects, cycles, issues })).toBe(before);
  });
});

describe('JIRA_PRIORITY_TO_SEVERITY / mapJiraSeverity', () => {
  it('maps the documented priority groups to severities', () => {
    // Highest/Blocker/Critical → Critical
    expect(JIRA_PRIORITY_TO_SEVERITY.highest).toBe('Critical');
    expect(JIRA_PRIORITY_TO_SEVERITY.blocker).toBe('Critical');
    expect(JIRA_PRIORITY_TO_SEVERITY.critical).toBe('Critical');
    // High/Major → Major
    expect(JIRA_PRIORITY_TO_SEVERITY.high).toBe('Major');
    expect(JIRA_PRIORITY_TO_SEVERITY.major).toBe('Major');
    // Medium / medium-ish → Minor
    expect(JIRA_PRIORITY_TO_SEVERITY.medium).toBe('Minor');
    expect(JIRA_PRIORITY_TO_SEVERITY.normal).toBe('Minor');
    expect(JIRA_PRIORITY_TO_SEVERITY['medium high']).toBe('Minor');
    // Low/Lowest/Minor/Trivial → Trivial
    expect(JIRA_PRIORITY_TO_SEVERITY.low).toBe('Trivial');
    expect(JIRA_PRIORITY_TO_SEVERITY.lowest).toBe('Trivial');
    expect(JIRA_PRIORITY_TO_SEVERITY.minor).toBe('Trivial');
    expect(JIRA_PRIORITY_TO_SEVERITY.trivial).toBe('Trivial');
  });

  it('is case-insensitive and trims the input', () => {
    expect(mapJiraSeverity('  HIGHest ')).toBe('Critical');
    expect(mapJiraSeverity('low')).toBe('Trivial');
  });

  it('returns undefined for missing or unknown priority names', () => {
    expect(mapJiraSeverity(undefined)).toBeUndefined();
    expect(mapJiraSeverity('')).toBeUndefined();
    expect(mapJiraSeverity('  ')).toBeUndefined();
    expect(mapJiraSeverity('Urgent!')).toBeUndefined();
  });
});

describe('mapJiraStatus', () => {
  it('maps the exact BugStatus names case-insensitively', () => {
    expect(mapJiraStatus('Open', 'To Do')).toBe('Open');
    expect(mapJiraStatus('In Progress', 'In Progress')).toBe('In Progress');
    expect(mapJiraStatus('Resolved', 'Done')).toBe('Resolved');
    expect(mapJiraStatus('Closed', 'Done')).toBe('Closed');
    expect(mapJiraStatus('Rejected', 'Done')).toBe('Rejected');
    expect(mapJiraStatus('Duplicate', 'Done')).toBe('Duplicate');
    expect(mapJiraStatus('  open ', 'To Do')).toBe('Open');
  });

  it('falls back to the status category when the name is not an exact match', () => {
    expect(mapJiraStatus('To Do', 'To Do')).toBe('Open');
    expect(mapJiraStatus('In Progress', 'In Progress')).toBe('In Progress');
    expect(mapJiraStatus('Cancelled', 'Done')).toBe('Closed');
    expect(mapJiraStatus('Custom', 'In Progress')).toBe('In Progress');
  });

  it('is undefined for unknown names and categories', () => {
    expect(mapJiraStatus(undefined, undefined)).toBeUndefined();
    expect(mapJiraStatus('Weird', undefined)).toBeUndefined();
    expect(mapJiraStatus('Weird', 'Unknown Category')).toBeUndefined();
    expect(mapJiraStatus('', '')).toBeUndefined();
  });
});

describe('issueToBugTicket', () => {
  it('builds the full draft shape with mapped severity/status', () => {
    const draft = issueToBugTicket(
      issue({ priorityName: 'Blocker', statusName: 'In Progress', statusCategoryName: 'In Progress' }),
      'PRJ-001',
      'USER0001',
      'https://jira.example.com',
    );
    expect(draft).toEqual({
      projectId: 'PRJ-001',
      ticket: {
        projectId: 'PRJ-001',
        ticketKey: 'ABC-123',
        title: 'Login fails on Safari',
        url: 'https://jira.example.com/browse/ABC-123',
        createdAt: '2026-10-07',
        reportedBy: 'Ken Ito',
        reporterMemberId: 'USER0001',
        severity: 'Critical',
        status: 'In Progress',
      },
    });
  });

  it('trims trailing slashes from the base URL', () => {
    const draft = issueToBugTicket(issue({ key: 'ABC-7' }), 'PRJ-001', undefined, 'https://jira.example.com///');
    expect(draft.ticket.url).toBe('https://jira.example.com/browse/ABC-7');
  });

  it('an empty baseUrl yields a relative URL (documented degenerate)', () => {
    const draft = issueToBugTicket(issue({ key: 'ABC-7' }), 'PRJ-001', undefined, '  ');
    expect(draft.ticket.url).toBe('/browse/ABC-7');
  });

  it('converts created to Asia/Tokyo date, crossing the day boundary at 15:00Z', () => {
    expect(issueToBugTicket(issue({ created: '2026-10-07T14:59:59.000Z' }), 'PRJ-001', undefined, 'x').ticket.createdAt).toBe('2026-10-07');
    expect(issueToBugTicket(issue({ created: '2026-10-07T15:00:00.000Z' }), 'PRJ-001', undefined, 'x').ticket.createdAt).toBe('2026-10-08');
    expect(issueToBugTicket(issue({ created: '2026-10-07T01:00:00.000Z' }), 'PRJ-001', undefined, 'x').ticket.createdAt).toBe('2026-10-07');
  });

  it('missing or unparseable created → createdAt "" (documented: merge substitutes now)', () => {
    expect(issueToBugTicket(issue({ created: undefined }), 'PRJ-001', undefined, 'x').ticket.createdAt).toBe('');
    expect(issueToBugTicket(issue({ created: 'garbage' }), 'PRJ-001', undefined, 'x').ticket.createdAt).toBe('');
  });

  it('missing reporter name → reportedBy ""; unmatched member → reporterMemberId absent', () => {
    const draft = issueToBugTicket(issue({ reporterName: undefined }), 'PRJ-001', undefined, 'x');
    expect(draft.ticket.reportedBy).toBe('');
    expect('reporterMemberId' in draft.ticket).toBe(false);
  });

  it('unmappable severity/status stay absent; memo and identityResolution are never touched', () => {
    const draft = issueToBugTicket(issue({ priorityName: 'Bizarre', statusName: 'Weird', statusCategoryName: undefined }), 'PRJ-001', 'U1', 'x');
    expect('severity' in draft.ticket).toBe(false);
    expect('status' in draft.ticket).toBe(false);
    expect(draft.ticket.memo).toBeUndefined();
    expect(draft.ticket.identityResolution).toBeUndefined();
  });
});

describe('mergeImportedTickets', () => {
  const draft = (over: Partial<BugTicket> = {}): BugTicket => ({
    id: 'draft-id-unused', // drafts never carry a real id; merge assigns one
    projectId: 'PRJ-001',
    ticketKey: 'ABC-100',
    title: 'Login fails on Safari',
    url: 'https://jira.example.com/browse/ABC-100',
    createdAt: '2026-09-10',
    reportedBy: 'Sato',
    ...over,
  });

  const existing = (over: Partial<BugTicket> = {}): BugTicket => ({
    id: 'ticket-legacy-1',
    projectId: 'PRJ-001',
    ticketKey: 'ABC-100',
    title: 'Old title',
    url: 'https://jira.example.com/browse/ABC-100',
    createdAt: '2026-08-01',
    reportedBy: 'Old reporter',
    severity: 'Major',
    status: 'Open',
    memo: 'keep me',
    identityResolution: { method: 'manual', resolvedAt: '2026-08-02T00:00:00.000Z', memberId: 'U9' },
    ...over,
  });

  const asDraft = (t: BugTicket): Parameters<typeof mergeImportedTickets>[1][number] => ({
    projectId: t.projectId,
    ticket: {
      projectId: t.projectId,
      ticketKey: t.ticketKey,
      title: t.title,
      url: t.url,
      createdAt: t.createdAt,
      reportedBy: t.reportedBy,
      reporterMemberId: t.reporterMemberId,
      severity: t.severity,
      status: t.status,
    },
  });

  it('creates a new ticket with a deterministic id and the draft createdAt', () => {
    const d = asDraft(draft());
    const result = mergeImportedTickets([], [d], '2026-10-07');
    expect(result.next).toHaveLength(1);
    expect(result.next[0]!.id).toBe('tkt_PRJ-001_ABC-100');
    expect(result.next[0]!.createdAt).toBe('2026-09-10');
    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.unchanged).toBe(0);
  });

  it('uses the provided now date when the draft has no createdAt', () => {
    const d = asDraft(draft({ createdAt: '' }));
    const result = mergeImportedTickets([], [d], '2026-10-07');
    expect(result.next[0]!.createdAt).toBe('2026-10-07');
  });

  it('updates an existing key only from the draft, preserving id, memo and identityResolution', () => {
    const e = existing();
    const d = asDraft(
      draft({ title: 'New title', url: 'https://jira.example.com/browse/ABC-100', severity: 'Critical', status: 'Closed', reportedBy: 'New reporter', reporterMemberId: 'U2', createdAt: '2026-09-11' }),
    );
    const result = mergeImportedTickets([e], [d], '2026-10-07');
    const merged = result.next[0]!;
    expect(merged.id).toBe('ticket-legacy-1');
    expect(merged.memo).toBe('keep me');
    expect(merged.identityResolution).toEqual(e.identityResolution);
    expect(merged.title).toBe('New title');
    expect(merged.severity).toBe('Critical');
    expect(merged.status).toBe('Closed');
    expect(merged.reportedBy).toBe('New reporter');
    expect(merged.reporterMemberId).toBe('U2');
    expect(merged.createdAt).toBe('2026-09-11');
    expect(result.updated).toBe(1);
    expect(result.created).toBe(0);
    expect(result.unchanged).toBe(0);
  });

  it('counts identical drafts as unchanged and keeps the existing object reference', () => {
    const e = existing();
    const d = asDraft(
      draft({ title: 'Old title', severity: 'Major', status: 'Open', reportedBy: 'Old reporter', createdAt: '2026-08-01' }),
    );
    const result = mergeImportedTickets([e], [d], '2026-10-07');
    expect(result.updated).toBe(0);
    expect(result.unchanged).toBe(1);
    expect(result.next[0]).toBe(e); // same reference — untouched
  });

  it('a draft with unknown createdAt never overwrites an existing date', () => {
    const e = existing();
    const d = asDraft(
      draft({ title: 'Old title', severity: 'Major', status: 'Open', reportedBy: 'Old reporter', createdAt: '' }),
    );
    const result = mergeImportedTickets([e], [d], '2026-10-07');
    expect(result.unchanged).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.next[0]!.createdAt).toBe('2026-08-01');

    // A real difference alongside '' still updates and keeps the date.
    const d2 = asDraft(
      draft({ title: 'Brand new title', createdAt: '' }),
    );
    const result2 = mergeImportedTickets([e], [d2], '2026-10-07');
    expect(result2.updated).toBe(1);
    expect(result2.next[0]!.title).toBe('Brand new title');
    expect(result2.next[0]!.createdAt).toBe('2026-08-01');
  });

  it('clears severity/status when the draft has none (update-only fields)', () => {
    const e = existing();
    const d = asDraft(draft({ title: 'Old title', reportedBy: 'Old reporter' }));
    const result = mergeImportedTickets([e], [d], '2026-10-07');
    expect(result.updated).toBe(1);
    expect(result.next[0]!.severity).toBeUndefined();
    expect(result.next[0]!.status).toBeUndefined();
  });

  it('collapses duplicate drafts with the same key onto one ticket', () => {
    const d1 = asDraft(draft({ ticketKey: 'ABC-200', title: 'First' }));
    const d2 = asDraft(draft({ ticketKey: 'ABC-200', title: 'First' }));
    const result = mergeImportedTickets([], [d1, d2], '2026-10-07');
    expect(result.next).toHaveLength(1);
    expect(result.created).toBe(1);
    expect(result.unchanged).toBe(1);
  });

  it('leaves tickets with other keys untouched and is pure', () => {
    const e = existing();
    const other = existing({ id: 'ticket-2', ticketKey: 'XYZ-1' });
    const before = JSON.stringify([e, other]);
    const d = asDraft(draft({ ticketKey: 'ABC-100', title: 'New title' }));
    const result = mergeImportedTickets([e, other], [d], '2026-10-07');
    expect(JSON.stringify([e, other])).toBe(before); // inputs never mutated
    expect(result.next).toHaveLength(2);
    expect(result.next[1]).toBe(other);
    expect(result.updated).toBe(1);
  });
});
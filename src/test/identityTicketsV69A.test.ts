import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BugTicket, ProjectRecord, QaInputs, RcsMember, ReportsState } from '../types';
import { DEMO_STATE, isBugTicket, normalizeQaInputs } from '../lib/storage/storage';
import { defaultReportsState, loadReportsState, saveReportsState } from '../lib/storage/reports';
import { createBackupPayload, parseBackupPayload } from '../lib/backup/backup';
import { newProjectRecord } from '../domain/projects/lifecycle';
import { collectIdentityIssues, migrateBugTicketIdentity, migrateProjectBugTickets, resolveBugTicket } from '../domain/identityResolution';
import { aggregateTesterPerformance } from '../lib/calculations/testerPerformance';
import { attendanceSheet, bugTicketsSheet } from '../lib/export/exportData';

/**
 * V6.9-A §39 — bug-ticket identity: reporterMemberId on new tickets,
 * conservative legacy migration, external/unknown reporters, bug discovery
 * attribution by stable identity without double counting, backup/restore
 * and exports.
 */

class MemoryStorage {
  map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal('window', { localStorage: storage });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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

function ticket(overrides: Partial<BugTicket> = {}): BugTicket {
  return {
    id: 't1',
    projectId: 'PRJ-001',
    ticketKey: 'ABC-100',
    title: 'Login fails on Safari',
    url: 'https://jira.example.com/browse/ABC-100',
    createdAt: '2026-09-10',
    reportedBy: 'Yamauchi Kentaro',
    ...overrides,
  };
}

function baseInputs(): QaInputs {
  return normalizeQaInputs({
    totalCases: 100,
    currentTesters: 8,
    startTime: 13 * 60,
    targetFinish: 17 * 60,
    lunchStart: 0,
    lunchEnd: 0,
    perHourPerTester: 4,
    casesCompleted: 0,
    startDate: '2026-09-28',
    targetCompletionDate: '2026-09-30',
    targetCompletionTime: '17:00',
    planningRows: [{ id: 'row-1', date: '2026-09-28', plannedTesters: 8, absentTesters: 0, nonWorkingDay: false, note: '' }],
  });
}

function project(tickets: readonly BugTicket[] = []): ProjectRecord {
  const record = newProjectRecord(baseInputs(), { nameEn: 'Project A' }, '2026-09-01T00:00:00.000Z', []);
  return { ...record, projectId: 'PRJ-001', inputs: { ...record.inputs, bugTickets: [...tickets] } };
}

describe('V6.9-A bug ticket identity model', () => {
  it('stores reporterMemberId with a reportedBy snapshot and validates the shape', () => {
    const t = ticket({ reporterMemberId: 'USER0003', reportedBy: 'Yamauchi K.' });
    expect(isBugTicket(t)).toBe(true);
    expect(t.reporterMemberId).toBe('USER0003');
    expect(t.reportedBy).toBe('Yamauchi K.'); // snapshot/history preserved
    expect(isBugTicket({ ...t, reporterMemberId: 3 as unknown as string })).toBe(false);
    expect(isBugTicket(ticket())).toBe(true); // legacy shape stays valid
    expect(isBugTicket({ ...t, identityResolution: { method: 'auto' as unknown as 'manual', resolvedAt: 'x' } })).toBe(false);
  });

  it('external / unknown reporters keep reporterMemberId undefined', () => {
    const t = ticket({ reportedBy: 'External Vendor X' });
    expect(t.reporterMemberId).toBeUndefined();
    expect(isBugTicket(t)).toBe(true);
  });
});

describe('V6.9-A bug ticket migration', () => {
  it('migrates a unique reporter (current name or history) and preserves reportedBy', () => {
    const members = [member({ nameHistory: [{ name: 'Yamauchi Kentaro' }] })];
    const result = migrateBugTicketIdentity([ticket()], members);
    expect(result.resolved).toHaveLength(1);
    expect(result.tickets[0].reporterMemberId).toBe('USER0003');
    expect(result.tickets[0].reportedBy).toBe('Yamauchi Kentaro'); // never rewritten
  });

  it('preserves unmatched and ambiguous tickets verbatim', () => {
    const members = [
      member({ nameHistory: [{ name: 'Yamauchi Kentaro' }] }),
      member({ id: 'USER0012', name: 'Yamauchi Kentaro' }),
    ];
    const result = migrateBugTicketIdentity(
      [ticket({ id: 't1', reportedBy: 'External Vendor' }), ticket({ id: 't2' })],
      members,
    );
    expect(result.resolved).toHaveLength(0);
    expect(result.unmatched.map((t) => t.id)).toEqual(['t1']);
    expect(result.ambiguous.map((t) => t.id)).toEqual(['t2']);
    expect(result.tickets.every((t) => t.reporterMemberId === undefined)).toBe(true);
  });

  it('is idempotent and never overwrites manual resolutions', () => {
    const members = [member({ nameHistory: [{ name: 'Yamauchi Kentaro' }] })];
    const first = migrateBugTicketIdentity([ticket()], members);
    const second = migrateBugTicketIdentity(first.tickets, members);
    expect(second.tickets).toEqual(first.tickets);
    const manually = resolveBugTicket(ticket({ id: 't9', reportedBy: 'Who' }), undefined, '2026-09-30T00:00:00.000Z');
    const result = migrateBugTicketIdentity([manually], members);
    expect(result.resolved).toHaveLength(0);
    expect(result.tickets[0].identityResolution?.method).toBe('manual');
  });

  it('migrates project tickets through normalizeReportsState on load', () => {
    const members = [member({ nameHistory: [{ name: 'Yamauchi Kentaro' }] })];
    const state: ReportsState = {
      ...defaultReportsState(),
      rcsMembers: members,
      projects: [project([ticket()])],
    };
    saveReportsState(state);
    const loaded = loadReportsState();
    expect(loaded.projects[0].inputs.bugTickets![0].reporterMemberId).toBe('USER0003');
  });

  it('migrateProjectBugTickets aggregates across projects without touching empty ones', () => {
    const members = [member({ nameHistory: [{ name: 'Yamauchi Kentaro' }] })];
    const projects = [project([ticket()]), project([])];
    const { projects: next, migration } = migrateProjectBugTickets(projects, members);
    expect(migration.resolved).toHaveLength(1);
    expect(next[0].inputs.bugTickets![0].reporterMemberId).toBe('USER0003');
    expect(next[1].inputs.bugTickets).toEqual([]);
  });
});

describe('V6.9-A bug discovery attribution', () => {
  const members = [member({ nameHistory: [{ name: 'Yamauchi Kentaro' }] })];

  it('attributes a ticket through reporterMemberId even when reportedBy differs', () => {
    const records = [
      { id: 'r1', date: '2026-09-10', testerName: 'Yamauchi K.', memberId: 'USER0003', projectId: 'PRJ-001', casesTested: 100 },
    ];
    const tickets = [ticket({ reporterMemberId: 'USER0003', reportedBy: 'Old Display Name' })];
    const rows = aggregateTesterPerformance(records, tickets, { members });
    expect(rows).toHaveLength(1);
    expect(rows[0].bugsFound).toBe(1);
    expect(rows[0].bugDiscoveryRate).toBe(10); // 1 / 100 × 1000
  });

  it('attributes a legacy ticket through the name resolver (current or history)', () => {
    const records = [
      { id: 'r1', date: '2026-09-10', testerName: 'Yamauchi K.', memberId: 'USER0003', projectId: 'PRJ-001', casesTested: 50 },
    ];
    const tickets = [ticket()]; // reportedBy 'Yamauchi Kentaro' → history → USER0003
    const rows = aggregateTesterPerformance(records, tickets, { members });
    expect(rows).toHaveLength(1);
    expect(rows[0].bugsFound).toBe(1);
  });

  it('leaves external/unknown reporters unattributed (no false attribution)', () => {
    const records = [
      { id: 'r1', date: '2026-09-10', testerName: 'Yamauchi K.', memberId: 'USER0003', projectId: 'PRJ-001', casesTested: 50 },
    ];
    const tickets = [ticket({ reportedBy: 'External Vendor' })];
    const rows = aggregateTesterPerformance(records, tickets, { members });
    // The external ticket creates its own (bugs-only) row — never attributed to USER0003.
    const yamauchi = rows.find((r) => r.memberId === 'USER0003')!;
    expect(yamauchi.bugsFound).toBe(0);
    const external = rows.find((r) => r.testerName === 'External Vendor')!;
    expect(external.bugsFound).toBe(1);
    expect(rows).toHaveLength(2);
  });

  it('never double counts: one ticket attributed to at most one member', () => {
    const records = [
      { id: 'r1', date: '2026-09-10', testerName: 'Yamauchi K.', memberId: 'USER0003', projectId: 'PRJ-001', casesTested: 50 },
      { id: 'r2', date: '2026-09-11', testerName: 'Yamauchi Kentaro', projectId: 'PRJ-001', casesTested: 50 }, // legacy same person
    ];
    const tickets = [ticket({ reporterMemberId: 'USER0003' })];
    const rows = aggregateTesterPerformance(records, tickets, { members });
    expect(rows).toHaveLength(1); // legacy name + memberId unify into one row
    expect(rows[0].casesTested).toBe(100);
    expect(rows[0].bugsFound).toBe(1); // counted once
  });
});

describe('V6.9-A ticket identity in exports and backup', () => {
  it('exports reporter member identity columns alongside the recorded reporter', () => {
    const members = [member()];
    const tickets = [
      ticket({ reporterMemberId: 'USER0003', reportedBy: 'Yamauchi Kentaro' }),
      ticket({ id: 't2', reportedBy: 'External Vendor' }),
    ];
    const sheet = bugTicketsSheet('en', tickets, [project(tickets)], members);
    const headerIndex = sheet.headers.indexOf('Reporter Member ID');
    expect(headerIndex).toBeGreaterThan(0);
    const memberRow = sheet.rows[0];
    expect(memberRow[headerIndex]).toBe('USER0003');
    expect(memberRow[headerIndex + 1]).toBe('Yamauchi K.'); // current member name
    expect(memberRow[5]).toBe('Yamauchi Kentaro'); // recorded name preserved
    const externalRow = sheet.rows[1];
    expect(externalRow[headerIndex]).toBe('');
    expect(externalRow[headerIndex + 1]).toBe('');
  });

  it('exports attendance member identity columns', () => {
    const sheet = attendanceSheet(
      'en',
      [{ id: 'a1', date: '2026-09-10', memberName: 'Yamauchi Kentaro', memberId: 'USER0003', team: 'RCS', status: 'PRESENT', workingStart: null, workingEnd: null, leaveType: null, comment: '' }],
      [member()],
    );
    const idIndex = sheet.headers.indexOf('Member ID');
    const nameIndex = sheet.headers.indexOf('Member Name (current)');
    expect(idIndex).toBeGreaterThan(0);
    const row = sheet.rows[0];
    expect(row[idIndex]).toBe('USER0003');
    expect(row[nameIndex]).toBe('Yamauchi K.');
    expect(row[1]).toBe('Yamauchi Kentaro'); // recorded name preserved
  });

  it('round-trips ticket identity through backup/restore', () => {
    const state: ReportsState = {
      ...defaultReportsState(),
      rcsMembers: [member({ nameHistory: [{ name: 'Yamauchi Kentaro' }] })],
      projects: [project([ticket({ reporterMemberId: 'USER0003', reportedBy: 'Yamauchi Kentaro' })])],
    };
    const payload = createBackupPayload(DEMO_STATE, state);
    const parsed = parseBackupPayload(JSON.stringify(payload));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const restored = parsed.data.reportsState.projects[0].inputs.bugTickets![0];
    expect(restored.reporterMemberId).toBe('USER0003');
    expect(restored.reportedBy).toBe('Yamauchi Kentaro');
  });

  it('collects ticket identity issues for the Identity Resolution Center', () => {
    const members = [
      member({ nameHistory: [{ name: 'Yamauchi Kentaro' }] }),
      member({ id: 'USER0012', name: 'Yamauchi Kentaro' }),
    ];
    const issues = collectIdentityIssues(
      [],
      [
        project([
          ticket({ id: 't1', reportedBy: 'External Vendor' }),
          ticket({ id: 't2' }),
          ticket({ id: 't3', reporterMemberId: 'USER0005' }),
          resolveBugTicket(ticket({ id: 't4', reportedBy: 'Who' }), 'USER0003', '2026-09-30T00:00:00.000Z'),
        ]),
      ],
      members,
    );
    expect(issues.tickets.map((i) => i.ticketId)).toEqual(['t1', 't2']);
    expect(issues.tickets[0].kind).toBe('unmatched');
    expect(issues.tickets[1].kind).toBe('ambiguous');
    expect(issues.tickets[1].candidates.map((c) => c.memberId)).toEqual(['USER0003', 'USER0012']);
    expect(issues.resolvedTickets.map((r) => r.ticketId)).toEqual(['t4']);
    expect(issues.resolvedTickets[0].audit.memberId).toBe('USER0003');
  });
});

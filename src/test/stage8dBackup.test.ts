import { describe, expect, it } from 'vitest';
import { createBackupPayload, parseBackupPayload } from '../lib/backup/backup';
import { createProjectBackupPayload, importProjectIntoRegistry, parseProjectBackupPayload } from '../lib/backup/projectBackup';
import { sanitizeRestoredAccountLinks } from '../lib/backup/restoreLinks';
import { defaultReportsState, normalizeReportsState } from '../lib/storage/reports';
import { DEMO_STATE, normalizeQaInputs } from '../lib/storage/storage';
import { newProjectRecord } from '../domain/projects/lifecycle';
import { dailyPlanId, meetingNoteId } from '../../shared/meeting';
import type { AppState, DailyTeamPlan, MeetingNote, ProjectRecord, QaInputs, RcsMember, ReportsState, TesterProjectAssignment, TestScope } from '../types';

const NOW = '2026-10-08T09:00:00.000Z';
const inputs = (over: Partial<QaInputs> = {}): QaInputs => normalizeQaInputs({ ...(DEMO_STATE as QaInputs), totalCases: 10, ...over });
const project = (projectId: string, id: string, over: Partial<QaInputs> = {}, extra: Partial<ProjectRecord> = {}): ProjectRecord => ({ ...newProjectRecord(inputs(over), { nameEn: `Project ${projectId}`, status: 'ongoing' }, NOW, []), id, projectId, ...extra });
const scope = (id: string, projectId: string, total?: number): TestScope => ({ id, projectId, name: `Scope ${id}`, code: id.toUpperCase().slice(0, 4), status: 'active', order: 10, createdAt: NOW, updatedAt: NOW, ...(total === undefined ? {} : { totalTestCases: total }) });
const plan = (date: string, projectId: string, n: number, scopeId?: string): DailyTeamPlan => ({ id: dailyPlanId(date, projectId, scopeId), date, projectId, ...(scopeId === undefined ? {} : { scopeId }), plannedCases: n, createdAt: NOW, updatedAt: NOW });
const note = (date: string, morning: string): MeetingNote => ({ id: meetingNoteId(date), date, morning, createdAt: NOW, updatedAt: NOW });
const member = (id: string, name: string, over: Partial<RcsMember> = {}): RcsMember => ({ id, name, team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true, ...over });
const A = project('PRJ-001', 'a');
const B = project('PRJ-002', 'b');

const full = (): { app: AppState; reports: ReportsState } => ({
  app: { ...(DEMO_STATE as AppState) },
  reports: {
    ...defaultReportsState(),
    projects: [A, B],
    activeProjectId: 'a',
    rcsMembers: [member('USER0001', 'Hana Sato', { email: 'hana@rakuten.com', userId: 'usr_hana' }), member('USER0002', 'Taro Tanaka', { email: 'taro@rakuten.com' }), member('USER0003', 'Gone', { active: false, endDate: '2026-09-30', removedAt: NOW })],
    scopes: [scope('scp_a', 'PRJ-001', 134), scope('scp_b', 'PRJ-002', 90)],
    dailyPlans: [plan('2026-10-08', 'PRJ-001', 80, 'scp_a'), plan('2026-10-09', 'PRJ-001', 145), plan('2026-10-08', 'PRJ-002', 35)],
    meetingNotes: [note('2026-10-08', 'Finish Ecosystem')],
  },
});

describe('full backup', () => {
  it('round-trips the authoritative Totals, profiles (with email, link metadata and removed state), plans and notes', () => {
    const { app, reports } = full();
    const parsed = parseBackupPayload(JSON.stringify(createBackupPayload(app, reports)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const r = parsed.data.reportsState;
    expect(r.scopes?.map((s) => [s.id, s.totalTestCases])).toEqual([['scp_a', 134], ['scp_b', 90]]);
    expect(r.rcsMembers?.map((m) => [m.id, m.email, m.userId, m.active, m.removedAt !== undefined])).toEqual([
      ['USER0001', 'hana@rakuten.com', 'usr_hana', true, false],
      ['USER0002', 'taro@rakuten.com', undefined, true, false],
      ['USER0003', undefined, undefined, false, true],
    ]);
    expect(r.dailyPlans?.map((p) => p.id).sort()).toEqual(reports.dailyPlans?.map((p) => p.id).sort());
    expect(r.meetingNotes?.[0]).toMatchObject({ date: '2026-10-08', morning: 'Finish Ecosystem' });
  });

  it('carries no credentials or session material', () => {
    const text = JSON.stringify(createBackupPayload(full().app, full().reports));
    expect(text).not.toMatch(/token|secret|password|cookie|jwt|authorization/i);
  });

  it('a Stage 8C backup (no plans, notes, emails or Totals) still imports, with nothing invented', () => {
    const { app, reports } = full();
    const old = createBackupPayload(app, { ...reports, dailyPlans: undefined, meetingNotes: undefined, scopes: [scope('scp_a', 'PRJ-001')], rcsMembers: [member('USER0001', 'Old Member')] });
    const raw = JSON.parse(JSON.stringify(old));
    delete raw.data.reportsState.dailyPlans;
    delete raw.data.reportsState.meetingNotes;
    const parsed = parseBackupPayload(JSON.stringify(raw));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.reportsState.dailyPlans).toEqual([]);
    expect(parsed.data.reportsState.meetingNotes).toEqual([]);
    expect(parsed.data.reportsState.scopes?.[0].totalTestCases).toBeUndefined();
    expect(parsed.data.reportsState.rcsMembers?.[0].email).toBeUndefined();
  });

  it('damaged plans and notes are dropped, never repaired', () => {
    const { reports } = full();
    const damaged = normalizeReportsState({ ...reports, dailyPlans: [...(reports.dailyPlans ?? []), { id: 'junk' } as never], meetingNotes: [{ id: 'x' } as never] });
    expect(damaged.dailyPlans).toHaveLength(3);
    expect(damaged.meetingNotes).toEqual([]);
  });
});

describe('restoring a file never binds or changes a login link', () => {
  const current: ReportsState = {
    ...defaultReportsState(),
    rcsMembers: [member('USER0001', 'Hana', { userId: 'usr_hana', email: 'hana@rakuten.com', role: 'Tester' }), member('USER0002', 'Taro', { email: 'taro@rakuten.com' })],
    testerAssignments: [{ id: 'asg-1', projectId: 'PRJ-001', userId: 'usr_hana', memberId: 'USER0001', startDate: '2026-10-01', active: true }],
  };

  it('a profile keeps the link, email, role and state the workspace has now', () => {
    const file: ReportsState = { ...defaultReportsState(), rcsMembers: [member('USER0001', 'Hana (old file)', { userId: 'usr_FOREIGN', email: 'other@x.com', role: 'SV', active: false })] };
    const out = sanitizeRestoredAccountLinks(file, current).rcsMembers!;
    expect(out.find((m) => m.id === 'USER0001')).toMatchObject({ name: 'Hana (old file)', userId: 'usr_hana', email: 'hana@rakuten.com', role: 'Tester', active: true });
  });

  it('an unlinked profile in the file stays unlinked whatever the file says; a linked profile missing from the file is kept', () => {
    const file: ReportsState = { ...defaultReportsState(), rcsMembers: [member('USER0002', 'Taro', { userId: 'usr_SNEAKY', email: 'taro@rakuten.com' })] };
    const out = sanitizeRestoredAccountLinks(file, current).rcsMembers!;
    expect(out.find((m) => m.id === 'USER0002')!.userId).toBeUndefined();
    expect(out.find((m) => m.id === 'USER0001')).toMatchObject({ userId: 'usr_hana' });
  });

  it('an email already carried by another profile is dropped (emails stay unique)', () => {
    const file: ReportsState = { ...defaultReportsState(), rcsMembers: [member('USER0009', 'Newcomer', { email: 'hana@rakuten.com' }), member('USER0010', 'Fresh', { email: 'fresh@rakuten.com' })] };
    const out = sanitizeRestoredAccountLinks(file, current).rcsMembers!;
    expect(out.find((m) => m.id === 'USER0009')!.email).toBeUndefined();
    expect(out.find((m) => m.id === 'USER0010')!.email).toBe('fresh@rakuten.com');
  });

  it('an assignment keeps its account only if this workspace has the same assignment for the same account; the business assignment survives', () => {
    const same: TesterProjectAssignment = { id: 'asg-1', projectId: 'PRJ-001', userId: 'usr_hana', memberId: 'USER0001', startDate: '2026-10-01', active: true };
    const foreign: TesterProjectAssignment = { id: 'asg-2', projectId: 'PRJ-001', userId: 'usr_FOREIGN', memberId: 'USER0002', testerName: 'Taro', scopeId: 'scp_a', startDate: '2026-10-01', active: true };
    const out = sanitizeRestoredAccountLinks({ ...defaultReportsState(), testerAssignments: [same, foreign] }, current).testerAssignments!;
    expect(out[0].userId).toBe('usr_hana');
    expect(out[1].userId).toBeUndefined();
    expect(out[1]).toMatchObject({ memberId: 'USER0002', scopeId: 'scp_a', projectId: 'PRJ-001', active: true });
  });

  it('into a workspace with no logins (Local storage) every link in the file is dropped', () => {
    const file: ReportsState = { ...defaultReportsState(), rcsMembers: [member('USER0001', 'Hana', { userId: 'usr_hana' })], testerAssignments: [{ ...current.testerAssignments![0] }] };
    const out = sanitizeRestoredAccountLinks(file, defaultReportsState());
    expect(out.rcsMembers![0].userId).toBeUndefined();
    expect(out.testerAssignments![0].userId).toBeUndefined();
  });
});

describe('single-project export and import', () => {
  const plans = full().reports.dailyPlans!;

  it('exports THIS project\'s plans and nothing of another project, and never the workspace\'s meeting notes', () => {
    const payload = createProjectBackupPayload(A, [], NOW, { scopes: full().reports.scopes }, plans);
    expect(payload.data.dailyPlans?.map((p) => p.id).sort()).toEqual([dailyPlanId('2026-10-08', 'PRJ-001', 'scp_a'), dailyPlanId('2026-10-09', 'PRJ-001')].sort());
    const text = JSON.stringify(payload);
    expect(text).not.toContain('PRJ-002');
    expect(text).not.toContain('Finish Ecosystem');
    expect(createProjectBackupPayload(project('PRJ-009', 'z'), [], NOW, undefined, plans).data.dailyPlans).toBeUndefined(); // old format when there is none
  });

  it('imports plans re-pointed at the imported project and its (re-identified) scopes; scope Totals are preserved', () => {
    const payload = createProjectBackupPayload(A, [], NOW, { scopes: full().reports.scopes }, plans);
    const parsed = parseProjectBackupPayload(JSON.stringify(payload));
    if (!parsed.ok) throw new Error('parse');
    const merged = importProjectIntoRegistry([A], [], parsed.data, { existing: { scopes: full().reports.scopes, testCases: [] } });
    const newProjectId = merged.importedProject.projectId;
    expect(newProjectId).not.toBe('PRJ-001');
    expect(merged.testManagement.scopes[0].totalTestCases).toBe(134);
    const scopeId = merged.testManagement.scopes[0].id;
    expect(scopeId).not.toBe('scp_a');
    expect(merged.dailyPlans.map((p) => p.id).sort()).toEqual([dailyPlanId('2026-10-08', newProjectId, scopeId), dailyPlanId('2026-10-09', newProjectId)].sort());
    for (const p of merged.dailyPlans) expect(p.projectId).toBe(newProjectId);
  });

  it('a plan whose scope is not in the file is dropped, not guessed', () => {
    const payload = createProjectBackupPayload(A, [], NOW, undefined, plans); // no test management in the file
    const parsed = parseProjectBackupPayload(JSON.stringify(payload));
    if (!parsed.ok) throw new Error('parse');
    expect(importProjectIntoRegistry([], [], parsed.data).dailyPlans.map((p) => p.scopeId)).toEqual([undefined]);
  });

  it('old project files (no plans) import unchanged', () => {
    const merged = importProjectIntoRegistry([], [], parseProjectBackupPayloadOk(JSON.stringify(createProjectBackupPayload(A, [], NOW))));
    expect(merged.dailyPlans).toEqual([]);
  });

  it('the owner is never carried over as a member of the destination; the name snapshot stays', () => {
    const owned = project('PRJ-003', 'c', {}, { ownerMemberId: 'USER0003', owner: 'Hana Sato' });
    const merged = importProjectIntoRegistry([], [], parseProjectBackupPayloadOk(JSON.stringify(createProjectBackupPayload(owned, [], NOW))), { members: [member('USER0003', 'Somebody Else')] });
    expect(merged.importedProject.ownerMemberId).toBeUndefined();
    expect(merged.importedProject.owner).toBe('Hana Sato');
  });

  it('a ticket reporter or performance row keeps its profile id only where the destination has that very person (id AND name)', () => {
    const tickets = [
      { id: 't1', projectId: 'PRJ-004', title: 'x', url: 'https://j/1', createdAt: '2026-10-01', reportedBy: 'Hana Sato', reporterMemberId: 'USER0001' },
      { id: 't2', projectId: 'PRJ-004', title: 'y', url: 'https://j/2', createdAt: '2026-10-01', reportedBy: 'Hana Sato', reporterMemberId: 'USER0002' }, // same id, different person here
      { id: 't3', projectId: 'PRJ-004', title: 'z', url: 'https://j/3', createdAt: '2026-10-01', reportedBy: 'External' },
    ];
    const perf = [{ id: 'p1', date: '2026-10-01', testerName: 'Hana Sato', projectId: 'PRJ-004', casesTested: 3, memberId: 'USER0001' }, { id: 'p2', date: '2026-10-01', testerName: 'Hana Sato', projectId: 'PRJ-004', casesTested: 3, memberId: 'USER0002' }];
    const p = project('PRJ-004', 'd', { bugTickets: tickets, testerDailyPerformance: perf } as Partial<QaInputs>);
    const here = [member('USER0001', 'hana sato'), member('USER0002', 'Somebody Else', { nameHistory: [] })];
    const merged = importProjectIntoRegistry([], [], parseProjectBackupPayloadOk(JSON.stringify(createProjectBackupPayload(p, [], NOW))), { members: here });
    const out = merged.importedProject.inputs;
    expect(out.bugTickets?.map((t) => t.reporterMemberId)).toEqual(['USER0001', undefined, undefined]);
    expect(out.bugTickets?.[1].reportedBy).toBe('Hana Sato'); // the recorded name is kept
    expect(out.testerDailyPerformance?.map((r) => r.memberId)).toEqual(['USER0001', undefined]);
  });
});

function parseProjectBackupPayloadOk(text: string) {
  const parsed = parseProjectBackupPayload(text);
  if (!parsed.ok) throw new Error('parse');
  return parsed.data;
}

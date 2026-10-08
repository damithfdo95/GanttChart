import { describe, expect, it } from 'vitest';
import { SV_ONLY_KINDS, isAssignedNow, isToday, ownMemberId, sameJson, testerCommitError, type TesterView } from '../../shared/testerRules';
import { qaCommitError } from '../../shared/qaRules';

/** The Tester rules as pure functions: the matrix of what a Tester may and may not change inside a commit. */

const TODAY = '2026-10-07';
const ME = 'usr_hana';
const HER_MEMBER = 'USER0001';
const HIS_MEMBER = 'USER0002';

type Records = Record<string, string>;
const view = (records: Records): TesterView => ({
  get: (kind, id) => records[`${kind}:${id}`] ?? null,
  list: (kind) => Object.entries(records).filter(([k]) => k.startsWith(`${kind}:`)).map(([k, json]) => ({ id: k.slice(kind.length + 1), json })),
});

const entry = (over: Record<string, unknown> = {}) => ({ id: 'e1', date: TODAY, testers: 2, pass: 5, fail: 1, notApplicable: 0, spo: 0, blocked: 0, retest: 0, questioned: 0, overtimeMinutes: 0, ...over });
const ticket = (over: Record<string, unknown> = {}) => ({ id: 't1', projectId: 'PRJ-001', title: 'Crash', url: 'https://x.example', createdAt: TODAY, reportedBy: 'Hana', reporterMemberId: HER_MEMBER, ...over });
const perf = (over: Record<string, unknown> = {}) => ({ id: 'p1', date: TODAY, testerName: 'Hana', projectId: 'PRJ-001', casesTested: 10, memberId: HER_MEMBER, ...over });

function project(inputs: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ id: 'proj-1', projectId: 'PRJ-001', nameEn: 'Android', status: 'ongoing', updatedAt: 'a', inputs: { totalCases: 100, dailyExecuted: [], bugTickets: [], testerDailyPerformance: [], ...inputs }, ...extra });
}

const assignment = (over: Record<string, unknown> = {}) => JSON.stringify({ id: 'a1', projectId: 'PRJ-001', userId: ME, startDate: '2026-10-01', active: true, ...over });
const member = (id: string, userId: string | undefined) => JSON.stringify({ id, name: id, team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true, ...(userId === undefined ? {} : { userId }) });

const world = (over: Records = {}): Records => ({
  'project:proj-1': project(),
  'assignment:a1': assignment(),
  [`member:${HER_MEMBER}`]: member(HER_MEMBER, ME),
  [`member:${HIS_MEMBER}`]: member(HIS_MEMBER, 'usr_ken'),
  ...over,
});

const change = (records: Records, nextProject: string, extra: { deletes?: Array<{ kind: string; id: string }>; puts?: Array<{ kind: string; id: string; json: string }> } = {}) =>
  testerCommitError({ userId: ME, today: TODAY, view: view(records), puts: [{ kind: 'project', id: 'proj-1', json: nextProject }, ...(extra.puts ?? [])], deletes: extra.deletes ?? [] });

describe('helpers', () => {
  it('compares JSON without regard to key order', () => {
    expect(sameJson({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(sameJson({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameJson([1, 2], [2, 1])).toBe(false);
    expect(sameJson({ a: null }, { a: undefined })).toBe(false);
    expect(sameJson({ a: undefined }, {})).toBe(true);
    expect(sameJson(null, {})).toBe(false);
  });

  it('“today” is exactly the business date, and only a real calendar date', () => {
    expect(isToday('2026-10-07', TODAY)).toBe(true);
    for (const d of ['2026-10-06', '2026-10-08', '2026-10-05', '2025-10-07', 'today', '2026-02-30', 5, null]) expect(isToday(d, TODAY), String(d)).toBe(false);
    expect(isToday('2027-01-01', '2027-01-01')).toBe(true);
    expect(isToday('2026-12-31', '2027-01-01')).toBe(false);
  });

  it('finds the Tester’s own profile only by the account link', () => {
    expect(ownMemberId(view(world()), ME)).toBe(HER_MEMBER);
    expect(ownMemberId(view(world()), 'usr_nobody')).toBeNull();
    expect(ownMemberId(view({ [`member:${HER_MEMBER}`]: member(HER_MEMBER, undefined) }), ME)).toBeNull();
  });

  it('an assignment counts when it is by account id, active, not ended and already started', () => {
    const at = (a: Record<string, unknown>) => isAssignedNow(view({ 'assignment:a1': assignment(a) }), ME, 'PRJ-001', TODAY);
    expect(at({})).toBe(true);
    expect(at({ active: false })).toBe(false);
    expect(at({ endDate: '2026-10-06' })).toBe(false);
    expect(at({ endDate: '2026-10-07' })).toBe(true);
    expect(at({ startDate: '2026-11-01' })).toBe(false);
    expect(at({ userId: 'usr_ken' })).toBe(false);
    expect(at({ projectId: 'PRJ-002' })).toBe(false);
    expect(isAssignedNow(view({ 'assignment:a1': JSON.stringify({ id: 'a1', projectId: 'PRJ-001', memberId: HER_MEMBER, active: true, startDate: '2026-10-01' }) }), ME, 'PRJ-001', TODAY)).toBe(false); // a name/roster assignment is not an account
  });

  it('the kinds a Tester never receives', () => {
    // Stage 8D added the team meeting's plans and notes (an SV's records).
    expect([...SV_ONLY_KINDS].sort()).toEqual(['dailyPlan', 'externalIdentity', 'identityAudit', 'meetingNote', 'report', 'review', 'topic']);
    for (const kind of ['project', 'cycle', 'assignment', 'member', 'attendance', 'settings']) expect(SV_ONLY_KINDS.has(kind), kind).toBe(false);
  });
});

describe('a Tester commit: kinds and deletes', () => {
  it('may change projects only; never delete; never create a project', () => {
    const w = world();
    for (const kind of ['cycle', 'member', 'assignment', 'settings', 'report', 'review', 'topic', 'attendance', 'identityAudit', 'externalIdentity']) {
      expect(testerCommitError({ userId: ME, today: TODAY, view: view(w), puts: [{ kind, id: 'x', json: '{}' }], deletes: [] }), kind).toBe('tester_cannot_change_kind');
    }
    expect(testerCommitError({ userId: ME, today: TODAY, view: view(w), puts: [], deletes: [{ kind: 'project', id: 'proj-1' }] })).toBe('tester_cannot_delete');
    expect(change({}, project())).toBe('tester_cannot_create_project');
    expect(change(w, 'nope')).toBe('project_not_an_object');
  });

  it('an unchanged project is fine', () => {
    expect(change(world(), project())).toBeNull();
  });
});

describe('a Tester commit: the project itself', () => {
  it('cannot change structure (name, status, cycle, ids) or the plan (totals, testers, rows)', () => {
    const w = world();
    expect(change(w, project({}, { nameEn: 'X' }))).toBe('tester_project_structure');
    expect(change(w, project({}, { status: 'done' }))).toBe('tester_project_structure');
    expect(change(w, project({}, { cycleId: 'cyc_1' }))).toBe('tester_project_structure');
    expect(change(w, project({}, { projectId: 'PRJ-009' }))).toBe('tester_project_structure');
    expect(change(w, project({}, { statusHistory: [] }))).toBe('tester_project_structure');
    expect(change(w, project({ totalCases: 1 }))).toBe('tester_project_plan');
    expect(change(w, project({ currentTesters: 9 }))).toBe('tester_project_plan');
    expect(change(w, project({ planningRows: [{ id: 'r' }] }))).toBe('tester_project_plan');
  });

  it('may refresh updatedAt together with an allowed change', () => {
    expect(change(world(), project({ dailyExecuted: [entry()] }, { updatedAt: 'b' }))).toBeNull();
  });
});

describe('a Tester commit: Today’s Execution', () => {
  it('an assigned Tester records today’s entry (and the totals that follow it)', () => {
    expect(change(world(), project({ dailyExecuted: [entry()], casesCompleted: 6, casesPassed: 5, casesFailed: 1, dailyActuals: [{ date: TODAY }] }))).toBeNull();
  });

  it('today is accepted; yesterday, tomorrow and any other date are refused', () => {
    const w = world();
    expect(change(w, project({ dailyExecuted: [entry({ date: '2026-10-07' })] }))).toBeNull();
    for (const date of ['2026-10-06', '2026-10-08', '2026-09-30', '2026-11-07']) {
      expect(change(w, project({ dailyExecuted: [entry({ date })] })), date).toBe('tester_execution_not_today');
    }
  });

  it('a forged date or actor inside the commit changes nothing: only the server date and the socket account count', () => {
    const w = world();
    const stamped = { actor: 'usr_ken', userId: 'usr_ken', today: '2026-10-06' };
    expect(change(w, project({ dailyExecuted: [entry({ date: '2026-10-06', ...stamped })] }, { today: '2026-10-06' }))).toBe('tester_project_structure');
    expect(change(w, project({ dailyExecuted: [entry({ date: '2026-10-06', ...stamped })] }))).toBe('tester_execution_not_today');
    // Another account on the same socket rule: Ken is not assigned, so even today's entry is refused for him.
    expect(testerCommitError({ userId: 'usr_ken', today: TODAY, view: view(w), puts: [{ kind: 'project', id: 'proj-1', json: project({ dailyExecuted: [entry()] }) }], deletes: [] })).toBe('tester_execution_not_assigned');
  });

  it('an unassigned Tester cannot, nor one whose assignment ended or is somebody else’s', () => {
    const next = project({ dailyExecuted: [entry()] });
    expect(change(world({ 'assignment:a1': assignment({ userId: 'usr_ken' }) }), next)).toBe('tester_execution_not_assigned');
    expect(change(world({ 'assignment:a1': assignment({ active: false }) }), next)).toBe('tester_execution_not_assigned');
    expect(change(world({ 'assignment:a1': assignment({ endDate: '2026-10-01' }) }), next)).toBe('tester_execution_not_assigned');
    const { 'assignment:a1': _gone, ...none } = world();
    expect(change(none, next)).toBe('tester_execution_not_assigned');
  });

  it('cannot rewrite or remove an earlier day', () => {
    const old = entry({ id: 'old', date: '2026-09-01' });
    const w = world({ 'project:proj-1': project({ dailyExecuted: [old] }) });
    expect(change(w, project({ dailyExecuted: [{ ...old, pass: 99 }] }))).toBe('tester_execution_not_today');
    expect(change(w, project({ dailyExecuted: [] }))).toBe('tester_execution_not_today');
  });

  it('may correct or remove today’s own entry', () => {
    const w = world({ 'project:proj-1': project({ dailyExecuted: [entry()] }) });
    expect(change(w, project({ dailyExecuted: [entry({ pass: 7 })] }))).toBeNull();
    expect(change(w, project({ dailyExecuted: [] }))).toBeNull();
  });

  it('the totals and snapshots cannot be changed on their own', () => {
    for (const f of ['casesCompleted', 'casesPassed', 'casesFailed', 'casesNotApplicable', 'spoAssigned', 'casesBlocked', 'casesRetest', 'casesQuestioned', 'dailyActuals']) {
      expect(change(world(), project({ [f]: f === 'dailyActuals' ? [{ date: TODAY }] : 50 })), f).toBe('tester_derived_without_entry');
    }
  });
});

describe('a Tester commit: tickets', () => {
  const withTickets = (tickets: unknown[]) => world({ 'project:proj-1': project({ bugTickets: tickets }) });

  it('anyone may raise a ticket for the project, as themselves or with no linked reporter', () => {
    expect(change(world(), project({ bugTickets: [ticket()] }))).toBeNull();
    expect(change(world(), project({ bugTickets: [ticket({ reporterMemberId: undefined, reportedBy: 'External' })] }))).toBeNull();
  });

  it('cannot raise one in someone else’s name, or for another project', () => {
    expect(change(world(), project({ bugTickets: [ticket({ reporterMemberId: HIS_MEMBER })] }))).toBe('tester_ticket_as_someone_else');
    expect(change(world(), project({ bugTickets: [ticket({ projectId: 'PRJ-009' })] }))).toBe('tester_ticket_wrong_project');
  });

  it('may change or remove their own ticket; not another person’s, not a legacy one with no reporter link', () => {
    const mine = ticket();
    const his = ticket({ id: 't2', reporterMemberId: HIS_MEMBER, reportedBy: 'Ken' });
    const legacy = ticket({ id: 't3', reporterMemberId: undefined });
    const w = withTickets([mine, his, legacy]);
    expect(change(w, project({ bugTickets: [{ ...mine, status: 'Resolved' }, his, legacy] }))).toBeNull();
    expect(change(w, project({ bugTickets: [his, legacy] }))).toBeNull(); // removed their own
    expect(change(w, project({ bugTickets: [mine, { ...his, title: 'hijack' }, legacy] }))).toBe('tester_ticket_not_own');
    expect(change(w, project({ bugTickets: [mine, legacy] }))).toBe('tester_ticket_not_own'); // removed his
    expect(change(w, project({ bugTickets: [mine, his, { ...legacy, title: 'x' }] }))).toBe('tester_ticket_not_own');
  });

  it('cannot hand a ticket to someone else or move it to another project', () => {
    const mine = ticket();
    const w = withTickets([mine]);
    expect(change(w, project({ bugTickets: [{ ...mine, reporterMemberId: HIS_MEMBER }] }))).toBe('tester_ticket_owner_immutable');
    expect(change(w, project({ bugTickets: [{ ...mine, projectId: 'PRJ-009' }] }))).toBe('tester_ticket_owner_immutable');
  });

  it('a Tester with no linked profile may raise a ticket but change none', () => {
    const w = world({ [`member:${HER_MEMBER}`]: member(HER_MEMBER, undefined), 'project:proj-1': project({ bugTickets: [ticket({ reporterMemberId: undefined })] }) });
    expect(change(w, project({ bugTickets: [ticket({ reporterMemberId: undefined }), ticket({ id: 't9', reporterMemberId: undefined })] }))).toBeNull();
    expect(change(w, project({ bugTickets: [ticket({ reporterMemberId: undefined, title: 'x' })] }))).toBe('tester_ticket_not_own');
  });
});

describe('a Tester commit: performance', () => {
  const withPerf = (rows: unknown[]) => world({ 'project:proj-1': project({ testerDailyPerformance: rows }) });

  it('writes, changes and removes only their own rows', () => {
    const mine = perf();
    const w = withPerf([mine]);
    expect(change(world(), project({ testerDailyPerformance: [mine] }))).toBeNull();
    expect(change(w, project({ testerDailyPerformance: [{ ...mine, casesTested: 20 }] }))).toBeNull();
    expect(change(w, project({ testerDailyPerformance: [] }))).toBeNull();
  });

  it('never another person’s row, a row with no member id, or a row moved to someone else', () => {
    const mine = perf();
    const his = perf({ id: 'p2', memberId: HIS_MEMBER, testerName: 'Ken' });
    expect(change(world(), project({ testerDailyPerformance: [his] }))).toBe('tester_performance_not_own');
    expect(change(world(), project({ testerDailyPerformance: [perf({ memberId: undefined })] }))).toBe('tester_performance_not_own');
    const w = withPerf([mine, his]);
    expect(change(w, project({ testerDailyPerformance: [mine, { ...his, casesTested: 1 }] }))).toBe('tester_performance_not_own');
    expect(change(w, project({ testerDailyPerformance: [mine] }))).toBe('tester_performance_not_own'); // removing his
    expect(change(w, project({ testerDailyPerformance: [{ ...mine, memberId: HIS_MEMBER }, his] }))).toBe('tester_performance_not_own');
  });

  it('a Tester whose account is not linked to a profile cannot write performance at all', () => {
    const w = world({ [`member:${HER_MEMBER}`]: member(HER_MEMBER, undefined) });
    expect(change(w, project({ testerDailyPerformance: [perf()] }))).toBe('tester_not_linked');
  });
});

describe('through the full commit rules', () => {
  const run = (role: 'admin' | 'editor' | 'viewer', puts: Array<{ kind: string; id: string; json: string }>, records: Records = world(), extra: { userId?: string; today?: string } = { userId: ME, today: TODAY }) =>
    qaCommitError({ role, puts, deletes: [], view: view(records), ...extra });

  it('an SV is not subject to the Tester rules', () => {
    expect(run('admin', [{ kind: 'project', id: 'proj-1', json: project({ totalCases: 5 }, { nameEn: 'Renamed' }) }])).toBeNull();
    expect(run('admin', [{ kind: 'review', id: 'r', json: '{}' }])).toBeNull();
  });

  it('a Tester or read-only member is subject to them, and without an identity the rules refuse rather than guess', () => {
    expect(run('editor', [{ kind: 'project', id: 'proj-1', json: project({ totalCases: 5 }) }])).toBe('tester_project_plan');
    expect(run('viewer', [{ kind: 'project', id: 'proj-1', json: project({ totalCases: 5 }) }])).toBe('tester_project_plan');
    expect(run('editor', [{ kind: 'project', id: 'proj-1', json: project() }], world(), {})).toBe('tester_rules_unavailable');
  });

  it('the link between a profile and an account can be set by the server only, for anyone', () => {
    const linked = member('USER0003', 'usr_new');
    const unlinked = member('USER0003', undefined);
    expect(run('admin', [{ kind: 'member', id: 'USER0003', json: linked }], world({ 'member:USER0003': unlinked }))).toBe('member_link_requires_api');
    expect(run('admin', [{ kind: 'member', id: 'USER0003', json: unlinked }], world({ 'member:USER0003': linked }))).toBe('member_link_requires_api');
    expect(run('admin', [{ kind: 'member', id: 'USER0003', json: linked }], world({ 'member:USER0003': linked }))).toBeNull();
    expect(run('admin', [{ kind: 'member', id: 'USER0009', json: member('USER0009', undefined) }])).toBeNull();
    expect(run('admin', [{ kind: 'member', id: 'USER0009', json: member('USER0009', 'usr_x') }])).toBe('member_link_requires_api');
  });

  it('a workspace tool name must be plain, short text (and only an SV can write the settings at all)', () => {
    const settings = (toolName: unknown) => [{ kind: 'settings', id: 'settings', json: JSON.stringify({ teams: [], toolName }) }];
    expect(run('admin', settings('QA Board'))).toBeNull();
    expect(run('admin', settings('<img src=x>'))).toBe('settings_invalid_tool_name');
    expect(run('admin', settings('x'.repeat(41)))).toBe('settings_invalid_tool_name');
    expect(run('admin', settings(5))).toBe('settings_invalid_tool_name');
    expect(run('admin', [{ kind: 'settings', id: 'settings', json: JSON.stringify({ teams: [] }) }])).toBeNull(); // none set
    expect(run('editor', settings('QA Board'))).toBe('tester_cannot_change_kind');
  });
});

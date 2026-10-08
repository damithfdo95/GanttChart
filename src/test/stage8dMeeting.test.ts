import { describe, expect, it } from 'vitest';
import { DEMO_STATE, normalizeQaInputs } from '../lib/storage/storage';
import { newProjectRecord } from '../domain/projects/lifecycle';
import {
  attendanceFor,
  buildMeeting,
  confirmMorning,
  enginePlannedFor,
  inMeeting,
  nextBusinessDate,
  nextCalendarDate,
  planFor,
  setNote,
  setPlan,
  type MeetingInputs,
} from '../domain/meeting';
import { checkDailyPlan, checkMeetingNote, dailyPlanId, meetingNoteId, meetingCommitError } from '../../shared/meeting';
import type { AttendanceRecord, CaseResult, DailyExecutionEntry, DailyTeamPlan, ProjectRecord, QaInputs, RcsMember, TesterProjectAssignment, TestCase, TestScope } from '../types';

const NOW = '2026-10-08T09:00:00.000Z';
const TODAY = '2026-10-08'; // a Thursday
const TOMORROW = '2026-10-09'; // Friday
const row = (date: string, over: Record<string, unknown> = {}) => ({ id: `row-${date}`, date, plannedTesters: 4, absentTesters: 0, nonWorkingDay: false, note: '', ...over });

function inputs(over: Partial<QaInputs> = {}): QaInputs {
  return normalizeQaInputs({ ...(DEMO_STATE as QaInputs), totalCases: 500, currentTesters: 4, perHourPerTester: 4, startTime: 540, startDate: '2026-10-05', targetCompletionDate: '2026-10-30', planningRows: [row(TODAY), row(TOMORROW)], dailyExecuted: [], bugTickets: [], dailyTargetOverrides: [], ...over } as QaInputs);
}
const entry = (date: string, over: Partial<DailyExecutionEntry> = {}): DailyExecutionEntry => ({ id: `e-${date}`, date, startTime: null, endTime: null, overtimeMinutes: 0, intervalEnabled: true, testers: 4, pass: 0, fail: 0, notApplicable: 0, spo: 0, blocked: 0, retest: 0, questioned: 0, note: '', ...over });
function project(projectId: string, over: Partial<QaInputs> = {}, status: ProjectRecord['status'] = 'ongoing'): ProjectRecord {
  return { ...newProjectRecord(inputs(over), { nameEn: `Project ${projectId}`, status }, NOW, []), id: `rec_${projectId}`, projectId };
}
const scope = (id: string, projectId: string, total?: number, order = 10): TestScope => ({ id, projectId, name: id.toUpperCase(), code: id.toUpperCase().slice(0, 4), status: 'active', order, createdAt: NOW, updatedAt: NOW, ...(total === undefined ? {} : { totalTestCases: total }) });
const plan = (projectId: string, date: string, plannedCases: number, scopeId?: string, over: Partial<DailyTeamPlan> = {}): DailyTeamPlan => ({ id: dailyPlanId(date, projectId, scopeId), date, projectId, ...(scopeId === undefined ? {} : { scopeId }), plannedCases, createdAt: NOW, updatedAt: NOW, ...over });
const member = (id: string, name: string, over: Partial<RcsMember> = {}): RcsMember => ({ id, name, team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true, ...over });
const asg = (projectId: string, over: Partial<TesterProjectAssignment>): TesterProjectAssignment => ({ id: `a-${Math.random()}`, projectId, startDate: '2026-10-01', active: true, ...over });

const base = (over: Partial<MeetingInputs> = {}): MeetingInputs => ({
  today: TODAY,
  tomorrow: TOMORROW,
  nowIso: NOW,
  projects: [],
  scopes: [],
  testCases: [],
  caseResults: [],
  assignments: [],
  members: [],
  attendance: [],
  plans: [],
  ...over,
});

describe('the whole team, not a person', () => {
  const android = project('PRJ-001', { totalCases: 333, dailyExecuted: [entry(TODAY, { pass: 60, fail: 10, blocked: 3 })], casesCompleted: 70, casesPassed: 60, casesFailed: 10, casesBlocked: 3 });
  const vvm = project('PRJ-002', { totalCases: 109, dailyExecuted: [entry(TODAY, { pass: 30, fail: 1 })], casesCompleted: 31, casesPassed: 30, casesFailed: 1 });
  const scopes = [scope('eco', 'PRJ-001', 134, 10), scope('htma', 'PRJ-001', 90, 20), scope('vvm', 'PRJ-001', 109, 30)];
  const members = [member('USER0001', 'Hana Sato'), member('USER0002', 'Ken Ito'), member('USER0003', 'Taro Tanaka')];
  const assignments = [
    asg('PRJ-001', { id: 'a1', userId: 'usr_a', memberId: 'USER0001', scopeId: 'eco' }),
    asg('PRJ-001', { id: 'a2', memberId: 'USER0003', scopeId: 'htma' }), // no login yet
    asg('PRJ-002', { id: 'a3', userId: 'usr_b', memberId: 'USER0002' }),
  ];
  const plans = [plan('PRJ-001', TODAY, 80, 'eco'), plan('PRJ-001', TODAY, 50, 'htma'), plan('PRJ-002', TODAY, 35)];
  const view = buildMeeting(base({ projects: [android, vvm], scopes, assignments, members, plans }), [], false);

  it('lists every active project of the workspace, with its scopes beneath, in one view', () => {
    expect(view.rows.map((r) => r.project.projectId)).toEqual(['PRJ-001', 'PRJ-002']);
    expect(view.rows[0].scopes.map((s) => s.scope.id)).toEqual(['eco', 'htma', 'vvm']);
    expect(view.summary.activeProjects).toBe(2);
    expect(view.summary.activeScopes).toBe(3);
    expect(view.summary.teamMembers).toBe(3);
  });

  it('uses the AUTHORITATIVE Total (333 = 134 + 90 + 109), not the number of registered cases', () => {
    expect(view.rows[0].total).toBe(333);
    expect(view.rows[0].registered).toBe(0);
    expect(view.rows[0].scopes.map((s) => s.total)).toEqual([134, 90, 109]);
  });

  it('Remaining is the authoritative Total minus what the daily execution completed', () => {
    expect(view.rows[0].metrics.remaining).toBe(333 - 70);
    expect(view.summary.remaining).toBe(333 - 70 + (109 - 31));
  });

  it('today\'s plan is the SV\'s: scope plans add up to the project; a project-level plan stands alone', () => {
    expect(view.rows[0].today).toMatchObject({ planned: 130, source: 'meeting' });
    expect(view.rows[1].today).toMatchObject({ planned: 35, source: 'meeting' });
    expect(view.summary.plannedToday).toBe(165);
  });

  it('names the people on a project and on each scope, including a Tester who has no login yet, and never shows an id', () => {
    const sc = view.rows[0].scopes;
    expect(sc[0].people.map((p) => p.key)).toEqual(['u:usr_a']);
    expect(sc[1].people.map((p) => p.key)).toEqual(['m:USER0003']);
    expect(view.rows[0].people.map((p) => p.key).sort()).toEqual(['m:USER0003', 'u:usr_a']);
    expect(JSON.stringify(view.summary)).not.toMatch(/usr_|USER\d/);
  });

  it('is empty when there is nothing to present', () => {
    const empty = buildMeeting(base(), [], false);
    expect(empty.rows).toEqual([]);
    expect(empty.summary).toMatchObject({ activeProjects: 0, plannedToday: 0, actualToday: 0, remaining: 0, tomorrowPlanned: 0, needsAttention: 0 });
  });
});

describe('which projects are in the meeting', () => {
  const p = (status: ProjectRecord['status'], over: Partial<QaInputs> = {}) => project('PRJ-009', over, status);
  it('running projects, ones starting by today, ones that executed today or are planned today; not paused or finished ones', () => {
    expect(inMeeting(p('ongoing'), TODAY, [])).toBe(true);
    expect(inMeeting(p('extended'), TODAY, [])).toBe(true);
    expect(inMeeting(p('todo', { startDate: TODAY }), TODAY, [])).toBe(true);
    expect(inMeeting(p('todo', { startDate: '2026-11-01' }), TODAY, [])).toBe(false);
    expect(inMeeting(p('onHold'), TODAY, [])).toBe(false);
    expect(inMeeting(p('done'), TODAY, [])).toBe(false);
    expect(inMeeting(p('done', { dailyExecuted: [entry(TODAY, { pass: 5 })] }), TODAY, [])).toBe(true); // finished today: still shown
    expect(inMeeting(p('onHold'), TODAY, [plan('PRJ-009', TODAY, 10)])).toBe(true);
  });
});

describe('today\'s plan: whose number is it', () => {
  it('the SV\'s plan wins; with none, the project\'s own plan; with neither, "not set"; never remaining divided by days', () => {
    const p = project('PRJ-001', { totalCases: 500 });
    expect(planFor(p, TODAY, [])).toMatchObject({ planned: 120, source: 'project' }); // 4 testers x 4/h x 7.5 productive hours
    expect(planFor(p, TODAY, [plan('PRJ-001', TODAY, 77)])).toMatchObject({ planned: 77, source: 'meeting' });
    expect(planFor(p, '2026-12-25', [])).toMatchObject({ planned: null, source: 'none' });
    expect(enginePlannedFor(p.inputs, TODAY)).toBe(120);
    expect(enginePlannedFor(inputs({ planningRows: [row(TODAY, { nonWorkingDay: true })] }), TODAY)).toBeNull();
  });

  it('a manual target of the project\'s own plan is respected', () => {
    const p = project('PRJ-001', { dailyTargetOverrides: [{ id: 'o', date: TODAY, plannedExecute: 42, plannedPass: 40 }] });
    expect(planFor(p, TODAY, [])).toMatchObject({ planned: 42, source: 'project' });
  });

  it('scope plans win over a project-level plan for the same day (no two numbers for one place)', () => {
    const p = project('PRJ-001');
    expect(planFor(p, TODAY, [plan('PRJ-001', TODAY, 999), plan('PRJ-001', TODAY, 10, 'eco'), plan('PRJ-001', TODAY, 5, 'htma')]).planned).toBe(15);
  });

  it('another project\'s or another day\'s plan never counts', () => {
    const p = project('PRJ-001');
    expect(planFor(p, TODAY, [plan('PRJ-002', TODAY, 300), plan('PRJ-001', TOMORROW, 300)]).source).toBe('project');
  });
});

describe('Evening: plan against actual', () => {
  const p = project('PRJ-001', { totalCases: 400, dailyExecuted: [entry(TODAY, { pass: 68, fail: 6, notApplicable: 2, blocked: 2 })] });
  const evening = buildMeeting(base({ projects: [p], plans: [plan('PRJ-001', TODAY, 80), plan('PRJ-001', TOMORROW, 58)] }), [], true);
  const r = evening.rows[0];

  it('actual is the completed cases of the day (Pass + Fail + N/A + SPO), the difference is against the plan', () => {
    expect(r.actual).toMatchObject({ recorded: true, completed: 76, pass: 68, fail: 6, blocked: 2 });
    expect(r.difference).toBe(-4);
    expect(evening.summary).toMatchObject({ targetToday: 80, actualToday: 76, difference: -4, pass: 68, fail: 6, blocked: 2, tomorrowPlanned: 58 });
  });

  it('flags a day below plan in words, and a day with no entry is "not recorded", not zero', () => {
    expect(r.risks.map((x) => x.code)).toContain('below_plan');
    const none = buildMeeting(base({ projects: [project('PRJ-001', { dailyExecuted: [] })], plans: [plan('PRJ-001', TODAY, 80)] }), [], true).rows[0];
    expect(none.actual.recorded).toBe(false);
    expect(none.difference).toBeNull();
    expect(none.risks.map((x) => x.code)).not.toContain('below_plan');
  });

  it('blocked and failed cases and a missing Tester raise the deterministic signals; there is no scoring', () => {
    const codes = r.risks.map((x) => x.code);
    expect(codes).toEqual(expect.arrayContaining(['blocked_cases', 'failed_cases', 'no_tester']));
    expect(r.attention).toBe(true);
    expect(evening.summary.needsAttention).toBe(1);
    expect(evening.summary.blockedProjects).toBe(1);
  });

  it('the Morning plan stays the target when the plan is changed in the Evening', () => {
    const edited = setPlan([plan('PRJ-001', TODAY, 80)], { date: TODAY, projectId: 'PRJ-001', plannedCases: 60, mode: 'evening', today: TODAY }, NOW);
    expect(edited[0]).toMatchObject({ plannedCases: 60, morningCases: 80 });
    const again = setPlan(edited, { date: TODAY, projectId: 'PRJ-001', plannedCases: 50, mode: 'evening', today: TODAY }, NOW);
    expect(again[0]).toMatchObject({ plannedCases: 50, morningCases: 80 }); // stamped once, never overwritten
    const view = buildMeeting(base({ projects: [p], plans: again }), [], true).rows[0];
    expect(view.today).toMatchObject({ planned: 50, target: 80, revised: true });
    expect(view.difference).toBe(76 - 80);
  });
});

describe('tomorrow becomes the next Morning without being entered twice', () => {
  it('the plan an SV types in the Evening for the next business day is the plan the next Morning reads', () => {
    const eveningPlans = setPlan([], { date: TOMORROW, projectId: 'PRJ-001', plannedCases: 145, mode: 'evening', today: TODAY }, NOW);
    expect(eveningPlans).toHaveLength(1);
    const p = project('PRJ-001');
    const nextMorning = buildMeeting(base({ today: TOMORROW, tomorrow: nextBusinessDate(TOMORROW), projects: [p], plans: eveningPlans }), [], false);
    expect(nextMorning.rows[0].today).toMatchObject({ planned: 145, source: 'meeting' });
    // ... and can be edited that morning; the Morning edit does not stamp a target
    const edited = setPlan(eveningPlans, { date: TOMORROW, projectId: 'PRJ-001', plannedCases: 140, mode: 'morning', today: TOMORROW }, NOW);
    expect(edited[0]).toMatchObject({ plannedCases: 140 });
    expect(edited[0].morningCases).toBeUndefined();
  });

  it('"tomorrow" is the next BUSINESS day: Friday evening plans for Monday, and a holiday is skipped', () => {
    expect(nextBusinessDate('2026-10-08')).toBe('2026-10-09'); // Thu -> Fri
    expect(nextBusinessDate('2026-10-09')).toBe('2026-10-13'); // Fri -> Mon is Sports Day (a holiday in Japan): Tuesday
    expect(nextBusinessDate('2026-07-17')).toBe('2026-07-21'); // Fri -> Mon is Marine Day (07-20): Tuesday
    expect(nextCalendarDate('2026-12-31')).toBe('2027-01-01');
  });

  it('a Friday-evening plan reaches Monday\'s (or Tuesday\'s) Morning', () => {
    const monday = nextBusinessDate('2026-10-09');
    const plans = setPlan([], { date: monday, projectId: 'PRJ-001', plannedCases: 10, mode: 'evening', today: '2026-10-09' }, NOW);
    const p = project('PRJ-001', { planningRows: [row(monday)] });
    expect(buildMeeting(base({ today: monday, tomorrow: nextBusinessDate(monday), projects: [p], plans }), [], false).rows[0].today.planned).toBe(10);
  });
});

describe('writing plans and notes', () => {
  it('writes nothing when nothing changes (the same array comes back), and refuses nonsense', () => {
    const plans = [plan('PRJ-001', TODAY, 80)];
    expect(setPlan(plans, { date: TODAY, projectId: 'PRJ-001', plannedCases: 80, mode: 'morning', today: TODAY }, NOW)).toBe(plans);
    expect(setPlan(plans, { date: TODAY, projectId: 'PRJ-001', plannedCases: -1, mode: 'morning', today: TODAY }, NOW)).toBe(plans);
    expect(setPlan(plans, { date: TODAY, projectId: 'PRJ-001', plannedCases: 1.5, mode: 'morning', today: TODAY }, NOW)).toBe(plans);
    const notes = setNote([], TODAY, 'morning', 'Focus', NOW);
    expect(setNote(notes, TODAY, 'morning', ' Focus ', NOW)).toBe(notes);
  });

  it('one record per day and place: editing changes that record only; a scope plan is its own record', () => {
    let plans: DailyTeamPlan[] = [];
    plans = setPlan(plans, { date: TODAY, projectId: 'PRJ-001', plannedCases: 10, mode: 'morning', today: TODAY }, NOW);
    plans = setPlan(plans, { date: TODAY, projectId: 'PRJ-001', scopeId: 'eco', plannedCases: 4, mode: 'morning', today: TODAY }, NOW);
    plans = setPlan(plans, { date: TODAY, projectId: 'PRJ-001', plannedCases: 12, mode: 'morning', today: TODAY }, NOW);
    expect(plans.map((x) => [x.id, x.plannedCases]).sort()).toEqual([[dailyPlanId(TODAY, 'PRJ-001'), 12], [dailyPlanId(TODAY, 'PRJ-001', 'eco'), 4]].sort());
  });

  it('confirming keeps today\'s plan as the Morning target; running it again changes nothing', () => {
    const plans = [plan('PRJ-001', TODAY, 80), plan('PRJ-001', TOMORROW, 20)];
    const confirmed = confirmMorning(plans, TODAY, NOW);
    expect(confirmed[0].morningCases).toBe(80);
    expect(confirmed[1]).toBe(plans[1]); // other days untouched, by reference
    expect(confirmMorning(confirmed, TODAY, NOW)).toBe(confirmed);
  });

  it('notes are one record per day with three independent fields; an emptied note is removed from the record', () => {
    let notes = setNote([], TODAY, 'morning', 'Finish Ecosystem by 16:00', NOW);
    notes = setNote(notes, TODAY, 'evening', 'Good day', NOW);
    notes = setNote(notes, TODAY, 'tomorrow', 'HTMA', NOW);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ id: meetingNoteId(TODAY), morning: 'Finish Ecosystem by 16:00', evening: 'Good day', tomorrow: 'HTMA' });
    notes = setNote(notes, TODAY, 'evening', '   ', NOW);
    expect(notes[0].evening).toBeUndefined();
    expect(notes[0].morning).toBe('Finish Ecosystem by 16:00');
  });
});

describe('numbers from two sources are never added together', () => {
  it('registered case results change nothing in the meeting\'s execution numbers', () => {
    const p = project('PRJ-001', { totalCases: 134, dailyExecuted: [entry(TODAY, { pass: 20 })], casesCompleted: 20, casesPassed: 20 });
    const cases: TestCase[] = Array.from({ length: 42 }, (_, i) => ({ id: `tc${i}`, projectId: 'PRJ-001', scopeId: 'eco', key: `ECO-${i + 1}`, title: 't', priority: 'medium', status: 'active', order: i, createdAt: NOW, updatedAt: NOW }));
    const results: CaseResult[] = cases.slice(0, 30).map((c) => ({ id: `res_${c.id}`, projectId: 'PRJ-001', scopeId: 'eco', testCaseId: c.id, status: 'pass', retest: false, question: false, updatedByUserId: null, updatedAt: NOW }));
    const without = buildMeeting(base({ projects: [p], scopes: [scope('eco', 'PRJ-001', 134)] }), [], true);
    const withCases = buildMeeting(base({ projects: [p], scopes: [scope('eco', 'PRJ-001', 134)], testCases: cases, caseResults: results }), [], true);
    expect(withCases.summary).toEqual(without.summary);
    expect(withCases.rows[0].metrics).toEqual(without.rows[0].metrics);
    expect(withCases.rows[0]).toMatchObject({ total: 134, registered: 42 });
    expect(withCases.rows[0].scopes[0]).toMatchObject({ total: 134, registered: 42, registeredCompleted: 30 }); // detail only
    expect(withCases.rows[0].metrics.remaining).toBe(134 - 20); // not 134 - 20 - 30
  });
});

describe('attendance', () => {
  const a = (status: AttendanceRecord['status'], date = TODAY): AttendanceRecord => ({ id: `${status}-${date}-${Math.random()}`, date, memberName: 'x', team: 'RCS', status, workingStart: null, workingEnd: null, leaveType: null, comment: '' });

  it('is "not recorded" when nobody has an entry for the day (never guessed from accounts)', () => {
    expect(attendanceFor(TODAY, [a('PRESENT', '2026-10-07')])).toEqual({ recorded: false, attending: 0, total: 0 });
  });

  it('counts present, late and half-day people against everyone recorded that day', () => {
    expect(attendanceFor(TODAY, [a('PRESENT'), a('LATE'), a('HALF_DAY'), a('ABSENT'), a('PAID_LEAVE')])).toEqual({ recorded: true, attending: 3, total: 5 });
  });
});

describe('records are validated', () => {
  it('a plan needs a derived id, a real date, a whole non-negative number', () => {
    const ok = plan('PRJ-001', TODAY, 5, 'scp_x');
    expect(checkDailyPlan(ok).ok).toBe(true);
    for (const bad of [{ ...ok, id: 'dp_wrong' }, { ...ok, date: '2026-13-40' }, { ...ok, plannedCases: -1 }, { ...ok, plannedCases: 2.5 }, { ...ok, morningCases: 'x' }, { ...ok, note: 'a'.repeat(201) }, 'junk']) {
      expect(checkDailyPlan(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(checkMeetingNote({ id: meetingNoteId(TODAY), date: TODAY, morning: 'x', createdAt: NOW, updatedAt: NOW }).ok).toBe(true);
    expect(checkMeetingNote({ id: 'mn_other', date: TODAY, createdAt: NOW, updatedAt: NOW }).ok).toBe(false);
    expect(checkMeetingNote({ id: meetingNoteId(TODAY), date: TODAY, morning: 'x'.repeat(1001), createdAt: NOW, updatedAt: NOW }).ok).toBe(false);
  });

  it('only an SV may write them, and a plan refers to a project (and scope) of this workspace', () => {
    const view = {
      get: (_k: string, _id: string) => null as string | null,
      list: (kind: string) => (kind === 'project' ? [{ id: 'p', json: JSON.stringify({ id: 'p', projectId: 'PRJ-001' }) }] : []),
    };
    const put = (kind: string, v: { id: string }) => ({ kind, id: v.id, json: JSON.stringify(v) });
    const good = put('dailyPlan', plan('PRJ-001', TODAY, 5));
    expect(meetingCommitError({ puts: [good], deletes: [], view, isSv: true })).toBeNull();
    expect(meetingCommitError({ puts: [good], deletes: [], view, isSv: false })).toBe('meeting_sv_only');
    expect(meetingCommitError({ puts: [put('dailyPlan', plan('PRJ-777', TODAY, 5))], deletes: [], view, isSv: true })).toBe('dailyplan_project_not_found');
    expect(meetingCommitError({ puts: [put('dailyPlan', plan('PRJ-001', TODAY, 5, 'scp_none'))], deletes: [], view, isSv: true })).toBe('dailyplan_scope_not_found');
    expect(meetingCommitError({ puts: [], deletes: [{ kind: 'dailyPlan', id: 'x' }], view, isSv: false })).toBe('meeting_sv_only');
    const note = put('meetingNote', { id: meetingNoteId(TODAY), date: TODAY, createdAt: NOW, updatedAt: NOW } as { id: string });
    expect(meetingCommitError({ puts: [note], deletes: [], view, isSv: true })).toBeNull();
    expect(meetingCommitError({ puts: [note], deletes: [], view, isSv: false })).toBe('meeting_sv_only');
  });
});

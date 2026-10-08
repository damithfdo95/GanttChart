import { describe, expect, it } from 'vitest';
import { DEMO_STATE, normalizeQaInputs } from '../lib/storage/storage';
import { newProjectRecord } from '../domain/projects/lifecycle';
import { historyDay, historyRange, retainMeetingHistory, retainedFrom } from '../domain/meeting/history';
import { actorLabel, changedLabel, recordLabel } from '../domain/historyLabels';
import { pageUrl } from '../lib/history/pagination';
import { sanitizeRestoredAccountLinks } from '../lib/backup/restoreLinks';
import { createBackupPayload } from '../lib/backup/backup';
import { defaultReportsState } from '../lib/storage/reports';
import { dailyPlanId, meetingNoteId } from '../../shared/meeting';
import { ackId, type NotificationAck, type NotificationDef } from '../../shared/notifications';
import type { DailyExecutionEntry, DailyTeamPlan, MeetingNote, ProjectRecord, QaInputs, RcsMember, ReportsState, TestScope } from '../types';

const NOW = '2026-10-08T09:00:00.000Z';
const TODAY = '2026-10-08'; // Thursday
const entry = (date: string, over: Partial<DailyExecutionEntry> = {}): DailyExecutionEntry => ({ id: `e-${date}`, date, startTime: null, endTime: null, overtimeMinutes: 0, intervalEnabled: true, testers: 4, pass: 0, fail: 0, notApplicable: 0, spo: 0, blocked: 0, retest: 0, questioned: 0, note: '', ...over });
function project(projectId: string, over: Partial<QaInputs> = {}): ProjectRecord {
  const inputs = normalizeQaInputs({ ...(DEMO_STATE as QaInputs), totalCases: 349, dailyExecuted: [], bugTickets: [], dailyTargetOverrides: [], ...over } as QaInputs);
  return { ...newProjectRecord(inputs, { nameEn: `Project ${projectId}`, status: 'ongoing' }, NOW, []), id: `rec_${projectId}`, projectId };
}
const scope = (id: string, projectId: string, name: string): TestScope => ({ id, projectId, name, code: id.toUpperCase().slice(0, 4), status: 'active', order: 10, createdAt: NOW, updatedAt: NOW });
const plan = (projectId: string, date: string, plannedCases: number, scopeId?: string, over: Partial<DailyTeamPlan> = {}): DailyTeamPlan => ({ id: dailyPlanId(date, projectId, scopeId), date, projectId, ...(scopeId === undefined ? {} : { scopeId }), plannedCases, createdAt: NOW, updatedAt: NOW, ...over });
const note = (date: string, over: Partial<MeetingNote> = {}): MeetingNote => ({ id: meetingNoteId(date), date, createdAt: NOW, updatedAt: NOW, ...over });

const android = project('PRJ-001', { dailyExecuted: [entry('2026-10-05', { pass: 40, fail: 5 }), entry('2026-10-06', { pass: 60, fail: 10, notApplicable: 2 })] });
const vvm = project('PRJ-002', { totalCases: 109, dailyExecuted: [entry('2026-10-06', { pass: 20 })] });
const input = (over: Partial<Parameters<typeof historyDay>[0]> = {}): Parameters<typeof historyDay>[0] => ({
  projects: [android, vvm],
  scopes: [scope('eco', 'PRJ-001', 'Ecosystem'), scope('htma', 'PRJ-001', 'HTMA')],
  plans: [],
  notes: [],
  today: TODAY,
  retentionDays: 365,
  ...over,
});

describe('Meeting History: a past day as it was stored', () => {
  it('Plan is the stored Morning target, Actual the recorded result, Difference = Actual - Plan', () => {
    const day = historyDay(input({ plans: [plan('PRJ-001', '2026-10-06', 90, undefined, { morningCases: 80 }), plan('PRJ-002', '2026-10-06', 25)] }), '2026-10-06');
    const a = day.rows.find((r) => r.project.projectId === 'PRJ-001')!;
    expect(a).toMatchObject({ plan: 80, revisedTo: 90, actual: 72, difference: -8, pass: 60, fail: 10 }); // 60 + 10 + 2 N/A
    const v = day.rows.find((r) => r.project.projectId === 'PRJ-002')!;
    expect(v).toMatchObject({ plan: 25, actual: 20, difference: -5 });
    expect(day.totals).toMatchObject({ plan: 105, actual: 92, difference: -13 });
  });

  it('Difference is over the SAME rows: a project with a plan but no result counts 0 actual, a result with no plan counts 0 plan', () => {
    const day = historyDay(input({ plans: [plan('PRJ-001', '2026-10-06', 50), plan('PRJ-002', '2026-10-05', 30)] }), '2026-10-05');
    // 5 Oct: Android has a result (45) and no plan; VVM has a plan (30) and no result
    const a = day.rows.find((r) => r.project.projectId === 'PRJ-001')!;
    const v = day.rows.find((r) => r.project.projectId === 'PRJ-002')!;
    expect(a).toMatchObject({ plan: null, actual: 45, difference: null });
    expect(v).toMatchObject({ plan: 30, actual: null, difference: null });
    expect(day.totals.plan).toBe(30);
    expect(day.totals.actual).toBe(45);
    expect(day.totals.difference).toBe(45 - 30);
  });

  it('scope plans win over a project plan, and are shown as plans only - no per-scope actual is invented', () => {
    const day = historyDay(input({ plans: [plan('PRJ-001', '2026-10-06', 999), plan('PRJ-001', '2026-10-06', 50, 'eco'), plan('PRJ-001', '2026-10-06', 30, 'htma')] }), '2026-10-06');
    const a = day.rows.find((r) => r.project.projectId === 'PRJ-001')!;
    expect(a.plan).toBe(80);
    expect(a.scopes.map((s) => [s.scope.name, s.plan])).toEqual([['Ecosystem', 50], ['HTMA', 30]]);
    for (const s of a.scopes) expect(Object.keys(s).sort()).toEqual(['plan', 'scope']);
  });

  it('shows tomorrow\'s plan (made that day) and the day\'s note; Friday\'s tomorrow is Monday', () => {
    const d = historyDay(input({ plans: [plan('PRJ-001', '2026-10-06', 70), plan('PRJ-001', '2026-10-07', 55)], notes: [note('2026-10-06', { morning: 'Focus Ecosystem' })] }), '2026-10-06');
    expect(d.tomorrowDate).toBe('2026-10-07');
    expect(d.rows[0].tomorrow).toBe(55);
    expect(d.note?.morning).toBe('Focus Ecosystem');
    expect(historyDay(input(), '2026-10-16').tomorrowDate).toBe('2026-10-19'); // Fri -> Mon
    expect(historyDay(input(), '2026-10-09').tomorrowDate).toBe('2026-10-13'); // Fri -> Tue: Monday 12 October is a public holiday
  });

  it('remaining at the end of the day is measured against the current Total, from results up to that day', () => {
    const day = historyDay(input({ plans: [plan('PRJ-001', '2026-10-06', 70)] }), '2026-10-06');
    expect(day.rows.find((r) => r.project.projectId === 'PRJ-001')!.remainingAtEnd).toBe(349 - 45 - 72);
  });

  it('a day with nothing stored is empty; one before the retention window says so', () => {
    expect(historyDay(input(), '2026-09-01')).toMatchObject({ empty: true, rows: [], outsideRetention: false });
    const old = historyDay(input({ retentionDays: 90 }), '2026-06-01');
    expect(old.outsideRetention).toBe(true);
    expect(old.retainedFrom).toBe('2026-07-10');
    expect(retainedFrom(TODAY, 365)).toBe('2025-10-08');
  });

  it('projects of another workspace are simply not in the input: nothing of theirs can appear', () => {
    const day = historyDay(input({ projects: [vvm], plans: [plan('PRJ-001', '2026-10-06', 70)] }), '2026-10-06');
    expect(day.rows.map((r) => r.project.projectId)).toEqual(['PRJ-002']);
  });

  it('plan against actual over a range lists days that have something, newest first', () => {
    const range = historyRange(input({ plans: [plan('PRJ-001', '2026-10-06', 80)] }), '2026-10-01', '2026-10-08');
    expect(range.map((r) => r.date)).toEqual(['2026-10-06', '2026-10-05']);
    expect(historyRange(input(), '2026-10-08', '2026-10-01')).toEqual([]);
  });

  it('Local storage prunes by the same cutoff and returns the same arrays when nothing is old', () => {
    const plans = [plan('PRJ-001', '2025-01-01', 1), plan('PRJ-001', '2025-10-08', 1), plan('PRJ-001', '2026-10-09', 1)];
    const notes = [note('2025-01-01'), note('2026-10-08')];
    const r = retainMeetingHistory(plans, notes, TODAY, 365);
    expect(r.plans.map((p) => p.date)).toEqual(['2025-10-08', '2026-10-09']);
    expect(r.notes.map((n) => n.date)).toEqual(['2026-10-08']);
    expect(r.removed).toBe(2);
    const same = retainMeetingHistory(r.plans, r.notes, TODAY, 365);
    expect(same.plans).toBe(r.plans);
    expect(same.removed).toBe(0);
  });
});

describe('Shared History labels: a person, never an id', () => {
  const members: RcsMember[] = [{ id: 'USER0001', name: 'Hana Sato', team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true, email: 'hana@rakuten.com' }];
  const def: NotificationDef = { id: 'ntf_11111111-2222-3333-4444-555555555555', title: 'Daily stand-up', message: '', recurrence: 'daily', time: '09:00', audience: { kind: 'all' }, enabled: true, createdAt: NOW, updatedAt: NOW, createdByUserId: 'u', updatedByUserId: 'u' };
  const state: ReportsState = { ...defaultReportsState(), projects: [android], scopes: [scope('scp_eco', 'PRJ-001', 'Ecosystem')], rcsMembers: members, notifications: [def] };

  it('plans are named by date, project and scope; notes by their date; acknowledgments by the notification', () => {
    expect(recordLabel('dailyPlan', dailyPlanId('2026-10-06', 'PRJ-001', 'scp_eco'), state, 'en')).toBe('2026-10-06 · Project PRJ-001 · Ecosystem');
    expect(recordLabel('dailyPlan', dailyPlanId('2026-10-06', 'PRJ-001'), state, 'en')).toBe('2026-10-06 · Project PRJ-001');
    expect(recordLabel('meetingNote', meetingNoteId('2026-10-06'), state, 'en')).toBe('2026-10-06');
    expect(recordLabel('notificationAck', ackId(def.id, '2026-10-06T09:00', 'usr_x'), state, 'en')).toBe('Daily stand-up');
    expect(recordLabel('notification', def.id, state, 'en')).toBe('Daily stand-up');
  });

  it('a record that no longer exists gets a neutral word, never its id', () => {
    for (const [kind, id] of [['scope', 'scp_deadbeef'], ['member', 'USER0099'], ['notification', 'ntf_00000000-0000-0000-0000-000000000000'], ['project', 'proj-gone']] as const) {
      const label = recordLabel(kind, id, state, 'en');
      expect(label, kind).not.toContain(id);
      expect(label, kind).not.toBe('');
    }
  });

  it('an actor is a person\'s name where the directory knows them, else the email, never an id', () => {
    expect(actorLabel('hana@rakuten.com', state, 'en')).toContain('Hana Sato');
    expect(actorLabel('unknown@rakuten.com', state, 'en')).toBe('unknown@rakuten.com');
  });

  it('changedLabel names a changed record by kind and label', () => {
    const text = changedLabel('scope', 'scp_eco', state, 'en');
    expect(text).toContain('Ecosystem');
    expect(text).not.toContain('scp_eco');
  });
});

describe('the history request', () => {
  it('asks for one more row than a page (to know there is a next), with only the filters that are set', () => {
    expect(pageUrl(25, undefined)).toBe('/api/revisions?limit=26');
    expect(pageUrl(25, 40, { kind: 'dailyPlan', actor: 'a@b.c', from: '2026-10-01', to: '' })).toBe('/api/revisions?limit=26&before=40&kind=dailyPlan&actor=a%40b.c&from=2026-10-01');
  });
});

describe('restoring a backup does not carry other people\'s notifications state in', () => {
  const def = (over: Partial<NotificationDef> = {}): NotificationDef => ({ id: 'ntf_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', title: 'T', message: '', recurrence: 'daily', time: '09:00', audience: { kind: 'all' }, enabled: true, createdAt: NOW, updatedAt: NOW, createdByUserId: 'usr_other', updatedByUserId: 'usr_other', ...over });
  const ack = (userId: string): NotificationAck => ({ id: ackId('ntf_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '2026-10-08T09:00', userId), notificationId: 'ntf_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', occurrence: '2026-10-08T09:00', userId, at: NOW });
  const member = (id: string): RcsMember => ({ id, name: id, team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true });
  const logo = (by: string) => ({ id: 'branding' as const, mime: 'image/png' as const, data: 'iVBORw0KGgo=', bytes: 8, updatedAt: NOW, updatedByUserId: by });

  it('a restored definition is stamped with the person restoring it, and keeps only audience members that exist here', () => {
    const restored: ReportsState = { ...defaultReportsState(), rcsMembers: [member('USER0001')], notifications: [def({ audience: { kind: 'members', memberIds: ['USER0001', 'USER0777'] } })] };
    const out = sanitizeRestoredAccountLinks(restored, defaultReportsState(), 'usr_me');
    expect(out.notifications).toHaveLength(1);
    expect(out.notifications![0]).toMatchObject({ createdByUserId: 'usr_me', updatedByUserId: 'usr_me', audience: { kind: 'members', memberIds: ['USER0001'] } });
  });

  it('a definition addressed only to people who do not exist here is dropped', () => {
    const restored: ReportsState = { ...defaultReportsState(), notifications: [def({ audience: { kind: 'members', memberIds: ['USER0777'] } })] };
    expect(sanitizeRestoredAccountLinks(restored, defaultReportsState(), 'usr_me').notifications).toEqual([]);
  });

  it('acknowledgments in a file are ignored: the workspace\'s own stay, so a restore cannot close or reopen anything', () => {
    const restored: ReportsState = { ...defaultReportsState(), notificationAcks: [ack('usr_forged')] };
    const current: ReportsState = { ...defaultReportsState(), notificationAcks: [ack('usr_real')] };
    expect(sanitizeRestoredAccountLinks(restored, current, 'usr_me').notificationAcks).toEqual([ack('usr_real')]);
  });

  it('a restored logo is attributed to the person restoring it', () => {
    const restored: ReportsState = { ...defaultReportsState(), brandings: [logo('usr_other')] };
    expect(sanitizeRestoredAccountLinks(restored, defaultReportsState(), 'usr_me').brandings![0].updatedByUserId).toBe('usr_me');
  });

  it('an unchanged definition is left exactly as the workspace has it', () => {
    const same = def();
    const state: ReportsState = { ...defaultReportsState(), notifications: [same] };
    expect(sanitizeRestoredAccountLinks(state, state, 'usr_me').notifications).toEqual([same]);
  });

  it('a backup file never contains acknowledgments, but does contain definitions and the logo', () => {
    const state: ReportsState = { ...defaultReportsState(), notifications: [def()], notificationAcks: [ack('usr_a')], brandings: [logo('usr_a')] };
    const payload = createBackupPayload(DEMO_STATE as never, state);
    const reports = (payload as unknown as { data: { reportsState: ReportsState } }).data.reportsState;
    expect(reports.notificationAcks ?? []).toEqual([]);
    expect(reports.notifications).toHaveLength(1);
    expect(reports.brandings).toHaveLength(1);
  });
});

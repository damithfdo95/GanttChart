import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TeamView } from '../features/tenancy/TeamScreen';
import { TeamDirectory } from '../features/tenancy/TeamDirectory';
import { MeetingGantt } from '../features/meeting/MeetingGantt';
import { applyRecordChanges, reportsFromRecords, reportsToRecords } from '../lib/sync/records';
import { dailyPlanId, meetingNoteId } from '../../shared/meeting';
import { MeetingRiskBadge } from '../features/meeting/MeetingParts';
import { navItems } from '../app/navigation';
import { DEMO_STATE, normalizeQaInputs } from '../lib/storage/storage';
import { newProjectRecord } from '../domain/projects/lifecycle';
import { projectProgress } from '../domain/projects';
import { cycleSummary, projectMetrics } from '../domain/qaMetrics';
import { reconcileProjectTotals } from '../domain/testManagement';
import { buildMeeting } from '../domain/meeting';
import { createBackupPayload } from '../lib/backup/backup';
import { defaultReportsState } from '../lib/storage/reports';
import { dictionaries } from '../i18n/dictionaries';
import type { PrincipalDto } from '../../shared/tenancy';
import type { TenancyApi } from '../lib/tenancy/api';
import type { AppState, ProjectRecord, QaInputs, RcsMember, TestScope } from '../types';

const NOW = '2026-10-08T09:00:00.000Z';
const render = (el: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(el);
const inputs = (over: Partial<QaInputs> = {}): QaInputs => normalizeQaInputs({ ...(DEMO_STATE as QaInputs), totalCases: 10, ...over });
const project = (projectId: string, over: Partial<QaInputs> = {}): ProjectRecord => ({ ...newProjectRecord(inputs(over), { nameEn: projectId, status: 'ongoing' }, NOW, []), id: `rec_${projectId}`, projectId });
const scope = (id: string, projectId: string, total: number): TestScope => ({ id, projectId, name: id, status: 'active', order: 10, createdAt: NOW, updatedAt: NOW, totalTestCases: total });

describe('the authoritative Total reaches every place that reads the project\'s total', () => {
  const derived = reconcileProjectTotals([project('PRJ-001', { totalCases: 1, casesCompleted: 70, casesPassed: 60, casesFailed: 10 })], [scope('a', 'PRJ-001', 134), scope('b', 'PRJ-001', 90), scope('c', 'PRJ-001', 109)], [], NOW)[0];

  it('Dashboard / Overall progress', () => {
    expect(derived.inputs.totalCases).toBe(333);
    expect(projectProgress(derived)).toMatchObject({ total: 333, remaining: 263 });
  });

  it('Cycle and project metrics (Remaining and Progress use the Total, never the registered count)', () => {
    expect(projectMetrics(derived)).toMatchObject({ planned: 333, remaining: 263 });
    const cycle = { id: 'c', name: 'R', status: 'active', createdAt: NOW, updatedAt: NOW } as never;
    expect(cycleSummary(cycle, [{ ...derived, cycleId: 'c' }], { today: '2026-10-08', nowIso: NOW, assignments: [] }).metrics.planned).toBe(333);
  });

  it('the meeting and the exports', () => {
    const meeting = buildMeeting({ today: '2026-10-08', tomorrow: '2026-10-09', nowIso: NOW, projects: [derived], scopes: [], testCases: [], caseResults: [], assignments: [], members: [], attendance: [], plans: [] }, [], false);
    expect(meeting.rows[0].total).toBe(333);
    const payload = createBackupPayload(DEMO_STATE as AppState, { ...defaultReportsState(), projects: [derived], activeProjectId: derived.id });
    expect(payload.data.reportsState.projects[0].inputs.totalCases).toBe(333); // a report built from the backup does not fall back to the registered count
  });
});

describe('the Team Members directory screen', () => {
  const principal: PrincipalDto = { email: 'sv@x.com', userId: 'usr_sv', isOwner: true, displayName: 'SV', role: 'admin', tenant: { id: 'ten_x', name: 'Rakuten QA', storageMode: 'web', status: 'active', createdAt: 't', deletionRequestedAt: null }, access: null, workspaceRole: 'admin', sharedWorkspace: true };
  const m = (id: string, name: string, over: Partial<RcsMember> = {}): RcsMember => ({ id, name, team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true, ...over });
  const members = [m('USER0001', 'Hana Sato', { userId: 'usr_hana', email: 'hana@rakuten.com' }), m('USER0002', 'Taro Tanaka', { email: 'taro@rakuten.com' }), m('USER0003', 'Left Person', { active: false, endDate: '2026-09-01' }), m('USER0004', 'USER0004', { email: 'only-email@rakuten.com' })];
  const html = (lang: 'en' | 'ja') => render(createElement(TeamView, { lang, principal, api: {} as unknown as TenancyApi, members, onOpenSettings: () => undefined }));

  it('shows linked and not-linked people with their state in words, removed ones only on request, and never an id', () => {
    const out = html('en');
    expect(out).toContain('Hana Sato');
    expect(out).toContain('Taro Tanaka');
    expect(out).toContain('Linked');
    expect(out).toContain('Not linked');
    expect(out).not.toContain('Left Person'); // the default view shows active people
    expect(out).toContain('only-email@rakuten.com'); // a profile named like its id is shown by its email
    expect(out).not.toMatch(/USER\d{4}|usr_|mem_/);
  });

  it('has the same words in Japanese', () => {
    const out = html('ja');
    expect(out).toContain('Hana Sato');
    expect(out).toContain('連携済み');
    expect(out).toContain('未連携');
    expect(out).not.toMatch(/USER\d{4}|usr_/);
  });

  it('a Tester gets no directory at all', () => {
    expect(render(createElement(TeamView, { lang: 'en', principal: { ...principal, role: 'user', isOwner: false }, api: {} as unknown as TenancyApi, members, onOpenSettings: () => undefined }))).toBe('');
  });
});

describe('the meeting is the SV\'s', () => {
  it('no Tester navigation leads to it; the Gantt toggle and the Dashboard shortcuts are SV-only; a Tester sees a plain note', () => {
    expect(navItems('user').map((i) => i.id)).not.toContain('testManagement');
    const gantt = raw('../features/gantt/Gantt.tsx');
    expect(gantt).toMatch(/if \(isTester\) return <GanttPlanning/);
    expect(raw('../features/dashboard/Dashboard.tsx')).toMatch(/onOpenMeeting !== undefined && !tester/);
    expect(raw('../features/meeting/MeetingView.tsx')).toMatch(/access\.isTester/);
  });

  it('risk is a word and a symbol, not only a colour', () => {
    const out = render(createElement(MeetingRiskBadge, { lang: 'en', risks: [{ code: 'blocked_cases', severity: 'attention', value: 3 }] }));
    expect(out).toContain('Needs Attention');
    expect(out).toContain('⚠');
    expect(render(createElement(MeetingRiskBadge, { lang: 'ja', risks: [] }))).toContain('順調');
  });

  it('every new screen string exists in both languages', () => {
    const keys = Object.keys(dictionaries.en).filter((k) => k.startsWith('mt.') || k.startsWith('dir.') || k.startsWith('tm.total.'));
    expect(keys.length).toBeGreaterThan(100);
    for (const k of keys) expect((dictionaries.ja as Record<string, string>)[k], k).toBeTruthy();
  });
});

describe('person fields use the directory', () => {
  it('assignment pickers, the project owner and the person selectors draw from the directory (active people), not from free text or the account list', () => {
    expect(raw('../features/testManagement/TestManagementScreen.tsx')).toMatch(/selectableMembers\(tm\.reports\.state\.rcsMembers/);
    expect(raw('../features/dashboard/ProjectControlCenter.tsx')).toMatch(/selectableMembers\(members, \{ role: 'tester'/);
    expect(raw('../components/NewProjectForm.tsx')).toMatch(/selectableMembers\(reportsApi\.state\.rcsMembers/);
    expect(raw('../components/NewProjectForm.tsx')).not.toMatch(/set\(\{ owner:/); // the typed owner field is gone
    for (const f of ['../features/tickets/TicketForm.tsx', '../features/daily-report/AttendanceSection.tsx', '../features/performance/PerformanceTab.tsx']) expect(raw(f), f).toMatch(/selectableMembers/);
  });
});

describe('the meeting timeline', () => {
  const NOW2 = '2026-10-08T09:00:00.000Z';
  const rowFor = (evening: boolean) => {
    const p = project('PRJ-001', { totalCases: 400, casesCompleted: 120, dailyExecuted: [{ id: 'e', date: '2026-10-08', startTime: null, endTime: null, overtimeMinutes: 0, intervalEnabled: true, testers: 4, pass: 68, fail: 6, notApplicable: 0, spo: 0, blocked: 2, retest: 0, questioned: 0, note: '' }] });
    const plans = [{ id: dailyPlanId('2026-10-08', 'PRJ-001'), date: '2026-10-08', projectId: 'PRJ-001', plannedCases: 80, createdAt: NOW2, updatedAt: NOW2 }, { id: dailyPlanId('2026-10-09', 'PRJ-001'), date: '2026-10-09', projectId: 'PRJ-001', plannedCases: 58, createdAt: NOW2, updatedAt: NOW2 }];
    return buildMeeting({ today: '2026-10-08', tomorrow: '2026-10-09', nowIso: NOW2, projects: [p], scopes: [], testCases: [], caseResults: [], assignments: [{ id: 'a', projectId: 'PRJ-001', memberId: 'USER0001', startDate: '2026-10-01', active: true }], members: [], attendance: [], plans }, [], evening).rows;
  };
  const html = (evening: boolean, lang: 'en' | 'ja' = 'en') => render(createElement(MeetingGantt, { lang, today: '2026-10-08', rows: rowFor(evening), evening, names: () => 'Hana Sato', projectName: (r) => r.project.nameEn, onSelect: () => undefined }));

  it('the Morning shows the plan and who is assigned; the Evening shows plan, actual, difference, remaining and tomorrow', () => {
    const morning = html(false);
    expect(morning).toContain('Planned today 80');
    expect(morning).toContain('Hana Sato');
    expect(morning).not.toContain('Actual');
    const evening = html(true);
    expect(evening).toContain('Plan 80');
    expect(evening).toContain('Actual 74');
    expect(evening).toContain('Difference -6');
    expect(evening).toContain('Tomorrow 58');
  });

  it('is read-only (no inputs), shows the day in words, and never an id', () => {
    for (const out of [html(false), html(true), html(true, 'ja')]) {
      expect(out).not.toContain('<input');
      expect(out).not.toMatch(/USER\d|usr_|PRJ-001"|dp_/);
    }
    expect(html(true, 'ja')).toContain('今日');
  });
});

describe('the directory in Local storage', () => {
  it('shows profiles only: no login column, no login actions', () => {
    const m = (id: string, name: string, over: Partial<RcsMember> = {}): RcsMember => ({ id, name, team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true, ...over });
    const out = render(createElement(TeamDirectory, { lang: 'en', api: null, members: [m('USER0001', 'Hana Sato', { email: 'hana@rakuten.com' })] }));
    expect(out).toContain('Hana Sato');
    expect(out).toContain('Not linked');
    expect(out).not.toContain('Login status');
    expect(out).not.toContain('Create login');
    expect(out).not.toContain('Login account');
    expect(out).toContain('Local storage');
  });
});

describe('plans and notes travel as shared records', () => {
  it('map to and from records without loss, in a stable order', () => {
    const plans = [
      { id: dailyPlanId('2026-10-09', 'PRJ-001'), date: '2026-10-09', projectId: 'PRJ-001', plannedCases: 5, createdAt: '2026-10-08T09:00:00.000Z', updatedAt: '2026-10-08T09:00:00.000Z' },
      { id: dailyPlanId('2026-10-08', 'PRJ-001'), date: '2026-10-08', projectId: 'PRJ-001', plannedCases: 7, createdAt: '2026-10-08T09:00:00.000Z', updatedAt: '2026-10-08T09:00:00.000Z' },
    ];
    const notes = [{ id: meetingNoteId('2026-10-08'), date: '2026-10-08', morning: 'x', createdAt: '2026-10-08T09:00:00.000Z', updatedAt: '2026-10-08T09:00:00.000Z' }];
    const state = { ...defaultReportsState(), dailyPlans: plans, meetingNotes: notes };
    const records = [...reportsToRecords(state).values()];
    expect(records.filter((r) => r.kind === 'dailyPlan' || r.kind === 'meetingNote')).toHaveLength(3);
    const back = reportsFromRecords(records, defaultReportsState());
    expect(back.dailyPlans?.map((p) => p.date)).toEqual(['2026-10-08', '2026-10-09']); // ordered by date, whatever the arrival order
    expect(back.meetingNotes).toEqual(notes);
    const removed = applyRecordChanges(back, [], [{ kind: 'dailyPlan', id: plans[0].id }]);
    expect(removed.dailyPlans?.map((p) => p.id)).toEqual([plans[1].id]);
  });
});

const sources = import.meta.glob<string>('../**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true });
function raw(path: string): string {
  const key = Object.keys(sources).find((k) => k.endsWith(path.replace('../', '/')) || k === path);
  if (key === undefined) throw new Error(`source not found: ${path}`);
  return sources[key];
}

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEMO_STATE, normalizeQaInputs } from '../lib/storage/storage';
import { newProjectRecord } from '../domain/projects/lifecycle';
import { buildSupervisorDailyOperations, type SupervisorDailyOperations, type SupervisorOpsInput } from '../domain/supervisorOperations';
import { supervisorDailyOperationsSheet } from '../lib/export/exportData';
import { accessTo } from '../app/access';
import { navItems } from '../app/navigation';
import { dictionaries } from '../i18n/dictionaries';
import type { CaseStatus } from '../domain/testManagement';
import type { BugTicket, CaseExecutionEvent, DailyExecutionEntry, ProjectLifecycleStatus, ProjectRecord, QaInputs, RcsMember, TestCase, TestScope, TesterProjectAssignment } from '../types';

const root = resolve(__dirname, '..');
const src = (rel: string): string => readFileSync(join(root, rel), 'utf8');
const dict = (lang: 'en' | 'ja'): Record<string, string> => dictionaries[lang] as Record<string, string>;
const NOW = '2026-10-01T00:00:00.000Z';
const TODAY = '2026-10-27';
const YESTERDAY = '2026-10-26';
const NOW_ISO = '2026-10-27T01:00:00.000Z';
const DAYS = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'];
const row = (date: string, n: number) => ({ id: `r-${date}`, date, plannedTesters: n, absentTesters: 0, nonWorkingDay: false, note: '' });
const entry = (date: string, over: Partial<DailyExecutionEntry> = {}): DailyExecutionEntry => ({ id: `d-${date}`, date, startTime: 540, endTime: 1050, overtimeMinutes: 0, intervalEnabled: true, testers: 4, pass: 0, fail: 0, notApplicable: 0, spo: 0, blocked: 0, retest: 0, questioned: 0, note: '', source: 'manual', ...over });
const jst = (date: string, hhmm: string): string => new Date(`${date}T${hhmm}:00+09:00`).toISOString();

function project(id: string, over: Partial<QaInputs> = {}, status: ProjectLifecycleStatus = 'ongoing'): ProjectRecord {
  const inputs = normalizeQaInputs({ ...(DEMO_STATE as QaInputs), totalCases: 100, casesCompleted: 60, casesPassed: 60, currentTesters: 4, startDate: '2026-10-26', targetCompletionDate: '2026-10-30', targetCompletionTime: null, planningRows: DAYS.map((d) => row(d, 4)), dailyExecuted: [entry(YESTERDAY, { pass: 60 })], bugTickets: [], ...over });
  return { ...newProjectRecord(inputs, { nameEn: `Project ${id}`, status }, NOW, []), id: `rec_${id}`, projectId: `PRJ-${id}` };
}
const scope = (id: string, projectId: string, workType: TestScope['workType'], total: number): TestScope => ({ id, projectId, name: `${id} scope`, status: 'active', order: 1, createdAt: NOW, updatedAt: NOW, totalTestCases: total, ...(workType === undefined ? {} : { workType }) });
const tcase = (id: string, projectId: string, scopeId: string): TestCase => ({ id, projectId, scopeId, key: id.toUpperCase(), title: `case ${id}`, priority: 'medium', status: 'active', order: 1, createdAt: NOW, updatedAt: NOW });
let n = 0;
const ev = (projectId: string, scopeId: string, testCaseId: string, status: CaseStatus, date: string, hhmm = '10:00', over: Partial<CaseExecutionEvent> = {}): CaseExecutionEvent => ({ id: `evt_${(n += 1)}`, projectId, scopeId, testCaseId, status, executedAt: jst(date, hhmm), source: 'manual', ...over });
const assign = (projectId: string, memberId: string, scopeId?: string): TesterProjectAssignment => ({ id: `a-${projectId}-${memberId}-${scopeId ?? 'all'}`, projectId, memberId, startDate: '2026-10-01', active: true, ...(scopeId === undefined ? {} : { scopeId }) });
const ticket = (projectId: string, over: Partial<BugTicket> = {}): BugTicket => ({ id: `t-${projectId}`, projectId, title: 'Crash', url: 'https://x.example/1', createdAt: '2026-10-20', reportedBy: 'Hana', ...over });
const members: RcsMember[] = ['m1', 'm2', 'm3'].map((id) => ({ id, name: `Member ${id}`, team: 'T', role: 'tester', startDate: '2026-01-01', active: true }));

/** A: Regression, healthy. B: Sanity, forecast late. C: Verification, blocked by a Critical ticket. */
function team(over: Partial<SupervisorOpsInput> = {}): SupervisorOpsInput {
  const a = project('A', { dailyExecuted: [entry(YESTERDAY, { pass: 60 }), entry(TODAY, { pass: 8, testers: 3 })] });
  const b = project('B', { totalCases: 3000, casesCompleted: 60, currentTesters: 4 });
  const c = project('C', { bugTickets: [ticket('PRJ-C', { severity: 'Critical', status: 'Open', ticketKey: 'ABC-1' })], dailyExecuted: [entry(YESTERDAY, { pass: 60 })] });
  const scopes = [scope('sa', 'PRJ-A', 'regression', 3), scope('sb', 'PRJ-B', 'sanity', 2), scope('sc', 'PRJ-C', 'verification', 2)];
  const cases = [tcase('a1', 'PRJ-A', 'sa'), tcase('a2', 'PRJ-A', 'sa'), tcase('a3', 'PRJ-A', 'sa'), tcase('b1', 'PRJ-B', 'sb'), tcase('b2', 'PRJ-B', 'sb'), tcase('c1', 'PRJ-C', 'sc'), tcase('c2', 'PRJ-C', 'sc')];
  const caseExecution = [
    ev('PRJ-A', 'sa', 'a1', 'fail', TODAY, '09:00', { executedByMemberId: 'm1' }),
    ev('PRJ-A', 'sa', 'a1', 'pass', TODAY, '11:00', { executedByMemberId: 'm1' }),
    ev('PRJ-A', 'sa', 'a2', 'blocked', TODAY, '12:00', { executedByMemberId: 'm2' }),
    ev('PRJ-B', 'sb', 'b1', 'pass', TODAY, '13:00', { source: 'testrail' }),
    ev('PRJ-A', 'sa', 'a3', 'pass', YESTERDAY, '10:00', { executedByMemberId: 'm1' }),
  ];
  return {
    projects: [a, b, c],
    scopes,
    cases,
    caseExecution,
    assignments: [assign('PRJ-A', 'm1', 'sa'), assign('PRJ-A', 'm2'), assign('PRJ-B', 'm1'), assign('PRJ-C', 'm3', 'sc')],
    members,
    selectedDate: TODAY,
    today: TODAY,
    nowIso: NOW_ISO,
    ...over,
  };
}
const ops = (over: Partial<SupervisorOpsInput> = {}): SupervisorDailyOperations => buildSupervisorDailyOperations(team(over));
const byProject = (o: SupervisorDailyOperations, id: string) => o.projects.find((p) => p.projectId === id)!;

describe('summary', () => {
  it('counts active projects and readiness states; staffing totals use distinct people for "assigned"', () => {
    const s = ops().summary;
    expect(s).toMatchObject({ activeProjects: 3, blockedProjects: 1, atRiskProjects: 1, readyProjects: 1, plannedTesters: 12 });
    expect(s.assignedTesters).toBe(3); // m1 is on two projects and counts once
    expect(s.actualTesters).toBe(3); // only A recorded a headcount today
  });

  it('execution totals keep saved cases, unique cases and events apart', () => {
    const e = ops().summary.execution;
    expect(e).toMatchObject({ savedExecuted: 8, savedPassed: 8, savedFailed: 0, savedBlocked: 0, uniqueCasesExecuted: 3, executionEvents: 4 });
  });

  it('breaks the work down by QA work type, with ticket counts kept out of case counts', () => {
    const s = ops();
    expect(s.summary.workTypeBreakdown.map((w) => [w.workType, w.cases])).toEqual([['regression', 3], ['sanity', 2], ['verification', 2]]);
    expect(byProject(s, 'PRJ-C').tickets).toMatchObject({ criticalUnresolved: 1, openOrInProgress: 1 });
    expect(byProject(s, 'PRJ-C').workMix).toEqual([{ workType: 'verification', scopes: 1, cases: 2 }]); // the ticket is not a case
  });

  it('shows an unspecified type and supports a project with no typed scope', () => {
    const o = ops({ scopes: [scope('sa', 'PRJ-A', undefined, 3)] });
    expect(o.summary.workTypeBreakdown.map((w) => w.workType)).toEqual(['unspecified']);
  });
});

describe('Needs Attention', () => {
  it('puts the blocking defect first, then schedule risk, then staffing - in a stable order', () => {
    const items = ops().summary.attentionItems;
    expect(items[0]).toMatchObject({ projectId: 'PRJ-C', reasonCode: 'critical_defect_open', severity: 'blocking', category: 'defect', priority: 1 });
    const firstWarning = items.findIndex((i) => i.severity === 'warning');
    const firstInfo = items.findIndex((i) => i.severity === 'info');
    expect(items[firstWarning]).toMatchObject({ projectId: 'PRJ-B', category: 'schedule', priority: 2 });
    expect(firstWarning).toBeLessThan(firstInfo);
    expect(items.filter((i) => i.severity === 'info').every((i) => i.priority === 3)).toBe(true);
    expect(JSON.stringify(ops().summary.attentionItems)).toBe(JSON.stringify(ops().summary.attentionItems));
  });

  it('uses the readiness reasons as they are: an overdue and late project yields one schedule item', () => {
    const o = ops({ today: '2026-11-02', selectedDate: '2026-11-02' });
    const b = o.summary.attentionItems.filter((i) => i.projectId === 'PRJ-B' && i.category === 'schedule');
    expect(b.map((i) => i.reasonCode)).toEqual(['project_overdue']);
  });

  it('never carries one project\'s issue into another', () => {
    const items = ops().summary.attentionItems;
    expect(items.filter((i) => i.reasonCode === 'critical_defect_open').map((i) => i.projectId)).toEqual(['PRJ-C']);
    expect(byProject(ops(), 'PRJ-A').readiness.state).toBe('ready');
  });

  it('has no items for a healthy workspace', () => {
    const healthy = ops({ projects: [project('A', { dailyExecuted: [entry(YESTERDAY, { pass: 60 }), entry(TODAY, { pass: 5 })] })], assignments: [assign('PRJ-A', 'm1'), assign('PRJ-A', 'm2'), assign('PRJ-A', 'm3'), { ...assign('PRJ-A', 'm4') }], caseExecution: [], scopes: [], cases: [] });
    expect(healthy.summary.attentionItems.filter((i) => i.severity !== 'info')).toEqual([]);
  });
});

describe('the selected date', () => {
  it('day sections follow the date while readiness stays current', () => {
    const today = ops();
    const yesterday = ops({ selectedDate: YESTERDAY });
    expect(yesterday.isHistorical).toBe(true);
    expect(today.isHistorical).toBe(false);
    const a = byProject(yesterday, 'PRJ-A');
    expect(a.saved).toMatchObject({ executed: 60, passed: 60 });
    expect(a.staffing.actual).toBe(4);
    expect(a.detailed.eventCount).toBe(1); // only yesterday's event
    expect(byProject(today, 'PRJ-A').saved).toMatchObject({ executed: 8 });
    expect(byProject(today, 'PRJ-A').staffing.actual).toBe(3);
    for (const p of today.projects) expect(byProject(yesterday, p.projectId).readiness).toEqual(p.readiness);
  });

  it("Planned, Assigned and Actual testers are three separate numbers", () => {
    const a = byProject(ops(), 'PRJ-A').staffing;
    expect(a).toEqual({ planned: 4, assigned: 2, actual: 3, gap: 2 });
  });

  it('compares with the most recent earlier day that has activity, on day-based figures only', () => {
    const c = ops().comparison!;
    expect(c.previous.date).toBe(YESTERDAY);
    expect(c.current).toMatchObject({ date: TODAY, uniqueCasesExecuted: 3, failedCases: 0, savedExecuted: 8 });
    expect(c.previous).toMatchObject({ uniqueCasesExecuted: 1, savedExecuted: 180, actualTesters: 12 });
    expect(Object.keys(c.current)).not.toContain('readiness');
    expect(ops({ selectedDate: '2026-10-20' }).comparison).toBeNull();
  });

  it('what changed comes from the immutable case history of that day', () => {
    const c = ops().changes;
    expect(c).toMatchObject({ passEvents: 2, failEvents: 1, blockedEvents: 1, casesFirstExecuted: 3, casesNewlyPassed: 2 });
    expect(ops({ selectedDate: YESTERDAY }).changes).toMatchObject({ passEvents: 1, failEvents: 0, casesFirstExecuted: 1 });
  });

  it('lists the day\'s failed and blocked cases, not hundreds', () => {
    const f = ops().failures;
    expect(f.items.map((i) => [i.key, i.status])).toEqual([['A2', 'blocked']]);
    expect(f.blockedToday).toBe(1);
  });
});

describe('projects, people and inclusion', () => {
  it('ranks projects by readiness first, then explainable tie-breakers', () => {
    expect(ops().projectRanking).toEqual(['PRJ-C', 'PRJ-B', 'PRJ-A']);
  });

  it('shows who is assigned to what and the factual execution attributed to them - alphabetical, never ranked', () => {
    const al = ops().allocation;
    expect(al.map((a) => a.name)).toEqual(['Member m1', 'Member m2', 'Member m3']);
    const m1 = al[0]!;
    expect(m1).toMatchObject({ eventsToday: 2, uniqueCasesToday: 1, noExecutionRecorded: false });
    expect(m1.assignments.map((x) => [x.projectId, x.workType])).toEqual([['PRJ-A', 'regression'], ['PRJ-B', null]]);
    expect(al[2]).toMatchObject({ noExecutionRecorded: true });
  });

  it('a completed project appears for a day it had execution, but is not an active project and raises no attention', () => {
    const done = project('Z', { dailyExecuted: [entry(TODAY, { pass: 5 })] }, 'done');
    const o = ops({ projects: [...team().projects, done] });
    expect(o.summary.activeProjects).toBe(3);
    expect(o.projects.some((p) => p.projectId === 'PRJ-Z')).toBe(true);
    expect(o.summary.attentionItems.some((i) => i.projectId === 'PRJ-Z')).toBe(false);
    expect(ops().projects.some((p) => p.projectId === 'PRJ-Z')).toBe(false);
  });

  it('handles an empty workspace', () => {
    const o = ops({ projects: [], scopes: [], cases: [], caseExecution: [], assignments: [] });
    expect(o.summary).toMatchObject({ activeProjects: 0, assignedTesters: 0 });
    expect(o.allocation).toEqual([]);
    expect(o.projectRanking).toEqual([]);
  });
});

describe('export', () => {
  for (const lang of ['en', 'ja'] as const) {
    it(`[${lang}] one row per project with explicit units and the attention codes`, () => {
      const sheet = supervisorDailyOperationsSheet(lang, ops());
      expect(sheet.headers).toHaveLength(16);
      expect(sheet.headers[3]).toBe(dict(lang)['qa.workType.export']);
      expect(sheet.rows).toHaveLength(3);
      const c = sheet.rows.find((r) => r[1] === 'PRJ-C')!;
      expect(c[4]).toBe(dict(lang)['readiness.state.blocked']);
      expect(c[14]).toBe(1);
      expect(String(c[15])).toContain('critical_defect_open');
    });
  }
});

describe('access, isolation and no side effects', () => {
  it('the Command Center is management-only', () => {
    expect(accessTo('user', 'commandCenter')).toBe('none');
    expect(accessTo('admin', 'commandCenter')).toBe('manage');
    expect(accessTo(null, 'commandCenter')).toBe('manage');
    expect(navItems('user').some((i) => i.id === 'commandCenter')).toBe(false);
    expect(navItems('admin').some((i) => i.id === 'commandCenter')).toBe(true);
    expect(src('app/App.tsx')).toContain("|| !allowed ? 'dashboard' : screen");
  });

  it('it neither writes any saved data nor calls an integration', () => {
    for (const f of ['features/commandCenter/CommandCenter.tsx', 'domain/supervisorOperations.ts']) {
      const code = src(f);
      expect(code).not.toMatch(/saveDailyExecutionEntry|updateField\(|updateSettings|updateProject|upsert|applyDailyExecutionEntry|finalizeReport|createRevision|updateReport|upsertReport/);
      expect(code).not.toMatch(/fetch\(|createTestRailClient|createJiraClient|XMLHttpRequest/);
    }
    expect(src('domain/supervisorOperations.ts')).not.toMatch(/Date\.now|new Date\(\)/);
  });

  it('one team only: no team selector or cross-team aggregation', () => {
    expect(src('features/commandCenter/CommandCenter.tsx')).not.toMatch(/Rakuten|DeliveryTeam|teamSelector|organization/i);
  });

  it('has EN and JA strings for everything it shows', () => {
    const keys = Object.keys(dict('en')).filter((k) => k.startsWith('ops.') || k === 'nav.commandCenter');
    expect(keys.length).toBeGreaterThan(80);
    for (const k of keys) expect(dict('ja')[k], k).toBeTruthy();
  });
});

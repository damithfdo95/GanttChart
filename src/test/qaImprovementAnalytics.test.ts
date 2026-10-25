import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEMO_STATE, normalizeQaInputs } from '../lib/storage/storage';
import { newProjectRecord } from '../domain/projects/lifecycle';
import {
  MIN_RELATIVE_CHANGE,
  buildQaImprovementAnalytics,
  percentChange,
  presetRange,
  previousRangeOf,
  weekStartOf,
  type QaImprovementInput,
} from '../domain/qaImprovementAnalytics';
import { accessTo, SCREEN_ACCESS } from '../app/access';
import { navItems } from '../app/navigation';
import { improvementSheets } from '../lib/export/exportData';
import { signalText } from '../features/improvement/ImprovementAnalytics';
import { dictionaries } from '../i18n/dictionaries';
import type { BugTicket, CaseExecutionEvent, DailyExecutionEntry, ProjectRecord, QaInputs, TestScope } from '../types';
import type { CaseStatus } from '../domain/testManagement';

const root = resolve(__dirname, '..');
const src = (rel: string): string => readFileSync(join(root, rel), 'utf8');
const dict = (lang: 'en' | 'ja'): Record<string, string> => dictionaries[lang] as Record<string, string>;

const NOW = '2026-10-01T00:00:00.000Z';
const TODAY = '2026-10-30';
const RANGE = { from: '2026-10-26', to: '2026-10-30' };
const DAYS = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'];
const prow = (date: string, n: number) => ({ id: `r-${date}`, date, plannedTesters: n, absentTesters: 0, nonWorkingDay: false, note: '' });
const entry = (date: string, over: Partial<DailyExecutionEntry> = {}): DailyExecutionEntry => ({ id: `d-${date}`, date, startTime: 540, endTime: 1050, overtimeMinutes: 0, intervalEnabled: true, testers: 4, pass: 0, fail: 0, notApplicable: 0, spo: 0, blocked: 0, retest: 0, questioned: 0, note: '', source: 'manual', ...over });
function project(id: string, over: Partial<QaInputs> = {}, extra: Partial<ProjectRecord> = {}): ProjectRecord {
  const inputs = normalizeQaInputs({ ...(DEMO_STATE as QaInputs), totalCases: 500, casesCompleted: 0, currentTesters: 4, startDate: '2026-10-01', targetCompletionDate: '2026-11-30', targetCompletionTime: null, planningRows: DAYS.map((d) => prow(d, 4)), dailyExecuted: [], bugTickets: [], ...over });
  return { ...newProjectRecord(inputs, { nameEn: `Project ${id}`, nameJa: `プロジェクト${id}`, status: 'ongoing' }, NOW, []), id: `rec_${id}`, projectId: `PRJ-${id}`, ...extra };
}
const scope = (id: string, projectId: string, workType: TestScope['workType']): TestScope => ({ id, projectId, name: id, status: 'active', order: 1, createdAt: NOW, updatedAt: NOW, totalTestCases: 100, ...(workType === undefined ? {} : { workType }) });
let n = 0;
const jst = (date: string, hhmm: string): string => new Date(`${date}T${hhmm}:00+09:00`).toISOString();
const ev = (projectId: string, scopeId: string, testCaseId: string, status: CaseStatus, date: string, hhmm = '10:00', over: Partial<CaseExecutionEvent> = {}): CaseExecutionEvent => ({ id: `evt_${(n += 1)}`, projectId, scopeId, testCaseId, status, executedAt: jst(date, hhmm), source: 'manual', ...over });
const ticket = (projectId: string, createdAt: string): BugTicket => ({ id: `t-${(n += 1)}`, projectId, title: 'Bug', url: 'https://x.example/1', createdAt, reportedBy: 'Hana' });

const run = (over: Partial<QaImprovementInput> & Pick<QaImprovementInput, 'projects'>) => buildQaImprovementAnalytics({ scopes: [], caseExecution: [], range: RANGE, today: TODAY, ...over });

describe('throughput', () => {
  it('daily completed cases come from the saved Daily Execution: day 1 = 100, day 2 = 120, total 220', () => {
    const a = project('A', { dailyExecuted: [entry('2026-10-26', { pass: 100 }), entry('2026-10-27', { pass: 100, fail: 10, notApplicable: 5, spo: 5 })] });
    const r = run({ projects: [a] });
    expect(r.days.map((d) => d.completed)).toEqual([100, 120, null, null, null]);
    expect(r.summary.completed).toBe(220);
    expect(r.basis).toBe('saved');
  });

  it('is not the event count: 3 events for 1 completed case stay 3 events and 1 completed', () => {
    const a = project('A', { dailyExecuted: [entry('2026-10-28', { pass: 1 })] });
    const events = [ev('PRJ-A', 's1', 'c1', 'fail', '2026-10-28', '10:00'), ev('PRJ-A', 's1', 'c1', 'inProgress', '2026-10-28', '11:00', { retest: true }), ev('PRJ-A', 's1', 'c1', 'pass', '2026-10-28', '12:00')];
    const r = run({ projects: [a], scopes: [scope('s1', 'PRJ-A', 'regression')], caseExecution: events });
    expect(r.summary.completed).toBe(1);
    expect(r.summary.executionEvents).toBe(3);
  });
});

describe('repeated execution', () => {
  const events = [ev('PRJ-A', 's1', 'c1', 'fail', '2026-10-28', '10:00'), ev('PRJ-A', 's1', 'c1', 'inProgress', '2026-10-28', '11:00', { retest: true }), ev('PRJ-A', 's1', 'c1', 'pass', '2026-10-28', '12:00')];
  const r = run({ projects: [project('A')], scopes: [scope('s1', 'PRJ-A', 'regression')], caseExecution: events, workType: 'regression' });

  it('Fail → Retest → Pass is 3 events, 1 unique case, 1 final completed case, 1 retest event', () => {
    expect(r.summary.executionEvents).toBe(3);
    expect(r.summary.uniqueCases).toBe(1);
    expect(r.summary.completed).toBe(1); // history basis under a work-type filter: the final state of the day
    expect(r.summary.failed).toBe(0); // the final status is Pass
    expect(r.summary.retestEvents).toBe(1);
    expect(r.summary.casesRunMoreThanOnce).toBe(1);
    expect(r.summary.retestPer100Events).toBeCloseTo(33.33, 1);
    expect(r.workTypes[0]).toMatchObject({ workType: 'regression', events: 3, uniqueCases: 1, completedCases: 1, retestEvents: 1 });
  });

  it('events are bucketed by the Tokyo business day', () => {
    const late = ev('PRJ-A', 's1', 'c9', 'pass', '2026-10-27', '23:30'); // 23:30 JST = 14:30 UTC, still the 27th
    const early = ev('PRJ-A', 's1', 'c8', 'pass', '2026-10-28', '00:30'); // 00:30 JST = the 27th in UTC
    const x = run({ projects: [project('A')], scopes: [scope('s1', 'PRJ-A', 'regression')], caseExecution: [late, early] });
    expect(x.days.find((d) => d.date === '2026-10-27')?.events).toBe(1);
    expect(x.days.find((d) => d.date === '2026-10-28')?.events).toBe(1);
  });
});

describe('failure rate', () => {
  it('Pass 90 + Fail 10 = 10%; blocked cases do not enter the denominator', () => {
    const a = project('A', { dailyExecuted: [entry('2026-10-28', { pass: 90, fail: 10, blocked: 40, questioned: 5, retest: 7 })] });
    const r = run({ projects: [a] });
    expect(r.summary.completed).toBe(100);
    expect(r.summary.failed).toBe(10);
    expect(r.summary.failureRate).toBeCloseTo(0.1, 10);
  });

  it('is null (not 0) when nothing was completed', () => {
    expect(run({ projects: [project('A')] }).summary.failureRate).toBeNull();
  });
});

describe('blocked trend', () => {
  it('counts project-days with blocked cases, from saved evidence only', () => {
    const a = project('A', { dailyExecuted: [entry('2026-10-26', { pass: 5, blocked: 3 }), entry('2026-10-27', { pass: 5, blocked: 0 }), entry('2026-10-28', { pass: 5, blocked: 2 })] });
    const r = run({ projects: [a] });
    expect(r.summary.blockedProjectDays).toBe(2);
    expect(r.summary.activeProjectDays).toBe(3);
    expect(r.days.map((d) => d.blocked)).toEqual([3, 0, 2, null, null]);
  });
});

describe('staffing plan accuracy', () => {
  const rows = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29'].map((d) => prow(d, 8));
  const a = project('A', { planningRows: rows, dailyExecuted: [entry('2026-10-26', { testers: 8 }), entry('2026-10-27', { testers: 6 }), entry('2026-10-28', { testers: 7 })] });
  const r = run({ projects: [a] });

  it('planned 8,8,8 vs actual 8,6,7: average 8 / 7 / -1, two days under plan', () => {
    expect(r.staffing).toMatchObject({ comparedDays: 3, avgPlanned: 8, avgActual: 7, avgVariance: -1, understaffedDays: 2, overPlannedDays: 0 });
  });

  it('a planned day with no recorded actual is missing coverage, never zero', () => {
    expect(r.staffing?.missingActualDays).toBe(1);
    expect(r.staffing?.comparedDays).toBe(3);
    expect(r.days.find((d) => d.date === '2026-10-29')?.actualTesters).toBeNull();
    expect(r.staffing?.avgActual).toBe(7);
  });

  it('is hidden under a work-type filter (staffing is project level)', () => {
    expect(run({ projects: [a], workType: 'regression', scopes: [scope('s1', 'PRJ-A', 'regression')] }).staffing).toBeNull();
  });
});

describe('schedule variance of completed releases', () => {
  const late = project('L', { targetCompletionDate: '2026-10-20' }, { status: 'done', completedAt: '2026-10-22T03:00:00.000Z' });
  const early = project('E', { targetCompletionDate: '2026-10-20' }, { status: 'done', completedAt: '2026-10-19T03:00:00.000Z' });
  const noPlan = project('N', { targetCompletionDate: null }, { status: 'done', completedAt: '2026-10-21T03:00:00.000Z' });
  const r = run({ projects: [late, early, noPlan], range: { from: '2026-10-01', to: '2026-10-30' } });

  it('planned Oct 20, completed Oct 22 is +2 days late; completed Oct 19 is -1 day early', () => {
    const by = Object.fromEntries(r.releases.map((x) => [x.projectId, x]));
    expect(by['PRJ-L']).toMatchObject({ daysVariance: 2, outcome: 'late' });
    expect(by['PRJ-E']).toMatchObject({ daysVariance: -1, outcome: 'early' });
    expect(by['PRJ-N']).toMatchObject({ daysVariance: null, outcome: 'unknown' });
    expect(r.summary.completedReleases).toBe(3);
    expect(r.summary.lateReleases).toBe(1);
  });

  it('a release completed before the range is not part of it, and an unfinished project has no release row', () => {
    const x = run({ projects: [late, project('Z')], range: { from: '2026-10-23', to: '2026-10-30' } });
    expect(x.releases).toEqual([]);
  });

  it('late releases appear in Areas to Review with the projects behind them', () => {
    const sig = r.signals.review.find((s) => s.id === 'lateReleases');
    expect(sig?.values).toMatchObject({ count: 1, of: 3 });
    expect(sig?.projects.map((p) => p.projectId)).toEqual(['PRJ-L']);
  });
});

describe('work types', () => {
  const scopes = [scope('sr', 'PRJ-A', 'regression'), scope('ss', 'PRJ-A', 'sanity'), scope('su', 'PRJ-A', undefined)];
  const events = [ev('PRJ-A', 'sr', 'r1', 'pass', '2026-10-28'), ev('PRJ-A', 'sr', 'r2', 'fail', '2026-10-28'), ev('PRJ-A', 'ss', 's1', 'pass', '2026-10-28'), ev('PRJ-A', 'su', 'u1', 'pass', '2026-10-29')];
  const r = run({ projects: [project('A')], scopes, caseExecution: events });

  it('Regression, Sanity and Unspecified of one mixed project are separate rows', () => {
    const by = Object.fromEntries(r.workTypes.map((w) => [w.workType, w]));
    expect(by.regression).toMatchObject({ events: 2, completedCases: 2, failedCases: 1, failureRate: 0.5 });
    expect(by.sanity).toMatchObject({ events: 1, completedCases: 1, failedCases: 0 });
    expect(by.unspecified).toMatchObject({ events: 1, completedCases: 1 });
    expect(by.adhoc).toBeUndefined();
  });

  it('a work-type filter keeps only that type', () => {
    const only = run({ projects: [project('A')], scopes, caseExecution: events, workType: 'sanity' });
    expect(only.workTypes.map((w) => w.workType)).toEqual(['sanity']);
    expect(only.summary.executionEvents).toBe(1);
    expect(only.summary.completed).toBe(1);
  });
});

describe('Verification keeps cases and tickets in separate units', () => {
  const events = Array.from({ length: 20 }, (_, i) => ev('PRJ-V', 'sv', `v${i}`, 'pass', '2026-10-28'));
  const tickets = Array.from({ length: 5 }, () => ticket('PRJ-V', '2026-10-28'));
  const r = run({ projects: [project('V', { bugTickets: tickets })], scopes: [scope('sv', 'PRJ-V', 'verification')], caseExecution: events });

  it('20 case executions and 5 tickets are never 25 items', () => {
    const v = r.workTypes.find((w) => w.workType === 'verification');
    expect(v).toMatchObject({ events: 20, completedCases: 20, tickets: 5 });
    expect(r.tickets.raised).toBe(5);
    expect(r.summary.executionEvents).toBe(20);
    expect(Object.values(r.summary).concat(Object.values(r.workTypes[0] ?? {}) as never[]).filter((v) => typeof v === 'number')).not.toContain(25);
    expect(r.workTypes.filter((w) => w.workType !== 'verification').every((w) => w.tickets === null)).toBe(true);
  });
});

describe('previous period comparison', () => {
  it('120 now vs 100 before is +20%', () => {
    const a = project('A', { dailyExecuted: [entry('2026-10-27', { pass: 120 }), entry('2026-10-21', { pass: 100 })] });
    const r = run({ projects: [a] });
    expect(r.previousRange).toEqual({ from: '2026-10-21', to: '2026-10-25' });
    expect(r.comparison.find((c) => c.metric === 'completed')).toMatchObject({ current: 120, previous: 100, percent: 0.2 });
    expect(r.signals.improved.map((s) => s.id)).toContain('throughput');
  });

  it('a previous value of 0 gives no percentage (never Infinity)', () => {
    const a = project('A', { dailyExecuted: [entry('2026-10-27', { pass: 120 })] });
    const r = run({ projects: [a] });
    expect(r.comparison.find((c) => c.metric === 'completed')?.percent).toBeNull();
    expect(percentChange(5, 0)).toBeNull();
    expect(percentChange(5, null)).toBeNull();
    expect(percentChange(0, 10)).toBe(-1);
    expect(r.signals.improved.map((s) => s.id)).not.toContain('throughput');
  });

  it('a change smaller than the one central threshold is not a signal', () => {
    const a = project('A', { dailyExecuted: [entry('2026-10-27', { pass: 102 }), entry('2026-10-21', { pass: 100 })] });
    const r = run({ projects: [a] });
    expect(0.02).toBeLessThan(MIN_RELATIVE_CHANGE);
    expect(r.signals.improved.concat(r.signals.review).map((s) => s.id)).not.toContain('throughput');
  });

  it('retest increase is described factually, and failure rate movement is in points', () => {
    const a = project('A', { dailyExecuted: [entry('2026-10-27', { pass: 90, fail: 10 }), entry('2026-10-21', { pass: 98, fail: 2 })] });
    const events = [
      ...Array.from({ length: 6 }, (_, i) => ev('PRJ-A', 's1', `a${i}`, 'pass', '2026-10-27', '10:00', { retest: true })),
      ...Array.from({ length: 5 }, (_, i) => ev('PRJ-A', 's1', `b${i}`, 'pass', '2026-10-22', '10:00', { retest: true })),
    ];
    const r = run({ projects: [a], scopes: [scope('s1', 'PRJ-A', 'regression')], caseExecution: events });
    const retest = r.signals.review.find((s) => s.id === 'retest');
    expect(retest?.values).toMatchObject({ current: 6, previous: 5 });
    expect(signalText('en', retest!)).toBe('Retest activity increased 20% (5 → 6 events) compared with the previous period.');
    const fr = r.signals.review.find((s) => s.id === 'failureRate');
    expect(fr?.values).toMatchObject({ pp: 8 });
    expect(signalText('ja', fr!)).toContain('8.0ポイント');
  });
});

describe('weeks, ranges and presets', () => {
  it('weeks are Monday to Sunday business dates', () => {
    expect(weekStartOf('2026-10-26')).toBe('2026-10-26');
    expect(weekStartOf('2026-11-01')).toBe('2026-10-26');
    expect(weekStartOf('2026-11-02')).toBe('2026-11-02');
    const a = project('A', { dailyExecuted: [entry('2026-10-26', { pass: 10 }), entry('2026-10-30', { pass: 20 })] });
    const r = run({ projects: [a], range: { from: '2026-10-26', to: '2026-11-01' }, today: '2026-11-01' });
    expect(r.weeks).toHaveLength(1);
    expect(r.weeks[0]).toMatchObject({ weekStart: '2026-10-26', completed: 30, days: 7 });
  });

  it('presets end today and the previous range is the adjacent equal-length one', () => {
    expect(presetRange(30, '2026-10-30')).toEqual({ from: '2026-10-01', to: '2026-10-30' });
    expect(presetRange(7, '2026-10-30')).toEqual({ from: '2026-10-24', to: '2026-10-30' });
    expect(previousRangeOf({ from: '2026-10-01', to: '2026-10-30' })).toEqual({ from: '2026-09-01', to: '2026-09-30' });
  });

  it('a future end date is clipped to today and an inverted range collapses', () => {
    const r = run({ projects: [project('A')], range: { from: '2026-11-05', to: '2027-01-01' } });
    expect(r.range.to).toBe(TODAY);
    expect(r.range.from <= r.range.to).toBe(true);
  });
});

describe('partial history', () => {
  const events = [ev('PRJ-A', 's1', 'c1', 'pass', '2026-10-28')];
  const scopes = [scope('s1', 'PRJ-A', 'regression')];

  it('warns when the range starts before the first recorded event', () => {
    const r = run({ projects: [project('A')], scopes, caseExecution: events });
    expect(r.history).toEqual({ hasEvents: true, firstEventDate: '2026-10-28', partial: true });
    expect(run({ projects: [project('A')], scopes, caseExecution: events, range: { from: '2026-10-28', to: '2026-10-30' } }).history.partial).toBe(false);
  });

  it('no history at all is reported as such, not as a warning date; days before history show no data, not 0', () => {
    const r = run({ projects: [project('A')] });
    expect(r.history).toEqual({ hasEvents: false, firstEventDate: null, partial: false });
    expect(r.days.every((d) => d.events === null)).toBe(true);
    const withHist = run({ projects: [project('A')], scopes, caseExecution: events });
    expect(withHist.days.map((d) => d.events)).toEqual([null, null, 1, 0, 0]);
  });
});

describe('only reconstructable history', () => {
  it('forecast accuracy, readiness trend and assigned history are reported as unavailable, with the current gap kept separate', () => {
    const r = run({ projects: [project('A')], assignments: [{ id: 'a1', projectId: 'PRJ-A', memberId: 'm1', startDate: '2026-10-01', active: true }] });
    expect(r.forecastAccuracy).toEqual({ available: false });
    expect(r.readinessTrend).toEqual({ available: false });
    expect(r.assignmentHistory.available).toBe(false);
    expect(r.assignmentHistory.currentGaps).toEqual([{ projectId: 'PRJ-A', projectName: 'Project A', planned: 4, assigned: 1 }]);
    expect(dict('en')['ia.limit.forecast']).toBe('Forecast accuracy unavailable — historical forecast snapshots are not stored.');
    expect(dict('en')['ia.limit.readiness']).toBe('Historical readiness snapshots required for trend analysis.');
  });

  it('the analytics source never reconstructs readiness, forecasts or policy from current state', () => {
    const code = src('domain/qaImprovementAnalytics.ts');
    expect(code).not.toMatch(/evaluateReleaseReadiness|from '\.\/readiness'|projectProjection|projectPlanningStatus|resolveQaPolicy|defaultQaPolicy|unresolvedDefectStatuses|fetch\(|XMLHttpRequest|WebSocket|Date\.now\(|new Date\(\)/);
    expect(src('features/improvement/ImprovementAnalytics.tsx')).not.toMatch(/fetch\(|XMLHttpRequest|testrail|jira/i);
  });
});

describe('no tester ranking', () => {
  it('Team Member facts are in name order with no rank, score or leaderboard field', () => {
    const members = [{ id: 'mZ', name: 'Zed', team: 'RCS', role: 'tester', startDate: '2026-01-01', active: true }, { id: 'mA', name: 'Aoi', team: 'RCS', role: 'tester', startDate: '2026-01-01', active: true }];
    const events = [...Array.from({ length: 5 }, (_, i) => ev('PRJ-A', 's1', `z${i}`, 'pass', '2026-10-28', '10:00', { executedByMemberId: 'mZ' })), ev('PRJ-A', 's1', 'a1', 'pass', '2026-10-28', '10:00', { executedByMemberId: 'mA' })];
    const r = run({ projects: [project('A')], scopes: [scope('s1', 'PRJ-A', 'regression')], caseExecution: events, members: members as never });
    expect(r.testers.map((x) => x.name)).toEqual(['Aoi', 'Zed']);
    expect(Object.keys(r.testers[0]!).sort()).toEqual(['activeDays', 'assignedScopes', 'events', 'key', 'name', 'uniqueCases']);
    expect(r.testers[1]).toMatchObject({ events: 5, uniqueCases: 5, activeDays: 1 });
  });

  it('no ranking, score, leaderboard or productivity wording exists in the analytics code or screen text', () => {
    const words = /\brank|leaderboard|top performer|low performer|productivity|\bscore\b/i;
    expect(src('domain/qaImprovementAnalytics.ts').replace(/no ranking[^\n]*/gi, '')).not.toMatch(words);
    expect(src('features/improvement/ImprovementAnalytics.tsx')).not.toMatch(words);
    for (const lang of ['en', 'ja'] as const) {
      for (const [k, v] of Object.entries(dict(lang))) if (k.startsWith('ia.') && k !== 'ia.note' && k !== 'ia.people.note') expect(v, k).not.toMatch(words);
    }
  });
});

describe('permissions', () => {
  it('management only: an SV and plain local use see it, a Tester never does, and the shell falls back for a direct route', () => {
    expect(accessTo('admin', 'improvement')).toBe('manage');
    expect(accessTo(null, 'improvement')).toBe('manage');
    expect(accessTo('user', 'improvement')).toBe('none');
    expect(SCREEN_ACCESS.improvement.tester).toBe('none');
    expect(navItems('user').map((i) => i.id)).not.toContain('improvement');
    expect(navItems('admin').map((i) => i.id)).toContain('improvement');
    expect(navItems('super_admin')).toEqual([]);
    const ids = navItems('admin').map((i) => i.id);
    expect(ids.indexOf('improvement')).toBe(ids.indexOf('commandCenter') + 1);
    const app = src('app/App.tsx');
    expect(app).toContain('!allowed ?');
    expect(app).toContain("activeScreen === 'improvement'");
  });
});

describe('isolation', () => {
  it('only the given projects count: another project (or workspace) never enters totals, history dates or testers', () => {
    const a = project('A', { dailyExecuted: [entry('2026-10-28', { pass: 10 })] });
    const b = project('B', { dailyExecuted: [entry('2026-10-28', { pass: 999 })] });
    const events = [ev('PRJ-A', 's1', 'c1', 'pass', '2026-10-28'), ev('PRJ-B', 's2', 'c2', 'pass', '2026-10-20', '10:00', { executedByMemberId: 'mB' })];
    const scopes = [scope('s1', 'PRJ-A', 'regression'), scope('s2', 'PRJ-B', 'regression')];
    const onlyA = run({ projects: [a], scopes, caseExecution: events });
    expect(onlyA.summary.completed).toBe(10);
    expect(onlyA.summary.executionEvents).toBe(1);
    expect(onlyA.history.firstEventDate).toBe('2026-10-28');
    expect(onlyA.testers).toEqual([]);
    const filtered = run({ projects: [a, b], scopes, caseExecution: events, projectId: 'PRJ-A' });
    expect(filtered.summary.completed).toBe(10);
    expect(filtered.projects.map((p) => p.projectId)).toEqual(['PRJ-A']);
    expect(filtered.history.firstEventDate).toBe('2026-10-28');
    expect(run({ projects: [a, b], scopes, caseExecution: events }).summary.completed).toBe(1009);
  });
});

describe('lifecycle inclusion', () => {
  it('includes active projects and releases completed in the range; leaves out projects finished before it', () => {
    const active = project('A');
    const finishedBefore = project('F', {}, { status: 'done', completedAt: '2026-08-01T03:00:00.000Z' });
    const finishedIn = project('I', {}, { status: 'done', completedAt: '2026-10-28T03:00:00.000Z' });
    const r = run({ projects: [active, finishedBefore, finishedIn] });
    expect(r.projects.map((p) => p.projectId)).toEqual(['PRJ-A', 'PRJ-I']);
  });
});

describe('export and strings', () => {
  it('the workbook is several logical tables, not one denormalised sheet', () => {
    const a = project('A', { dailyExecuted: [entry('2026-10-27', { pass: 120 })] });
    const r = run({ projects: [a], scopes: [scope('s1', 'PRJ-A', 'regression')], caseExecution: [ev('PRJ-A', 's1', 'c1', 'pass', '2026-10-27')] });
    const sheets = improvementSheets('en', r);
    expect(sheets.map((s) => s.name)).toEqual(['Daily trend', 'Work types', 'Release schedule', 'Staffing variance', 'Period comparison']);
    expect(sheets[0]!.rows).toHaveLength(5);
    expect(sheets[0]!.rows[1]![1]).toBe(120);
    expect(sheets[0]!.rows[0]![1]).toBe('—'); // no data is not 0
    expect(sheets[4]!.rows.find((x) => x[0] === 'Completed cases')).toEqual(['Completed cases', 120, 0, 120]);
    expect(improvementSheets('ja', r)[0]!.name).toBe('日別推移');
  });

  it('every analytics string exists in English and Japanese, and the screen has accessible charts', () => {
    const keys = Object.keys(dict('en')).filter((k) => k.startsWith('ia.') || k === 'nav.improvement');
    expect(keys.length).toBeGreaterThan(100);
    for (const k of keys) expect(dict('ja')[k], k).toBeTruthy();
    expect(dict('en')['nav.improvement']).toBe('Improvement Analytics');
    const ui = src('features/improvement/ImprovementAnalytics.tsx');
    expect(ui).toContain('<figcaption>{title}</figcaption>');
    expect(ui).toContain('role="img"');
    expect(ui).toContain('<details>');
    expect(ui).toContain('strokeDasharray'); // a second line style, not colour alone
  });
});

describe('performance', () => {
  it('90 days, 20 projects and 6000 events build in well under a second', () => {
    const projects = Array.from({ length: 20 }, (_, i) => project(`P${i}`, { dailyExecuted: DAYS.map((d) => entry(d, { pass: 10 })) }));
    const scopes = projects.map((p) => scope(`s-${p.projectId}`, p.projectId, 'regression'));
    const events = Array.from({ length: 6000 }, (_, i) => ev(`PRJ-P${i % 20}`, `s-PRJ-P${i % 20}`, `c${i % 300}`, 'pass', DAYS[i % 5]!, '10:00'));
    const t0 = Date.now();
    const r = run({ projects, scopes, caseExecution: events, range: presetRange(90, TODAY) });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(r.summary.executionEvents).toBe(6000);
  });
});

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEMO_STATE, normalizeQaInputs } from '../lib/storage/storage';
import { newProjectRecord } from '../domain/projects/lifecycle';
import { prepareDailyReportDraft, reportStateForDate, type PreparedDailyReportDraft } from '../domain/dailyReportDraft';
import type { CaseStatus } from '../domain/testManagement';
import { defaultQaPolicy } from '../../shared/qaPolicy';
import { preparedDraftPreview, preparedTopicText, preparedTopicsAsRecords } from '../features/daily-report/preparedDraft';
import { buildReportSections, renderActivitiesSection, renderStaffingLine } from '../lib/reporting/sections';
import { createRevision, finalizeReport, newDraft } from '../lib/reporting/drafts';
import { accessTo } from '../app/access';
import { dictionaries } from '../i18n/dictionaries';
import type { BugTicket, CaseExecutionEvent, DailyExecutionEntry, DailyReport, ProjectLifecycleStatus, ProjectRecord, QaInputs, TestCase, TestScope, TesterProjectAssignment } from '../types';
import type { DailyReportDraftInput } from '../domain/dailyReportDraft';

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
  const inputs = normalizeQaInputs({ ...(DEMO_STATE as QaInputs), totalCases: 100, casesCompleted: 60, casesPassed: 60, currentTesters: 4, startDate: '2026-10-26', targetCompletionDate: '2026-10-30', targetCompletionTime: null, planningRows: DAYS.map((d) => row(d, 4)), dailyExecuted: [entry(YESTERDAY, { pass: 60, testers: 4 })], bugTickets: [], ...over });
  return { ...newProjectRecord(inputs, { nameEn: `Project ${id}`, nameJa: `プロジェクト${id}`, status }, NOW, []), id: `rec_${id}`, projectId: `PRJ-${id}` };
}
const scope = (id: string, projectId: string, workType: TestScope['workType'], total: number): TestScope => ({ id, projectId, name: `${id} scope`, status: 'active', order: 1, createdAt: NOW, updatedAt: NOW, totalTestCases: total, ...(workType === undefined ? {} : { workType }) });
const tcase = (id: string, projectId: string, scopeId: string): TestCase => ({ id, projectId, scopeId, key: id.toUpperCase(), title: `case ${id}`, priority: 'medium', status: 'active', order: 1, createdAt: NOW, updatedAt: NOW });
let n = 0;
const ev = (projectId: string, scopeId: string, testCaseId: string, status: CaseStatus, date: string): CaseExecutionEvent => ({ id: `evt_${(n += 1)}`, projectId, scopeId, testCaseId, status, executedAt: jst(date, '10:00'), source: 'manual' });
const assign = (projectId: string, memberId: string): TesterProjectAssignment => ({ id: `a-${projectId}-${memberId}`, projectId, memberId, startDate: '2026-10-01', active: true });
const ticket = (projectId: string, over: Partial<BugTicket> = {}): BugTicket => ({ id: `t-${projectId}-${n++}`, projectId, title: 'Crash', url: 'https://x.example/1', createdAt: '2026-10-20', reportedBy: 'Hana', ...over });

/** A: Regression (done today), B: Sanity (late forecast), C: Verification (Critical ticket, executed today). */
function input(over: Partial<DailyReportDraftInput> = {}): DailyReportDraftInput {
  const a = project('A', { dailyExecuted: [entry(YESTERDAY, { pass: 50, testers: 4 }), entry(TODAY, { pass: 8, fail: 1, testers: 3 })] });
  const b = project('B', { totalCases: 3000, casesCompleted: 60, dailyExecuted: [entry(YESTERDAY, { pass: 40, testers: 2 }), entry(TODAY, { pass: 2, testers: 2 })] });
  const c = project('C', { bugTickets: [ticket('PRJ-C', { severity: 'Critical', status: 'Open', ticketKey: 'ABC-1' }), ticket('PRJ-C', { severity: 'Major', status: 'In Progress' })], dailyExecuted: [entry(YESTERDAY, { pass: 10, testers: 1 }), entry(TODAY, { pass: 4, testers: 1 })] });
  return {
    language: 'en',
    projects: [a, b, c],
    scopes: [scope('sa', 'PRJ-A', 'regression', 3), scope('sb', 'PRJ-B', 'sanity', 2), scope('sc', 'PRJ-C', 'verification', 2)],
    cases: [tcase('a1', 'PRJ-A', 'sa'), tcase('a2', 'PRJ-A', 'sa'), tcase('b1', 'PRJ-B', 'sb'), tcase('c1', 'PRJ-C', 'sc')],
    caseExecution: [ev('PRJ-A', 'sa', 'a1', 'pass', TODAY), ev('PRJ-B', 'sb', 'b1', 'pass', TODAY), ev('PRJ-C', 'sc', 'c1', 'pass', TODAY), ev('PRJ-A', 'sa', 'a2', 'pass', YESTERDAY)],
    assignments: [assign('PRJ-A', 'm1'), assign('PRJ-A', 'm2'), assign('PRJ-B', 'm1'), assign('PRJ-C', 'm3')],
    members: [],
    policy: defaultQaPolicy(),
    selectedDate: TODAY,
    today: TODAY,
    nowIso: NOW_ISO,
    ...over,
  };
}
const draft = (over: Partial<DailyReportDraftInput> = {}): PreparedDailyReportDraft => prepareDailyReportDraft(input(over));
const preview = (d: PreparedDailyReportDraft) => preparedDraftPreview(d.language, d);

describe('a fresh draft for today', () => {
  it('has staffing facts, work-type activities with exact units, and the relevant topics - and no side effects', () => {
    const in1 = input();
    const frozen = JSON.stringify(in1);
    const d = prepareDailyReportDraft(in1);
    expect(JSON.stringify(in1)).toBe(frozen);
    expect(d.staffing).toEqual({ planned: 12, assigned: 3, actual: 6 });
    expect(d.activities.map((a) => [a.name, a.workTypes])).toEqual([['Project A', ['regression']], ['Project B', ['sanity']], ['Project C', ['verification']]]);
    expect(d.topics.map((t) => t.code)).toEqual(['critical_defect_open', 'day_failures', 'capacity_shortage', 'staffing_gap']);
    expect(d.topics[0]).toMatchObject({ code: 'critical_defect_open', severity: 'blocking', scope: 'current' });
    expect(d.topics.find((t) => t.code === 'day_failures')).toMatchObject({ scope: 'day', source: { kind: 'dayFailures', count: 1 } });
    expect(d.missing).toEqual([]);
    expect(d.isHistorical).toBe(false);
  });

  it('is a proposal only: the generator and its previews never write a report', () => {
    for (const f of ['domain/dailyReportDraft.ts', 'features/daily-report/preparedDraft.ts', 'features/daily-report/PreparedDraftPanel.tsx', 'features/commandCenter/CommandCenter.tsx']) {
      expect(src(f), f).not.toMatch(/upsertReport|addTopic|removeReport|finalizeReport|newDraft\(/);
    }
  });

  it('the composer writes only on the two explicit actions and never while a proposal is open', () => {
    const c = src('features/daily-report/DailyReport.tsx');
    expect(c).toContain('!finalizedForDate && !proposing');
    expect(c).toContain('if (prepared === null || draft !== undefined || finalizedForDate) return;');
    expect(c).toContain("preparedFrom: { generatedAt: now, generatedForDate: selectedDate }");
  });
});

describe('work types and units', () => {
  it('groups activities by QA work type (including adhoc and unspecified) in a fixed order', () => {
    const d = draft({
      scopes: [scope('sa', 'PRJ-A', 'adhoc', 3), scope('sb', 'PRJ-B', undefined, 2), scope('sc', 'PRJ-C', 'verification', 2)],
    });
    const text = renderActivitiesSection('en', d.activities);
    expect(text.indexOf('Adhoc')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('Verification')).toBeGreaterThan(text.indexOf('Adhoc'));
    expect(text.indexOf('Unspecified')).toBeGreaterThan(text.indexOf('Verification'));
    expect(text).toContain('- 3: Project A');
  });

  it('keeps Verification test cases and JIRA tickets as separate units', () => {
    const d = draft();
    const c = d.activities.find((a) => a.name === 'Project C')!;
    expect(c.ticketCount).toBe(2); // Open + In Progress tickets
    expect(c.casesPassed).toBe(4);
    const line = renderActivitiesSection('en', d.activities).split('\n').find((l) => l.includes('Project C'))!;
    expect(line).toContain('4 case(s) / 2 open ticket(s)');
    expect(d.activities.find((a) => a.name === 'Project A')!.ticketCount).toBeUndefined();
  });

  it('older activities without work types render exactly as before', () => {
    const legacy = draft().activities.map(({ workTypes: _w, ticketCount: _t, ...rest }) => rest);
    expect(renderActivitiesSection('en', legacy)).toBe(legacy.map((a) => `${a.memberCount}: ${a.name}`).join('\n'));
  });

  it('only projects that had work on the date are included', () => {
    const quiet = project('Q', { dailyExecuted: [entry(YESTERDAY, { pass: 5 })] });
    const d = draft({ projects: [...input().projects, quiet] });
    expect(d.activities.map((a) => a.name)).not.toContain('Project Q');
  });
});

describe('staffing is staffing, not attendance', () => {
  it('is rendered as its own labelled line beneath the formal attendance, in the report language', () => {
    const d = draft();
    const sections = buildReportSections({ language: 'en', activities: d.activities, attendance: [], topics: [], nextDay: [], jiraUrl: '', rules: { working: 'totalCases', complete: 'totalCases' }, staffing: d.staffing });
    expect(sections.attendance).toBe('Staffing: Planned 12 · Assigned 3 · Actual 6');
    expect(sections.attendance).not.toMatch(/attending/i);
    const ja = renderStaffingLine('ja', d.staffing);
    expect(ja).toBe('体制: 予定 12名 · 割り当て 3名 · 実績 6名');
    expect(renderStaffingLine('en', undefined)).toBe('');
    expect(renderStaffingLine('en', { planned: null, assigned: null, actual: 5 })).toBe('Staffing: Actual 5');
  });
});

describe('a historical date uses only that day\'s own data', () => {
  it('yesterday: its execution and actual testers, its case history - no current readiness or ticket state in the draft', () => {
    const d = draft({ selectedDate: YESTERDAY });
    expect(d.isHistorical).toBe(true);
    expect(d.staffing).toEqual({ planned: null, assigned: null, actual: 7 }); // 4 + 2 + 1 testers recorded yesterday
    expect(d.activities.find((a) => a.name === 'Project A')).toMatchObject({ casesPassed: 50, memberCount: 4 });
    expect(d.activities.every((a) => a.ticketCount === undefined)).toBe(true);
    expect(d.topics.every((t) => t.scope === 'day')).toBe(true);
    expect(d.topics.map((t) => t.code)).not.toContain('critical_defect_open');
    // the present state is offered separately, never inserted
    expect(d.currentContext.map((c) => c.reasonCode)).toContain('critical_defect_open');
    expect(d.activities.find((a) => a.name === 'Project A')!.workTypes).toEqual(['regression']); // from yesterday's executed case
  });

  it('cumulative progress is as of the report date, not today', () => {
    const d = draft({ selectedDate: YESTERDAY });
    expect(d.activities.find((a) => a.name === 'Project A')!.completedCases).toBe(50);
    expect(draft().activities.find((a) => a.name === 'Project A')!.completedCases).toBe(59);
  });
});

describe('today\'s current topics follow the data, saved reports do not', () => {
  it('resolving the ticket changes a NEWLY generated draft; an existing saved draft is left exactly as it is', () => {
    const before = draft();
    const saved: DailyReport = { ...newDraft(TODAY, 'en', 'SV', NOW_ISO), activities: before.activities, staffing: before.staffing };
    const frozen = JSON.stringify(saved);
    const resolved = input();
    const c = resolved.projects.find((p) => p.projectId === 'PRJ-C')!;
    c.inputs = { ...c.inputs, bugTickets: (c.inputs.bugTickets ?? []).map((t) => (t.severity === 'Critical' ? { ...t, status: 'Resolved' as const } : t)) };
    const after = prepareDailyReportDraft(resolved);
    expect(before.topics.map((t) => t.code)).toContain('critical_defect_open');
    expect(after.topics.map((t) => t.code)).not.toContain('critical_defect_open');
    expect(JSON.stringify(saved)).toBe(frozen);
  });

  it('does not repeat the failure counts: the day fact replaces the cumulative readiness topic', () => {
    const codes = draft().topics.map((t) => t.code);
    expect(codes).not.toContain('test_failures_open');
    expect(codes).not.toContain('blocked_cases_open');
  });
});

describe('report state, existing drafts and finalized reports', () => {
  const rep = (status: 'DRAFT' | 'FINALIZED', date = TODAY) => ({ reportDate: date, status });
  it('reports none, draft or finalized for the date; a revision draft counts as a draft', () => {
    expect(reportStateForDate([], TODAY)).toBe('none');
    expect(reportStateForDate([rep('DRAFT')], TODAY)).toBe('draft');
    expect(reportStateForDate([rep('FINALIZED')], TODAY)).toBe('finalized');
    expect(reportStateForDate([rep('FINALIZED'), rep('DRAFT')], TODAY)).toBe('draft');
    expect(reportStateForDate([rep('FINALIZED', YESTERDAY)], TODAY)).toBe('none');
  });

  it('the Command Center action reads Prepare / Continue / View and hands the selected date to the report screen', () => {
    const cc = src('features/commandCenter/CommandCenter.tsx');
    expect(cc).toContain("none: 'ops.report.prepare'");
    expect(cc).toContain("draft: 'ops.report.continue'");
    expect(cc).toContain('REPORT_ACTION_KEY[reportState]');
    expect(cc).toContain('onClick={() => onPrepareReport(date)}');
    const app = src('app/App.tsx');
    expect(app).toContain('setReportIntent({ date })');
    expect(app).toContain('initialDate: reportIntent.date');
    expect(src('features/daily-report/DailyReport.tsx')).toContain('initialDate ?? formatDate(todayEpochDays())');
  });

  it('a draft that exists is kept: regeneration is a separate, confirmed action that keeps manual activities', () => {
    const c = src('features/daily-report/DailyReport.tsx');
    expect(c).toContain("ask(t(uiLang, 'dailyReport.prepare.regenerateConfirm')");
    expect(c).toContain("draft.activities.filter((a) => a.source === 'MANUAL')");
    expect(dict('en')['dailyReport.prepare.regenerateConfirm']).toContain('manual edits');
  });

  it('only a Tester-free management screen: the Daily Report stays SV-only', () => {
    expect(accessTo('user', 'dailyReport')).toBe('none');
    expect(accessTo('admin', 'dailyReport')).toBe('manage');
  });
});

describe('a finalized report is a historical snapshot', () => {
  it('keeps its activities, work types, staffing and topics whatever changes later', () => {
    const d = draft();
    const base: DailyReport = { ...newDraft(TODAY, 'en', 'SV', NOW_ISO), activities: d.activities, staffing: d.staffing };
    const topics = preparedTopicsAsRecords('en', d.topics, TODAY, 'SV', NOW_ISO, 0);
    const finalized = finalizeReport(base, [], topics, 'SV', NOW_ISO);
    const frozen = JSON.stringify(finalized);
    const renderFrom = (r: DailyReport): string => {
      const s = r.snapshot!;
      return JSON.stringify(buildReportSections({ language: s.language, activities: s.activities, attendance: s.attendance, topics: s.topics, nextDay: s.nextDay, jiraUrl: '', rules: { working: 'totalCases', complete: 'totalCases' }, ...(s.staffing === undefined ? {} : { staffing: s.staffing }) }));
    };
    const before = renderFrom(finalized);
    // later edits to the workspace: scope work type, project name, execution, tickets, policy
    const changed = input({ scopes: [scope('sa', 'PRJ-A', 'sanity', 3)], policy: { ...defaultQaPolicy(), defectsAction: 'atRisk' } });
    changed.projects[0]!.nameEn = 'Renamed';
    changed.projects[0]!.inputs = { ...changed.projects[0]!.inputs, dailyExecuted: [entry(TODAY, { pass: 99 })] };
    prepareDailyReportDraft(changed);
    expect(JSON.stringify(finalized)).toBe(frozen);
    expect(renderFrom(finalized)).toBe(before);
    expect(before).toContain('Regression');
    expect(before).toContain('Project A');
    expect(before).toContain('Staffing: Planned 12');
    expect(finalized.snapshot!.staffing).toEqual(d.staffing);
  });

  it('rendering a finalized report takes only the snapshot - no scopes, policy or live projects', () => {
    expect(src('lib/reporting/sections.ts')).not.toMatch(/scopes|qaPolicy|workTypeOf|useReports/);
    const rev = createRevision(finalizeReport({ ...newDraft(TODAY, 'en', 'SV', NOW_ISO), staffing: { planned: 1, assigned: 2, actual: 3 } }, [], [], 'SV', NOW_ISO), NOW_ISO);
    expect(rev.staffing).toEqual({ planned: 1, assigned: 2, actual: 3 });
    expect(rev.status).toBe('DRAFT');
  });
});

describe('language', () => {
  it('English and Japanese drafts are not mixed', () => {
    const en = draft({ language: 'en' });
    const ja = draft({ language: 'ja' });
    const enText = [renderStaffingLine('en', en.staffing), renderActivitiesSection('en', en.activities), ...en.topics.map((t) => preparedTopicText('en', t))].join('\n');
    const jaText = [renderStaffingLine('ja', ja.staffing), renderActivitiesSection('ja', ja.activities), ...ja.topics.map((t) => preparedTopicText('ja', t))].join('\n');
    expect(enText).toMatch(/Regression/);
    expect(enText).not.toMatch(/[぀-ヿ]/);
    expect(jaText).toMatch(/リグレッション/);
    expect(jaText).not.toMatch(/Staffing|Regression|Planned|ticket\(s\)|Project A/);
    expect(ja.activities[0]!.name).toBe('プロジェクトA');
  });

  it('every new string exists in both languages', () => {
    for (const k of Object.keys(dict('en')).filter((x) => /^(dailyReport\.prepare\.|draft\.|report\.staffing|report\.activityUnits|ops\.report\.)/.test(x))) expect(dict('ja')[k], k).toBeTruthy();
  });
});

describe('completeness and isolation', () => {
  it('names plain gaps without scoring', () => {
    const empty = draft({ projects: [project('Q', { dailyExecuted: [] })], scopes: [], cases: [], caseExecution: [], assignments: [] });
    expect(empty.missing).toEqual(expect.arrayContaining(['noActivity', 'noTopics']));
  });

  it("one project's data never enters another's activity or topics", () => {
    const d = draft();
    expect(d.topics.filter((t) => t.code === 'critical_defect_open').map((t) => t.projectId)).toEqual(['PRJ-C']);
    expect(d.activities.find((a) => a.name === 'Project A')!.ticketCount).toBeUndefined();
  });

  it('makes no network call', () => {
    for (const f of ['domain/dailyReportDraft.ts', 'features/daily-report/preparedDraft.ts']) expect(src(f)).not.toMatch(/fetch\(|createTestRailClient|createJiraClient|XMLHttpRequest/);
    expect(src('domain/dailyReportDraft.ts')).not.toMatch(/Date\.now|new Date\(\)/);
  });

  it('previews the exact text blocks it would store', () => {
    const p = preview(draft());
    expect(p.staffing).toContain('Planned 12');
    expect(p.activities).toContain('Regression');
    expect(p.topics.length).toBeGreaterThan(0);
  });
});

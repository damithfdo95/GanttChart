import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEMO_STATE, normalizeQaInputs } from '../lib/storage/storage';
import { newProjectRecord } from '../domain/projects/lifecycle';
import { READINESS_CODES, canViewReadiness, evaluateReleaseReadiness, readinessBadgeKey, type ReadinessInput, type ReleaseReadiness } from '../domain/readiness';
import { ReadinessBadge, ReadinessCard } from '../features/readiness/ReadinessCard';
import { OverallProjectTable } from '../features/overall/OverallTable';
import { projectsSheet } from '../lib/export/exportData';
import { dictionaries } from '../i18n/dictionaries';
import type { BugTicket, CaseExecutionEvent, DailyExecutionEntry, ProjectLifecycleStatus, ProjectRecord, QaInputs, TestCase, TestScope, TesterProjectAssignment } from '../types';

const root = resolve(__dirname, '..');
const src = (rel: string): string => readFileSync(join(root, rel), 'utf8');
const dict = (lang: 'en' | 'ja'): Record<string, string> => dictionaries[lang] as Record<string, string>;
const NOW = '2026-10-01T00:00:00.000Z';
const TODAY = '2026-10-27'; // a Tuesday
const NOW_ISO = '2026-10-27T01:00:00.000Z';

const row = (date: string, plannedTesters = 8) => ({ id: `r-${date}`, date, plannedTesters, absentTesters: 0, nonWorkingDay: false, note: '' });
const DAYS = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'];
const entry = (date: string, over: Partial<DailyExecutionEntry> = {}): DailyExecutionEntry => ({ id: `d-${date}`, date, startTime: 540, endTime: 1050, overtimeMinutes: 0, intervalEnabled: true, testers: 4, pass: 60, fail: 0, notApplicable: 0, spo: 0, blocked: 0, retest: 0, questioned: 0, note: '', source: 'manual', ...over });

function project(over: Partial<QaInputs> = {}, status: ProjectLifecycleStatus = 'ongoing', projectId = 'PRJ-001'): ProjectRecord {
  const inputs = normalizeQaInputs({
    ...(DEMO_STATE as QaInputs),
    totalCases: 100,
    casesCompleted: 60,
    casesPassed: 60,
    currentTesters: 4,
    startDate: '2026-10-26',
    targetCompletionDate: '2026-10-30',
    targetCompletionTime: null,
    planningRows: DAYS.map((d) => row(d, 4)),
    dailyExecuted: [entry('2026-10-26')],
    bugTickets: [],
    ...over,
  });
  return { ...newProjectRecord(inputs, { nameEn: 'Alpha', status }, NOW, []), id: `rec_${projectId}`, projectId };
}
const assign = (n: number, projectId = 'PRJ-001'): TesterProjectAssignment[] => Array.from({ length: n }, (_, i) => ({ id: `a${projectId}${i}`, projectId, memberId: `m${i}`, startDate: '2026-10-01', active: true }));
const ticket = (over: Partial<BugTicket> = {}): BugTicket => ({ id: 't1', projectId: 'PRJ-001', title: 'Crash on launch', url: 'https://x.example/1', createdAt: '2026-10-20', reportedBy: 'Hana', ...over });
const run = (p: ProjectRecord, over: Partial<ReadinessInput> = {}): ReleaseReadiness => evaluateReleaseReadiness({ project: p, today: TODAY, nowIso: NOW_ISO, assignments: assign(4), ...over });
const codes = (r: ReleaseReadiness): string[] => r.reasons.map((x) => x.code);

describe('Ready', () => {
  it('a healthy in-progress project with evidence, nothing blocking and nothing late is Ready - with no warnings', () => {
    const r = run(project({ bugTickets: [ticket({ severity: 'Major', status: 'Resolved' })] }));
    expect(r.state).toBe('ready');
    expect(r.applicability).toBe('evaluated');
    expect(r.reasons.filter((x) => x.severity !== 'info')).toEqual([]);
  });

  it('is never Ready by silence: an active project with no execution evidence or no test total is At Risk', () => {
    const none = run(project({ dailyExecuted: [], casesCompleted: 0, casesPassed: 0 }));
    expect(none.state).toBe('atRisk');
    expect(codes(none)).toContain('no_execution_data');
    const noPlan = run(project({ totalCases: 0, casesCompleted: 0, dailyExecuted: [] }));
    expect(codes(noPlan)).toContain('insufficient_plan_data');
    expect(noPlan.state).toBe('atRisk');
  });
});

describe('Blocked', () => {
  it('an unresolved Critical defect blocks, with a stable reason code', () => {
    const r = run(project({ bugTickets: [ticket({ severity: 'Critical', status: 'Open', ticketKey: 'ABC-1' })] }));
    expect(r.state).toBe('blocked');
    expect(r.reasons[0]).toMatchObject({ code: 'critical_defect_open', severity: 'blocking', category: 'defects', messageKey: 'readiness.reason.critical_defect_open', metadata: { count: 1, tickets: 'ABC-1' } });
  });

  it('a resolved Critical or an unresolved Major defect does not block; a Critical with no recorded status is only a warning', () => {
    expect(run(project({ bugTickets: [ticket({ severity: 'Critical', status: 'Closed' })] })).state).toBe('ready');
    expect(run(project({ bugTickets: [ticket({ severity: 'Major', status: 'Open' })] })).state).toBe('ready');
    const unknown = run(project({ bugTickets: [ticket({ severity: 'Critical' })] }));
    expect(unknown.state).toBe('atRisk');
    expect(codes(unknown)).toContain('critical_defect_status_unknown');
  });

  it('failed or blocked tests are At Risk, never Blocked by themselves (no release-blocker semantics in the model)', () => {
    const failed = run(project({ dailyExecuted: [entry('2026-10-26', { pass: 55, fail: 5, blocked: 2 })], casesCompleted: 60 }));
    expect(failed.state).toBe('atRisk');
    expect(codes(failed)).toEqual(expect.arrayContaining(['test_failures_open', 'blocked_cases_open']));
    expect(failed.reasons.some((r) => r.severity === 'blocking')).toBe(false);
  });

  it('a blocking defect outranks warnings, and the order is deterministic (blockers first)', () => {
    const r = run(project({ dailyExecuted: [entry('2026-10-26', { pass: 55, fail: 5 })], bugTickets: [ticket({ severity: 'Critical', status: 'In Progress' })] }));
    expect(r.state).toBe('blocked');
    expect(codes(r).slice(0, 2)).toEqual(['critical_defect_open', 'test_failures_open']);
  });
});

describe('At Risk: schedule and completeness', () => {
  it('overdue with testing left is At Risk (not Blocked: release completion is not mandatory in the model) and explained once', () => {
    const r = run(project(), { today: '2026-11-02' });
    expect(r.state).toBe('atRisk');
    expect(codes(r)).toContain('project_overdue');
    expect(codes(r)).not.toContain('projected_finish_late');
    expect(codes(r)).not.toContain('capacity_shortage');
    expect(r.reasons.find((x) => x.code === 'project_overdue')?.metadata).toMatchObject({ remaining: 40, daysOverdue: 3 });
  });

  it('an overdue project whose forecast is also late is one schedule reason, not two descriptions of the same condition', () => {
    const r = run(project({ totalCases: 3000, casesCompleted: 60, casesPassed: 60 }), { today: '2026-11-02' });
    expect(r.reasons.filter((x) => x.category === 'schedule').map((x) => x.code)).toEqual(['project_overdue']);
    expect(codes(r)).not.toContain('execution_incomplete');
  });

  describe('projected finish late', () => {
    // 150 cases, one tester, plan ends 2026-10-30 10:00: capacity by the date suffices, but the finish (17:30 that day) is after the planned time.
    const lateProject = (over: Partial<QaInputs> = {}): ProjectRecord =>
      project({ totalCases: 150, casesCompleted: 0, casesPassed: 0, currentTesters: 1, targetCompletionTime: '10:00', planningRows: DAYS.map((d) => row(d, 1)), dailyExecuted: [entry('2026-10-26', { pass: 0 })], ...over });
    const lateRun = (over: Partial<ReadinessInput> = {}): ReleaseReadiness => run(lateProject(), { assignments: assign(1), ...over });

    it('before the end date, with a finish after the planned end, it is At Risk with exactly one projected_finish_late reason', () => {
      const r = lateRun();
      expect(r.state).toBe('atRisk');
      expect(codes(r).filter((c) => c === 'projected_finish_late')).toHaveLength(1);
      expect(r.reasons.find((x) => x.code === 'projected_finish_late')).toMatchObject({ severity: 'warning', category: 'schedule', metadata: { planned: '2026-10-30', projected: '2026-10-30', daysLate: null } });
      expect(codes(r)).not.toContain('project_overdue');
      expect(codes(r)).not.toContain('capacity_shortage');
      expect(r.reasons.some((x) => x.severity === 'blocking')).toBe(false);
      expect(r.reasons.filter((x) => x.category === 'schedule' && x.severity === 'warning').map((x) => x.code)).toEqual(['projected_finish_late']);
    });

    it('once the planned end has passed, the overdue reason stands alone (the late forecast adds nothing)', () => {
      const r = lateRun({ today: '2026-11-02' });
      expect(r.state).toBe('atRisk');
      expect(r.reasons.filter((x) => x.category === 'schedule' && x.severity === 'warning').map((x) => x.code)).toEqual(['project_overdue']);
      expect(codes(r)).not.toContain('projected_finish_late');
    });

    it('a forecast that meets the planned end has no projected_finish_late reason', () => {
      const onTime = run(project({ totalCases: 60, casesCompleted: 0, casesPassed: 0, currentTesters: 1, targetCompletionTime: '10:00', planningRows: DAYS.map((d) => row(d, 1)), dailyExecuted: [entry('2026-10-26', { pass: 0 })] }), { assignments: assign(1) });
      expect(codes(onTime)).not.toContain('projected_finish_late');
      expect(codes(onTime)).not.toContain('project_overdue');
      expect(onTime.state).toBe('ready');
    });
  });

  it('a forecast later than the plan, before the date, is At Risk', () => {
    const r = run(project({ totalCases: 3000, casesCompleted: 60, casesPassed: 60 }));
    expect(r.state).toBe('atRisk');
    expect(codes(r).some((c) => c === 'projected_finish_late' || c === 'capacity_shortage')).toBe(true);
    expect(codes(r)).not.toContain('project_overdue');
  });

  it('close to the end date with much still open is incomplete execution; without a target date no schedule risk is invented', () => {
    const near = run(project({ totalCases: 100, casesCompleted: 40, dailyExecuted: [entry('2026-10-26', { pass: 40 })] }), { today: '2026-10-29' });
    expect(codes(near)).toContain('execution_incomplete');
    const open = run(project({ targetCompletionDate: null }));
    expect(codes(open)).not.toEqual(expect.arrayContaining(['project_overdue']));
    expect(open.reasons.find((x) => x.code === 'no_target_date')?.severity).toBe('info');
    expect(open.state).toBe('ready');
  });

  it('complete testing past the date is not a release risk by itself', () => {
    const done = run(project({ casesCompleted: 100, casesPassed: 100, dailyExecuted: [entry('2026-10-26', { pass: 100 })] }), { today: '2026-11-02' });
    expect(codes(done)).not.toContain('project_overdue');
  });
});

describe('At Risk: staffing', () => {
  it('assigned below planned is only informational while the schedule is healthy', () => {
    const r = run(project({ currentTesters: 8 }), { assignments: assign(6) });
    expect(r.state).toBe('ready');
    expect(r.reasons.find((x) => x.code === 'staffing_gap')).toMatchObject({ severity: 'info', category: 'staffing', metadata: { planned: 8, assigned: 6, gap: 2 } });
    expect(r.metrics.staffingGap).toBe(2);
  });

  it('the same gap is a warning once it is part of a schedule / capacity problem', () => {
    const r = run(project({ currentTesters: 8, totalCases: 3000 }), { assignments: assign(6) });
    expect(r.state).toBe('atRisk');
    expect(r.reasons.find((x) => x.code === 'staffing_gap')?.severity).toBe('warning');
  });

  it("one day's lower attendance is informational", () => {
    const r = run(project({ dailyExecuted: [entry('2026-10-26'), entry(TODAY, { testers: 2, pass: 60 })] }));
    expect(r.reasons.find((x) => x.code === 'actual_below_planned')).toMatchObject({ severity: 'info', metadata: { planned: 4, actual: 2 } });
    expect(r.state).toBe('ready');
  });
});

describe('data quality never becomes release risk on its own', () => {
  const scope = (total: number): TestScope => ({ id: 'scp_a', projectId: 'PRJ-001', name: 'A', status: 'active', order: 1, createdAt: NOW, updatedAt: NOW, totalTestCases: total });
  const cases = (n: number): TestCase[] => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, projectId: 'PRJ-001', scopeId: 'scp_a', key: `A-${i}`, title: 'c', priority: 'medium' as const, status: 'active' as const, order: i, createdAt: NOW, updatedAt: NOW }));
  const ev = (id: string, status: 'pass' | 'fail'): CaseExecutionEvent => ({ id: `e${id}`, projectId: 'PRJ-001', scopeId: 'scp_a', testCaseId: id, status, executedAt: '2026-10-27T01:00:00.000Z', source: 'manual' });

  it('partial detailed coverage with a healthy aggregate stays Ready (informational coverage note only)', () => {
    const r = run(project(), { scopes: [scope(10)], cases: cases(5), caseExecution: [ev('c0', 'pass')] });
    expect(r.state).toBe('ready');
    expect(r.reasons.find((x) => x.code === 'detailed_coverage_partial')).toMatchObject({ severity: 'info', category: 'coverage' });
  });

  it('an aggregate-vs-detail difference is informational and never Blocked', () => {
    const p = project({ dailyExecuted: [entry('2026-10-26'), entry(TODAY, { pass: 10 })] });
    const r = run(p, { scopes: [scope(3)], cases: cases(3), caseExecution: [ev('c0', 'pass'), ev('c1', 'pass')] });
    expect(r.reasons.find((x) => x.code === 'reconciliation_difference')).toMatchObject({ severity: 'info', category: 'dataQuality' });
    expect(r.state).toBe('ready');
  });
});

describe('isolation, determinism, purity', () => {
  it("Project A's critical defect, events and assignments never touch Project B", () => {
    const a = project({ bugTickets: [ticket({ severity: 'Critical', status: 'Open' })] }, 'ongoing', 'PRJ-001');
    const b = project({}, 'ongoing', 'PRJ-002');
    const shared = { tickets: [ticket({ severity: 'Critical', status: 'Open' })], assignments: assign(4, 'PRJ-001'), caseExecution: [{ id: 'x', projectId: 'PRJ-001', scopeId: 's', testCaseId: 'c', status: 'fail' as const, executedAt: NOW_ISO, source: 'manual' as const }] };
    expect(run(a, { tickets: shared.tickets }).state).toBe('blocked');
    const rb = run(b, shared);
    expect(rb.state).toBe('ready'); // A's blocker and assignments are invisible to B (B only shows its own informational staffing gap)
    expect(codes(rb)).not.toContain('critical_defect_open');
    expect(rb.metrics.assigned).toBe(0);
  });

  it('same inputs and date give the identical result; the selector reads no clock and mutates nothing', () => {
    const p = project({ bugTickets: [ticket({ severity: 'Critical', status: 'Open' })], dailyExecuted: [entry('2026-10-26', { fail: 2 })] });
    const frozen = JSON.stringify(p);
    const deepFreeze = <T,>(o: T): T => {
      if (typeof o === 'object' && o !== null) {
        Object.freeze(o);
        for (const v of Object.values(o)) deepFreeze(v);
      }
      return o;
    };
    deepFreeze(p);
    const first = run(p);
    expect(run(p)).toEqual(first);
    expect(JSON.stringify(p)).toBe(frozen);
    expect(src('domain/readiness.ts')).not.toMatch(/Date\.now|new Date\(\)|Math\.random/);
  });

  it('every reason is explained once: codes are unique and the order is stable', () => {
    const r = run(project({ totalCases: 3000, dailyExecuted: [entry('2026-10-26', { pass: 55, fail: 5, blocked: 1 })], bugTickets: [ticket({ severity: 'Critical' })] }), { assignments: assign(2) });
    expect(new Set(codes(r)).size).toBe(codes(r).length);
    const order = READINESS_CODES;
    const idx = codes(r).map((c) => order.indexOf(c as never));
    expect(idx).toEqual([...idx].sort((x, y) => x - y));
  });
});

describe('lifecycle', () => {
  it('paused and finished projects are not asked for readiness; a project not started is not "Ready"', () => {
    expect(readinessBadgeKey(run(project({}, 'onHold')))).toBe('onHold');
    expect(readinessBadgeKey(run(project({}, 'done')))).toBe('completed');
    const todo = run(project({ dailyExecuted: [], casesCompleted: 0 }, 'todo'));
    expect(todo.applicability).toBe('notStarted');
    expect(readinessBadgeKey(todo)).toBe('notStarted');
    expect(codes(todo)).toContain('not_started');
    expect(codes(todo)).not.toContain('no_execution_data');
  });

  it('a project not started with a real problem still shows it', () => {
    const todo = run(project({ dailyExecuted: [], casesCompleted: 0, bugTickets: [ticket({ severity: 'Critical', status: 'Open' })] }, 'todo'));
    expect(readinessBadgeKey(todo)).toBe('blocked');
  });
});

describe('visibility', () => {
  it('readiness is management-only: hidden from a Tester on the Dashboard, Overall and Gantt', () => {
    expect(canViewReadiness({ isTester: true })).toBe(false);
    expect(canViewReadiness({ isTester: false })).toBe(true);
    expect(src('features/dashboard/Dashboard.tsx')).toContain('canViewReadiness(access) && readiness !== undefined');
    expect(src('features/overall/Overall.tsx')).toContain('canViewReadiness({ isTester: readOnly })');
    expect(src('features/gantt/Gantt.tsx')).toMatch(/readOnly \|\| readiness\.get/);
  });

  it('the selector makes no network call', () => {
    expect(src('domain/readiness.ts')).not.toMatch(/fetch\(|createTestRailClient|XMLHttpRequest/);
  });
});

describe('UI', () => {
  const states = {
    ready: run(project()),
    atRisk: run(project({ dailyExecuted: [entry('2026-10-26', { pass: 55, fail: 5 })] })),
    blocked: run(project({ bugTickets: [ticket({ severity: 'Critical', status: 'Open', ticketKey: 'ABC-1' })], dailyExecuted: [entry('2026-10-26', { pass: 55, fail: 5 })] })),
  };

  for (const lang of ['en', 'ja'] as const) {
    it(`[${lang}] the card shows the state as icon + word, the reasons in order, and folds informational notes away`, () => {
      const ready = renderToStaticMarkup(createElement(ReadinessCard, { lang, readiness: states.ready }));
      expect(ready).toContain(dict(lang)['readiness.state.ready']);
      expect(ready).toContain(dict(lang)['readiness.noReasons']);
      expect(ready).toContain('<details');
      const risk = renderToStaticMarkup(createElement(ReadinessCard, { lang, readiness: states.atRisk }));
      expect(risk).toContain(dict(lang)['readiness.state.atRisk']);
      expect(risk).toContain('⚠');
      const blocked = renderToStaticMarkup(createElement(ReadinessCard, { lang, readiness: states.blocked }));
      expect(blocked).toContain(dict(lang)['readiness.state.blocked']);
      expect(blocked).toContain('ABC-1');
      expect(blocked.indexOf('ABC-1')).toBeLessThan(blocked.indexOf(dict(lang)['readiness.category.execution']));
      expect(blocked.match(/readiness-reason-blocking/g)?.length).toBe(1);
    });
  }

  it('the Overall table shows a Readiness column with the badge, and none without readiness (Tester)', () => {
    const p = project();
    const base = { lang: 'en' as const, readOnly: false, visible: [p], planningStatuses: new Map(), selected: new Set<string>(), sortKey: 'name' as never, sortDirection: 'asc' as const, reopenFor: null, onToggleSelected: () => undefined, onToggleSort: () => undefined, onSelectAll: () => undefined, onStatusChange: () => undefined, onReopenFor: () => undefined, onOpenGantt: () => undefined, onExportProject: () => undefined, onDeleteProject: () => undefined };
    const withCol = renderToStaticMarkup(createElement(OverallProjectTable, { ...base, readiness: new Map([[p.id, states.atRisk]]) }));
    expect(withCol).toContain('>Readiness<');
    expect(withCol).toContain(dict('en')['readiness.state.atRisk']);
    expect(renderToStaticMarkup(createElement(OverallProjectTable, base))).not.toContain('>Readiness<');
  });

  it('the badge carries the reasons as its tooltip', () => {
    expect(renderToStaticMarkup(createElement(ReadinessBadge, { lang: 'en', readiness: states.blocked }))).toContain('ABC-1');
  });

  it('every reason code and label has an EN and a JA string', () => {
    for (const code of READINESS_CODES) {
      expect(dict('en')[`readiness.reason.${code}`], code).toBeTruthy();
      expect(dict('ja')[`readiness.reason.${code}`], code).toBeTruthy();
    }
    for (const k of Object.keys(dict('en')).filter((x) => x.startsWith('readiness.'))) expect(dict('ja')[k], k).toBeTruthy();
  });
});

describe('export', () => {
  it('the project export adds Readiness State, Blocking and Warning reasons and the machine-readable codes; existing columns stay', () => {
    const p = project({ bugTickets: [ticket({ severity: 'Critical', status: 'Open', ticketKey: 'ABC-1' })], dailyExecuted: [entry('2026-10-26', { pass: 55, fail: 5 })] });
    const plain = projectsSheet('en', [p]);
    const rich = projectsSheet('en', [p], new Map([[p.id, run(p)]]));
    expect(rich.headers.slice(0, plain.headers.length)).toEqual(plain.headers);
    expect(rich.headers.slice(-4)).toEqual(['Readiness State', 'Blocking Reasons', 'Warning Reasons', 'Readiness Reason Codes']);
    const cells = rich.rows[0]!.slice(-4);
    expect(cells[0]).toBe('Blocked');
    expect(String(cells[1])).toContain('ABC-1');
    expect(String(cells[2])).toContain('failed');
    expect(String(cells[3])).toContain('critical_defect_open;');
  });
});

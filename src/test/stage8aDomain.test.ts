import { describe, expect, it } from 'vitest';
import type { Cycle, DailyExecutionEntry, ProjectRecord, QaInputs, ReportsState, TesterProjectAssignment } from '../types';
import { newProjectRecord, setProjectLifecycleStatus } from '../domain/projects/lifecycle';
import { CYCLE_TRANSITIONS, canMoveCycle, createCycle, editCycle, projectsOfCycle, projectsWithMissingCycle, projectsWithoutCycle, setCycleStatus, sortCycles, withProjectCycle } from '../domain/cycles';
import {
  RISK_THRESHOLDS,
  assignedPeople,
  cycleRiskSignals,
  cycleSummary,
  highestSeverity,
  isAssignmentCurrent,
  metricsFromCounts,
  needsAttention,
  portfolioMetrics,
  projectMetrics,
  projectRiskSignals,
  recentActivity,
  sumMetrics,
  testerWorkload,
  todayMetrics,
  unassignedProjects,
} from '../domain/qaMetrics';
import { normalizeQaInputs } from '../lib/storage/storage';
import { defaultReportsState, isReportsState, normalizeReportsState } from '../lib/storage/reports';
import { applyRecordChanges, hasMeaningfulLocalData, reportsToRecords } from '../lib/sync/records';
import { assembleReportsState, splitWorkspace } from '../lib/storage/db/workspace';
import { emptySharedState } from '../lib/sync/starter';

const NOW = '2026-10-07T09:00:00.000Z';
const TODAY = '2026-10-07';
const CTX = { today: TODAY, nowIso: NOW, assignments: [] as TesterProjectAssignment[] };

const entry = (over: Partial<DailyExecutionEntry> = {}): DailyExecutionEntry => ({
  id: crypto.randomUUID(),
  date: '2026-10-06',
  startTime: null,
  endTime: null,
  overtimeMinutes: 0,
  intervalEnabled: true,
  testers: 2,
  pass: 0,
  fail: 0,
  notApplicable: 0,
  spo: 0,
  blocked: 0,
  retest: 0,
  questioned: 0,
  note: '',
  ...over,
});

/** One planning row per day from `start` to `end` (weekends off), so a project has a believable plan to measure against. */
function planFor(start: string, end: string): QaInputs['planningRows'] {
  const rows: QaInputs['planningRows'] = [];
  for (let t = Date.parse(start); t <= Date.parse(end); t += 86_400_000) {
    const d = new Date(t);
    const day = d.getUTCDay();
    rows.push({ id: `row-${rows.length}`, date: d.toISOString().slice(0, 10), plannedTesters: 4, absentTesters: 0, nonWorkingDay: day === 0 || day === 6, note: '' });
  }
  return rows;
}

function inputs(over: Partial<QaInputs> = {}): QaInputs {
  return normalizeQaInputs({
    totalCases: 100,
    currentTesters: 2,
    startTime: 9 * 60,
    targetFinish: 18 * 60,
    lunchStart: 12 * 60,
    lunchEnd: 13 * 60,
    perHourPerTester: 6,
    casesCompleted: 0,
    startDate: '2026-10-01',
    targetCompletionDate: '2026-10-30',
    targetCompletionTime: '17:30',
    planningRows: planFor(over.startDate ?? '2026-10-01', over.targetCompletionDate ?? '2026-10-30'),
    ...over,
  });
}

let seq = 0;
function project(over: Partial<QaInputs> = {}, status: ProjectRecord['status'] = 'ongoing', extra: Partial<ProjectRecord> = {}): ProjectRecord {
  seq += 1;
  const p = newProjectRecord(inputs(over), { nameEn: `Project ${seq}`, status }, NOW, []);
  return { ...p, projectId: `PRJ-${String(seq).padStart(3, '0')}`, ...extra };
}

const withEntries = (entries: DailyExecutionEntry[], over: Partial<QaInputs> = {}, status: ProjectRecord['status'] = 'ongoing', extra: Partial<ProjectRecord> = {}) =>
  project({ dailyExecuted: entries, ...over }, status, extra);

describe('cycles', () => {
  it('creates a planned cycle with trimmed text and optional release label', () => {
    const r = createCycle({ name: '  Android   4.2.0  Release ', version: ' 4.2.0 ', description: ' RC validation ', plannedStart: '2026-10-01', plannedEnd: '2026-10-31' }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ name: 'Android 4.2.0 Release', version: '4.2.0', description: 'RC validation', status: 'planned', completedAt: null, createdAt: NOW, updatedAt: NOW });
    expect(r.value.id).toMatch(/^cyc_/);
  });

  it('refuses an empty name and impossible or reversed dates', () => {
    expect(createCycle({ name: '   ' }, NOW)).toEqual({ ok: false, error: 'cycle_invalid_name' });
    expect(createCycle({ name: 'X', plannedStart: '2026-02-30' }, NOW)).toEqual({ ok: false, error: 'cycle_invalid_date' });
    expect(createCycle({ name: 'X', plannedStart: '2026-11-01', plannedEnd: '2026-10-01' }, NOW)).toEqual({ ok: false, error: 'cycle_end_before_start' });
    expect(createCycle({ name: 'x'.repeat(121) }, NOW)).toEqual({ ok: false, error: 'cycle_invalid_name' });
    expect(createCycle({ name: 'No dates at all' }, NOW).ok).toBe(true);
  });

  it('edits the descriptive fields and can clear the optional ones', () => {
    const c = createCycle({ name: 'A', version: '1.0', description: 'd', plannedStart: '2026-10-01', plannedEnd: '2026-10-10' }, NOW);
    if (!c.ok) throw new Error('setup');
    const e = editCycle(c.value, { name: 'B', plannedStart: null, plannedEnd: null }, '2026-10-08T00:00:00.000Z');
    expect(e.ok && e.value).toMatchObject({ name: 'B', plannedStart: null, plannedEnd: null, updatedAt: '2026-10-08T00:00:00.000Z' });
    expect(e.ok && 'version' in e.value).toBe(false);
    expect(e.ok && 'description' in e.value).toBe(false);
    expect(editCycle(c.value, { name: '' }, NOW)).toEqual({ ok: false, error: 'cycle_invalid_name' });
  });

  it('follows the small status table: planned -> active -> completed -> archived, reopening allowed, nothing else', () => {
    const states = Object.keys(CYCLE_TRANSITIONS) as Cycle['status'][];
    expect(canMoveCycle('planned', 'active')).toBe(true);
    expect(canMoveCycle('active', 'completed')).toBe(true);
    expect(canMoveCycle('completed', 'archived')).toBe(true);
    expect(canMoveCycle('completed', 'active')).toBe(true);
    expect(canMoveCycle('planned', 'completed')).toBe(false); // must be Active first
    expect(canMoveCycle('archived', 'completed')).toBe(false);
    for (const s of states) expect(canMoveCycle(s, s)).toBe(false);
    const c = createCycle({ name: 'A' }, NOW);
    if (!c.ok) throw new Error('setup');
    expect(setCycleStatus(c.value, 'completed', NOW)).toEqual({ ok: false, error: 'cycle_transition_not_allowed' });
    const active = setCycleStatus(c.value, 'active', NOW);
    if (!active.ok) throw new Error('active');
    const done = setCycleStatus(active.value, 'completed', '2026-10-20T00:00:00.000Z');
    expect(done.ok && done.value).toMatchObject({ status: 'completed', completedAt: '2026-10-20T00:00:00.000Z' });
    if (!done.ok) throw new Error('done');
    const archived = setCycleStatus(done.value, 'archived', '2026-10-21T00:00:00.000Z');
    expect(archived.ok && archived.value.completedAt).toBe('2026-10-20T00:00:00.000Z'); // the completion date is kept
    const reopened = setCycleStatus(done.value, 'active', NOW);
    expect(reopened.ok && reopened.value.completedAt).toBeNull();
    expect(setCycleStatus(c.value, 'nonsense' as never, NOW)).toEqual({ ok: false, error: 'cycle_invalid_status' });
    expect(setCycleStatus(c.value, 'planned', NOW)).toEqual({ ok: true, value: c.value }); // no-op
  });

  const cycles = (): Cycle[] => {
    const a = createCycle({ name: 'A' }, NOW);
    const b = createCycle({ name: 'B' }, NOW);
    if (!a.ok || !b.ok) throw new Error('setup');
    const archived = setCycleStatus(b.value, 'archived', NOW);
    return [a.value, archived.ok ? archived.value : b.value];
  };

  it('puts a project into a cycle, moves it, and takes it out; a project in no cycle is valid', () => {
    const [a] = cycles();
    const c2 = createCycle({ name: 'C' }, NOW);
    if (!c2.ok) throw new Error('setup');
    const p = project();
    expect(p.cycleId).toBeUndefined();
    const into = withProjectCycle(p, a.id, [a, c2.value], NOW);
    expect(into.ok && into.value.cycleId).toBe(a.id);
    if (!into.ok) throw new Error('into');
    const moved = withProjectCycle(into.value, c2.value.id, [a, c2.value], NOW);
    expect(moved.ok && moved.value.cycleId).toBe(c2.value.id);
    const out = withProjectCycle(moved.ok ? moved.value : into.value, null, [a, c2.value], NOW);
    expect(out.ok && out.value.cycleId).toBeNull();
    expect(withProjectCycle(p, null, [a], NOW)).toEqual({ ok: true, value: p }); // nothing to do
  });

  it('refuses an unknown or archived cycle, and never lists a project twice', () => {
    const [a, archived] = cycles();
    const p = project();
    expect(withProjectCycle(p, 'cyc_unknown', [a], NOW)).toEqual({ ok: false, error: 'cycle_not_found' });
    expect(withProjectCycle(p, archived.id, [a, archived], NOW)).toEqual({ ok: false, error: 'cycle_archived' });
    // a project already inside the archived cycle may stay there
    const inside = { ...p, cycleId: archived.id };
    expect(withProjectCycle(inside, archived.id, [a, archived], NOW)).toEqual({ ok: true, value: inside });
    const list = [{ ...p, cycleId: a.id }, project(), { ...project(), cycleId: 'cyc_gone' }];
    expect(projectsOfCycle(list, a.id)).toHaveLength(1);
    expect(projectsWithoutCycle(list)).toHaveLength(1);
    expect(projectsWithMissingCycle(list, [a, archived]).map((x) => x.cycleId)).toEqual(['cyc_gone']);
  });

  it('sorts active first, then planned, completed, archived', () => {
    const mk = (name: string, status: Cycle['status']): Cycle => ({ ...(createCycle({ name }, NOW) as { ok: true; value: Cycle }).value, status });
    expect(sortCycles([mk('d', 'archived'), mk('c', 'completed'), mk('b', 'planned'), mk('a', 'active')]).map((c) => c.status)).toEqual(['active', 'planned', 'completed', 'archived']);
  });
});

describe('persistence: old data keeps loading, new data round-trips', () => {
  const legacy = (): ReportsState => {
    const state = { ...defaultReportsState(), projects: [project()] };
    delete (state as { cycles?: unknown }).cycles;
    return state;
  };

  it('a workspace saved before cycles existed is valid and normalizes to no cycles', () => {
    const old = legacy();
    expect(isReportsState(old)).toBe(true);
    expect(normalizeReportsState(old).cycles).toEqual([]);
    expect(old.projects[0].cycleId).toBeUndefined();
  });

  it('a project record without cycleId, with null, or with an id is valid; garbage is not', () => {
    const base = { ...defaultReportsState() };
    for (const cycleId of [undefined, null, 'cyc_x']) expect(isReportsState({ ...base, projects: [{ ...project(), cycleId }] })).toBe(true);
    expect(isReportsState({ ...base, projects: [{ ...project(), cycleId: 5 }] })).toBe(false);
  });

  it('malformed cycles are filtered on load, valid ones pass through unchanged', () => {
    const ok = createCycle({ name: 'A' }, NOW);
    if (!ok.ok) throw new Error('setup');
    const state = { ...defaultReportsState(), cycles: [ok.value, { id: 'x', name: '' } as unknown as Cycle] };
    expect(normalizeReportsState(state).cycles).toEqual([ok.value]);
    expect(isReportsState(state)).toBe(false);
  });

  it('cycles and project membership survive the shared-record round trip and the local database split', () => {
    const c = createCycle({ name: 'Round trip', version: '1.0' }, NOW);
    if (!c.ok) throw new Error('setup');
    const state: ReportsState = { ...defaultReportsState(), cycles: [c.value], projects: [{ ...project(), cycleId: c.value.id }] };
    const records = [...reportsToRecords(state).values()];
    expect(records.filter((r) => r.kind === 'cycle')).toHaveLength(1);
    const back = applyRecordChanges({ ...emptySharedState(defaultReportsState()) }, records, []);
    expect(back.cycles).toEqual([c.value]);
    expect(back.projects[0].cycleId).toBe(c.value.id);

    const { parts } = splitWorkspace({}, state);
    expect(parts.collections.cycles).toEqual([c.value]);
    expect(assembleReportsState(parts).cycles).toEqual([c.value]);
  });

  it('a cycle counts as data worth protecting when linking a device', () => {
    const c = createCycle({ name: 'A' }, NOW);
    if (!c.ok) throw new Error('setup');
    expect(hasMeaningfulLocalData({ ...defaultReportsState(), cycles: [c.value] })).toBe(true);
  });
});

describe('execution metrics', () => {
  it('computes planned, executed, completed, remaining, completion and pass rate from the daily entries', () => {
    const p = withEntries([entry({ date: '2026-10-05', pass: 30, fail: 10, blocked: 5, notApplicable: 4, spo: 1 }), entry({ date: '2026-10-06', pass: 20, fail: 0, blocked: 2 })]);
    const m = projectMetrics(p);
    expect(m).toMatchObject({ planned: 100, passed: 50, failed: 10, blocked: 7, notApplicable: 4, spo: 1, executed: 60, completed: 65, remaining: 35 });
    expect(m.completion).toBeCloseTo(0.65);
    expect(m.passRate).toBeCloseTo(50 / 60); // Passed / Executed — never Passed / Planned
    expect(m.warnings).toEqual([]);
  });

  it('Blocked is an open tally: it is neither executed nor completed, so those cases stay in Remaining', () => {
    const m = projectMetrics(withEntries([entry({ pass: 10, blocked: 40 })]));
    expect(m).toMatchObject({ executed: 10, completed: 10, remaining: 90, blocked: 40 });
  });

  it('is zero-safe: nothing executed gives no pass rate, nothing planned gives no completion', () => {
    expect(projectMetrics(withEntries([])).passRate).toBeNull();
    expect(projectMetrics(withEntries([entry({ pass: 0, fail: 0, blocked: 3 })])).passRate).toBeNull();
    const none = projectMetrics(project({ totalCases: 0 }));
    expect(none).toMatchObject({ planned: 0, remaining: 0, completion: null, passRate: null });
    expect(Number.isNaN(none.completion as number)).toBe(false);
  });

  it('an all-pass and an all-fail project give 100% and 0%', () => {
    expect(projectMetrics(withEntries([entry({ pass: 10 })])).passRate).toBe(1);
    expect(projectMetrics(withEntries([entry({ fail: 10 })])).passRate).toBe(0);
  });

  it('does not hide inconsistent data: completed above planned, and a breakdown larger than completed, are reported', () => {
    const over = projectMetrics(withEntries([entry({ pass: 80, fail: 40 })], { totalCases: 100 }));
    expect(over.warnings).toContain('completed_exceeds_planned');
    expect(over.remaining).toBe(0); // clamped, never negative
    expect(over.completion).toBe(1);
    expect(metricsFromCounts({ planned: 100, passed: 50, failed: 40, blocked: 0, notApplicable: 0, spo: 0, completed: 60 }).warnings).toContain('breakdown_exceeds_completed');
  });

  it('lowering the planned total after results exist keeps the history and warns', () => {
    const p = withEntries([entry({ pass: 60, fail: 20 })], { totalCases: 100 });
    const lowered = { ...p, inputs: { ...p.inputs, totalCases: 50 } };
    const m = projectMetrics(lowered);
    expect(m).toMatchObject({ planned: 50, passed: 60, failed: 20, completed: 80, remaining: 0 });
    expect(m.warnings).toContain('completed_exceeds_planned');
    expect(lowered.inputs.dailyExecuted).toEqual(p.inputs.dailyExecuted); // history untouched
  });

  it('falls back to the stored totals for a project without daily entries (older data)', () => {
    const m = projectMetrics(project({ totalCases: 200, casesCompleted: 120, casesPassed: 90, casesFailed: 20, casesBlocked: 3 }));
    expect(m).toMatchObject({ planned: 200, passed: 90, failed: 20, blocked: 3, completed: 120, remaining: 80, executed: 110 });
  });

  it('adds projects together with ratios computed from the sums, not averaged', () => {
    const a = projectMetrics(withEntries([entry({ pass: 9, fail: 1 })], { totalCases: 10 })); // 90% pass
    const b = projectMetrics(withEntries([entry({ pass: 0, fail: 90 })], { totalCases: 90 })); // 0% pass
    const sum = sumMetrics([a, b]);
    expect(sum).toMatchObject({ planned: 100, passed: 9, failed: 91, executed: 100, completed: 100, remaining: 0 });
    expect(sum.passRate).toBeCloseTo(0.09);
    expect(sumMetrics([])).toMatchObject({ planned: 0, executed: 0, passRate: null, completion: null });
  });

  it("reports one day's results and ignores projects without an entry that day", () => {
    const ps = [withEntries([entry({ date: TODAY, pass: 5, fail: 2, blocked: 1, testers: 3 })]), withEntries([entry({ date: '2026-10-06', pass: 99 })]), withEntries([entry({ date: TODAY, pass: 4, fail: 0, blocked: 0, testers: 2, notApplicable: 1 })])];
    expect(todayMetrics(ps, TODAY)).toEqual({ projectsWithEntry: 2, passed: 9, failed: 2, blocked: 1, executed: 11, completed: 12, testersMax: 3 });
    expect(todayMetrics([], TODAY)).toEqual({ projectsWithEntry: 0, passed: 0, failed: 0, blocked: 0, executed: 0, completed: 0, testersMax: 0 });
  });

  it('daily activity is aggregated per day across projects, newest first, within the window', () => {
    const ps = [withEntries([entry({ date: '2026-10-06', pass: 5, fail: 1 }), entry({ date: '2026-09-29', pass: 50 })]), withEntries([entry({ date: '2026-10-06', pass: 3, blocked: 2 })])];
    expect(recentActivity(ps, TODAY, 7)).toEqual([{ date: '2026-10-06', passed: 8, failed: 1, blocked: 2, executed: 9 }]);
    expect(recentActivity(ps, TODAY, 30).map((r) => r.date)).toEqual(['2026-10-06', '2026-09-29']);
  });
});

describe('risk signals (deterministic, thresholds in one place)', () => {
  const codes = (p: ProjectRecord, ctx = CTX) => projectRiskSignals(p, ctx).map((s) => s.code);

  it('publishes its thresholds', () => {
    expect(RISK_THRESHOLDS).toEqual({ dueSoonDays: 2, dueSoonRemainingShare: 0.2, idleDays: 3, blockedAttentionAbove: 0, failedWarningAbove: 0 });
  });

  it('done and on-hold projects carry no signals', () => {
    expect(codes(project({ targetCompletionDate: '2026-09-01' }, 'done'))).toEqual([]);
    expect(codes(project({ targetCompletionDate: '2026-09-01' }, 'onHold'))).toEqual([]);
  });

  it('overdue is attention', () => {
    const s = projectRiskSignals(project({ targetCompletionDate: '2026-10-01' }), CTX);
    expect(s[0]).toEqual({ code: 'overdue', severity: 'attention' });
    expect(needsAttention(s)).toBe(true);
  });

  it('blocked cases are attention, failed cases a warning', () => {
    const blocked = projectRiskSignals(withEntries([entry({ pass: 5, blocked: 1 })]), CTX);
    expect(blocked.find((s) => s.code === 'blocked_cases')).toEqual({ code: 'blocked_cases', severity: 'attention', value: 1 });
    const failed = projectRiskSignals(withEntries([entry({ pass: 5, fail: 2 })]), CTX);
    expect(failed.find((s) => s.code === 'failed_cases')).toEqual({ code: 'failed_cases', severity: 'warning', value: 2 });
    expect(needsAttention(failed.filter((s) => s.code === 'failed_cases'))).toBe(false);
  });

  it('a deadline within two days with more than 20% still open is attention; exactly 20% is not; a distant deadline is not', () => {
    const near = (done: number, deadline: string) => withEntries([entry({ date: TODAY, pass: done })], { targetCompletionDate: deadline, startDate: '2026-10-05' });
    expect(codes(near(79, '2026-10-09'))).toContain('due_soon_much_remaining'); // 21% left
    expect(codes(near(80, '2026-10-09'))).not.toContain('due_soon_much_remaining'); // exactly 20%
    expect(codes(near(10, '2026-10-20'))).not.toContain('due_soon_much_remaining');
    expect(codes(near(10, '2026-10-10'))).not.toContain('due_soon_much_remaining'); // 3 days away
  });

  it('an ongoing project with no recorded results for three days is a warning; a project that only just started is not', () => {
    expect(codes(withEntries([entry({ date: '2026-10-03', pass: 5 })], { startDate: '2026-10-01' }))).toContain('no_recent_activity');
    expect(codes(withEntries([entry({ date: '2026-10-05', pass: 5 })], { startDate: '2026-10-01' }))).not.toContain('no_recent_activity'); // 2 days
    expect(codes(withEntries([], { startDate: TODAY }))).not.toContain('no_recent_activity');
    expect(codes(withEntries([], { startDate: '2026-10-01' }))).toContain('no_recent_activity');
  });

  it('an ongoing project with nobody assigned is a hint, not attention; being assigned clears it', () => {
    const p = withEntries([entry({ date: '2026-10-06', pass: 5 })]);
    const s = projectRiskSignals(p, CTX);
    expect(s.find((x) => x.code === 'no_tester')).toEqual({ code: 'no_tester', severity: 'info' });
    expect(needsAttention(s.filter((x) => x.code === 'no_tester'))).toBe(false);
    const assigned: TesterProjectAssignment = { id: 'a', projectId: p.projectId, userId: 'usr_1', testerName: 'Hana', startDate: '2026-10-01', active: true };
    expect(codes(p, { ...CTX, assignments: [assigned] })).not.toContain('no_tester');
    expect(codes(p, { ...CTX, assignments: [{ ...assigned, active: false }] })).toContain('no_tester');
    expect(codes(p, { ...CTX, assignments: [{ ...assigned, endDate: '2026-10-05' }] })).toContain('no_tester');
  });

  it('sorts the most serious signal first and reports the highest severity', () => {
    const s = projectRiskSignals(withEntries([entry({ pass: 5, fail: 1, blocked: 2 })], { targetCompletionDate: '2026-10-01' }), CTX);
    expect(s[0].severity).toBe('attention');
    expect(highestSeverity(s)).toBe('attention');
    expect(highestSeverity([])).toBeNull();
    expect(highestSeverity([{ severity: 'info' }, { severity: 'warning' }])).toBe('warning');
  });

  it('a cycle is at risk when its end has passed, or is near with much left, or contains projects that need attention', () => {
    const c = (over: Partial<Cycle>): Cycle => ({ ...(createCycle({ name: 'C' }, NOW) as { ok: true; value: Cycle }).value, status: 'active', ...over });
    const cyc = c({ plannedEnd: '2026-10-05' });
    expect(cycleRiskSignals(cyc, [], CTX).map((s) => s.code)).toEqual(['cycle_overdue']);
    const soon = c({ plannedEnd: '2026-10-09' });
    const mine = [withEntries([entry({ date: TODAY, pass: 10 })], {}, 'ongoing', { cycleId: soon.id })];
    expect(cycleRiskSignals(soon, mine, CTX).map((s) => s.code)).toContain('cycle_due_soon_much_remaining');
    expect(cycleRiskSignals(c({ plannedEnd: '2026-12-31' }), [], CTX)).toEqual([]);
    expect(cycleRiskSignals(c({ plannedEnd: '2026-10-01', status: 'completed' }), [], CTX)).toEqual([]); // finished cycles are not chased
    const withBlocked = c({ plannedEnd: '2026-12-31' });
    const risky = [withEntries([entry({ pass: 1, blocked: 3 })], {}, 'ongoing', { cycleId: withBlocked.id })];
    expect(cycleRiskSignals(withBlocked, risky, CTX)).toEqual([{ code: 'projects_need_attention', severity: 'warning', value: 1 }]);
  });
});

describe('cycle and portfolio summaries are tenant-scoped by construction (they only see what they are given)', () => {
  const cyc = (name: string): Cycle => (createCycle({ name }, NOW) as { ok: true; value: Cycle }).value;

  it('a cycle summary includes only its own projects, totals and at-risk list', () => {
    const a = cyc('A');
    const b = cyc('B');
    const inA1 = withEntries([entry({ pass: 20, fail: 5, blocked: 2 })], { totalCases: 50 }, 'ongoing', { cycleId: a.id });
    const inA2 = withEntries([entry({ pass: 10 })], { totalCases: 50 }, 'ongoing', { cycleId: a.id });
    const inB = withEntries([entry({ pass: 99 })], { totalCases: 100 }, 'ongoing', { cycleId: b.id });
    const loose = withEntries([entry({ pass: 77 })], { totalCases: 100 });
    const s = cycleSummary(a, [inA1, inA2, inB, loose], CTX);
    expect(s.projects.map((p) => p.id)).toEqual([inA1.id, inA2.id]);
    expect(s.metrics).toMatchObject({ planned: 100, passed: 30, failed: 5, blocked: 2, completed: 35, remaining: 65 });
    expect(s.atRiskProjects.map((p) => p.id)).toEqual([inA1.id]); // the one with blocked cases
  });

  it('the portfolio counts active cycles and projects, attention, overdue and totals; it can be limited to one cycle', () => {
    const a = { ...cyc('A'), status: 'active' as const };
    const b = { ...cyc('B'), status: 'planned' as const };
    const ps = [
      withEntries([entry({ date: TODAY, pass: 10, fail: 2 })], { totalCases: 100 }, 'ongoing', { cycleId: a.id }),
      withEntries([entry({ pass: 5, blocked: 1 })], { totalCases: 50, targetCompletionDate: '2026-10-01' }, 'ongoing', { cycleId: b.id }),
      withEntries([entry({ pass: 30 })], { totalCases: 30 }, 'done'),
    ];
    const all = portfolioMetrics(ps, [a, b], CTX);
    expect(all).toMatchObject({ activeCycles: 1, activeProjects: 2, completedProjects: 1, overdue: 1 });
    expect(all.needsAttention).toBe(1);
    expect(all.metrics).toMatchObject({ planned: 150, passed: 15, failed: 2, blocked: 1 });
    expect(all.today).toMatchObject({ passed: 10, failed: 2, executed: 12, projectsWithEntry: 1 });
    const onlyA = portfolioMetrics(ps, [a, b], CTX, a.id);
    expect(onlyA).toMatchObject({ activeProjects: 1, overdue: 0, needsAttention: 0 });
    expect(onlyA.metrics.planned).toBe(100);
  });

  it('an empty workspace gives zeros, not errors', () => {
    expect(portfolioMetrics([], [], CTX)).toMatchObject({ activeCycles: 0, activeProjects: 0, needsAttention: 0, overdue: 0, metrics: { planned: 0, passRate: null } });
  });

  it('a Done project is completed, not active, and counts nowhere in the active totals', () => {
    const p = setProjectLifecycleStatus(withEntries([entry({ pass: 10 })]), 'done', NOW);
    expect(portfolioMetrics([p], [], CTX)).toMatchObject({ activeProjects: 0, completedProjects: 1, metrics: { planned: 0 } });
  });
});

describe('assignments and workload', () => {
  const asg = (over: Partial<TesterProjectAssignment>): TesterProjectAssignment => ({ id: crypto.randomUUID(), projectId: 'PRJ-001', startDate: '2026-10-01', active: true, ...over });

  it('an assignment is current when switched on, started and not ended', () => {
    expect(isAssignmentCurrent(asg({}), TODAY)).toBe(true);
    expect(isAssignmentCurrent(asg({ active: false }), TODAY)).toBe(false);
    expect(isAssignmentCurrent(asg({ startDate: '2026-10-08' }), TODAY)).toBe(false);
    expect(isAssignmentCurrent(asg({ endDate: '2026-10-06' }), TODAY)).toBe(false);
    expect(isAssignmentCurrent(asg({ endDate: TODAY }), TODAY)).toBe(true);
  });

  it('shows the people on a project from account and roster assignments alike, preferring the roster name', () => {
    const list = [asg({ userId: 'usr_1', testerName: 'Hana S.' }), asg({ memberId: 'USER0003' }), asg({ userId: 'usr_2', testerName: 'Old', active: false }), asg({ projectId: 'PRJ-009', userId: 'usr_3' })];
    const people = assignedPeople(list, 'PRJ-001', TODAY, [{ id: 'USER0003', name: 'Yamauchi', team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true }]);
    expect(people.map((p) => p.name).sort()).toEqual(['Hana S.', 'Yamauchi']);
    expect(people.find((p) => p.userId === 'usr_1')).toBeTruthy();
  });

  it('workload lists only active projects of the Tester, counts remaining IN FULL (shared, never divided) and shows how many share it', () => {
    const p1 = withEntries([entry({ pass: 40 })], { totalCases: 100 });
    const p2 = withEntries([], { totalCases: 30 });
    const onHold = withEntries([], { totalCases: 500 }, 'onHold');
    const done = withEntries([], { totalCases: 500 }, 'done');
    const list = [
      asg({ projectId: p1.projectId, userId: 'usr_1', testerName: 'A' }),
      asg({ projectId: p1.projectId, userId: 'usr_2', testerName: 'B' }),
      asg({ projectId: p2.projectId, userId: 'usr_1', testerName: 'A' }),
      asg({ projectId: onHold.projectId, userId: 'usr_1' }),
      asg({ projectId: done.projectId, userId: 'usr_1' }),
      asg({ projectId: p2.projectId, userId: 'usr_3', active: false }),
    ];
    const [one, two, three] = testerWorkload(['usr_1', 'usr_2', 'usr_3'], [p1, p2, onHold, done], list, TODAY);
    expect(one.assignedProjects.map((w) => [w.projectId, w.remaining, w.peopleOnProject])).toEqual([[p1.projectId, 60, 2], [p2.projectId, 30, 1]]);
    expect(one.sharedRemaining).toBe(90);
    expect(two).toMatchObject({ sharedRemaining: 60 });
    expect(three).toEqual({ userId: 'usr_3', assignedProjects: [], sharedRemaining: 0 });
  });

  it('finds the active projects nobody is on', () => {
    const p1 = withEntries([]);
    const p2 = withEntries([]);
    const idle = withEntries([], {}, 'onHold');
    expect(unassignedProjects([p1, p2, idle], [asg({ projectId: p1.projectId, userId: 'usr_1' })], TODAY).map((p) => p.id)).toEqual([p2.id]);
  });
});

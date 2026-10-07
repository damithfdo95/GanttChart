import type { Cycle, ProjectRecord, RcsMember, TesterProjectAssignment } from '../../types';
import { aggregateDailyExecuted, entryForDate } from '../../lib/calculations/dailyExecuted';
import { daysUntilDeadline, isProjectOverdue, projectNeedsAttention, projectPlanningStatus } from '../projects/selectors';

/**
 * QA execution metrics, risk signals and workload (Stage 8A).
 *
 * Everything here is derived from data the application already stores (daily execution entries, planned totals,
 * schedule dates, assignments); nothing is stored twice and nothing is estimated beyond what the data says.
 *
 * Definitions (also documented in docs/QA_EXECUTION.md):
 *   Planned   = total cases of the project.
 *   Passed / Failed / Blocked / N/A / SPO = the recorded counts (Blocked is an open-status tally).
 *   Executed  = Passed + Failed          — cases that produced a verdict.
 *   Completed = Passed + Failed + N/A + SPO (+ migrated remainder) — the existing engine's notion of "done".
 *   Remaining = max(Planned − Completed, 0).   Blocked cases stay in Remaining until they are completed.
 *   Completion % = Completed / Planned.
 *   Pass rate = Passed / Executed (null with no verdict yet — never a divide by zero, never Passed / Planned).
 */

export interface ExecutionMetrics {
  planned: number;
  passed: number;
  failed: number;
  blocked: number;
  notApplicable: number;
  spo: number;
  executed: number;
  completed: number;
  remaining: number;
  /** Completed / Planned, 0..1; null when nothing is planned. */
  completion: number | null;
  /** Passed / Executed, 0..1; null when nothing has been executed. */
  passRate: number | null;
  warnings: MetricWarning[];
}

/** Things the numbers say that a person should look at. Inconsistent data is reported, never hidden or "fixed". */
export type MetricWarning = 'completed_exceeds_planned' | 'breakdown_exceeds_completed';

const int = (n: number | undefined): number => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);

export function emptyMetrics(): ExecutionMetrics {
  return { planned: 0, passed: 0, failed: 0, blocked: 0, notApplicable: 0, spo: 0, executed: 0, completed: 0, remaining: 0, completion: null, passRate: null, warnings: [] };
}

/** Build metrics from raw counts (pure; used for a project, a cycle or a whole portfolio). */
export function metricsFromCounts(c: { planned: number; passed: number; failed: number; blocked: number; notApplicable: number; spo: number; completed: number }): ExecutionMetrics {
  const executed = c.passed + c.failed;
  const warnings: MetricWarning[] = [];
  if (c.completed > c.planned) warnings.push('completed_exceeds_planned');
  if (c.passed + c.failed + c.notApplicable + c.spo > c.completed) warnings.push('breakdown_exceeds_completed');
  return {
    planned: c.planned,
    passed: c.passed,
    failed: c.failed,
    blocked: c.blocked,
    notApplicable: c.notApplicable,
    spo: c.spo,
    executed,
    completed: c.completed,
    remaining: Math.max(c.planned - c.completed, 0),
    completion: c.planned > 0 ? Math.min(1, c.completed / c.planned) : null,
    passRate: executed > 0 ? c.passed / executed : null,
    warnings,
  };
}

/** One project's metrics. The daily entries are the source of truth when there are any; otherwise the stored totals. */
export function projectMetrics(project: ProjectRecord): ExecutionMetrics {
  const inputs = project.inputs;
  const entries = inputs.dailyExecuted ?? [];
  const totals = entries.length > 0 ? aggregateDailyExecuted(entries) : null;
  return metricsFromCounts({
    planned: int(inputs.totalCases),
    passed: totals?.casesPassed ?? int(inputs.casesPassed),
    failed: totals?.casesFailed ?? int(inputs.casesFailed),
    blocked: totals?.casesBlocked ?? int(inputs.casesBlocked),
    notApplicable: totals?.casesNotApplicable ?? int(inputs.casesNotApplicable),
    spo: totals?.spoAssigned ?? int(inputs.spoAssigned),
    completed: totals?.casesCompleted ?? int(inputs.casesCompleted),
  });
}

/** Add several metric sets together (a cycle, a portfolio). Ratios are recomputed from the sums, never averaged. */
export function sumMetrics(list: readonly ExecutionMetrics[]): ExecutionMetrics {
  const sum = { planned: 0, passed: 0, failed: 0, blocked: 0, notApplicable: 0, spo: 0, completed: 0 };
  for (const m of list) {
    sum.planned += m.planned;
    sum.passed += m.passed;
    sum.failed += m.failed;
    sum.blocked += m.blocked;
    sum.notApplicable += m.notApplicable;
    sum.spo += m.spo;
    sum.completed += m.completed;
  }
  const merged = metricsFromCounts(sum);
  // A per-project problem stays visible in the total.
  for (const m of list) for (const w of m.warnings) if (!merged.warnings.includes(w)) merged.warnings.push(w);
  return merged;
}

// ---- today ------------------------------------------------------------------------------

export interface TodayMetrics {
  /** Projects with an execution entry for the day. */
  projectsWithEntry: number;
  passed: number;
  failed: number;
  blocked: number;
  executed: number;
  completed: number;
  /** Largest tester head count recorded on any one of the day's entries (not a sum: the same person can work on two). */
  testersMax: number;
}

/** What was recorded for ONE day across projects (a project without an entry that day contributes nothing). */
export function todayMetrics(projects: readonly ProjectRecord[], date: string): TodayMetrics {
  const out: TodayMetrics = { projectsWithEntry: 0, passed: 0, failed: 0, blocked: 0, executed: 0, completed: 0, testersMax: 0 };
  for (const project of projects) {
    const entry = entryForDate(project.inputs.dailyExecuted ?? [], date);
    if (entry === null) continue;
    out.projectsWithEntry += 1;
    out.passed += int(entry.pass);
    out.failed += int(entry.fail);
    out.blocked += int(entry.blocked);
    out.executed += int(entry.pass) + int(entry.fail);
    out.completed += int(entry.pass) + int(entry.fail) + int(entry.notApplicable) + int(entry.spo) + int(entry.uncategorizedCompleted);
    out.testersMax = Math.max(out.testersMax, Number.isFinite(entry.testers) ? entry.testers : 0);
  }
  return out;
}

// ---- assignments ----------------------------------------------------------------------------

/** Assigned on `date`: switched on, started, and not past its end date. */
export function isAssignmentCurrent(a: TesterProjectAssignment, date: string): boolean {
  return a.active && a.startDate <= date && (a.endDate === undefined || a.endDate >= date);
}

export interface AssignedPerson {
  assignmentId: string;
  /** A Tester ACCOUNT (registry user id), else a roster member id, else only a name. */
  userId?: string;
  memberId?: string;
  name: string;
}

/** The people on a project on a date, from account and roster assignments alike. */
export function assignedPeople(assignments: readonly TesterProjectAssignment[], projectId: string, date: string, members: readonly RcsMember[] = []): AssignedPerson[] {
  return assignments
    .filter((a) => a.projectId === projectId && isAssignmentCurrent(a, date))
    .map((a) => ({
      assignmentId: a.id,
      ...(a.userId === undefined ? {} : { userId: a.userId }),
      ...(a.memberId === undefined ? {} : { memberId: a.memberId }),
      name: (a.memberId === undefined ? undefined : members.find((m) => m.id === a.memberId)?.name) ?? a.testerName ?? a.memberId ?? a.userId ?? '',
    }));
}

// ---- risk -----------------------------------------------------------------------------------

/**
 * The thresholds behind every risk signal, in one place. Nothing is hidden in a component and nothing is learned
 * from data: change a number here and the tests show exactly what moves.
 */
export const RISK_THRESHOLDS = {
  /** A deadline this close (calendar days) with much still open is an attention signal. */
  dueSoonDays: 2,
  /** ... "much still open" = more than this share of the planned cases remaining. */
  dueSoonRemainingShare: 0.2,
  /** An ongoing project that started at least this many days ago and has recorded nothing since is flagged. */
  idleDays: 3,
  /** Cases Blocked above this count are an attention signal (any blocked case needs a decision). */
  blockedAttentionAbove: 0,
  /** Cases Failed above this count are a warning (failures are normal; they need follow-up). */
  failedWarningAbove: 0,
} as const;

export type RiskSeverity = 'attention' | 'warning' | 'info';

export type RiskCode =
  | 'overdue'
  | 'behind_plan'
  | 'schedule_attention'
  | 'due_soon_much_remaining'
  | 'blocked_cases'
  | 'failed_cases'
  | 'no_recent_activity'
  | 'no_tester'
  | 'completed_exceeds_planned';

export interface RiskSignal {
  code: RiskCode;
  severity: RiskSeverity;
  /** Numbers the message needs (counts, days). */
  value?: number;
}

const severityRank: Record<RiskSeverity, number> = { attention: 0, warning: 1, info: 2 };

export interface RiskContext {
  today: string;
  nowIso: string;
  assignments: readonly TesterProjectAssignment[];
}

/** Whole calendar days between two YYYY-MM-DD dates (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

/** Deterministic risk signals for one ACTIVE project (done and on-hold projects have none). */
export function projectRiskSignals(project: ProjectRecord, ctx: RiskContext): RiskSignal[] {
  if (project.status === 'done' || project.status === 'onHold') return [];
  const m = projectMetrics(project);
  const signals: RiskSignal[] = [];
  const planning = projectPlanningStatus(project);

  if (isProjectOverdue(project, ctx.today)) signals.push({ code: 'overdue', severity: 'attention' });
  if (planning === 'atRisk' || planning === 'capacityShortage') signals.push({ code: 'behind_plan', severity: 'attention' });

  const until = daysUntilDeadline(project, ctx.today);
  if (until !== null && until <= RISK_THRESHOLDS.dueSoonDays && m.planned > 0 && m.remaining / m.planned > RISK_THRESHOLDS.dueSoonRemainingShare) {
    signals.push({ code: 'due_soon_much_remaining', severity: 'attention', value: until });
  }
  // The existing "Needs Attention" rules (deadline within a week while ongoing, no update for two weeks) stay the
  // definition of schedule attention; the signal is added only when none of the sharper ones above already said so.
  if (signals.length === 0 && projectNeedsAttention(project, ctx.today, ctx.nowIso)) signals.push({ code: 'schedule_attention', severity: 'attention' });

  if (m.blocked > RISK_THRESHOLDS.blockedAttentionAbove) signals.push({ code: 'blocked_cases', severity: 'attention', value: m.blocked });
  if (m.failed > RISK_THRESHOLDS.failedWarningAbove) signals.push({ code: 'failed_cases', severity: 'warning', value: m.failed });

  if (project.status === 'ongoing' && project.inputs.startDate < ctx.today && m.completed < m.planned) {
    const entries = project.inputs.dailyExecuted ?? [];
    const last = entries.reduce((max, e) => (e.date > max ? e.date : max), '');
    const idle = last === '' ? daysBetween(project.inputs.startDate, ctx.today) : daysBetween(last, ctx.today);
    if (idle >= RISK_THRESHOLDS.idleDays) signals.push({ code: 'no_recent_activity', severity: 'warning', value: idle });
  }
  if (project.status === 'ongoing' && !ctx.assignments.some((a) => a.projectId === project.projectId && isAssignmentCurrent(a, ctx.today))) {
    signals.push({ code: 'no_tester', severity: 'info' });
  }
  if (m.warnings.includes('completed_exceeds_planned')) signals.push({ code: 'completed_exceeds_planned', severity: 'warning' });
  return signals.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
}

export function highestSeverity(signals: ReadonlyArray<{ severity: RiskSeverity }>): RiskSeverity | null {
  return signals.length === 0 ? null : signals.reduce((best, s) => (severityRank[s.severity] < severityRank[best] ? s.severity : best), signals[0].severity);
}

/** Needs Attention = at least one attention-level signal. */
export function needsAttention(signals: readonly RiskSignal[]): boolean {
  return signals.some((s) => s.severity === 'attention');
}

export type CycleRiskCode = 'cycle_overdue' | 'cycle_due_soon_much_remaining' | 'projects_need_attention';

export interface CycleRiskSignal {
  code: CycleRiskCode;
  severity: RiskSeverity;
  value?: number;
}

/** Cycle-level signals: its end date against what is left, plus how many of its projects need attention. */
export function cycleRiskSignals(cycle: Cycle, projects: readonly ProjectRecord[], ctx: RiskContext): CycleRiskSignal[] {
  if (cycle.status === 'completed' || cycle.status === 'archived') return [];
  const mine = projects.filter((p) => p.cycleId === cycle.id);
  const m = sumMetrics(mine.map(projectMetrics));
  const signals: CycleRiskSignal[] = [];
  if (cycle.plannedEnd !== null && cycle.plannedEnd < ctx.today) signals.push({ code: 'cycle_overdue', severity: 'attention' });
  else if (cycle.plannedEnd !== null) {
    const until = daysBetween(ctx.today, cycle.plannedEnd);
    if (until <= RISK_THRESHOLDS.dueSoonDays && m.planned > 0 && m.remaining / m.planned > RISK_THRESHOLDS.dueSoonRemainingShare) {
      signals.push({ code: 'cycle_due_soon_much_remaining', severity: 'attention', value: until });
    }
  }
  const atRisk = mine.filter((p) => needsAttention(projectRiskSignals(p, ctx))).length;
  if (atRisk > 0) signals.push({ code: 'projects_need_attention', severity: 'warning', value: atRisk });
  return signals;
}

// ---- cycle and portfolio summaries ---------------------------------------------------------------

export interface CycleSummary {
  cycle: Cycle;
  projects: ProjectRecord[];
  metrics: ExecutionMetrics;
  riskSignals: CycleRiskSignal[];
  atRiskProjects: ProjectRecord[];
}

export function cycleSummary(cycle: Cycle, projects: readonly ProjectRecord[], ctx: RiskContext): CycleSummary {
  const mine = projects.filter((p) => p.cycleId === cycle.id);
  return {
    cycle,
    projects: mine,
    metrics: sumMetrics(mine.map(projectMetrics)),
    riskSignals: cycleRiskSignals(cycle, projects, ctx),
    atRiskProjects: mine.filter((p) => needsAttention(projectRiskSignals(p, ctx))),
  };
}

export interface DailyActivityRow {
  date: string;
  passed: number;
  failed: number;
  blocked: number;
  executed: number;
}

/** The last `days` days (newest first) of recorded activity across some projects; days with nothing recorded are left out. */
export function recentActivity(projects: readonly ProjectRecord[], today: string, days = 7): DailyActivityRow[] {
  const byDate = new Map<string, DailyActivityRow>();
  for (const project of projects) {
    for (const e of project.inputs.dailyExecuted ?? []) {
      if (e.date > today || daysBetween(e.date, today) >= days) continue;
      const row = byDate.get(e.date) ?? { date: e.date, passed: 0, failed: 0, blocked: 0, executed: 0 };
      row.passed += int(e.pass);
      row.failed += int(e.fail);
      row.blocked += int(e.blocked);
      row.executed += int(e.pass) + int(e.fail);
      byDate.set(e.date, row);
    }
  }
  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
}

export interface PortfolioSummary {
  activeCycles: number;
  activeProjects: number;
  completedProjects: number;
  needsAttention: number;
  overdue: number;
  metrics: ExecutionMetrics;
  today: TodayMetrics;
}

/** The manager's whole-portfolio numbers (optionally limited to one cycle). Active = not done. */
export function portfolioMetrics(projects: readonly ProjectRecord[], cycles: readonly Cycle[], ctx: RiskContext, onlyCycleId?: string | null): PortfolioSummary {
  const scoped = onlyCycleId === undefined || onlyCycleId === null ? projects : projects.filter((p) => p.cycleId === onlyCycleId);
  const active = scoped.filter((p) => p.status !== 'done');
  const signals = new Map(active.map((p) => [p.id, projectRiskSignals(p, ctx)] as const));
  return {
    activeCycles: cycles.filter((c) => c.status === 'active').length,
    activeProjects: active.length,
    completedProjects: scoped.length - active.length,
    needsAttention: active.filter((p) => needsAttention(signals.get(p.id) ?? [])).length,
    overdue: active.filter((p) => isProjectOverdue(p, ctx.today)).length,
    metrics: sumMetrics(active.map(projectMetrics)),
    today: todayMetrics(scoped, ctx.today),
  };
}

// ---- Tester workload ------------------------------------------------------------------------------

export interface WorkloadProject {
  projectId: string;
  name: string;
  cycleId: string | null;
  remaining: number;
  /** How many people are on the project (so a shared project is visibly shared). */
  peopleOnProject: number;
}

export interface TesterWorkload {
  userId: string;
  assignedProjects: WorkloadProject[];
  /**
   * The remaining cases of the projects this Tester is on, each counted IN FULL. Where several people share a
   * project the figure is shared, not divided: there is no weighting in the data, and inventing one would be false precision.
   */
  sharedRemaining: number;
}

/** Per account Tester: the active projects they are currently assigned to. Disabled accounts still show (with their history intact). */
export function testerWorkload(userIds: readonly string[], projects: readonly ProjectRecord[], assignments: readonly TesterProjectAssignment[], today: string): TesterWorkload[] {
  const activeProjects = projects.filter((p) => p.status !== 'done' && p.status !== 'onHold');
  return userIds.map((userId) => {
    const mine = assignments.filter((a) => a.userId === userId && isAssignmentCurrent(a, today));
    const assignedProjects: WorkloadProject[] = [];
    for (const a of mine) {
      const project = activeProjects.find((p) => p.projectId === a.projectId);
      if (project === undefined || assignedProjects.some((w) => w.projectId === project.projectId)) continue;
      const people = new Set(assignments.filter((x) => x.projectId === project.projectId && isAssignmentCurrent(x, today)).map((x) => x.userId ?? x.memberId ?? x.testerName ?? x.id));
      assignedProjects.push({
        projectId: project.projectId,
        name: project.nameEn || project.nameJa || project.projectId,
        cycleId: project.cycleId ?? null,
        remaining: projectMetrics(project).remaining,
        peopleOnProject: people.size,
      });
    }
    return { userId, assignedProjects, sharedRemaining: assignedProjects.reduce((s, w) => s + w.remaining, 0) };
  });
}

/** Active projects with nobody currently assigned (account or roster). */
export function unassignedProjects(projects: readonly ProjectRecord[], assignments: readonly TesterProjectAssignment[], today: string): ProjectRecord[] {
  return projects.filter((p) => p.status !== 'done' && p.status !== 'onHold' && !assignments.some((a) => a.projectId === p.projectId && isAssignmentCurrent(a, today)));
}

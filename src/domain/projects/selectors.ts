import type { ProjectRecord } from '../../types';
import { calculateMultiDayProjection } from '../../lib/calculations/planning';
import { derivePlanStatus } from '../../lib/calculations/explanations';
import type { PlanStatus } from '../../lib/calculations/explanations';
import { WORK_DAY_END, WORK_LUNCH, workdayProductiveHours } from '../../lib/calculations/workday';
import { parseTimeToMinutes } from '../../lib/formatting/format';
import {
  LIFECYCLE_ORDER,
  type PlanningFilter,
  type PortfolioFilters,
  type PortfolioSummary,
  type ProjectPlanningStatus,
  type ProjectProgress,
  type ProjectSortKey,
  type SortDirection,
} from './types';

/**
 * Read-only project selectors. All planning/risk knowledge is delegated to
 * the existing calculation engine (derivePlanStatus +
 * calculateMultiDayProjection) — this module never recomputes schedules on
 * its own and never mutates lifecycle state.
 */

/**
 * Derive the planning/risk status from the project's inputs. A project on
 * hold is masked to the dedicated "onHold" display state: paused work has
 * neither schedule pressure nor progress, so the engine result would be
 * misleading. Extended projects run through the engine normally (they are
 * measured against their — extended — target date).
 */
export function projectPlanningStatus(project: ProjectRecord): ProjectPlanningStatus {
  if (project.status === 'onHold') return 'onHold';
  const { inputs } = project;
  const casesRemaining = Math.max(0, inputs.totalCases - inputs.casesCompleted);
  const targetTimeMinutes =
    inputs.targetCompletionTime === null ? null : parseTimeToMinutes(inputs.targetCompletionTime);
  const projection = calculateMultiDayProjection({
    casesRemaining,
    planningRows: inputs.planningRows,
    perHourPerTester: inputs.perHourPerTester,
    workStartTime: inputs.startTime,
    workEndTime: WORK_DAY_END,
    lunch: WORK_LUNCH,
    targetCompletionDate: inputs.targetCompletionDate,
    targetCompletionTime: targetTimeMinutes,
    dailyOvertimeMinutes: inputs.dailyOvertimeMinutes,
  });
  const status: PlanStatus = derivePlanStatus(projection, {
    totalCases: inputs.totalCases,
    casesRemaining,
    planningDayCount: inputs.planningRows.length,
    targetCompletionDate: inputs.targetCompletionDate,
    targetCompletionTime: targetTimeMinutes,
    workEndTimeMinutes: WORK_DAY_END,
  });
  return status === 'onTrack' || status === 'atRisk' || status === 'capacityShortage' || status === 'completed'
    ? status
    : 'noTarget';
}

/** Deadline already passed (and not done/on hold — paused work is not chased). */
export function isProjectOverdue(project: ProjectRecord, today: string): boolean {
  if (project.status === 'done' || project.status === 'onHold') return false;
  const deadline = project.inputs.targetCompletionDate;
  return deadline !== null && deadline < today;
}

/** Days until the deadline (null when absent/done/past). */
export function daysUntilDeadline(project: ProjectRecord, today: string): number | null {
  if (project.status === 'done') return null;
  const deadline = project.inputs.targetCompletionDate;
  if (deadline === null || deadline < today) return null;
  return Math.round((Date.parse(deadline) - Date.parse(today)) / 86_400_000);
}

/**
 * Derived "Needs Attention" filter (never a stored status): At Risk,
 * Capacity Shortage, Overdue, deadline within 7 calendar days, or an Ongoing
 * project without updates for 14+ days. Projects on hold never need
 * attention — paused work is not chased.
 */
export function projectNeedsAttention(project: ProjectRecord, today: string, nowIso: string): boolean {
  if (project.status === 'onHold') return false;
  const planning = projectPlanningStatus(project);
  if (planning === 'atRisk' || planning === 'capacityShortage') return true;
  if (isProjectOverdue(project, today)) return true;
  const untilDeadline = daysUntilDeadline(project, today);
  if (project.status === 'ongoing' && untilDeadline !== null && untilDeadline <= 7) return true;
  if (project.status === 'ongoing') {
    const staleMs = Date.parse(nowIso) - Date.parse(project.updatedAt);
    if (Number.isFinite(staleMs) && staleMs > 14 * 86_400_000) return true;
  }
  return false;
}

/** Progress figures — never auto-change the lifecycle status. */
export function projectProgress(project: ProjectRecord): ProjectProgress {
  const total = project.inputs.totalCases;
  const completed = project.inputs.casesCompleted;
  return {
    ratio: total > 0 ? Math.min(1, completed / total) : null,
    completed,
    total,
    remaining: Math.max(0, total - completed),
  };
}

/**
 * Team cases/day capacity from the workday model (per-project Plan Start
 * Time). A project on hold contributes no active capacity (work is paused).
 */
export function projectDailyCapacity(project: ProjectRecord): number {
  if (project.status === 'onHold') return 0;
  const { inputs } = project;
  return inputs.currentTesters * inputs.perHourPerTester * workdayProductiveHours(inputs.startTime, inputs.dailyOvertimeMinutes);
}

/** Display name in the active language with single-name fallback. */
export function projectDisplayName(project: ProjectRecord, lang: 'en' | 'ja'): string {
  const primary = (lang === 'en' ? project.nameEn : project.nameJa) ?? '';
  const fallback = (lang === 'en' ? project.nameJa : project.nameEn) ?? '';
  const trimmed = primary.trim();
  return trimmed !== '' ? trimmed : fallback.trim();
}

/** Find a project by its stable human-readable Project ID. */
export function findProjectByProjectId(projects: readonly ProjectRecord[], projectId: string): ProjectRecord | undefined {
  return projects.find((p) => p.projectId === projectId);
}

/**
 * Schedule Overview row order: by start datetime — start date, then the
 * day's work start time, then the stable Project ID as a deterministic
 * tiebreaker so the row order never flickers between renders.
 */
export function compareByStartDateTime(a: ProjectRecord, b: ProjectRecord): number {
  const byDate = a.inputs.startDate.localeCompare(b.inputs.startDate);
  if (byDate !== 0) return byDate;
  const byTime = a.inputs.startTime - b.inputs.startTime;
  if (byTime !== 0) return byTime;
  return (a.projectId ?? a.id).localeCompare(b.projectId ?? b.id, undefined, { numeric: true });
}

/** Search matches Project ID, English name or Japanese name (case-insensitive). */
export function searchMatchesProject(project: ProjectRecord, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return (
    (project.projectId ?? '').toLowerCase().includes(q) ||
    project.nameEn.toLowerCase().includes(q) ||
    project.nameJa.toLowerCase().includes(q) ||
    project.id.toLowerCase().includes(q)
  );
}

export function filterProjects(
  projects: ProjectRecord[],
  filters: PortfolioFilters,
  today: string,
  nowIso: string,
): ProjectRecord[] {
  return projects.filter((project) => {
    if (filters.lifecycle === 'active' && project.status === 'done') return false;
    if (filters.lifecycle === 'todo' && project.status !== 'todo') return false;
    if (filters.lifecycle === 'ongoing' && project.status !== 'ongoing') return false;
    if (filters.lifecycle === 'extended' && project.status !== 'extended') return false;
    if (filters.lifecycle === 'onHold' && project.status !== 'onHold') return false;
    if (filters.lifecycle === 'done' && project.status !== 'done') return false;
    if (filters.team !== null && project.team !== filters.team) return false;
    if (!searchMatchesProject(project, filters.search)) return false;
    if (filters.planning !== 'all') {
      const planning = projectPlanningStatus(project);
      switch (filters.planning) {
        case 'onTrack':
          if (planning !== 'onTrack' && planning !== 'noTarget') return false;
          break;
        case 'atRisk':
          if (planning !== 'atRisk') return false;
          break;
        case 'capacityShortage':
          if (planning !== 'capacityShortage') return false;
          break;
        case 'completed':
          if (planning !== 'completed') return false;
          break;
        case 'overdue':
          if (!isProjectOverdue(project, today)) return false;
          break;
        case 'needsAttention':
          if (!projectNeedsAttention(project, today, nowIso)) return false;
          break;
        case 'onHold':
          if (planning !== 'onHold') return false;
          break;
      }
    }
    return true;
  });
}

function deadlineKey(project: ProjectRecord): string {
  return project.inputs.targetCompletionDate ?? '9999-12-31';
}

function nameKey(project: ProjectRecord): string {
  return (project.nameEn || project.nameJa || project.id).toLowerCase();
}

/** Default: To Do → Ongoing → Done, then earliest deadline, then name. */
function defaultCompare(a: ProjectRecord, b: ProjectRecord): number {
  const byStatus = LIFECYCLE_ORDER[a.status] - LIFECYCLE_ORDER[b.status];
  if (byStatus !== 0) return byStatus;
  const byDeadline = deadlineKey(a).localeCompare(deadlineKey(b));
  if (byDeadline !== 0) return byDeadline;
  return nameKey(a).localeCompare(nameKey(b));
}

export function sortProjects(
  projects: ProjectRecord[],
  key: ProjectSortKey,
  direction: SortDirection = 'asc',
): ProjectRecord[] {
  const sorted = [...projects];
  const cmp = (a: ProjectRecord, b: ProjectRecord): number => {
    switch (key) {
      case 'default':
        return defaultCompare(a, b);
      case 'id':
        return (a.projectId ?? a.id).localeCompare(b.projectId ?? b.id, undefined, { numeric: true });
      case 'name':
        return nameKey(a).localeCompare(nameKey(b));
      case 'status':
        return LIFECYCLE_ORDER[a.status] - LIFECYCLE_ORDER[b.status];
      case 'start':
        return a.inputs.startDate.localeCompare(b.inputs.startDate);
      case 'deadline':
        return deadlineKey(a).localeCompare(deadlineKey(b));
      case 'progress': {
        const ra = projectProgress(a).ratio ?? -1;
        const rb = projectProgress(b).ratio ?? -1;
        return ra - rb;
      }
      case 'remaining':
        return projectProgress(a).remaining - projectProgress(b).remaining;
      case 'updated':
        return a.updatedAt.localeCompare(b.updatedAt);
    }
  };
  sorted.sort((a, b) => (direction === 'asc' ? cmp(a, b) : -cmp(a, b)));
  return sorted;
}

/** Portfolio summary card numbers — always computed, never hard-coded. */
export function portfolioSummary(projects: ProjectRecord[], today: string): PortfolioSummary {
  const summary: PortfolioSummary = {
    total: projects.length,
    todo: 0,
    ongoing: 0,
    extended: 0,
    onHold: 0,
    done: 0,
    atRisk: 0,
    overdue: 0,
    capacityShortage: 0,
  };
  for (const project of projects) {
    if (project.status === 'todo') summary.todo += 1;
    if (project.status === 'ongoing') summary.ongoing += 1;
    if (project.status === 'extended') summary.extended += 1;
    if (project.status === 'onHold') summary.onHold += 1;
    if (project.status === 'done') summary.done += 1;
    const planning = projectPlanningStatus(project);
    if (planning === 'atRisk') summary.atRisk += 1;
    if (planning === 'capacityShortage') summary.capacityShortage += 1;
    if (isProjectOverdue(project, today)) summary.overdue += 1;
  }
  return summary;
}

// ---- Named portfolio selectors ---------------------------------------------

/** Projects that are not Done (the default "Active" view). */
export function getActiveProjects(projects: readonly ProjectRecord[]): ProjectRecord[] {
  return projects.filter((p) => p.status !== 'done');
}

export function getCompletedProjects(projects: readonly ProjectRecord[]): ProjectRecord[] {
  return projects.filter((p) => p.status === 'done');
}

export function getProjectsByLifecycleStatus(
  projects: readonly ProjectRecord[],
  status: ProjectRecord['status'],
): ProjectRecord[] {
  return projects.filter((p) => p.status === status);
}

export function getProjectsByPlanningStatus(
  projects: readonly ProjectRecord[],
  planning: Exclude<PlanningFilter, 'all'>,
  today: string,
  nowIso: string,
): ProjectRecord[] {
  return filterProjects(
    [...projects],
    { lifecycle: 'all', planning, team: null, search: '' },
    today,
    nowIso,
  );
}

export function getProjectsNeedingAttention(
  projects: readonly ProjectRecord[],
  today: string,
  nowIso: string,
): ProjectRecord[] {
  return projects.filter((p) => projectNeedsAttention(p, today, nowIso));
}

// ---- Portfolio group status card (worst-case aggregate) ----------------------

/** Per-project schedule metrics feeding the portfolio group status card. */
export interface ProjectScheduleMetrics {
  planningStatus: ProjectPlanningStatus;
  /** Deadline passed (derived flag, independent of the planning status). */
  overdue: boolean;
  /** Project deadline date (YYYY-MM-DD) or null when not set. */
  deadline: string | null;
  /** Capacity-projected finish (epoch day + minutes of day); null when not computable. */
  plannedFinish: { epochDay: number; time: number } | null;
  /** Deadline minus the planned finish; negative = the deadline is missed. */
  bufferMinutes: number | null;
}

/** Worst-case portfolio verdict for a group of projects (Overall status card). */
export type PortfolioVerdict =
  | 'onTrack'
  | 'atRisk'
  | 'capacityShortage'
  | 'overdue'
  | 'completed'
  | 'noProjects';

export interface ProjectGroupSummary {
  verdict: PortfolioVerdict;
  /** Number of projects in the group. */
  projectCount: number;
  /** Latest capacity-projected finish in the group — when ALL work is done. */
  latestPlannedFinish: { epochDay: number; time: number } | null;
  /** Earliest deadline in the group (YYYY-MM-DD) — the nearest pressure point. */
  earliestDeadline: string | null;
  /** Minimum buffer in the group — the worst project's slack. */
  worstBufferMinutes: number | null;
}

/**
 * Worst-case aggregate over a group of projects (the Overall status card).
 * Verdict severity: any overdue project makes the group Overdue, then any
 * at-risk, then any capacity shortage; a group where every project is
 * completed is Completed; anything else is On Track. An empty group has the
 * neutral noProjects verdict. Planned finish is the LATEST in the group
 * (when all work is projected done), the deadline is the EARLIEST (the
 * nearest pressure point) and the buffer is the WORST (minimum) — a
 * portfolio owner cares about the weakest link, not the average.
 */
export function summarizeProjectGroup(metrics: readonly ProjectScheduleMetrics[]): ProjectGroupSummary {
  const projectCount = metrics.length;
  if (projectCount === 0) {
    return {
      verdict: 'noProjects',
      projectCount: 0,
      latestPlannedFinish: null,
      earliestDeadline: null,
      worstBufferMinutes: null,
    };
  }
  let anyOverdue = false;
  let anyAtRisk = false;
  let anyCapacityShortage = false;
  let allCompleted = true;
  let latestPlannedFinish: { epochDay: number; time: number } | null = null;
  let earliestDeadline: string | null = null;
  let worstBufferMinutes: number | null = null;
  for (const metric of metrics) {
    if (metric.overdue) anyOverdue = true;
    if (metric.planningStatus === 'atRisk') anyAtRisk = true;
    if (metric.planningStatus === 'capacityShortage') anyCapacityShortage = true;
    if (metric.planningStatus !== 'completed') allCompleted = false;
    if (metric.plannedFinish !== null) {
      if (
        latestPlannedFinish === null ||
        metric.plannedFinish.epochDay > latestPlannedFinish.epochDay ||
        (metric.plannedFinish.epochDay === latestPlannedFinish.epochDay && metric.plannedFinish.time > latestPlannedFinish.time)
      ) {
        latestPlannedFinish = metric.plannedFinish;
      }
    }
    if (metric.deadline !== null && (earliestDeadline === null || metric.deadline < earliestDeadline)) {
      earliestDeadline = metric.deadline;
    }
    if (metric.bufferMinutes !== null && (worstBufferMinutes === null || metric.bufferMinutes < worstBufferMinutes)) {
      worstBufferMinutes = metric.bufferMinutes;
    }
  }
  const verdict: PortfolioVerdict = anyOverdue
    ? 'overdue'
    : anyAtRisk
      ? 'atRisk'
      : anyCapacityShortage
        ? 'capacityShortage'
        : allCompleted
          ? 'completed'
          : 'onTrack';
  return { verdict, projectCount, latestPlannedFinish, earliestDeadline, worstBufferMinutes };
}

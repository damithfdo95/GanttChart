/**
 * The QA manager's landing numbers, computed ONLY from data the application already has
 * (project lifecycle status, schedule dates, planned and completed case counts). Nothing
 * here is invented: pass/fail/blocked counts, velocity and defects are not in the data
 * model yet, so they are not shown.
 */

import type { ProjectRecord } from './types';
import { isProjectOverdue, projectNeedsAttention, projectProgress } from './selectors';

export interface ManagerSummary {
  /** Projects that are not Done. */
  activeProjects: number;
  completedProjects: number;
  /** Not on hold and at risk, overdue, due within a week while ongoing, or untouched for two weeks. */
  needsAttention: number;
  overdue: number;
  /** Ongoing projects whose schedule includes today (started, deadline not passed). */
  executingToday: number;
  /** Planned test cases across active projects. */
  plannedCases: number;
  completedCases: number;
  remainingCases: number;
  /** completed / planned across active projects; null when nothing is planned. */
  progress: number | null;
}

export function managerSummary(projects: readonly ProjectRecord[], today: string, nowIso: string): ManagerSummary {
  const out: ManagerSummary = {
    activeProjects: 0,
    completedProjects: 0,
    needsAttention: 0,
    overdue: 0,
    executingToday: 0,
    plannedCases: 0,
    completedCases: 0,
    remainingCases: 0,
    progress: null,
  };
  for (const project of projects) {
    if (project.status === 'done') {
      out.completedProjects += 1;
      continue;
    }
    out.activeProjects += 1;
    if (projectNeedsAttention(project, today, nowIso)) out.needsAttention += 1;
    if (isProjectOverdue(project, today)) out.overdue += 1;
    const deadline = project.inputs.targetCompletionDate;
    if (project.status === 'ongoing' && project.inputs.startDate <= today && (deadline === null || deadline >= today)) out.executingToday += 1;
    const progress = projectProgress(project);
    out.plannedCases += progress.total;
    out.completedCases += Math.min(progress.completed, progress.total);
    out.remainingCases += progress.remaining;
  }
  out.progress = out.plannedCases > 0 ? out.completedCases / out.plannedCases : null;
  return out;
}

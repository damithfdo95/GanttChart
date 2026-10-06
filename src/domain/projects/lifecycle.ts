import type { DailyReport, ProjectLifecycleStatus, ProjectRecord, QaInputs } from '../../types';
import { generateId } from '../../lib/id';
import { normalizeQaInputs } from '../../lib/storage/storage';
import { LIFECYCLE_ORDER } from './types';

/**
 * Single source of truth for project lifecycle operations. Every screen
 * (Overall, Gantt, Dashboard, Daily Report, exports) must use these
 * functions — never re-implement lifecycle transitions locally.
 *
 * Rules:
 * - Lifecycle status is user-controlled; it is never derived from progress,
 *   planning status, deadlines or capacity.
 * - Statuses: todo (scheduled), ongoing (in progress), extended (deadline
 *   officially extended — still active), onHold (work paused — no capacity
 *   or deadline pressure in derived calculations), done (finished).
 * - Every transition appends to statusHistory (audit trail).
 * - completedAt/completedBy are set when entering "done" and cleared on
 *   reopen; the history preserves the completion events.
 */

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

/**
 * Next stable human-readable project ID ("PRJ-001", "PRJ-002", …) that does
 * not collide with any existing projectId. Never based on array index —
 * existing IDs are scanned, so deletions/gaps never cause reuse.
 */
export function nextProjectId(existing: readonly ProjectRecord[]): string {
  let max = 0;
  const seen = new Set<string>();
  for (const project of existing) {
    if (project.projectId !== undefined) {
      seen.add(project.projectId);
      const m = /^PRJ-(\d+)$/.exec(project.projectId);
      if (m !== null) max = Math.max(max, Number(m[1]));
    }
  }
  let candidate = max + 1;
  while (seen.has(`PRJ-${pad3(candidate)}`)) candidate += 1;
  return `PRJ-${pad3(candidate)}`;
}

/**
 * Create a project record with a unique stable Project ID. The inputs are
 * normalized (V6.3 §25) so every creation path — form, migration, seed —
 * stores the same fully-populated canonical shape (spoAssigned, Level 2
 * defaults, …) as a loaded/imported/restored project.
 */
export function newProjectRecord(
  inputs: QaInputs,
  overrides: Partial<Pick<ProjectRecord, 'nameEn' | 'nameJa' | 'team' | 'status'>> = {},
  nowIso: string,
  existing: readonly ProjectRecord[] = [],
): ProjectRecord {
  const status = overrides.status ?? 'todo';
  return {
    id: generateId(),
    projectId: nextProjectId(existing),
    nameEn: overrides.nameEn ?? '',
    nameJa: overrides.nameJa ?? '',
    team: overrides.team ?? '',
    status,
    statusHistory: [{ status, changedAt: nowIso }],
    completedAt: null,
    completedBy: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    inputs: normalizeQaInputs(JSON.parse(JSON.stringify(inputs)) as QaInputs),
  };
}

/**
 * Transition the lifecycle status. All corrections are allowed
 * (todo↔ongoing↔extended↔onHold↔done); every change is appended to
 * statusHistory.
 */
export function setProjectLifecycleStatus(
  project: ProjectRecord,
  status: ProjectLifecycleStatus,
  nowIso: string,
  by?: string,
): ProjectRecord {
  return {
    ...project,
    status,
    statusHistory: [...project.statusHistory, { status, changedAt: nowIso }],
    completedAt: status === 'done' ? (project.completedAt ?? nowIso) : null,
    completedBy: status === 'done' ? (project.completedBy ?? by ?? null) : null,
    updatedAt: nowIso,
  };
}

/**
 * Reopen a Done project as To Do, In Progress, Extended or On Hold — the
 * caller chooses explicitly; nothing is guessed. The previous Done event
 * stays in statusHistory and the completion metadata is cleared (the
 * lifecycle status is authoritative).
 */
export function reopenProject(
  project: ProjectRecord,
  status: 'todo' | 'ongoing' | 'extended' | 'onHold',
  nowIso: string,
  by?: string,
): ProjectRecord {
  return setProjectLifecycleStatus(project, status, nowIso, by);
}

/**
 * Stable sort weight of a lifecycle status
 * (todo → ongoing → extended → onHold → done).
 */
export function lifecycleWeight(status: ProjectLifecycleStatus): number {
  return LIFECYCLE_ORDER[status];
}

export interface ProjectRemoval {
  projects: ProjectRecord[];
  /** Reports of the removed project are removed with it (its execution data). */
  reports: DailyReport[];
  /**
   * Active-project fallback (V6.3 §12): the first remaining project in
   * registry order when the active project was removed, otherwise the
   * unchanged active id; null when no project remains.
   */
  nextActiveProjectId: string | null;
}

/**
 * Remove one project and its reports from the registry. Pure and
 * deterministic — callers apply the result through the state actions.
 */
export function removeProjectFromRegistry(
  projects: readonly ProjectRecord[],
  reports: readonly DailyReport[],
  activeProjectId: string | null,
  projectId: string,
): ProjectRemoval {
  const target = projects.find((p) => p.id === projectId);
  const remainingProjects = projects.filter((p) => p.id !== projectId);
  const remainingReports = target === undefined ? [...reports] : reports.filter((r) => r.projectId !== target.projectId);
  const nextActiveProjectId =
    target !== undefined && activeProjectId === projectId
      ? (remainingProjects[0]?.id ?? null)
      : activeProjectId;
  return { projects: remainingProjects, reports: remainingReports, nextActiveProjectId };
}

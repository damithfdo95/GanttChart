import type { Cycle, CycleStatus, ProjectRecord } from '../../types';
import { checkCycle, CYCLE_STATUSES } from '../../../shared/qaRules';
import { generateId } from '../../lib/id';

/**
 * Test cycles / releases (Stage 8A). Pure functions over plain data: callers apply the result through the
 * reports-state actions so persistence and sync stay centralized. A cycle groups several test executions
 * (projects); each project belongs to at most one cycle, and a project without one is entirely valid.
 */

export type CycleError =
  | 'cycle_invalid_name'
  | 'cycle_invalid_version'
  | 'cycle_invalid_description'
  | 'cycle_invalid_date'
  | 'cycle_end_before_start'
  | 'cycle_invalid_status'
  | 'cycle_invalid_id'
  | 'cycle_invalid_completed_at'
  | 'cycle_invalid_timestamp'
  | 'cycle_not_an_object'
  | 'cycle_not_found'
  | 'cycle_archived'
  | 'cycle_transition_not_allowed';

export type CycleResult<T> = { ok: true; value: T } | { ok: false; error: CycleError | string };

export interface CycleInput {
  name: string;
  version?: string;
  description?: string;
  plannedStart?: string | null;
  plannedEnd?: string | null;
}

const clean = (v: string | undefined): string | undefined => {
  const t = v?.replace(/\s+/g, ' ').trim();
  return t === undefined || t === '' ? undefined : t;
};

function finish(cycle: Cycle): CycleResult<Cycle> {
  const check = checkCycle(cycle);
  return check.ok ? { ok: true, value: check.cycle } : { ok: false, error: check.error };
}

/** A new cycle in the Planned state. Names are trimmed; dates must be real and in order. */
export function createCycle(input: CycleInput, nowIso: string): CycleResult<Cycle> {
  const cycle: Cycle = {
    id: `cyc_${generateId()}`,
    name: input.name.replace(/\s+/g, ' ').trim(),
    ...(clean(input.version) === undefined ? {} : { version: clean(input.version) }),
    ...(clean(input.description) === undefined ? {} : { description: input.description?.trim() }),
    status: 'planned',
    plannedStart: input.plannedStart ?? null,
    plannedEnd: input.plannedEnd ?? null,
    completedAt: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  return finish(cycle);
}

/** Edit the descriptive fields (name, version, description, planned dates). Status has its own function. */
export function editCycle(cycle: Cycle, input: CycleInput, nowIso: string): CycleResult<Cycle> {
  const next: Cycle = {
    ...cycle,
    name: input.name.replace(/\s+/g, ' ').trim(),
    plannedStart: input.plannedStart ?? null,
    plannedEnd: input.plannedEnd ?? null,
    updatedAt: nowIso,
  };
  const version = clean(input.version);
  const description = input.description?.trim() === '' ? undefined : input.description?.trim();
  if (version === undefined) delete next.version;
  else next.version = version;
  if (description === undefined) delete next.description;
  else next.description = description;
  return finish(next);
}

/**
 * The few allowed status changes. Planned -> Active -> Completed, a finished or unused cycle can be Archived,
 * and a Completed or Archived cycle can be reopened. Nothing else.
 */
export const CYCLE_TRANSITIONS: Readonly<Record<CycleStatus, readonly CycleStatus[]>> = {
  planned: ['active', 'archived'],
  active: ['planned', 'completed', 'archived'],
  completed: ['active', 'archived'],
  archived: ['planned', 'active'],
};

export function canMoveCycle(from: CycleStatus, to: CycleStatus): boolean {
  return CYCLE_TRANSITIONS[from].includes(to);
}

/** Change the status. Completing stamps the completion time; leaving Completed/Archived-from-Completed keeps history honest. */
export function setCycleStatus(cycle: Cycle, to: CycleStatus, nowIso: string): CycleResult<Cycle> {
  if (!(CYCLE_STATUSES as readonly string[]).includes(to)) return { ok: false, error: 'cycle_invalid_status' };
  if (to === cycle.status) return { ok: true, value: cycle };
  if (!canMoveCycle(cycle.status, to)) return { ok: false, error: 'cycle_transition_not_allowed' };
  const completedAt = to === 'completed' ? nowIso : to === 'archived' ? cycle.completedAt : null;
  return finish({ ...cycle, status: to, completedAt, updatedAt: nowIso });
}

/** Projects of one cycle (by id; a project in no cycle is never included). */
export function projectsOfCycle(projects: readonly ProjectRecord[], cycleId: string): ProjectRecord[] {
  return projects.filter((p) => p.cycleId === cycleId);
}

export function projectsWithoutCycle(projects: readonly ProjectRecord[]): ProjectRecord[] {
  return projects.filter((p) => p.cycleId === undefined || p.cycleId === null);
}

/**
 * Put a project into a cycle, move it to another, or take it out (`null`). The target must exist in THIS workspace's
 * cycles and must not be archived. The server checks the same rules again.
 */
export function withProjectCycle(project: ProjectRecord, cycleId: string | null, cycles: readonly Cycle[], nowIso: string): CycleResult<ProjectRecord> {
  if (cycleId !== null) {
    const target = cycles.find((c) => c.id === cycleId);
    if (target === undefined) return { ok: false, error: 'cycle_not_found' };
    if (target.status === 'archived' && project.cycleId !== cycleId) return { ok: false, error: 'cycle_archived' };
  }
  if ((project.cycleId ?? null) === cycleId) return { ok: true, value: project };
  return { ok: true, value: { ...project, cycleId, updatedAt: nowIso } };
}

/** Projects that name a cycle this workspace does not have (should never happen; surfaced, never silently fixed). */
export function projectsWithMissingCycle(projects: readonly ProjectRecord[], cycles: readonly Cycle[]): ProjectRecord[] {
  const known = new Set(cycles.map((c) => c.id));
  return projects.filter((p) => p.cycleId !== undefined && p.cycleId !== null && !known.has(p.cycleId));
}

/** Newest first; active ones before planned, completed and archived. */
export function sortCycles(cycles: readonly Cycle[]): Cycle[] {
  const rank: Record<CycleStatus, number> = { active: 0, planned: 1, completed: 2, archived: 3 };
  return [...cycles].sort((a, b) => rank[a.status] - rank[b.status] || (b.plannedStart ?? b.createdAt).localeCompare(a.plannedStart ?? a.createdAt) || a.name.localeCompare(b.name));
}

import { isAssignmentCurrent } from './qaMetrics';
import type { DailyExecutionEntry, RcsMember, TesterProjectAssignment } from '../types';

/**
 * Planned / Assigned / Actual Testers - three different facts that must never overwrite each other:
 *  - Planned: the capacity the plan assumes (the persisted `currentTesters`; read it from the project's inputs).
 *  - Assigned: the named people on the project - derived here from the assignment records, never stored.
 *  - Actual: how many worked on one date - the daily execution entry's own `testers`.
 */

/** A stable person key: the Team Member when known (an account id resolves to its linked member), else the account, else a legacy name. */
function personKey(a: TesterProjectAssignment, members: readonly RcsMember[]): string | null {
  if (a.memberId !== undefined) return `m:${a.memberId}`;
  if (a.userId !== undefined) {
    const linked = members.find((m) => m.userId === a.userId);
    return linked === undefined ? `u:${a.userId}` : `m:${linked.id}`;
  }
  const name = a.testerName?.trim().toLowerCase();
  return name === undefined || name === '' ? null : `n:${name}`;
}

/** The unique people assigned anywhere in the project (project-wide or any scope) on `date`. */
export function assignedTesterIdsForProject(
  assignments: readonly TesterProjectAssignment[],
  projectId: string,
  date: string,
  members: readonly RcsMember[] = [],
): Set<string> {
  const ids = new Set<string>();
  for (const a of assignments) {
    if (a.projectId !== projectId || !isAssignmentCurrent(a, date)) continue;
    const key = personKey(a, members);
    if (key !== null) ids.add(key);
  }
  return ids;
}

export function assignedTesterCountForProject(assignments: readonly TesterProjectAssignment[], projectId: string, date: string, members: readonly RcsMember[] = []): number {
  return assignedTesterIdsForProject(assignments, projectId, date, members).size;
}

/** The testers recorded for `date`, or null when that day has no entry (never a fabricated 0). */
export function actualTesterCountForDate(entries: readonly DailyExecutionEntry[], date: string): number | null {
  return entries.find((e) => e.date === date)?.testers ?? null;
}

export interface TesterCapacitySummary {
  planned: number;
  assigned: number;
  actual: number | null;
  /** planned - assigned: positive = people still to assign, negative = over-assigned. */
  assignmentGap: number;
  /** planned - actual (null without an entry for the date). */
  actualGap: number | null;
  assignmentState: 'fullyStaffed' | 'assignmentGap' | 'overAssigned';
}

/** Informational only: nothing here feeds the schedule, the risk engine or the plan. */
export function testerCapacitySummary(input: {
  planned: number;
  projectId: string;
  date: string;
  assignments: readonly TesterProjectAssignment[];
  members?: readonly RcsMember[];
  entries: readonly DailyExecutionEntry[];
}): TesterCapacitySummary {
  const assigned = assignedTesterCountForProject(input.assignments, input.projectId, input.date, input.members ?? []);
  const actual = actualTesterCountForDate(input.entries, input.date);
  const assignmentGap = input.planned - assigned;
  return {
    planned: input.planned,
    assigned,
    actual,
    assignmentGap,
    actualGap: actual === null ? null : input.planned - actual,
    assignmentState: assignmentGap === 0 ? 'fullyStaffed' : assignmentGap > 0 ? 'assignmentGap' : 'overAssigned',
  };
}

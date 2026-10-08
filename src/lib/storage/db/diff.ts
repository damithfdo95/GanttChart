/**
 * Canonical workspace diff (V6.8 §9–§11).
 *
 * Pure, deterministic comparison of two canonical workspaces producing the
 * journal's change summary. The journal never infers changes from UI events:
 * the persistence backend compares the PREVIOUS canonical persisted state
 * with the NEXT one (V6.8 §9). Only domain-level changes are described —
 * persistence internals (mirrors, manifest bookkeeping, fallback records)
 * are invisible here by construction.
 *
 * Determinism (§11): no random ids, no timing-dependent classification, no
 * UI/browser state. Same inputs → byte-identical summary. Collections use
 * stable JSON comparison and stable record ids.
 */

import type { AppState, ReportsState } from '../../../types';
import { splitWorkspace, type WorkspaceParts } from './workspace';
import type { RevisionChangeSummary, RevisionReason } from './journal';

/** A canonical workspace as committed (the React application state). */
export interface CanonicalWorkspace {
  app: AppState;
  reports: ReportsState;
}

export interface WorkspaceDiff {
  summary: RevisionChangeSummary;
  /** Best domain-level reason for the change when the caller does not force one. */
  reason: RevisionReason;
  /** Stable Project IDs touched by this revision (created/updated/deleted). */
  affectedProjectIds: string[];
}

/** AppState fields that represent EXECUTION progress of the active project. */
const EXECUTION_FIELDS: readonly (keyof AppState)[] = [
  'casesCompleted',
  'casesPassed',
  'casesFailed',
  'casesNotApplicable',
  'spoAssigned',
  'casesBlocked',
  'casesRetest',
  'casesQuestioned',
  'dailyActuals',
  'blockingEvents',
  'bugTickets',
  'testerDailyPerformance',
];

/** AppState fields that represent PLANNING/schedule inputs. */
const PLANNING_FIELDS: readonly (keyof AppState)[] = [
  'totalCases',
  'currentTesters',
  'perHourPerTester',
  'startTime',
  'targetFinish',
  'lunchStart',
  'lunchEnd',
  'startDate',
  'targetCompletionDate',
  'targetCompletionTime',
  'planningRows',
  'targetPassRate',
  'dailyTargetOverrides',
  'milestones',
];

function jsonEquals(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface RowLike {
  id: string;
}

/** Diff one keyed record collection; returns created/updated/deleted ids. */
function diffRows<T extends RowLike>(
  prev: T[] | undefined,
  next: T[],
): { created: string[]; updated: string[]; deleted: string[] } {
  const prevMap = new Map((prev ?? []).map((row) => [row.id, row]));
  const nextMap = new Map(next.map((row) => [row.id, row]));
  const created: string[] = [];
  const updated: string[] = [];
  const deleted: string[] = [];
  for (const [id, row] of nextMap) {
    const before = prevMap.get(id);
    if (before === undefined) created.push(id);
    else if (!jsonEquals(before, row)) updated.push(id);
  }
  for (const id of prevMap.keys()) {
    if (!nextMap.has(id)) deleted.push(id);
  }
  return { created, updated, deleted };
}

function changed<T>(prev: T[] | undefined, next: T[]): boolean {
  return !jsonEquals(prev ?? [], next);
}

/** Stable Project ID of a project record id (records are keyed by record id; ids here are the stable PRJ ids). */
function projectStableIds(parts: WorkspaceParts, recordIds: string[]): string[] {
  const byRecordId = new Map(parts.projects.map((project) => [project.id, project.projectId]));
  const stable = new Set<string>();
  for (const id of recordIds) {
    const projectId = byRecordId.get(id);
    if (projectId !== undefined) stable.add(projectId);
  }
  return [...stable].sort();
}

/** Classify the best reason from the summary alone (deterministic priority). */
function classifyReason(summary: RevisionChangeSummary): RevisionReason {
  if (summary.projectsCreated.length > 0) return 'project-created';
  if (summary.projectsDeleted.length > 0) return 'project-deleted';
  if (summary.reportsCreated.length > 0) return 'report-created';
  if (summary.reportsDeleted.length > 0) return 'report-deleted';
  if (summary.reportsUpdated.length > 0) return 'report-updated';
  if (summary.attendanceChanged) return 'attendance-updated';
  if (summary.topicsChanged) return 'topic-updated';
  if (summary.identityChanged) return 'identity-updated';
  return 'edit';
}

/**
 * Diff the canonical workspaces. `prev === null` (fresh journal anchor /
 * first commit) treats every existing record as created; the caller supplies
 * the reason for such anchor commits (initial/migration) explicitly.
 */
export function diffWorkspaces(prev: CanonicalWorkspace | null, next: CanonicalWorkspace): WorkspaceDiff {
  const prevParts = prev === null ? null : splitWorkspace(prev.app, prev.reports).parts;
  const nextParts = splitWorkspace(next.app, next.reports).parts;

  const projects = diffRows(prevParts?.projects, nextParts.projects);
  const reports = diffRows(prevParts?.reports, nextParts.reports);
  const attendance = changed(prevParts?.attendance, nextParts.attendance);
  const topics = changed(prevParts?.topics, nextParts.topics);

  // Snapshot rows are keyed by the composite projectId::id (V6.5 semantics).
  const prevSnapshots = new Set((prevParts?.dailyActuals ?? []).map((row) => `${row.projectId}::${row.id}`));
  const nextSnapshots = new Map(nextParts.dailyActuals.map((row) => [`${row.projectId}::${row.id}`, row]));
  let snapshotsChanged = prevParts === null ? nextSnapshots.size > 0 : prevSnapshots.size !== nextSnapshots.size;
  if (!snapshotsChanged) {
    for (const [key, row] of nextSnapshots) {
      const before = (prevParts?.dailyActuals ?? []).find((candidate) => `${candidate.projectId}::${candidate.id}` === key);
      if (before === undefined || !jsonEquals(before, row)) {
        snapshotsChanged = true;
        break;
      }
    }
  }

  const identityChanged =
    changed(prevParts?.collections.rcsMembers, nextParts.collections.rcsMembers) ||
    changed(prevParts?.collections.identityAuditLog, nextParts.collections.identityAuditLog) ||
    changed(prevParts?.collections.externalIdentities, nextParts.collections.externalIdentities);
  const testerAssignmentsChanged = changed(prevParts?.collections.testerAssignments, nextParts.collections.testerAssignments);
  const reviewsChanged = changed(prevParts?.collections.reviews, nextParts.collections.reviews);

  // AppState is the ACTIVE project's editing surface: classify field groups.
  let executionChanged = false;
  let planningChanged = false;
  let settingsChanged = false;
  if (prev !== null) {
    for (const field of EXECUTION_FIELDS) {
      if (!jsonEquals(prev.app[field], next.app[field])) executionChanged = true;
    }
    for (const field of PLANNING_FIELDS) {
      if (!jsonEquals(prev.app[field], next.app[field])) planningChanged = true;
    }
    if (
      !jsonEquals(prevParts?.collections.cycles ?? [], nextParts.collections.cycles) ||
      !jsonEquals(prevParts?.collections.scopes ?? [], nextParts.collections.scopes) ||
      !jsonEquals(prevParts?.collections.testCases ?? [], nextParts.collections.testCases) ||
      !jsonEquals(prevParts?.collections.dailyPlans ?? [], nextParts.collections.dailyPlans) ||
      !jsonEquals(prevParts?.collections.meetingNotes ?? [], nextParts.collections.meetingNotes) ||
      !jsonEquals(prevParts?.collections.notifications ?? [], nextParts.collections.notifications) ||
      !jsonEquals(prevParts?.collections.brandings ?? [], nextParts.collections.brandings) ||
      prev.app.language !== next.app.language ||
      prev.app.projectNameEn !== next.app.projectNameEn ||
      prev.app.projectNameJa !== next.app.projectNameJa ||
      (prev.app.dashboardView ?? 'operator') !== (next.app.dashboardView ?? 'operator')
    ) {
      settingsChanged = true;
    }
  }

  // Affected projects: stable ids of created/updated/deleted projects,
  // projects owning changed reports, snapshot owners, and the active project
  // when the AppState editing surface changed.
  const affected = new Set<string>(projectStableIds(nextParts, [...projects.created, ...projects.updated, ...projects.deleted]));
  for (const report of nextParts.reports) {
    if (
      reports.created.includes(report.id) ||
      reports.updated.includes(report.id) ||
      reports.deleted.includes(report.id)
    ) {
      if (report.projectId !== null && report.projectId !== undefined) affected.add(report.projectId);
    }
  }
  // Deleted reports are no longer in nextParts — their owning project came
  // from the previous state.
  if (prevParts !== null) {
    for (const report of prevParts.reports) {
      if (reports.deleted.includes(report.id)) {
        if (report.projectId !== null && report.projectId !== undefined) affected.add(report.projectId);
      }
    }
  }
  if (snapshotsChanged) {
    for (const row of nextParts.dailyActuals) affected.add(row.projectId);
    for (const row of prevParts?.dailyActuals ?? []) affected.add(row.projectId);
  }
  if (prev !== null && (executionChanged || planningChanged || settingsChanged)) {
    // The AppState edits the active project; map the active record to its
    // stable Project ID (name-based matching is never used).
    const activeRecord = nextParts.projects.find((project) => project.id === next.reports.activeProjectId);
    if (activeRecord !== undefined) affected.add(activeRecord.projectId);
    const prevActive = prevParts?.projects.find((project) => project.id === prev.reports.activeProjectId);
    if (prevActive !== undefined) affected.add(prevActive.projectId);
  }
  // Attendance records carry no project attribution — they are workspace-wide
  // and appear in the summary flags only.
  // Deleted projects are resolved through the PREVIOUS state (they no longer
  // exist in the next one).
  for (const id of projects.deleted) {
    const stable = prevParts?.projects.find((project) => project.id === id)?.projectId;
    if (stable !== undefined) affected.add(stable);
  }

  const summary: RevisionChangeSummary = {
    projectsCreated: projects.created,
    projectsUpdated: projects.updated,
    projectsDeleted: projects.deleted,
    reportsCreated: reports.created,
    reportsUpdated: reports.updated,
    reportsDeleted: reports.deleted,
    snapshotsChanged,
    attendanceChanged: attendance,
    topicsChanged: topics,
    identityChanged,
    testerAssignmentsChanged,
    reviewsChanged,
    executionChanged,
    planningChanged,
    settingsChanged,
  };
  return { summary, reason: classifyReason(summary), affectedProjectIds: [...affected].sort() };
}

/** True when the workspace carries no domain change at all (used by tests). */
export function isNoOpDiff(diff: WorkspaceDiff): boolean {
  const s = diff.summary;
  return (
    s.projectsCreated.length === 0 &&
    s.projectsUpdated.length === 0 &&
    s.projectsDeleted.length === 0 &&
    s.reportsCreated.length === 0 &&
    s.reportsUpdated.length === 0 &&
    s.reportsDeleted.length === 0 &&
    !s.snapshotsChanged &&
    !s.attendanceChanged &&
    !s.topicsChanged &&
    !s.identityChanged &&
    !s.testerAssignmentsChanged &&
    !s.reviewsChanged &&
    !s.executionChanged &&
    !s.planningChanged &&
    !s.settingsChanged
  );
}

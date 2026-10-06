/**
 * Workspace split/assemble (V6.6 database migration, §5–§9).
 *
 * Maps the two canonical V6.3 states (AppState + ReportsState) onto the
 * IndexedDB object stores. This is the ONLY place where the mapping between
 * the domain workspace and the database records lives —the migration, the
 * regular save path and the load path all share it, so a record written by
 * one path is always readable by the others (§27).
 */

import type {
  AttendanceRecord,
  DailyActualSnapshot,
  DailyReport,
  DailyTopic,
  ExternalIdentity,
  IdentityAuditEntry,
  ProjectRecord,
  QaInputs,
  ReportSettings,
  ReportsState,
  RcsMember,
  TesterProjectAssignment,
  TesterReview,
} from '../../../types';

/** A V6.5 daily-actual snapshot row: snapshot fields + owning project + list order. */
export interface DailyActualRow extends DailyActualSnapshot {
  /** Stable owning Project ID ("PRJ-001"). */
  projectId: string;
  /** Position inside the project's snapshot list — preserves the persisted order. */
  order: number;
}

/**
 * Store key of a snapshot row. Snapshot ids are unique per project, not
 * globally (they live inside project inputs in the domain model), so the
 * database key is the composite projectId::id.
 */
export function dailyActualRowKey(row: Pick<DailyActualRow, 'projectId' | 'id'>): string {
  return `${row.projectId}::${row.id}`;
}

/** ReportsState minus the pieces stored in their own object stores. */
export interface ReportsCore {
  schemaVersion: number;
  settings: ReportSettings;
  activeProjectId: string | null;
}

export interface WorkspaceCollections {
  testerAssignments: TesterProjectAssignment[];
  reviews: TesterReview[];
  rcsMembers: RcsMember[];
  identityAuditLog: IdentityAuditEntry[];
  externalIdentities: ExternalIdentity[];
}

/** The complete split of a workspace into IndexedDB-shaped records. */
export interface WorkspaceParts {
  projects: ProjectRecord[];
  dailyActuals: DailyActualRow[];
  reports: DailyReport[];
  attendance: AttendanceRecord[];
  topics: DailyTopic[];
  core: ReportsCore;
  collections: WorkspaceCollections;
}

function stripDailyActuals(project: ProjectRecord): ProjectRecord {
  return { ...project, inputs: { ...project.inputs, dailyActuals: [] } };
}

/**
 * Split a canonical workspace into database records. Daily-actual snapshots
 * live inside project inputs in the domain model; they are extracted into
 * the dailyActuals store with their owning projectId and list order (§5:
 * logical relationship preserved, no unnecessary further normalization).
 */
export function splitWorkspace(appState: unknown, reports: ReportsState): { appState: unknown; parts: WorkspaceParts } {
  const dailyActuals: DailyActualRow[] = [];
  const projects = reports.projects.map((project) => {
    const snapshots = project.inputs.dailyActuals ?? [];
    snapshots.forEach((snapshot, order) => {
      dailyActuals.push({ ...snapshot, projectId: project.projectId, order });
    });
    return stripDailyActuals(project);
  });
  return {
    appState,
    parts: {
      projects,
      dailyActuals,
      reports: reports.reports,
      attendance: reports.attendance,
      topics: reports.topics,
      core: {
        schemaVersion: reports.schemaVersion,
        settings: reports.settings,
        activeProjectId: reports.activeProjectId,
      },
      collections: {
        testerAssignments: reports.testerAssignments ?? [],
        reviews: reports.reviews ?? [],
        rcsMembers: reports.rcsMembers ?? [],
        identityAuditLog: reports.identityAuditLog ?? [],
        externalIdentities: reports.externalIdentities ?? [],
      },
    },
  };
}

/** Inverse of splitWorkspace: rebuild the domain ReportsState from records. */
export function assembleReportsState(parts: WorkspaceParts): ReportsState {
  const projects = parts.projects.map((project) => {
    const snapshots = parts.dailyActuals
      .filter((row) => row.projectId === project.projectId)
      .sort((a, b) => a.order - b.order)
      .map((row) => {
        const { projectId: _projectId, order: _order, ...snapshot } = row;
        return snapshot as DailyActualSnapshot;
      });
    const inputs: QaInputs = { ...project.inputs, dailyActuals: snapshots };
    return { ...project, inputs };
  });
  return {
    schemaVersion: parts.core.schemaVersion,
    settings: parts.core.settings,
    attendance: parts.attendance,
    topics: parts.topics,
    reports: parts.reports,
    projects,
    activeProjectId: parts.core.activeProjectId,
    testerAssignments: parts.collections.testerAssignments,
    reviews: parts.collections.reviews,
    rcsMembers: parts.collections.rcsMembers,
    identityAuditLog: parts.collections.identityAuditLog,
    externalIdentities: parts.collections.externalIdentities,
  };
}

/** Deep equality via stable JSON —used by the migration verification (§14). */
export function jsonEquals(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

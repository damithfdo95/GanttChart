/**
 * Centralized persistence integrity checker (V6.7 §8–§10).
 *
 * Pure, diagnostic-only structural validation of a canonical workspace:
 * duplicate/missing IDs, malformed records, broken project ownership and
 * manifest sanity. It NEVER mutates, repairs or fabricates data — issues are
 * reported and the recovery policy decides what happens (§9). Diagnostic
 * messages reference record IDs only, never raw user data (§10).
 *
 * Levels of use (§11):
 *   - every save: full check of the in-memory workspace (cheap, no database
 *     scan — the workspace is already assembled in memory) plus the
 *     prospective manifest; a `failed` result blocks the commit.
 *   - migration / recovery: the same check gates the migration marker.
 */

import type { ReportsState } from '../../../types';
import type { PersistenceManifest } from './manifest';
import type { DailyActualRow } from './workspace';
import { STORE_ATTENDANCE, STORE_DAILY_ACTUALS, STORE_METADATA, STORE_PROJECTS, STORE_REPORTS, STORE_TOPICS } from './repository';
export type IntegritySeverity = 'warning' | 'failure';

export type IntegrityCategory = 'projects' | 'reports' | 'dailyActuals' | 'attendance' | 'topics' | 'metadata' | 'identity';

export interface PersistenceIntegrityIssue {
  /** Stable machine code, e.g. "reports.orphan-project". */
  code: string;
  category: IntegrityCategory;
  severity: IntegritySeverity;
  /** Object store the record belongs to (diagnostics). */
  store: string;
  /** Record id when identifiable — never user content. */
  recordId?: string;
  /** Human-readable description without user data. */
  message: string;
}

export interface PersistenceIntegrityResult {
  status: 'verified' | 'warning' | 'failed';
  issues: PersistenceIntegrityIssue[];
  /** Revision from the manifest when one was supplied. */
  revision?: number;
}

const PROJECT_LIFECYCLE_STATUSES = new Set(['todo', 'ongoing', 'extended', 'onHold', 'done']);
const ATTENDANCE_STATUS_SET = new Set(['PRESENT', 'ABSENT', 'PAID_LEAVE', 'HALF_DAY', 'LATE', 'OTHER']);

function isMissingString(v: unknown): boolean {
  return typeof v !== 'string' || v === '';
}

function issue(
  issues: PersistenceIntegrityIssue[],
  code: string,
  category: IntegrityCategory,
  severity: IntegritySeverity,
  store: string,
  message: string,
  recordId?: string,
): void {
  issues.push(
    recordId === undefined
      ? { code, category, severity, store, message }
      : { code, category, severity, store, recordId, message },
  );
}

function aggregate(issues: PersistenceIntegrityIssue[]): 'verified' | 'warning' | 'failed' {
  if (issues.some((i) => i.severity === 'failure')) return 'failed';
  if (issues.length > 0) return 'warning';
  return 'verified';
}

function checkProjects(reports: ReportsState, issues: PersistenceIntegrityIssue[]): Set<string> {
  const recordIds = new Set<string>();
  const stableIds = new Set<string>();
  let activeSeen = false;
  for (const project of reports.projects) {
    if (typeof project !== 'object' || project === null) {
      issue(issues, 'projects.malformed-record', 'projects', 'failure', STORE_PROJECTS, 'A project record is not an object.');
      continue;
    }
    if (isMissingString(project.id)) {
      issue(issues, 'projects.malformed-record', 'projects', 'failure', STORE_PROJECTS, 'A project record is missing its record id.');
    } else if (recordIds.has(project.id)) {
      issue(issues, 'projects.duplicate-id', 'projects', 'failure', STORE_PROJECTS, `Duplicate project record id "${project.id}".`, project.id);
    } else {
      recordIds.add(project.id);
    }
    if (isMissingString(project.projectId)) {
      issue(issues, 'projects.malformed-record', 'projects', 'failure', STORE_PROJECTS, 'A project record is missing its stable project id.', project.id);
    } else if (stableIds.has(project.projectId)) {
      issue(issues, 'projects.duplicate-project-id', 'projects', 'failure', STORE_PROJECTS, `Duplicate stable project id "${project.projectId}".`, project.projectId);
    } else {
      stableIds.add(project.projectId);
    }
    if (isMissingString(project.nameEn) || isMissingString(project.nameJa)) {
      issue(issues, 'projects.malformed-record', 'projects', 'failure', STORE_PROJECTS, 'A project record is missing a bilingual name.', project.id);
    }
    if (!PROJECT_LIFECYCLE_STATUSES.has(project.status)) {
      issue(issues, 'projects.malformed-record', 'projects', 'failure', STORE_PROJECTS, 'A project record has an invalid lifecycle status.', project.id);
    }
    if (isMissingString(project.createdAt) || isMissingString(project.updatedAt)) {
      issue(issues, 'projects.malformed-record', 'projects', 'failure', STORE_PROJECTS, 'A project record is missing its timestamps.', project.id);
    }
    if (typeof project.inputs !== 'object' || project.inputs === null || !Array.isArray(project.inputs.planningRows)) {
      issue(issues, 'projects.malformed-record', 'projects', 'failure', STORE_PROJECTS, 'A project record has malformed planning inputs.', project.id);
    }
  }
  // Active project must reference an existing project record (existing fallbacks
  // tolerate it, so this is a warning, not a failure).
  if (reports.activeProjectId !== null) {
    for (const project of reports.projects) {
      if (project.id === reports.activeProjectId) {
        activeSeen = true;
        break;
      }
    }
    if (!activeSeen) {
      issue(issues, 'projects.active-missing', 'projects', 'warning', STORE_METADATA, 'The active project references a missing project record.', reports.activeProjectId);
    }
  }
  return stableIds;
}

function checkReports(reports: ReportsState, issues: PersistenceIntegrityIssue[], projectIds: Set<string>): void {
  const ids = new Set<string>();
  for (const report of reports.reports) {
    if (typeof report !== 'object' || report === null) {
      issue(issues, 'reports.malformed-record', 'reports', 'failure', STORE_REPORTS, 'A report record is not an object.');
      continue;
    }
    if (isMissingString(report.id)) {
      issue(issues, 'reports.malformed-record', 'reports', 'failure', STORE_REPORTS, 'A report record is missing its id.');
    } else if (ids.has(report.id)) {
      issue(issues, 'reports.duplicate-id', 'reports', 'failure', STORE_REPORTS, `Duplicate report id "${report.id}".`, report.id);
    } else {
      ids.add(report.id);
    }
    if (isMissingString(report.reportDate)) {
      issue(issues, 'reports.malformed-record', 'reports', 'failure', STORE_REPORTS, 'A report record is missing its date.', report.id);
    }
    if (!Array.isArray(report.activities)) {
      issue(issues, 'reports.malformed-record', 'reports', 'failure', STORE_REPORTS, 'A report record has malformed activities.', report.id);
    }
    if (report.projectId !== null && report.projectId !== undefined && !projectIds.has(report.projectId)) {
      // Orphaned evidence is preserved, never deleted or re-attached (§26).
      issue(issues, 'reports.orphan-project', 'reports', 'warning', STORE_REPORTS, 'A report references a project that does not exist.', report.id);
    }
  }
}

function checkDailyActuals(
  reports: ReportsState,
  issues: PersistenceIntegrityIssue[],
  projectIds: Set<string>,
  rows?: DailyActualRow[],
): void {
  for (const project of reports.projects) {
    const snapshots = project.inputs?.dailyActuals ?? [];
    const snapshotIds = new Set<string>();
    for (const snapshot of snapshots) {
      if (typeof snapshot !== 'object' || snapshot === null) {
        issue(issues, 'dailyActuals.malformed-record', 'dailyActuals', 'failure', STORE_DAILY_ACTUALS, 'A snapshot record is not an object.', project.projectId);
        continue;
      }
      if (isMissingString(snapshot.id)) {
        issue(issues, 'dailyActuals.malformed-record', 'dailyActuals', 'failure', STORE_DAILY_ACTUALS, 'A snapshot record is missing its id.', project.projectId);
      } else if (snapshotIds.has(snapshot.id)) {
        issue(issues, 'dailyActuals.duplicate-id-in-project', 'dailyActuals', 'failure', STORE_DAILY_ACTUALS, `Duplicate snapshot id "${snapshot.id}" within project "${project.projectId}".`, snapshot.id);
      } else {
        snapshotIds.add(snapshot.id);
      }
      if (isMissingString(snapshot.date) || typeof snapshot.executed !== 'number' || typeof snapshot.passed !== 'number') {
        issue(issues, 'dailyActuals.malformed-record', 'dailyActuals', 'failure', STORE_DAILY_ACTUALS, 'A snapshot record is missing its date or totals.', snapshot.id);
      }
    }
  }
  // Store-level snapshot rows: orphans reference a project that does not exist.
  // Orphaned evidence is preserved, never deleted or re-attached (§26).
  if (rows !== undefined) {
    const rowKeys = new Set<string>();
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) {
        issue(issues, 'dailyActuals.malformed-record', 'dailyActuals', 'failure', STORE_DAILY_ACTUALS, 'A snapshot row is not an object.');
        continue;
      }
      if (isMissingString(row.id) || isMissingString(row.projectId)) {
        issue(issues, 'dailyActuals.malformed-record', 'dailyActuals', 'failure', STORE_DAILY_ACTUALS, 'A snapshot row is missing its id or project reference.', row.id);
        continue;
      }
      const key = `${row.projectId}::${row.id}`;
      if (rowKeys.has(key)) {
        issue(issues, 'dailyActuals.duplicate-id-in-project', 'dailyActuals', 'failure', STORE_DAILY_ACTUALS, `Duplicate snapshot row "${key}".`, row.id);
      } else {
        rowKeys.add(key);
      }
      if (!projectIds.has(row.projectId)) {
        issue(issues, 'dailyActuals.orphan-project', 'dailyActuals', 'warning', STORE_DAILY_ACTUALS, 'A snapshot references a project that does not exist.', row.id);
      }
    }
  }
}

function checkAttendance(reports: ReportsState, issues: PersistenceIntegrityIssue[]): void {
  const ids = new Set<string>();
  for (const record of reports.attendance) {
    if (typeof record !== 'object' || record === null) {
      issue(issues, 'attendance.malformed-record', 'attendance', 'failure', STORE_ATTENDANCE, 'An attendance record is not an object.');
      continue;
    }
    if (isMissingString(record.id)) {
      issue(issues, 'attendance.malformed-record', 'attendance', 'failure', STORE_ATTENDANCE, 'An attendance record is missing its id.');
    } else if (ids.has(record.id)) {
      issue(issues, 'attendance.duplicate-id', 'attendance', 'failure', STORE_ATTENDANCE, `Duplicate attendance id "${record.id}".`, record.id);
    } else {
      ids.add(record.id);
    }
    if (isMissingString(record.date) || isMissingString(record.memberName) || !ATTENDANCE_STATUS_SET.has(record.status)) {
      issue(issues, 'attendance.malformed-record', 'attendance', 'failure', STORE_ATTENDANCE, 'An attendance record is missing required fields.', record.id);
    }
  }
}

function checkTopics(reports: ReportsState, issues: PersistenceIntegrityIssue[]): void {
  const ids = new Set<string>();
  for (const topic of reports.topics) {
    if (typeof topic !== 'object' || topic === null) {
      issue(issues, 'topics.malformed-record', 'topics', 'failure', STORE_TOPICS, 'A topic record is not an object.');
      continue;
    }
    if (isMissingString(topic.id)) {
      issue(issues, 'topics.malformed-record', 'topics', 'failure', STORE_TOPICS, 'A topic record is missing its id.');
    } else if (ids.has(topic.id)) {
      issue(issues, 'topics.duplicate-id', 'topics', 'failure', STORE_TOPICS, `Duplicate topic id "${topic.id}".`, topic.id);
    } else {
      ids.add(topic.id);
    }
    if (isMissingString(topic.reportDate) || isMissingString(topic.title)) {
      issue(issues, 'topics.malformed-record', 'topics', 'failure', STORE_TOPICS, 'A topic record is missing required fields.', topic.id);
    }
  }
}

function checkIdentity(reports: ReportsState, issues: PersistenceIntegrityIssue[], projectIds: Set<string>): void {
  const memberIds = new Set<string>();
  for (const member of reports.rcsMembers ?? []) {
    if (typeof member !== 'object' || member === null) continue;
    if (isMissingString(member.id)) {
      issue(issues, 'identity.malformed-record', 'identity', 'failure', STORE_METADATA, 'A member record is missing its id.');
    } else if (memberIds.has(member.id)) {
      issue(issues, 'identity.duplicate-member-id', 'identity', 'failure', STORE_METADATA, `Duplicate member id "${member.id}".`, member.id);
    } else {
      memberIds.add(member.id);
    }
  }
  const assignmentIds = new Set<string>();
  for (const assignment of reports.testerAssignments ?? []) {
    if (typeof assignment !== 'object' || assignment === null) continue;
    if (isMissingString(assignment.id)) {
      issue(issues, 'identity.malformed-record', 'identity', 'failure', STORE_METADATA, 'An assignment record is missing its id.');
    } else if (assignmentIds.has(assignment.id)) {
      issue(issues, 'identity.duplicate-id', 'identity', 'failure', STORE_METADATA, `Duplicate assignment id "${assignment.id}".`, assignment.id);
    } else {
      assignmentIds.add(assignment.id);
    }
    if (assignment.projectId !== undefined && !projectIds.has(assignment.projectId)) {
      issue(issues, 'identity.assignment-orphan-project', 'identity', 'warning', STORE_METADATA, 'An assignment references a project that does not exist.', assignment.id);
    }
  }
  const reviewIds = new Set<string>();
  for (const review of reports.reviews ?? []) {
    if (typeof review !== 'object' || review === null) continue;
    if (isMissingString(review.id)) {
      issue(issues, 'identity.malformed-record', 'identity', 'failure', STORE_METADATA, 'A review record is missing its id.');
    } else if (reviewIds.has(review.id)) {
      issue(issues, 'identity.duplicate-id', 'identity', 'failure', STORE_METADATA, `Duplicate review id "${review.id}".`, review.id);
    } else {
      reviewIds.add(review.id);
    }
  }
  const externalIds = new Set<string>();
  for (const identity of reports.externalIdentities ?? []) {
    if (typeof identity !== 'object' || identity === null) continue;
    if (isMissingString(identity.id)) {
      issue(issues, 'identity.malformed-record', 'identity', 'failure', STORE_METADATA, 'An external-identity record is missing its id.');
    } else if (externalIds.has(identity.id)) {
      issue(issues, 'identity.duplicate-id', 'identity', 'failure', STORE_METADATA, `Duplicate external-identity id "${identity.id}".`, identity.id);
    } else {
      externalIds.add(identity.id);
    }
    if (identity.memberId !== undefined && memberIds.size > 0 && !memberIds.has(identity.memberId)) {
      // Broken references are reported, never repaired or inferred (§9/§25).
      issue(issues, 'identity.external-identity-broken-member', 'identity', 'warning', STORE_METADATA, 'An external identity references a member that does not exist.', identity.id);
    }
  }
}

function checkManifest(manifest: PersistenceManifest | null | undefined, issues: PersistenceIntegrityIssue[]): void {
  if (manifest === null || manifest === undefined) return; // absent manifest is not an integrity failure
  if (!Number.isInteger(manifest.revision) || manifest.revision < 1) {
    issue(issues, 'metadata.invalid-revision', 'metadata', 'failure', STORE_METADATA, 'The persistence manifest has an invalid revision.', String(manifest.revision));
  }
  if (manifest.schemaVersion < 1) {
    issue(issues, 'metadata.invalid-schema-version', 'metadata', 'failure', STORE_METADATA, 'The persistence manifest has an invalid schema version.', String(manifest.schemaVersion));
  }
  if (manifest.backend !== 'indexeddb' && manifest.backend !== 'localStorage') {
    issue(issues, 'metadata.malformed-manifest', 'metadata', 'failure', STORE_METADATA, 'The persistence manifest has an invalid backend.');
  }
  if (isMissingString(manifest.committedAt)) {
    issue(issues, 'metadata.malformed-manifest', 'metadata', 'failure', STORE_METADATA, 'The persistence manifest is missing its commit timestamp.');
  }
  if (manifest.integrityStatus === 'failed') {
    issue(issues, 'metadata.manifest-impossible', 'metadata', 'failure', STORE_METADATA, 'The persistence manifest claims a failed-integrity commit.');
  }
}

/**
 * Verify the structural integrity of a canonical workspace. Pure: the
 * input is never modified (deep-compare safe). The manifest, when supplied,
 * is validated together with the workspace so a commit can be rejected
 * before it happens (§11). Store-level dailyActual rows (from the split)
 * may be supplied for orphan detection that the domain model cannot see.
 */
export function verifyWorkspaceIntegrity(
  reports: ReportsState,
  manifest?: PersistenceManifest | null,
  dailyActualRows?: DailyActualRow[],
): PersistenceIntegrityResult {
  const issues: PersistenceIntegrityIssue[] = [];
  const projectIds = checkProjects(reports, issues);
  checkReports(reports, issues, projectIds);
  checkDailyActuals(reports, issues, projectIds, dailyActualRows);
  checkAttendance(reports, issues);
  checkTopics(reports, issues);
  checkIdentity(reports, issues, projectIds);
  checkManifest(manifest, issues);
  const result: PersistenceIntegrityResult = { status: aggregate(issues), issues };
  if (manifest !== undefined && manifest !== null) result.revision = manifest.revision;
  return result;
}

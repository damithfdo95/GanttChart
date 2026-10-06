/**
 * Revision journal record types (V6.8).
 *
 * Every successful canonical workspace commit receives exactly one durable
 * journal entry in the `revisionHistory` object store. The entry captures
 * WHEN the revision was committed, WHY (a controlled reason union), WHICH
 * projects were affected, WHAT changed (a compact deterministic domain
 * summary produced by the diff layer — never a UI event log) and a full
 * verbatim workspace snapshot for point-in-time reconstruction.
 *
 * Concept separation (V6.8 §16):
 *   - V6.7 recovery snapshots (localStorage) — emergency artifacts taken at
 *     destructive lifecycle events. NOT touched here.
 *   - V6.8 revision history (IndexedDB) — normal committed history. This module.
 *
 * The manifest remains the single authoritative revision counter (V6.8 §7):
 * a journal entry's `revision` always equals the manifest revision it was
 * committed with, in the same IndexedDB transaction.
 */

import type { AppState, ReportsState } from '../../../types';

/** Journal record format version (independent of the IndexedDB schema version). */
export const JOURNAL_SCHEMA_VERSION = 1;

/** Controlled commit reasons — persisted as-is, never free-form strings. */
export type RevisionReason =
  | 'initial'
  | 'edit'
  | 'project-created'
  | 'project-deleted'
  | 'report-created'
  | 'report-updated'
  | 'report-deleted'
  | 'attendance-updated'
  | 'topic-updated'
  | 'identity-updated'
  | 'import'
  | 'recovery'
  | 'migration'
  | 'clear-all'
  | 'system';

export const REVISION_REASONS: readonly RevisionReason[] = [
  'initial',
  'edit',
  'project-created',
  'project-deleted',
  'report-created',
  'report-updated',
  'report-deleted',
  'attendance-updated',
  'topic-updated',
  'identity-updated',
  'import',
  'recovery',
  'migration',
  'clear-all',
  'system',
];

/**
 * Compact, deterministic description of what changed between two canonical
 * workspaces (V6.8 §8). Projects are identified by their stable Project IDs;
 * reports/attendance/topics by record ids. Empty lists/flags are omitted on
 * the wire by buildRevisionEntry to keep entries small.
 */
export interface RevisionChangeSummary {
  projectsCreated: string[];
  projectsUpdated: string[];
  projectsDeleted: string[];
  reportsCreated: string[];
  reportsUpdated: string[];
  reportsDeleted: string[];
  /** Daily-actual snapshot rows added/changed/removed (per project inputs). */
  snapshotsChanged: boolean;
  attendanceChanged: boolean;
  topicsChanged: boolean;
  /** RCS members, member-name history, identity audit log, external identities. */
  identityChanged: boolean;
  testerAssignmentsChanged: boolean;
  reviewsChanged: boolean;
  /** Active-project execution counts changed (V6.4 granular fields included). */
  executionChanged: boolean;
  /** Planning/staffing/schedule inputs changed. */
  planningChanged: boolean;
  /** Report settings or other AppState metadata changed. */
  settingsChanged: boolean;
}

/** The full verbatim workspace committed at this revision (reconstruction source). */
export interface RevisionSnapshot {
  appState: AppState;
  reportsState: ReportsState;
}

/** One durable journal entry (V6.8 §4). */
export interface WorkspaceRevision {
  revision: number;
  committedAt: string;
  reason: RevisionReason;
  /** Stable Project IDs ("PRJ-001") touched by this revision. */
  affectedProjectIds: string[];
  /** Present only on reason='recovery': the revision whose state was restored. */
  restoredFromRevision?: number;
  /** Null for anchor entries (initial/migration) that have no previous state to diff. */
  changeSummary: RevisionChangeSummary | null;
  integrityStatus: 'verified' | 'warning';
  snapshot: RevisionSnapshot;
}

/** Metadata view of a journal entry for listings — never carries the snapshot payload. */
export type WorkspaceRevisionMeta = Omit<WorkspaceRevision, 'snapshot'>;

function isRevisionReason(v: unknown): v is RevisionReason {
  return typeof v === 'string' && (REVISION_REASONS as readonly string[]).includes(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((entry) => typeof entry === 'string' && entry !== '');
}

function isChangeSummary(v: unknown): v is RevisionChangeSummary {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    isStringArray(s.projectsCreated) &&
    isStringArray(s.projectsUpdated) &&
    isStringArray(s.projectsDeleted) &&
    isStringArray(s.reportsCreated) &&
    isStringArray(s.reportsUpdated) &&
    isStringArray(s.reportsDeleted) &&
    typeof s.snapshotsChanged === 'boolean' &&
    typeof s.attendanceChanged === 'boolean' &&
    typeof s.topicsChanged === 'boolean' &&
    typeof s.identityChanged === 'boolean' &&
    typeof s.testerAssignmentsChanged === 'boolean' &&
    typeof s.reviewsChanged === 'boolean' &&
    typeof s.executionChanged === 'boolean' &&
    typeof s.planningChanged === 'boolean' &&
    typeof s.settingsChanged === 'boolean'
  );
}

/**
 * Strictly validate a raw journal record (V6.8 §19). Structural validation of
 * the embedded snapshot states is done by the reconstruction path with the
 * existing isAppState/isReportsState guards — here we verify the journal
 * envelope only, so a structurally damaged entry is reported instead of
 * silently repaired.
 */
export function parseRevisionEntry(raw: unknown): WorkspaceRevision | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== JOURNAL_SCHEMA_VERSION) return null;
  if (typeof r.revision !== 'number' || !Number.isInteger(r.revision) || r.revision < 1) return null;
  if (typeof r.committedAt !== 'string' || r.committedAt === '') return null;
  if (!isRevisionReason(r.reason)) return null;
  if (!isStringArray(r.affectedProjectIds)) return null;
  if (r.changeSummary !== null && r.changeSummary !== undefined && !isChangeSummary(r.changeSummary)) return null;
  if (r.integrityStatus !== 'verified' && r.integrityStatus !== 'warning') return null;
  const snapshot = r.snapshot;
  if (typeof snapshot !== 'object' || snapshot === null) return null;
  const s = snapshot as Record<string, unknown>;
  if (typeof s.appState !== 'object' || s.appState === null) return null;
  if (typeof s.reportsState !== 'object' || s.reportsState === null) return null;
  if (r.restoredFromRevision !== undefined) {
    if (typeof r.restoredFromRevision !== 'number' || !Number.isInteger(r.restoredFromRevision) || r.restoredFromRevision < 1) {
      return null;
    }
  }
  return {
    revision: r.revision,
    committedAt: r.committedAt,
    reason: r.reason,
    affectedProjectIds: r.affectedProjectIds,
    ...(r.restoredFromRevision === undefined ? {} : { restoredFromRevision: r.restoredFromRevision }),
    changeSummary: r.changeSummary ?? null,
    integrityStatus: r.integrityStatus,
    snapshot: s as unknown as RevisionSnapshot,
  };
}

/** Strip the snapshot payload for listings/preview (V6.8 §37). */
export function toRevisionMeta(entry: WorkspaceRevision): WorkspaceRevisionMeta {
  const { snapshot: _snapshot, ...meta } = entry;
  return meta;
}

/**
 * Build the durable journal record for a commit. Omitted-empty summary fields
 * are stored as empty values (kept uniform for deterministic parsing); the
 * entry is frozen data — callers never mutate it afterwards.
 */
export function buildRevisionEntry(input: {
  revision: number;
  committedAt: string;
  reason: RevisionReason;
  affectedProjectIds: string[];
  changeSummary: RevisionChangeSummary | null;
  integrityStatus: 'verified' | 'warning';
  snapshot: RevisionSnapshot;
  restoredFromRevision?: number;
}): WorkspaceRevision & { schemaVersion: number } {
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    revision: input.revision,
    committedAt: input.committedAt,
    reason: input.reason,
    affectedProjectIds: input.affectedProjectIds,
    ...(input.restoredFromRevision === undefined ? {} : { restoredFromRevision: input.restoredFromRevision }),
    changeSummary: input.changeSummary,
    integrityStatus: input.integrityStatus,
    snapshot: input.snapshot,
  };
}

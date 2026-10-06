/**
 * Persistence manifest (V6.7 §3).
 *
 * Small persistent record describing the committed workspace: revision,
 * commit time, backend, integrity status and migration/recovery bookkeeping.
 * It lives in the existing `metadata.persistenceMeta` slot (V6.6) and is
 * written in the SAME IndexedDB transaction as the workspace records, so
 * revision and state can never disagree after a successful commit (§4).
 *
 * Concept separation:
 *   - IndexedDB schema version (GanttChartDB v1) — object-store layout.
 *   - Application data schema versions — localStorage key versions, reports
 *     schemaVersion, backup `version`.
 *   - Workspace revision (this manifest) — monotonic commit ordering.
 *   - `schemaVersion` here is the MANIFEST format version, nothing else.
 */

export const PERSISTENCE_SCHEMA_VERSION = 1;

export type IntegrityStatus = 'verified' | 'warning' | 'failed';

export interface PersistenceManifest {
  /** Manifest format version (PERSISTENCE_SCHEMA_VERSION). */
  schemaVersion: number;
  /** Monotonic workspace revision; >= 1 on every committed manifest. */
  revision: number;
  /** ISO timestamp of the commit this manifest describes. */
  committedAt: string;
  /** Epoch ms of the last successful save (V6.6 UX metadata, kept). */
  lastSavedAt: number | null;
  /** Backend that committed this revision. */
  backend: 'indexeddb' | 'localStorage';
  /** Structural integrity status of the committed workspace. */
  integrityStatus: IntegrityStatus;
  lastMigrationAt?: string;
  lastRecoveryAt?: string;
}

function isIntegrityStatus(v: unknown): v is IntegrityStatus {
  return v === 'verified' || v === 'warning' || v === 'failed';
}

/**
 * Strictly validate a raw manifest record. Legacy V6.6 `persistenceMeta`
 * payloads ({ lastSavedAt }) have no revision and parse to null — callers
 * treat that as "no manifest yet" and start revision counting at 0, never
 * resetting an existing valid revision (§12).
 */
export function parseManifest(raw: unknown): PersistenceManifest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== PERSISTENCE_SCHEMA_VERSION) return null;
  if (typeof r.revision !== 'number' || !Number.isInteger(r.revision) || r.revision < 1) return null;
  if (typeof r.committedAt !== 'string' || r.committedAt === '') return null;
  if (r.backend !== 'indexeddb' && r.backend !== 'localStorage') return null;
  if (!isIntegrityStatus(r.integrityStatus)) return null;
  const lastSavedAt = r.lastSavedAt;
  if (lastSavedAt !== undefined && lastSavedAt !== null && typeof lastSavedAt !== 'number') return null;
  const lastMigrationAt = r.lastMigrationAt;
  if (lastMigrationAt !== undefined && typeof lastMigrationAt !== 'string') return null;
  const lastRecoveryAt = r.lastRecoveryAt;
  if (lastRecoveryAt !== undefined && typeof lastRecoveryAt !== 'string') return null;
  return {
    schemaVersion: PERSISTENCE_SCHEMA_VERSION,
    revision: r.revision,
    committedAt: r.committedAt,
    lastSavedAt: typeof lastSavedAt === 'number' ? lastSavedAt : null,
    backend: r.backend,
    integrityStatus: r.integrityStatus,
    ...(lastMigrationAt === undefined ? {} : { lastMigrationAt }),
    ...(lastRecoveryAt === undefined ? {} : { lastRecoveryAt }),
  };
}

/** Build a manifest for a new commit (V6.7 §2/§3). */
export function buildManifest(input: {
  revision: number;
  backend: 'indexeddb' | 'localStorage';
  integrityStatus: IntegrityStatus;
  committedAt: string;
  lastSavedAt: number | null;
  lastMigrationAt?: string;
  lastRecoveryAt?: string;
}): PersistenceManifest {
  return {
    schemaVersion: PERSISTENCE_SCHEMA_VERSION,
    revision: input.revision,
    committedAt: input.committedAt,
    lastSavedAt: input.lastSavedAt,
    backend: input.backend,
    integrityStatus: input.integrityStatus,
    ...(input.lastMigrationAt === undefined ? {} : { lastMigrationAt: input.lastMigrationAt }),
    ...(input.lastRecoveryAt === undefined ? {} : { lastRecoveryAt: input.lastRecoveryAt }),
  };
}

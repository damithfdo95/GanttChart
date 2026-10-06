/**
 * Storage-mode migration, Local <-> Web.
 *
 * Pure orchestration over injected dependencies, so every failure path is
 * testable. The invariants the whole file exists to keep:
 *
 *  - The source of truth only changes AFTER the destination has been written
 *    AND read back and verified. Until then, the source stays authoritative and
 *    usable.
 *  - Nothing is overwritten silently: replacing existing cloud data needs an
 *    explicit choice and the typed confirmation (the server checks it too).
 *  - A backup file of the local workspace is produced before anything leaves
 *    the device.
 *  - Retry-safe: the migration id is derived from the content and the inspected
 *    revision, so repeating a half-finished migration changes nothing twice.
 *  - Leaving the cloud keeps the cloud copy (archived); it is never deleted.
 */

import type { AppState, ReportsState } from '../../types';
import type { RecordPut } from '../../../shared/protocol';
import {
  REPLACE_CONFIRMATION,
  SWITCH_TO_LOCAL_CONFIRMATION,
  canonicalRecordsHash,
  summarizeRecords,
  validateImportRecords,
} from '../../../shared/tenancy';
import { normalizeQaInputsForLoad } from '../storage/storage';
import { reportsFromRecords, reportsToRecords } from '../sync/records';
import { ApiError, type ExportAll, type ServerState, type TenancyApi } from './api';

export interface LocalWorkspace {
  app: AppState;
  reports: ReportsState;
}

/** What the migration needs from the app; every one is faked in tests. */
export interface MigrationDeps {
  api: TenancyApi;
  /** Produce the backup file of the LOCAL workspace. Must throw if it cannot. */
  downloadBackup(workspace: LocalWorkspace): void | Promise<void>;
  /** Persist a workspace into this device's local database. */
  saveLocal(workspace: LocalWorkspace): Promise<void>;
  /** Read the local database back (for verification). */
  loadLocal(): Promise<LocalWorkspace | null>;
  /** After a successful Local -> Web: mark this device as linked, with the verified server copy as its baseline. */
  adoptWebDevice(baseline: { revision: number; records: RecordPut[] }): void;
  /** After Web -> Local: forget the link and the sync baseline of this device. */
  unlinkDevice(): void;
}

// ---- Local -> Web -----------------------------------------------------------------

export interface LocalToWebPlan {
  local: { records: RecordPut[]; hash: string; counts: Record<string, number> };
  server: ServerState;
  /** The cloud already holds exactly this workspace (an earlier attempt got that far). */
  alreadyUploaded: boolean;
  /** The cloud holds DIFFERENT data: going on would replace it, which needs an explicit choice. */
  needsReplace: boolean;
}

export type PlanResult = { ok: true; plan: LocalToWebPlan } | { ok: false; error: 'invalid_local_data' | 'server_unreachable'; message?: string };

/** Inspect both sides. Changes nothing. */
export async function planLocalToWeb(local: LocalWorkspace, api: TenancyApi): Promise<PlanResult> {
  const records = [...reportsToRecords(local.reports).values()];
  const valid = validateImportRecords(records);
  if (!valid.ok) return { ok: false, error: 'invalid_local_data', message: valid.error };
  let inspected: Awaited<ReturnType<TenancyApi['inspect']>>;
  try {
    inspected = await api.inspect();
  } catch (e) {
    return { ok: false, error: 'server_unreachable', message: e instanceof ApiError ? e.code : undefined };
  }
  const hash = await canonicalRecordsHash(records);
  const alreadyUploaded = inspected.server.hash === hash;
  return {
    ok: true,
    plan: {
      local: { records, hash, counts: summarizeRecords(records) },
      server: inspected.server,
      alreadyUploaded,
      needsReplace: inspected.server.hasData && !alreadyUploaded,
    },
  };
}

export type MigrationStep = 'backup' | 'confirm' | 'upload' | 'verify' | 'activate' | 'save' | 'switch';

export type MigrationFailure = {
  ok: false;
  step: MigrationStep;
  error: string;
  /** True when the SOURCE of truth is untouched and still usable (always, by construction). */
  sourceIntact: true;
};

export type LocalToWebResult = { ok: true; revision: number; hash: string; counts: Record<string, number> } | MigrationFailure;

const failure = (step: MigrationStep, error: string): MigrationFailure => ({ ok: false, step, error, sourceIntact: true });

export interface LocalToWebOptions {
  /** The person chose to REPLACE existing cloud data with this device's data. */
  replace?: boolean;
  /** What they typed to confirm that choice. */
  typed?: string;
}

/**
 * Upload, verify, then (and only then) switch. If anything fails, the workspace
 * stays local and untouched; running it again is safe.
 */
export async function runLocalToWeb(local: LocalWorkspace, plan: LocalToWebPlan, options: LocalToWebOptions, deps: MigrationDeps): Promise<LocalToWebResult> {
  // 0. Never replace existing cloud data without the deliberate, typed choice.
  const replacing = plan.needsReplace;
  if (replacing && (options.replace !== true || options.typed !== REPLACE_CONFIRMATION)) return failure('confirm', 'replace_not_confirmed');

  // 1. A backup file must exist before anything leaves this device.
  try {
    await deps.downloadBackup(local);
  } catch {
    return failure('backup', 'backup_failed');
  }

  // 2. Atomic upload as ONE revision. The id makes a retry a no-op.
  const migrationId = `mig-${plan.local.hash.slice(0, 24)}-${plan.server.revision}`;
  let uploaded: Awaited<ReturnType<TenancyApi['upload']>>;
  try {
    uploaded = await deps.api.upload({
      migrationId,
      expectedRevision: plan.server.revision,
      records: plan.local.records,
      ...(replacing ? { replace: true, confirm: options.typed } : {}),
    });
  } catch (e) {
    return failure('upload', e instanceof ApiError ? e.code : 'upload_failed');
  }

  // 3. Verify independently, twice: the hash the server reports for what it stored, and a FRESH read of the
  //    server's state (inspect works while the workspace is still local, unlike a data export).
  if (uploaded.hash !== plan.local.hash) return failure('verify', 'hash_mismatch');
  try {
    const after = await deps.api.inspect();
    if (after.server.hash !== plan.local.hash || after.server.revision !== uploaded.revision) return failure('verify', 'read_back_mismatch');
  } catch {
    return failure('verify', 'read_back_failed');
  }

  // 4. Switch the authority — the server re-checks the same hash itself.
  try {
    await deps.api.activateWeb(uploaded.revision, uploaded.hash);
  } catch (e) {
    return failure('activate', e instanceof ApiError ? e.code : 'activate_failed');
  }

  // 5. Only now does this device become a web device, with the verified copy as its baseline.
  deps.adoptWebDevice({ revision: uploaded.revision, records: plan.local.records });
  return { ok: true, revision: uploaded.revision, hash: uploaded.hash, counts: uploaded.counts };
}

// ---- Web -> Local -----------------------------------------------------------------

export interface PreparedWebToLocal {
  revision: number;
  hash: string;
  counts: Record<string, number>;
}

export type PrepareResult = { ok: true; prepared: PreparedWebToLocal } | { ok: false; step: MigrationStep; error: string };

/** The app's editing surface for the active project of a reports state. */
export function appForActiveProject(app: AppState, reports: ReportsState): AppState {
  const project = reports.projects.find((p) => p.id === reports.activeProjectId) ?? reports.projects[0];
  if (project === undefined) return app;
  return {
    ...normalizeQaInputsForLoad(project.inputs),
    language: app.language,
    projectNameEn: project.nameEn,
    projectNameJa: project.nameJa,
    dashboardView: app.dashboardView,
  };
}

/**
 * Download the complete cloud snapshot, validate it, save it locally and READ IT
 * BACK. Changes nothing in the cloud. The result is what the final switch will
 * be verified against.
 */
export async function prepareWebToLocal(current: LocalWorkspace, deps: MigrationDeps): Promise<PrepareResult> {
  let snapshot: ExportAll;
  try {
    snapshot = await deps.api.exportAll();
  } catch (e) {
    return { ok: false, step: 'verify', error: e instanceof ApiError ? e.code : 'download_failed' };
  }
  // The transfer itself must be intact.
  if ((await canonicalRecordsHash(snapshot.records)) !== snapshot.hash) return { ok: false, step: 'verify', error: 'snapshot_corrupt' };
  const valid = validateImportRecords(snapshot.records);
  if (!valid.ok) return { ok: false, step: 'verify', error: 'snapshot_invalid' };

  const reports = reportsFromRecords(snapshot.records, current.reports);
  const workspace: LocalWorkspace = { app: appForActiveProject(current.app, reports), reports };
  try {
    await deps.saveLocal(workspace);
  } catch {
    return { ok: false, step: 'save', error: 'local_save_failed' };
  }

  // Read it back from the local database: nothing may have been dropped on the way.
  const loaded = await deps.loadLocal().catch(() => null);
  if (loaded === null) return { ok: false, step: 'save', error: 'local_read_back_failed' };
  const want = ids(snapshot.records);
  const got = ids([...reportsToRecords(loaded.reports).values()]);
  if (want.length !== got.length || want.some((k, i) => k !== got[i])) return { ok: false, step: 'save', error: 'local_copy_incomplete' };

  return { ok: true, prepared: { revision: snapshot.revision, hash: snapshot.hash, counts: summarizeRecords(snapshot.records) } };
}

const ids = (records: ReadonlyArray<Pick<RecordPut, 'kind' | 'id'>>): string[] => records.map((r) => `${r.kind}\u0000${r.id}`).sort();

export type SwitchResult = { ok: true } | MigrationFailure;

/**
 * The deliberate last step: only with the typed confirmation, and only if the
 * cloud still holds exactly what was downloaded. The cloud copy is KEPT.
 */
export async function completeWebToLocal(prepared: PreparedWebToLocal, typed: string, deps: MigrationDeps): Promise<SwitchResult> {
  if (typed !== SWITCH_TO_LOCAL_CONFIRMATION) return failure('confirm', 'not_confirmed');
  try {
    await deps.api.deactivateWeb(prepared.revision, prepared.hash, typed);
  } catch (e) {
    return failure('switch', e instanceof ApiError ? e.code : 'switch_failed');
  }
  deps.unlinkDevice();
  return { ok: true };
}

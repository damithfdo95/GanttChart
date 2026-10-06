/**
 * Revision journal query & reconstruction API (V6.8 §13, §15, §19, §36).
 *
 * Pure IndexedDB access layer for the `revisionHistory` store: targeted
 * queries (never full scans during normal React rendering), strict parsing,
 * point-in-time reconstruction from the stored verbatim snapshot, journal
 * integrity verification and retention pruning.
 *
 * The internal API is intentionally shaped so a future external
 * synchronization adapter could ask "give me the changes after revision N"
 * (getRevisionsAfter) — no such adapter exists in V6.8 (§36).
 *
 * Reconstruction stores FULL workspace snapshots per retained revision
 * (confirmed design): restoration is exact (legacy unknown fields stay
 * unknown, nothing is recomputed), atomicity is trivial, and growth is
 * bounded by the retention cap. History is append-only; restoring an older
 * revision NEVER rewrites or deletes newer entries (§13/§14).
 */

import type { AppState, ReportsState } from '../../../types';
import { isAppState } from '../storage';
import { isReportsState } from '../reports';
import { STORE_REVISION_HISTORY, getAllFromStore, getFromStore, withReadWriteTx } from './repository';
import {
  JOURNAL_SCHEMA_VERSION,
  buildRevisionEntry,
  parseRevisionEntry,
  toRevisionMeta,
  type WorkspaceRevision,
  type WorkspaceRevisionMeta,
} from './journal';
import type { CanonicalWorkspace } from './diff';
import { verifyWorkspaceIntegrity } from './integrity';

/** Default retention: the latest 100 revisions are kept (confirmed design). */
export const REVISION_HISTORY_RETENTION = 100;

/** Read + parse every journal entry, ascending by revision. Invalid entries are skipped (evidence preserved). */
async function readAllRevisions(): Promise<WorkspaceRevision[]> {
  const raw = await getAllFromStore<unknown>(STORE_REVISION_HISTORY);
  const entries: WorkspaceRevision[] = [];
  for (const record of raw) {
    const parsed = parseRevisionEntry(record);
    if (parsed !== null) entries.push(parsed);
  }
  return entries.sort((a, b) => a.revision - b.revision);
}

/**
 * List journal entries (metadata only — snapshots are never loaded into
 * application state by a listing, §37), newest first, at most `limit`.
 */
export async function getRevisionHistory(limit?: number): Promise<WorkspaceRevisionMeta[]> {
  const entries = await readAllRevisions();
  const metas = entries.map(toRevisionMeta).reverse();
  return limit === undefined ? metas : metas.slice(0, limit);
}

/** One full journal entry by revision (null when absent or structurally invalid). */
export async function getRevision(revision: number): Promise<WorkspaceRevision | null> {
  const raw = await getFromStore<unknown>(STORE_REVISION_HISTORY, revision);
  return parseRevisionEntry(raw);
}

/** All committed revisions AFTER `revision`, ascending (future external-sync boundary, §36). */
export async function getRevisionsAfter(revision: number): Promise<WorkspaceRevision[]> {
  const entries = await readAllRevisions();
  return entries.filter((entry) => entry.revision > revision);
}

/** Latest committed journal revision (0 when the journal is empty/unreadable). */
export async function getLatestRevision(): Promise<number> {
  const entries = await readAllRevisions();
  return entries.length > 0 ? entries[entries.length - 1].revision : 0;
}

/** Count of valid journal entries. */
export async function countRevisions(): Promise<number> {
  const entries = await readAllRevisions();
  return entries.length;
}

/** Result of reconstructing a historical revision. */
export type ReconstructionResult =
  | { ok: true; app: AppState; reports: ReportsState; entry: WorkspaceRevision }
  | { ok: false; error: 'not-found' | 'pruned' | 'invalid' | 'unavailable' };

/**
 * Reconstruct the canonical workspace exactly as committed at `revision`
 * (V6.8 §13/§15). The stored snapshot is validated with the existing
 * isAppState/isReportsState guards and the shared integrity checker, but it
 * is NEVER recomputed or normalized — legacy unknown values remain unknown
 * (§33) and granular execution data survives verbatim (§34). No mutation of
 * anything happens here: reconstruction is a pure read (§28).
 */
export async function reconstructRevision(revision: number): Promise<ReconstructionResult> {
  const entry = await getRevision(revision).catch(() => null);
  if (entry === null) {
    // Distinguish "pruned by retention" (revision below the journal head)
    // from "never existed" (above the head).
    const latest = await getLatestRevision().catch(() => 0);
    if (revision > 0 && revision < latest) return { ok: false, error: 'pruned' };
    return { ok: false, error: 'not-found' };
  }
  if (!isAppState(entry.snapshot.appState) || !isReportsState(entry.snapshot.reportsState)) {
    return { ok: false, error: 'invalid' };
  }
  const integrity = verifyWorkspaceIntegrity(entry.snapshot.reportsState, null);
  if (integrity.status === 'failed') {
    return { ok: false, error: 'invalid' };
  }
  return { ok: true, app: entry.snapshot.appState, reports: entry.snapshot.reportsState, entry };
}

/** Journal integrity classification (V6.8 §19–§20). */
export interface JournalIntegrityResult {
  status: 'verified' | 'warning' | 'unavailable';
  /** Stable machine codes, e.g. "journal.manifest-ahead". */
  issues: string[];
  /** Latest committed journal revision (0 when none). */
  latestRevision: number;
}

/**
 * Verify the journal against the authoritative manifest revision (§20).
 * Mismatches are REPORTED, never silently repaired:
 *   - manifest newer than the journal → the history is degraded (§25)
 *   - journal newer than the manifest   → integrity attention (§20)
 * Monotonic strictly ascending unique revisions are required; gaps are
 * allowed (retention prunes the oldest end; a history import may create
 * interior gaps).
 */
export function verifyJournalIntegrity(entries: WorkspaceRevision[], manifestRevision: number): JournalIntegrityResult {
  const issues: string[] = [];
  let previous = 0;
  const seen = new Set<number>();
  for (const entry of entries) {
    if (entry.revision <= previous) {
      issues.push(`journal.non-monotonic@${entry.revision}`);
    }
    if (seen.has(entry.revision)) {
      issues.push(`journal.duplicate-revision@${entry.revision}`);
    }
    seen.add(entry.revision);
    previous = entry.revision;
  }
  const latestRevision = entries.length > 0 ? entries[entries.length - 1].revision : 0;
  if (manifestRevision > 0 && latestRevision === 0) {
    issues.push('journal.empty');
  } else if (manifestRevision > latestRevision) {
    issues.push('journal.behind-manifest');
  } else if (latestRevision > manifestRevision) {
    issues.push('journal.ahead-of-manifest');
  } else if (!seen.has(manifestRevision)) {
    issues.push(`journal.missing-current@${manifestRevision}`);
  }
  if (entries.length === 0) {
    return { status: manifestRevision > 0 ? 'unavailable' : 'verified', issues, latestRevision };
  }
  return { status: issues.length === 0 ? 'verified' : 'warning', issues, latestRevision };
}

/**
 * Read + verify the journal against the manifest revision in one call
 * (diagnostics / startup cross-check, V6.8 §20).
 */
export async function readJournalIntegrity(
  manifestRevision: number,
): Promise<JournalIntegrityResult & { entryCount: number }> {
  const entries = await readAllRevisions();
  const result = verifyJournalIntegrity(entries, manifestRevision);
  return { ...result, entryCount: entries.length };
}

/**
 * Retention pruning (V6.8 §17): keep only the latest `retention` valid
 * entries; the CURRENT revision is never deleted. Runs in its own
 * transaction — a failure leaves the existing history untouched and the
 * next commit retries (nothing else depends on pruning for correctness
 * because every retained revision carries a full snapshot).
 */
export async function pruneRevisionHistory(
  keepCurrentRevision: number,
  retention: number = REVISION_HISTORY_RETENTION,
): Promise<number> {
  const entries = await readAllRevisions();
  if (entries.length <= retention) return 0;
  const excess = entries.slice(0, entries.length - retention).filter((entry) => entry.revision !== keepCurrentRevision);
  if (excess.length === 0) return 0;
  await withReadWriteTx([STORE_REVISION_HISTORY], (get) => {
    const store = get(STORE_REVISION_HISTORY);
    for (const entry of excess) store.delete(entry.revision);
  });
  return excess.length;
}

/**
 * Write a single anchor entry for a state that was committed before the
 * journal existed (V6.8 §42/§43: a V6.7 installation adopts V6.8 at its
 * CURRENT manifest revision — no fabricated history before that point).
 * The anchor reuses the existing revision number; it never advances it.
 */
export async function writeJournalAnchor(
  revision: number,
  committedAt: string,
  reason: 'initial' | 'migration' | 'system',
  workspace: CanonicalWorkspace,
  integrityStatus: 'verified' | 'warning' = 'verified',
): Promise<boolean> {
  if (revision < 1) return false;
  const existing = await getRevision(revision).catch(() => null);
  if (existing !== null) return true; // idempotent
  const entry = buildRevisionEntry({
    revision,
    committedAt,
    reason,
    affectedProjectIds: [],
    changeSummary: null, // anchor: no previous V6.8 state to diff against
    integrityStatus,
    snapshot: { appState: workspace.app, reportsState: workspace.reports },
  });
  try {
    await withReadWriteTx([STORE_REVISION_HISTORY], (get) => {
      get(STORE_REVISION_HISTORY).put({ ...entry, schemaVersion: JOURNAL_SCHEMA_VERSION });
    });
    return true;
  } catch {
    return false; // history becomes degraded — reported, never fatal
  }
}

/**
 * Replace the whole journal with validated imported entries (history backup
 * import, V6.8 §30). Entries are written verbatim in one transaction; the
 * caller afterwards persists the imported current state as a NEW revision so
 * the manifest/journal pair converges.
 */
export async function replaceJournalEntries(entries: WorkspaceRevision[]): Promise<boolean> {
  try {
    await withReadWriteTx([STORE_REVISION_HISTORY], (get) => {
      const store = get(STORE_REVISION_HISTORY);
      store.clear();
      for (const entry of entries) {
        store.put({ ...entry, schemaVersion: JOURNAL_SCHEMA_VERSION });
      }
    });
    return true;
  } catch {
    return false;
  }
}

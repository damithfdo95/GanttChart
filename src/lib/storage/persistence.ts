import type { AppState, ReportsState } from '../../types';
import { LEGACY_STORAGE_KEY, STORAGE_KEY } from './storage';
import { REPORTS_STORAGE_KEY } from './reports';
import { RECOVERY_KEY_PREFIX_EXPORT } from './corruption';

/**
 * Centralized persistence layer (V6.3 §5).
 *
 * Every localStorage write flows through here — individual components never
 * call setItem directly. The layer sits around the canonical state:
 *
 *   Canonical App State → Persistence Layer → localStorage → JSON backup/import
 *
 * Schema versioning (V6.3 §6): each persisted artifact is versioned so
 * future migrations have an explicit anchor —
 *   - app state:   key-versioned (ganttchart.v2; v1 is migrated on load)
 *   - reports:     explicit `schemaVersion` field inside the payload
 *   - backups:     explicit `version` field in the backup envelope
 *   - UX metadata: key-versioned (ganttchart.meta.v1)
 */

/** UX-only persistence metadata (last successful save time). No state copy. */
export const META_STORAGE_KEY = 'ganttchart.meta.v1';

export interface PersistenceMeta {
  /** Epoch ms of the last successful workspace save; null when never saved. */
  lastSavedAt: number | null;
}

/** Read the persisted UX metadata; corruption-tolerant. */
export function readPersistenceMeta(): PersistenceMeta {
  try {
    const raw = window.localStorage.getItem(META_STORAGE_KEY);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        const lastSavedAt = (parsed as Record<string, unknown>).lastSavedAt;
        if (typeof lastSavedAt === 'number' && Number.isFinite(lastSavedAt)) {
          return { lastSavedAt };
        }
      }
    }
  } catch {
    // unreadable metadata is cosmetic only — fall back to "never saved"
  }
  return { lastSavedAt: null };
}

function writePersistenceMeta(lastSavedAt: number): boolean {
  try {
    window.localStorage.setItem(META_STORAGE_KEY, JSON.stringify({ lastSavedAt }));
    return true;
  } catch {
    return false;
  }
}

export interface WorkspaceWriteResult {
  /** True when every required write succeeded. */
  ok: boolean;
  /** True when at least one storage key actually changed (skips no-op writes, §27). */
  changed: boolean;
}

/**
 * Persist the canonical workspace (app state + reports state). Unchanged
 * payloads are not re-serialized/re-written; the last-saved timestamp is
 * refreshed only after a real change. Returns ok=false on any write failure
 * — the in-memory state is never touched here (V6.3 §3).
 */
export function writePersistedWorkspace(appState: AppState, reportsState: ReportsState): WorkspaceWriteResult {
  let ok = true;
  let changed = false;
  try {
    const appJson = JSON.stringify(appState);
    if (window.localStorage.getItem(STORAGE_KEY) !== appJson) {
      window.localStorage.setItem(STORAGE_KEY, appJson);
      changed = true;
    }
  } catch {
    ok = false;
  }
  try {
    const reportsJson = JSON.stringify(reportsState);
    if (window.localStorage.getItem(REPORTS_STORAGE_KEY) !== reportsJson) {
      window.localStorage.setItem(REPORTS_STORAGE_KEY, reportsJson);
      changed = true;
    }
  } catch {
    ok = false;
  }
  if (ok && changed) {
    ok = writePersistenceMeta(Date.now());
  }
  return { ok, changed };
}

/**
 * Remove every GanttChart-persisted key, including recovery payloads and UX
 * metadata (V6.3 §13). The caller resets the in-memory canonical state to
 * the initial state afterwards.
 */
export function clearAllPersistence(): boolean {
  const keys = [STORAGE_KEY, LEGACY_STORAGE_KEY, REPORTS_STORAGE_KEY, META_STORAGE_KEY];
  let ok = true;
  try {
    const recoveryKeys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key !== null && key.startsWith(RECOVERY_KEY_PREFIX_EXPORT)) recoveryKeys.push(key);
    }
    keys.push(...recoveryKeys);
  } catch {
    // listing is best effort; fixed keys below are still removed
  }
  for (const key of keys) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      ok = false;
    }
  }
  return ok;
}

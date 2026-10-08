import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useAppState, type AppStateApi } from '../features/dashboard/hooks/useAppState';
import { useReportsState, type ReportsStateApi } from './useReportsState';
import { applyActiveProjectSync, applyActiveProjectSyncRestricted, qaInputsFromAppState } from '../domain/projects';
import { useTenant } from './tenant-context';
import { derivedTotalFor, reconcileProjectTotals } from '../domain/testManagement/totals';
import { normalizeQaInputsForLoad } from '../lib/storage/storage';
import { consumeCorruptionEvents, type CorruptionEvent } from '../lib/storage/corruption';
import { persistWorkspaceAsync } from '../lib/storage/db/persistenceBackend';
import type { PersistenceBoot } from '../lib/storage/db/bootstrap';
import { downloadTextFile } from '../lib/export/download';
import {
  DEFAULT_AUTO_BACKUP_SETTINGS,
} from '../lib/storage/reports';
import {
  reauthorizeAndWriteBackup,
  runDailyBackupInBrowser,
  type AutoBackupRunResult,
} from '../lib/backup/autoBackup';
import { formatDate, todayEpochDays } from '../lib/dates/dates';
import { SharedSyncProvider, useSharedSyncEngine, type SharedBoot } from './shared-sync';
import type { AppState, ProjectRecord, ReportsState } from '../types';

/**
 * App-level state providers. Both stores are mounted once here so every
 * screen shares one live instance — there is exactly one project registry
 * and no second project state store. The app state is the editing surface
 * of the ACTIVE project; the write-back below delegates to the domain sync
 * (applyActiveProjectSync), which touches only the active project and bumps
 * updatedAt only on meaningful data changes.
 *
 * Persistence is centralized here (V6.3 §3/§5/§17, V6.6 §23–§25): a single
 * debounced effect writes the canonical workspace through the persistence
 * backend (IndexedDB primary, localStorage fallback) whenever either state
 * actually changes. Writes are asynchronous and serialized by the backend
 * queue, so the latest state always commits last; the save status tracks
 * the real commit, and beforeunload/pagehide flush the pending write as a
 * best effort (an async database write is never falsely reported as saved).
 */

const AppStateContext = createContext<AppStateApi | null>(null);
const ReportsStateContext = createContext<ReportsStateApi | null>(null);

/** Automatic daily backup status (see lib/backup/autoBackup.ts). */
export interface AutoBackupApi {
  /** Outcome that needs user attention; null when everything is fine. */
  notice: 'needs-permission' | 'failed' | null;
  dismiss: () => void;
  /** User-gesture re-authorization of folder access + retry write. */
  reauthorize: () => Promise<void>;
  /** Immediate backup run (Settings "Back up now"); bypasses the due check. */
  runNow: () => Promise<AutoBackupRunResult>;
}

const AutoBackupContext = createContext<AutoBackupApi | null>(null);

export function useAutoBackupCtx(): AutoBackupApi {
  const ctx = useContext(AutoBackupContext);
  if (ctx === null) throw new Error('useAutoBackupCtx must be used within AppProviders');
  return ctx;
}

/**
 * Automatic daily backup (first app start of a new day + hourly midnight
 * crossing check). The check reads the LATEST state through a ref so it runs
 * on a timer, not on every keystroke; lastBackupAt is only recorded after a
 * successful write, so an unauthorized or failed attempt retries on the
 * next check.
 */
function useAutoDailyBackup(app: AppStateApi, reports: ReportsStateApi): AutoBackupApi {
  const [notice, setNotice] = useState<'needs-permission' | 'failed' | null>(null);
  const latest = useRef({ app: app.state, reports: reports.state });
  latest.current = { app: app.state, reports: reports.state };

  const check = useCallback(async (force: boolean): Promise<AutoBackupRunResult> => {
    const { app: appState, reports: reportsState } = latest.current;
    const result = await runDailyBackupInBrowser({
      app: appState,
      reports: reportsState,
      settings: reportsState.settings.autoBackup ?? DEFAULT_AUTO_BACKUP_SETTINGS,
      today: formatDate(todayEpochDays()),
      nowIso: new Date().toISOString(),
      force,
    });
    if (result.status === 'needs-permission' || result.status === 'failed') setNotice(result.status);
    else if (result.status === 'written-folder' || result.status === 'written-download') setNotice(null);
    return result;
  }, []);

  useEffect(() => {
    void check(false);
    const id = window.setInterval(() => void check(false), 60 * 60 * 1000);
    return () => window.clearInterval(id);
  }, [check]);

  const reauthorize = useCallback(async (): Promise<void> => {
    const { app: appState, reports: reportsState } = latest.current;
    const result = await reauthorizeAndWriteBackup(appState, reportsState, formatDate(todayEpochDays()), new Date().toISOString());
    setNotice(result === 'written' ? null : 'failed');
  }, []);

  const dismiss = useCallback((): void => setNotice(null), []);

  return { notice, dismiss, reauthorize, runNow: () => check(true) };
}

/** Save-status indicator states (V6.3 §3; V6.6 §17). */
export type SaveStatus = 'saved' | 'saving' | 'error';

export interface PersistenceStatusApi {
  status: SaveStatus;
  /** Epoch ms of the last successful workspace save; null when never saved. */
  lastSavedAt: number | null;
  /** True when unreadable persisted data was detected at startup (V6.3 §22). */
  corruptedAtStartup: boolean;
  dismissCorruption: () => void;
  /** Download the preserved raw payloads of the corrupted keys as a JSON file. */
  exportCorruptedData: () => void;
  /** Active persistence backend after the startup bootstrap (V6.6 §22). */
  mode: 'indexeddb' | 'localstorage';
  /** localStorage → IndexedDB migration status from the startup bootstrap. */
  migrationStatus: PersistenceBoot['migrationStatus'];
  /** Why the migration failed (null unless migrationStatus is 'failed'). */
  migrationFailureReason: PersistenceBoot['migrationFailureReason'];
  /** Overall persistence/recovery state (V6.7 §7). */
  health: PersistenceBoot['health'];
  /** Committed workspace revision of the latest save (V6.7 §2). */
  revision: number;
  /** Write any pending edit to this device's database now (used before signing out). */
  saveNow: () => Promise<void>;
}

const PersistenceStatusContext = createContext<PersistenceStatusApi | null>(null);

export function usePersistenceCtx(): PersistenceStatusApi {
  const ctx = useContext(PersistenceStatusContext);
  if (ctx === null) throw new Error('usePersistenceCtx must be used within AppProviders');
  return ctx;
}

/** Debounce window for auto-save; rapid successive changes write once (§17/§27). */
const SAVE_DEBOUNCE_MS = 400;

interface PendingPayload {
  app: AppState;
  reports: ReportsState;
  appJson: string;
  reportsJson: string;
}

function useWorkspacePersistence(app: AppStateApi, reports: ReportsStateApi, boot: PersistenceBoot): PersistenceStatusApi {
  const [status, setStatus] = useState<SaveStatus>('saved');
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(boot.lastSavedAt);
  const [revision, setRevision] = useState<number>(boot.revision);
  const [corruptionEvents, setCorruptionEvents] = useState<CorruptionEvent[]>(() => consumeCorruptionEvents());
  const corruptedAtStartup = corruptionEvents.length > 0;

  // Last-written serializations: unchanged state never re-serializes or
  // re-writes (§27). null on first run — the backend diff handles the
  // "just loaded, nothing changed" case.
  const lastWritten = useRef<{ app: string | null; reports: string | null }>({ app: null, reports: null });
  const pending = useRef<PendingPayload | null>(null);
  const timer = useRef<number | null>(null);

  /** Fire the pending write now (cancels the debounce). */
  const saveNow = useCallback(async (): Promise<void> => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    const payload = pending.current;
    if (payload === null) return;
    const result = await persistWorkspaceAsync(payload.app, payload.reports);
    // Only the newest payload may update the status — a completed write of
    // superseded state is silently ignored (ordered saves, latest wins, §25).
    if (pending.current !== payload) return;
    if (result.ok) {
      lastWritten.current = { app: payload.appJson, reports: payload.reportsJson };
      pending.current = null;
      if (result.changed) {
        setLastSavedAt(result.lastSavedAt ?? Date.now());
        setRevision(result.revision);
      }
      setStatus('saved');
    } else {
      // Storage failed — keep the in-memory state and stay usable (§3/§21).
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    const appJson = JSON.stringify(app.state);
    const reportsJson = JSON.stringify(reports.state);
    if (
      appJson === lastWritten.current.app &&
      reportsJson === lastWritten.current.reports &&
      pending.current === null
    ) {
      return; // nothing meaningful changed — no save, no status flicker
    }
    pending.current = { app: app.state, reports: reports.state, appJson, reportsJson };
    setStatus('saving');
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void saveNow();
    }, SAVE_DEBOUNCE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.state, reports.state]);

  // Best-effort flush on page exit: the debounce is cancelled and the async
  // write starts immediately. Async IndexedDB commits are never guaranteed
  // during unload — the status never falsely reports "saved" (V6.6 §24).
  useEffect(() => {
    const flush = (): void => {
      void saveNow();
    };
    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      window.removeEventListener('pagehide', flush);
    };
  }, [saveNow]);

  const dismissCorruption = useCallback((): void => {
    setCorruptionEvents([]);
  }, []);

  const exportCorruptedData = useCallback((): void => {
    const payload = JSON.stringify(
      {
        app: 'ganttchart',
        kind: 'corrupted-raw-recovery',
        exportedAt: new Date().toISOString(),
        events: corruptionEvents.map((event) => ({ key: event.key, raw: event.raw })),
      },
      null,
      2,
    );
    downloadTextFile('ganttchart-corrupted-data.json', 'application/json', payload);
  }, [corruptionEvents]);

  return {
    status,
    lastSavedAt,
    corruptedAtStartup,
    dismissCorruption,
    exportCorruptedData,
    mode: boot.mode,
    migrationStatus: boot.migrationStatus,
    migrationFailureReason: boot.migrationFailureReason,
    health: boot.health,
    revision,
    saveNow,
  };
}

/** Sync the app state into the active project record when data actually changed. */
function useProjectWriteBack(app: AppStateApi, reports: ReportsStateApi, testerOnly: boolean): void {
  useEffect(() => {
    const nextProjects = testerOnly
      ? applyActiveProjectSyncRestricted(reports.state.projects, reports.state.activeProjectId, qaInputsFromAppState(app.state), new Date().toISOString())
      : applyActiveProjectSync(
          reports.state.projects,
          reports.state.activeProjectId,
          app.state.projectNameEn,
          app.state.projectNameJa,
          qaInputsFromAppState(app.state),
          new Date().toISOString(),
        );
    if (nextProjects !== reports.state.projects) reports.setProjects(nextProjects);
  }, [app.state, reports, testerOnly]);
}

/**
 * Stage 8D: when a project's Total Test Cases comes from its scopes, keep the figure every screen reads (`inputs.totalCases`) equal to
 * the sum. The ACTIVE project is changed through the editing surface (the write-back then carries it into the record - writing the
 * record directly would be undone by that write-back); the others are changed in the portfolio. SV/local only: a Tester never
 * receives every scope, so a Tester must not derive anything.
 */
function useScopeTotalSync(app: AppStateApi, reports: ReportsStateApi, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const scopes = reports.state.scopes ?? [];
    if (scopes.length === 0) return;
    const cases = reports.state.testCases ?? [];
    const projects = reports.state.projects;
    const activeId = reports.state.activeProjectId;
    const active = projects.find((p) => p.id === activeId);
    const derivedActive = derivedTotalFor(active, scopes, cases);
    if (derivedActive !== null && app.state.totalCases !== derivedActive) app.updateField('totalCases', derivedActive);
    const reconciled = reconcileProjectTotals(projects, scopes, cases, new Date().toISOString());
    if (reconciled === projects) return;
    const others = reconciled.map((p, i) => (p.id === activeId ? projects[i] : p));
    if (others.some((p, i) => p !== projects[i])) reports.setProjects(others);
  }, [app, reports, enabled]);
}

/**
 * One-time migration: seed the portfolio from the existing single-project data.
 * NOT in shared mode: every fresh browser would seed its own project and the
 * shared portfolio would fill with duplicates. In shared mode the first project
 * is created exactly once, deliberately, by the link screen (fixed record id).
 */
function usePortfolioSeed(app: AppStateApi, reports: ReportsStateApi, enabled: boolean): void {
  useEffect(() => {
    if (enabled) reports.seedInitialProject(app.state);
  }, [reports, enabled]);
}

export function AppProviders({ boot, shared = null, children }: { boot: PersistenceBoot; shared?: SharedBoot | null; children: ReactNode }) {
  const app = useAppState(boot.workspace.app);
  const reports = useReportsState(boot.workspace.reports);
  const autoBackup = useAutoDailyBackup(app, reports);
  usePortfolioSeed(app, reports, shared === null);
  // A Tester's changes reach the shared project only where a Tester may change it (see shared/testerRules.ts).
  const testerOnly = useTenant().principal?.role === 'user';
  useProjectWriteBack(app, reports, testerOnly);
  useScopeTotalSync(app, reports, !testerOnly);
  const persistence = useWorkspacePersistence(app, reports, boot);
  const sharedSync = useSharedSyncEngine(app, reports, shared);
  return (
    <AppStateContext.Provider value={app}>
      <ReportsStateContext.Provider value={reports}>
        <AutoBackupContext.Provider value={autoBackup}>
          <PersistenceStatusContext.Provider value={persistence}>
            <SharedSyncProvider value={sharedSync}>{children}</SharedSyncProvider>
          </PersistenceStatusContext.Provider>
        </AutoBackupContext.Provider>
      </ReportsStateContext.Provider>
    </AppStateContext.Provider>
  );
}

export function useAppStateCtx(): AppStateApi {
  const ctx = useContext(AppStateContext);
  if (ctx === null) throw new Error('useAppStateCtx must be used within AppProviders');
  return ctx;
}

export function useReportsStateCtx(): ReportsStateApi {
  const ctx = useContext(ReportsStateContext);
  if (ctx === null) throw new Error('useReportsStateCtx must be used within AppProviders');
  return ctx;
}

/**
 * Load a project into the Dashboard/Gantt editing state and make it active.
 * Takes the record directly — used right after creating a project, when the
 * new record is not yet visible in the (stale) rendered state snapshot.
 */
export function activateProjectRecord(reports: ReportsStateApi, app: AppStateApi, record: ProjectRecord): void {
  app.replaceState({
    ...normalizeQaInputsForLoad(record.inputs),
    language: app.state.language,
    projectNameEn: record.nameEn,
    projectNameJa: record.nameJa,
    dashboardView: app.state.dashboardView,
  });
  reports.setActiveProjectId(record.id);
}

/** Load a project into the Dashboard/Gantt editing state and make it active. */
export function activateProject(reports: ReportsStateApi, app: AppStateApi, id: string): void {
  const project = reports.state.projects.find((p) => p.id === id);
  if (project === undefined) return;
  activateProjectRecord(reports, app, project);
}

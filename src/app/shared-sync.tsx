import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { AppStateApi } from '../features/dashboard/hooks/useAppState';
import type { ReportsStateApi } from './useReportsState';
import type { ReportsState } from '../types';
import type { Identity, RecordDelete, RecordPut } from '../../shared/protocol';
import { normalizeQaInputsForLoad } from '../lib/storage/storage';
import { SyncClient, type PersistedMirror, type SyncHost, type SyncNotice, type SyncSocket, type SyncState } from '../lib/sync/client';
import { applyRecordChanges, reportsToRecords, type RecordKey } from '../lib/sync/records';
import { appendStash, readStash, writeLink, writeMirror } from '../lib/sync/device';
import { probeSession } from '../lib/sync/serverMode';

/** What the app needs to know to run against the shared workspace (decided at startup). */
export interface SharedBoot {
  identity: Identity;
  /** ws(s)://host/ws */
  wsUrl: string;
  /** This page's origin — the device link is per server. */
  origin: string;
  /** 'overwrite' only for a deliberate "replace the shared workspace". */
  firstState: 'apply' | 'overwrite';
  /** Persisted mirror of the server copy, for an offline start. */
  resume: PersistedMirror | null;
}

export interface SharedSyncApi {
  enabled: boolean;
  identity: Identity | null;
  /** null until the first status arrives (and always null when not shared). */
  sync: SyncState | null;
  notices: SyncNotice[];
  dismissNotice: (index: number) => void;
  /** Edits a conflict replaced on this device (kept so they can be recovered). */
  stashCount: number;
  retryNow: () => void;
  flushNow: () => void;
}

const DISABLED: SharedSyncApi = {
  enabled: false,
  identity: null,
  sync: null,
  notices: [],
  dismissNotice: () => undefined,
  stashCount: 0,
  retryNow: () => undefined,
  flushNow: () => undefined,
};

const SharedSyncContext = createContext<SharedSyncApi>(DISABLED);

export const SharedSyncProvider = SharedSyncContext.Provider;

/** Safe outside shared mode: returns a disabled API. */
export function useSharedSync(): SharedSyncApi {
  return useContext(SharedSyncContext);
}

/**
 * Connects the app state to the shared workspace. Inert when `shared` is null
 * (local-only mode: the app behaves exactly as before).
 *
 * Two rules keep it safe:
 *  1. Remote changes are applied to the reports state AND, when they touch the
 *     active project, to the editing surface (AppState) in the SAME React
 *     batch — otherwise the project write-back would push the stale editing
 *     surface over the newer shared record.
 *  2. The client reads the shared records through a ref that applyRemote
 *     updates synchronously, so a diff taken right after applying remote
 *     changes can never "undo" them.
 */
export function useSharedSyncEngine(app: AppStateApi, reports: ReportsStateApi, shared: SharedBoot | null): SharedSyncApi {
  const [sync, setSync] = useState<SyncState | null>(null);
  const [notices, setNotices] = useState<SyncNotice[]>([]);
  const [stashCount, setStashCount] = useState<number>(() => (shared === null ? 0 : readStash().length));

  const reportsRef = useRef<ReportsState>(reports.state);
  reportsRef.current = reports.state;
  const apiRef = useRef({ app, reports });
  apiRef.current = { app, reports };
  const clientRef = useRef<SyncClient | null>(null);
  const cacheRef = useRef<{ state: ReportsState; records: Map<RecordKey, RecordPut> } | null>(null);
  const syncRef = useRef<SyncState | null>(null);
  const linkedRef = useRef(false);

  useEffect(() => {
    if (shared === null) return;
    const host: SyncHost = {
      readRecords() {
        const state = reportsRef.current;
        if (cacheRef.current === null || cacheRef.current.state !== state) {
          cacheRef.current = { state, records: reportsToRecords(state) };
        }
        return cacheRef.current.records;
      },
      applyRemote(puts: RecordPut[], deletes: RecordDelete[]) {
        const before = reportsRef.current;
        const after = applyRecordChanges(before, puts, deletes);
        reportsRef.current = after; // visible to the client immediately
        apiRef.current.reports.applyRemoteChanges(puts, deletes);
        const activeId = after.activeProjectId;
        const touchedActive = activeId !== null && puts.some((p) => p.kind === 'project' && p.id === activeId);
        if (touchedActive || activeId !== before.activeProjectId) {
          const record = after.projects.find((p) => p.id === activeId);
          if (record !== undefined) {
            const current = apiRef.current.app.state;
            apiRef.current.app.replaceState({
              ...normalizeQaInputsForLoad(record.inputs),
              language: current.language,
              projectNameEn: record.nameEn,
              projectNameJa: record.nameJa,
              dashboardView: current.dashboardView,
            });
          }
        }
      },
      onState(state) {
        syncRef.current = state;
        setSync(state);
      },
      onNotice(notice) {
        setNotices((prev) => [...prev, notice].slice(-5));
        if (notice.kind === 'conflict') setStashCount(readStash().length);
      },
    };
    const client = new SyncClient({
      url: shared.wsUrl,
      host,
      // The browser WebSocket has the shape SyncSocket needs (readyState/send/close/on* handlers).
      createSocket: (url) => new WebSocket(url) as unknown as SyncSocket,
      clientId: crypto.randomUUID(),
      initial: shared.resume,
      firstState: shared.firstState,
      persistMirror: (m) => void writeMirror(m),
      stashEdit: (edit) => appendStash(edit),
      probeSession: () => probeSession(),
    });
    clientRef.current = client;
    client.start();

    const onOnline = (): void => client.networkOnline();
    const flush = (): void => client.flushNow();
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') client.flushNow();
    };
    // Unsent edits must not be lost silently: warn before leaving the page.
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      const s = syncRef.current;
      if (s !== null && s.pending > 0 && s.status !== 'readonly') {
        client.flushNow();
        event.preventDefault();
      }
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('visibilitychange', onVisibility);
      client.stop();
      clientRef.current = null;
    };
    // The shared boot is fixed for the lifetime of the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Every change to the shared state schedules a (debounced) diff against the server copy.
  useEffect(() => {
    clientRef.current?.notifyLocalChange();
  }, [reports.state]);

  // Remember that this device is linked once the server has delivered state.
  useEffect(() => {
    if (shared === null || linkedRef.current || sync === null || sync.revision === null) return;
    if (sync.status === 'synced' || sync.status === 'syncing' || sync.status === 'readonly') {
      linkedRef.current = true;
      writeLink({ origin: shared.origin, linkedAt: new Date().toISOString(), email: shared.identity.email });
    }
  }, [shared, sync]);

  const dismissNotice = useCallback((index: number): void => {
    setNotices((prev) => prev.filter((_, i) => i !== index));
  }, []);
  const retryNow = useCallback((): void => clientRef.current?.networkOnline(), []);
  const flushNow = useCallback((): void => clientRef.current?.flushNow(), []);

  if (shared === null) return DISABLED;
  return { enabled: true, identity: shared.identity, sync, notices, dismissNotice, stashCount, retryNow, flushNow };
}

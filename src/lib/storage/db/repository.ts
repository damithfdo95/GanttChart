/**
 * IndexedDB repository (V6.6 database migration, §4–§5).
 *
 * Single application database `GanttChartDB`, versioned schema (currently
 * v1). The IndexedDB schema version is intentionally independent from the
 * application data schema versions (localStorage v1/v2 keys, reports
 * schemaVersion 1) —those keep flowing through the existing V6.3
 * validation/normalization layer on top of these raw records.
 *
 * Only this module (and the migration/persistence modules around it) may
 * touch IndexedDB —React components always go through the persistence
 * abstraction (§3).
 */

export const DB_NAME = 'GanttChartDB';
/**
 * v1: projects/reports/dailyActuals/attendance/topics/metadata (V6.6).
 * v2: + revisionHistory journal store (V6.8) — additive upgrade, no
 * existing store is recreated or deleted.
 */
export const DB_VERSION = 2;

export const STORE_PROJECTS = 'projects';
export const STORE_REPORTS = 'reports';
export const STORE_DAILY_ACTUALS = 'dailyActuals';
export const STORE_ATTENDANCE = 'attendance';
export const STORE_TOPICS = 'topics';
export const STORE_METADATA = 'metadata';
export const STORE_REVISION_HISTORY = 'revisionHistory';

export const ALL_STORES: readonly string[] = [
  STORE_PROJECTS,
  STORE_REPORTS,
  STORE_DAILY_ACTUALS,
  STORE_ATTENDANCE,
  STORE_TOPICS,
  STORE_METADATA,
  STORE_REVISION_HISTORY,
];

/** Metadata store string keys (out-of-line keys). */
export const META_KEY_APP_STATE = 'appState';
export const META_KEY_REPORTS_CORE = 'reportsCore';
export const META_KEY_COLLECTION = {
  testerAssignments: 'testerAssignments',
  reviews: 'reviews',
  rcsMembers: 'rcsMembers',
  identityAuditLog: 'identityAuditLog',
  externalIdentities: 'externalIdentities',
  cycles: 'cycles',
  scopes: 'scopes',
  testCases: 'testCases',
  caseResults: 'caseResults',
  dailyPlans: 'dailyPlans',
  meetingNotes: 'meetingNotes',
} as const;
export const META_KEY_PERSISTENCE_META = 'persistenceMeta';
export const META_KEY_STORAGE_MIGRATION = 'storageMigration';

/** Open failure that callers translate into the localStorage fallback. */
export class IndexedDbUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'IndexedDbUnavailableError';
  }
}

/** The global IDBFactory, or null when IndexedDB is unavailable (node tests, hardened browsers). */
export function getIndexedDbGlobal(): IDBFactory | null {
  try {
    const factory = typeof indexedDB !== 'undefined' ? indexedDB : undefined;
    return factory ?? null;
  } catch {
    return null; // accessing the global threw —treat as unavailable
  }
}

/** True when the browser exposes an IndexedDB factory at all. */
export function isIndexedDbAvailable(): boolean {
  return getIndexedDbGlobal() !== null;
}

function reqAsPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function txAsPromise(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}

/**
 * Deterministic v1 upgrade: create every store/index that does not exist
 * yet. Future schema versions add their own step here and never recreate or
 * delete stores that already hold user data (§26).
 */
function upgradeSchema(db: IDBDatabase, fromVersion: number): void {
  if (fromVersion < 1) {
    if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
      db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' }).createIndex('projectId', 'projectId', { unique: false });
    }
    if (!db.objectStoreNames.contains(STORE_REPORTS)) {
      db.createObjectStore(STORE_REPORTS, { keyPath: 'id' }).createIndex('projectId', 'projectId', { unique: false });
    }
    if (!db.objectStoreNames.contains(STORE_DAILY_ACTUALS)) {
      // Out-of-line composite key (projectId::id) — snapshot ids are unique per
      // project, not globally (see dailyActualRowKey).
      db.createObjectStore(STORE_DAILY_ACTUALS).createIndex('projectId', 'projectId', { unique: false });
    }
    if (!db.objectStoreNames.contains(STORE_ATTENDANCE)) {
      db.createObjectStore(STORE_ATTENDANCE, { keyPath: 'id' });
    }
    if (!db.objectStoreNames.contains(STORE_TOPICS)) {
      db.createObjectStore(STORE_TOPICS, { keyPath: 'id' });
    }
    if (!db.objectStoreNames.contains(STORE_METADATA)) {
      db.createObjectStore(STORE_METADATA);
    }
  }
  // V6.8: the revision journal store. Additive only — existing V6.7 data is
  // never touched by the upgrade (§3).
  if (fromVersion < 2) {
    if (!db.objectStoreNames.contains(STORE_REVISION_HISTORY)) {
      db.createObjectStore(STORE_REVISION_HISTORY, { keyPath: 'revision' });
    }
  }
}

const OPEN_TIMEOUT_MS = 10_000;

let dbPromise: Promise<IDBDatabase> | null = null;

/** Open (and if needed upgrade) GanttChartDB. The connection is cached. */
export function openGanttChartDb(): Promise<IDBDatabase> {
  if (dbPromise !== null) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const factory = getIndexedDbGlobal();
    if (factory === null) {
      reject(new IndexedDbUnavailableError('IndexedDB is not available'));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        dbPromise = null;
        reject(new IndexedDbUnavailableError('IndexedDB open timed out'));
      }
    }, OPEN_TIMEOUT_MS);
    const request = factory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      upgradeSchema(request.result, event.oldVersion);
    };
    request.onsuccess = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      dbPromise = null;
      reject(request.error ?? new IndexedDbUnavailableError('IndexedDB open failed'));
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      dbPromise = null;
      reject(new IndexedDbUnavailableError('IndexedDB open blocked'));
    };
  });
  return dbPromise;
}

/** Drop the cached connection (used by Clear All Local Data and tests). */
export function closeGanttChartDb(): void {
  if (dbPromise === null) return;
  const promise = dbPromise;
  dbPromise = null;
  void promise.then(
    (db) => {
      db.close();
    },
    () => undefined,
  );
}

/** True when a cached connection is open. */
export function isGanttChartDbOpen(): boolean {
  return dbPromise !== null;
}

/** Start a readwrite transaction over every store and run ops inside it. */
export async function withReadWriteTx(
  stores: readonly string[],
  run: (get: (store: string) => IDBObjectStore) => void,
): Promise<void> {
  const db = await openGanttChartDb();
  const tx = db.transaction(stores as string[], 'readwrite');
  run((store) => tx.objectStore(store));
  await txAsPromise(tx);
}

/** Start a readonly transaction and collect results of the requested reads. */
export async function withReadTx<T>(
  stores: readonly string[],
  run: (get: (store: string) => IDBObjectStore) => T,
): Promise<T> {
  const db = await openGanttChartDb();
  const tx = db.transaction(stores as string[], 'readonly');
  const result = run((store) => tx.objectStore(store));
  await txAsPromise(tx);
  return result;
}

export async function getAllFromStore<T>(store: string): Promise<T[]> {
  return withReadTx([store], (get) => {
    const request = get(store).getAll();
    return reqAsPromise<T[]>(request);
  });
}

export async function getFromStore<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  return withReadTx([store], (get) => {
    const request = get(store).get(key);
    return reqAsPromise<T | undefined>(request);
  });
}

export async function putIntoStore(store: string, value: unknown, key?: IDBValidKey): Promise<void> {
  await withReadWriteTx([store], (get) => {
    if (key === undefined) {
      get(store).put(value as never);
    } else {
      get(store).put(value as never, key);
    }
  });
}

/** Delete the whole database (Clear All Local Data; connection must be closed first). */
export async function deleteGanttChartDb(): Promise<void> {
  const factory = getIndexedDbGlobal();
  if (factory === null) return;
  await new Promise<void>((resolve, reject) => {
    const request = factory.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('IndexedDB delete failed'));
    request.onblocked = () => resolve(); // best effort —stores are also cleared below
  });
}

/** Test hook: drop the cached connection so the next open starts fresh. */
export function resetGanttChartDbForTests(): void {
  closeGanttChartDb();
}

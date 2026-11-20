/**
 * IndexedDB backing store for per-device sync state (the link marker, the
 * offline mirror and the conflict stash).
 *
 * These used to live in localStorage, but the mirror is the full workspace
 * snapshot as JSON and routinely exceeds the ~5 MB localStorage quota, so the
 * write silently failed and the device was never remembered as linked (which
 * made the app re-download a "before sharing" backup on every login). A
 * dedicated IndexedDB database has a far larger quota and survives that.
 *
 * This database is intentionally separate from GanttChartDB (the workspace):
 * sync device state is per-browser and must never be cleared by "Clear All
 * Local Data" of the workspace, nor travel with a workspace export.
 */

import { getIndexedDbGlobal } from '../storage/db/repository';

export const SYNC_DB_NAME = 'GanttChartSyncDB';
export const SYNC_DB_VERSION = 1;
export const SYNC_STORE_KV = 'kv';

const OPEN_TIMEOUT_MS = 10_000;

let dbPromise: Promise<IDBDatabase> | null = null;

/** Open (and if needed create) the sync database. The connection is cached. */
export function openSyncDb(): Promise<IDBDatabase> {
  if (dbPromise !== null) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const factory = getIndexedDbGlobal();
    if (factory === null) {
      dbPromise = null;
      reject(new Error('IndexedDB is not available'));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        dbPromise = null;
        reject(new Error('IndexedDB open timed out'));
      }
    }, OPEN_TIMEOUT_MS);
    const request = factory.open(SYNC_DB_NAME, SYNC_DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(SYNC_STORE_KV)) {
        request.result.createObjectStore(SYNC_STORE_KV);
      }
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
      reject(request.error ?? new Error('IndexedDB open failed'));
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      dbPromise = null;
      reject(new Error('IndexedDB open blocked'));
    };
  });
  return dbPromise;
}

/** Drop the cached connection (used by tests). */
export function closeSyncDb(): void {
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

/** Test hook: drop the cached connection so the next open starts fresh. */
export function resetSyncDbForTests(): void {
  closeSyncDb();
}

async function withReadTx<T>(run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openSyncDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(SYNC_STORE_KV, 'readonly');
    const request = run(tx.objectStore(SYNC_STORE_KV));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed'));
  });
}

async function withWriteTx(run: (store: IDBObjectStore) => void): Promise<void> {
  const db = await openSyncDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(SYNC_STORE_KV, 'readwrite');
    run(tx.objectStore(SYNC_STORE_KV));
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}

/** Read one value; returns undefined when the key is absent or storage is blocked. */
export async function kvGet<T>(key: string): Promise<T | undefined> {
  try {
    return await withReadTx((store) => store.get(key) as IDBRequest<T>);
  } catch {
    return undefined;
  }
}

/** Write one value; returns false when storage is blocked/full. */
export async function kvPut(key: string, value: unknown): Promise<boolean> {
  try {
    await withWriteTx((store) => {
      store.put(value, key);
    });
    return true;
  } catch {
    return false;
  }
}

/** Delete one value; never throws (blocked storage is ignored). */
export async function kvDelete(key: string): Promise<void> {
  try {
    await withWriteTx((store) => {
      store.delete(key);
    });
  } catch {
    /* blocked storage */
  }
}
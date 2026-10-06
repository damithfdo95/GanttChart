/**
 * Minimal in-memory IndexedDB fake for the V6.6 persistence tests
 * (no external dependency added — the production code uses the native API).
 *
 * Implements the subset of the IndexedDB API the repository uses:
 * open/onupgradeneeded/onsuccess/onerror, versioned databases, readonly and
 * readwrite transactions with a staging overlay (abort rolls back),
 * object stores with keyPath and out-of-line keys, put/get/delete/clear/
 * getAll, deleteDatabase, and failure-injection hooks for the
 * transaction-safety and unavailable-database tests.
 */

export class FakeRequest<T = unknown> {
  result: T = undefined as unknown as T;
  error: unknown = null;
  onsuccess: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onupgradeneeded: ((event: { oldVersion: number }) => void) | null = null;
}

interface StoreDef {
  keyPath?: string;
  indexes: Map<string, string>;
}

interface DatabaseState {
  name: string;
  version: number;
  stores: Map<string, StoreDef>;
  committed: Map<string, Map<unknown, unknown>>;
}

const DELETED = Symbol('fake-idb-deleted');

/** Real IndexedDB structured-clones stored values — the fake deep-copies on the same boundary. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Handle returned by createObjectStore during an upgrade. */
interface StoreCreator {
  createIndex: (name: string, keyPath: string, options?: unknown) => void;
}

class FakeObjectStore {
  private overlay = new Map<unknown, unknown>();
  private cleared = false;

  constructor(
    private readonly def: StoreDef,
    private readonly committed: Map<unknown, unknown>,
    private readonly onRequest: () => void,
  ) {}

  private extractKey(value: unknown, explicitKey: IDBValidKey | undefined): IDBValidKey {
    if (explicitKey !== undefined) {
      if (this.def.keyPath !== undefined) throw new Error('DataError: explicit key on a keyPath store');
      return explicitKey;
    }
    if (this.def.keyPath === undefined) throw new Error('DataError: missing key on an out-of-line store');
    const record = value as Record<string, unknown> | null;
    if (typeof record !== 'object' || record === null || !(this.def.keyPath in record)) {
      throw new Error('DataError: value is missing the keyPath property');
    }
    return record[this.def.keyPath] as IDBValidKey;
  }

  put(value: unknown, key?: IDBValidKey): FakeRequest<IDBValidKey> {
    const request = new FakeRequest<IDBValidKey>();
    try {
      const storedKey = this.extractKey(value, key);
      this.overlay.set(storedKey, clone(value));
      this.onRequest();
      fire(request, storedKey);
    } catch (error) {
      fireError(request, error);
    }
    return request;
  }

  /** Overlay applied over the committed data (this transaction's view). */
  readView(): Map<unknown, unknown> {
    const view = this.cleared ? new Map() : new Map(this.committed);
    for (const [key, value] of this.overlay) {
      if (value === DELETED) view.delete(key);
      else view.set(key, value);
    }
    return view;
  }

  /** Commit the staged overlay into the committed store data. */
  commitInto(): void {
    if (this.cleared) this.committed.clear();
    for (const [key, value] of this.overlay) {
      if (value === DELETED) this.committed.delete(key);
      else this.committed.set(key, value);
    }
  }

  get(key: IDBValidKey): FakeRequest<unknown> {
    const request = new FakeRequest<unknown>();
    this.onRequest();
    const staged = this.overlay.get(key);
    const raw =
      staged === DELETED ? undefined : staged !== undefined ? staged : this.cleared ? undefined : this.committed.get(key);
    fire(request, raw === undefined ? undefined : clone(raw));
    return request;
  }

  delete(key: IDBValidKey): FakeRequest<undefined> {
    const request = new FakeRequest<undefined>();
    this.overlay.set(key, DELETED);
    this.onRequest();
    fire(request, undefined);
    return request;
  }

  clear(): FakeRequest<undefined> {
    const request = new FakeRequest<undefined>();
    this.cleared = true;
    this.overlay = new Map();
    this.onRequest();
    fire(request, undefined);
    return request;
  }

  getAll(): FakeRequest<unknown[]> {
    const request = new FakeRequest<unknown[]>();
    this.onRequest();
    fire(request, [...this.readView().values()].map(clone));
    return request;
  }

  count(): FakeRequest<number> {
    const request = new FakeRequest<number>();
    this.onRequest();
    fire(request, this.readView().size);
    return request;
  }
}

function fire<T>(request: FakeRequest<T>, result: T): void {
  request.result = result;
  queueMicrotask(() => {
    if (request.onsuccess !== null) request.onsuccess();
  });
}

function fireError(request: FakeRequest, error: unknown): void {
  request.error = error;
  queueMicrotask(() => {
    if (request.onerror !== null) request.onerror(error);
  });
}

class FakeTransaction {
  private stores = new Map<string, FakeObjectStore>();
  private pendingRequests = 0;
  private state: 'active' | 'finished' = 'active';

  oncomplete: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(
    private readonly db: FakeDatabase,
    readonly storeNames: string[],
    readonly mode: 'readonly' | 'readwrite',
  ) {
    // Auto-commit when no request is ever issued (real IDB commits immediately).
    queueMicrotask(() => {
      if (this.state === 'active' && this.pendingRequests === 0) this.settle();
    });
  }

  objectStore(name: string): FakeObjectStore {
    if (this.state !== 'active') throw new Error('InvalidStateError: transaction finished');
    if (!this.storeNames.includes(name)) throw new Error(`NotFoundError: store ${name} not in transaction scope`);
    let store = this.stores.get(name);
    if (store === undefined) {
      const def = this.db.state.stores.get(name);
      if (def === undefined) throw new Error(`NotFoundError: store ${name}`);
      const committed = this.db.state.committed.get(name) ?? new Map();
      store = new FakeObjectStore(def, committed, () => this.trackRequest());
      this.stores.set(name, store);
    }
    return store;
  }

  trackRequest(): void {
    this.pendingRequests++;
    queueMicrotask(() => {
      this.pendingRequests--;
      if (this.pendingRequests === 0 && this.state === 'active') this.settle();
    });
  }

  private settle(): void {
    const factory = this.db.factory;
    const scoped = factory.abortNextTransactionIncluding;
    if (
      this.mode === 'readwrite' &&
      (factory.abortNextTransaction || (scoped !== null && this.storeNames.includes(scoped)))
    ) {
      factory.abortNextTransaction = false;
      factory.abortNextTransactionIncluding = null;
      this.state = 'finished';
      if (this.onabort !== null) this.onabort();
      return;
    }
    if (this.mode === 'readwrite') {
      for (const store of this.stores.values()) store.commitInto();
    }
    this.state = 'finished';
    if (this.oncomplete !== null) this.oncomplete();
  }

  abort(): void {
    if (this.state !== 'active') return;
    this.state = 'finished';
    if (this.onabort !== null) this.onabort();
  }
}

class FakeDatabase {
  objectStoreNames: { contains: (name: string) => boolean } = {
    contains: (name: string) => this.state.stores.has(name),
  };

  onversionchange: (() => void) | null = null;

  constructor(
    readonly state: DatabaseState,
    readonly factory: FakeIDBFactory,
  ) {}

  get version(): number {
    return this.state.version;
  }

  get name(): string {
    return this.state.name;
  }

  createObjectStore(name: string, options?: { keyPath?: string }): StoreCreator {
    if (!this.factory.upgradeActive) throw new Error('InvalidStateError: createObjectStore outside an upgrade');
    if (this.state.stores.has(name)) throw new Error(`ConstraintError: store ${name} exists`);
    const def: StoreDef = { keyPath: options?.keyPath, indexes: new Map() };
    this.state.stores.set(name, def);
    this.state.committed.set(name, new Map());
    return {
      createIndex: (indexName: string, keyPath: string): void => {
        def.indexes.set(indexName, keyPath);
      },
    };
  }

  transaction(storeNames: string[] | string, mode: 'readonly' | 'readwrite'): FakeTransaction {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    for (const name of names) {
      if (!this.state.stores.has(name)) throw new Error(`NotFoundError: store ${name}`);
    }
    return new FakeTransaction(this, names, mode);
  }

  close(): void {
    this.factory.connections.delete(this);
  }
}

export class FakeIDBFactory {
  private databases = new Map<string, DatabaseState>();
  /** Open connections (the fake does not enforce single-writer blocking). */
  readonly connections = new Set<FakeDatabase>();
  upgradeActive = false;
  /** When true, the next transaction that would commit is aborted instead (transaction-safety test). */
  abortNextTransaction = false;
  /** When set, the next readwrite transaction whose scope includes this store is aborted (targets one specific commit). */
  abortNextTransactionIncluding: string | null = null;
  /** When true, the next open() fails (unavailable-database test). */
  failNextOpen = false;

  open(name: string, version?: number): FakeRequest<FakeDatabase> {
    const request = new FakeRequest<FakeDatabase>();
    queueMicrotask(() => {
      if (this.failNextOpen) {
        this.failNextOpen = false;
        request.error = new Error('fake open failure');
        if (request.onerror !== null) request.onerror(request.error);
        return;
      }
      let state = this.databases.get(name);
      if (state === undefined) {
        state = { name, version: 0, stores: new Map(), committed: new Map() };
        this.databases.set(name, state);
      } else if (version !== undefined && version < state.version) {
        request.error = new Error('VersionError');
        if (request.onerror !== null) request.onerror(request.error);
        return;
      }
      const needsUpgrade = state.stores.size === 0 || (version !== undefined && version > state.version);
      const db = new FakeDatabase(state, this);
      this.connections.add(db);
      if (needsUpgrade) {
        this.upgradeActive = true;
        const oldVersion = state.version;
        if (version !== undefined) state.version = version;
        else if (state.version === 0) state.version = 1;
        request.result = db as never;
        request.onupgradeneeded?.({ oldVersion });
        this.upgradeActive = false;
      }
      request.result = db as never;
      if (request.onsuccess !== null) request.onsuccess();
    });
    return request;
  }

  deleteDatabase(name: string): FakeRequest<undefined> {
    const request = new FakeRequest<undefined>();
    queueMicrotask(() => {
      this.databases.delete(name);
      request.result = undefined;
      if (request.onsuccess !== null) request.onsuccess();
    });
    return request;
  }

  /** Test helper: does the named database exist? */
  hasDatabase(name: string): boolean {
    return this.databases.has(name);
  }

  /** Test helper: read one committed record directly (verification/tampering). */
  readRecord(storeName: string, key: unknown): unknown {
    for (const state of this.databases.values()) {
      const map = state.committed.get(storeName);
      if (map !== undefined && map.has(key)) return clone(map.get(key));
    }
    return undefined;
  }

  /** Test helper: list committed keys of a store in the named database. */
  listKeys(dbName: string, storeName: string): unknown[] {
    const state = this.databases.get(dbName);
    const map = state?.committed.get(storeName);
    return map === undefined ? [] : [...map.keys()];
  }

  /** Test helper: remove one committed record directly (verification-failure tests). */
  deleteRecord(dbName: string, storeName: string, key: unknown): void {
    this.databases.get(dbName)?.committed.get(storeName)?.delete(key);
  }

  /** Test helper: write a raw record bypassing all guards (corruption tests). */
  writeRecord(dbName: string, storeName: string, key: unknown, value: unknown): void {
    const state = this.databases.get(dbName);
    if (state === undefined) return;
    let map = state.committed.get(storeName);
    if (map === undefined) {
      map = new Map();
      state.committed.set(storeName, map);
    }
    map.set(key, clone(value));
  }
}

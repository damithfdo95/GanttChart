import { beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceStore, type CommitInput } from '../src/store';
import { createTestStorage } from './helpers/sqlJsStorage';

type TestStorage = Awaited<ReturnType<typeof createTestStorage>>;

let storage: TestStorage;
let store: WorkspaceStore;
let seq = 0;

beforeEach(async () => {
  storage = await createTestStorage();
  store = new WorkspaceStore(storage);
  store.init();
  seq = 0;
});

const put = (kind: 'project' | 'report' | 'member' | 'settings', id: string, value: unknown) => ({
  kind,
  id,
  json: JSON.stringify(value),
});

function commit(overrides: Partial<CommitInput> & Pick<CommitInput, 'puts' | 'deletes'>) {
  seq += 1;
  return store.commit({
    commitId: `c${seq}`,
    baseRevision: store.revision(),
    actor: 'a@example.com',
    reason: 'edit',
    now: `2026-10-0${Math.min(9, seq)}T09:00:00.000Z`,
    ...overrides,
  });
}

describe('basics', () => {
  it('init is idempotent and starts empty at revision 0', () => {
    store.init();
    expect(store.revision()).toBe(0);
    expect(store.snapshot()).toEqual({ revision: 0, records: [] });
    expect(store.historyFloor()).toBe(0);
  });

  it('commits records, advances the revision and returns what changed', () => {
    const r = commit({ puts: [put('project', 'p1', { n: 1 }), put('settings', 'settings', { t: 1 })], deletes: [] });
    expect(r).toMatchObject({ ok: true, revision: 1, changed: true, duplicate: false });
    expect(store.snapshot().records.map((x) => `${x.kind}:${x.id}`)).toEqual(['project:p1', 'settings:settings']);
    expect(store.listRevisions()[0]).toMatchObject({ revision: 1, actor: 'a@example.com', puts: 2, deletes: 0 });
  });

  it('drops no-op puts and deletes of missing records without creating a revision', () => {
    commit({ puts: [put('project', 'p1', { n: 1 })], deletes: [] });
    const same = commit({ puts: [put('project', 'p1', { n: 1 })], deletes: [{ kind: 'report', id: 'nope' }] });
    expect(same).toMatchObject({ ok: true, changed: false, revision: 1 });
    expect(store.revision()).toBe(1);
  });
});

describe('per-record optimistic concurrency', () => {
  it('merges edits to DIFFERENT records made on the same base revision', () => {
    commit({ puts: [put('project', 'a', 1), put('project', 'b', 1)], deletes: [] });
    const base = store.revision();
    const alice = commit({ baseRevision: base, puts: [put('project', 'a', 2)], deletes: [] });
    const bob = commit({ baseRevision: base, puts: [put('project', 'b', 2)], deletes: [] });
    expect(alice).toMatchObject({ ok: true, revision: 2 });
    expect(bob).toMatchObject({ ok: true, revision: 3 });
    expect(store.snapshot().records.map((r) => r.json)).toEqual(['2', '2']);
  });

  it('rejects an edit to the SAME record and returns the server version', () => {
    commit({ puts: [put('project', 'a', 1)], deletes: [] });
    const base = store.revision();
    commit({ baseRevision: base, puts: [put('project', 'a', 'alice')], deletes: [] });
    const bob = commit({ baseRevision: base, puts: [put('project', 'a', 'bob')], deletes: [] });
    expect(bob).toEqual({
      ok: false,
      reason: 'conflict',
      revision: 2,
      conflicts: [{ kind: 'project', id: 'a', json: '"alice"' }],
    });
    expect(store.snapshot().records[0].json).toBe('"alice"'); // nothing of Bob's was applied
  });

  it('is all-or-nothing: one conflicting record rejects the whole commit', () => {
    commit({ puts: [put('project', 'a', 1), put('project', 'b', 1)], deletes: [] });
    const base = store.revision();
    commit({ baseRevision: base, puts: [put('project', 'a', 'alice')], deletes: [] });
    const bob = commit({ baseRevision: base, puts: [put('project', 'a', 'bob'), put('project', 'b', 'bob')], deletes: [] });
    expect(bob.ok).toBe(false);
    expect(store.snapshot().records.find((r) => r.id === 'b')?.json).toBe('1');
    expect(store.revision()).toBe(2);
  });

  it('treats editing a record someone deleted as a conflict (no silent resurrection)', () => {
    commit({ puts: [put('report', 'r', 1)], deletes: [] });
    const base = store.revision();
    commit({ baseRevision: base, puts: [], deletes: [{ kind: 'report', id: 'r' }] });
    const bob = commit({ baseRevision: base, puts: [put('report', 'r', 'edited')], deletes: [] });
    expect(bob).toMatchObject({ ok: false, reason: 'conflict', conflicts: [{ kind: 'report', id: 'r', json: null }] });
  });

  it('rejects a base revision from the future as stale', () => {
    expect(commit({ baseRevision: 99, puts: [put('member', 'm', 1)], deletes: [] })).toMatchObject({ ok: false, reason: 'stale' });
  });
});

describe('idempotent retries', () => {
  it('re-sending a commit that already succeeded does not apply it twice', () => {
    const first = store.commit({
      commitId: 'same', baseRevision: 0, puts: [put('member', 'm', 1)], deletes: [], actor: 'a', reason: 'edit', now: '2026-10-01T00:00:00.000Z',
    });
    const retry = store.commit({
      commitId: 'same', baseRevision: 0, puts: [put('member', 'm', 1)], deletes: [], actor: 'a', reason: 'edit', now: '2026-10-01T00:00:01.000Z',
    });
    expect(first).toMatchObject({ ok: true, revision: 1, duplicate: false });
    expect(retry).toMatchObject({ ok: true, revision: 1, duplicate: true, puts: [], deletes: [] });
    expect(store.revision()).toBe(1);
  });
});

describe('catching up (changesSince)', () => {
  it('returns the latest state per key since a revision, including deletions', () => {
    commit({ puts: [put('project', 'a', 1), put('project', 'b', 1)], deletes: [] }); // 1
    commit({ puts: [put('project', 'a', 2)], deletes: [] }); // 2
    commit({ puts: [put('project', 'a', 3)], deletes: [{ kind: 'project', id: 'b' }] }); // 3
    const c = store.changesSince(1);
    expect(c).toEqual({
      kind: 'changes',
      revision: 3,
      puts: [{ kind: 'project', id: 'a', json: '3' }],
      deletes: [{ kind: 'project', id: 'b' }],
    });
    expect(store.changesSince(3)).toEqual({ kind: 'changes', revision: 3, puts: [], deletes: [] });
  });

  it('falls back to a snapshot for a client from the future (e.g. after a server restore)', () => {
    commit({ puts: [put('project', 'a', 1)], deletes: [] });
    expect(store.changesSince(50).kind).toBe('snapshot');
  });
});

describe('history', () => {
  it('reconstructs the full state at any retained revision', () => {
    commit({ puts: [put('project', 'a', 1), put('project', 'b', 1)], deletes: [] }); // 1
    commit({ puts: [put('project', 'a', 2)], deletes: [{ kind: 'project', id: 'b' }] }); // 2
    expect(store.reconstruct(1)?.map((r) => `${r.id}=${r.json}`)).toEqual(['a=1', 'b=1']);
    expect(store.reconstruct(2)?.map((r) => `${r.id}=${r.json}`)).toEqual(['a=2']);
    expect(store.reconstruct(3)).toBeNull();
  });

  it('restores an old revision as a NEW revision and keeps the history append-only', () => {
    commit({ puts: [put('project', 'a', 1), put('project', 'b', 1)], deletes: [] }); // 1
    commit({ puts: [put('project', 'a', 2)], deletes: [{ kind: 'project', id: 'b' }] }); // 2
    const restored = store.restoreAsNewRevision(1, 'admin@example.com', '2026-10-05T00:00:00.000Z', 'restore-1');
    expect(restored).toMatchObject({ ok: true, revision: 3 });
    expect(store.snapshot().records.map((r) => `${r.id}=${r.json}`)).toEqual(['a=1', 'b=1']);
    expect(store.listRevisions().map((r) => [r.revision, r.reason])).toEqual([[3, 'restore:1'], [2, 'edit'], [1, 'edit']]);
    expect(store.reconstruct(2)?.map((r) => r.id)).toEqual(['a']); // rev 2 still reachable
    expect(store.restoreAsNewRevision(99, 'x', '2026-10-05T00:00:00.000Z', 'r2')).toBeNull();
  });

  it('lists revisions newest-first with per-kind summaries', () => {
    commit({ puts: [put('project', 'a', 1), put('report', 'r', 1)], deletes: [] });
    const [latest] = store.listRevisions();
    expect(latest.summary).toEqual([
      { kind: 'project', puts: 1, deletes: 0 },
      { kind: 'report', puts: 1, deletes: 0 },
    ]);
  });
});

describe('retention (prune)', () => {
  function seed() {
    commit({ puts: [put('project', 'a', 1), put('project', 'gone', 1)], deletes: [], now: '2026-01-01T00:00:00.000Z' }); // 1
    commit({ puts: [put('project', 'a', 2)], deletes: [{ kind: 'project', id: 'gone' }], now: '2026-01-02T00:00:00.000Z' }); // 2
    commit({ puts: [put('project', 'a', 3)], deletes: [], now: '2026-06-01T00:00:00.000Z' }); // 3
    commit({ puts: [put('project', 'b', 1)], deletes: [], now: '2026-06-02T00:00:00.000Z' }); // 4
  }

  it('folds old history into a baseline and keeps everything after the floor intact', () => {
    seed();
    const floor = store.prune('2026-03-01T00:00:00.000Z');
    expect(floor).toBe(2);
    expect(store.historyFloor()).toBe(2);
    expect(store.reconstruct(1)).toBeNull(); // before the floor
    expect(store.reconstruct(2)?.map((r) => `${r.id}=${r.json}`)).toEqual(['a=2']); // baseline state at the floor
    expect(store.reconstruct(4)?.map((r) => `${r.id}=${r.json}`)).toEqual(['a=3', 'b=1']);
    expect(store.snapshot().records.map((r) => r.id)).toEqual(['a', 'b']); // live state untouched
    expect(store.listRevisions().map((r) => r.revision)).toEqual([4, 3, 2]);
  });

  it('sends a snapshot to clients older than the floor and rejects their commits as stale', () => {
    seed();
    store.prune('2026-03-01T00:00:00.000Z');
    expect(store.changesSince(1).kind).toBe('snapshot');
    expect(store.changesSince(2)).toMatchObject({ kind: 'changes', puts: [{ id: 'a', json: '3' }, { id: 'b', json: '1' }] });
    expect(commit({ baseRevision: 1, puts: [put('project', 'a', 9)], deletes: [] })).toMatchObject({ ok: false, reason: 'stale' });
    expect(commit({ baseRevision: 2, puts: [put('project', 'zz', 9)], deletes: [] })).toMatchObject({ ok: true });
  });

  it('is a no-op when nothing is old enough', () => {
    seed();
    expect(store.prune('2025-01-01T00:00:00.000Z')).toBe(0);
    expect(store.reconstruct(1)).not.toBeNull();
  });
});

describe('atomicity', () => {
  it('a failure part-way through a commit leaves records, history and revision untouched', () => {
    commit({ puts: [put('project', 'a', 1)], deletes: [] });
    storage.failOn('INSERT INTO revisions');
    expect(() => commit({ puts: [put('project', 'a', 2), put('project', 'b', 1)], deletes: [] })).toThrow(/injected failure/);
    storage.failOn(null);
    expect(store.revision()).toBe(1);
    expect(store.snapshot().records.map((r) => `${r.id}=${r.json}`)).toEqual(['a=1']);
    expect(store.reconstruct(1)?.length).toBe(1);
    // …and the store still works afterwards.
    expect(commit({ puts: [put('project', 'a', 2)], deletes: [] })).toMatchObject({ ok: true, revision: 2 });
  });
});

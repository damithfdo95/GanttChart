import { describe, expect, it } from 'vitest';
import { qaCommitError } from '../../shared/qaRules';

/**
 * Durable Object SQLite bills every row a query scans, and the free plan stops at 5,000,000 rows read per day. The commit rules used to
 * list a whole table once PER PUT (a 500-case import over 1,500 existing cases read ~750,000 rows in one commit). These tests pin the
 * read cost - each kind is listed at most once per commit - and that the rules still give the same answers.
 */

const J = JSON.stringify;
const NOW = '2026-10-26T00:00:00.000Z';
const project = { id: 'proj-1', projectId: 'PRJ-001', nameEn: 'P', status: 'ongoing', inputs: { totalCases: 10 } };
const scope = (id: string, code?: string) => ({ id, projectId: 'PRJ-001', name: id, status: 'active', order: 1, createdAt: NOW, updatedAt: NOW, ...(code === undefined ? {} : { code }) });
const tcase = (id: string, scopeId: string, key: string) => ({ id, projectId: 'PRJ-001', scopeId, key, title: key, priority: 'medium', status: 'active', order: 1, createdAt: NOW, updatedAt: NOW });

function world(existingCases: number) {
  const rows: Record<string, Array<{ id: string; json: string }>> = {
    project: [{ id: 'proj-1', json: J(project) }],
    scope: [{ id: 's1', json: J(scope('s1', 'REG')) }, { id: 's2', json: J(scope('s2')) }],
    testCase: Array.from({ length: existingCases }, (_, i) => ({ id: `c${i}`, json: J(tcase(`c${i}`, 's1', `REG-${i}`)) })),
    caseExecution: [{ id: 'e1', json: J({ id: 'e1', projectId: 'PRJ-001', scopeId: 's1', testCaseId: 'c0', status: 'pass', executedAt: NOW, source: 'manual' }) }],
  };
  const stats = { listCalls: [] as string[], rowsRead: 0, gets: 0 };
  const view = {
    get: (kind: string, id: string) => {
      stats.gets += 1;
      return rows[kind]?.find((r) => r.id === id)?.json ?? null;
    },
    list: (kind: string) => {
      stats.listCalls.push(kind);
      const out = rows[kind] ?? [];
      stats.rowsRead += out.length;
      return out;
    },
  };
  return { view, stats };
}
const run = (puts: Array<{ kind: string; id: string; json: string }>, deletes: Array<{ kind: string; id: string }>, w: ReturnType<typeof world>) =>
  qaCommitError({ role: 'admin', puts, deletes, view: w.view, userId: 'usr_sv', today: '2026-10-26' });

describe('commit rules read each table at most once per commit', () => {
  it('a 500-case import over 1,500 existing cases lists the case table once, not once per put', () => {
    const w = world(1500);
    const puts = Array.from({ length: 500 }, (_, i) => ({ kind: 'testCase', id: `n${i}`, json: J(tcase(`n${i}`, 's1', `NEW-${i}`)) }));
    const started = Date.now();
    expect(run(puts, [], w)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
    const counts = new Map<string, number>();
    for (const k of w.stats.listCalls) counts.set(k, (counts.get(k) ?? 0) + 1);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
    expect(w.stats.rowsRead).toBeLessThan(1600); // ~1,500 case rows once - the old rules read about 750,000
  });

  it('many new scopes list the scope and project tables once each', () => {
    const w = world(10);
    const puts = Array.from({ length: 200 }, (_, i) => ({ kind: 'scope', id: `ns${i}`, json: J(scope(`ns${i}`, `C${i}`)) }));
    expect(run(puts, [], w)).toBeNull();
    expect(w.stats.listCalls.filter((k) => k === 'scope').length).toBeLessThanOrEqual(1);
    expect(w.stats.listCalls.filter((k) => k === 'project').length).toBeLessThanOrEqual(1);
  });

  it('deleting many cases without history lists the history table once', () => {
    const w = world(300);
    const deletes = Array.from({ length: 200 }, (_, i) => ({ kind: 'testCase', id: `c${i + 1}` }));
    expect(run([], deletes, w)).toBeNull();
    expect(w.stats.listCalls.filter((k) => k === 'caseExecution').length).toBe(1);
  });

  it('the rules still refuse what they refused before', () => {
    const w = world(50);
    expect(run([{ kind: 'testCase', id: 'dup', json: J(tcase('dup', 's1', 'REG-7')) }], [], w)).toBe('testcase_key_taken');
    expect(run([{ kind: 'testCase', id: 'a', json: J(tcase('a', 's1', 'SAME')) }, { kind: 'testCase', id: 'b', json: J(tcase('b', 's1', 'SAME')) }], [], w)).toBe('testcase_key_taken');
    expect(run([{ kind: 'scope', id: 'dupscope', json: J(scope('dupscope', 'REG')) }], [], w)).toBe('scope_code_taken');
    expect(run([{ kind: 'scope', id: 's1', json: J(scope('s1', 'REG')) }], [], w)).toBeNull(); // its own code is not a clash
    expect(run([{ kind: 'scope', id: 'orphan', json: J({ ...scope('orphan'), projectId: 'PRJ-NOPE' }) }], [], w)).toBe('scope_project_not_found');
    expect(run([], [{ kind: 'testCase', id: 'c0' }], w)).toBe('testcase_has_history');
    expect(run([], [{ kind: 'scope', id: 's1' }], w)).toBe('scope_has_cases');
    expect(run([], [{ kind: 'scope', id: 's2' }], w)).toBeNull();
    // A key freed in the same commit can be reused.
    expect(run([{ kind: 'testCase', id: 'c3', json: J(tcase('c3', 's1', 'REG-3-RENAMED')) }, { kind: 'testCase', id: 'x', json: J(tcase('x', 's1', 'REG-3')) }], [], w)).toBe('testcase_key_immutable');
  });
});

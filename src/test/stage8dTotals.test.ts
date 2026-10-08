import { describe, expect, it } from 'vitest';
import { DEMO_STATE, normalizeQaInputs } from '../lib/storage/storage';
import { newProjectRecord } from '../domain/projects/lifecycle';
import {
  cleanTotal,
  detailedCoverage,
  derivedTotalFor,
  editScope,
  newScope,
  parseTotalInput,
  projectTotals,
  reconcileProjectTotals,
  registeredWarning,
  resultsByCase,
  summarize,
} from '../domain/testManagement';
import { checkScope, testManagementCommitError } from '../../shared/testManagement';
import type { ProjectRecord, QaInputs, TestCase, TestScope } from '../types';

const NOW = '2026-10-08T09:00:00.000Z';
const inputs = (totalCases: number): QaInputs => normalizeQaInputs({ ...(DEMO_STATE as QaInputs), totalCases });
const project = (projectId: string, totalCases: number): ProjectRecord => ({ ...newProjectRecord(inputs(totalCases), { nameEn: projectId, status: 'ongoing' }, NOW, []), id: `rec_${projectId}`, projectId });
const scope = (id: string, projectId: string, total?: number, status: 'active' | 'archived' = 'active', order = 10): TestScope => ({ id, projectId, name: id, status, order, createdAt: NOW, updatedAt: NOW, ...(total === undefined ? {} : { totalTestCases: total }) });
const cases = (scopeId: string, projectId: string, n: number, status: 'active' | 'archived' = 'active'): TestCase[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${scopeId}_c${i}_${status}`, projectId, scopeId, key: `${scopeId.toUpperCase()}-${status[0]}${i + 1}`, title: 't', priority: 'medium', status, order: i, createdAt: NOW, updatedAt: NOW }));

describe('Total Test Cases is authoritative and independent of registration', () => {
  it('a Total can exist with NO registered cases', () => {
    const t = projectTotals(project('PRJ-001', 0), [scope('s1', 'PRJ-001', 134)], []);
    expect(t).toMatchObject({ total: 134, registered: 0, source: 'scopes', overRegistered: false });
  });

  it('Total 134 with 42 registered stays 134 (registered never becomes the Total)', () => {
    const t = projectTotals(project('PRJ-001', 0), [scope('s1', 'PRJ-001', 134)], cases('s1', 'PRJ-001', 42));
    expect(t.total).toBe(134);
    expect(t.registered).toBe(42);
    expect(t.scopes[0]).toMatchObject({ total: 134, registered: 42, overRegistered: false });
  });

  it('Total equal to the registered count is fine', () => {
    const t = projectTotals(project('PRJ-001', 0), [scope('s1', 'PRJ-001', 5)], cases('s1', 'PRJ-001', 5));
    expect(t).toMatchObject({ total: 5, registered: 5, overRegistered: false });
    expect(registeredWarning(t)).toBeNull();
  });

  it('registered MORE than the Total: warns, and changes nothing (no clamping, no auto-increase, no deletion)', () => {
    const list = cases('s1', 'PRJ-001', 137);
    const t = projectTotals(project('PRJ-001', 0), [scope('s1', 'PRJ-001', 134)], list);
    expect(t.total).toBe(134);
    expect(t.registered).toBe(137);
    expect(t.overRegistered).toBe(true);
    expect(registeredWarning(t)).toEqual({ registered: 137, total: 134 });
    expect(list).toHaveLength(137);
  });

  it('archived cases are not registered; cases in an archived scope are not registered', () => {
    const t = projectTotals(project('PRJ-001', 0), [scope('s1', 'PRJ-001', 10), scope('s2', 'PRJ-001', 10, 'archived')], [...cases('s1', 'PRJ-001', 3), ...cases('s1', 'PRJ-001', 4, 'archived'), ...cases('s2', 'PRJ-001', 9)]);
    expect(t.registered).toBe(3);
    expect(t.total).toBe(10);
  });
});

describe('the project Total is derived from its scopes, and legacy projects are unchanged', () => {
  const p = project('PRJ-001', 999);

  it('Ecosystem 134 + HTMA 90 + VVM 109 = 333', () => {
    const t = projectTotals(p, [scope('eco', 'PRJ-001', 134, 'active', 10), scope('htma', 'PRJ-001', 90, 'active', 20), scope('vvm', 'PRJ-001', 109, 'active', 30)], []);
    expect(t).toMatchObject({ total: 333, source: 'scopes', scopesWithoutTotal: 0 });
  });

  it('a project with no scopes keeps its own Total', () => {
    expect(projectTotals(p, [], [])).toMatchObject({ total: 999, source: 'project', activeScopes: 0 });
  });

  it('scopes without any typed Total do not change the project figure', () => {
    expect(projectTotals(p, [scope('s1', 'PRJ-001'), scope('s2', 'PRJ-001')], cases('s1', 'PRJ-001', 4))).toMatchObject({ total: 999, source: 'project', registered: 4 });
  });

  it('a scope without a Total beside scopes with one counts as 0 and is reported', () => {
    expect(projectTotals(p, [scope('s1', 'PRJ-001', 10), scope('s2', 'PRJ-001')], [])).toMatchObject({ total: 10, scopesWithoutTotal: 1 });
  });

  it('an archived scope leaves the project Total; another project\'s scopes are ignored', () => {
    const t = projectTotals(p, [scope('s1', 'PRJ-001', 10), scope('s2', 'PRJ-001', 50, 'archived'), scope('x', 'PRJ-002', 77)], []);
    expect(t.total).toBe(10);
  });

  it('a total of 0 on a scope is a real Total (not "unset")', () => {
    expect(projectTotals(p, [scope('s1', 'PRJ-001', 0)], [])).toMatchObject({ total: 0, source: 'scopes' });
  });

  it('a damaged value is treated as unset, never as a number', () => {
    const bad = { ...scope('s1', 'PRJ-001'), totalTestCases: -3 } as TestScope;
    expect(projectTotals(p, [bad], [])).toMatchObject({ total: 999, source: 'project' });
  });

  it('project-level Total (no scope totals) also warns when more cases are registered', () => {
    const t = projectTotals(project('PRJ-001', 3), [scope('s1', 'PRJ-001')], cases('s1', 'PRJ-001', 5));
    expect(t).toMatchObject({ total: 3, registered: 5, overRegistered: true });
  });
});

describe('what the SV types', () => {
  it('parses integers, blank and rubbish', () => {
    expect(parseTotalInput('134')).toBe(134);
    expect(parseTotalInput(' １３４ ')).toBe(134); // full-width digits
    expect(parseTotalInput('0')).toBe(0);
    expect(parseTotalInput('')).toBeUndefined();
    for (const bad of ['-1', '1.5', '12a', 'abc', '99999999', '1e3']) expect(parseTotalInput(bad)).toBeNull();
    expect(cleanTotal(1_000_001)).toBeNull();
    expect(cleanTotal(1.2)).toBeNull();
  });

  it('editing a scope Total changes only that record; a blank clears it; an unchanged value is not a change', () => {
    const s = scope('s1', 'PRJ-001', 5);
    const made = editScope({ scopes: [s] }, 's1', { totalTestCases: 150 }, NOW);
    expect(made.ok && made.value.totalTestCases).toBe(150);
    const cleared = editScope({ scopes: [s] }, 's1', { totalTestCases: null }, NOW);
    expect(cleared.ok && 'totalTestCases' in cleared.value).toBe(false);
    const same = editScope({ scopes: [s] }, 's1', { totalTestCases: 5 }, '2027-01-01T00:00:00.000Z');
    expect(same.ok && same.value).toEqual(s);
    expect(editScope({ scopes: [s] }, 's1', { totalTestCases: -1 }, NOW)).toEqual({ ok: false, error: 'scope_invalid_total' });
    expect(editScope({ scopes: [s] }, 's1', { totalTestCases: 2.5 }, NOW)).toEqual({ ok: false, error: 'scope_invalid_total' });
  });

  it('a new scope may carry a Total; an invalid one is refused', () => {
    const ok = newScope({ scopes: [] }, { projectId: 'PRJ-001', name: 'Eco', totalTestCases: 134 }, NOW);
    expect(ok.ok && ok.value.totalTestCases).toBe(134);
    expect(newScope({ scopes: [] }, { projectId: 'PRJ-001', name: 'Eco', totalTestCases: -5 }, NOW)).toEqual({ ok: false, error: 'scope_invalid_total' });
  });
});

describe('the stored figure every screen reads follows the derived Total', () => {
  it('reconcile writes the sum into inputs.totalCases, only for projects that derive it', () => {
    const a = project('PRJ-001', 1);
    const b = project('PRJ-002', 77);
    const out = reconcileProjectTotals([a, b], [scope('s1', 'PRJ-001', 134), scope('s2', 'PRJ-001', 90)], [], NOW);
    expect(out[0].inputs.totalCases).toBe(224);
    expect(out[1]).toBe(b); // legacy project: same reference, untouched
  });

  it('is idempotent: nothing differs, nothing is written (same array back)', () => {
    const a = project('PRJ-001', 224);
    const list = [a];
    expect(reconcileProjectTotals(list, [scope('s1', 'PRJ-001', 134), scope('s2', 'PRJ-001', 90)], [], NOW)).toBe(list);
  });

  it('registering or archiving cases never moves the stored Total', () => {
    const a = project('PRJ-001', 134);
    const sc = [scope('s1', 'PRJ-001', 134)];
    expect(reconcileProjectTotals([a], sc, cases('s1', 'PRJ-001', 42), NOW)[0].inputs.totalCases).toBe(134);
    expect(reconcileProjectTotals([a], sc, [], NOW)[0].inputs.totalCases).toBe(134);
  });

  it('derivedTotalFor says when the editing surface must be read-only', () => {
    const a = project('PRJ-001', 5);
    expect(derivedTotalFor(a, [], [])).toBeNull();
    expect(derivedTotalFor(a, [scope('s1', 'PRJ-001', 9)], [])).toBe(9);
    expect(derivedTotalFor(undefined, [scope('s1', 'PRJ-001', 9)], [])).toBeNull();
  });

  it('editing the Total updates the derived project figure (134 -> 150)', () => {
    const a = project('PRJ-001', 0);
    const first = reconcileProjectTotals([a], [scope('s1', 'PRJ-001', 134)], [], NOW);
    const after = reconcileProjectTotals(first, [scope('s1', 'PRJ-001', 150)], [], NOW);
    expect([first[0].inputs.totalCases, after[0].inputs.totalCases]).toEqual([134, 150]);
  });
});

describe('registered-case execution is detail only and is not the overall progress', () => {
  it('30 completed of 42 registered is 71% DETAILED coverage; the Total stays 134', () => {
    const list = cases('s1', 'PRJ-001', 42);
    const results = list.slice(0, 30).map((c) => ({ id: `res_${c.id}`, projectId: 'PRJ-001', scopeId: 's1', testCaseId: c.id, status: 'pass' as const, retest: false, question: false, updatedByUserId: null, updatedAt: NOW }));
    const sum = summarize(list, resultsByCase(results));
    expect(sum.completed).toBe(30);
    expect(detailedCoverage(sum.completed, sum.total)).toBeCloseTo(30 / 42);
    expect(detailedCoverage(0, 0)).toBeNull();
    expect(projectTotals(project('PRJ-001', 0), [scope('s1', 'PRJ-001', 134)], list).total).toBe(134);
  });
});

describe('server rules for the Total (shared validators)', () => {
  const view = (projects = ['PRJ-001']) => ({
    get: () => null as string | null,
    list: (kind: string) => (kind === 'project' ? projects.map((p, i) => ({ id: `p${i}`, json: JSON.stringify({ id: `p${i}`, projectId: p }) })) : []),
  });
  const put = (s: unknown) => ({ kind: 'scope', id: (s as { id: string }).id, json: JSON.stringify(s) });

  it('accepts a whole number and rejects negatives, fractions, text and huge values', () => {
    expect(checkScope(scope('s1', 'PRJ-001', 134)).ok).toBe(true);
    for (const bad of [-1, 1.5, '12', Number.NaN, 1_000_001, null]) {
      expect(checkScope({ ...scope('s1', 'PRJ-001'), totalTestCases: bad }).ok).toBe(false);
    }
  });

  it('an SV may set it; a Tester may not (scopes are the SV\'s)', () => {
    const next = put(scope('s1', 'PRJ-001', 134));
    expect(testManagementCommitError({ puts: [next], deletes: [], view: view(), isSv: true, userId: 'usr_sv', today: '2026-10-08' })).toBeNull();
    expect(testManagementCommitError({ puts: [next], deletes: [], view: view(), isSv: false, userId: 'usr_t', today: '2026-10-08' })).toBe('scope_sv_only');
  });

  it('an invalid Total is refused on commit', () => {
    const bad = put({ ...scope('s1', 'PRJ-001'), totalTestCases: -4 });
    expect(testManagementCommitError({ puts: [bad], deletes: [], view: view(), isSv: true, userId: 'usr_sv', today: '2026-10-08' })).toBe('scope_invalid_total');
  });

  it('a Tester cannot change a Total by editing an existing scope either', () => {
    const existing = JSON.stringify(scope('s1', 'PRJ-001', 134));
    const v = { ...view(), get: (_k: string, id: string) => (id === 's1' ? existing : null) };
    const edit = put(scope('s1', 'PRJ-001', 999));
    expect(testManagementCommitError({ puts: [edit], deletes: [], view: v, isSv: false, userId: 'usr_t', today: '2026-10-08' })).toBe('scope_sv_only');
  });
});

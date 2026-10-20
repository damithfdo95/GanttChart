import { describe, expect, it } from 'vitest';
import { passedPct, runProgressFromCounts, type TestRailRunProgress, type TestRailRunRef } from '../../shared/testrail';
import { checkScope, TM_LIMITS, testManagementCommitError, type TestScope } from '../../shared/testManagement';
import { newScope } from '../domain/testManagement';
import { defaultScopeName, planImportRows } from '../domain/testManagement/testrailScopeImport';
import { editScope } from '../domain/testManagement';

const NOW = '2026-10-20T09:00:00.000Z';
const P = 'PRJ-001';

const scope = (over: Partial<TestScope> = {}): TestScope => ({ id: 'scp_1', projectId: P, name: 'Ecosystem', code: 'ECO', status: 'active', order: 10, createdAt: NOW, updatedAt: NOW, ...over });

const run = (over: Partial<TestRailRunRef> = {}): TestRailRunRef => ({
  id: 9001,
  name: 'Chrome',
  config: 'Chrome',
  planId: 32716,
  progress: { passed: 10, blocked: 2, retest: 1, failed: 3, untested: 20, custom: 9, total: 45 },
  ...over,
});

describe('runProgressFromCounts (shared mapper)', () => {
  it('maps all nine flat count fields and sums them into total', () => {
    const raw = {
      passed_count: 10,
      blocked_count: 2,
      retest_count: 1,
      failed_count: 3,
      untested_count: 20,
      custom_status1_count: 4,
      custom_status2_count: 5,
      custom_status3_count: 0,
      custom_status4_count: 0,
      custom_status5_count: 0,
      custom_status6_count: 0,
      custom_status7_count: 0,
    };
    const p = runProgressFromCounts(raw);
    expect(p).toEqual({ passed: 10, blocked: 2, retest: 1, failed: 3, untested: 20, custom: 9, total: 45 });
  });

  it('treats missing custom fields (older servers) as 0', () => {
    const p = runProgressFromCounts({ passed_count: 4, untested_count: 6 });
    expect(p).toEqual({ passed: 4, blocked: 0, retest: 0, failed: 0, untested: 6, custom: 0, total: 10 });
  });

  it('maps an empty/absent payload to all zeros with total 0', () => {
    const p = runProgressFromCounts({});
    expect(p).toEqual({ passed: 0, blocked: 0, retest: 0, failed: 0, untested: 0, custom: 0, total: 0 });
  });

  it('is defensive: string numbers count, garbage and negatives never poison the sum', () => {
    const p = runProgressFromCounts({ passed_count: '7', failed_count: -3, untested_count: 'x', custom_status1_count: 1.9 });
    expect(p.passed).toBe(7);
    expect(p.failed).toBe(0);
    expect(p.untested).toBe(0);
    expect(p.custom).toBe(1); // truncated, never a fractional total
    expect(p.total).toBe(8);
  });
});

describe('passedPct', () => {
  it('is passed / total (the TestRail plan convention)', () => {
    const p: TestRailRunProgress = { passed: 25, blocked: 5, retest: 2, failed: 3, untested: 10, custom: 5, total: 50 };
    expect(passedPct(p)).toBeCloseTo(0.5);
  });

  it('is 0 for an empty run — never NaN', () => {
    const empty: TestRailRunProgress = { passed: 0, blocked: 0, retest: 0, failed: 0, untested: 0, custom: 0, total: 0 };
    expect(passedPct(empty)).toBe(0);
    expect(Number.isFinite(passedPct(empty))).toBe(true);
  });
});

describe('defaultScopeName', () => {
  it('collapses and hard-caps the run name at TM_LIMITS.scopeName', () => {
    expect(defaultScopeName('  Chrome   Sanity  ', 5)).toBe('Chrome Sanity');
    const long = 'R '.repeat(TM_LIMITS.scopeName + 20);
    expect(defaultScopeName(long, 5)).toHaveLength(TM_LIMITS.scopeName);
  });

  it('falls back to "Run {id}" for a run without a usable name', () => {
    expect(defaultScopeName('   \n ', 42)).toBe('Run 42');
    expect(defaultScopeName('', 42)).toBe('Run 42');
  });
});

describe('planImportRows', () => {
  it('plans one importable row per run with the default name and the run total', () => {
    const plan = planImportRows([run({ id: 9001, name: 'Chrome' }), run({ id: 9002, name: 'Android 14' })], [], P);
    expect(plan.rows).toHaveLength(2);
    expect(plan.rows.every((r) => r.importable && r.skipReason === null)).toBe(true);
    expect(plan.importableCount).toBe(2);
    expect(plan.duplicateCount).toBe(0);
    expect(plan.rows[0]).toMatchObject({ name: 'Chrome', totalTestCases: 45 });
  });

  it('skips a run whose runId is already linked by ANY scope of the same project', () => {
    const existing = [scope({ id: 'scp_linked', testrail: { planId: 32716, runId: 9001 } })];
    const plan = planImportRows([run({ id: 9001 }), run({ id: 9002 })], existing, P);
    expect(plan.duplicateCount).toBe(1);
    expect(plan.importableCount).toBe(1);
    expect(plan.rows[0]).toMatchObject({ importable: false, skipReason: 'duplicate' });
    expect(plan.rows[1]).toMatchObject({ importable: true, skipReason: null });
  });

  it('does NOT treat a link in another project as a duplicate of this one', () => {
    const other = [scope({ id: 'scp_other', projectId: 'PRJ-002', testrail: { planId: 32716, runId: 9001 } })];
    const plan = planImportRows([run({ id: 9001 })], other, P);
    expect(plan.duplicateCount).toBe(0);
    expect(plan.rows[0].importable).toBe(true);
  });

  it('skips a run appearing twice inside one plan (second occurrence)', () => {
    const plan = planImportRows([run({ id: 9001 }), run({ id: 9002 }), run({ id: 9001 })], [], P);
    expect(plan.duplicateCount).toBe(1);
    expect(plan.rows.map((r) => [r.run.id, r.importable])).toEqual([
      [9001, true],
      [9002, true],
      [9001, false],
    ]);
  });

  it('defaults totalTestCases to 0 when the run carries no counts', () => {
    const plan = planImportRows([run({ progress: undefined })], [], P);
    expect(plan.rows[0].totalTestCases).toBe(0);
  });

  it('leaves the input runs untouched (pure planning)', () => {
    const runs = [run(), run({ id: 9001 })];
    const snapshot = JSON.stringify(runs);
    planImportRows(runs, [scope({ testrail: { planId: 32716, runId: 9001 } })], P);
    expect(JSON.stringify(runs)).toBe(snapshot);
  });
});

describe('the TestRail link on scopes (shared validator + commit path)', () => {
  it('checkScope accepts a scope without the link (absent = fine)', () => {
    expect(checkScope(scope()).ok).toBe(true);
  });

  it('checkScope accepts a well-formed link (positive integers)', () => {
    expect(checkScope(scope({ testrail: { planId: 32716, runId: 9001 } })).ok).toBe(true);
  });

  it('checkScope rejects a malformed link (negative, non-integer, string, missing field)', () => {
    const bad = [
      { planId: -1, runId: 9001 },
      { planId: 32716, runId: 0 },
      { planId: 32716.5, runId: 9001 },
      { planId: '32716', runId: 9001 },
      { planId: 32716 },
      { planId: null, runId: 9001 },
      'planId:runId',
    ];
    for (const link of bad) {
      const check = checkScope(scope({ testrail: link as never }));
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.error).toBe('scope_invalid_testrail');
    }
  });

  it('newScope commits a scope carrying the link, and the commit validator accepts it (SV)', () => {
    const made = newScope({ scopes: [] }, { projectId: P, name: 'Chrome', totalTestCases: 45, testrail: { planId: 32716, runId: 9001 } }, NOW, 'scp_new');
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.value.testrail).toEqual({ planId: 32716, runId: 9001 });
    expect(made.value.totalTestCases).toBe(45);
    expect(checkScope(made.value).ok).toBe(true);
    const view = { get: () => null as string | null, list: (kind: string) => (kind === 'project' ? [{ id: 'p1', json: JSON.stringify({ id: 'p1', projectId: P }) }] : []) };
    const put = { kind: 'scope', id: made.value.id, json: JSON.stringify(made.value) };
    expect(testManagementCommitError({ puts: [put], deletes: [], view, isSv: true, userId: 'usr_sv', today: '2026-10-20' })).toBeNull();
  });

  it('newScope rejects a malformed link without writing', () => {
    const made = newScope({ scopes: [] }, { projectId: P, name: 'Chrome', testrail: { planId: -1, runId: 9001 } }, NOW);
    expect(made).toEqual({ ok: false, error: 'scope_invalid_testrail' });
  });

  it('editScope preserves the link (the existing edit path never strips it)', () => {
    const s = scope({ testrail: { planId: 32716, runId: 9001 } });
    const edited = editScope({ scopes: [s] }, 'scp_1', { name: 'Renamed' }, NOW);
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.value.testrail).toEqual({ planId: 32716, runId: 9001 });
    expect(edited.value.name).toBe('Renamed');
  });

  it('two newScope calls in one batch get distinct orders (multi-scope import)', () => {
    const first = newScope({ scopes: [] }, { projectId: P, name: 'A', testrail: { planId: 1, runId: 1 } }, NOW, 'scp_a');
    if (!first.ok) throw new Error('first failed');
    const second = newScope({ scopes: [first.value] }, { projectId: P, name: 'B', testrail: { planId: 1, runId: 2 } }, NOW, 'scp_b');
    if (!second.ok) throw new Error('second failed');
    expect(second.value.order).toBeGreaterThan(first.value.order);
  });
});
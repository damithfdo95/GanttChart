import { describe, expect, it } from 'vitest';
import {
  EMPTY_SUMMARY,
  applyResultPatch,
  assignedScopes,
  buildBulkCases,
  editScope,
  editTestCase,
  filterCases,
  moveInOrder,
  newScope,
  newTestCase,
  parseBulkCases,
  projectOverview,
  resultsByCase,
  scopeAssigneeIds,
  setCaseStatus,
  setScopeStatus,
  summarize,
  upsertResult,
  caseResultId,
  nextCaseKey,
  type CaseResult,
  type CaseStatus,
  type TestCase,
  type TestScope,
} from '../domain/testManagement';
import { pct } from '../features/testManagement/SummaryParts';
import type { TesterProjectAssignment } from '../types';

const NOW = '2026-10-07T09:00:00.000Z';
const P = 'PRJ-001';

const scope = (over: Partial<TestScope> = {}): TestScope => ({ id: 'scp_1', projectId: P, name: 'Ecosystem', code: 'ECO', status: 'active', order: 10, createdAt: NOW, updatedAt: NOW, ...over });
const tcase = (n: number, over: Partial<TestCase> = {}): TestCase => ({ id: `tc_${n}`, projectId: P, scopeId: 'scp_1', key: `ECO-${String(n).padStart(3, '0')}`, title: `Case ${n}`, priority: 'medium', status: 'active', order: n * 10, createdAt: NOW, updatedAt: NOW, ...over });
const result = (n: number, status: CaseStatus, over: Partial<CaseResult> = {}): CaseResult => ({ id: caseResultId(`tc_${n}`), projectId: P, scopeId: 'scp_1', testCaseId: `tc_${n}`, status, retest: false, question: false, updatedByUserId: 'usr_a', updatedAt: NOW, ...over });

describe('summary formulas', () => {
  const cases = Array.from({ length: 12 }, (_, i) => tcase(i + 1));
  const results = [
    result(1, 'pass'), result(2, 'pass'), result(3, 'pass'), result(4, 'fail'), result(5, 'na'), result(6, 'spo'),
    result(7, 'blocked'), result(8, 'inProgress'), result(9, 'pass', { retest: true }), result(10, 'fail', { question: true }),
  ];
  const s = summarize(cases, resultsByCase(results));

  it('counts every status once', () => {
    expect(s).toMatchObject({ total: 12, pass: 4, fail: 2, na: 1, spo: 1, blocked: 1, inProgress: 1, notStarted: 2 });
  });

  it('Started = everything but Not Started; Completed = Pass + Fail + N/A + SPO', () => {
    expect(s.started).toBe(10);
    expect(s.completed).toBe(8);
  });

  it('Blocked and In Progress are NOT completed, so they stay in Remaining', () => {
    expect(s.remaining).toBe(4); // total 12 - completed 8 (blocked, in progress and the two untouched cases)
    expect(s.remaining).toBe(s.blocked + s.inProgress + s.notStarted + 0 * s.completed);
  });

  it('Progress = Completed / Total; Pass Rate = Pass / (Pass + Fail), never Pass / Total', () => {
    expect(s.progress).toBeCloseTo(8 / 12, 10);
    expect(s.passRate).toBeCloseTo(4 / 6, 10);
    expect(s.passRate).not.toBeCloseTo(4 / 12, 5);
  });

  it('Retest and Question are flags counted across cases, not statuses', () => {
    expect([s.retest, s.question]).toEqual([1, 1]);
    expect(s.pass + s.fail + s.na + s.spo + s.blocked + s.inProgress + s.notStarted).toBe(s.total);
  });

  it('zero denominators give "no value", shown as a dash, never NaN or #DIV/0!', () => {
    const none = summarize([], new Map());
    expect(none).toEqual({ ...EMPTY_SUMMARY });
    expect(none.progress).toBeNull();
    expect(none.passRate).toBeNull();
    expect(summarize([tcase(1)], resultsByCase([result(1, 'na')])).passRate).toBeNull(); // nothing passed or failed
    expect(pct(null)).toBe('—');
    expect(pct(NaN)).toBe('—');
    expect(pct(0.8123)).toBe('81.2%');
    expect(pct(1)).toBe('100.0%');
    expect(pct(0)).toBe('0.0%');
  });

  it('archived cases are excluded from every number, results included', () => {
    const withArchived = [...cases, tcase(13, { status: 'archived' })];
    const r = [...results, result(13, 'pass')];
    const t = summarize(withArchived, resultsByCase(r));
    expect(t.total).toBe(12);
    expect(t.pass).toBe(4);
  });

  it('a case with no result at all is Not Started', () => {
    expect(summarize([tcase(1), tcase(2)], new Map()).notStarted).toBe(2);
  });

  it('the project total covers ACTIVE scopes only', () => {
    const scopes = [scope(), scope({ id: 'scp_2', name: 'HTMA', code: 'HTMA', status: 'archived', order: 20 })];
    const cs = [tcase(1), tcase(2), { ...tcase(3), id: 'tc_h1', scopeId: 'scp_2', key: 'HTMA-001' }];
    const o = projectOverview(P, { scopes, testCases: cs, caseResults: [result(1, 'pass')] });
    expect(o.rows.map((r) => [r.scope.name, r.summary.total])).toEqual([['Ecosystem', 2], ['HTMA', 1]]);
    expect(o.total.total).toBe(2);
  });
});

describe('scopes', () => {
  const state = { scopes: [scope()] };

  it('creates a scope with a normalised code and the next display position', () => {
    const made = newScope(state, { projectId: P, name: '  HTMA  ', code: ' htma ' }, NOW, 'scp_2');
    expect(made).toMatchObject({ ok: true, value: { name: 'HTMA', code: 'HTMA', status: 'active', order: 20, projectId: P } });
  });

  it('refuses an empty name, a malformed code and a code already used in the project; the same code in another project is fine', () => {
    expect(newScope(state, { projectId: P, name: '  ' }, NOW)).toEqual({ ok: false, error: 'scope_invalid_name' });
    expect(newScope(state, { projectId: P, name: 'X', code: 'bad code!' }, NOW)).toEqual({ ok: false, error: 'scope_invalid_code' });
    expect(newScope(state, { projectId: P, name: 'Again', code: 'eco' }, NOW)).toEqual({ ok: false, error: 'scope_code_taken' });
    expect(newScope(state, { projectId: 'PRJ-002', name: 'Eco too', code: 'ECO' }, NOW).ok).toBe(true);
  });

  it('a scope needs no code', () => {
    const made = newScope(state, { projectId: P, name: 'VVM' }, NOW);
    expect(made.ok && made.value.code).toBeUndefined();
  });

  it('renaming a scope keeps its id, its project and its existing case keys', () => {
    const cases = [tcase(1)];
    const made = editScope(state, 'scp_1', { name: 'Ecosystem 2' }, '2026-10-08T00:00:00.000Z');
    expect(made).toMatchObject({ ok: true, value: { id: 'scp_1', name: 'Ecosystem 2', code: 'ECO', projectId: P } });
    expect(cases[0].key).toBe('ECO-001');
    expect(editScope(state, 'nope', { name: 'x' }, NOW)).toEqual({ ok: false, error: 'scope_not_found' });
  });

  it('archive and reactivate', () => {
    const archived = setScopeStatus(scope(), 'archived', NOW);
    expect(archived.status).toBe('archived');
    expect(setScopeStatus(archived, 'active', NOW).status).toBe('active');
    const s = scope();
    expect(setScopeStatus(s, 'active', NOW)).toBe(s); // nothing to change, same object
  });

  it('moves a scope up or down by swapping display positions', () => {
    const list = [scope({ id: 'a', order: 10 }), scope({ id: 'b', order: 20 }), scope({ id: 'c', order: 30 })];
    expect(moveInOrder(list, 'b', -1).map((x) => [x.id, x.order])).toEqual([['b', 10], ['a', 20]]);
    expect(moveInOrder(list, 'a', -1)).toEqual([]);
    expect(moveInOrder(list, 'c', 1)).toEqual([]);
  });

  it('a project without any scope is simply empty', () => {
    expect(projectOverview('PRJ-009', { scopes: [scope()], testCases: [], caseResults: [] })).toEqual({ rows: [], total: { ...EMPTY_SUMMARY } });
  });
});

describe('test cases and their keys', () => {
  const base = { scopes: [scope()], testCases: [] as TestCase[] };

  it('creates a case in a scope with the next key and stable internal ids', () => {
    const a = newTestCase(base, 'scp_1', { title: 'Login with existing account', priority: 'high', expected: 'Home opens' }, NOW);
    expect(a).toMatchObject({ ok: true, value: { key: 'ECO-001', title: 'Login with existing account', priority: 'high', scopeId: 'scp_1', projectId: P, status: 'active' } });
    if (!a.ok) return;
    expect(a.value.id).toMatch(/^tc_/);
    const b = newTestCase({ ...base, testCases: [a.value] }, 'scp_1', { title: 'Second' }, NOW);
    expect(b.ok && b.value.key).toBe('ECO-002');
    expect(b.ok && b.value.id).not.toBe(a.value.id);
  });

  it('the key comes from the highest number ever used (archived included) - nothing is renumbered or reused', () => {
    const cs = [tcase(1), tcase(2), tcase(5, { status: 'archived' })];
    expect(nextCaseKey('ECO', cs.map((c) => c.key))).toBe('ECO-006');
    const made = newTestCase({ scopes: [scope()], testCases: cs }, 'scp_1', { title: 'New' }, NOW);
    expect(made.ok && made.value.key).toBe('ECO-006');
    expect(cs.map((c) => c.key)).toEqual(['ECO-001', 'ECO-002', 'ECO-005']); // untouched
  });

  it('a scope without a code uses the TC prefix', () => {
    const made = newTestCase({ scopes: [scope({ code: undefined })], testCases: [] }, 'scp_1', { title: 'x' }, NOW);
    expect(made.ok && made.value.key).toBe('TC-001');
  });

  it('an explicit key is normalised, must be valid and must be unique in the PROJECT (any scope, archived too)', () => {
    const other = tcase(1, { scopeId: 'scp_2', key: 'SHARED-1' });
    const st = { scopes: [scope(), scope({ id: 'scp_2', code: 'HTMA' })], testCases: [other] };
    expect(newTestCase(st, 'scp_1', { key: ' shared-2 ', title: 'x' }, NOW)).toMatchObject({ ok: true, value: { key: 'SHARED-2' } });
    expect(newTestCase(st, 'scp_1', { key: 'shared-1', title: 'x' }, NOW)).toEqual({ ok: false, error: 'testcase_key_taken' });
    expect(newTestCase(st, 'scp_1', { key: 'bad key', title: 'x' }, NOW)).toEqual({ ok: false, error: 'testcase_invalid_key' });
    expect(newTestCase({ ...st, testCases: [{ ...other, status: 'archived' }] }, 'scp_1', { key: 'SHARED-1', title: 'x' }, NOW)).toEqual({ ok: false, error: 'testcase_key_taken' });
  });

  it('refuses a missing scope, an archived scope, an empty title and an unknown priority', () => {
    expect(newTestCase(base, 'nope', { title: 'x' }, NOW)).toEqual({ ok: false, error: 'scope_not_found' });
    expect(newTestCase({ scopes: [scope({ status: 'archived' })], testCases: [] }, 'scp_1', { title: 'x' }, NOW)).toEqual({ ok: false, error: 'scope_archived' });
    expect(newTestCase(base, 'scp_1', { title: '   ' }, NOW)).toEqual({ ok: false, error: 'testcase_invalid_title' });
    expect(newTestCase(base, 'scp_1', { title: 'x', priority: 'urgent' as never }, NOW)).toEqual({ ok: false, error: 'testcase_invalid_priority' });
  });

  it('editing never changes the key, the scope, the project or the id', () => {
    const prev = tcase(1);
    const made = editTestCase(prev, { title: 'New title', priority: 'high', tags: ['smoke', ' login '] }, '2026-10-08T00:00:00.000Z');
    expect(made).toMatchObject({ ok: true, value: { id: 'tc_1', key: 'ECO-001', scopeId: 'scp_1', projectId: P, title: 'New title', priority: 'high', tags: ['smoke', 'login'] } });
    expect(editTestCase(prev, { title: ' ' }, NOW)).toEqual({ ok: false, error: 'testcase_invalid_title' });
  });

  it('archive and reactivate keep the case; an archived case leaves the active count', () => {
    const archived = setCaseStatus(tcase(1), 'archived', NOW);
    expect(archived.status).toBe('archived');
    expect(summarize([archived, tcase(2)], new Map()).total).toBe(1);
    expect(setCaseStatus(archived, 'active', NOW).status).toBe('active');
  });
});

describe('bulk add (paste from a spreadsheet)', () => {
  it('reads Excel-style tab-separated rows: key, title, priority, type, expected', () => {
    const text = 'ECO-001\tLogin with existing account\tHigh\tFunctional\tUser reaches Home\nECO-002\tLogout\t\t\t\r\n\r\nECO-003\tProfile photo\tLow';
    const r = parseBulkCases(text, []);
    expect(r.ok).toBe(true);
    expect(r.rows).toEqual([
      { line: 1, key: 'ECO-001', title: 'Login with existing account', priority: 'high', type: 'Functional', expected: 'User reaches Home' },
      { line: 2, key: 'ECO-002', title: 'Logout', priority: 'medium' },
      { line: 4, key: 'ECO-003', title: 'Profile photo', priority: 'low' },
    ]);
  });

  it('skips a header line (English or Japanese)', () => {
    expect(parseBulkCases('Key\tTitle\tPriority\nA-1\tFirst', []).rows).toHaveLength(1);
    expect(parseBulkCases('キー\tタイトル\n甲-1\t最初', []).errors[0]?.code).toBe('bulk_invalid_key'); // full-width key is not valid, header was skipped
    expect(parseBulkCases('キー\tタイトル\nA-1\tログインできること', []).rows[0]).toMatchObject({ key: 'A-1', title: 'ログインできること' });
  });

  it('a single column is just a title (the key is given later); keys are upper-cased', () => {
    const r = parseBulkCases('Only a title\neco-9\tNine', []);
    expect(r.rows[0]).toEqual({ line: 1, title: 'Only a title', priority: 'medium' });
    expect(r.rows[1].key).toBe('ECO-9');
  });

  it('reports every problem with its line and saves nothing: duplicates, existing keys, bad keys, missing titles, bad priorities', () => {
    const text = ['A-1\tFirst', 'A-1\tDuplicate', 'B-2\tAlready there', 'bad key\tX', 'C-3\t', 'D-4\tFine\turgent'].join('\n');
    const r = parseBulkCases(text, ['B-2']);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => [e.line, e.code])).toEqual([
      [2, 'bulk_duplicate_key_in_paste'],
      [3, 'bulk_key_exists'],
      [4, 'bulk_invalid_key'],
      [5, 'bulk_missing_title'],
      [6, 'bulk_invalid_priority'],
    ]);
    expect(r.rows.map((x) => x.key)).toEqual(['A-1']); // the one valid line is only ever a preview
  });

  it('Japanese priorities and Japanese text survive', () => {
    const r = parseBulkCases('J-1\tホームに遷移する\t高\t機能\t期待どおり', []);
    expect(r.rows[0]).toMatchObject({ priority: 'high', title: 'ホームに遷移する', type: '機能', expected: '期待どおり' });
  });

  it('empty and oversized pastes are refused', () => {
    expect(parseBulkCases('  \n \n', []).errors).toEqual([{ line: 0, code: 'bulk_empty' }]);
    const many = Array.from({ length: 501 }, (_, i) => `K-${i + 1}\tCase ${i + 1}`).join('\n');
    expect(parseBulkCases(many, []).errors.some((e) => e.code === 'bulk_too_many_rows')).toBe(true);
  });

  it('a large reasonable batch (500 rows) is accepted and builds 500 distinct cases in one go', () => {
    const text = Array.from({ length: 500 }, (_, i) => `K-${i + 1}\tCase ${i + 1}\tHigh`).join('\n');
    const parsed = parseBulkCases(text, []);
    expect(parsed.ok).toBe(true);
    const built = buildBulkCases({ scopes: [scope()], testCases: [] }, 'scp_1', parsed.rows, NOW);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(new Set(built.value.map((c) => c.key)).size).toBe(500);
    expect(new Set(built.value.map((c) => c.id)).size).toBe(500);
    expect(built.value.map((c) => c.order)).toEqual([...built.value.map((c) => c.order)].sort((a, b) => a - b));
  });

  it('rows without a key get the next free keys, never one the sheet itself uses or one already used (archived included)', () => {
    const existing = [tcase(1, { status: 'archived' })];
    const parsed = parseBulkCases('One\nECO-003\tThree\nTwo', ['ECO-001']);
    const built = buildBulkCases({ scopes: [scope()], testCases: existing }, 'scp_1', parsed.rows, NOW);
    expect(built.ok && built.value.map((c) => c.key)).toEqual(['ECO-004', 'ECO-003', 'ECO-005']);
  });
});

describe('recording a result', () => {
  const tc = { id: 'tc_1', projectId: P, scopeId: 'scp_1' };

  it('the first change creates the result with the actor and time; nothing exists before', () => {
    const r = applyResultPatch(undefined, tc, { status: 'pass' }, 'usr_a', NOW)!;
    expect(r).toMatchObject({ id: 'res_tc_1', testCaseId: 'tc_1', status: 'pass', retest: false, question: false, updatedByUserId: 'usr_a', executedByUserId: 'usr_a', executedAt: NOW });
  });

  it('writes NOTHING when nothing changes (clicking the status that is already set, a blank memo, an empty first patch)', () => {
    const r = applyResultPatch(undefined, tc, { status: 'pass' }, 'usr_a', NOW)!;
    expect(applyResultPatch(r, tc, { status: 'pass' }, 'usr_a', '2026-10-07T10:00:00.000Z')).toBeNull();
    expect(applyResultPatch(r, tc, { memo: '' }, 'usr_a', NOW)).toBeNull();
    expect(applyResultPatch(undefined, tc, {}, 'usr_a', NOW)).toBeNull();
    expect(applyResultPatch(undefined, tc, { status: 'notStarted', memo: '  ' }, 'usr_a', NOW)).toBeNull();
  });

  it('flags, memo, device and OS are kept with the result; trimmed; cleared by blanking', () => {
    let r = applyResultPatch(undefined, tc, { status: 'fail' }, 'usr_a', NOW)!;
    r = applyResultPatch(r, tc, { retest: true, question: true, memo: '  crashes on rotate ', device: 'Galaxy S23', os: 'Android 15' }, 'usr_b', '2026-10-07T10:00:00.000Z')!;
    expect(r).toMatchObject({ status: 'fail', retest: true, question: true, memo: 'crashes on rotate', device: 'Galaxy S23', os: 'Android 15', updatedByUserId: 'usr_b' });
    expect(r.executedByUserId).toBe('usr_a'); // who set the status does not change when only the memo does
    const cleared = applyResultPatch(r, tc, { memo: '' }, 'usr_b', '2026-10-07T11:00:00.000Z')!;
    expect(cleared.memo).toBeUndefined();
  });

  it('changing the status again records the new executor', () => {
    let r = applyResultPatch(undefined, tc, { status: 'inProgress' }, 'usr_a', NOW)!;
    r = applyResultPatch(r, tc, { status: 'pass' }, 'usr_b', '2026-10-07T10:00:00.000Z')!;
    expect([r.executedByUserId, r.executedAt]).toEqual(['usr_b', '2026-10-07T10:00:00.000Z']);
  });

  it('rejects an impossible status', () => {
    expect(applyResultPatch(undefined, tc, { status: 'done' as never }, 'usr_a', NOW)).toBeNull();
  });

  it('upsert replaces by id and appends otherwise', () => {
    const a = result(1, 'pass');
    expect(upsertResult([a], { ...a, status: 'fail' })).toEqual([{ ...a, status: 'fail' }]);
    expect(upsertResult([a], result(2, 'pass'))).toHaveLength(2);
  });
});

describe('who may work on which scope', () => {
  const asg = (over: Partial<TesterProjectAssignment>): TesterProjectAssignment => ({ id: crypto.randomUUID(), projectId: P, userId: 'usr_a', testerName: 'x', startDate: '2026-10-01', active: true, ...over });
  const scopes = [scope(), scope({ id: 'scp_2', name: 'HTMA', code: 'HTMA', order: 20 }), scope({ id: 'scp_3', name: 'Old', status: 'archived', order: 30 })];
  const TODAY = '2026-10-07';

  it('a scope-level assignment covers that scope only', () => {
    expect(assignedScopes('usr_a', [asg({ scopeId: 'scp_2' })], scopes, TODAY).map((s) => s.id)).toEqual(['scp_2']);
  });

  it('a project-level assignment (every assignment before Stage 8C) covers every ACTIVE scope of the project', () => {
    expect(assignedScopes('usr_a', [asg({})], scopes, TODAY).map((s) => s.id)).toEqual(['scp_1', 'scp_2']);
    expect(assignedScopes('usr_a', [asg({ projectId: 'PRJ-009' })], scopes, TODAY)).toEqual([]);
  });

  it('ended, inactive, not yet started and other people’s assignments do not count', () => {
    expect(assignedScopes('usr_a', [asg({ endDate: '2026-10-06' })], scopes, TODAY)).toEqual([]);
    expect(assignedScopes('usr_a', [asg({ active: false })], scopes, TODAY)).toEqual([]);
    expect(assignedScopes('usr_a', [asg({ startDate: '2026-10-08' })], scopes, TODAY)).toEqual([]);
    expect(assignedScopes('usr_a', [asg({ userId: 'usr_b' })], scopes, TODAY)).toEqual([]);
    expect(assignedScopes('usr_a', [asg({ userId: undefined, memberId: 'USER0001' })], scopes, TODAY)).toEqual([]); // a roster/name assignment is not an account
  });

  it('lists the accounts on a scope, scope-level and project-level together, once each', () => {
    const list = [asg({ scopeId: 'scp_1' }), asg({ userId: 'usr_b' }), asg({ userId: 'usr_c', scopeId: 'scp_2' }), asg({ userId: 'usr_a' })];
    expect(scopeAssigneeIds(scopes[0], list, TODAY).sort()).toEqual(['usr_a', 'usr_b']);
    expect(scopeAssigneeIds(scopes[1], list, TODAY).sort()).toEqual(['usr_a', 'usr_b', 'usr_c']);
  });
});

describe('filtering and sorting cases', () => {
  const cases = [tcase(1, { priority: 'low', title: 'Alpha login', tags: ['smoke'], type: 'Functional' }), tcase(2, { priority: 'critical', title: 'Beta payment' }), tcase(3, { priority: 'high', title: 'ガンマ' }), tcase(4, { status: 'archived', title: 'Old' }), tcase(5, { scopeId: 'scp_2', key: 'HTMA-001', title: 'Other scope' })];
  const by = resultsByCase([result(1, 'pass'), result(2, 'fail', { retest: true }), result(3, 'blocked', { question: true, updatedAt: '2026-10-08T00:00:00.000Z' })]);
  const keys = (f: Parameters<typeof filterCases>[2], sort?: Parameters<typeof filterCases>[3]) => filterCases(cases, by, f, sort).map((c) => c.key);

  it('active cases only by default; scope, status, priority, tag, type and text filters', () => {
    expect(keys({})).toEqual(['ECO-001', 'ECO-002', 'ECO-003', 'HTMA-001']);
    expect(keys({ includeArchived: true })).toContain('ECO-004');
    expect(keys({ scopeId: 'scp_2' })).toEqual(['HTMA-001']);
    expect(keys({ status: 'fail' })).toEqual(['ECO-002']);
    expect(keys({ status: 'notStarted' })).toEqual(['HTMA-001']);
    expect(keys({ priority: 'high' })).toEqual(['ECO-003']);
    expect(keys({ tag: 'smoke' })).toEqual(['ECO-001']);
    expect(keys({ type: 'Functional' })).toEqual(['ECO-001']);
    expect(keys({ q: 'PAYMENT' })).toEqual(['ECO-002']);
    expect(keys({ q: 'ガンマ' })).toEqual(['ECO-003']);
    expect(keys({ q: 'eco-001' })).toEqual(['ECO-001']);
    expect(keys({ retest: true })).toEqual(['ECO-002']);
    expect(keys({ question: true })).toEqual(['ECO-003']);
  });

  it('sorts by key, priority, status and last update', () => {
    expect(keys({}, 'key')).toEqual(['ECO-001', 'ECO-002', 'ECO-003', 'HTMA-001']);
    expect(keys({}, 'priority')).toEqual(['ECO-002', 'ECO-003', 'HTMA-001', 'ECO-001']);
    expect(keys({}, 'status')[0]).toBe('ECO-002'); // failures first
    expect(keys({}, 'updated')[0]).toBe('ECO-003');
  });
});

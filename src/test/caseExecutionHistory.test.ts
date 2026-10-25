import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEMO_STATE, normalizeQaInputs } from '../lib/storage/storage';
import { newProjectRecord } from '../domain/projects/lifecycle';
import {
  appendExecutionEvents,
  caseResultId,
  checkCaseExecution,
  dailyCaseExecution,
  eventsForCase,
  executionCoverage,
  latestStatusFromHistory,
  resultsByCase,
  type CaseExecutionEvent,
  type CaseStatus,
  type TestCase,
  type TestManagementState,
  type TestScope,
} from '../domain/testManagement';
import { planTestRailResultSync } from '../domain/testManagement/testrailResults';
import { applyManualResult, applyTestRailSyncToState } from '../domain/testManagement/executionRecord';
import { createProjectBackupPayload, importProjectIntoRegistry, parseProjectBackupPayload } from '../lib/backup/projectBackup';
import { caseExecutionHistorySheet } from '../lib/export/exportData';
import { reportsToRecords, applyRecordChanges, recordKey } from '../lib/sync/records';
import { filterForTester } from '../../shared/testManagementAccess';
import { dictionaries } from '../i18n/dictionaries';
import type { QaInputs, RcsMember } from '../types';

const root = resolve(__dirname, '..');
const src = (rel: string): string => readFileSync(join(root, rel), 'utf8');
const dict = (lang: 'en' | 'ja'): Record<string, string> => dictionaries[lang] as Record<string, string>;
const NOW = '2026-10-08T01:00:00.000Z';
const P = 'PRJ-001';

const scope = (over: Partial<TestScope> = {}): TestScope => ({ id: 'scp_1', projectId: P, name: 'Ecosystem', code: 'ECO', status: 'active', order: 10, createdAt: NOW, updatedAt: NOW, totalTestCases: 420, ...over });
const tcase = (n: number, over: Partial<TestCase> = {}): TestCase => ({ id: `tc_${n}`, projectId: P, scopeId: 'scp_1', key: `ECO-${String(n).padStart(3, '0')}`, title: `Case ${n}`, priority: 'medium', status: 'active', order: n * 10, createdAt: NOW, updatedAt: NOW, ...over });
const emptyTm = (): TestManagementState => ({ scopes: [scope()], testCases: [tcase(1), tcase(2), tcase(3)], caseResults: [], caseExecutions: [] });
let seq = 0;
const ctx = (now: string, actor: string | null = 'usr_a') => ({ actor, memberId: 'USER0001', now, newId: () => `evt_${(seq += 1)}` });

describe('manual execution appends history and updates the projection together', () => {
  it('Not Started -> Fail -> Pass: two events, the Fail stays, the result ends as Pass', () => {
    const tc = tcase(1);
    const one = applyManualResult(emptyTm(), tc, { status: 'fail' }, ctx('2026-10-08T01:00:00.000Z'));
    expect(one.caseResults[0]?.status).toBe('fail');
    expect(one.caseExecutions).toHaveLength(1);
    const first = (one.caseExecutions ?? [])[0] as CaseExecutionEvent;
    expect(first).toMatchObject({ status: 'fail', source: 'manual', executedByUserId: 'usr_a', executedByMemberId: 'USER0001', testCaseId: 'tc_1', projectId: P, scopeId: 'scp_1' });
    expect(Number.isNaN(Date.parse(first.executedAt))).toBe(false);
    expect(checkCaseExecution(first).ok).toBe(true);

    const two = applyManualResult(one, tc, { status: 'pass' }, ctx('2026-10-08T02:00:00.000Z'));
    expect(two.caseResults[0]?.status).toBe('pass');
    expect(two.caseExecutions).toHaveLength(2);
    expect((two.caseExecutions ?? [])[0]).toEqual(first); // history is never rewritten
    expect(latestStatusFromHistory(two.caseExecutions ?? [], 'tc_1')).toBe(two.caseResults[0]?.status);
  });

  it('a Retest flag is an execution; memo / device / question edits and no-ops are not', () => {
    const tc = tcase(1);
    const failed = applyManualResult(emptyTm(), tc, { status: 'fail' }, ctx('2026-10-08T01:00:00.000Z'));
    const retest = applyManualResult(failed, tc, { retest: true }, ctx('2026-10-08T02:00:00.000Z'));
    expect(retest.caseExecutions).toHaveLength(2);
    expect((retest.caseExecutions ?? [])[1]).toMatchObject({ status: 'fail', retest: true });
    const memo = applyManualResult(retest, tc, { memo: 'seen on iOS' }, ctx('2026-10-08T03:00:00.000Z'));
    expect(memo.caseResults[0]?.memo).toBe('seen on iOS');
    expect(memo.caseExecutions).toHaveLength(2);
    expect(applyManualResult(memo, tc, { status: 'fail' }, ctx('2026-10-08T04:00:00.000Z'))).toBe(memo); // nothing changed: nothing written
  });

  it('resetting to Not Started is a new event too, so the latest event always agrees with the result', () => {
    const tc = tcase(1);
    const passed = applyManualResult(emptyTm(), tc, { status: 'pass' }, ctx('2026-10-08T01:00:00.000Z'));
    const reset = applyManualResult(passed, tc, { status: 'notStarted' }, ctx('2026-10-08T02:00:00.000Z'));
    expect(reset.caseExecutions).toHaveLength(2);
    expect(latestStatusFromHistory(reset.caseExecutions ?? [], 'tc_1')).toBe('notStarted');
    expect(reset.caseResults[0]?.status).toBe('notStarted');
  });

  it('plain local use records no fake account', () => {
    const out = applyManualResult(emptyTm(), tcase(1), { status: 'pass' }, { actor: null, now: NOW, newId: () => 'evt_local' });
    expect((out.caseExecutions ?? [])[0]).toMatchObject({ executedByUserId: null });
    expect((out.caseExecutions ?? [])[0]?.executedByMemberId).toBeUndefined();
  });

  it('the hook routes every manual change through this one action', () => {
    expect(src('features/testManagement/useTestManagement.ts')).toContain('applyManualResult(tm, tc, patch');
    expect(src('domain/testManagement/executionRecord.ts')).toContain('appendExecutionEvents(');
  });
});

describe('TestRail sync appends idempotent events', () => {
  const tc = tcase(1, { testrailCaseId: 77 });
  const tm0: TestManagementState = { ...emptyTm(), testCases: [tc] };
  const test = (statusId: number) => ({ testId: 900, assignedToId: null, statusId, caseId: 77 });
  const resultRow = (id: number, statusId: number, createdOn: number) => ({ id, testId: 900, runId: 12, statusId, createdOn, createdBy: 31, assignedToId: null, comment: 'checked' });
  const plan = (tm: TestManagementState, statusId: number, results: ReturnType<typeof resultRow>[]) =>
    planTestRailResultSync([test(statusId)], results, tm.testCases, resultsByCase(tm.caseResults), { knownEventIds: new Set((tm.caseExecutions ?? []).map((e) => e.id)), memberByTestRailUserId: new Map([[31, 'USER0007']]) });
  const apply = (tm: TestManagementState, p: ReturnType<typeof plan>) => applyTestRailSyncToState(tm, p.patches, p.events, 'usr_sv', NOW);

  it('result 5001 -> one TestRail event; the same sync again adds nothing; 5002 adds a second', () => {
    const t1 = 1_791_000_000; // unix seconds
    const first = apply(tm0, plan(tm0, 5, [resultRow(5001, 5, t1)]));
    expect(first.caseResults[0]?.status).toBe('fail');
    expect(first.caseExecutions).toHaveLength(1);
    const e = (first.caseExecutions ?? [])[0] as CaseExecutionEvent;
    expect(e).toMatchObject({ source: 'testrail', id: 'evt_tr_12_5001', sourceRef: { provider: 'testrail', runId: 12, resultId: 5001 }, executedByMemberId: 'USER0007', status: 'fail', executedByUserId: null });
    expect(e.executedAt).toBe(new Date(t1 * 1000).toISOString()); // TestRail's own created_on, not the fetch time
    expect(checkCaseExecution(e).ok).toBe(true);

    const again = apply(first, plan(first, 5, [resultRow(5001, 5, t1)]));
    expect(again).toBe(first);
    expect(again.caseExecutions).toHaveLength(1);

    const second = apply(first, plan(first, 1, [resultRow(5001, 5, t1), resultRow(5002, 1, t1 + 600)]));
    expect(second.caseExecutions).toHaveLength(2);
    expect(second.caseResults[0]?.status).toBe('pass');
    expect(latestStatusFromHistory(second.caseExecutions ?? [], 'tc_1')).toBe('pass');
  });

  it('a new TestRail result with the same status is still a new execution fact; a repeat of it is not', () => {
    const t1 = 1_791_000_000;
    const first = apply(tm0, plan(tm0, 5, [resultRow(5001, 5, t1)]));
    const retried = apply(first, plan(first, 5, [resultRow(5001, 5, t1), resultRow(5003, 5, t1 + 3600)]));
    expect(retried.caseExecutions).toHaveLength(2);
    expect(apply(retried, plan(retried, 5, [resultRow(5001, 5, t1), resultRow(5003, 5, t1 + 3600)]))).toBe(retried);
  });

  it('appendExecutionEvents never rewrites an existing id', () => {
    const e: CaseExecutionEvent = { id: 'evt_x', projectId: P, scopeId: 'scp_1', testCaseId: 'tc_1', status: 'pass', executedAt: NOW, source: 'manual' };
    const list = appendExecutionEvents([e], [{ ...e, status: 'fail' }]);
    expect(list).toHaveLength(1);
    expect(list[0]?.status).toBe('pass');
  });

  it('the Execution-tab sync uses the dedicated lane (no manual events, no daily aggregate)', () => {
    const tab = src('features/testManagement/ExecutionTab.tsx');
    expect(tab).toContain('tm.applyTestRailSync(syncPlan.patches, syncPlan.events)');
    expect(tab).not.toContain('tm.patchResult(patch.testCase');
  });
});

describe('per-day derivation (read-only)', () => {
  const ev = (id: string, testCaseId: string, status: CaseStatus, at: string, over: Partial<CaseExecutionEvent> = {}): CaseExecutionEvent => ({ id, projectId: P, scopeId: 'scp_1', testCaseId, status, executedAt: at, source: 'manual', ...over });
  // 2026-10-08 in Tokyo: 09:00 = 00:00Z.
  const day = [
    ev('a', 'tc_1', 'fail', '2026-10-08T00:00:00.000Z'),
    ev('b', 'tc_1', 'inProgress', '2026-10-08T02:00:00.000Z', { retest: true }),
    ev('c', 'tc_1', 'pass', '2026-10-08T06:00:00.000Z'),
  ];

  it('three events on one case: events = 3, unique cases = 1, the final status is the LATEST of the day (not the first)', () => {
    const d = dailyCaseExecution(day, P, '2026-10-08');
    expect(d).toMatchObject({ events: 3, uniqueCasesExecuted: 1, passed: 1, failed: 0, inProgress: 0 });
  });

  it('a second case that ended Blocked: unique = 2, Pass 1, Blocked 1', () => {
    const d = dailyCaseExecution([...day, ev('d', 'tc_2', 'blocked', '2026-10-08T03:00:00.000Z')], P, '2026-10-08');
    expect(d).toMatchObject({ events: 4, uniqueCasesExecuted: 2, passed: 1, blocked: 1 });
  });

  it('the day is the business day (Asia/Tokyo): 00:30 JST belongs to the next date; a reset case is not counted as executed', () => {
    const late = ev('e', 'tc_3', 'pass', '2026-10-08T15:30:00.000Z');
    expect(dailyCaseExecution([late], P, '2026-10-08').uniqueCasesExecuted).toBe(0);
    expect(dailyCaseExecution([late], P, '2026-10-09').uniqueCasesExecuted).toBe(1);
    expect(dailyCaseExecution([ev('f', 'tc_3', 'pass', '2026-10-08T01:00:00.000Z'), ev('g', 'tc_3', 'notStarted', '2026-10-08T02:00:00.000Z')], P, '2026-10-08').uniqueCasesExecuted).toBe(0);
  });

  it("another project's history never appears", () => {
    const other = ev('x', 'tc_9', 'pass', '2026-10-08T01:00:00.000Z', { projectId: 'PRJ-002' });
    expect(dailyCaseExecution([...day, other], P, '2026-10-08').events).toBe(3);
    expect(dailyCaseExecution([other], P, '2026-10-08').uniqueCasesExecuted).toBe(0);
  });

  it('history of a case is newest first', () => {
    expect(eventsForCase(day, 'tc_1').map((e) => e.id)).toEqual(['c', 'b', 'a']);
  });

  it('coverage keeps scope total, registered cases and executed cases apart', () => {
    const cov = executionCoverage({ total: 420, cases: [tcase(1), tcase(2), tcase(3)], events: [...day, ev('d', 'tc_2', 'blocked', '2026-10-08T03:00:00.000Z')], projectId: P, date: '2026-10-08' });
    expect(cov).toEqual({ total: 420, registered: 3, withHistory: 2, executedOnDate: 2 });
  });

  it('is a read-only derivation: nothing here touches the daily aggregate', () => {
    expect(src('domain/testManagement/executionHistory.ts')).not.toMatch(/dailyExecuted|saveDailyExecutionEntry|applyDailyExecutionEntry/);
  });
});

describe('backup, project import and removal', () => {
  const project = { ...newProjectRecord(normalizeQaInputs({ ...(DEMO_STATE as QaInputs), totalCases: 420 }), { nameEn: 'P', status: 'ongoing' }, NOW, []), projectId: P };
  const e1: CaseExecutionEvent = { id: 'evt_a', projectId: P, scopeId: 'scp_1', testCaseId: 'tc_1', status: 'fail', executedAt: NOW, executedByUserId: 'usr_a', executedByMemberId: 'USER0001', source: 'manual' };
  const e2: CaseExecutionEvent = { ...e1, id: 'evt_tr_12_5001', source: 'testrail', executedByUserId: null, sourceRef: { provider: 'testrail', runId: 12, resultId: 5001 } };
  const tmData = { scopes: [scope()], testCases: [tcase(1)], caseResults: [], caseExecutions: [e1, e2] };

  it('the project backup carries only its own project history and survives a round trip', () => {
    const foreign: CaseExecutionEvent = { ...e1, id: 'evt_other', projectId: 'PRJ-002' };
    const payload = createProjectBackupPayload(project, [], NOW, { ...tmData, caseExecutions: [e1, e2, foreign] });
    expect(payload.data.testManagement?.caseExecutions?.map((e) => e.id)).toEqual(['evt_a', 'evt_tr_12_5001']);
    const parsed = parseProjectBackupPayload(JSON.stringify(payload));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.data.testManagement?.caseExecutions).toHaveLength(2);
  });

  it('importing as a new project remaps scope, case and project references and replaces taken event ids; nothing is orphaned', () => {
    const payload = createProjectBackupPayload(project, [], NOW, tmData);
    const parsed = parseProjectBackupPayload(JSON.stringify(payload));
    if (!parsed.ok) throw new Error('parse failed');
    const result = importProjectIntoRegistry([project], [], parsed.data, { existing: { scopes: tmData.scopes, testCases: tmData.testCases, caseExecutions: [e1] } });
    const tm = result.testManagement;
    expect(result.importedProject.projectId).not.toBe(P);
    const caseIds = new Set(tm.testCases.map((c) => c.id));
    const scopeIds = new Set(tm.scopes.map((s) => s.id));
    expect(tm.caseExecutions).toHaveLength(2);
    for (const e of tm.caseExecutions ?? []) {
      expect(e.projectId).toBe(result.importedProject.projectId);
      expect(caseIds.has(e.testCaseId)).toBe(true);
      expect(scopeIds.has(e.scopeId)).toBe(true);
    }
    expect((tm.caseExecutions ?? []).some((e) => e.id === 'evt_a')).toBe(false); // the taken id was replaced
    expect((tm.caseExecutions ?? []).some((e) => e.id === 'evt_tr_12_5001')).toBe(true);
  });

  it('in a shared workspace restored manual events are attributed to the person restoring them', () => {
    const payload = createProjectBackupPayload(project, [], NOW, tmData);
    const parsed = parseProjectBackupPayload(JSON.stringify(payload));
    if (!parsed.ok) throw new Error('parse failed');
    const result = importProjectIntoRegistry([project], [], parsed.data, { actor: 'usr_sv' });
    const manual = (result.testManagement.caseExecutions ?? []).find((e) => e.source === 'manual');
    expect(manual?.executedByUserId).toBe('usr_sv');
    expect(manual?.executedByMemberId).toBeUndefined();
  });

  it('an old backup with no history imports unchanged', () => {
    const payload = createProjectBackupPayload(project, [], NOW, { scopes: [scope()], testCases: [tcase(1)], caseResults: [] });
    expect(payload.data.testManagement?.caseExecutions).toBeUndefined();
    const parsed = parseProjectBackupPayload(JSON.stringify(payload));
    if (!parsed.ok) throw new Error('parse failed');
    const result = importProjectIntoRegistry([], [], parsed.data);
    expect(result.testManagement.caseExecutions ?? []).toEqual([]);
    expect(result.testManagement.scopes).toHaveLength(1);
  });

  it('removing a project removes its history; the sync mapper carries the kind', () => {
    expect(src('app/useReportsState.ts')).toContain('caseExecutions: (prev.caseExecutions ?? []).filter(gone)');
    const base = { projects: [], reports: [], attendance: [], topics: [], settings: {}, activeProjectId: null, caseExecutions: [e1] } as unknown as Parameters<typeof reportsToRecords>[0];
    const records = reportsToRecords(base);
    const put = records.get(recordKey('caseExecution', 'evt_a'));
    expect(put?.kind).toBe('caseExecution');
    const rebuilt = applyRecordChanges({ ...base, caseExecutions: [] }, put === undefined ? [] : [put], []);
    expect((rebuilt as { caseExecutions?: CaseExecutionEvent[] }).caseExecutions).toEqual([e1]);
  });
});

describe('visibility and export', () => {
  const e: CaseExecutionEvent = { id: 'evt_a', projectId: P, scopeId: 'scp_1', testCaseId: 'tc_1', status: 'fail', executedAt: NOW, source: 'manual' };
  it('a Tester receives events only of scopes they are authorized for', () => {
    const items = [{ kind: 'caseExecution', id: 'evt_a', json: JSON.stringify(e) }, { kind: 'caseExecution', id: 'evt_b', json: JSON.stringify({ ...e, id: 'evt_b', scopeId: 'scp_other' }) }];
    expect(filterForTester(items, new Set(['scp_1'])).map((i) => i.id)).toEqual(['evt_a']);
  });

  const members: RcsMember[] = [{ id: 'USER0001', name: 'Alice', team: 'T', role: 'tester', startDate: '2026-01-01', active: true }];
  for (const lang of ['en', 'ja'] as const) {
    it(`[${lang}] the history export has the required columns and values`, () => {
      const events: CaseExecutionEvent[] = [
        { ...e, executedByMemberId: 'USER0001', memo: 'a, "quoted"', ticketRef: 'JIRA-123', device: 'Pixel', os: 'Android 15', retest: true },
        { ...e, id: 'evt_tr_12_5001', status: 'pass', source: 'testrail', executedAt: '2026-10-09T01:00:00.000Z', sourceRef: { provider: 'testrail', runId: 12, resultId: 5001 } },
      ];
      const sheet = caseExecutionHistorySheet(lang, events, [scope()], [tcase(1)], members);
      expect(sheet.headers).toHaveLength(16);
      expect(sheet.headers[0]).toBe(dict(lang)['tm.history.exportProjectId']);
      expect(sheet.rows).toHaveLength(2);
      expect(sheet.rows[0]).toEqual([P, 'Ecosystem', 'ECO-001', 'Case 1', NOW, dict(lang)['tm.status.fail'], '✔', '', 'Alice', dict(lang)['tm.history.sourceManual'], '', '', 'JIRA-123', 'a, "quoted"', 'Pixel', 'Android 15']);
      expect(sheet.rows[1]?.slice(9, 12)).toEqual([dict(lang)['tm.history.sourceTestrail'], 12, 5001]);
    });
  }

  it('new visible strings exist in both languages', () => {
    const keys = ['tm.history.column', 'tm.history.show', 'tm.history.title', 'tm.history.empty', 'tm.history.since', 'tm.history.sourceManual', 'tm.history.sourceTestrail', 'tm.execSync.historyFound', 'tm.history.exportSheet', 'tm.history.exportProjectId', 'tm.history.exportDateTime', 'tm.history.exportActor', 'tm.history.exportSource', 'tm.history.exportRunId', 'tm.history.exportResultId', 'tm.history.exportTicket', 'hist.kind.caseExecution'];
    for (const k of keys) {
      expect(dict('en')[k], k).toBeTruthy();
      expect(dict('ja')[k], k).toBeTruthy();
    }
    expect(caseResultId('tc_1')).toBe('res_tc_1');
  });
});

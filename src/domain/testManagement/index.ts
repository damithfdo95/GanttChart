import {
  CASE_PRIORITIES,
  CASE_STATUSES,
  TM_LIMITS,
  caseResultId,
  checkCaseResult,
  checkScope,
  checkTestCase,
  isAssignedToScope,
  nextCaseKey,
  normalizeCaseKey,
  normalizeScopeCode,
  type CasePriority,
  type CaseResult,
  type CaseStatus,
  type TestCase,
  type TestScope,
} from '../../../shared/testManagement';
import type { TesterProjectAssignment } from '../../types';
import { cleanTotal } from './totals';

export * from '../../../shared/testManagement';
export { parseBulkCases, type BulkParse, type BulkRow, type BulkRowError } from './bulk';
export * from './totals';

/**
 * Test Management domain: scopes, test cases and their current results, and the summary formulas.
 *
 * Source of truth (decision for Stage 8C): the CASE-BASED numbers below belong to Test Management and are shown only there. The
 * Stage 8A aggregate numbers (daily execution entries: Dashboard, Cycles, Daily Report) are unchanged and are NOT computed from
 * cases and NOT added to them, so the two can never be double counted or silently disagree. A project with no test cases behaves
 * exactly as before. Rolling case results up into the aggregate reports is Stage 8D/8F work.
 */

export interface TestManagementState {
  scopes: TestScope[];
  testCases: TestCase[];
  caseResults: CaseResult[];
}

// ---- summary formulas -----------------------------------------------------------

export interface CaseSummary {
  /** Active test cases (archived ones are excluded everywhere). */
  total: number;
  /** Cases whose status is anything but Not Started. */
  started: number;
  pass: number;
  fail: number;
  na: number;
  blocked: number;
  /** "Not Executable (SPO)": the product's existing SPO concept. */
  spo: number;
  inProgress: number;
  notStarted: number;
  /** Cases flagged for retest / with an open question (flags, not statuses). */
  retest: number;
  question: number;
  /** Pass + Fail + N/A + SPO. Blocked and In Progress are NOT completed. */
  completed: number;
  /** max(total - completed, 0): blocked cases stay in it. */
  remaining: number;
  /** completed / total, or null when there are no cases. */
  progress: number | null;
  /** pass / (pass + fail), or null when nothing was passed or failed. Never pass / total. */
  passRate: number | null;
}

export const EMPTY_SUMMARY: CaseSummary = { total: 0, started: 0, pass: 0, fail: 0, na: 0, blocked: 0, spo: 0, inProgress: 0, notStarted: 0, retest: 0, question: 0, completed: 0, remaining: 0, progress: null, passRate: null };

/** Index results by test case id. */
export function resultsByCase(results: readonly CaseResult[]): Map<string, CaseResult> {
  return new Map(results.map((r) => [r.testCaseId, r]));
}

/** The status of a case: its result's, or Not Started when it has none. */
export function statusOf(testCaseId: string, byCase: ReadonlyMap<string, CaseResult>): CaseStatus {
  return byCase.get(testCaseId)?.status ?? 'notStarted';
}

/** The summary of a set of cases. Archived cases are ignored. */
export function summarize(cases: readonly TestCase[], byCase: ReadonlyMap<string, CaseResult>): CaseSummary {
  const s = { ...EMPTY_SUMMARY };
  for (const c of cases) {
    if (c.status !== 'active') continue;
    s.total += 1;
    const r = byCase.get(c.id);
    const status = r?.status ?? 'notStarted';
    switch (status) {
      case 'pass': s.pass += 1; break;
      case 'fail': s.fail += 1; break;
      case 'na': s.na += 1; break;
      case 'blocked': s.blocked += 1; break;
      case 'spo': s.spo += 1; break;
      case 'inProgress': s.inProgress += 1; break;
      default: s.notStarted += 1;
    }
    if (r?.retest === true) s.retest += 1;
    if (r?.question === true) s.question += 1;
  }
  s.started = s.total - s.notStarted;
  s.completed = s.pass + s.fail + s.na + s.spo;
  s.remaining = Math.max(s.total - s.completed, 0);
  s.progress = s.total === 0 ? null : s.completed / s.total;
  s.passRate = s.pass + s.fail === 0 ? null : s.pass / (s.pass + s.fail);
  return s;
}

export interface ScopeRow {
  scope: TestScope;
  summary: CaseSummary;
}

/** One row per scope of a project (in display order), plus the total over the ACTIVE scopes. */
export function projectOverview(projectId: string, state: TestManagementState): { rows: ScopeRow[]; total: CaseSummary } {
  const byCase = resultsByCase(state.caseResults);
  const scopes = sortScopes(state.scopes.filter((s) => s.projectId === projectId));
  const rows = scopes.map((scope) => ({ scope, summary: summarize(state.testCases.filter((c) => c.scopeId === scope.id), byCase) }));
  const activeScopeIds = new Set(scopes.filter((s) => s.status === 'active').map((s) => s.id));
  const total = summarize(state.testCases.filter((c) => c.projectId === projectId && activeScopeIds.has(c.scopeId)), byCase);
  return { rows, total };
}

// ---- ordering --------------------------------------------------------------------

export const sortScopes = (scopes: readonly TestScope[]): TestScope[] => [...scopes].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
export const sortCases = (cases: readonly TestCase[]): TestCase[] => [...cases].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key, undefined, { numeric: true }));

// ---- creating and editing definitions ---------------------------------------------

export type TmError =
  | 'scope_invalid_name'
  | 'scope_invalid_code'
  | 'scope_invalid_total'
  | 'scope_code_taken'
  | 'scope_not_found'
  | 'scope_archived'
  | 'testcase_invalid_title'
  | 'testcase_invalid_key'
  | 'testcase_key_taken'
  | 'testcase_invalid_priority';

export type Made<T> = { ok: true; value: T } | { ok: false; error: TmError };

const clean = (v: string | undefined): string | undefined => {
  const t = v?.replace(/\r\n/g, '\n').trim();
  return t === undefined || t === '' ? undefined : t;
};

export function newScope(
  state: Pick<TestManagementState, 'scopes'>,
  input: { projectId: string; name: string; code?: string; description?: string; totalTestCases?: number },
  now: string,
  id: string = `scp_${crypto.randomUUID()}`,
): Made<TestScope> {
  const name = input.name.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (name === '' || name.length > TM_LIMITS.scopeName) return { ok: false, error: 'scope_invalid_name' };
  const code = normalizeScopeCode(input.code);
  if (code === null) return { ok: false, error: 'scope_invalid_code' };
  if (code !== undefined && state.scopes.some((s) => s.projectId === input.projectId && s.code === code)) return { ok: false, error: 'scope_code_taken' };
  const mine = state.scopes.filter((s) => s.projectId === input.projectId);
  const order = mine.reduce((m, s) => Math.max(m, s.order), 0) + 10;
  if (input.totalTestCases !== undefined && cleanTotal(input.totalTestCases) === null) return { ok: false, error: 'scope_invalid_total' };
  const scope: TestScope = { id, projectId: input.projectId, name, ...(code === undefined ? {} : { code }), ...(clean(input.description) === undefined ? {} : { description: clean(input.description) }), ...(input.totalTestCases === undefined ? {} : { totalTestCases: input.totalTestCases }), status: 'active', order, createdAt: now, updatedAt: now };
  return checkScope(scope).ok ? { ok: true, value: scope } : { ok: false, error: 'scope_invalid_name' };
}

export function editScope(
  state: Pick<TestManagementState, 'scopes'>,
  scopeId: string,
  patch: { name?: string; code?: string; description?: string; totalTestCases?: number | null },
  now: string,
): Made<TestScope> {
  const prev = state.scopes.find((s) => s.id === scopeId);
  if (prev === undefined) return { ok: false, error: 'scope_not_found' };
  const name = patch.name === undefined ? prev.name : patch.name.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (name === '' || name.length > TM_LIMITS.scopeName) return { ok: false, error: 'scope_invalid_name' };
  let code = prev.code;
  if (patch.code !== undefined) {
    const c = normalizeScopeCode(patch.code);
    if (c === null) return { ok: false, error: 'scope_invalid_code' };
    if (c !== undefined && state.scopes.some((s) => s.id !== prev.id && s.projectId === prev.projectId && s.code === c)) return { ok: false, error: 'scope_code_taken' };
    code = c;
  }
  const description = patch.description === undefined ? prev.description : clean(patch.description);
  // undefined keeps the Total, null clears it, a whole number >= 0 sets it.
  let total = prev.totalTestCases;
  if (patch.totalTestCases === null) total = undefined;
  else if (patch.totalTestCases !== undefined) {
    if (cleanTotal(patch.totalTestCases) === null) return { ok: false, error: 'scope_invalid_total' };
    total = patch.totalTestCases;
  }
  const { code: _c, description: _d, totalTestCases: _t, ...rest } = prev;
  return { ok: true, value: { ...rest, ...(code === undefined ? {} : { code }), ...(description === undefined ? {} : { description }), ...(total === undefined ? {} : { totalTestCases: total }), name, updatedAt: prev.totalTestCases === total && patch.name === undefined && patch.code === undefined && patch.description === undefined ? prev.updatedAt : now } };
}

export function setScopeStatus(scope: TestScope, status: 'active' | 'archived', now: string): TestScope {
  return scope.status === status ? scope : { ...scope, status, updatedAt: now };
}

export interface CaseInput {
  key?: string;
  title: string;
  description?: string;
  preconditions?: string;
  steps?: string;
  expected?: string;
  priority?: CasePriority;
  type?: string;
  tags?: string[];
}

/** Keys already used in a project, ARCHIVED ones included, so a retired key is never handed out again. */
export function usedKeys(cases: readonly TestCase[], projectId: string): string[] {
  return cases.filter((c) => c.projectId === projectId).map((c) => c.key);
}

export function newTestCase(
  state: Pick<TestManagementState, 'scopes' | 'testCases'>,
  scopeId: string,
  input: CaseInput,
  now: string,
  options: { id?: string; reservedKeys?: Iterable<string>; order?: number } = {},
): Made<TestCase> {
  const scope = state.scopes.find((s) => s.id === scopeId);
  if (scope === undefined) return { ok: false, error: 'scope_not_found' };
  if (scope.status === 'archived') return { ok: false, error: 'scope_archived' };
  const title = input.title.replace(/\s+/g, ' ').trim();
  if (title === '' || title.length > TM_LIMITS.title) return { ok: false, error: 'testcase_invalid_title' };
  const used = new Set([...usedKeys(state.testCases, scope.projectId), ...(options.reservedKeys ?? [])]);
  let key: string | null;
  if (input.key === undefined || input.key.trim() === '') key = nextCaseKey(scope.code, used);
  else key = normalizeCaseKey(input.key);
  if (key === null) return { ok: false, error: 'testcase_invalid_key' };
  if (used.has(key)) return { ok: false, error: 'testcase_key_taken' };
  const priority = input.priority ?? 'medium';
  if (!(CASE_PRIORITIES as readonly string[]).includes(priority)) return { ok: false, error: 'testcase_invalid_priority' };
  const order = options.order ?? state.testCases.filter((c) => c.scopeId === scopeId).reduce((m, c) => Math.max(m, c.order), 0) + 10;
  const tags = (input.tags ?? []).map((t) => t.trim()).filter((t) => t !== '').slice(0, TM_LIMITS.tags);
  const tc: TestCase = {
    id: options.id ?? `tc_${crypto.randomUUID()}`,
    projectId: scope.projectId,
    scopeId,
    key,
    title,
    ...(clean(input.description) === undefined ? {} : { description: clean(input.description) }),
    ...(clean(input.preconditions) === undefined ? {} : { preconditions: clean(input.preconditions) }),
    ...(clean(input.steps) === undefined ? {} : { steps: clean(input.steps) }),
    ...(clean(input.expected) === undefined ? {} : { expected: clean(input.expected) }),
    priority,
    ...(clean(input.type) === undefined ? {} : { type: clean(input.type) }),
    ...(tags.length === 0 ? {} : { tags }),
    status: 'active',
    order,
    createdAt: now,
    updatedAt: now,
  };
  return checkTestCase(tc).ok ? { ok: true, value: tc } : { ok: false, error: 'testcase_invalid_title' };
}

/** Edit a case. The key, the scope and the project never change (a case keeps its identity). */
export function editTestCase(prev: TestCase, patch: Partial<Omit<CaseInput, 'key'>>, now: string): Made<TestCase> {
  const title = patch.title === undefined ? prev.title : patch.title.replace(/\s+/g, ' ').trim();
  if (title === '' || title.length > TM_LIMITS.title) return { ok: false, error: 'testcase_invalid_title' };
  const priority = patch.priority ?? prev.priority;
  const pick = (k: 'description' | 'preconditions' | 'steps' | 'expected' | 'type'): string | undefined => (patch[k] === undefined ? prev[k] : clean(patch[k]));
  const tags = patch.tags === undefined ? prev.tags : patch.tags.map((t) => t.trim()).filter((t) => t !== '').slice(0, TM_LIMITS.tags);
  const next: TestCase = {
    id: prev.id, projectId: prev.projectId, scopeId: prev.scopeId, key: prev.key, title, priority, status: prev.status, order: prev.order, createdAt: prev.createdAt, updatedAt: now,
    ...(pick('description') === undefined ? {} : { description: pick('description') }),
    ...(pick('preconditions') === undefined ? {} : { preconditions: pick('preconditions') }),
    ...(pick('steps') === undefined ? {} : { steps: pick('steps') }),
    ...(pick('expected') === undefined ? {} : { expected: pick('expected') }),
    ...(pick('type') === undefined ? {} : { type: pick('type') }),
    ...(tags === undefined || tags.length === 0 ? {} : { tags }),
  };
  return checkTestCase(next).ok ? { ok: true, value: next } : { ok: false, error: 'testcase_invalid_title' };
}

export function setCaseStatus(tc: TestCase, status: 'active' | 'archived', now: string): TestCase {
  return tc.status === status ? tc : { ...tc, status, updatedAt: now };
}

/** Swap a scope or case with its neighbour in display order (`direction` -1 up, +1 down). Returns the two changed records. */
export function moveInOrder<T extends { id: string; order: number }>(sorted: readonly T[], id: string, direction: -1 | 1): T[] {
  const i = sorted.findIndex((x) => x.id === id);
  const j = i + direction;
  if (i < 0 || j < 0 || j >= sorted.length) return [];
  return [{ ...sorted[i], order: sorted[j].order }, { ...sorted[j], order: sorted[i].order }];
}

// ---- results ------------------------------------------------------------------------

export interface ResultPatch {
  status?: CaseStatus;
  retest?: boolean;
  question?: boolean;
  memo?: string;
  device?: string;
  os?: string;
  ticketRef?: string;
}

/**
 * Apply a change to a case's current result. Returns the new record, or null when NOTHING changes (so nothing is written: clicking
 * the status that is already set, or leaving a field as it was, produces no revision). `actor` is the signed-in account (null in
 * plain local use); the server checks it against the real one.
 */
export function applyResultPatch(prev: CaseResult | undefined, tc: Pick<TestCase, 'id' | 'projectId' | 'scopeId'>, patch: ResultPatch, actor: string | null, now: string): CaseResult | null {
  const base: CaseResult = prev ?? { id: caseResultId(tc.id), projectId: tc.projectId, scopeId: tc.scopeId, testCaseId: tc.id, status: 'notStarted', retest: false, question: false, updatedByUserId: actor, updatedAt: now };
  const status = patch.status ?? base.status;
  if (!(CASE_STATUSES as readonly string[]).includes(status)) return null;
  const text = (v: string | undefined, prevV: string | undefined): string | undefined => (v === undefined ? prevV : clean(v));
  const memo = text(patch.memo, base.memo);
  const device = text(patch.device, base.device);
  const os = text(patch.os, base.os);
  const ticketRef = text(patch.ticketRef, base.ticketRef);
  const retest = patch.retest ?? base.retest;
  const question = patch.question ?? base.question;
  const changed = prev === undefined ? (status !== 'notStarted' || retest || question || memo !== undefined || device !== undefined || os !== undefined || ticketRef !== undefined)
    : status !== prev.status || retest !== prev.retest || question !== prev.question || memo !== prev.memo || device !== prev.device || os !== prev.os || ticketRef !== prev.ticketRef;
  if (!changed) return null;
  const statusChanged = status !== base.status;
  const executed = status !== 'notStarted' && statusChanged;
  const { memo: _m, device: _d, os: _o, ticketRef: _t, ...rest } = base;
  const next: CaseResult = {
    ...rest,
    status,
    retest,
    question,
    ...(memo === undefined ? {} : { memo }),
    ...(device === undefined ? {} : { device }),
    ...(os === undefined ? {} : { os }),
    ...(ticketRef === undefined ? {} : { ticketRef }),
    ...(executed ? { executedByUserId: actor, executedAt: now } : {}),
    updatedByUserId: actor,
    updatedAt: now,
  };
  return checkCaseResult(next).ok ? next : null;
}

/** Put one result into the list (replace by id or append). */
export function upsertResult(results: readonly CaseResult[], result: CaseResult): CaseResult[] {
  return results.some((r) => r.id === result.id) ? results.map((r) => (r.id === result.id ? result : r)) : [...results, result];
}

// ---- who may work on what --------------------------------------------------------------

/** The active scopes a Tester is assigned to today (a project-level assignment covers every scope of that project). */
export function assignedScopes(userId: string, assignments: readonly TesterProjectAssignment[], scopes: readonly TestScope[], today: string): TestScope[] {
  const list = assignments as unknown as ReadonlyArray<Record<string, unknown>>;
  return sortScopes(scopes.filter((s) => s.status === 'active' && isAssignedToScope(list, userId, s.projectId, s.id, today)));
}

/** The accounts assigned to a scope today (scope-level or project-level), by account id. */
export function scopeAssigneeIds(scope: TestScope, assignments: readonly TesterProjectAssignment[], today: string): string[] {
  const ids = new Set<string>();
  for (const a of assignments) {
    if (a.userId === undefined) continue;
    if (isAssignedToScope([a as unknown as Record<string, unknown>], a.userId, scope.projectId, scope.id, today)) ids.add(a.userId);
  }
  return [...ids];
}

export interface ScopeAssignee {
  key: string;
  userId?: string;
  memberId?: string;
}

/**
 * Everyone currently assigned to a scope: accounts (by `userId`) AND Team Members that have no account yet (by `memberId`), so a
 * person without a login still shows on the scope they were assigned to. A project-level assignment (no scope) covers every scope.
 */
export function scopeAssignees(scope: TestScope, assignments: readonly TesterProjectAssignment[], today: string): ScopeAssignee[] {
  const out = new Map<string, ScopeAssignee>();
  for (const a of assignments) {
    if (!a.active || a.projectId !== scope.projectId) continue;
    if (a.scopeId !== undefined && a.scopeId !== '' && a.scopeId !== scope.id) continue;
    if (a.endDate !== undefined && a.endDate !== '' && a.endDate < today) continue;
    if (a.startDate > today) continue;
    if (a.userId !== undefined) out.set(`u:${a.userId}`, { key: `u:${a.userId}`, userId: a.userId, ...(a.memberId === undefined ? {} : { memberId: a.memberId }) });
    else if (a.memberId !== undefined) out.set(`m:${a.memberId}`, { key: `m:${a.memberId}`, memberId: a.memberId });
  }
  return [...out.values()];
}

// ---- filtering --------------------------------------------------------------------------

export interface CaseFilter {
  scopeId?: string;
  status?: CaseStatus | 'all';
  priority?: CasePriority | 'all';
  type?: string;
  tag?: string;
  q?: string;
  retest?: boolean;
  question?: boolean;
  includeArchived?: boolean;
}

export type CaseSort = 'order' | 'key' | 'priority' | 'status' | 'updated';

const PRIORITY_RANK: Record<CasePriority, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const STATUS_RANK: Record<CaseStatus, number> = { fail: 0, blocked: 1, inProgress: 2, notStarted: 3, spo: 4, na: 5, pass: 6 };

export function filterCases(cases: readonly TestCase[], byCase: ReadonlyMap<string, CaseResult>, f: CaseFilter, sort: CaseSort = 'order'): TestCase[] {
  const q = (f.q ?? '').normalize('NFKC').trim().toLowerCase();
  const rows = cases.filter((c) => {
    if (!f.includeArchived && c.status !== 'active') return false;
    if (f.scopeId !== undefined && c.scopeId !== f.scopeId) return false;
    if (f.priority !== undefined && f.priority !== 'all' && c.priority !== f.priority) return false;
    if (f.type !== undefined && f.type !== '' && c.type !== f.type) return false;
    if (f.tag !== undefined && f.tag !== '' && !(c.tags ?? []).includes(f.tag)) return false;
    const r = byCase.get(c.id);
    if (f.status !== undefined && f.status !== 'all' && (r?.status ?? 'notStarted') !== f.status) return false;
    if (f.retest === true && r?.retest !== true) return false;
    if (f.question === true && r?.question !== true) return false;
    if (q !== '' && !c.key.toLowerCase().includes(q) && !c.title.toLowerCase().includes(q)) return false;
    return true;
  });
  const cmp = (a: TestCase, b: TestCase): number => {
    switch (sort) {
      case 'key': return a.key.localeCompare(b.key, undefined, { numeric: true });
      case 'priority': return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.order - b.order;
      case 'status': return STATUS_RANK[statusOf(a.id, byCase)] - STATUS_RANK[statusOf(b.id, byCase)] || a.order - b.order;
      case 'updated': return (byCase.get(b.id)?.updatedAt ?? '').localeCompare(byCase.get(a.id)?.updatedAt ?? '');
      default: return a.order - b.order || a.key.localeCompare(b.key, undefined, { numeric: true });
    }
  };
  return rows.sort(cmp);
}

// ---- bulk add -------------------------------------------------------------------------

import type { BulkRow } from './bulk';

/** Turn a VALID preview into cases: given keys are kept, blank ones get the next free key (never a key already used, archived included). */
export function buildBulkCases(state: Pick<TestManagementState, 'scopes' | 'testCases'>, scopeId: string, rows: readonly BulkRow[], now: string): Made<TestCase[]> | { ok: false; error: TmError; line: number } {
  const out: TestCase[] = [];
  const reserved: string[] = rows.flatMap((r) => (r.key === undefined ? [] : [r.key]));
  const baseOrder = state.testCases.filter((c) => c.scopeId === scopeId).reduce((m, c) => Math.max(m, c.order), 0);
  for (const [i, row] of rows.entries()) {
    const made = newTestCase(state, scopeId, { ...(row.key === undefined ? {} : { key: row.key }), title: row.title, priority: row.priority, ...(row.type === undefined ? {} : { type: row.type }), ...(row.expected === undefined ? {} : { expected: row.expected }) }, now, {
      // keys given by the sheet are reserved up front (so an auto key never takes one), keys already issued in this paste too
      reservedKeys: [...reserved.filter((k) => k !== row.key), ...out.map((c) => c.key)],
      order: baseOrder + (i + 1) * 10,
    });
    if (!made.ok) return { ok: false, error: made.error, line: row.line };
    out.push(made.value);
  }
  return { ok: true, value: out };
}

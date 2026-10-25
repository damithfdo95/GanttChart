/**
 * Test Management (Stage 8C): Test Scopes, Test Cases and their current execution results.
 *
 * Hierarchy: Cycle > Project / Test Execution > Test Scope > Test Case > Execution Result.
 *
 *  - A Scope belongs to exactly one project (its stable project id, "PRJ-001") and a Test Case to exactly one Scope.
 *  - A Test Case has a stable internal id (never shown) and a human-readable key ("ECO-001", shown).
 *  - There is ONE current result per Test Case, stored lazily: no record means "Not Started". Its id is derived from the case id
 *    (`res_<caseId>`), so two people editing the same case always touch the same record (conflict detection), and two people editing
 *    different cases never do.
 *
 * Plain TypeScript with no dependencies: the same validators run in the browser (before saving) and in the Worker (before a commit is
 * accepted). Everything is checked on CHANGES only, so existing data is never refused for being old.
 */
import { isQaWorkType, type QaWorkType } from './qaPolicy';

export const SCOPE_STATUSES = ['active', 'archived'] as const;
export type ScopeStatus = (typeof SCOPE_STATUSES)[number];

/**
 * Case execution statuses. "spo" is the product's existing SPO concept (cases QA could not execute, handed to the SPO side); the screens
 * call it "Not Executable (SPO)". "na" is "Not applicable". No second term was invented.
 */
export const CASE_STATUSES = ['notStarted', 'inProgress', 'pass', 'fail', 'na', 'blocked', 'spo'] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const CASE_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
export type CasePriority = (typeof CASE_PRIORITIES)[number];

export const TM_LIMITS = {
  scopeName: 80,
  scopeDescription: 1000,
  title: 200,
  description: 4000,
  preconditions: 2000,
  steps: 8000,
  expected: 2000,
  type: 40,
  tags: 10,
  tag: 30,
  memo: 500,
  device: 80,
  os: 80,
  ticketRef: 80,
  bulkRows: 500,
} as const;

/**
 * The link of a scope to one TestRail test run (Stage: TestRail run import).
 *
 * The plan id is the run's parent plan (populated when the run was fetched
 * through `get_plan`); the run id is the unit the app tracks. This is SHARED
 * data — it rides inside the ordinary `scope` record, so it syncs with the
 * workspace exactly like the other scope fields. The run's live progress
 * counts are NEVER persisted here: they are fetched on demand and kept in the
 * browser only (see the client and the progress readout).
 */
export interface TestRailScopeLink {
  /** A positive TestRail plan id. */
  planId: number;
  /** A positive TestRail run id (the run of `planId` that this scope tracks). */
  runId: number;
}

const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 2_000_000_000;

/** True exactly for a whole `TestRailScopeLink` (planId + runId, positive integers). */
export const testrailLinkOk = (v: unknown): v is TestRailScopeLink => isObj(v) && isPositiveInt(v.planId) && isPositiveInt(v.runId);

export interface TestScope {
  id: string;
  /** What kind of QA work this scope is (Regression, Sanity, Adhoc, Verification). Absent = unspecified (older scopes); never guessed from the name. */
  workType?: QaWorkType;
  /** Stable project id ("PRJ-001"), the same one assignments use. */
  projectId: string;
  name: string;
  /** Short code ("ECO"). Unique within the project; used to suggest case keys. Never a primary key. */
  code?: string;
  description?: string;
  /**
   * Stage 8D: the AUTHORITATIVE Total Test Cases of this scope, typed by an SV. Independent of how many detailed Test Cases are
   * registered (those may be fewer, equal, or - with a warning - more). Absent = not set. Integer 0..TOTAL_TEST_CASES_MAX.
   */
  totalTestCases?: number;
  /**
   * Stage (TestRail run import): when present, this scope tracks ONE TestRail test run — its Total Test Cases came from the run,
   * and the run's live progress can be shown next to the scope. Shared (synced) data; run counts never ride along.
   */
  testrail?: TestRailScopeLink;
  status: ScopeStatus;
  order: number;
  createdAt: string;
  updatedAt: string;
}

export const TOTAL_TEST_CASES_MAX = 1_000_000;

export interface TestCase {
  id: string;
  projectId: string;
  scopeId: string;
  /** Business-facing key ("ECO-001"). Unique within the project, never changes once created. */
  key: string;
  title: string;
  description?: string;
  preconditions?: string;
  steps?: string;
  expected?: string;
  priority: CasePriority;
  type?: string;
  tags?: string[];
  /**
   * Stage (TestRail case import): when present, this case was imported from (or linked to) the TestRail case with this id —
   * the join key the Execution tab's TestRail sync uses to match run results to registered cases. Shared (synced) data.
   */
  testrailCaseId?: number;
  status: ScopeStatus;
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface CaseResult {
  /** `res_<testCaseId>` */
  id: string;
  projectId: string;
  scopeId: string;
  testCaseId: string;
  status: CaseStatus;
  retest: boolean;
  question: boolean;
  memo?: string;
  device?: string;
  os?: string;
  /** An existing ticket's key/id, free text (optional). */
  ticketRef?: string;
  /** Who last set a status other than Not Started, and when. Account ids are never shown; names are resolved for display. */
  executedByUserId?: string | null;
  executedAt?: string | null;
  updatedByUserId: string | null;
  updatedAt: string;
}

const ID_SHAPE = /^[A-Za-z0-9_.:-]{1,200}$/;
const SCOPE_CODE = /^[A-Z0-9][A-Z0-9_-]{0,11}$/;
const CASE_KEY = /^[A-Z0-9][A-Z0-9._-]{0,39}$/;

export const caseResultId = (testCaseId: string): string => `res_${testCaseId}`;

/** "eco " -> "ECO"; null when the cleaned code is not valid. Empty means "no code" (undefined). */
export function normalizeScopeCode(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') return null;
  const c = raw.normalize('NFKC').trim().toUpperCase();
  if (c === '') return undefined;
  return SCOPE_CODE.test(c) ? c : null;
}

/** "eco-001 " -> "ECO-001"; null when not a valid key. */
export function normalizeCaseKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const k = raw.normalize('NFKC').trim().toUpperCase();
  return CASE_KEY.test(k) ? k : null;
}

/**
 * The next key for a scope code: the highest number ever used with that code plus one, over ALL keys of the project (archived
 * included), so a retired key is never handed out again. Falls back to the "TC" prefix for a scope without a code.
 */
export function nextCaseKey(code: string | undefined, existingKeys: Iterable<string>, taken: Iterable<string> = []): string {
  const prefix = code ?? 'TC';
  const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`);
  let max = 0;
  for (const k of [...existingKeys, ...taken]) {
    const m = re.exec(k);
    if (m !== null) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

function text(value: unknown, max: number): value is string {
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function stamp(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 10 && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

const idOk = (v: unknown): v is string => typeof v === 'string' && ID_SHAPE.test(v);
const orderOk = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e9;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export type Check<T> = { ok: true; value: T } | { ok: false; error: string };

export function checkScope(raw: unknown): Check<TestScope> {
  if (!isObj(raw)) return { ok: false, error: 'scope_not_an_object' };
  if (!idOk(raw.id)) return { ok: false, error: 'scope_invalid_id' };
  if (!idOk(raw.projectId)) return { ok: false, error: 'scope_invalid_project' };
  if (!text(raw.name, TM_LIMITS.scopeName) || raw.name.trim() === '') return { ok: false, error: 'scope_invalid_name' };
  if (raw.code !== undefined && normalizeScopeCode(raw.code) !== raw.code) return { ok: false, error: 'scope_invalid_code' };
  if (raw.description !== undefined && !text(raw.description, TM_LIMITS.scopeDescription)) return { ok: false, error: 'scope_invalid_description' };
  if (raw.workType !== undefined && !isQaWorkType(raw.workType)) return { ok: false, error: 'scope_invalid_work_type' };
  if (raw.totalTestCases !== undefined && !(typeof raw.totalTestCases === 'number' && Number.isInteger(raw.totalTestCases) && raw.totalTestCases >= 0 && raw.totalTestCases <= TOTAL_TEST_CASES_MAX)) return { ok: false, error: 'scope_invalid_total' };
  // The TestRail link is lenient exactly like the other optional fields: absent = fine, present but malformed = rejected.
  if (raw.testrail !== undefined && !testrailLinkOk(raw.testrail)) return { ok: false, error: 'scope_invalid_testrail' };
  if (typeof raw.status !== 'string' || !(SCOPE_STATUSES as readonly string[]).includes(raw.status)) return { ok: false, error: 'scope_invalid_status' };
  if (!orderOk(raw.order)) return { ok: false, error: 'scope_invalid_order' };
  if (!stamp(raw.createdAt) || !stamp(raw.updatedAt)) return { ok: false, error: 'scope_invalid_timestamp' };
  return { ok: true, value: raw as unknown as TestScope };
}

export function checkTestCase(raw: unknown): Check<TestCase> {
  if (!isObj(raw)) return { ok: false, error: 'testcase_not_an_object' };
  if (!idOk(raw.id)) return { ok: false, error: 'testcase_invalid_id' };
  if (!idOk(raw.projectId) || !idOk(raw.scopeId)) return { ok: false, error: 'testcase_invalid_reference' };
  if (normalizeCaseKey(raw.key) !== raw.key) return { ok: false, error: 'testcase_invalid_key' };
  if (!text(raw.title, TM_LIMITS.title) || raw.title.trim() === '') return { ok: false, error: 'testcase_invalid_title' };
  const longs: Array<[string, number]> = [['description', TM_LIMITS.description], ['preconditions', TM_LIMITS.preconditions], ['steps', TM_LIMITS.steps], ['expected', TM_LIMITS.expected], ['type', TM_LIMITS.type]];
  for (const [f, max] of longs) if (raw[f] !== undefined && !text(raw[f], max)) return { ok: false, error: `testcase_invalid_${f}` };
  if (typeof raw.priority !== 'string' || !(CASE_PRIORITIES as readonly string[]).includes(raw.priority)) return { ok: false, error: 'testcase_invalid_priority' };
  // The TestRail case link is lenient exactly like scope.testrail: absent = fine, present but malformed = rejected.
  if (raw.testrailCaseId !== undefined && !(typeof raw.testrailCaseId === 'number' && Number.isInteger(raw.testrailCaseId) && raw.testrailCaseId > 0)) return { ok: false, error: 'testcase_invalid_testrail_case' };
  if (raw.tags !== undefined && (!Array.isArray(raw.tags) || raw.tags.length > TM_LIMITS.tags || !raw.tags.every((t) => text(t, TM_LIMITS.tag) && t.trim() !== ''))) return { ok: false, error: 'testcase_invalid_tags' };
  if (typeof raw.status !== 'string' || !(SCOPE_STATUSES as readonly string[]).includes(raw.status)) return { ok: false, error: 'testcase_invalid_status' };
  if (!orderOk(raw.order)) return { ok: false, error: 'testcase_invalid_order' };
  if (!stamp(raw.createdAt) || !stamp(raw.updatedAt)) return { ok: false, error: 'testcase_invalid_timestamp' };
  return { ok: true, value: raw as unknown as TestCase };
}

export function checkCaseResult(raw: unknown): Check<CaseResult> {
  if (!isObj(raw)) return { ok: false, error: 'result_not_an_object' };
  if (!idOk(raw.id) || !idOk(raw.testCaseId) || raw.id !== caseResultId(raw.testCaseId)) return { ok: false, error: 'result_invalid_id' };
  if (!idOk(raw.projectId) || !idOk(raw.scopeId)) return { ok: false, error: 'result_invalid_reference' };
  if (typeof raw.status !== 'string' || !(CASE_STATUSES as readonly string[]).includes(raw.status)) return { ok: false, error: 'result_invalid_status' };
  if (typeof raw.retest !== 'boolean' || typeof raw.question !== 'boolean') return { ok: false, error: 'result_invalid_flag' };
  for (const [f, max] of [['memo', TM_LIMITS.memo], ['device', TM_LIMITS.device], ['os', TM_LIMITS.os], ['ticketRef', TM_LIMITS.ticketRef]] as Array<[string, number]>) {
    if (raw[f] !== undefined && !text(raw[f], max)) return { ok: false, error: `result_invalid_${f}` };
  }
  for (const f of ['executedByUserId', 'updatedByUserId']) {
    if (raw[f] !== undefined && raw[f] !== null && !idOk(raw[f])) return { ok: false, error: `result_invalid_${f}` };
  }
  if (raw.updatedByUserId === undefined) return { ok: false, error: 'result_invalid_updatedByUserId' };
  if (raw.executedAt !== undefined && raw.executedAt !== null && !stamp(raw.executedAt)) return { ok: false, error: 'result_invalid_executedAt' };
  if (!stamp(raw.updatedAt)) return { ok: false, error: 'result_invalid_timestamp' };
  return { ok: true, value: raw as unknown as CaseResult };
}

/**
 * One execution FACT of a test case, appended every time a status is set (by hand or by the TestRail sync). `CaseResult` stays the
 * mutable current/latest projection; these events are never edited and never deleted by the app - a correction is a newer event.
 * No event is invented for results that existed before this record kind: history starts empty and grows from the first new execution.
 */
export const CASE_EXECUTION_SOURCES = ['manual', 'testrail'] as const;
export type CaseExecutionSource = (typeof CASE_EXECUTION_SOURCES)[number];
/** The only keys an event's source reference may carry: TestRail ids, never a URL or credential. */
export const CASE_EXECUTION_REF_KEYS = ['provider', 'runId', 'resultId'] as const;

export interface CaseExecutionEvent {
  /** Unique and stable. Manual events: `evt_<uuid>`. TestRail events: `evt_tr_<runId>_<resultId>` so a repeated sync is idempotent. */
  id: string;
  projectId: string;
  scopeId: string;
  testCaseId: string;
  status: CaseStatus;
  /** ISO time of the execution itself (TestRail: the result's own `created_on`, never the fetch time). */
  executedAt: string;
  /** The signed-in account that did it (manual); null/absent for TestRail events and plain local use. */
  executedByUserId?: string | null;
  /** The Team Member (stable identity); never a display name. */
  executedByMemberId?: string;
  source: CaseExecutionSource;
  retest?: boolean;
  question?: boolean;
  memo?: string;
  device?: string;
  os?: string;
  ticketRef?: string;
  sourceRef?: { provider: 'testrail'; runId?: number; resultId?: number };
}

export const caseExecutionTestRailId = (runId: number, resultId: number): string => `evt_tr_${runId}_${resultId}`;

export function checkCaseExecution(raw: unknown): Check<CaseExecutionEvent> {
  if (!isObj(raw)) return { ok: false, error: 'execution_not_an_object' };
  if (!idOk(raw.id)) return { ok: false, error: 'execution_invalid_id' };
  if (!idOk(raw.projectId) || !idOk(raw.scopeId) || !idOk(raw.testCaseId)) return { ok: false, error: 'execution_invalid_reference' };
  if (typeof raw.status !== 'string' || !(CASE_STATUSES as readonly string[]).includes(raw.status)) return { ok: false, error: 'execution_invalid_status' };
  if (!stamp(raw.executedAt)) return { ok: false, error: 'execution_invalid_executedAt' };
  if (typeof raw.source !== 'string' || !(CASE_EXECUTION_SOURCES as readonly string[]).includes(raw.source)) return { ok: false, error: 'execution_invalid_source' };
  if (raw.executedByUserId !== undefined && raw.executedByUserId !== null && !idOk(raw.executedByUserId)) return { ok: false, error: 'execution_invalid_executedByUserId' };
  if (raw.executedByMemberId !== undefined && !idOk(raw.executedByMemberId)) return { ok: false, error: 'execution_invalid_executedByMemberId' };
  for (const f of ['retest', 'question']) if (raw[f] !== undefined && typeof raw[f] !== 'boolean') return { ok: false, error: 'execution_invalid_flag' };
  for (const [f, max] of [['memo', TM_LIMITS.memo], ['device', TM_LIMITS.device], ['os', TM_LIMITS.os], ['ticketRef', TM_LIMITS.ticketRef]] as Array<[string, number]>) {
    if (raw[f] !== undefined && !text(raw[f], max)) return { ok: false, error: `execution_invalid_${f}` };
  }
  if (raw.sourceRef !== undefined) {
    const ref = raw.sourceRef;
    if (!isObj(ref) || ref.provider !== 'testrail' || Object.keys(ref).some((k) => !(CASE_EXECUTION_REF_KEYS as readonly string[]).includes(k))) return { ok: false, error: 'execution_invalid_sourceRef' };
    if (ref.runId !== undefined && !isPositiveInt(ref.runId)) return { ok: false, error: 'execution_invalid_sourceRef' };
    if (ref.resultId !== undefined && !isPositiveInt(ref.resultId)) return { ok: false, error: 'execution_invalid_sourceRef' };
  }
  return { ok: true, value: raw as unknown as CaseExecutionEvent };
}

// ---- commit rules -----------------------------------------------------------------

export interface TmView {
  get(kind: string, id: string): string | null;
  list?(kind: string): Array<{ id: string; json: string }>;
}

export interface TmCommitInput {
  puts: ReadonlyArray<{ kind: string; id: string; json: string }>;
  deletes: ReadonlyArray<{ kind: string; id: string }>;
  view: TmView;
  /** True for an SV (manages definitions and every result); false for a Tester (results of assigned, active cases only). */
  isSv: boolean;
  /** The sender's registry account id (from the verified socket), never from the message. */
  userId: string | undefined;
  /** The business date (YYYY-MM-DD) from the server's clock. */
  today: string;
}

function parse(json: string | null): Obj | null {
  if (json === null) return null;
  try {
    const v: unknown = JSON.parse(json);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/** Is the account assigned to this scope today (a project-level assignment covers every scope of the project)? */
export function isAssignedToScope(assignments: ReadonlyArray<Obj>, userId: string, projectId: string, scopeId: string, today: string): boolean {
  for (const a of assignments) {
    if (a.userId !== userId || a.projectId !== projectId || a.active !== true) continue;
    if (typeof a.scopeId === 'string' && a.scopeId !== '' && a.scopeId !== scopeId) continue;
    if (typeof a.endDate === 'string' && a.endDate !== '' && a.endDate < today) continue;
    if (typeof a.startDate === 'string' && a.startDate > today) continue;
    return true;
  }
  return false;
}

/**
 * Every rule a commit must satisfy for scopes, test cases and results. Returns a short machine-readable reason or null. Called for
 * every commit (SV and Tester); Testers are additionally limited to results of cases they are assigned to.
 */
export function testManagementCommitError(input: TmCommitInput): string | null {
  const { puts, deletes, view, isSv, userId, today } = input;
  const isTm = (k: string): boolean => k === 'scope' || k === 'testCase' || k === 'caseResult' || k === 'caseExecution';
  const touches = puts.some((p) => isTm(p.kind)) || deletes.some((d) => isTm(d.kind));
  if (!touches) return null;

  const inCommit = (kind: string): Map<string, Obj> => {
    const m = new Map<string, Obj>();
    for (const p of puts) if (p.kind === kind) {
      const o = parse(p.json);
      if (o !== null) m.set(p.id, o);
    }
    return m;
  };
  const newScopes = inCommit('scope');
  const newCases = inCommit('testCase');
  const scopeOf = (id: string): Obj | null => newScopes.get(id) ?? parse(view.get('scope', id));
  const caseOf = (id: string): Obj | null => newCases.get(id) ?? parse(view.get('testCase', id));

  // Projects deleted in this very commit take their scopes, cases and results with them.
  const deletedProjects = new Set<string>();
  for (const d of deletes) {
    if (d.kind !== 'project') continue;
    const p = parse(view.get('project', d.id));
    if (typeof p?.projectId === 'string') deletedProjects.add(p.projectId);
  }

  const list = view.list;

  for (const p of puts) {
    if (p.kind === 'scope') {
      if (!isSv) return 'scope_sv_only';
      const check = checkScope(parse(p.json));
      if (!check.ok) return check.error;
      const next = check.value;
      if (next.id !== p.id) return 'scope_id_mismatch';
      const prev = parse(view.get('scope', p.id));
      if (prev === null) {
        // A new scope belongs to a project of THIS workspace.
        const projects = list?.('project') ?? [];
        const known = projects.some((r) => parse(r.json)?.projectId === next.projectId) || puts.some((q) => q.kind === 'project' && parse(q.json)?.projectId === next.projectId);
        if (!known) return 'scope_project_not_found';
      } else if (prev.projectId !== next.projectId) return 'scope_project_immutable';
      if (next.code !== undefined && list !== undefined) {
        for (const r of list('scope')) {
          if (r.id === p.id) continue;
          const o = newScopes.get(r.id) ?? parse(r.json);
          if (o !== null && o.projectId === next.projectId && o.code === next.code) return 'scope_code_taken';
        }
        for (const [id, o] of newScopes) if (id !== p.id && o.projectId === next.projectId && o.code === next.code) return 'scope_code_taken';
      }
    }

    if (p.kind === 'testCase') {
      if (!isSv) return 'testcase_sv_only';
      const check = checkTestCase(parse(p.json));
      if (!check.ok) return check.error;
      const next = check.value;
      if (next.id !== p.id) return 'testcase_id_mismatch';
      const scope = scopeOf(next.scopeId);
      if (scope === null) return 'testcase_scope_not_found';
      if (scope.projectId !== next.projectId) return 'testcase_scope_project_mismatch';
      const prev = parse(view.get('testCase', p.id));
      if (prev === null) {
        if (scope.status === 'archived') return 'testcase_scope_archived';
      } else {
        if (prev.projectId !== next.projectId || prev.scopeId !== next.scopeId) return 'testcase_scope_immutable';
        if (prev.key !== next.key) return 'testcase_key_immutable';
      }
      if (prev === null || prev.key !== next.key) {
        if (list !== undefined) {
          for (const r of list('testCase')) {
            if (r.id === p.id) continue;
            const o = newCases.get(r.id) ?? parse(r.json);
            if (o !== null && o.projectId === next.projectId && o.key === next.key) return 'testcase_key_taken';
          }
        }
        for (const [id, o] of newCases) if (id !== p.id && o.projectId === next.projectId && o.key === next.key) return 'testcase_key_taken';
      }
    }

    if (p.kind === 'caseExecution') {
      const check = checkCaseExecution(parse(p.json));
      if (!check.ok) return check.error;
      const next = check.value;
      if (next.id !== p.id) return 'execution_id_mismatch';
      const prev = parse(view.get('caseExecution', p.id));
      if (prev !== null) {
        // The same event arriving again (a repeated sync) is a no-op; a DIFFERENT event under an existing id is an edit.
        if (JSON.stringify(prev) === JSON.stringify(parse(p.json))) continue;
        return 'execution_append_only';
      }
      const tc = caseOf(next.testCaseId);
      if (tc === null) return 'execution_case_not_found';
      if (tc.projectId !== next.projectId || tc.scopeId !== next.scopeId) return 'execution_case_mismatch';
      const scope = scopeOf(next.scopeId);
      if (scope === null || scope.projectId !== next.projectId) return 'execution_scope_mismatch';
      if (scope.status === 'archived') return 'execution_scope_archived';
      if (tc.status === 'archived') return 'execution_case_archived';
      // Who did it is whoever the server knows, whatever the message says; a TestRail event names no account at all.
      if (next.source === 'manual' && userId !== undefined && next.executedByUserId !== userId) return 'execution_actor_mismatch';
      if (next.source === 'testrail' && next.executedByUserId !== undefined && next.executedByUserId !== null) return 'execution_actor_mismatch';
      if (next.executedByMemberId !== undefined && userId !== undefined && next.source === 'manual') {
        const own = (list?.('member') ?? []).map((r) => parse(r.json)).find((o) => o !== null && o.userId === userId);
        if (own === undefined || own === null || own.id !== next.executedByMemberId) return 'execution_member_mismatch';
      }
      if (!isSv) {
        if (userId === undefined) return 'tester_rules_unavailable';
        const assignments = (list?.('assignment') ?? []).map((r) => parse(r.json)).filter((o): o is Obj => o !== null);
        if (!isAssignedToScope(assignments, userId, next.projectId, next.scopeId, today)) return 'tester_result_not_assigned';
      }
    }

    if (p.kind === 'caseResult') {
      const check = checkCaseResult(parse(p.json));
      if (!check.ok) return check.error;
      const next = check.value;
      if (next.id !== p.id) return 'result_id_mismatch';
      const tc = caseOf(next.testCaseId);
      if (tc === null) return 'result_case_not_found';
      if (tc.projectId !== next.projectId || tc.scopeId !== next.scopeId) return 'result_case_mismatch';
      const scope = scopeOf(next.scopeId);
      if (scope === null || scope.projectId !== next.projectId) return 'result_scope_mismatch';
      const prevJson = view.get('caseResult', p.id);
      const prev = parse(prevJson);
      const unchanged = prev !== null && JSON.stringify(prev) === JSON.stringify(parse(p.json));
      if (unchanged) continue;
      if (prev !== null && (prev.projectId !== next.projectId || prev.scopeId !== next.scopeId || prev.testCaseId !== next.testCaseId)) return 'result_reference_immutable';
      if (scope.status === 'archived') return 'result_scope_archived';
      if (tc.status === 'archived') return 'result_case_archived';
      // The one who changed it is the one the server knows, whatever the message says.
      if (userId !== undefined && next.updatedByUserId !== userId) return 'result_actor_mismatch';
      if (next.status !== 'notStarted' && (prev === null || next.status !== prev.status) && userId !== undefined && next.executedByUserId !== userId) return 'result_actor_mismatch';
      if (!isSv) {
        if (userId === undefined) return 'tester_rules_unavailable';
        const assignments = (list?.('assignment') ?? []).map((r) => parse(r.json)).filter((o): o is Obj => o !== null);
        if (!isAssignedToScope(assignments, userId, next.projectId, next.scopeId, today)) return 'tester_result_not_assigned';
      }
    }
  }

  for (const d of deletes) {
    if (d.kind === 'caseExecution') {
      // Append-only: an event goes only with its project (or after its case is gone), never on its own, and never by a Tester.
      if (!isSv) return 'tester_cannot_delete';
      const prev = parse(view.get('caseExecution', d.id));
      if (prev === null) continue;
      if (typeof prev.projectId === 'string' && deletedProjects.has(prev.projectId)) continue;
      if (typeof prev.projectId === 'string' && list !== undefined && !list('project').some((r) => parse(r.json)?.projectId === prev.projectId)) continue;
      if (typeof prev.testCaseId === 'string' && view.get('testCase', prev.testCaseId) === null) continue;
      return 'execution_append_only';
    }
    if (d.kind === 'caseResult') {
      if (!isSv) return 'tester_cannot_delete';
      continue;
    }
    if (d.kind !== 'scope' && d.kind !== 'testCase') continue;
    if (!isSv) return 'tester_cannot_delete';
    const prev = parse(view.get(d.kind, d.id));
    if (prev === null) continue;
    if (typeof prev.projectId === 'string' && deletedProjects.has(prev.projectId)) continue; // the whole project goes
    // ... or already went (a large clean-up is sent in several commits): nothing is left for these records to belong to.
    if (typeof prev.projectId === 'string' && list !== undefined && !list('project').some((r) => parse(r.json)?.projectId === prev.projectId)) continue;
    if (d.kind === 'testCase') {
      if (view.get('caseResult', caseResultId(d.id)) !== null && !deletes.some((x) => x.kind === 'caseResult' && x.id === caseResultId(d.id))) return 'testcase_has_results';
      if (list !== undefined) {
        for (const r of list('caseExecution')) {
          if (parse(r.json)?.testCaseId === d.id && !deletes.some((x) => x.kind === 'caseExecution' && x.id === r.id)) return 'testcase_has_history';
        }
      }
    } else if (list !== undefined) {
      for (const r of list('testCase')) {
        const o = parse(r.json);
        if (o?.scopeId === d.id && !deletes.some((x) => x.kind === 'testCase' && x.id === r.id)) return 'scope_has_cases';
      }
    }
  }
  return null;
}

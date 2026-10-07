/**
 * What a TESTER may change in the shared workspace (Stage 8B), enforced by the server inside every commit.
 *
 * The workspace is a set of opaque records, and a Tester's three kinds of input (Tickets, Performance, Today's
 * Execution) all live INSIDE a project record, so the rule is a field-level one: a Tester's change to a project may
 * touch only those parts, and inside them only what belongs to them. Everything else (project structure, the plan,
 * status, cycle, settings, reports, reviews, members, assignments) is an SV's.
 *
 * Pure functions with no I/O, shared by the Worker (authoritative) and the tests. Reasons are short machine-readable
 * codes; the browser shows its own wording.
 */

function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export interface TesterView {
  get(kind: string, id: string): string | null;
  list(kind: string): Array<{ id: string; json: string }>;
}

export interface TesterCommitInput {
  /** The authenticated Tester's registry user id (from the socket attachment, never from the message). */
  userId: string;
  puts: ReadonlyArray<{ kind: string; id: string; json: string }>;
  deletes: ReadonlyArray<{ kind: string; id: string }>;
  view: TesterView;
  /** The server's date (UTC, YYYY-MM-DD). */
  today: string;
}

/** The kinds of record a Tester never receives (SV-only information). */
export const SV_ONLY_KINDS: ReadonlySet<string> = new Set(['review', 'identityAudit', 'externalIdentity', 'report', 'topic']);

/** Fields of `inputs` a Tester's change may touch. The cumulative fields are derived from the daily entries. */
const DERIVED_INPUT_FIELDS = ['casesCompleted', 'casesPassed', 'casesFailed', 'casesNotApplicable', 'spoAssigned', 'casesBlocked', 'casesRetest', 'casesQuestioned', 'dailyActuals'] as const;
export const TESTER_INPUT_FIELDS = ['dailyExecuted', 'bugTickets', 'testerDailyPerformance', ...DERIVED_INPUT_FIELDS] as const;

type Obj = Record<string, unknown>;

function parse(json: string | null): Obj | null {
  if (json === null) return null;
  try {
    const v: unknown = JSON.parse(json);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null;
  } catch {
    return null;
  }
}

/** Key-order-independent equality for JSON values. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  const ao = a as Obj;
  const bo = b as Obj;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) {
    // An absent key and an explicit undefined are the same in JSON; null is a value.
    if (!sameJson(ao[k], bo[k])) return false;
  }
  return true;
}

function listOf(value: unknown): Obj[] {
  return Array.isArray(value) ? (value.filter((x) => typeof x === 'object' && x !== null && !Array.isArray(x)) as Obj[]) : [];
}

interface ListDiff {
  added: Obj[];
  changed: Array<{ prev: Obj; next: Obj }>;
  removed: Obj[];
}

function diffById(prev: Obj[], next: Obj[]): ListDiff {
  const p = new Map(prev.map((e) => [String(e.id), e]));
  const n = new Map(next.map((e) => [String(e.id), e]));
  const out: ListDiff = { added: [], changed: [], removed: [] };
  for (const [id, e] of n) {
    const before = p.get(id);
    if (before === undefined) out.added.push(e);
    else if (!sameJson(before, e)) out.changed.push({ prev: before, next: e });
  }
  for (const [id, e] of p) if (!n.has(id)) out.removed.push(e);
  return out;
}

/**
 * A Tester records TODAY only. `today` is the calendar date in the business time zone computed by the server from its own clock
 * (shared/businessTime.ts); an entry dated yesterday, tomorrow or anything else is refused, whatever the browser's clock says.
 */
export function isToday(date: unknown, today: string): boolean {
  return isIsoDate(date) && date === today;
}

/** The Team Member profile of this account (the link is set by the server only), or null. */
export function ownMemberId(view: TesterView, userId: string): string | null {
  for (const m of view.list('member')) {
    const o = parse(m.json);
    if (o !== null && o.userId === userId) return m.id;
  }
  return null;
}

/**
 * Is this account currently assigned to the project? Only assignments by account id count (the server alone creates those);
 * a roster/name assignment is not an account. Shared by the server's check and by the browser, which uses it to explain
 * why a Tester cannot record today's results instead of letting the server refuse them.
 */
export function isAssignedIn(assignments: ReadonlyArray<Record<string, unknown>>, userId: string, projectStableId: string, today: string): boolean {
  for (const o of assignments) {
    if (o.userId !== userId || o.projectId !== projectStableId || o.active !== true) continue;
    if (typeof o.endDate === 'string' && o.endDate !== '' && o.endDate < today) continue;
    if (typeof o.startDate === 'string' && o.startDate > today) continue;
    return true;
  }
  return false;
}

export function isAssignedNow(view: TesterView, userId: string, projectStableId: string, today: string): boolean {
  const parsed: Obj[] = [];
  for (const a of view.list('assignment')) {
    const o = parse(a.json);
    if (o !== null) parsed.push(o);
  }
  return isAssignedIn(parsed, userId, projectStableId, today);
}

/** Why a Tester's commit is refused, or null. */
export function testerCommitError(input: TesterCommitInput): string | null {
  const { userId, puts, deletes, view, today } = input;
  if (deletes.length > 0) return 'tester_cannot_delete';
  // A Tester changes projects (their own inputs) and the results of cases assigned to them; the case rules live in testManagement.ts.
  for (const p of puts) if (p.kind !== 'project' && p.kind !== 'caseResult') return 'tester_cannot_change_kind';

  const memberId = ownMemberId(view, userId);

  for (const p of puts) {
    if (p.kind !== 'project') continue;
    const prevJson = view.get('project', p.id);
    const prev = parse(prevJson);
    const next = parse(p.json);
    if (prev === null) return 'tester_cannot_create_project';
    if (next === null) return 'project_not_an_object';

    // 1. Nothing outside the Tester's three areas may differ.
    const prevInputs = (typeof prev.inputs === 'object' && prev.inputs !== null ? prev.inputs : {}) as Obj;
    const nextInputs = (typeof next.inputs === 'object' && next.inputs !== null ? next.inputs : {}) as Obj;
    const strip = (o: Obj): Obj => {
      const { updatedAt: _u, inputs: _i, ...rest } = o;
      return rest;
    };
    if (!sameJson(strip(prev), strip(next))) return 'tester_project_structure';
    const stripInputs = (o: Obj): Obj => {
      const copy: Obj = { ...o };
      for (const f of TESTER_INPUT_FIELDS) delete copy[f];
      return copy;
    };
    if (!sameJson(stripInputs(prevInputs), stripInputs(nextInputs))) return 'tester_project_plan';

    const stableId = typeof prev.projectId === 'string' ? prev.projectId : '';

    // 2. Today's Execution: only today's entry, only on a project the Tester is assigned to.
    const exec = diffById(listOf(prevInputs.dailyExecuted), listOf(nextInputs.dailyExecuted));
    const touched = [...exec.added, ...exec.changed.flatMap((c) => [c.prev, c.next]), ...exec.removed];
    if (touched.length > 0) {
      for (const e of touched) if (!isToday(e.date, today)) return 'tester_execution_not_today';
      if (!isAssignedNow(view, userId, stableId, today)) return 'tester_execution_not_assigned';
    }
    // The derived totals and snapshots follow the entries; they may not be edited on their own.
    if (touched.length === 0) {
      for (const f of DERIVED_INPUT_FIELDS) if (!sameJson(prevInputs[f], nextInputs[f])) return 'tester_derived_without_entry';
    }

    // 3. Tickets: anyone may raise one; only the reporter changes or removes theirs.
    const tickets = diffById(listOf(prevInputs.bugTickets), listOf(nextInputs.bugTickets));
    for (const t of tickets.added) {
      if (t.projectId !== undefined && t.projectId !== stableId) return 'tester_ticket_wrong_project';
      if (t.reporterMemberId !== undefined && t.reporterMemberId !== memberId) return 'tester_ticket_as_someone_else';
    }
    for (const c of tickets.changed) {
      if (memberId === null || c.prev.reporterMemberId !== memberId) return 'tester_ticket_not_own';
      if (c.next.reporterMemberId !== c.prev.reporterMemberId || c.next.projectId !== c.prev.projectId) return 'tester_ticket_owner_immutable';
    }
    for (const r of tickets.removed) if (memberId === null || r.reporterMemberId !== memberId) return 'tester_ticket_not_own';

    // 4. Performance: only the Tester's own rows.
    const perf = diffById(listOf(prevInputs.testerDailyPerformance), listOf(nextInputs.testerDailyPerformance));
    const mine = (e: Obj): boolean => memberId !== null && e.memberId === memberId;
    for (const e of perf.added) if (!mine(e)) return memberId === null ? 'tester_not_linked' : 'tester_performance_not_own';
    for (const c of perf.changed) if (!mine(c.prev) || !mine(c.next)) return memberId === null ? 'tester_not_linked' : 'tester_performance_not_own';
    for (const e of perf.removed) if (!mine(e)) return memberId === null ? 'tester_not_linked' : 'tester_performance_not_own';
  }
  return null;
}

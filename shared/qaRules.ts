/**
 * QA execution rules that must hold on BOTH sides: the browser (before it saves) and the server (before it
 * accepts a commit). Plain TypeScript, no dependencies, so the same code runs in both bundles.
 *
 * The shared workspace is a set of opaque JSON records; the server normally never interprets them. These rules
 * are the narrow, deliberate exception: references between records (a project's cycle, an assignment's
 * project), who may change what (cycles and account assignments are Admin matters) and the few numbers that can
 * never be valid (negative or fractional counts, impossible dates). Everything is checked on CHANGES only, so data
 * that already exists is never rejected for being old.
 */

import type { Role } from './protocol';
import { testerCommitError } from './testerRules';

// ---- cycles ------------------------------------------------------------------

export const CYCLE_STATUSES = ['planned', 'active', 'completed', 'archived'] as const;
export type CycleStatus = (typeof CYCLE_STATUSES)[number];

export const CYCLE_LIMITS = { name: 120, version: 60, description: 2000 } as const;

/** A QA test cycle / release: a named group of test executions (projects). */
export interface CycleRecord {
  id: string;
  name: string;
  /** Release / build label, e.g. "4.2.0". Free text; never translated. */
  version?: string;
  description?: string;
  status: CycleStatus;
  /** "YYYY-MM-DD" or null. */
  plannedStart: string | null;
  plannedEnd: string | null;
  /** When the cycle was completed (ISO timestamp), else null. */
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const ID_SHAPE = /^[A-Za-z0-9_.:-]{1,100}$/;

/** A real calendar date in "YYYY-MM-DD" form (no month 13, no 31 February). */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 10 && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

function plainText(value: unknown, max: number): value is string {
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

export type CycleCheck = { ok: true; cycle: CycleRecord } | { ok: false; error: string };

/** Is this a well-formed cycle? (Used for every cycle record the server accepts and every one the browser loads.) */
export function checkCycle(raw: unknown): CycleCheck {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'cycle_not_an_object' };
  const c = raw as Record<string, unknown>;
  if (typeof c.id !== 'string' || !ID_SHAPE.test(c.id)) return { ok: false, error: 'cycle_invalid_id' };
  if (!plainText(c.name, CYCLE_LIMITS.name) || c.name.trim() === '') return { ok: false, error: 'cycle_invalid_name' };
  if (c.version !== undefined && !plainText(c.version, CYCLE_LIMITS.version)) return { ok: false, error: 'cycle_invalid_version' };
  if (c.description !== undefined && !plainText(c.description, CYCLE_LIMITS.description)) return { ok: false, error: 'cycle_invalid_description' };
  if (typeof c.status !== 'string' || !(CYCLE_STATUSES as readonly string[]).includes(c.status)) return { ok: false, error: 'cycle_invalid_status' };
  if (c.plannedStart !== null && !isIsoDate(c.plannedStart)) return { ok: false, error: 'cycle_invalid_date' };
  if (c.plannedEnd !== null && !isIsoDate(c.plannedEnd)) return { ok: false, error: 'cycle_invalid_date' };
  if (c.plannedStart !== null && c.plannedEnd !== null && (c.plannedStart as string) > (c.plannedEnd as string)) return { ok: false, error: 'cycle_end_before_start' };
  if (c.completedAt !== null && !isTimestamp(c.completedAt)) return { ok: false, error: 'cycle_invalid_completed_at' };
  if (!isTimestamp(c.createdAt) || !isTimestamp(c.updatedAt)) return { ok: false, error: 'cycle_invalid_timestamp' };
  return { ok: true, cycle: c as unknown as CycleRecord };
}

// ---- workspace appearance ----------------------------------------------------

export const TOOL_NAME_MAX = 40;

/**
 * A workspace's own name for the tool (shown after sign-in; the public landing page keeps the platform name): 1–40
 * characters of plain text, no control characters and no angle brackets. Returns the cleaned name, or null when it is not valid.
 */
export function cleanToolName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const n = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  // eslint-disable-next-line no-control-regex
  if (n.length < 1 || n.length > TOOL_NAME_MAX || /[\u0000-\u001f\u007f<>]/.test(n)) return null;
  return n;
}

// ---- execution entries -------------------------------------------------------

const COUNT_FIELDS = ['pass', 'fail', 'notApplicable', 'spo', 'blocked', 'retest', 'questioned'] as const;
const OPTIONAL_COUNT_FIELDS = ['uncategorizedCompleted'] as const;

function isCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10_000_000;
}

/** Why one daily execution entry can never be valid, or null. Shape only: no totals, no history. */
export function executionEntryError(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return 'execution_entry_not_an_object';
  const e = entry as Record<string, unknown>;
  if (typeof e.id !== 'string' || e.id.length === 0 || e.id.length > 200) return 'execution_entry_invalid_id';
  if (!isIsoDate(e.date)) return 'execution_entry_invalid_date';
  for (const f of COUNT_FIELDS) if (!isCount(e[f])) return `execution_entry_invalid_${f}`;
  for (const f of OPTIONAL_COUNT_FIELDS) if (e[f] !== undefined && !isCount(e[f])) return `execution_entry_invalid_${f}`;
  // People on the day: a head count, but half-day planning can make it fractional, so only "a sane non-negative number" is required.
  if (typeof e.testers !== 'number' || !Number.isFinite(e.testers) || e.testers < 0 || e.testers > 100_000) return 'execution_entry_invalid_testers';
  if (typeof e.overtimeMinutes !== 'number' || !Number.isInteger(e.overtimeMinutes) || e.overtimeMinutes < 0 || e.overtimeMinutes > 180) return 'execution_entry_invalid_overtimeMinutes';
  return null;
}

/** Cases a day's entry counts as completed (the four completed categories + the migrated remainder). */
export function entryCompleted(entry: Record<string, unknown>): number {
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
  return n(entry.pass) + n(entry.fail) + n(entry.notApplicable) + n(entry.spo) + n(entry.uncategorizedCompleted);
}

function asObject(json: string | null): Record<string, unknown> | null {
  if (json === null) return null;
  try {
    const v: unknown = JSON.parse(json);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function entriesOf(project: Record<string, unknown> | null): Record<string, unknown>[] {
  const inputs = project?.inputs;
  if (typeof inputs !== 'object' || inputs === null) return [];
  const list = (inputs as Record<string, unknown>).dailyExecuted;
  return Array.isArray(list) ? (list.filter((x) => typeof x === 'object' && x !== null) as Record<string, unknown>[]) : [];
}

/**
 * The execution rules for one changed project record. Only entries that are NEW or CHANGED are examined, so
 * older data is never rejected for what it already contains; a lowered planned total is never an error (the
 * browser warns); but a change may not push the cumulative completed cases ABOVE the planned total.
 */
export function projectExecutionError(prevJson: string | null, nextJson: string): string | null {
  const next = asObject(nextJson);
  if (next === null) return 'project_not_an_object';
  const prev = asObject(prevJson);
  const nextEntries = entriesOf(next);
  const prevEntries = entriesOf(prev);
  const prevById = new Map(prevEntries.map((e) => [String(e.id), JSON.stringify(e)]));
  const changed = nextEntries.filter((e) => prevById.get(String(e.id)) !== JSON.stringify(e));
  for (const entry of changed) {
    const problem = executionEntryError(entry);
    if (problem !== null) return problem;
    const sameDay = (list: Record<string, unknown>[]) => list.filter((x) => x.date === entry.date).length;
    if (sameDay(nextEntries) > Math.max(1, sameDay(prevEntries))) return 'execution_entry_duplicate_date';
  }
  // A project that is NEW to the workspace (a restore, an import) is never refused for its totals; only a CHANGE to an existing one is.
  if (prev !== null && (changed.length > 0 || nextEntries.length !== prevEntries.length)) {
    const total = (next.inputs as Record<string, unknown> | undefined)?.totalCases;
    if (typeof total === 'number' && Number.isFinite(total)) {
      const sum = (list: Record<string, unknown>[]) => list.reduce((s, e) => s + entryCompleted(e), 0);
      const after = sum(nextEntries);
      if (after > total && after > sum(prevEntries)) return 'executed_exceeds_planned';
    }
  }
  return null;
}

// ---- who may change what, and what may refer to what -----------------------------------

export interface QaCommitView {
  /** The JSON of the record as it is NOW (before this commit), or null. */
  get(kind: string, id: string): string | null;
  /** Every current record of one kind. */
  list?(kind: string): Array<{ id: string; json: string }>;
}

export interface QaCommitInput {
  /** The sender's role in the workspace. */
  role: Role;
  puts: ReadonlyArray<{ kind: string; id: string; json: string }>;
  deletes: ReadonlyArray<{ kind: string; id: string }>;
  view: QaCommitView;
  /** The sender's registry user id (from the verified socket attachment). Needed for the Tester rules. */
  userId?: string;
  /** The server's UTC date (YYYY-MM-DD). Needed for the Tester rules. */
  today?: string;
}

/**
 * Every rule a commit must satisfy beyond "well-formed records". Returns a short machine-readable reason, or null.
 *
 *  - Cycles are administered by the Admin only; each must be well formed.
 *  - A project's cycle (`cycleId`) must name a cycle of THIS workspace (existing or created in the same commit),
 *    only the Admin may change it, and a finished-with (archived) cycle takes no new projects.
 *  - A tester assignment tied to an ACCOUNT (`userId`) is an Admin matter: it can only be created through the
 *    server's assignment endpoint (which checks the account), never directly; afterwards its owner and project cannot be
 *    changed; editing or removing it is the Admin's.
 *  - Daily execution entries obey `projectExecutionError`.
 */
export function qaCommitError(input: QaCommitInput): string | null {
  const { role, puts, deletes, view } = input;
  const isAdmin = role === 'admin';

  // A Tester (anyone who is not an SV) may change only their own tickets, performance and today's execution.
  if (!isAdmin) {
    if (input.userId === undefined || input.today === undefined || view.list === undefined) return 'tester_rules_unavailable';
    const refused = testerCommitError({ userId: input.userId, puts, deletes, view: { get: view.get, list: view.list }, today: input.today });
    if (refused !== null) return refused;
  }

  // The workspace's own tool name, when set, must be plain, short text (only an SV can write the settings record at all).
  for (const p of puts) {
    if (p.kind !== 'settings') continue;
    const next = asObject(p.json);
    if (next !== null && next.toolName !== undefined && cleanToolName(next.toolName) !== next.toolName) return 'settings_invalid_tool_name';
  }

  // A Team Member's link to a registry account is set by the server only (the assignment endpoint's twin).
  for (const p of puts) {
    if (p.kind !== 'member') continue;
    const next = asObject(p.json);
    const prev = asObject(view.get('member', p.id));
    if (next !== null && next.userId !== prev?.userId) return 'member_link_requires_api';
  }
  const putCycles = new Map<string, Record<string, unknown>>();
  for (const p of puts) {
    if (p.kind !== 'cycle') continue;
    const parsed = asObject(p.json);
    if (parsed === null) return 'cycle_not_an_object';
    putCycles.set(p.id, parsed);
  }
  const cycleStatus = (id: string): string | null => {
    const inCommit = putCycles.get(id);
    if (inCommit !== undefined) return typeof inCommit.status === 'string' ? inCommit.status : null;
    const current = asObject(view.get('cycle', id));
    return current === null ? null : typeof current.status === 'string' ? current.status : null;
  };

  for (const p of puts) {
    if (p.kind === 'cycle') {
      if (!isAdmin) return 'cycles_admin_only';
      const check = checkCycle(putCycles.get(p.id));
      if (!check.ok) return check.error;
      if (check.cycle.id !== p.id) return 'cycle_id_mismatch';
    }
  }
  for (const d of deletes) {
    if (d.kind === 'cycle' && !isAdmin) return 'cycles_admin_only';
  }

  for (const p of puts) {
    if (p.kind === 'project') {
      const prevJson = view.get('project', p.id);
      const next = asObject(p.json);
      // A payload that is not an object cannot carry a cycle or execution data, so there is nothing for these rules to check.
      if (next === null) continue;
      const prev = asObject(prevJson);
      const nextCycle = next.cycleId === undefined || next.cycleId === null ? null : next.cycleId;
      const prevCycle = prev === null || prev.cycleId === undefined || prev.cycleId === null ? null : prev.cycleId;
      if (nextCycle !== null && (typeof nextCycle !== 'string' || !ID_SHAPE.test(nextCycle))) return 'project_invalid_cycle';
      if (nextCycle !== prevCycle) {
        if (!isAdmin) return 'cycle_assignment_admin_only';
        if (nextCycle !== null) {
          const status = cycleStatus(nextCycle as string);
          if (status === null) return 'project_cycle_not_found';
          if (status === 'archived') return 'project_cycle_archived';
        }
      }
      const problem = projectExecutionError(prevJson, p.json);
      if (problem !== null) return problem;
    }

    if (p.kind === 'assignment') {
      const next = asObject(p.json);
      if (next === null) return 'assignment_not_an_object';
      const prev = asObject(view.get('assignment', p.id));
      const nextUser = next.userId;
      const prevUser = prev?.userId;
      if (nextUser !== undefined && typeof nextUser !== 'string') return 'assignment_invalid_user';
      if (nextUser !== undefined || prevUser !== undefined) {
        if (!isAdmin) return 'assignment_admin_only';
        if (prev === null) return 'assignment_requires_api'; // new account assignments are created by the server only
        if (nextUser !== prevUser || next.projectId !== prev.projectId) return 'assignment_immutable_fields';
      }
    }
  }

  for (const d of deletes) {
    if (d.kind !== 'assignment') continue;
    const prev = asObject(view.get('assignment', d.id));
    if (prev !== null && prev.userId !== undefined && !isAdmin) return 'assignment_admin_only';
  }
  return null;
}

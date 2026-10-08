/**
 * Team meeting records (Stage 8D): the SV's plan for a day and the day's meeting notes.
 *
 *   DailyTeamPlan  one record per (date, project, optional scope): how many cases the TEAM plans to execute that day. Typed by an SV.
 *                  Its id is derived from those three things, so there can never be two plans for the same day and place, and two SVs
 *                  editing the same plan always touch the same record (conflict detection) while different plans never do.
 *   MeetingNote    one record per date: a short Morning / Evening / Tomorrow note. Narrative only; never a source of numbers.
 *
 * Neither is a snapshot of the workspace: execution numbers are always read from the existing execution records at the time they are
 * shown. A plan stores only what a person decided; nothing is written when a meeting screen is merely opened.
 *
 * Plain TypeScript with no dependencies: the same validators run in the browser (before saving) and in the Worker (before a commit is
 * accepted). Everything is checked on CHANGES only, so existing data is never refused for being old.
 */

export const MEETING_LIMITS = {
  /** Largest plan for one row of one day. */
  plannedCases: 1_000_000,
  rowNote: 200,
  note: 1000,
} as const;

export interface DailyTeamPlan {
  /** `dp_<date>_<projectId>_<scopeId|all>` */
  id: string;
  /** Business date, YYYY-MM-DD. */
  date: string;
  /** Stable project id ("PRJ-001"). */
  projectId: string;
  /** Present when the plan is for one scope of the project. */
  scopeId?: string;
  /** The plan: how many cases the team intends to execute that day. */
  plannedCases: number;
  /**
   * The Morning target, kept apart from later changes: set by "Confirm the plan" in the Morning meeting, and automatically when the
   * plan of a day that has already begun is changed during the Evening meeting. Absent = the plan has not been revised since it was made.
   */
  morningCases?: number;
  /** A short remark on this row (for example "regression only"). */
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MeetingNote {
  /** `mn_<date>` */
  id: string;
  date: string;
  /** Team focus for the day, written in the Morning meeting. */
  morning?: string;
  /** The day's summary, written in the Evening meeting. */
  evening?: string;
  /** What the team focuses on next, written in the Evening meeting. */
  tomorrow?: string;
  createdAt: string;
  updatedAt: string;
}

const ID_PART = /^[A-Za-z0-9_.:-]{1,200}$/;

export const dailyPlanId = (date: string, projectId: string, scopeId?: string): string => `dp_${date}_${projectId}_${scopeId ?? 'all'}`;
export const meetingNoteId = (date: string): string => `mn_${date}`;

export function isBusinessDateString(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export function cleanPlannedCases(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MEETING_LIMITS.plannedCases ? v : null;
}

function text(value: unknown, max: number): value is string {
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function stamp(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 10 && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export type Check<T> = { ok: true; value: T } | { ok: false; error: string };

export function checkDailyPlan(raw: unknown): Check<DailyTeamPlan> {
  if (!isObj(raw)) return { ok: false, error: 'dailyplan_not_an_object' };
  if (!isBusinessDateString(raw.date)) return { ok: false, error: 'dailyplan_invalid_date' };
  if (typeof raw.projectId !== 'string' || !ID_PART.test(raw.projectId)) return { ok: false, error: 'dailyplan_invalid_project' };
  if (raw.scopeId !== undefined && (typeof raw.scopeId !== 'string' || !ID_PART.test(raw.scopeId))) return { ok: false, error: 'dailyplan_invalid_scope' };
  if (raw.id !== dailyPlanId(raw.date, raw.projectId, raw.scopeId as string | undefined)) return { ok: false, error: 'dailyplan_id_mismatch' };
  if (cleanPlannedCases(raw.plannedCases) === null) return { ok: false, error: 'dailyplan_invalid_cases' };
  if (raw.morningCases !== undefined && cleanPlannedCases(raw.morningCases) === null) return { ok: false, error: 'dailyplan_invalid_morning' };
  if (raw.note !== undefined && !text(raw.note, MEETING_LIMITS.rowNote)) return { ok: false, error: 'dailyplan_invalid_note' };
  if (!stamp(raw.createdAt) || !stamp(raw.updatedAt)) return { ok: false, error: 'dailyplan_invalid_timestamp' };
  return { ok: true, value: raw as unknown as DailyTeamPlan };
}

export function checkMeetingNote(raw: unknown): Check<MeetingNote> {
  if (!isObj(raw)) return { ok: false, error: 'meetingnote_not_an_object' };
  if (!isBusinessDateString(raw.date)) return { ok: false, error: 'meetingnote_invalid_date' };
  if (raw.id !== meetingNoteId(raw.date)) return { ok: false, error: 'meetingnote_id_mismatch' };
  for (const f of ['morning', 'evening', 'tomorrow']) if (raw[f] !== undefined && !text(raw[f], MEETING_LIMITS.note)) return { ok: false, error: `meetingnote_invalid_${f}` };
  if (!stamp(raw.createdAt) || !stamp(raw.updatedAt)) return { ok: false, error: 'meetingnote_invalid_timestamp' };
  return { ok: true, value: raw as unknown as MeetingNote };
}

export interface MeetingCommitInput {
  puts: ReadonlyArray<{ kind: string; id: string; json: string }>;
  deletes: ReadonlyArray<{ kind: string; id: string }>;
  view: { get(kind: string, id: string): string | null; list?(kind: string): Array<{ id: string; json: string }> };
  isSv: boolean;
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

/**
 * Who may write meeting records and what they must refer to. SV only; a plan names a project of THIS workspace and, when it names a
 * scope, a scope of that project. Returns a short machine-readable reason, or null.
 */
export function meetingCommitError(input: MeetingCommitInput): string | null {
  const { puts, deletes, view, isSv } = input;
  const touches = puts.some((p) => p.kind === 'dailyPlan' || p.kind === 'meetingNote') || deletes.some((d) => d.kind === 'dailyPlan' || d.kind === 'meetingNote');
  if (!touches) return null;
  if (!isSv) return 'meeting_sv_only';

  const newScopes = new Map<string, Obj>();
  for (const p of puts) if (p.kind === 'scope') {
    const o = parse(p.json);
    if (o !== null) newScopes.set(p.id, o);
  }

  for (const p of puts) {
    if (p.kind === 'meetingNote') {
      const check = checkMeetingNote(parse(p.json));
      if (!check.ok) return check.error;
      if (check.value.id !== p.id) return 'meetingnote_id_mismatch';
    }
    if (p.kind !== 'dailyPlan') continue;
    const check = checkDailyPlan(parse(p.json));
    if (!check.ok) return check.error;
    const next = check.value;
    if (next.id !== p.id) return 'dailyplan_id_mismatch';
    const prev = parse(view.get('dailyPlan', p.id));
    if (prev !== null && JSON.stringify(prev) === JSON.stringify(parse(p.json))) continue; // unchanged: nothing to check
    if (prev === null) {
      const projects = view.list?.('project') ?? [];
      const known = projects.some((r) => parse(r.json)?.projectId === next.projectId) || puts.some((q) => q.kind === 'project' && parse(q.json)?.projectId === next.projectId);
      if (!known) return 'dailyplan_project_not_found';
      if (next.scopeId !== undefined) {
        const scope = newScopes.get(next.scopeId) ?? parse(view.get('scope', next.scopeId));
        if (scope === null || scope.projectId !== next.projectId) return 'dailyplan_scope_not_found';
      }
    }
  }
  return null;
}

/** How many days of plans and notes a workspace may keep (Stage 8E); the SV picks one in Settings. */
export const RETENTION_CHOICES = [90, 180, 365, 730] as const;
export const DEFAULT_PLAN_RETENTION_DAYS = 365;

/** The oldest calendar day (YYYY-MM-DD) whose plans and notes are still kept: today minus the retention days. Older days are removed (strictly before it). */
export function retentionCutoff(today: string, retentionDays: number): string {
  const epoch = Math.floor(Date.parse(`${today}T00:00:00.000Z`) / 86_400_000) - retentionDays;
  return new Date(epoch * 86_400_000).toISOString().slice(0, 10);
}

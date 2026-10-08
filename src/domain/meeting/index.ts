import {
  cleanPlannedCases,
  dailyPlanId,
  meetingNoteId,
  type DailyTeamPlan,
  type MeetingNote,
} from '../../../shared/meeting';
import type { AttendanceRecord, CaseResult, ProjectRecord, QaInputs, RcsMember, TestCase, TesterProjectAssignment, TestScope } from '../../types';
import { entryCompletedCases, entryForDate } from '../../lib/calculations/dailyExecuted';
import { generateDailyPlan } from '../../lib/calculations/dailyPlan';
import { addDays, formatDate, parseDate } from '../../lib/dates/dates';
import { nextBusinessDayEpoch } from '../../lib/dates/businessDays';
import { dayWindowsFromRows, projectDayWindowDefaults, rowDayWindow, workdayProductiveHours } from '../../lib/calculations/workday';
import { isActiveMember } from '../teamMembers/directory';
import { resultsByCase, scopeAssignees, summarize, type ScopeAssignee } from '../testManagement';
import { projectTotals } from '../testManagement/totals';
import { isAssignmentCurrent, needsAttention, projectMetrics, projectRiskSignals, type ExecutionMetrics, type RiskContext, type RiskSignal } from '../qaMetrics';

export * from './state';

/**
 * The SV's Morning / Evening team meeting (Stage 8D). Everything here is READ from sources that already exist; the only things the
 * meeting stores are the plans an SV typed (DailyTeamPlan) and the day's notes (MeetingNote).
 *
 * Where each number comes from - and what is deliberately NOT added to what:
 *
 *   Total Test Cases      the authoritative project Total (`inputs.totalCases`, derived from the scopes' Totals when they have one).
 *   Today's plan          the SV's DailyTeamPlan for the day; when there is none, the project's own daily plan (its manual targets or
 *                         the capacity plan the Dashboard shows); when there is neither, "not set". Never "remaining / days".
 *   Today's actual        the project's daily execution entry for the day (Stage 8A aggregate model: Today's Execution).
 *   Pass / Fail / Blocked the same entry. Remaining and progress come from the aggregate totals against the authoritative Total.
 *   Detailed coverage     Stage 8C case results of the REGISTERED cases, shown only as a drill-down per scope. They are never added to
 *                         the aggregate numbers above, so nothing is counted twice.
 */

export type PlanSource = 'meeting' | 'project' | 'none';

export interface PlanFigure {
  /** The plan, or null when nothing plans this day. */
  planned: number | null;
  source: PlanSource;
  /** The Morning target to compare the day against (the confirmed one, else the plan itself); null when not planned. */
  target: number | null;
  /** The plan was changed after the Morning target was confirmed. */
  revised: boolean;
}

const none: PlanFigure = { planned: null, source: 'none', target: null, revised: false };

/** The project's own plan for a date: a manual target if one exists, else the capacity plan the Dashboard shows. Null when the date is not in the plan. */
export function enginePlannedFor(inputs: QaInputs, date: string): number | null {
  const rows = inputs.planningRows ?? [];
  if (rows.length === 0 || !rows.some((r) => r.date === date)) return null;
  const productive = workdayProductiveHours(inputs.startTime, inputs.dailyOvertimeMinutes);
  const windows = dayWindowsFromRows(rows, projectDayWindowDefaults(inputs));
  const plan = generateDailyPlan(rows, inputs.perHourPerTester, productive, inputs.totalCases, inputs.targetPassRate ?? 1, inputs.dailyTargetOverrides ?? [], windows);
  const row = plan.find((r) => r.date === date);
  return row === undefined || row.nonWorkingDay ? null : Math.round(row.plannedExecute);
}

/** The plan figure of one project on one date (scope plans win over a project-level plan; neither -> the project's own plan). */
export function planFor(project: ProjectRecord, date: string, plans: readonly DailyTeamPlan[]): PlanFigure {
  const mine = plans.filter((p) => p.projectId === project.projectId && p.date === date);
  const scoped = mine.filter((p) => p.scopeId !== undefined);
  const chosen = scoped.length > 0 ? scoped : mine.filter((p) => p.scopeId === undefined);
  if (chosen.length > 0) {
    const planned = chosen.reduce((sum, p) => sum + p.plannedCases, 0);
    const target = chosen.reduce((sum, p) => sum + (p.morningCases ?? p.plannedCases), 0);
    return { planned, source: 'meeting', target, revised: chosen.some((p) => p.morningCases !== undefined && p.morningCases !== p.plannedCases) };
  }
  const engine = enginePlannedFor(project.inputs, date);
  return engine === null ? none : { planned: engine, source: 'project', target: engine, revised: false };
}

/** The plan of one scope on one date (its own record only). */
export function scopePlanFor(scope: TestScope, date: string, plans: readonly DailyTeamPlan[]): DailyTeamPlan | undefined {
  return plans.find((p) => p.projectId === scope.projectId && p.date === date && p.scopeId === scope.id);
}

/** The next business day after `date` (weekends and Japanese holidays skipped): what "tomorrow" means for a Friday evening. */
export function nextBusinessDate(date: string): string {
  const epoch = parseDate(date);
  return epoch === null ? date : formatDate(nextBusinessDayEpoch(epoch));
}

/** The calendar day after `date`. */
export function nextCalendarDate(date: string): string {
  const epoch = parseDate(date);
  return epoch === null ? date : formatDate(addDays(epoch, 1));
}

// ---- the whole-team picture -------------------------------------------------------------

export type MeetingRiskCode = RiskSignal['code'] | 'below_plan' | 'no_plan_set';
export interface MeetingRisk {
  code: MeetingRiskCode;
  severity: RiskSignal['severity'];
  value?: number;
}

export interface MeetingInputs {
  /** The meeting date: today in the business time zone. */
  today: string;
  /** The date the Evening meeting plans for. */
  tomorrow: string;
  nowIso: string;
  projects: readonly ProjectRecord[];
  scopes: readonly TestScope[];
  testCases: readonly TestCase[];
  caseResults: readonly CaseResult[];
  assignments: readonly TesterProjectAssignment[];
  members: readonly RcsMember[];
  attendance: readonly AttendanceRecord[];
  plans: readonly DailyTeamPlan[];
}

export interface MeetingScopeRow {
  scope: TestScope;
  /** The scope's typed Total, or null. */
  total: number | null;
  registered: number;
  /** Registered cases that are completed (Pass + Fail + N/A + SPO): detail only. */
  registeredCompleted: number;
  plan: DailyTeamPlan | undefined;
  tomorrow: DailyTeamPlan | undefined;
  people: ScopeAssignee[];
}

export interface DayActual {
  /** True when a Today's Execution entry exists for the day. */
  recorded: boolean;
  completed: number;
  pass: number;
  fail: number;
  blocked: number;
  notApplicable: number;
  spo: number;
}

export interface MeetingProjectRow {
  project: ProjectRecord;
  /** Authoritative Total Test Cases. */
  total: number;
  registered: number;
  metrics: ExecutionMetrics;
  today: PlanFigure;
  tomorrow: PlanFigure;
  actual: DayActual;
  /** Actual minus the Morning target; null when either is unknown. */
  difference: number | null;
  /** The people on the project (accounts and profiles without a login alike). */
  people: ScopeAssignee[];
  risks: MeetingRisk[];
  attention: boolean;
  scopes: MeetingScopeRow[];
  /** The day's working window as minutes of day, or null on a non-working day / outside the plan. */
  window: { start: number; end: number } | null;
  /** Open tickets (their keys), most recent first, for the detail panel. */
  openIssues: string[];
}

export interface AttendanceFigure {
  recorded: boolean;
  attending: number;
  total: number;
}

export interface MeetingSummary {
  activeProjects: number;
  activeScopes: number;
  teamMembers: number;
  /** The team's plan for today (current). */
  plannedToday: number;
  /** The team's Morning target for today: the confirmed target where there is one, else the plan. The Evening compares against this. */
  targetToday: number;
  /** Projects whose plan for today is not set at all. */
  unplannedProjects: number;
  actualToday: number;
  difference: number;
  pass: number;
  fail: number;
  blocked: number;
  remaining: number;
  tomorrowPlanned: number;
  needsAttention: number;
  blockedProjects: number;
  attendance: AttendanceFigure;
}

export interface MeetingView {
  rows: MeetingProjectRow[];
  summary: MeetingSummary;
  note: MeetingNote | undefined;
}

const OPEN_TICKET = (status: string | undefined): boolean => status === undefined || status === 'Open' || status === 'In Progress';

/** Is this project part of the team's day? Running projects, ones starting by today, ones that executed today, and ones with a plan. */
export function inMeeting(project: ProjectRecord, date: string, plans: readonly DailyTeamPlan[]): boolean {
  if (plans.some((p) => p.projectId === project.projectId && p.date === date && p.plannedCases > 0)) return true;
  if (entryForDate(project.inputs.dailyExecuted ?? [], date) !== null) return true;
  if (project.status === 'ongoing' || project.status === 'extended') return true;
  return project.status === 'todo' && project.inputs.startDate <= date;
}

function actualOf(project: ProjectRecord, date: string): DayActual {
  const entry = entryForDate(project.inputs.dailyExecuted ?? [], date);
  if (entry === null) return { recorded: false, completed: 0, pass: 0, fail: 0, blocked: 0, notApplicable: 0, spo: 0 };
  const n = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
  return { recorded: true, completed: entryCompletedCases(entry), pass: n(entry.pass), fail: n(entry.fail), blocked: n(entry.blocked), notApplicable: n(entry.notApplicable), spo: n(entry.spo) };
}

function windowOf(project: ProjectRecord, date: string): { start: number; end: number } | null {
  const row = (project.inputs.planningRows ?? []).find((r) => r.date === date);
  if (row === undefined || row.nonWorkingDay) return null;
  const w = rowDayWindow(row, projectDayWindowDefaults(project.inputs));
  return { start: w.start, end: w.end };
}

export function attendanceFor(date: string, attendance: readonly AttendanceRecord[]): AttendanceFigure {
  const rows = attendance.filter((a) => a.date === date);
  if (rows.length === 0) return { recorded: false, attending: 0, total: 0 };
  const attending = rows.filter((a) => a.status === 'PRESENT' || a.status === 'LATE' || a.status === 'HALF_DAY').length;
  return { recorded: true, attending, total: rows.length };
}

/** Extra, deterministic signals only the meeting can see (the day's plan against the day's actual). */
function meetingRisks(row: Pick<MeetingProjectRow, 'today' | 'actual' | 'difference' | 'project'>, evening: boolean): MeetingRisk[] {
  const out: MeetingRisk[] = [];
  if (row.today.planned === null && row.project.status === 'ongoing') out.push({ code: 'no_plan_set', severity: 'info' });
  if (evening && row.actual.recorded && row.difference !== null && row.difference < 0) out.push({ code: 'below_plan', severity: 'warning', value: -row.difference });
  return out;
}

export function buildMeeting(input: MeetingInputs, notes: readonly MeetingNote[], evening: boolean): MeetingView {
  const { today, tomorrow } = input;
  const byCase = resultsByCase(input.caseResults);
  const ctx: RiskContext = { today, nowIso: input.nowIso, assignments: input.assignments };
  const rows: MeetingProjectRow[] = [];

  for (const project of input.projects) {
    if (!inMeeting(project, today, input.plans)) continue;
    const totals = projectTotals(project, input.scopes, input.testCases);
    const metrics = projectMetrics(project);
    const todayPlan = planFor(project, today, input.plans);
    const actual = actualOf(project, today);
    const difference = actual.recorded && todayPlan.target !== null ? actual.completed - todayPlan.target : null;
    const scopes: MeetingScopeRow[] = totals.scopes.map((r) => {
      const cases = input.testCases.filter((c) => c.scopeId === r.scope.id);
      const sum = summarize(cases, byCase);
      return {
        scope: r.scope,
        total: r.total,
        registered: r.registered,
        registeredCompleted: sum.completed,
        plan: scopePlanFor(r.scope, today, input.plans),
        tomorrow: scopePlanFor(r.scope, tomorrow, input.plans),
        people: scopeAssignees(r.scope, input.assignments, today),
      };
    });
    const people: ScopeAssignee[] = [];
    const seen = new Set<string>();
    for (const a of input.assignments) {
      if (a.projectId !== project.projectId || !isAssignmentCurrent(a, today)) continue;
      const key = a.userId !== undefined ? `u:${a.userId}` : a.memberId !== undefined ? `m:${a.memberId}` : `n:${a.testerName ?? a.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      people.push({ key, ...(a.userId === undefined ? {} : { userId: a.userId }), ...(a.memberId === undefined ? {} : { memberId: a.memberId }) });
    }
    const partial = { project, today: todayPlan, actual, difference };
    const risks: MeetingRisk[] = [...projectRiskSignals(project, ctx), ...meetingRisks(partial, evening)];
    rows.push({
      project,
      total: totals.total,
      registered: totals.registered,
      metrics,
      today: todayPlan,
      tomorrow: planFor(project, tomorrow, input.plans),
      actual,
      difference,
      people,
      risks,
      attention: needsAttention(risks.filter((r): r is RiskSignal => r.code !== 'below_plan' && r.code !== 'no_plan_set')),
      scopes,
      window: windowOf(project, today),
      openIssues: (project.inputs.bugTickets ?? [])
        .filter((t) => OPEN_TICKET(t.status))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((t) => t.ticketKey ?? t.title),
    });
  }
  rows.sort((a, b) => a.project.projectId.localeCompare(b.project.projectId));

  const sum = (f: (r: MeetingProjectRow) => number): number => rows.reduce((s, r) => s + f(r), 0);
  const plannedToday = sum((r) => r.today.planned ?? 0);
  const targetToday = sum((r) => r.today.target ?? 0);
  const actualToday = sum((r) => r.actual.completed);
  const summary: MeetingSummary = {
    activeProjects: rows.length,
    activeScopes: sum((r) => r.scopes.length),
    teamMembers: input.members.filter((m) => isActiveMember(m, today)).length,
    plannedToday,
    targetToday,
    unplannedProjects: rows.filter((r) => r.today.planned === null).length,
    actualToday,
    difference: actualToday - sum((r) => (r.actual.recorded ? (r.today.target ?? 0) : 0)),
    pass: sum((r) => r.actual.pass),
    fail: sum((r) => r.actual.fail),
    blocked: sum((r) => r.actual.blocked),
    remaining: sum((r) => r.metrics.remaining),
    tomorrowPlanned: sum((r) => r.tomorrow.planned ?? 0),
    needsAttention: rows.filter((r) => r.attention).length,
    blockedProjects: rows.filter((r) => r.risks.some((x) => x.code === 'blocked_cases')).length,
    attendance: attendanceFor(today, input.attendance),
  };
  return { rows, summary, note: notes.find((n) => n.date === today) };
}

// ---- writing plans and notes -----------------------------------------------------------------

export interface PlanEdit {
  date: string;
  projectId: string;
  scopeId?: string;
  plannedCases: number;
  note?: string;
  /**
   * 'morning' keeps the plan's Morning target as it was set; 'evening' on a day that has already begun first stamps the previous plan as
   * the Morning target, so the day can still be judged against what the team set out to do.
   */
  mode: 'morning' | 'evening';
  today: string;
}

/**
 * Set one plan. Returns the SAME array when nothing changes (so nothing is written). A plan is one record per day and place; changing
 * it changes that record only. In the Evening meeting, changing the plan of a day that has already begun keeps the earlier plan as the
 * Morning target (once), so the Morning value is never overwritten by the Evening's.
 */
export function setPlan(plans: readonly DailyTeamPlan[], edit: PlanEdit, nowIso: string): DailyTeamPlan[] {
  const cases = cleanPlannedCases(edit.plannedCases);
  if (cases === null) return plans as DailyTeamPlan[];
  const id = dailyPlanId(edit.date, edit.projectId, edit.scopeId);
  const prev = plans.find((p) => p.id === id);
  const note = edit.note === undefined ? prev?.note : edit.note.trim() === '' ? undefined : edit.note.trim();
  if (prev !== undefined && prev.plannedCases === cases && prev.note === note) return plans as DailyTeamPlan[];
  let morning = prev?.morningCases;
  if (edit.mode === 'evening' && edit.date <= edit.today && prev !== undefined && morning === undefined && prev.plannedCases !== cases) morning = prev.plannedCases;
  const next: DailyTeamPlan = {
    id,
    date: edit.date,
    projectId: edit.projectId,
    ...(edit.scopeId === undefined ? {} : { scopeId: edit.scopeId }),
    plannedCases: cases,
    ...(morning === undefined ? {} : { morningCases: morning }),
    ...(note === undefined ? {} : { note }),
    createdAt: prev?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };
  return prev === undefined ? [...plans, next] : plans.map((p) => (p.id === id ? next : p));
}

/** "Confirm the plan": freeze today's plans as the Morning target (only records that have no target yet). */
export function confirmMorning(plans: readonly DailyTeamPlan[], date: string, nowIso: string, projectId?: string): DailyTeamPlan[] {
  let changed = false;
  const next = plans.map((p) => {
    if (p.date !== date || (projectId !== undefined && p.projectId !== projectId) || p.morningCases === p.plannedCases) return p;
    changed = true;
    return { ...p, morningCases: p.plannedCases, updatedAt: nowIso };
  });
  return changed ? next : (plans as DailyTeamPlan[]);
}

export type NoteField = 'morning' | 'evening' | 'tomorrow';

/** Set one of a day's notes. Returns the SAME array when the text did not change. An emptied note is kept as an empty record, not deleted. */
export function setNote(notes: readonly MeetingNote[], date: string, field: NoteField, textValue: string, nowIso: string): MeetingNote[] {
  const id = meetingNoteId(date);
  const prev = notes.find((n) => n.id === id);
  const value = textValue.replace(/\r\n/g, '\n').trim();
  if ((prev?.[field] ?? '') === value) return notes as MeetingNote[];
  const { [field]: _old, ...rest } = prev ?? { id, date, createdAt: nowIso, updatedAt: nowIso };
  const next: MeetingNote = { ...(rest as MeetingNote), ...(value === '' ? {} : { [field]: value }), updatedAt: nowIso };
  return prev === undefined ? [...notes, next] : notes.map((n) => (n.id === id ? next : n));
}

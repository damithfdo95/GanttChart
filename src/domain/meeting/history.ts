import { retentionCutoff, type DailyTeamPlan, type MeetingNote } from '../../../shared/meeting';
import { entryCompletedCases, entryForDate } from '../../lib/calculations/dailyExecuted';
import { formatDate, parseDate } from '../../lib/dates/dates';
import type { ProjectRecord, TestScope } from '../../types';
import { nextBusinessDate } from './index';

/**
 * Meeting History (Stage 8E): a past business day as it was STORED - the plan the team set, the results recorded, the day's notes, and the plan
 * made that day for the next business day. Nothing is recomputed from today's settings except where a row says so.
 *
 *  - Plan   = the stored plan of the day: the Morning target when one was kept, else the plan itself. Scope plans win over a project-level plan
 *             (never both). Only STORED plans count: the project's own capacity plan is a live calculation, not a record of what the team decided.
 *  - Actual = the project's recorded Today's Execution for the day (Pass + Fail + N/A + SPO + migrated remainder). A project that had a plan but
 *             recorded nothing contributes 0, so Difference = Actual total - Plan total holds over one row set (the Stage 8D.1 rule).
 *  - Remaining at the end of the day = the CURRENT Total minus everything completed up to that day. The Total of that day is not kept, so the
 *             screen says this figure is measured against today's Total.
 *  - Scope rows: the stored plan only. Results are recorded per project, so there is no per-scope actual to show, and none is invented.
 *  - People: assignments are not stored per day, so no assignee is shown for a past day.
 */

export interface HistoryRow {
  project: ProjectRecord;
  plan: number | null;
  /** The plan as it stood at the end of the day when it differs from the Morning target. */
  revisedTo: number | null;
  actual: number | null;
  difference: number | null;
  pass: number | null;
  fail: number | null;
  blocked: number | null;
  remainingAtEnd: number | null;
  tomorrow: number | null;
  scopes: Array<{ scope: TestScope; plan: number }>;
}

export interface HistoryTotals {
  plan: number;
  actual: number;
  difference: number;
  pass: number;
  fail: number;
  blocked: number;
  tomorrow: number;
}

export interface HistoryDay {
  date: string;
  tomorrowDate: string;
  rows: HistoryRow[];
  totals: HistoryTotals;
  note: MeetingNote | undefined;
  /** Nothing stored for the day at all (no plan, no result, no note). */
  empty: boolean;
  /** The day is older than the retention window: its plans and notes are no longer kept. */
  outsideRetention: boolean;
  /** The oldest day still kept. */
  retainedFrom: string;
}

export interface HistoryInput {
  projects: readonly ProjectRecord[];
  scopes: readonly TestScope[];
  plans: readonly DailyTeamPlan[];
  notes: readonly MeetingNote[];
  /** Today, business time. */
  today: string;
  retentionDays: number;
}

export function retainedFrom(today: string, retentionDays: number): string {
  return retentionCutoff(today, retentionDays);
}

/** Local storage has no server to do the housekeeping: the same cutoff applied to this device's plans and notes. Returns the SAME arrays when nothing is old. */
export function retainMeetingHistory<P extends { date: string }, N extends { date: string }>(plans: readonly P[], notes: readonly N[], today: string, retentionDays: number): { plans: P[]; notes: N[]; removed: number } {
  const cutoff = retentionCutoff(today, retentionDays);
  const keepPlans = plans.filter((p) => p.date >= cutoff);
  const keepNotes = notes.filter((n) => n.date >= cutoff);
  const removed = plans.length - keepPlans.length + notes.length - keepNotes.length;
  return removed === 0 ? { plans: plans as P[], notes: notes as N[], removed } : { plans: keepPlans, notes: keepNotes, removed };
}

/** The stored plan of a project on a day: the sum of its scope plans, else its project-level plan, else null. */
function storedPlan(project: ProjectRecord, date: string, plans: readonly DailyTeamPlan[]): { target: number; planned: number } | null {
  const mine = plans.filter((p) => p.projectId === project.projectId && p.date === date);
  const scoped = mine.filter((p) => p.scopeId !== undefined);
  const chosen = scoped.length > 0 ? scoped : mine;
  if (chosen.length === 0) return null;
  return { target: chosen.reduce((s, p) => s + (p.morningCases ?? p.plannedCases), 0), planned: chosen.reduce((s, p) => s + p.plannedCases, 0) };
}

export function historyDay(input: HistoryInput, date: string): HistoryDay {
  const tomorrowDate = nextBusinessDate(date);
  const from = retainedFrom(input.today, input.retentionDays);
  const rows: HistoryRow[] = [];
  for (const project of input.projects) {
    const entries = project.inputs.dailyExecuted ?? [];
    const entry = entryForDate(entries, date);
    const plan = storedPlan(project, date, input.plans);
    if (entry === null && plan === null) continue;
    const completedBy = entries.filter((e) => e.date <= date).reduce((s, e) => s + entryCompletedCases(e), 0);
    const n = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
    const actual = entry === null ? null : entryCompletedCases(entry);
    const target = plan === null ? null : plan.target;
    const scopes = input.scopes
      .filter((s) => s.projectId === project.projectId)
      .map((scope) => ({ scope, plan: input.plans.find((p) => p.projectId === project.projectId && p.date === date && p.scopeId === scope.id)?.plannedCases }))
      .filter((x): x is { scope: TestScope; plan: number } => x.plan !== undefined);
    rows.push({
      project,
      plan: target,
      revisedTo: plan !== null && plan.planned !== plan.target ? plan.planned : null,
      actual,
      difference: actual !== null && target !== null ? actual - target : null,
      pass: entry === null ? null : n(entry.pass),
      fail: entry === null ? null : n(entry.fail),
      blocked: entry === null ? null : n(entry.blocked),
      remainingAtEnd: entry === null && completedBy === 0 ? null : Math.max(n(project.inputs.totalCases) - completedBy, 0),
      tomorrow: storedPlan(project, tomorrowDate, input.plans)?.planned ?? null,
      scopes,
    });
  }
  rows.sort((a, b) => a.project.projectId.localeCompare(b.project.projectId));
  const sum = (f: (r: HistoryRow) => number | null): number => rows.reduce((s, r) => s + (f(r) ?? 0), 0);
  const plan = sum((r) => r.plan);
  const actual = sum((r) => r.actual);
  const note = input.notes.find((x) => x.date === date);
  return {
    date,
    tomorrowDate,
    rows,
    totals: { plan, actual, difference: actual - plan, pass: sum((r) => r.pass), fail: sum((r) => r.fail), blocked: sum((r) => r.blocked), tomorrow: sum((r) => r.tomorrow) },
    note,
    empty: rows.length === 0 && note === undefined,
    outsideRetention: date < from,
    retainedFrom: from,
  };
}

/** Plan against actual for every day in a range that has something stored, newest first. */
export function historyRange(input: HistoryInput, from: string, to: string): Array<{ date: string; totals: HistoryTotals }> {
  const start = parseDate(from);
  const end = parseDate(to);
  if (start === null || end === null || end < start) return [];
  const out: Array<{ date: string; totals: HistoryTotals }> = [];
  for (let d = end; d >= start && end - d < 400; d -= 1) {
    const day = historyDay(input, formatDate(d));
    if (day.rows.length > 0) out.push({ date: day.date, totals: day.totals });
  }
  return out;
}

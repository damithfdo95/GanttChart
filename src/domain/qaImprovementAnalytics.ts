import { businessDate } from '../../shared/businessTime';
import { QA_WORK_TYPES } from '../../shared/qaPolicy';
import type { BugTicket, CaseExecutionEvent, DailyExecutionEntry, ProjectRecord, RcsMember, TestScope, TesterProjectAssignment } from '../types';
import { entryCompletedCases } from '../lib/calculations/dailyExecuted';
import { eventBusinessDate, sortEventsAscending } from './testManagement';
import { workMixOfProject, workTypeOf, type WorkMixRow, type WorkTypeKey } from './qaWork';

/**
 * QA improvement analytics for the CURRENT workspace (one QA team): patterns over a date range that help a supervisor improve planning,
 * staffing, execution flow, release predictability and retest load. Pure and derived: nothing is stored, nothing is fetched, no clock is read.
 *
 * Only facts that can be reconstructed historically are used:
 *   saved Daily Execution entries, the immutable case-execution history, the per-day plan rows, project dates and completion time,
 *   ticket creation dates.
 * Deliberately NOT used as history: release readiness (no snapshots), forecasts (no snapshots), current assignments, ticket status.
 *
 * Definitions (all labelled the same way on screen):
 *   Completed cases   Pass + Fail + N/A + SPO (+ uncategorised completed) of the saved Daily Execution - never an event count.
 *   Execution events  every case-execution event (a case run three times is three). Activity, not throughput.
 *   Unique cases      distinct cases whose final state of a day is not Not Started.
 *   Failure rate      failed / completed, on the same basis (null when completed is 0).
 *   Retest events     case-execution events flagged as a retest.
 *   Staffing          planned (the day's plan row) vs actual (the saved entry's testers); a day without an actual is missing, never 0.
 * Weeks are Monday-Sunday business dates (Asia/Tokyo calendar dates).
 * With a work-type filter the figures come from case history (the saved aggregate has no work type); staffing and releases stay per project.
 */

/** Smallest change that is reported as a movement (below it the comparison is shown but is not a signal). One place, no per-metric tuning. */
export const MIN_RELATIVE_CHANGE = 0.05;
/** Smallest change of a rate (failure rate, share of days) in percentage points. */
export const MIN_RATE_CHANGE_PP = 0.5;
/** Smallest change of average staffing variance, in testers. */
export const MIN_STAFFING_CHANGE = 0.25;
/** A range longer than this is clipped (keeps the per-day work bounded). */
export const MAX_RANGE_DAYS = 366;

export interface AnalyticsRange {
  from: string;
  to: string;
}

export type WorkTypeFilter = WorkTypeKey | 'all';
export const WORK_TYPE_ORDER: readonly WorkTypeKey[] = [...QA_WORK_TYPES, 'unspecified'];

export const addDays = (date: string, n: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** The Monday of the business week the date belongs to. */
export function weekStartOf(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7));
}

export function presetRange(days: number, today: string): AnalyticsRange {
  return { from: addDays(today, -(days - 1)), to: today };
}

/** The immediately preceding range of the same length. */
export function previousRangeOf(range: AnalyticsRange): AnalyticsRange {
  const len = daysBetween(range.from, range.to) + 1;
  return { from: addDays(range.from, -len), to: addDays(range.from, -1) };
}

export function normalizeRange(range: AnalyticsRange, today: string): AnalyticsRange {
  let { from, to } = range;
  if (to > today) to = today;
  if (from > to) from = to;
  if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) from = addDays(to, -(MAX_RANGE_DAYS - 1));
  return { from, to };
}

const datesIn = (range: AnalyticsRange): string[] => {
  const out: string[] = [];
  for (let d = range.from; d <= range.to; d = addDays(d, 1)) out.push(d);
  return out;
};

/** Percentage change, or null when the previous value is zero/invalid (never Infinity or NaN). */
export function percentChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || !Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null;
  return (current - previous) / previous;
}

const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);
const avg = (values: readonly number[]): number | null => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);
const nameOf = (p: ProjectRecord): string => (p.nameEn !== '' ? p.nameEn : p.nameJa) || p.projectId;
const COMPLETED = new Set(['pass', 'fail', 'na', 'spo']);

export interface QaImprovementInput {
  projects: readonly ProjectRecord[];
  scopes: readonly TestScope[];
  caseExecution: readonly CaseExecutionEvent[];
  assignments?: readonly TesterProjectAssignment[];
  members?: readonly RcsMember[];
  /** Defaults to each project's own recorded tickets. */
  tickets?: readonly BugTicket[];
  range: AnalyticsRange;
  /** The current business day (injected). */
  today: string;
  projectId?: string | null;
  workType?: WorkTypeFilter;
}

export interface AnalyticsDay {
  date: string;
  /** Completed cases (null = no data that day). Basis: saved Daily Execution, or case history under a work-type filter. */
  completed: number | null;
  failed: number | null;
  blocked: number | null;
  /** Execution events, unique cases and retest events always come from case history (null before history exists). */
  events: number | null;
  uniqueCases: number | null;
  retestEvents: number | null;
  plannedTesters: number | null;
  actualTesters: number | null;
}

export interface AnalyticsWeek {
  weekStart: string;
  days: number;
  completed: number;
  failed: number;
  failureRate: number | null;
  events: number;
  retestEvents: number;
}

export interface AnalyticsSummary {
  completed: number;
  failed: number;
  failureRate: number | null;
  executionEvents: number;
  uniqueCases: number;
  retestEvents: number;
  retestPer100Events: number | null;
  casesRunMoreThanOnce: number;
  avgActualTesters: number | null;
  staffingAvgVariance: number | null;
  completedReleases: number;
  lateReleases: number;
  /** Project-days with at least one blocked case (final state of the day / the saved day tally). */
  blockedProjectDays: number;
  activeProjectDays: number;
  blockedShare: number | null;
}

export interface StaffingStats {
  /** Project-days with BOTH a plan row and a recorded actual. */
  comparedDays: number;
  avgPlanned: number | null;
  avgActual: number | null;
  avgVariance: number | null;
  understaffedDays: number;
  overPlannedDays: number;
  /** Planned working project-days (up to today) that have no recorded actual: coverage gap, not zero. */
  missingActualDays: number;
  byProject: Array<{ projectId: string; projectName: string; comparedDays: number; understaffedDays: number; avgVariance: number | null }>;
}

export interface WorkTypeRow {
  workType: WorkTypeKey;
  scopes: number;
  events: number;
  uniqueCases: number;
  /** Case-days that ended Pass / Fail / N/A / SPO (history). */
  completedCases: number;
  failedCases: number;
  failureRate: number | null;
  retestEvents: number;
  retestPer100Events: number | null;
  activeDays: number;
  completedPerActiveDay: number | null;
  /** Verification only: JIRA tickets raised in the range, a different unit that is never added to cases. */
  tickets: number | null;
}

export interface ReleaseRow {
  projectId: string;
  projectName: string;
  plannedFinish: string | null;
  actualCompletion: string;
  /** actual - planned in days: positive late, negative early; null without a planned finish. */
  daysVariance: number | null;
  outcome: 'late' | 'early' | 'onTime' | 'unknown';
  completedCases: number;
  failedCases: number;
  failureRate: number | null;
  blockedAtEnd: number | null;
  /** The project's CURRENT work mix (scopes are not versioned). */
  workMix: WorkMixRow[];
  plannedDurationDays: number | null;
  actualDurationDays: number | null;
  plannedAvgTesters: number | null;
  actualAvgTesters: number | null;
  plannedVolume: number;
}

export interface TesterFact {
  key: string;
  name: string;
  events: number;
  uniqueCases: number;
  activeDays: number;
  /** CURRENT assignments (not history). */
  assignedScopes: number;
}

export type SignalId =
  | 'throughput'
  | 'retest'
  | 'failureRate'
  | 'staffingVariance'
  | 'understaffed'
  | 'lateReleases'
  | 'onTimeReleases'
  | 'workTypeFailureRate'
  | 'blockerPersistence';

export interface AnalyticsSignal {
  id: SignalId;
  kind: 'review' | 'improved';
  /** Values the sentence is built from (the screen formats them). */
  values: Record<string, number | string>;
  /** The projects behind the signal, for the drill-down. */
  projects: Array<{ projectId: string; projectName: string }>;
}

export interface ComparisonRow {
  metric: 'completed' | 'failureRate' | 'retestEvents' | 'staffingVariance' | 'executionEvents' | 'uniqueCases';
  current: number | null;
  previous: number | null;
  /** Relative change (null when the previous value is 0/missing, or for rates). */
  percent: number | null;
  /** Absolute change (percentage points for rates, testers for staffing); null when either side is missing. */
  absolute: number | null;
}

export interface QaImprovementAnalytics {
  range: AnalyticsRange;
  previousRange: AnalyticsRange;
  workType: WorkTypeFilter;
  projectId: string | null;
  /** Where completed / failed / blocked come from. */
  basis: 'saved' | 'history';
  projects: Array<{ projectId: string; projectName: string }>;
  history: { hasEvents: boolean; firstEventDate: string | null; partial: boolean };
  summary: AnalyticsSummary;
  previousSummary: AnalyticsSummary;
  comparison: ComparisonRow[];
  days: AnalyticsDay[];
  weeks: AnalyticsWeek[];
  workTypes: WorkTypeRow[];
  staffing: StaffingStats | null;
  releases: ReleaseRow[];
  forecastAccuracy: { available: false };
  readinessTrend: { available: false };
  assignmentHistory: { available: false; currentGaps: Array<{ projectId: string; projectName: string; planned: number; assigned: number }> };
  tickets: { raised: number; byProject: Array<{ projectId: string; projectName: string; raised: number }> };
  testers: TesterFact[];
  signals: { review: AnalyticsSignal[]; improved: AnalyticsSignal[] };
}

// ---- indexes (built once per call) --------------------------------------------------------------

interface ScopeDay {
  events: number;
  retest: number;
  finals: Map<string, string>;
  caseEvents: Map<string, number>;
  byMember: Map<string, { events: number; cases: Set<string> }>;
}
type DayBucket = Map<string, ScopeDay>; // scopeId -> that scope's day
type EventIndex = Map<string, Map<string, DayBucket>>; // projectId -> date -> bucket

function indexEvents(events: readonly CaseExecutionEvent[], projectIds: ReadonlySet<string>): { index: EventIndex; firstEventDate: string | null } {
  const index: EventIndex = new Map();
  let first: string | null = null;
  for (const e of sortEventsAscending(events)) {
    if (!projectIds.has(e.projectId)) continue;
    const date = eventBusinessDate(e);
    if (first === null || date < first) first = date;
    const days = index.get(e.projectId) ?? new Map<string, DayBucket>();
    index.set(e.projectId, days);
    const bucket = days.get(date) ?? new Map<string, ScopeDay>();
    days.set(date, bucket);
    const sd = bucket.get(e.scopeId) ?? { events: 0, retest: 0, finals: new Map(), caseEvents: new Map(), byMember: new Map() };
    bucket.set(e.scopeId, sd);
    sd.events += 1;
    if (e.retest === true) sd.retest += 1;
    sd.finals.set(e.testCaseId, e.status); // ascending order: the last event of the day wins
    sd.caseEvents.set(e.testCaseId, (sd.caseEvents.get(e.testCaseId) ?? 0) + 1);
    if (e.executedByMemberId !== undefined) {
      const m = sd.byMember.get(e.executedByMemberId) ?? { events: 0, cases: new Set<string>() };
      m.events += 1;
      m.cases.add(e.testCaseId);
      sd.byMember.set(e.executedByMemberId, m);
    }
  }
  return { index, firstEventDate: first };
}

interface HistDay {
  events: number;
  retest: number;
  unique: number;
  completed: number;
  failed: number;
  blocked: number;
}

function histOf(bucket: DayBucket | undefined, scopeType: ReadonlyMap<string, WorkTypeKey>, wt: WorkTypeFilter): HistDay | null {
  if (bucket === undefined) return null;
  const out: HistDay = { events: 0, retest: 0, unique: 0, completed: 0, failed: 0, blocked: 0 };
  let any = false;
  for (const [scopeId, sd] of bucket) {
    if (wt !== 'all' && (scopeType.get(scopeId) ?? 'unspecified') !== wt) continue;
    any = true;
    out.events += sd.events;
    out.retest += sd.retest;
    for (const status of sd.finals.values()) {
      if (status === 'notStarted') continue;
      out.unique += 1;
      if (COMPLETED.has(status)) out.completed += 1;
      if (status === 'fail') out.failed += 1;
      if (status === 'blocked') out.blocked += 1;
    }
  }
  return any ? out : null;
}

const hasActual = (e: DailyExecutionEntry | undefined): e is DailyExecutionEntry => e !== undefined && typeof e.testers === 'number' && Number.isFinite(e.testers);

const businessDay = (iso: string | null): string | null => {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? businessDate(ms) : null;
};

// ---- the core (one range) -----------------------------------------------------------------------

interface Core {
  days: AnalyticsDay[];
  summary: AnalyticsSummary;
  staffing: StaffingStats;
  releases: ReleaseRow[];
  workTypes: WorkTypeRow[];
  testers: Map<string, { events: number; cases: Set<string>; days: Set<string> }>;
  blockedProjects: Map<string, number>;
  tickets: { raised: number; byProject: Array<{ projectId: string; projectName: string; raised: number }> };
}

export function buildQaImprovementAnalytics(input: QaImprovementInput): QaImprovementAnalytics {
  const today = input.today;
  const range = normalizeRange(input.range, today);
  const previousRange = previousRangeOf(range);
  const wt: WorkTypeFilter = input.workType ?? 'all';
  const projectFilter = input.projectId ?? null;
  const scopeType = new Map<string, WorkTypeKey>(input.scopes.map((s) => [s.id, workTypeOf(s)] as const));

  const everything: AnalyticsRange = { from: previousRange.from, to: range.to };
  const typeOk = (p: ProjectRecord): boolean => wt === 'all' || input.scopes.some((s) => s.projectId === p.projectId && workTypeOf(s) === wt);
  const lifecycleOk = (p: ProjectRecord): boolean => {
    const entries = p.inputs.dailyExecuted ?? [];
    if (entries.some((e) => e.date >= everything.from && e.date <= everything.to)) return true;
    const done = businessDay(p.completedAt);
    if (p.status === 'done') return done !== null && done >= everything.from && done <= everything.to;
    return p.inputs.startDate <= everything.to; // an unfinished project is part of the picture from its start date
  };
  const hasEventsIn = (p: ProjectRecord, ids: ReadonlySet<string>): boolean => ids.has(p.projectId);
  const candidateIds = new Set(input.projects.filter((p) => projectFilter === null || p.projectId === projectFilter).map((p) => p.projectId));
  const { index, firstEventDate } = indexEvents(input.caseExecution, candidateIds);
  const eventProjects = new Set(index.keys());
  const included = input.projects.filter((p) => (projectFilter === null || p.projectId === projectFilter) && typeOk(p) && (lifecycleOk(p) || hasEventsIn(p, eventProjects)));
  const basis: 'saved' | 'history' = wt === 'all' ? 'saved' : 'history';

  const core = (r: AnalyticsRange): Core => {
    const dates = datesIn(r);
    const days: AnalyticsDay[] = [];
    const testers = new Map<string, { events: number; cases: Set<string>; days: Set<string> }>();
    const blockedProjects = new Map<string, number>();
    const comparedVariances: number[] = [];
    const comparedPlanned: number[] = [];
    const comparedActual: number[] = [];
    let under = 0;
    let over = 0;
    let missingActual = 0;
    const perProject = new Map<string, { vars: number[]; under: number }>();
    const caseRuns = new Map<string, number>();
    const uniqueSeen = new Set<string>();
    let activeProjectDays = 0;
    let blockedProjectDays = 0;
    const actualPerDay: number[] = [];

    const wtRows = new Map<WorkTypeKey, { events: number; retest: number; completed: number; failed: number; unique: Set<string>; days: Set<string>; scopes: Set<string> }>();
    const tickets: Core['tickets'] = { raised: 0, byProject: [] };

    for (const date of dates) {
      let completed: number | null = null;
      let failed: number | null = null;
      let blocked: number | null = null;
      let events: number | null = null;
      let unique: number | null = null;
      let retest: number | null = null;
      let planned: number | null = null;
      let actual: number | null = null;
      for (const p of included) {
        const entries = p.inputs.dailyExecuted ?? [];
        const entry = entries.find((e) => e.date === date);
        const bucket = index.get(p.projectId)?.get(date);
        const hist = histOf(bucket, scopeType, wt);
        // execution activity is always history
        if (hist !== null) {
          events = (events ?? 0) + hist.events;
          unique = (unique ?? 0) + hist.unique;
          retest = (retest ?? 0) + hist.retest;
        }
        const savedBlocked = entry === undefined ? null : entry.blocked;
        if (basis === 'saved' && entry !== undefined) {
          completed = (completed ?? 0) + entryCompletedCases(entry);
          failed = (failed ?? 0) + entry.fail;
          blocked = (blocked ?? 0) + entry.blocked;
        } else if (basis === 'history' && hist !== null) {
          completed = (completed ?? 0) + hist.completed;
          failed = (failed ?? 0) + hist.failed;
          blocked = (blocked ?? 0) + hist.blocked;
        }
        const dayActive = basis === 'saved' ? entry !== undefined : hist !== null;
        if (dayActive) {
          activeProjectDays += 1;
          const b = basis === 'saved' ? savedBlocked : hist?.blocked ?? 0;
          if ((b ?? 0) > 0) {
            blockedProjectDays += 1;
            blockedProjects.set(p.projectId, (blockedProjects.get(p.projectId) ?? 0) + 1);
          }
        }
        // history by work type + people
        if (bucket !== undefined) {
          for (const [scopeId, sd] of bucket) {
            const type = scopeType.get(scopeId) ?? 'unspecified';
            const row = wtRows.get(type) ?? { events: 0, retest: 0, completed: 0, failed: 0, unique: new Set<string>(), days: new Set<string>(), scopes: new Set<string>() };
            wtRows.set(type, row);
            row.events += sd.events;
            row.retest += sd.retest;
            row.days.add(date);
            for (const [caseId, status] of sd.finals) {
              if (status === 'notStarted') continue;
              row.unique.add(caseId);
              if (COMPLETED.has(status)) row.completed += 1;
              if (status === 'fail') row.failed += 1;
            }
            if (wt === 'all' || wt === type) {
              for (const [caseId, n] of sd.caseEvents) caseRuns.set(caseId, (caseRuns.get(caseId) ?? 0) + n);
              for (const [caseId, status] of sd.finals) if (status !== 'notStarted') uniqueSeen.add(caseId);
              for (const [memberId, m] of sd.byMember) {
                const t = testers.get(memberId) ?? { events: 0, cases: new Set<string>(), days: new Set<string>() };
                t.events += m.events;
                for (const c of m.cases) t.cases.add(c);
                t.days.add(date);
                testers.set(memberId, t);
              }
            }
          }
        }
        // staffing (project level)
        const row = p.inputs.planningRows.find((x) => x.date === date);
        const plannedToday = row !== undefined && !row.nonWorkingDay ? row.plannedTesters : null;
        if (plannedToday !== null) planned = (planned ?? 0) + plannedToday;
        if (hasActual(entry)) actual = (actual ?? 0) + entry.testers;
        if (plannedToday !== null && date <= today && !hasActual(entry)) missingActual += 1;
        if (plannedToday !== null && hasActual(entry)) {
          const v = entry.testers - plannedToday;
          comparedVariances.push(v);
          comparedPlanned.push(plannedToday);
          comparedActual.push(entry.testers);
          if (v < 0) under += 1;
          if (v > 0) over += 1;
          const pp = perProject.get(p.projectId) ?? { vars: [], under: 0 };
          pp.vars.push(v);
          if (v < 0) pp.under += 1;
          perProject.set(p.projectId, pp);
        }
      }
      if (actual !== null) actualPerDay.push(actual);
      const dayHasHistory = firstEventDate !== null && date >= firstEventDate;
      days.push({ date, completed, failed, blocked, events: events ?? (dayHasHistory ? 0 : null), uniqueCases: unique ?? (dayHasHistory ? 0 : null), retestEvents: retest ?? (dayHasHistory ? 0 : null), plannedTesters: planned, actualTesters: actual });
    }

    // tickets (a different unit: never part of case figures)
    const allTickets = input.tickets;
    for (const p of included) {
      const list = (allTickets ?? p.inputs.bugTickets ?? []).filter((t) => t.projectId === p.projectId && t.createdAt >= r.from && t.createdAt <= r.to);
      if (list.length > 0) tickets.byProject.push({ projectId: p.projectId, projectName: nameOf(p), raised: list.length });
      tickets.raised += list.length;
    }

    // releases completed in range
    const releases: ReleaseRow[] = [];
    for (const p of included) {
      const actualDate = p.status === 'done' ? businessDay(p.completedAt) : null;
      if (actualDate === null || actualDate < r.from || actualDate > r.to) continue;
      const planned = p.inputs.targetCompletionDate;
      const variance = planned === null ? null : daysBetween(planned, actualDate);
      const entries = (p.inputs.dailyExecuted ?? []).filter((e) => e.date <= actualDate).sort((a, b) => a.date.localeCompare(b.date));
      const completedCases = entries.reduce((s, e) => s + entryCompletedCases(e), 0);
      const failedCases = entries.reduce((s, e) => s + e.fail, 0);
      const planRows = p.inputs.planningRows.filter((x) => !x.nonWorkingDay && x.date <= actualDate);
      const last = entries[entries.length - 1];
      releases.push({
        projectId: p.projectId,
        projectName: nameOf(p),
        plannedFinish: planned,
        actualCompletion: actualDate,
        daysVariance: variance,
        outcome: variance === null ? 'unknown' : variance > 0 ? 'late' : variance < 0 ? 'early' : 'onTime',
        completedCases,
        failedCases,
        failureRate: ratio(failedCases, completedCases),
        blockedAtEnd: last === undefined ? null : last.blocked,
        workMix: workMixOfProject(p.projectId, input.scopes, []),
        plannedDurationDays: planned === null ? null : daysBetween(p.inputs.startDate, planned) + 1,
        actualDurationDays: daysBetween(p.inputs.startDate, actualDate) + 1,
        plannedAvgTesters: avg(planRows.map((x) => x.plannedTesters)),
        actualAvgTesters: avg(entries.filter(hasActual).map((e) => e.testers)),
        plannedVolume: p.inputs.totalCases,
      });
    }
    releases.sort((a, b) => a.actualCompletion.localeCompare(b.actualCompletion) || a.projectId.localeCompare(b.projectId));

    const sum = (pick: (d: AnalyticsDay) => number | null): number => days.reduce((s, d) => s + (pick(d) ?? 0), 0);
    const completedTotal = sum((d) => d.completed);
    const failedTotal = sum((d) => d.failed);
    const eventsTotal = sum((d) => d.events);
    const retestTotal = sum((d) => d.retestEvents);
    const staffing: StaffingStats = {
      comparedDays: comparedVariances.length,
      avgPlanned: avg(comparedPlanned),
      avgActual: avg(comparedActual),
      avgVariance: avg(comparedVariances),
      understaffedDays: under,
      overPlannedDays: over,
      missingActualDays: missingActual,
      byProject: [...perProject.entries()]
        .map(([projectId, v]) => ({ projectId, projectName: nameOf(included.find((p) => p.projectId === projectId) as ProjectRecord), comparedDays: v.vars.length, understaffedDays: v.under, avgVariance: avg(v.vars) }))
        .sort((a, b) => a.projectName.localeCompare(b.projectName) || a.projectId.localeCompare(b.projectId)),
    };
    const summary: AnalyticsSummary = {
      completed: completedTotal,
      failed: failedTotal,
      failureRate: ratio(failedTotal, completedTotal),
      executionEvents: eventsTotal,
      uniqueCases: uniqueSeen.size,
      retestEvents: retestTotal,
      retestPer100Events: eventsTotal > 0 ? (retestTotal / eventsTotal) * 100 : null,
      casesRunMoreThanOnce: [...caseRuns.values()].filter((n) => n > 1).length,
      avgActualTesters: avg(actualPerDay),
      staffingAvgVariance: staffing.avgVariance,
      completedReleases: releases.length,
      lateReleases: releases.filter((x) => x.outcome === 'late').length,
      blockedProjectDays,
      activeProjectDays,
      blockedShare: ratio(blockedProjectDays, activeProjectDays),
    };

    const workTypes: WorkTypeRow[] = WORK_TYPE_ORDER.flatMap((type) => {
      const row = wtRows.get(type);
      if (row === undefined || (wt !== 'all' && wt !== type)) return [];
      const scopes = input.scopes.filter((s) => s.status === 'active' && workTypeOf(s) === type && included.some((p) => p.projectId === s.projectId)).length;
      const verifTickets = type === 'verification' ? included.filter((p) => input.scopes.some((s) => s.projectId === p.projectId && workTypeOf(s) === 'verification')).reduce((s, p) => s + (tickets.byProject.find((b) => b.projectId === p.projectId)?.raised ?? 0), 0) : null;
      return [{ workType: type, scopes, events: row.events, uniqueCases: row.unique.size, completedCases: row.completed, failedCases: row.failed, failureRate: ratio(row.failed, row.completed), retestEvents: row.retest, retestPer100Events: row.events > 0 ? (row.retest / row.events) * 100 : null, activeDays: row.days.size, completedPerActiveDay: ratio(row.completed, row.days.size), tickets: verifTickets }];
    });
    return { days, summary, staffing, releases, workTypes, testers, blockedProjects, tickets };
  };

  const current = core(range);
  const previous = core(previousRange);

  // ---- weekly roll-up -------------------------------------------------------------------------
  const weekMap = new Map<string, AnalyticsWeek>();
  for (const d of current.days) {
    const key = weekStartOf(d.date);
    const w = weekMap.get(key) ?? { weekStart: key, days: 0, completed: 0, failed: 0, failureRate: null, events: 0, retestEvents: 0 };
    w.days += 1;
    w.completed += d.completed ?? 0;
    w.failed += d.failed ?? 0;
    w.events += d.events ?? 0;
    w.retestEvents += d.retestEvents ?? 0;
    weekMap.set(key, w);
  }
  const weeks = [...weekMap.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart)).map((w) => ({ ...w, failureRate: ratio(w.failed, w.completed) }));

  // ---- comparison ------------------------------------------------------------------------------
  const cs = current.summary;
  const ps = previous.summary;
  const row = (metric: ComparisonRow['metric'], cur: number | null, prev: number | null, isRate: boolean): ComparisonRow => ({
    metric,
    current: cur,
    previous: prev,
    percent: isRate ? null : percentChange(cur, prev),
    absolute: cur === null || prev === null ? null : cur - prev,
  });
  const comparison: ComparisonRow[] = [
    row('completed', cs.completed, ps.completed, false),
    row('failureRate', cs.failureRate, ps.failureRate, true),
    row('retestEvents', cs.retestEvents, ps.retestEvents, false),
    row('staffingVariance', cs.staffingAvgVariance, ps.staffingAvgVariance, true),
    row('executionEvents', cs.executionEvents, ps.executionEvents, false),
    row('uniqueCases', cs.uniqueCases, ps.uniqueCases, false),
  ];

  // ---- signals ---------------------------------------------------------------------------------
  const review: AnalyticsSignal[] = [];
  const improved: AnalyticsSignal[] = [];
  const noProjects: AnalyticsSignal['projects'] = [];
  const push = (kind: 'review' | 'improved', id: SignalId, values: AnalyticsSignal['values'], projects: AnalyticsSignal['projects'] = noProjects): void => {
    (kind === 'review' ? review : improved).push({ id, kind, values, projects });
  };
  const byId = new Map(included.map((p) => [p.projectId, p] as const));
  const named = (ids: Iterable<string>): AnalyticsSignal['projects'] => [...new Set(ids)].map((projectId) => ({ projectId, projectName: nameOf(byId.get(projectId) as ProjectRecord) })).sort((a, b) => a.projectName.localeCompare(b.projectName));

  const tp = percentChange(cs.completed, ps.completed);
  if (tp !== null) {
    if (tp <= -MIN_RELATIVE_CHANGE) push('review', 'throughput', { percent: tp * 100, current: cs.completed, previous: ps.completed });
    else if (tp >= MIN_RELATIVE_CHANGE) push('improved', 'throughput', { percent: tp * 100, current: cs.completed, previous: ps.completed });
  }
  const rp = percentChange(cs.retestEvents, ps.retestEvents);
  if (rp !== null) {
    if (rp >= MIN_RELATIVE_CHANGE) push('review', 'retest', { percent: rp * 100, current: cs.retestEvents, previous: ps.retestEvents });
    else if (rp <= -MIN_RELATIVE_CHANGE) push('improved', 'retest', { percent: rp * 100, current: cs.retestEvents, previous: ps.retestEvents });
  }
  if (cs.failureRate !== null && ps.failureRate !== null) {
    const pp = (cs.failureRate - ps.failureRate) * 100;
    if (pp >= MIN_RATE_CHANGE_PP) push('review', 'failureRate', { pp, current: cs.failureRate * 100, previous: ps.failureRate * 100 });
    else if (pp <= -MIN_RATE_CHANGE_PP) push('improved', 'failureRate', { pp, current: cs.failureRate * 100, previous: ps.failureRate * 100 });
  }
  if (wt === 'all') {
    for (const type of WORK_TYPE_ORDER) {
      const c = current.workTypes.find((x) => x.workType === type)?.failureRate ?? null;
      const p = previous.workTypes.find((x) => x.workType === type)?.failureRate ?? null;
      if (c !== null && p !== null && (c - p) * 100 >= MIN_RATE_CHANGE_PP) push('review', 'workTypeFailureRate', { workType: type, pp: (c - p) * 100, current: c * 100, previous: p * 100 });
    }
  }
  if (cs.staffingAvgVariance !== null && ps.staffingAvgVariance !== null && wt === 'all') {
    const change = Math.abs(cs.staffingAvgVariance) - Math.abs(ps.staffingAvgVariance);
    if (change >= MIN_STAFFING_CHANGE) push('review', 'staffingVariance', { current: cs.staffingAvgVariance, previous: ps.staffingAvgVariance });
    else if (change <= -MIN_STAFFING_CHANGE) push('improved', 'staffingVariance', { current: cs.staffingAvgVariance, previous: ps.staffingAvgVariance });
  }
  if (current.staffing.understaffedDays > 0 && wt === 'all') push('review', 'understaffed', { days: current.staffing.understaffedDays, of: current.staffing.comparedDays }, named(current.staffing.byProject.filter((x) => x.understaffedDays > 0).map((x) => x.projectId)));
  const late = current.releases.filter((x) => x.outcome === 'late');
  if (late.length > 0) push('review', 'lateReleases', { count: late.length, of: current.releases.length }, named(late.map((x) => x.projectId)));
  const onTimeShare = (rows: readonly ReleaseRow[]): number | null => ratio(rows.filter((x) => x.outcome === 'onTime' || x.outcome === 'early').length, rows.filter((x) => x.outcome !== 'unknown').length);
  const curShare = onTimeShare(current.releases);
  const prevShare = onTimeShare(previous.releases);
  if (curShare !== null && prevShare !== null && (curShare - prevShare) * 100 >= MIN_RATE_CHANGE_PP) push('improved', 'onTimeReleases', { current: curShare * 100, previous: prevShare * 100 }, named(current.releases.filter((x) => x.outcome === 'onTime' || x.outcome === 'early').map((x) => x.projectId)));
  if (cs.blockedShare !== null && ps.blockedShare !== null) {
    const pp = (cs.blockedShare - ps.blockedShare) * 100;
    if (pp >= MIN_RATE_CHANGE_PP) push('review', 'blockerPersistence', { pp, current: cs.blockedShare * 100, previous: ps.blockedShare * 100 }, named(current.blockedProjects.keys()));
    else if (pp <= -MIN_RATE_CHANGE_PP) push('improved', 'blockerPersistence', { pp, current: cs.blockedShare * 100, previous: ps.blockedShare * 100 });
  }

  // ---- people (facts only, alphabetical) ----------------------------------------------------------
  const members = input.members ?? [];
  const memberName = new Map(members.map((m) => [m.id, m.name] as const));
  const assignments = (input.assignments ?? []).filter((a) => a.active && a.startDate <= today && (a.endDate === undefined || a.endDate >= today) && byId.has(a.projectId));
  const testers: TesterFact[] = [...current.testers.entries()]
    .map(([key, v]) => ({ key, name: memberName.get(key) ?? key, events: v.events, uniqueCases: v.cases.size, activeDays: v.days.size, assignedScopes: assignments.filter((a) => a.memberId === key && a.scopeId !== undefined).length }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));

  const currentGaps = included
    .filter((p) => p.status === 'ongoing' || p.status === 'extended')
    .map((p) => ({ projectId: p.projectId, projectName: nameOf(p), planned: p.inputs.currentTesters, assigned: new Set(assignments.filter((a) => a.projectId === p.projectId).map((a) => a.memberId ?? a.testerName ?? a.id)).size }))
    .filter((g) => g.planned !== g.assigned);

  return {
    range,
    previousRange,
    workType: wt,
    projectId: projectFilter,
    basis,
    projects: included.map((p) => ({ projectId: p.projectId, projectName: nameOf(p) })).sort((a, b) => a.projectName.localeCompare(b.projectName) || a.projectId.localeCompare(b.projectId)),
    history: { hasEvents: firstEventDate !== null, firstEventDate, partial: firstEventDate !== null && range.from < firstEventDate },
    summary: current.summary,
    previousSummary: previous.summary,
    comparison,
    days: current.days,
    weeks,
    workTypes: current.workTypes,
    staffing: wt === 'all' ? current.staffing : null,
    releases: current.releases,
    forecastAccuracy: { available: false },
    readinessTrend: { available: false },
    assignmentHistory: { available: false, currentGaps },
    tickets: current.tickets,
    testers,
    signals: { review, improved },
  };
}

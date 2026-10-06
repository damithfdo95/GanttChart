import type { BugTicket, PerformanceRecordSource, RcsMember, TesterDailyPerformance } from '../../types';
import { parseDate } from '../dates/dates';
import {
  identityDisplayName,
  reporterIdentityKey,
  testerIdentityKey,
} from '../../domain/members';

/**
 * V6.6 — Tester performance analytics (pure; no React, no storage, no
 * clock, no browser APIs).
 *
 * Evidence chain: TesterDailyPerformance records (per tester, per day, per
 * project) + BugTicket records (per reporter, per date, per project) are
 * aggregated into objective metrics. The existing V6.4/V6.5 status
 * semantics are preserved verbatim: casesTested is the authoritative
 * per-tester total; Pass/Fail/N-A/SPO are completed-category tallies and
 * Blocked/Retest/Questioned are open-status overlays. The breakdown fields
 * are NEVER summed, cross-checked or forced to equal casesTested (§13 —
 * no double counting, no reinterpretation).
 *
 * All dates are "YYYY-MM-DD" strings and compared lexicographically
 * (valid YYYY-MM-DD strings order identically to chronological order), so
 * there are no timezone-dependent computations anywhere in this module.
 */

/** Inclusive "YYYY-MM-DD" date window. */
export interface PeriodRange {
  start: string;
  end: string;
}

export type PeriodHalf = 1 | 2;

/** User-selectable analysis period (V6.6 §15). */
export type PeriodSelector =
  | { kind: 'month'; year: number; month: number }
  | { kind: 'year'; year: number }
  | { kind: 'halfYear'; year: number; half: PeriodHalf }
  | { kind: 'custom'; start: string; end: string };

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Resolve a period selector to an inclusive date range. Returns null for a
 * custom range with invalid or inverted dates (callers show the standard
 * empty state instead of guessing).
 */
export function getPeriodRange(selector: PeriodSelector): PeriodRange | null {
  switch (selector.kind) {
    case 'month':
      if (selector.month < 1 || selector.month > 12) return null;
      return {
        start: `${selector.year}-${pad2(selector.month)}-01`,
        end: `${selector.year}-${pad2(selector.month)}-${pad2(daysInMonth(selector.year, selector.month))}`,
      };
    case 'year':
      return { start: `${selector.year}-01-01`, end: `${selector.year}-12-31` };
    case 'halfYear':
      // H1: January 1 → June 30; H2: July 1 → December 31.
      return selector.half === 1
        ? { start: `${selector.year}-01-01`, end: `${selector.year}-06-30` }
        : { start: `${selector.year}-07-01`, end: `${selector.year}-12-31` };
    case 'custom': {
      if (parseDate(selector.start) === null || parseDate(selector.end) === null) return null;
      if (selector.start > selector.end) return null;
      return { start: selector.start, end: selector.end };
    }
  }
}

/** Inclusive range check ("YYYY-MM-DD" lexicographic comparison). */
export function dateInRange(date: string, range: PeriodRange): boolean {
  return date >= range.start && date <= range.end;
}

/** Aggregation options: an optional period, an optional project scope and the member master (V6.8). */
export interface AggregateOptions {
  /** null/undefined = all time. */
  range?: PeriodRange | null;
  /** null/undefined = all projects; otherwise only these stable Project IDs. */
  projectIds?: readonly string[] | null;
  /** RCS member master (V6.8) — resolves stable member identity for legacy name records. */
  members?: readonly RcsMember[];
}

function projectInScope(projectId: string, options: AggregateOptions): boolean {
  if (options.projectIds === undefined || options.projectIds === null) return true;
  return options.projectIds.includes(projectId);
}

function recordInScope(record: TesterDailyPerformance, options: AggregateOptions): boolean {
  return projectInScope(record.projectId, options) && (options.range === undefined || options.range === null || dateInRange(record.date, options.range));
}

function ticketInScope(ticket: BugTicket, options: AggregateOptions): boolean {
  return (
    projectInScope(ticket.projectId, options) &&
    (options.range === undefined || options.range === null || dateInRange(ticket.createdAt, options.range))
  );
}

/** One tester's objective performance figures for the selected scope. */
export interface TesterPerformanceRow {
  testerName: string;
  /**
   * Stable RCS member identity (V6.8) when the tester resolves to a member;
   * undefined for legacy name-only testers.
   */
  memberId?: string;
  /** From the tester's most recent in-scope record ('' when unset). */
  team: string;
  projectIds: string[];
  /** Distinct dates with a record. */
  activeDays: number;
  casesTested: number;
  casesPassed: number;
  casesFailed: number;
  casesNotApplicable: number;
  casesBlocked: number;
  casesRetest: number;
  casesQuestioned: number;
  casesSpoAssigned: number;
  /** Bug tickets reported by this tester in the scope. */
  bugsFound: number;
  /** casesTested / activeDays; 0 when there are no active days. */
  averageCasesPerDay: number;
  /** Bugs per 1,000 cases; null when casesTested is 0 (never a fake 0). */
  bugDiscoveryRate: number | null;
  /**
   * Distinct execution sources of the tester's in-scope records (V6.7 §16),
   * sorted; empty for testers that appear through bugs only. Multiple
   * sources are shown together — never collapsed or ranked.
   */
  sources: PerformanceRecordSource[];
}

interface Accumulator {
  team: string;
  lastDate: string;
  projects: Set<string>;
  dates: Set<string>;
  sources: Set<PerformanceRecordSource>;
  casesTested: number;
  casesPassed: number;
  casesFailed: number;
  casesNotApplicable: number;
  casesBlocked: number;
  casesRetest: number;
  casesQuestioned: number;
  casesSpoAssigned: number;
}

function newAccumulator(): Accumulator {
  return {
    team: '',
    lastDate: '',
    projects: new Set<string>(),
    dates: new Set<string>(),
    sources: new Set<PerformanceRecordSource>(),
    casesTested: 0,
    casesPassed: 0,
    casesFailed: 0,
    casesNotApplicable: 0,
    casesBlocked: 0,
    casesRetest: 0,
    casesQuestioned: 0,
    casesSpoAssigned: 0,
  };
}

function accumulate(acc: Accumulator, record: TesterDailyPerformance): void {
  acc.projects.add(record.projectId);
  acc.dates.add(record.date);
  if (record.date >= acc.lastDate) {
    acc.lastDate = record.date;
    acc.team = record.team ?? '';
  }
  if (record.source !== undefined) acc.sources.add(record.source);
  acc.casesTested += Math.max(0, record.casesTested);
  acc.casesPassed += Math.max(0, record.casesPassed ?? 0);
  acc.casesFailed += Math.max(0, record.casesFailed ?? 0);
  acc.casesNotApplicable += Math.max(0, record.casesNotApplicable ?? 0);
  acc.casesBlocked += Math.max(0, record.casesBlocked ?? 0);
  acc.casesRetest += Math.max(0, record.casesRetest ?? 0);
  acc.casesQuestioned += Math.max(0, record.casesQuestioned ?? 0);
  acc.casesSpoAssigned += Math.max(0, record.casesSpoAssigned ?? 0);
}

/**
 * Aggregate per-tester performance across the selected scope. V6.8: testers
 * are keyed by stable member identity (memberId, else a unique name match in
 * the member master, else the raw name), so renamed members and their legacy
 * name-based history stay one row. The project scope is only crossed when
 * the caller deliberately selects multiple projects. Output is sorted by
 * tester display name for stable display — never ranked.
 */
export function aggregateTesterPerformance(
  records: readonly TesterDailyPerformance[],
  tickets: readonly BugTicket[],
  options: AggregateOptions = {},
): TesterPerformanceRow[] {
  const members = options.members ?? [];
  const byTester = new Map<string, Accumulator>();
  for (const record of records) {
    if (!recordInScope(record, options)) continue;
    const key = testerIdentityKey(record, members);
    if (key === '') continue;
    let acc = byTester.get(key);
    if (acc === undefined) {
      acc = newAccumulator();
      byTester.set(key, acc);
    }
    accumulate(acc, record);
  }

  const bugsByTester = new Map<string, number>();
  for (const ticket of tickets) {
    if (!ticketInScope(ticket, options)) continue;
    const key = reporterIdentityKey(ticket, members);
    if (key === '') continue;
    bugsByTester.set(key, (bugsByTester.get(key) ?? 0) + 1);
  }

  const rows: TesterPerformanceRow[] = [];
  for (const [key, acc] of byTester) {
    const bugsFound = bugsByTester.get(key) ?? 0;
    rows.push({
      testerName: identityDisplayName(key, members),
      ...(members.some((member) => member.id === key) ? { memberId: key } : {}),
      team: acc.team,
      projectIds: [...acc.projects].sort(),
      activeDays: acc.dates.size,
      casesTested: acc.casesTested,
      casesPassed: acc.casesPassed,
      casesFailed: acc.casesFailed,
      casesNotApplicable: acc.casesNotApplicable,
      casesBlocked: acc.casesBlocked,
      casesRetest: acc.casesRetest,
      casesQuestioned: acc.casesQuestioned,
      casesSpoAssigned: acc.casesSpoAssigned,
      bugsFound,
      averageCasesPerDay: acc.dates.size > 0 ? acc.casesTested / acc.dates.size : 0,
      bugDiscoveryRate: calculateBugDiscoveryRate(bugsFound, acc.casesTested),
      sources: [...acc.sources].sort(),
    });
  }
  // Testers with bugs but no execution data still appear (bugsFound shown,
  // execution zeros never manufactured — §29); testers with neither do not.
  for (const [key, bugsFound] of bugsByTester) {
    if (byTester.has(key)) continue;
    rows.push({
      testerName: identityDisplayName(key, members),
      ...(members.some((member) => member.id === key) ? { memberId: key } : {}),
      team: '',
      projectIds: [],
      activeDays: 0,
      casesTested: 0,
      casesPassed: 0,
      casesFailed: 0,
      casesNotApplicable: 0,
      casesBlocked: 0,
      casesRetest: 0,
      casesQuestioned: 0,
      casesSpoAssigned: 0,
      bugsFound,
      averageCasesPerDay: 0,
      bugDiscoveryRate: calculateBugDiscoveryRate(bugsFound, 0),
      sources: [],
    });
  }
  rows.sort((a, b) => a.testerName.localeCompare(b.testerName));
  return rows;
}

/** Month aggregation (e.g. September 2026 → month 9). */
export function getMonthlyPerformance(
  records: readonly TesterDailyPerformance[],
  tickets: readonly BugTicket[],
  year: number,
  month: number,
  options: Omit<AggregateOptions, 'range'> = {},
): TesterPerformanceRow[] {
  const range = getPeriodRange({ kind: 'month', year, month });
  return range === null ? [] : aggregateTesterPerformance(records, tickets, { ...options, range });
}

/** Year aggregation (e.g. 2026). */
export function getYearlyPerformance(
  records: readonly TesterDailyPerformance[],
  tickets: readonly BugTicket[],
  year: number,
  options: Omit<AggregateOptions, 'range'> = {},
): TesterPerformanceRow[] {
  return aggregateTesterPerformance(records, tickets, { ...options, range: getPeriodRange({ kind: 'year', year }) });
}

/** Half-year aggregation: H1 (Jan 1–Jun 30) or H2 (Jul 1–Dec 31). */
export function getHalfYearPerformance(
  records: readonly TesterDailyPerformance[],
  tickets: readonly BugTicket[],
  year: number,
  half: PeriodHalf,
  options: Omit<AggregateOptions, 'range'> = {},
): TesterPerformanceRow[] {
  return aggregateTesterPerformance(records, tickets, {
    ...options,
    range: getPeriodRange({ kind: 'halfYear', year, half }),
  });
}

/** User-selected custom range (invalid/inverted dates → empty result). */
export function getCustomRangePerformance(
  records: readonly TesterDailyPerformance[],
  tickets: readonly BugTicket[],
  start: string,
  end: string,
  options: Omit<AggregateOptions, 'range'> = {},
): TesterPerformanceRow[] {
  const range = getPeriodRange({ kind: 'custom', start, end });
  return range === null ? [] : aggregateTesterPerformance(records, tickets, { ...options, range });
}

/** One tester's per-project figures inside the scope (V6.6 §21). */
export interface TesterProjectBreakdownRow {
  projectId: string;
  activeDays: number;
  casesTested: number;
  bugsFound: number;
  averageCasesPerDay: number;
}

export function getTesterProjectBreakdown(
  records: readonly TesterDailyPerformance[],
  tickets: readonly BugTicket[],
  testerName: string,
  options: AggregateOptions = {},
): TesterProjectBreakdownRow[] {
  const members = options.members ?? [];
  const key = testerName.trim();
  const projects = new Map<string, { dates: Set<string>; casesTested: number }>();
  for (const record of records) {
    if (testerIdentityKey(record, members) !== key || !recordInScope(record, options)) continue;
    let entry = projects.get(record.projectId);
    if (entry === undefined) {
      entry = { dates: new Set<string>(), casesTested: 0 };
      projects.set(record.projectId, entry);
    }
    entry.dates.add(record.date);
    entry.casesTested += Math.max(0, record.casesTested);
  }
  const bugsByProject = new Map<string, number>();
  for (const ticket of tickets) {
    if (reporterIdentityKey(ticket, members) !== key || !ticketInScope(ticket, options)) continue;
    bugsByProject.set(ticket.projectId, (bugsByProject.get(ticket.projectId) ?? 0) + 1);
  }
  const rows: TesterProjectBreakdownRow[] = [];
  for (const [projectId, entry] of projects) {
    rows.push({
      projectId,
      activeDays: entry.dates.size,
      casesTested: entry.casesTested,
      bugsFound: bugsByProject.get(projectId) ?? 0,
      averageCasesPerDay: entry.dates.size > 0 ? entry.casesTested / entry.dates.size : 0,
    });
  }
  for (const [projectId, bugsFound] of bugsByProject) {
    if (projects.has(projectId)) continue;
    rows.push({ projectId, activeDays: 0, casesTested: 0, bugsFound, averageCasesPerDay: 0 });
  }
  return rows.sort((a, b) => a.projectId.localeCompare(b.projectId));
}

/**
 * Bug discovery rate = bugs found / cases tested × 1,000 (V6.6 §20).
 * Purely analytical: the value is never labeled good/bad. null when no
 * cases were tested — the UI shows the empty marker instead of a fake 0.
 */
export function calculateBugDiscoveryRate(bugsFound: number, casesTested: number): number | null {
  if (casesTested <= 0) return null;
  return (bugsFound / casesTested) * 1000;
}

/** One month point of a tester's trend (month = "YYYY-MM"). */
export interface TesterMonthlyTrendPoint {
  month: string;
  activeDays: number;
  casesTested: number;
  bugsFound: number;
}

/**
 * Monthly execution trend for one tester (V6.6 §18). Months are the
 * calendar months between the range bounds (or the tester's own first →
 * last record month when no range is given), so gaps appear as honest
 * zeros. Sorted ascending; never ranked.
 */
export function getTesterMonthlyTrend(
  records: readonly TesterDailyPerformance[],
  tickets: readonly BugTicket[],
  testerName: string,
  options: AggregateOptions = {},
): TesterMonthlyTrendPoint[] {
  const members = options.members ?? [];
  const key = testerName.trim();
  const casesByMonth = new Map<string, number>();
  const daysByMonth = new Map<string, Set<string>>();
  for (const record of records) {
    if (testerIdentityKey(record, members) !== key || !recordInScope(record, options)) continue;
    const month = record.date.slice(0, 7);
    casesByMonth.set(month, (casesByMonth.get(month) ?? 0) + Math.max(0, record.casesTested));
    let days = daysByMonth.get(month);
    if (days === undefined) {
      days = new Set<string>();
      daysByMonth.set(month, days);
    }
    days.add(record.date);
  }
  const bugsByMonth = new Map<string, number>();
  for (const ticket of tickets) {
    if (reporterIdentityKey(ticket, members) !== key || !ticketInScope(ticket, options)) continue;
    const month = ticket.createdAt.slice(0, 7);
    bugsByMonth.set(month, (bugsByMonth.get(month) ?? 0) + 1);
  }

  const months = [...new Set([...casesByMonth.keys(), ...bugsByMonth.keys()])].sort();
  return months.map((month) => ({
    month,
    activeDays: daysByMonth.get(month)?.size ?? 0,
    casesTested: casesByMonth.get(month) ?? 0,
    bugsFound: bugsByMonth.get(month) ?? 0,
  }));
}

/** Team-level summary for the selected scope (V6.6 §16). */
export interface PerformanceSummary {
  totalTesters: number;
  totalCasesTested: number;
  totalBugs: number;
  /** Sum of every tester's active days (tester-day pairs). */
  activeTesterDays: number;
  projects: number;
  casesPassed: number;
  casesFailed: number;
  casesNotApplicable: number;
  casesBlocked: number;
  casesRetest: number;
  casesQuestioned: number;
  casesSpoAssigned: number;
}

export function performanceSummary(
  records: readonly TesterDailyPerformance[],
  tickets: readonly BugTicket[],
  options: AggregateOptions = {},
): PerformanceSummary {
  const rows = aggregateTesterPerformance(records, tickets, options);
  const projectIds = new Set<string>();
  let activeTesterDays = 0;
  for (const record of records) {
    if (!recordInScope(record, options)) continue;
    projectIds.add(record.projectId);
  }
  for (const ticket of tickets) {
    if (!ticketInScope(ticket, options)) continue;
    projectIds.add(ticket.projectId);
  }
  for (const row of rows) activeTesterDays += row.activeDays;
  return {
    totalTesters: rows.length,
    totalCasesTested: rows.reduce((sum, row) => sum + row.casesTested, 0),
    totalBugs: rows.reduce((sum, row) => sum + row.bugsFound, 0),
    activeTesterDays,
    projects: projectIds.size,
    casesPassed: rows.reduce((sum, row) => sum + row.casesPassed, 0),
    casesFailed: rows.reduce((sum, row) => sum + row.casesFailed, 0),
    casesNotApplicable: rows.reduce((sum, row) => sum + row.casesNotApplicable, 0),
    casesBlocked: rows.reduce((sum, row) => sum + row.casesBlocked, 0),
    casesRetest: rows.reduce((sum, row) => sum + row.casesRetest, 0),
    casesQuestioned: rows.reduce((sum, row) => sum + row.casesQuestioned, 0),
    casesSpoAssigned: rows.reduce((sum, row) => sum + row.casesSpoAssigned, 0),
  };
}

// ---- V6.7: Review workspace analytics ------------------------------------------

/**
 * The selector for the period immediately preceding the given one (V6.7 §21):
 * month → previous month (Dec of the previous year when January), H1 → H2 of
 * the previous year, H2 → H1 of the same year, year → previous year. Custom
 * ranges have no natural predecessor — null (the UI simply hides the
 * comparison instead of guessing).
 */
export function getPreviousPeriod(selector: PeriodSelector): PeriodSelector | null {
  switch (selector.kind) {
    case 'month':
      return selector.month === 1
        ? { kind: 'month', year: selector.year - 1, month: 12 }
        : { kind: 'month', year: selector.year, month: selector.month - 1 };
    case 'year':
      return { kind: 'year', year: selector.year - 1 };
    case 'halfYear':
      return selector.half === 1
        ? { kind: 'halfYear', year: selector.year - 1, half: 2 }
        : { kind: 'halfYear', year: selector.year, half: 1 };
    case 'custom':
      return null;
  }
}

/** One tester's objective review evidence for a period (V6.7 §20/§34). */
export interface TesterReviewMetrics {
  testerName: string;
  /** null when the tester has neither execution records nor bugs in the period. */
  row: TesterPerformanceRow | null;
  breakdown: TesterProjectBreakdownRow[];
}

/**
 * Objective metrics for a tester's review — recalculated from the evidence
 * chain on every call (reproducible: same source data + same period + same
 * tester → same result). No score, no grade, no ranking. V6.8: `testerName`
 * may be a stable memberId or a legacy name; either resolves through the
 * member master when `members` is provided.
 */
export function getTesterReviewMetrics(
  records: readonly TesterDailyPerformance[],
  tickets: readonly BugTicket[],
  testerName: string,
  range: PeriodRange,
  members: readonly RcsMember[] = [],
): TesterReviewMetrics {
  const options: AggregateOptions = { range, members };
  const key = testerName.trim();
  const row =
    aggregateTesterPerformance(records, tickets, options).find(
      (candidate) => (candidate.memberId ?? candidate.testerName) === key,
    ) ?? null;
  const breakdown = getTesterProjectBreakdown(records, tickets, testerName, options);
  return { testerName: key, row, breakdown };
}

/** One factual previous-vs-current metric difference (V6.7 §21). */
export interface PeriodComparisonEntry {
  /** Metric key — display labels are resolved by the caller. */
  key:
    | 'casesTested'
    | 'casesPassed'
    | 'casesFailed'
    | 'casesNotApplicable'
    | 'casesBlocked'
    | 'casesRetest'
    | 'casesQuestioned'
    | 'casesSpoAssigned'
    | 'bugsFound'
    | 'activeDays';
  previous: number;
  current: number;
  /** current − previous (factual; never labeled improved/worse). */
  difference: number;
}

/**
 * Factual comparison of one tester's metrics between two periods. The
 * application shows the differences as numbers only — any qualitative
 * assessment is the supervisor's, not the system's.
 */
export function comparePeriods(
  previous: TesterPerformanceRow | null,
  current: TesterPerformanceRow | null,
): PeriodComparisonEntry[] {
  const value = (row: TesterPerformanceRow | null, key: PeriodComparisonEntry['key']): number =>
    row === null ? 0 : row[key];
  const keys: PeriodComparisonEntry['key'][] = [
    'casesTested',
    'casesPassed',
    'casesFailed',
    'casesNotApplicable',
    'casesBlocked',
    'casesRetest',
    'casesQuestioned',
    'casesSpoAssigned',
    'bugsFound',
    'activeDays',
  ];
  return keys.map((key) => {
    const previousValue = value(previous, key);
    const currentValue = value(current, key);
    return { key, previous: previousValue, current: currentValue, difference: currentValue - previousValue };
  });
}

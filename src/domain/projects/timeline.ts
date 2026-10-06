import type { ProjectRecord } from '../../types';
import { calculateCumulativeCapacityByDay } from '../../lib/calculations/planning';
import { generateDailyPlan } from '../../lib/calculations/dailyPlan';
import { dayWindowsFromRows, projectDayWindowDefaults, workdayProductiveHours } from '../../lib/calculations/workday';
import { projectDisplayName } from './selectors';

/**
 * Multi-day timeline data (portfolio). For every planned day, distributes
 * each project's remaining cases across its own daily capacity using the
 * existing calculation engine — days with several projects produce one
 * segment per project so the UI can separate them by color.
 *
 * Pure: no clock, no React, no storage.
 */

export interface DayTimelineSegment {
  projectId: string;
  cases: number;
}

export interface DayTimelineDay {
  date: string;
  nonWorkingDay: boolean;
  totalCases: number;
  segments: DayTimelineSegment[];
}

export interface DayTimelineProject {
  projectId: string;
  name: string;
  /** Stable color index (palette order) for per-project separation. */
  colorIndex: number;
  totalCases: number;
  /**
   * Plan-vs-actual summary totals (shown when the dropdown filter selects
   * this project). Plan totals come from the daily plan (generateDailyPlan:
   * capacity-derived AUTO rows + stored MANUAL overrides, pass rate
   * applied); actual totals are the project's live cumulative inputs.
   */
  totalExecutePlan: number;
  totalPassPlan: number;
  totalExecuteActual: number;
  totalPassActual: number;
  /**
   * Per-date cumulative plan/actual series (single-project chart): the
   * four lines plotted when the dropdown filter selects this project.
   */
  detail: DayTimelineDetail;
}

/**
 * Cumulative plan/actual series of one project, keyed by date. Plan values
 * come from the daily plan (cumulativeExecute/cumulativePass); actual
 * values come from the end-of-day snapshots, with today's row holding the
 * LIVE cumulative totals (same rule as the gap view). The granular status
 * series (Fail/N/A/Blocked/Retest/Questioned/SPO) use the V6.5 snapshot
 * fields — never inferred from the legacy aggregates.
 */
export interface DayTimelineDetail {
  executePlan: Record<string, number>;
  passPlan: Record<string, number>;
  executeActual: Record<string, number>;
  passActual: Record<string, number>;
  failActual: Record<string, number>;
  notApplicableActual: Record<string, number>;
  blockedActual: Record<string, number>;
  retestActual: Record<string, number>;
  questionedActual: Record<string, number>;
  spoActual: Record<string, number>;
}

export interface DayTimelineData {
  /** All planned days across projects, ascending by date. */
  days: DayTimelineDay[];
  /** Largest per-day total — the 100% reference for bar heights. */
  maxDayCases: number;
  /** Legend entries (only projects that contribute cases). */
  projects: DayTimelineProject[];
}

export function buildDayTimeline(projects: readonly ProjectRecord[], lang: 'en' | 'ja', today: string): DayTimelineData {
  const dayMap = new Map<string, DayTimelineDay>();
  const timelineProjects: DayTimelineProject[] = [];

  const ordered = [...projects].sort((a, b) =>
    a.projectId.localeCompare(b.projectId, undefined, { numeric: true }),
  );

  ordered.forEach((project, colorIndex) => {
    const { inputs } = project;
    const productiveHours = workdayProductiveHours(inputs.startTime, inputs.dailyOvertimeMinutes);
    const dayWindows = dayWindowsFromRows(inputs.planningRows, projectDayWindowDefaults(inputs));
    const daily = calculateCumulativeCapacityByDay(inputs.planningRows, inputs.perHourPerTester, productiveHours, dayWindows);
    let remaining = Math.max(0, inputs.totalCases - inputs.casesCompleted);
    let projectTotal = 0;

    for (const row of daily) {
      const cases = Math.max(0, Math.min(row.dailyCapacity, remaining));
      remaining -= cases;
      projectTotal += cases;

      let day = dayMap.get(row.date);
      if (day === undefined) {
        day = { date: row.date, nonWorkingDay: true, totalCases: 0, segments: [] };
        dayMap.set(row.date, day);
      }
      if (!row.nonWorkingDay) day.nonWorkingDay = false;
      day.totalCases += cases;
      day.segments.push({ projectId: project.projectId, cases });
    }

    // Plan-vs-actual totals (dropdown filter summary): the daily plan is
    // the single source of the Execute/Pass plan — MANUAL overrides and the
    // target pass rate are honored; actuals are the live cumulative inputs.
    const plan = generateDailyPlan(
      inputs.planningRows,
      inputs.perHourPerTester,
      productiveHours,
      inputs.totalCases,
      inputs.targetPassRate ?? 1,
      inputs.dailyTargetOverrides ?? [],
      dayWindows,
    );
    const totalExecutePlan = plan.reduce((sum, row) => sum + row.plannedExecute, 0);
    const totalPassPlan = plan.reduce((sum, row) => sum + row.plannedPass, 0);

    // Per-date cumulative plan/actual series (single-project chart). Actual
    // lines use the end-of-day snapshots; today's row carries the LIVE
    // cumulative totals (the same rule as the gap view — a snapshot recorded
    // today would say the same thing a moment later). Granular status series
    // come from the V6.5 snapshot fields and the live granular inputs —
    // only when the project actually recorded them (never invented).
    const detail: DayTimelineDetail = {
      executePlan: Object.fromEntries(plan.map((row) => [row.date, row.cumulativeExecute])),
      passPlan: Object.fromEntries(plan.map((row) => [row.date, row.cumulativePass])),
      executeActual: {},
      passActual: {},
      failActual: {},
      notApplicableActual: {},
      blockedActual: {},
      retestActual: {},
      questionedActual: {},
      spoActual: {},
    };
    for (const snapshot of inputs.dailyActuals ?? []) {
      detail.executeActual[snapshot.date] = snapshot.executed;
      detail.passActual[snapshot.date] = snapshot.passed;
      if (snapshot.casesFailed !== undefined) detail.failActual[snapshot.date] = snapshot.casesFailed;
      if (snapshot.casesNotApplicable !== undefined) detail.notApplicableActual[snapshot.date] = snapshot.casesNotApplicable;
      if (snapshot.casesBlocked !== undefined) detail.blockedActual[snapshot.date] = snapshot.casesBlocked;
      if (snapshot.casesRetest !== undefined) detail.retestActual[snapshot.date] = snapshot.casesRetest;
      if (snapshot.casesQuestioned !== undefined) detail.questionedActual[snapshot.date] = snapshot.casesQuestioned;
      if (snapshot.spoAssigned !== undefined) detail.spoActual[snapshot.date] = snapshot.spoAssigned;
    }
    detail.executeActual[today] = inputs.casesCompleted;
    detail.passActual[today] = inputs.casesPassed ?? 0;
    if (inputs.casesFailed !== undefined) detail.failActual[today] = inputs.casesFailed;
    if (inputs.casesNotApplicable !== undefined) detail.notApplicableActual[today] = inputs.casesNotApplicable;
    if (inputs.casesBlocked !== undefined) detail.blockedActual[today] = inputs.casesBlocked;
    if (inputs.casesRetest !== undefined) detail.retestActual[today] = inputs.casesRetest;
    if (inputs.casesQuestioned !== undefined) detail.questionedActual[today] = inputs.casesQuestioned;
    if (inputs.spoAssigned !== undefined) detail.spoActual[today] = inputs.spoAssigned;

    timelineProjects.push({
      projectId: project.projectId,
      name: projectDisplayName(project, lang),
      colorIndex,
      totalCases: projectTotal,
      totalExecutePlan,
      totalPassPlan,
      totalExecuteActual: inputs.casesCompleted,
      totalPassActual: inputs.casesPassed ?? 0,
      detail,
    });
  });

  const days = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  const maxDayCases = days.reduce((max, day) => Math.max(max, day.totalCases), 0);
  return {
    days,
    maxDayCases,
    projects: timelineProjects.filter((p) => p.totalCases > 0),
  };
}

/**
 * Filter the multi-day timeline to one project (dropdown filter): the
 * selected project keeps its segments, every other project is removed, and
 * per-day totals / maxDayCases / the legend are recomputed so the Y axis
 * rescales to the filtered data. The date axis is preserved verbatim —
 * dates the selected project does not cover stay in the axis (and render
 * as line breaks per §9), so switching the filter never reorders the axis.
 * A null/empty selection returns the data unchanged (all projects).
 * Pure: no clock, no React, no storage.
 */
export function filterDayTimelineData(data: DayTimelineData, projectId: string | null): DayTimelineData {
  const selection = projectId !== null && projectId !== '' ? projectId : null;
  if (selection === null) return data;
  const selected = data.projects.find((project) => project.projectId === selection);
  if (selected === undefined) return data;
  const days = data.days.map((day) => {
    const segments = day.segments.filter((segment) => segment.projectId === selection);
    return segments.length === day.segments.length
      ? day
      : { ...day, segments, totalCases: segments.reduce((sum, segment) => sum + segment.cases, 0) };
  });
  const maxDayCases = days.reduce((max, day) => Math.max(max, day.totalCases), 0);
  return { days, maxDayCases, projects: [selected] };
}

// ---- V6.1: chart-ready transformation (pure) -------------------------------

/** One plotted series: a project's values aligned to the shared date axis. */
export interface TimelineSeries {
  projectId: string;
  name: string;
  colorIndex: number;
  /** One entry per chart date; null = the project has no data for that date. */
  values: (number | null)[];
}

/** Chart-ready data: dates form the shared X axis, series are aligned to it. */
export interface TimelineChartData {
  /** Union of all project dates, ascending (YYYY-MM-DD sorts lexically). */
  dates: string[];
  series: TimelineSeries[];
  /** Y-axis domain top (a "nice" multiple of the tick step). */
  yMax: number;
  /** Y-axis tick step; 0 when there is no data. */
  yStep: number;
}

/**
 * Smallest human-friendly axis bound ≥ value: a multiple of 1/1.5/2/2.5/3/4/
 * 5/6/8/10 × 10^n. Keeps Y-axis labels readable for any data scale.
 */
export function niceAxisCeil(value: number): number {
  if (!(value > 0)) return 0;
  const exponent = Math.floor(Math.log10(value));
  const base = Math.pow(10, exponent);
  for (const multiplier of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    const candidate = multiplier * base;
    if (value <= candidate + 1e-9) return candidate;
  }
  return 10 * base; // unreachable; for the type checker
}

/**
 * Transform the multi-day timeline into CUMULATIVE chart series, aligned BY
 * DATE — never by array index (V6.1 §9). Each series value is the running
 * total of the day's increments: 10 on day one, +20 on day two plots 10
 * then 30. Projects with different date ranges get null (missing) on dates
 * they do not cover — the running total pauses but never resets; a planned
 * day with 0 cases is a real 0 (the cumulative line holds its level), not
 * a missing value. Legend entries and series come from the same
 * `data.projects` list, so they always correspond exactly.
 */
export function buildTimelineChartData(data: DayTimelineData): TimelineChartData {
  const dates = data.days.map((day) => day.date);
  let max = 0;
  const series = data.projects.map((project) => {
    const byDate = new Map<string, number>();
    for (const day of data.days) {
      for (const segment of day.segments) {
        if (segment.projectId === project.projectId) byDate.set(day.date, segment.cases);
      }
    }
    let running = 0;
    const values = dates.map((date) => {
      if (!byDate.has(date)) return null;
      running += byDate.get(date) as number;
      max = Math.max(max, running);
      return running;
    });
    return {
      projectId: project.projectId,
      name: project.name,
      colorIndex: project.colorIndex,
      values,
    };
  });
  if (max <= 0) return { dates, series, yMax: 0, yStep: 0 };
  const yStep = niceAxisCeil(max / 4);
  const yMax = Math.ceil(max / yStep) * yStep;
  return { dates, series, yMax, yStep };
}

// ---- Single-project detail chart (plan vs actual lines) ----------------------

/** The detail lines: execute/pass × plan/actual plus the granular statuses. */
export const DETAIL_SERIES_KEYS = [
  'executePlan',
  'passPlan',
  'executeActual',
  'passActual',
  'failActual',
  'notApplicableActual',
  'blockedActual',
  'retestActual',
  'questionedActual',
  'spoActual',
] as const;
export type DetailSeriesKey = (typeof DETAIL_SERIES_KEYS)[number];

/** Granular status lines — plotted only once something was recorded. */
const GRANULAR_DETAIL_SERIES_KEYS: readonly DetailSeriesKey[] = [
  'failActual',
  'notApplicableActual',
  'blockedActual',
  'retestActual',
  'questionedActual',
  'spoActual',
];

/** One detail line: cumulative values aligned to the detail date axis. */
export interface DetailSeries {
  key: DetailSeriesKey;
  values: (number | null)[];
}

/** Detail-chart-ready data for the selected project. */
export interface ProjectDetailChartData {
  /** The project's OWN dates only (planned or recorded) — start to end. */
  dates: string[];
  /** Non-working-day flags aligned to `dates` (axis shading). */
  nonWorkingDays: boolean[];
  series: DetailSeries[];
  yMax: number;
  yStep: number;
}

/**
 * Build the plan/actual detail lines of one project for the single-project
 * chart (dropdown filter selection). The date axis spans the project's OWN
 * range only — every date it planned or recorded an actual on, from start
 * to end; other projects' dates never extend it. Values are already
 * cumulative per date (plan cumulative rows; end-of-day snapshots with
 * today's live totals) — aligned BY DATE with null (line break) on dates
 * without a value. Granular status lines (Fail/N/A/Blocked/Retest/
 * Questioned/SPO) appear only once something was actually recorded — a
 * never-used status stays off the chart instead of flatlining at 0. The Y
 * domain covers every plotted line. Pure: no clock, no React, no storage.
 */
export function buildProjectDetailChartData(data: DayTimelineData, projectId: string): ProjectDetailChartData {
  const project = data.projects.find((candidate) => candidate.projectId === projectId);
  if (project === undefined) return { dates: [], nonWorkingDays: [], series: [], yMax: 0, yStep: 0 };
  const ownDates = new Set<string>();
  for (const byDate of Object.values(project.detail)) {
    for (const date of Object.keys(byDate)) ownDates.add(date);
  }
  const dates = [...ownDates].sort();
  const nonWorkingByDate = new Map(data.days.map((day) => [day.date, day.nonWorkingDay]));
  const nonWorkingDays = dates.map((date) => nonWorkingByDate.get(date) ?? false);

  let max = 0;
  const series: DetailSeries[] = [];
  for (const key of DETAIL_SERIES_KEYS) {
    const byDate = project.detail[key];
    if (GRANULAR_DETAIL_SERIES_KEYS.includes(key) && !Object.values(byDate).some((value) => value > 0)) {
      continue; // nothing ever recorded for this status — keep the chart clean
    }
    const values = dates.map((date) => {
      const value = byDate[date];
      if (value === undefined) return null;
      max = Math.max(max, value);
      return value;
    });
    series.push({ key, values });
  }
  if (max <= 0) return { dates, nonWorkingDays, series, yMax: 0, yStep: 0 };
  const yStep = niceAxisCeil(max / 4);
  const yMax = Math.ceil(max / yStep) * yStep;
  return { dates, nonWorkingDays, series, yMax, yStep };
}

import { useEffect, useMemo, useState } from 'react';
import type { Language } from '../types';
import { t, type TranslationKey } from '../i18n';
import { formatCases, formatInteger } from '../lib/formatting/format';
import {
  buildProjectDetailChartData,
  buildTimelineChartData,
  filterDayTimelineData,
  type DayTimelineData,
  type DayTimelineDay,
  type DayTimelineProject,
  type DetailSeriesKey,
  type ProjectDetailChartData,
} from '../domain/projects/timeline';

/**
 * Multi-day progress chart (V6.1). A dependency-free inline SVG line chart:
 * the X axis is the shared date axis (dates horizontal), the Y axis is a
 * numeric scale derived from the data, and every project is one plotted
 * series (line + data points) in the existing project color system.
 *
 * The pure transform (buildTimelineChartData) aligns series BY DATE — never
 * by array index — and plots CUMULATIVE running totals: each day's
 * increment is added to everything before it (done 10, then +20 → 10, 30).
 * Projects with different date ranges share one axis, with null (line
 * break) on dates a project does not cover and a real 0 on planned days
 * with no remaining work (the cumulative line holds its level). Hovering a
 * data point shows a native tooltip with date, project name and the
 * running total.
 */

const WIDTH = 900;
const HEIGHT = 320;
const PAD = { top: 16, right: 20, bottom: 44, left: 56 };
const COLOR_COUNT = 8;
const MAX_DATE_LABELS = 12;

function shortDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (m === null) return date;
  return `${Number(m[2])}/${Number(m[3])}`;
}

function formatTick(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, '');
}

/** Contiguous non-null runs of a series; each run becomes one polyline. */
function nonNullRuns(values: readonly (number | null)[]): { startIndex: number; points: number[] }[] {
  const runs: { startIndex: number; points: number[] }[] = [];
  let current: number[] = [];
  let startIndex = 0;
  values.forEach((value, index) => {
    if (value === null) {
      if (current.length > 0) {
        runs.push({ startIndex, points: current });
        current = [];
      }
    } else {
      if (current.length === 0) startIndex = index;
      current.push(value);
    }
  });
  if (current.length > 0) runs.push({ startIndex, points: current });
  return runs;
}

interface MultiDayTimelineProps {
  data: DayTimelineData;
  lang: Language;
  /** Initial dropdown selection (a project id); '' = all projects. */
  defaultProjectId?: string;
}

/**
 * Plan-vs-actual summary for the project selected in the dropdown filter:
 * the four headline totals (execute/pass × plan/actual). Plan totals come
 * from the daily plan (AUTO capacity rows + MANUAL overrides, target pass
 * rate applied); actual totals are the project's live cumulative inputs.
 */
export function TimelineTotalsRow({ project, lang }: { project: DayTimelineProject; lang: Language }) {
  return (
    <div className="mdt-totals">
      <span className="mdt-total chip-plan">
        {t(lang, 'timeline.totalExecutePlan')}: {formatCases(project.totalExecutePlan, lang)}
      </span>
      <span className="mdt-total chip-plan">
        {t(lang, 'timeline.totalPassPlan')}: {formatCases(project.totalPassPlan, lang)}
      </span>
      <span className="mdt-total chip-actual">
        {t(lang, 'timeline.totalExecuteActual')}: {formatInteger(project.totalExecuteActual, lang)}
      </span>
      <span className="mdt-total chip-actual">
        {t(lang, 'timeline.totalPassActual')}: {formatInteger(project.totalPassActual, lang)}
      </span>
    </div>
  );
}

/** Fixed line color per detail series (execute/pass × plan/actual + granular statuses). */
const DETAIL_SERIES_CLASS: Record<DetailSeriesKey, string> = {
  executePlan: 'detail-exec-plan',
  passPlan: 'detail-pass-plan',
  executeActual: 'detail-exec-actual',
  passActual: 'detail-pass-actual',
  failActual: 'detail-fail-actual',
  notApplicableActual: 'detail-na-actual',
  blockedActual: 'detail-blocked-actual',
  retestActual: 'detail-retest-actual',
  questionedActual: 'detail-questioned-actual',
  spoActual: 'detail-spo-actual',
};

const DETAIL_SERIES_LABEL: Record<DetailSeriesKey, TranslationKey> = {
  executePlan: 'timeline.totalExecutePlan',
  passPlan: 'timeline.totalPassPlan',
  executeActual: 'timeline.totalExecuteActual',
  passActual: 'timeline.totalPassActual',
  failActual: 'timeline.totalFailActual',
  notApplicableActual: 'timeline.totalNotApplicableActual',
  blockedActual: 'timeline.totalBlockedActual',
  retestActual: 'timeline.totalRetestActual',
  questionedActual: 'timeline.totalQuestionedActual',
  spoActual: 'timeline.totalSpoActual',
};

/**
 * Single-project detail chart (dropdown filter selection): the cumulative
 * plan/actual lines — Total Execute Plan, Total Pass Plan, Total Execute
 * Actual, Total Pass Actual — plus the granular status lines recorded
 * time to time in the daily snapshots (Fail, N/A, Blocked, Retest,
 * Questioned, SPO — only statuses actually recorded are plotted). Each
 * line has its own color; plan lines are dashed, actual lines are solid.
 * The date axis spans the project's own range only (start to end), and is
 * date-based — no clock times are displayed.
 */
export function TimelineDetailChart({ chart, lang }: { chart: ProjectDetailChartData; lang: Language }) {
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const count = chart.dates.length;
  const x = (index: number): number =>
    count <= 1 ? PAD.left + plotWidth / 2 : PAD.left + (index / (count - 1)) * plotWidth;
  const y = (value: number): number => PAD.top + plotHeight - (value / chart.yMax) * plotHeight;
  const halfStep = count > 1 ? (x(1) - x(0)) / 2 : plotWidth / 2;

  const yTicks: number[] = [];
  for (let value = 0; value <= chart.yMax + 1e-9; value += chart.yStep) yTicks.push(value);

  const labelEvery = Math.max(1, Math.ceil(count / MAX_DATE_LABELS));
  const axisLabel = chart.series
    .map((series) => `${t(lang, DETAIL_SERIES_LABEL[series.key])} (${Math.round(series.values.reduce<number>((max, v) => Math.max(max, v ?? 0), 0))})`)
    .join(', ');

  return (
    <>
      <svg
        className="mdt-chart"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`${t(lang, 'timeline.cumulativeProgress')}: ${axisLabel}`}
      >
        {/* Non-working-day shading across the plot area */}
        {chart.nonWorkingDays.map((nonWorking, index) =>
          nonWorking ? (
            <rect
              key={`off-${chart.dates[index]}`}
              className="mdt-off-col"
              x={x(index) - halfStep}
              y={PAD.top}
              width={halfStep * 2}
              height={plotHeight}
            />
          ) : null,
        )}

        {/* Y gridlines + numeric labels (scale derived from the data) */}
        {yTicks.map((tick) => (
          <g key={`y-${tick}`}>
            <line className="mdt-grid-line" x1={PAD.left} x2={WIDTH - PAD.right} y1={y(tick)} y2={y(tick)} />
            <text className="mdt-axis-text" x={PAD.left - 8} y={y(tick) + 4} textAnchor="end">
              {formatTick(tick)}
            </text>
          </g>
        ))}

        {/* X axis + horizontal date labels */}
        <line className="mdt-axis-line" x1={PAD.left} x2={WIDTH - PAD.right} y1={PAD.top + plotHeight} y2={PAD.top + plotHeight} />
        {chart.dates.map((date, index) => (
          <g key={`x-${date}`}>
            <line
              className="mdt-axis-line"
              x1={x(index)}
              x2={x(index)}
              y1={PAD.top + plotHeight}
              y2={PAD.top + plotHeight + 5}
            />
            {index % labelEvery === 0 ? (
              <text className="mdt-axis-text" x={x(index)} y={PAD.top + plotHeight + 20} textAnchor="middle">
                {shortDate(date)}
              </text>
            ) : null}
          </g>
        ))}

        {/* One line per metric: line runs + data points */}
        {chart.series.map((series) => {
          const cls = DETAIL_SERIES_CLASS[series.key];
          return (
            <g key={series.key} className="mdt-series">
              {nonNullRuns(series.values).map((run, runIndex) => (
                <polyline
                  key={`${series.key}-${runIndex}`}
                  className={`mdt-line mdt-${cls}`}
                  points={run.points.map((value, k) => `${x(run.startIndex + k)},${y(value)}`).join(' ')}
                />
              ))}
              {series.values.map((value, index) =>
                value === null ? null : (
                  <circle
                    key={`${series.key}-p-${index}`}
                    className={`mdt-point mdt-${cls}`}
                    cx={x(index)}
                    cy={y(value)}
                    r={3.5}
                  >
                    <title>
                      {`${shortDate(chart.dates[index])} — ${t(lang, DETAIL_SERIES_LABEL[series.key])}: ${formatCases(value, lang)} ${t(lang, 'units.cases')}`}
                    </title>
                  </circle>
                ),
              )}
            </g>
          );
        })}
      </svg>
      <div className="mdt-legend">
        {chart.series.map((series) => (
          <span key={series.key} className="mdt-legend-item">
            <span className={`mdt-chip mdt-chip-${DETAIL_SERIES_CLASS[series.key]}`} />
            {t(lang, DETAIL_SERIES_LABEL[series.key])}
          </span>
        ))}
      </div>
    </>
  );
}

export function MultiDayTimeline({ data, lang, defaultProjectId = '' }: MultiDayTimelineProps) {
  // Dropdown filter: '' = all projects; otherwise one project's series.
  // Defaults to the currently selected project (only when the dropdown is
  // rendered, i.e. more than one project) and follows it; a selection that
  // disappears from the data (project completed/filtered out upstream)
  // falls back to all projects.
  const defaultSelection = data.projects.length > 1 ? defaultProjectId : '';
  const [selectedProjectId, setSelectedProjectId] = useState(defaultSelection);
  useEffect(() => {
    setSelectedProjectId(defaultSelection);
  }, [defaultSelection]);
  const selectionValid = data.projects.some((project) => project.projectId === selectedProjectId);
  const effectiveSelection = selectionValid ? selectedProjectId : '';
  const filtered = useMemo(
    () => filterDayTimelineData(data, effectiveSelection === '' ? null : effectiveSelection),
    [data, effectiveSelection],
  );
  const chart = buildTimelineChartData(filtered);
  // Four plan/actual lines of the selected project (dropdown filter).
  const detailChart = useMemo(
    () => (effectiveSelection === '' ? null : buildProjectDetailChartData(data, effectiveSelection)),
    [data, effectiveSelection],
  );
  const hasWork = filtered.maxDayCases > 0 && chart.dates.length > 0;

  if (!hasWork) {
    return (
      <div className="mdt">
        <div className="mdt-label">{t(lang, 'timeline.cumulativeProgress')}</div>
        <p className="dr-empty">{t(lang, 'timeline.noWork')}</p>
      </div>
    );
  }

  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const count = chart.dates.length;
  const x = (index: number): number =>
    count <= 1 ? PAD.left + plotWidth / 2 : PAD.left + (index / (count - 1)) * plotWidth;
  const y = (value: number): number => PAD.top + plotHeight - (value / chart.yMax) * plotHeight;
  const halfStep = count > 1 ? (x(1) - x(0)) / 2 : plotWidth / 2;

  const yTicks: number[] = [];
  for (let value = 0; value <= chart.yMax + 1e-9; value += chart.yStep) yTicks.push(value);

  const labelEvery = Math.max(1, Math.ceil(count / MAX_DATE_LABELS));
  // Values are cumulative running totals — the highest point of a series is
  // its planned total (never a sum of cumulative values, which would
  // double-count).
  const axisLabel = chart.series
    .map((s) => `${s.name} (${Math.round(s.values.reduce<number>((max, v) => Math.max(max, v ?? 0), 0))})`)
    .join(', ');

  return (
    <div className="mdt">
      <div className="mdt-toolbar">
        <div className="mdt-label">{t(lang, 'timeline.cumulativeProgress')}</div>
        {data.projects.length > 1 ? (
          <label className="dr-toolbar-field mdt-filter">
            {t(lang, 'timeline.projectFilter')}
            <select
              className="input"
              value={effectiveSelection}
              onChange={(e) => setSelectedProjectId(e.target.value)}
            >
              <option value="">{t(lang, 'timeline.allProjects')}</option>
              {data.projects.map((project) => (
                <option key={project.projectId} value={project.projectId}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {effectiveSelection !== '' ? (
        <>
          <TimelineTotalsRow project={filtered.projects[0]} lang={lang} />
          <TimelineDetailChart chart={detailChart!} lang={lang} />
        </>
      ) : (
        <>
          <svg
        className="mdt-chart"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`${t(lang, 'timeline.cumulativeProgress')}: ${axisLabel}`}
      >
        {/* Non-working-day shading across the plot area */}
        {data.days.map((day: DayTimelineDay, index) =>
          day.nonWorkingDay ? (
            <rect
              key={`off-${day.date}`}
              className="mdt-off-col"
              x={x(index) - halfStep}
              y={PAD.top}
              width={halfStep * 2}
              height={plotHeight}
            />
          ) : null,
        )}

        {/* Y gridlines + numeric labels (scale derived from the data) */}
        {yTicks.map((tick) => (
          <g key={`y-${tick}`}>
            <line className="mdt-grid-line" x1={PAD.left} x2={WIDTH - PAD.right} y1={y(tick)} y2={y(tick)} />
            <text className="mdt-axis-text" x={PAD.left - 8} y={y(tick) + 4} textAnchor="end">
              {formatTick(tick)}
            </text>
          </g>
        ))}

        {/* X axis + horizontal date labels */}
        <line className="mdt-axis-line" x1={PAD.left} x2={WIDTH - PAD.right} y1={PAD.top + plotHeight} y2={PAD.top + plotHeight} />
        {chart.dates.map((date, index) => (
          <g key={`x-${date}`}>
            <line
              className="mdt-axis-line"
              x1={x(index)}
              x2={x(index)}
              y1={PAD.top + plotHeight}
              y2={PAD.top + plotHeight + 5}
            />
            {index % labelEvery === 0 ? (
              <text className="mdt-axis-text" x={x(index)} y={PAD.top + plotHeight + 20} textAnchor="middle">
                {shortDate(date)}
              </text>
            ) : null}
          </g>
        ))}

        {/* One plotted series per project: line runs + data points */}
        {chart.series.map((series) => {
          const color = series.colorIndex % COLOR_COUNT;
          return (
            <g key={series.projectId} className="mdt-series">
              {nonNullRuns(series.values).map((run, runIndex) => (
                <polyline
                  key={`${series.projectId}-${runIndex}`}
                  className={`mdt-line mdt-line-${color}`}
                  points={run.points.map((value, k) => `${x(run.startIndex + k)},${y(value)}`).join(' ')}
                />
              ))}
              {series.values.map((value, index) =>
                value === null ? null : (
                  <circle
                    key={`${series.projectId}-p-${index}`}
                    className={`mdt-point mdt-point-${color}`}
                    cx={x(index)}
                    cy={y(value)}
                    r={3.5}
                  >
                    <title>
                      {`${shortDate(chart.dates[index])} — ${series.name}: ${value} ${t(lang, 'units.cases')}`}
                    </title>
                  </circle>
                ),
              )}
            </g>
          );
        })}
      </svg>
          <div className="mdt-legend">
            {filtered.projects.map((project) => (
              <span key={project.projectId} className="mdt-legend-item">
                <span className={`mdt-chip mdt-color-${project.colorIndex % COLOR_COUNT}`} />
                {project.name} ({formatInteger(project.totalCases, lang)})
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

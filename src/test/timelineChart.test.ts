import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  buildProjectDetailChartData,
  buildTimelineChartData,
  filterDayTimelineData,
  niceAxisCeil,
  type DayTimelineData,
  type DayTimelineDetail,
} from '../domain/projects/timeline';
import { MultiDayTimeline, TimelineDetailChart, TimelineTotalsRow } from '../components/MultiDayTimeline';

/**
 * V6.1 regression suite. The bug: the timeline chart rendered as stacked
 * plain-text date/value rows because the bar containers had no CSS. These
 * tests verify the chart-ready data transformation (date alignment!) and
 * that the component actually renders a plotted SVG chart.
 */

function day(date: string, segments: [string, number][], nonWorkingDay = false) {
  return {
    date,
    nonWorkingDay,
    totalCases: segments.reduce((sum, [, cases]) => sum + cases, 0),
    segments: segments.map(([projectId, cases]) => ({ projectId, cases })),
  };
}

const EMPTY_DETAIL: DayTimelineDetail = {
  executePlan: {}, passPlan: {}, executeActual: {}, passActual: {},
  failActual: {}, notApplicableActual: {}, blockedActual: {}, retestActual: {}, questionedActual: {}, spoActual: {},
};

/** Two projects with DIFFERENT date ranges (V6.1 §9 alignment requirement). */
function alignedData(): DayTimelineData {
  return {
    days: [
      day('2026-09-17', [['A', 112]]),
      day('2026-09-22', [['A', 224], ['B', 20]]),
      day('2026-09-23', [['A', 168], ['B', 41]]),
      day('2026-09-24', [['B', 60]]),
    ],
    maxDayCases: 244,
    projects: [
      {
        projectId: 'A', name: 'Android 4.1.0 R-can Sanity testing', colorIndex: 0, totalCases: 504,
        totalExecutePlan: 504, totalPassPlan: 453.6, totalExecuteActual: 112, totalPassActual: 100,
        detail: {
          executePlan: { '2026-09-17': 112, '2026-09-22': 336, '2026-09-23': 504 },
          passPlan: { '2026-09-17': 100.8, '2026-09-22': 302.4, '2026-09-23': 453.6 },
          executeActual: { '2026-09-17': 40, '2026-09-22': 180, '2026-09-23': 112 },
          passActual: { '2026-09-17': 38, '2026-09-22': 170, '2026-09-23': 100 },
          // Recorded time to time: 100 pass + 12 fail = 112 executed.
          failActual: { '2026-09-17': 2, '2026-09-22': 6, '2026-09-23': 12 },
          notApplicableActual: {},
          blockedActual: {},
          retestActual: {},
          questionedActual: {},
          spoActual: {},
        },
      },
      {
        projectId: 'B', name: 'HTMA 2.10', colorIndex: 1, totalCases: 121,
        totalExecutePlan: 121, totalPassPlan: 108.9, totalExecuteActual: 0, totalPassActual: 0,
        detail: EMPTY_DETAIL,
      },
    ],
  };
}

describe('niceAxisCeil', () => {
  it('produces human-friendly axis bounds', () => {
    expect(niceAxisCeil(0)).toBe(0);
    expect(niceAxisCeil(1)).toBe(1);
    expect(niceAxisCeil(8)).toBe(8);
    expect(niceAxisCeil(9)).toBe(10);
    expect(niceAxisCeil(10.25)).toBe(15);
    expect(niceAxisCeil(41)).toBe(50);
    expect(niceAxisCeil(56)).toBe(60);
    expect(niceAxisCeil(61)).toBe(80);
    expect(niceAxisCeil(100)).toBe(100);
    expect(niceAxisCeil(112)).toBe(150);
    expect(niceAxisCeil(168)).toBe(200);
    expect(niceAxisCeil(224)).toBe(250);
  });
});

describe('buildTimelineChartData', () => {
  it('aligns series BY DATE, never by array index (§9)', () => {
    const chart = buildTimelineChartData(alignedData());
    expect(chart.dates).toEqual(['2026-09-17', '2026-09-22', '2026-09-23', '2026-09-24']);
    const a = chart.series.find((s) => s.projectId === 'A')!;
    const b = chart.series.find((s) => s.projectId === 'B')!;
    // A covers 9/17–9/23; the 9/24 slot is MISSING (null), not a zero.
    expect(a.values).toEqual([112, 336, 504, null]);
    // B covers 9/22–9/24; the 9/17 slot is missing.
    expect(b.values).toEqual([null, 20, 61, 121]);
  });

  it('plots cumulative running totals of the daily increments', () => {
    const chart = buildTimelineChartData(alignedData());
    // 10 on day one, +20 on day two → 10 then 30 (increment pattern).
    const b = chart.series.find((s) => s.projectId === 'B')!;
    expect(b.values[1]).toBe(20); // first covered date
    expect(b.values[2]).toBe(61); // 20 + 41
    expect(b.values[3]).toBe(121); // 61 + 60
  });

  it('keeps real zeros distinct from missing values', () => {
    const data = alignedData();
    data.days[3].segments = [{ projectId: 'B', cases: 0 }];
    data.days[3].totalCases = 0;
    const chart = buildTimelineChartData(data);
    // A real 0 holds the cumulative level (still a plotted point); a missing
    // date would be null with a line break.
    expect(chart.series.find((s) => s.projectId === 'B')!.values).toEqual([null, 20, 61, 61]);
  });

  it('generates one series per legend project with names and colors preserved', () => {
    const chart = buildTimelineChartData(alignedData());
    expect(chart.series.map((s) => s.projectId)).toEqual(['A', 'B']);
    expect(chart.series[0].name).toBe('Android 4.1.0 R-can Sanity testing');
    expect(chart.series[0].colorIndex).toBe(0);
    expect(chart.series[1].name).toBe('HTMA 2.10');
    expect(chart.series[1].colorIndex).toBe(1);
  });

  it('all values are numeric or null — never NaN or undefined', () => {
    const chart = buildTimelineChartData(alignedData());
    for (const series of chart.series) {
      for (const value of series.values) {
        expect(value === null || (typeof value === 'number' && Number.isFinite(value))).toBe(true);
      }
    }
  });

  it('derives a nice Y domain from the cumulative data', () => {
    const chart = buildTimelineChartData(alignedData());
    expect(chart.yMax).toBeGreaterThanOrEqual(504); // highest cumulative point
    expect(chart.yMax % chart.yStep).toBe(0);
    expect(chart.yStep).toBeGreaterThan(0);
  });

  it('handles empty data without crashing', () => {
    const chart = buildTimelineChartData({ days: [], maxDayCases: 0, projects: [] });
    expect(chart.dates).toEqual([]);
    expect(chart.series).toEqual([]);
    expect(chart.yMax).toBe(0);
    expect(chart.yStep).toBe(0);
  });

  it('handles a single date and single-point series', () => {
    const data: DayTimelineData = {
      days: [day('2026-09-17', [['A', 41]])],
      maxDayCases: 41,
      projects: [{ projectId: 'A', name: 'Only One Day', colorIndex: 3, totalCases: 41, totalExecutePlan: 41, totalPassPlan: 41, totalExecuteActual: 0, totalPassActual: 0, detail: EMPTY_DETAIL }],
    };
    const chart = buildTimelineChartData(data);
    expect(chart.dates).toEqual(['2026-09-17']);
    expect(chart.series[0].values).toEqual([41]);
    expect(chart.yMax).toBeGreaterThanOrEqual(41);
  });
});

describe('filterDayTimelineData (dropdown filter)', () => {
  it('returns the data unchanged for the all-projects selection', () => {
    const data = alignedData();
    expect(filterDayTimelineData(data, null)).toBe(data);
    expect(filterDayTimelineData(data, '')).toBe(data);
  });

  it('keeps only the selected project and recomputes per-day totals', () => {
    const filtered = filterDayTimelineData(alignedData(), 'B');
    expect(filtered.projects.map((p) => p.projectId)).toEqual(['B']);
    // Same date axis, same order — never reordered by filtering.
    expect(filtered.days.map((d) => d.date)).toEqual(['2026-09-17', '2026-09-22', '2026-09-23', '2026-09-24']);
    expect(filtered.days.map((d) => d.totalCases)).toEqual([0, 20, 41, 60]);
    expect(filtered.maxDayCases).toBe(60);
    for (const day of filtered.days) {
      for (const segment of day.segments) expect(segment.projectId).toBe('B');
    }
  });

  it('feeds a chart whose Y axis rescales to the filtered data', () => {
    const chart = buildTimelineChartData(filterDayTimelineData(alignedData(), 'B'));
    expect(chart.series.map((s) => s.projectId)).toEqual(['B']);
    expect(chart.series[0].values).toEqual([null, 20, 61, 121]);
    const allProjects = buildTimelineChartData(alignedData());
    expect(chart.yMax).toBeLessThan(allProjects.yMax); // was scaled to A's 504 with both projects
  });

  it('returns the data unchanged for an unknown project id', () => {
    const data = alignedData();
    expect(filterDayTimelineData(data, 'NOPE')).toBe(data);
  });
});

describe('MultiDayTimeline rendering (renderToStaticMarkup)', () => {
  it('renders a real chart container with an SVG, lines and data points', () => {
    const html = renderToStaticMarkup(createElement(MultiDayTimeline, { data: alignedData(), lang: 'en' }));
    expect(html).toContain('class="mdt-chart"');
    expect(html).toContain('viewBox="0 0 900 320"');
    expect((html.match(/<polyline/g) ?? []).length).toBeGreaterThanOrEqual(2); // one per series
    expect((html.match(/<circle/g) ?? []).length).toBe(6); // 3 + 3 plotted points
  });

  it('renders dates as horizontal axis labels, not stacked text rows', () => {
    const html = renderToStaticMarkup(createElement(MultiDayTimeline, { data: alignedData(), lang: 'en' }));
    for (const label of ['9/17', '9/22', '9/23', '9/24']) {
      expect(html).toContain(`>${label}</text>`);
    }
    // The broken layout rendered raw date/value text in divs (mdt-row-*).
    expect(html).not.toContain('mdt-row');
    expect(html).not.toContain('mdt-rows');
  });

  it('renders a numeric Y axis derived from the data and never NaN/undefined', () => {
    const html = renderToStaticMarkup(createElement(MultiDayTimeline, { data: alignedData(), lang: 'en' }));
    expect(html).toContain('text-anchor="end"'); // Y-axis labels
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('undefined');
  });

  it('provides per-point tooltips with date, project name and cumulative value (§6)', () => {
    const html = renderToStaticMarkup(createElement(MultiDayTimeline, { data: alignedData(), lang: 'en' }));
    expect(html).toContain('9/17 — Android 4.1.0 R-can Sanity testing: 112 cases');
    expect(html).toContain('9/23 — HTMA 2.10: 61 cases'); // 20 + 41 running total
  });

  it('legend entries correspond exactly to the rendered series (§7)', () => {
    const html = renderToStaticMarkup(createElement(MultiDayTimeline, { data: alignedData(), lang: 'en' }));
    expect((html.match(/mdt-legend-item/g) ?? []).length).toBe(2);
    expect(html).toContain('Android 4.1.0 R-can Sanity testing');
    expect(html).toContain('HTMA 2.10');
    // Both series are actually plotted (line + point classes present).
    expect(html).toContain('mdt-line-0');
    expect(html).toContain('mdt-point-0');
    expect(html).toContain('mdt-line-1');
    expect(html).toContain('mdt-point-1');
  });

  it('renders the empty state without a chart and without crashing (§8)', () => {
    const html = renderToStaticMarkup(
      createElement(MultiDayTimeline, { data: { days: [], maxDayCases: 0, projects: [] }, lang: 'en' }),
    );
    expect(html).toContain('No work planned');
    expect(html).not.toContain('<svg');
  });

  it('handles a single-date chart without division-by-zero artifacts', () => {
    const data: DayTimelineData = {
      days: [day('2026-09-17', [['A', 41]])],
      maxDayCases: 41,
      projects: [{ projectId: 'A', name: 'Only One Day', colorIndex: 3, totalCases: 41, totalExecutePlan: 41, totalPassPlan: 41, totalExecuteActual: 0, totalPassActual: 0, detail: EMPTY_DETAIL }],
    };
    const html = renderToStaticMarkup(createElement(MultiDayTimeline, { data, lang: 'ja' }));
    expect(html).toContain('<svg');
    expect(html).toContain('<circle');
    expect(html).not.toContain('NaN');
  });

  it('breaks the line on missing dates instead of bridging them (§9)', () => {
    const html = renderToStaticMarkup(createElement(MultiDayTimeline, { data: alignedData(), lang: 'en' }));
    // Series A: [112, 336, 504, null] → ONE run (values then missing at end).
    // Series B: [null, 20, 61, 121] → ONE run. Two runs in total.
    expect((html.match(/<polyline/g) ?? []).length).toBe(2);
    const gapped: DayTimelineData = {
      days: [day('2026-09-17', [['A', 5]]), day('2026-09-18', []), day('2026-09-19', [['A', 7]])],
      maxDayCases: 7,
      projects: [{ projectId: 'A', name: 'Gap', colorIndex: 0, totalCases: 12, totalExecutePlan: 12, totalPassPlan: 12, totalExecuteActual: 0, totalPassActual: 0, detail: EMPTY_DETAIL }],
    };
    const gappedHtml = renderToStaticMarkup(createElement(MultiDayTimeline, { data: gapped, lang: 'en' }));
    // [5, null, 12] → two separate runs → two polylines; the running total
    // pauses on the gap but resumes at 5 + 7 = 12 (never resets).
    expect((gappedHtml.match(/<polyline/g) ?? []).length).toBe(2);
  });

  it('localizes the chart label, tooltip units and empty state', () => {
    const ja = renderToStaticMarkup(createElement(MultiDayTimeline, { data: alignedData(), lang: 'ja' }));
    expect(ja).toContain('累計進捗'); // "Cumulative progress (per project)"
    expect(ja).toContain('9/22 — Android 4.1.0 R-can Sanity testing: 336 ケース'); // 112 + 224
  });

  it('renders accessible chart semantics (§13)', () => {
    const html = renderToStaticMarkup(createElement(MultiDayTimeline, { data: alignedData(), lang: 'en' }));
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Cumulative progress (per project)');
  });

  it('renders a project dropdown filter with an all-projects default (multi-project data)', () => {
    const html = renderToStaticMarkup(createElement(MultiDayTimeline, { data: alignedData(), lang: 'en' }));
    expect(html).toContain('class="mdt-toolbar"');
    expect(html).toContain('>Project<select'); // filter field label
    expect(html).toContain('<option value="" selected="">All projects</option>');
    expect(html).toContain('<option value="A">Android 4.1.0 R-can Sanity testing</option>');
    expect(html).toContain('<option value="B">HTMA 2.10</option>');
    // Default selection is all projects: both series still plotted.
    expect(html).toContain('mdt-line-0');
    expect(html).toContain('mdt-line-1');
  });

  it('localizes the dropdown filter labels', () => {
    const ja = renderToStaticMarkup(createElement(MultiDayTimeline, { data: alignedData(), lang: 'ja' }));
    expect(ja).toContain('>プロジェクト<select');
    expect(ja).toContain('<option value="" selected="">すべてのプロジェクト</option>');
  });

  it('hides the dropdown filter when only one project contributes cases', () => {
    const single: DayTimelineData = {
      days: [day('2026-09-17', [['A', 41]])],
      maxDayCases: 41,
      projects: [{ projectId: 'A', name: 'Only One Day', colorIndex: 3, totalCases: 41, totalExecutePlan: 41, totalPassPlan: 41, totalExecuteActual: 0, totalPassActual: 0, detail: EMPTY_DETAIL }],
    };
    const html = renderToStaticMarkup(createElement(MultiDayTimeline, { data: single, lang: 'en' }));
    expect(html).not.toContain('mdt-filter');
    expect(html).not.toContain('<select');
  });

  it('does not render the plan-vs-actual totals row on the all-projects selection', () => {
    const html = renderToStaticMarkup(createElement(MultiDayTimeline, { data: alignedData(), lang: 'en' }));
    expect(html).not.toContain('mdt-totals');
    expect(html).not.toContain('Total Execute Plan');
  });
});

describe('TimelineTotalsRow (plan vs actual, dropdown selection)', () => {
  it('renders the four headline totals with plan and actual values', () => {
    const html = renderToStaticMarkup(
      createElement(TimelineTotalsRow, {
        project: alignedData().projects[0],
        lang: 'en',
      }),
    );
    expect(html).toContain('class="mdt-totals"');
    expect(html).toContain('Total Execute Plan: 504');
    expect(html).toContain('Total Pass Plan: 453.6'); // fractional pass plan keeps 1 decimal
    expect(html).toContain('Total Execute Actual: 112');
    expect(html).toContain('Total Pass Actual: 100');
  });

  it('localizes the total labels', () => {
    const ja = renderToStaticMarkup(
      createElement(TimelineTotalsRow, {
        project: alignedData().projects[0],
        lang: 'ja',
      }),
    );
    expect(ja).toContain('実行計画合計');
    expect(ja).toContain('パス計画合計');
    expect(ja).toContain('実行実績合計');
    expect(ja).toContain('パス実績合計');
  });

  it('carries the selected project totals through filterDayTimelineData', () => {
    const filtered = filterDayTimelineData(alignedData(), 'A');
    expect(filtered.projects[0].totalExecutePlan).toBe(504);
    expect(filtered.projects[0].totalPassPlan).toBe(453.6);
    expect(filtered.projects[0].totalExecuteActual).toBe(112);
    expect(filtered.projects[0].totalPassActual).toBe(100);
  });
});

describe('buildProjectDetailChartData (plan/actual lines)', () => {
  it('spans the project OWN date range only (start to end)', () => {
    const chart = buildProjectDetailChartData(alignedData(), 'A');
    // 9/24 belongs to project B only — never extends A's axis.
    expect(chart.dates).toEqual(['2026-09-17', '2026-09-22', '2026-09-23']);
  });

  it('builds the base series aligned BY DATE with a shared Y domain', () => {
    const chart = buildProjectDetailChartData(alignedData(), 'A');
    expect(chart.series.map((s) => s.key)).toEqual([
      'executePlan', 'passPlan', 'executeActual', 'passActual', 'failActual',
    ]);
    expect(chart.series[0].values).toEqual([112, 336, 504]);
    expect(chart.series[1].values).toEqual([100.8, 302.4, 453.6]);
    expect(chart.series[2].values).toEqual([40, 180, 112]);
    expect(chart.series[3].values).toEqual([38, 170, 100]);
    expect(chart.yMax).toBeGreaterThanOrEqual(504);
    expect(chart.yMax % chart.yStep).toBe(0);
    expect(chart.yStep).toBeGreaterThan(0);
  });

  it('plots granular status lines only when something was recorded', () => {
    const chart = buildProjectDetailChartData(alignedData(), 'A');
    // Fail was recorded (2 → 6 → 12) → plotted as its own line.
    const fail = chart.series.find((s) => s.key === 'failActual')!;
    expect(fail.values).toEqual([2, 6, 12]);
    // Never-recorded statuses stay off the chart instead of flatlining at 0.
    for (const hidden of ['blockedActual', 'retestActual', 'questionedActual', 'spoActual', 'notApplicableActual']) {
      expect(chart.series.some((s) => s.key === hidden)).toBe(false);
    }
  });

  it('returns empty series for an unknown project', () => {
    const chart = buildProjectDetailChartData(alignedData(), 'NOPE');
    expect(chart.series).toEqual([]);
    expect(chart.yMax).toBe(0);
    expect(chart.yStep).toBe(0);
  });
});

describe('TimelineDetailChart rendering (renderToStaticMarkup)', () => {
  it('renders every plotted line with its own color and legend label', () => {
    const chart = buildProjectDetailChartData(alignedData(), 'A');
    const html = renderToStaticMarkup(createElement(TimelineDetailChart, { chart, lang: 'en' }));
    expect(html).toContain('class="mdt-line mdt-detail-exec-plan"');
    expect(html).toContain('class="mdt-line mdt-detail-pass-plan"');
    expect(html).toContain('class="mdt-line mdt-detail-exec-actual"');
    expect(html).toContain('class="mdt-line mdt-detail-pass-actual"');
    expect(html).toContain('class="mdt-line mdt-detail-fail-actual"');
    // Legend: one colored chip + label per plotted line.
    expect((html.match(/mdt-legend-item/g) ?? []).length).toBe(5);
    expect(html).toContain('mdt-chip-detail-fail-actual');
    expect(html).toContain('Total Execute Plan');
    expect(html).toContain('Total Pass Plan');
    expect(html).toContain('Total Execute Actual');
    expect(html).toContain('Total Pass Actual');
    expect(html).toContain('Total Fail Actual');
  });

  it('renders per-point tooltips with the metric label and cumulative value', () => {
    const chart = buildProjectDetailChartData(alignedData(), 'A');
    const html = renderToStaticMarkup(createElement(TimelineDetailChart, { chart, lang: 'en' }));
    expect(html).toContain('9/23 — Total Execute Plan: 504 cases');
    expect(html).toContain('9/22 — Total Execute Actual: 180 cases');
    expect(html).toContain('9/23 — Total Fail Actual: 12 cases');
  });

  it('localizes the line labels and tooltips', () => {
    const chart = buildProjectDetailChartData(alignedData(), 'A');
    const ja = renderToStaticMarkup(createElement(TimelineDetailChart, { chart, lang: 'ja' }));
    expect(ja).toContain('実行計画合計');
    expect(ja).toContain('パス実績合計');
    expect(ja).toContain('失敗実績合計');
    expect(ja).toContain('9/23 — 実行計画合計: 504 ケース');
  });

  it('shows only the project own date range — never other projects dates', () => {
    const chart = buildProjectDetailChartData(alignedData(), 'A');
    const html = renderToStaticMarkup(createElement(TimelineDetailChart, { chart, lang: 'en' }));
    for (const label of ['9/17', '9/22', '9/23']) {
      expect(html).toContain(`>${label}</text>`);
    }
    expect(html).not.toContain('>9/24<'); // project B's date — outside A's range
  });
});

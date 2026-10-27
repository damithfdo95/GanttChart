import { useMemo, useState } from 'react';
import type { Language, ProjectRecord, TesterDailyPerformance, BugTicket } from '../../types';
import { t } from '../../i18n';
import { formatInteger } from '../../lib/formatting/format';
import {
  aggregateTesterPerformance,
  getTesterDailyBreakdown,
  getTesterMonthlyTrend,
  getTesterProjectBreakdown,
  getTesterWeeklyBreakdown,
  type AggregateOptions,
  type TesterDailyPoint,
  type TesterMonthlyTrendPoint,
  type TesterWeeklyPoint,
} from '../../lib/calculations/testerPerformance';
import { TesterDetail } from './TesterDetail';

type Granularity = 'day' | 'week' | 'month';

interface PerTesterTabProps {
  lang: Language;
  projects: readonly ProjectRecord[];
  allRecords: readonly TesterDailyPerformance[];
  allTickets: readonly BugTicket[];
  options: AggregateOptions;
  periodLabel: string;
}

/** Lightweight CSS bar chart for a numeric series (no chart library). */
function TrendChart({
  points,
  valueOf,
  labelOf,
  ariaLabel,
}: {
  points: readonly { key: string; value: number }[];
  valueOf: (point: { key: string; value: number }) => number;
  labelOf: (point: { key: string; value: number }) => string;
  ariaLabel: string;
}) {
  const max = Math.max(1, ...points.map((point) => valueOf(point)));
  return (
    <div className="perf-trend" role="img" aria-label={ariaLabel}>
      {points.map((point) => (
        <div key={point.key} className="perf-trend-month" title={`${labelOf(point)}: ${valueOf(point)}`}>
          <div className="perf-trend-bar-track">
            <div className="perf-trend-bar" style={{ height: `${Math.round((valueOf(point) / max) * 100)}%` }} />
          </div>
          <span className="perf-trend-value">{valueOf(point)}</span>
          <span className="perf-trend-label">{labelOf(point)}</span>
        </div>
      ))}
    </div>
  );
}

/** Per-day table for one tester. */
function DailyTable({ lang, rows }: { lang: Language; rows: TesterDailyPoint[] }) {
  if (rows.length === 0) {
    return <p className="dr-empty">{t(lang, 'performance.noData')}</p>;
  }
  return (
    <div className="table-wrap">
      <table className="dr-table">
        <thead>
          <tr>
            <th scope="col">{t(lang, 'columns.date')}</th>
            <th scope="col" className="num">{t(lang, 'performance.cases')}</th>
            <th scope="col" className="num">{t(lang, 'columns.pass')}</th>
            <th scope="col" className="num">{t(lang, 'fields.casesFailed')}</th>
            <th scope="col" className="num">{t(lang, 'columns.notApplicable')}</th>
            <th scope="col" className="num">{t(lang, 'columns.blocked')}</th>
            <th scope="col" className="num">{t(lang, 'fields.casesRetest')}</th>
            <th scope="col" className="num">{t(lang, 'fields.casesQuestioned')}</th>
            <th scope="col" className="num">{t(lang, 'columns.spoAssigned')}</th>
            <th scope="col" className="num">{t(lang, 'performance.bugs')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.date}>
              <td>{row.date}</td>
              <td className="num">{formatInteger(row.casesTested, lang)}</td>
              <td className="num">{formatInteger(row.casesPassed, lang)}</td>
              <td className="num">{formatInteger(row.casesFailed, lang)}</td>
              <td className="num">{formatInteger(row.casesNotApplicable, lang)}</td>
              <td className="num">{formatInteger(row.casesBlocked, lang)}</td>
              <td className="num">{formatInteger(row.casesRetest, lang)}</td>
              <td className="num">{formatInteger(row.casesQuestioned, lang)}</td>
              <td className="num">{formatInteger(row.casesSpoAssigned, lang)}</td>
              <td className="num">{formatInteger(row.bugsFound, lang)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Per-week table for one tester. */
function WeeklyTable({ lang, rows }: { lang: Language; rows: TesterWeeklyPoint[] }) {
  if (rows.length === 0) {
    return <p className="dr-empty">{t(lang, 'performance.noData')}</p>;
  }
  return (
    <div className="table-wrap">
      <table className="dr-table">
        <thead>
          <tr>
            <th scope="col">{t(lang, 'performance.week')}</th>
            <th scope="col" className="num">{t(lang, 'performance.activeDays')}</th>
            <th scope="col" className="num">{t(lang, 'performance.cases')}</th>
            <th scope="col" className="num">{t(lang, 'columns.pass')}</th>
            <th scope="col" className="num">{t(lang, 'fields.casesFailed')}</th>
            <th scope="col" className="num">{t(lang, 'columns.notApplicable')}</th>
            <th scope="col" className="num">{t(lang, 'columns.blocked')}</th>
            <th scope="col" className="num">{t(lang, 'fields.casesRetest')}</th>
            <th scope="col" className="num">{t(lang, 'fields.casesQuestioned')}</th>
            <th scope="col" className="num">{t(lang, 'columns.spoAssigned')}</th>
            <th scope="col" className="num">{t(lang, 'performance.bugs')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.week}>
              <td>{row.week}</td>
              <td className="num">{formatInteger(row.activeDays, lang)}</td>
              <td className="num">{formatInteger(row.casesTested, lang)}</td>
              <td className="num">{formatInteger(row.casesPassed, lang)}</td>
              <td className="num">{formatInteger(row.casesFailed, lang)}</td>
              <td className="num">{formatInteger(row.casesNotApplicable, lang)}</td>
              <td className="num">{formatInteger(row.casesBlocked, lang)}</td>
              <td className="num">{formatInteger(row.casesRetest, lang)}</td>
              <td className="num">{formatInteger(row.casesQuestioned, lang)}</td>
              <td className="num">{formatInteger(row.casesSpoAssigned, lang)}</td>
              <td className="num">{formatInteger(row.bugsFound, lang)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Per-Tester tab (V6.10): pick a tester from the aggregated list, then view
 * their performance by day, by ISO week, or by month — each with a trend
 * chart and a detail table. No ranking, no score, no interpretation.
 */
export function PerTesterTab({
  lang,
  projects,
  allRecords,
  allTickets,
  options,
  periodLabel,
}: PerTesterTabProps) {
  const rows = useMemo(
    () => aggregateTesterPerformance(allRecords, allTickets, options),
    [allRecords, allTickets, options],
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [granularity, setGranularity] = useState<Granularity>('month');

  const selectedRow = selectedKey === null ? null : rows.find((row) => (row.memberId ?? row.testerName) === selectedKey) ?? null;
  const testerName = selectedRow?.testerName ?? selectedKey ?? '';

  const daily = useMemo(
    () => (selectedKey === null ? [] : getTesterDailyBreakdown(allRecords, allTickets, selectedKey, options)),
    [selectedKey, allRecords, allTickets, options],
  );
  const weekly = useMemo(
    () => (selectedKey === null ? [] : getTesterWeeklyBreakdown(allRecords, allTickets, selectedKey, options)),
    [selectedKey, allRecords, allTickets, options],
  );
  const monthly = useMemo(
    () => (selectedKey === null ? [] : getTesterMonthlyTrend(allRecords, allTickets, selectedKey, options)),
    [selectedKey, allRecords, allTickets, options],
  );
  const breakdown = useMemo(
    () => (selectedKey === null ? [] : getTesterProjectBreakdown(allRecords, allTickets, selectedKey, options)),
    [selectedKey, allRecords, allTickets, options],
  );

  if (rows.length === 0) {
    return <p className="dr-empty">{t(lang, 'performance.noData')}</p>;
  }

  return (
    <>
      <section className="dr-section">
        <h2>{t(lang, 'performance.perTesterTitle')}</h2>
        <div className="dr-filter-bar">
          <label>
            {t(lang, 'performance.tester')}
            <select
              className="input"
              value={selectedKey ?? ''}
              onChange={(e) => setSelectedKey(e.target.value === '' ? null : e.target.value)}
            >
              <option value="">{t(lang, 'performance.selectTester')}</option>
              {rows.map((row) => (
                <option key={row.memberId ?? row.testerName} value={row.memberId ?? row.testerName}>
                  {row.testerName}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t(lang, 'performance.granularity')}
            <select className="input" value={granularity} onChange={(e) => setGranularity(e.target.value as Granularity)}>
              <option value="day">{t(lang, 'performance.granularityDay')}</option>
              <option value="week">{t(lang, 'performance.granularityWeek')}</option>
              <option value="month">{t(lang, 'performance.granularityMonth')}</option>
            </select>
          </label>
        </div>
      </section>

      {selectedRow === null ? (
        <p className="dr-empty">{t(lang, 'performance.selectTesterHint')}</p>
      ) : (
        <>
          <TesterDetail
            lang={lang}
            testerName={testerName}
            periodLabel={periodLabel}
            summary={{
              casesTested: selectedRow.casesTested,
              activeDays: selectedRow.activeDays,
              projects: selectedRow.projectIds.length,
              bugsFound: selectedRow.bugsFound,
            }}
            breakdown={breakdown}
            trend={monthly}
            projects={projects}
            onClose={() => setSelectedKey(null)}
          />

          <section className="dr-section">
            <h2>
              {granularity === 'day'
                ? t(lang, 'performance.dailyBreakdown')
                : granularity === 'week'
                  ? t(lang, 'performance.weeklyBreakdown')
                  : t(lang, 'performance.monthlyTrend')}
            </h2>
            {granularity === 'day' ? (
              <>
                <TrendChart
                  points={daily.map((point) => ({ key: point.date, value: point.casesTested }))}
                  valueOf={(point) => point.value}
                  labelOf={(point) => point.key}
                  ariaLabel={t(lang, 'performance.dailyBreakdown')}
                />
                <DailyTable lang={lang} rows={daily} />
              </>
            ) : granularity === 'week' ? (
              <>
                <TrendChart
                  points={weekly.map((point) => ({ key: point.week, value: point.casesTested }))}
                  valueOf={(point) => point.value}
                  labelOf={(point) => point.key}
                  ariaLabel={t(lang, 'performance.weeklyBreakdown')}
                />
                <WeeklyTable lang={lang} rows={weekly} />
              </>
            ) : (
              <>
                <TrendChart
                  points={monthly.map((point) => ({ key: point.month, value: point.casesTested }))}
                  valueOf={(point) => point.value}
                  labelOf={(point) => point.key}
                  ariaLabel={t(lang, 'performance.monthlyTrend')}
                />
                <MonthlyTable lang={lang} rows={monthly} />
              </>
            )}
          </section>
        </>
      )}
    </>
  );
}

/** Per-month table for one tester. */
function MonthlyTable({ lang, rows }: { lang: Language; rows: TesterMonthlyTrendPoint[] }) {
  if (rows.length === 0) {
    return <p className="dr-empty">{t(lang, 'performance.noData')}</p>;
  }
  return (
    <div className="table-wrap">
      <table className="dr-table">
        <thead>
          <tr>
            <th scope="col">{t(lang, 'performance.month')}</th>
            <th scope="col" className="num">{t(lang, 'performance.activeDays')}</th>
            <th scope="col" className="num">{t(lang, 'performance.cases')}</th>
            <th scope="col" className="num">{t(lang, 'performance.bugs')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.month}>
              <td>{row.month}</td>
              <td className="num">{formatInteger(row.activeDays, lang)}</td>
              <td className="num">{formatInteger(row.casesTested, lang)}</td>
              <td className="num">{formatInteger(row.bugsFound, lang)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
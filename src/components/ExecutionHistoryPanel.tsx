import { useMemo } from 'react';
import type { DailyActualSnapshot, Language } from '../types';
import { t } from '../i18n';
import { buildExecutionHistory, executionTrendPoints, type ExecutionHistoryRow } from '../lib/calculations/history';
import { formatCases, formatInteger } from '../lib/formatting/format';
import { usePagedRows } from '../lib/pagination/usePagedRows';
import { TablePager } from './TablePager';

interface ExecutionHistoryPanelProps {
  snapshots: DailyActualSnapshot[];
  totalCases: number;
  lang: Language;
}

function num(value: number | null, lang: Language): string {
  return value === null ? '—' : formatInteger(value, lang);
}

function deltaText(value: number | null): string {
  if (value === null) return '—';
  return `${value >= 0 ? '+' : ''}${value}`;
}

/**
 * V6.5 §7–§9: historical execution timeline, execution trend and status
 * breakdown. Everything is derived from ACTUAL stored snapshots via the pure
 * history layer — history is never recalculated from the current project
 * state. No charting dependency: the existing CSS bar-chart pattern
 * (dp-trend) is reused. Legacy snapshots show "—" for values that were never
 * recorded (never a false zero).
 */
export function ExecutionHistoryPanel({ snapshots, totalCases, lang }: ExecutionHistoryPanelProps) {
  const history = useMemo(() => buildExecutionHistory(snapshots, totalCases), [snapshots, totalCases]);
  const trend = useMemo(() => executionTrendPoints(history), [history]);
  // History grows one row per executed day — the table paginates (newest
  // visible first: the list is oldest-first), the trend charts keep the
  // complete series.
  const pager = usePagedRows(history, 10, { initialPage: 'last' });
  const openMax = useMemo(
    () => Math.max(1, ...history.map((row) => Math.max(row.blocked ?? 0, row.retest ?? 0, row.questioned ?? 0))),
    [history],
  );

  if (history.length === 0) {
    return (
      <div className="eh-panel">
        <h3>{t(lang, 'history.title')}</h3>
        <p className="empty-note">{t(lang, 'history.empty')}</p>
      </div>
    );
  }

  const newestDate = history[history.length - 1].date;

  return (
    <div className="eh-panel">
      <h3>{t(lang, 'history.title')}</h3>

      <div className="table-wrap">
        <table className="dr-table eh-table table-wide">
          <thead>
            <tr>
              <th scope="col">{t(lang, 'columns.date')}</th>
              <th scope="col" className="num">{t(lang, 'columns.pass')}</th>
              <th scope="col" className="num">{t(lang, 'fields.casesFailed')}</th>
              <th scope="col" className="num">{t(lang, 'fields.casesNotApplicable')}</th>
              <th scope="col" className="num">{t(lang, 'columns.spoAssigned')}</th>
              <th scope="col" className="num">{t(lang, 'metrics.qaTested')}</th>
              <th scope="col" className="num">{t(lang, 'metrics.qaCompleted')}</th>
              <th scope="col" className="num">{t(lang, 'dashboard.remainingCases')}</th>
              <th scope="col" className="num">{t(lang, 'fields.casesBlocked')}</th>
              <th scope="col" className="num">{t(lang, 'fields.casesRetest')}</th>
              <th scope="col" className="num">{t(lang, 'fields.casesQuestioned')}</th>
              <th scope="col" className="num">{t(lang, 'history.change')}</th>
            </tr>
          </thead>
        <tbody>
          {pager.pagedRows.map((row) => (
            <tr key={row.snapshot.id} className={row.date === newestDate ? 'eh-latest' : undefined}>
              <td>
                {row.date}
                {row.date === newestDate ? <span className="tag-today"> {t(lang, 'history.latest')}</span> : null}
                {row.granularConsistent === false ? (
                  <span className="eh-warning" title={t(lang, 'history.inconsistent')} aria-label={t(lang, 'history.inconsistent')}>
                    {' ⚠'}
                  </span>
                ) : null}
              </td>
              <td className="num">{formatInteger(row.pass, lang)}</td>
              <td className="num">{num(row.fail, lang)}</td>
              <td className="num">{num(row.notApplicable, lang)}</td>
              <td className="num">{num(row.spo, lang)}</td>
              <td className="num">{formatInteger(row.qaTested, lang)}</td>
              <td className="num">{formatInteger(row.qaCompleted, lang)}</td>
              <td className="num">{formatInteger(row.remaining, lang)}</td>
              <td className="num">{num(row.blocked, lang)}</td>
              <td className="num">{num(row.retest, lang)}</td>
              <td className="num">{num(row.questioned, lang)}</td>
              <td className="num">{deltaText(row.deltaQaCompleted)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <TablePager lang={lang} pager={pager} />

      {/* §8: QA Completed / Remaining / QA Tested over time (from snapshots). */}
      <div className="eh-trend">
        <div className="dp-trend-title">{t(lang, 'history.trendTitle')}</div>
        <div className="dp-trend-legend">
          <span className="legend-chip chip-progress">{t(lang, 'metrics.qaCompleted')}</span>
          <span className="legend-chip chip-remaining">{t(lang, 'dashboard.remainingCases')}</span>
          <span className="legend-chip chip-planned">{t(lang, 'metrics.qaTested')}</span>
        </div>
        <div
          className="dp-trend-chart"
          role="img"
          aria-label={t(lang, 'history.trendTitle')}
        >
          {trend.map((point) => {
            const completedHeight = totalCases > 0 ? Math.min(100, (point.qaCompleted / totalCases) * 100) : 0;
            const remainingHeight = totalCases > 0 ? Math.min(100, (point.remaining / totalCases) * 100) : 0;
            const testedHeight = totalCases > 0 ? Math.min(100, (point.qaTested / totalCases) * 100) : 0;
            return (
              <div
                key={point.date}
                className="dp-trend-col"
                title={`${point.date} — ${t(lang, 'metrics.qaCompleted')}: ${formatCases(point.qaCompleted, lang)} / ${t(lang, 'metrics.qaTested')}: ${formatCases(point.qaTested, lang)} / ${t(lang, 'dashboard.remainingCases')}: ${formatCases(point.remaining, lang)}`}
              >
                <div className="dp-trend-bars">
                  <div className="dp-trend-bar eh-bar-completed" style={{ height: `${completedHeight}%` }} />
                  <div className="dp-trend-bar eh-bar-remaining" style={{ height: `${remainingHeight}%` }} />
                  <div className="dp-trend-bar eh-bar-tested" style={{ height: `${testedHeight}%` }} />
                </div>
                <div className="dp-trend-date">{point.date.slice(5)}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* §9: completion results vs open/risk statuses — visually distinct groups. */}
      <div className="eh-trend">
        <div className="dp-trend-title">{t(lang, 'history.completionResults')}</div>
        <div className="dp-trend-legend">
          <span className="legend-chip chip-pass">{t(lang, 'columns.pass')}</span>
          <span className="legend-chip chip-fail">{t(lang, 'fields.casesFailed')}</span>
          <span className="legend-chip chip-na">{t(lang, 'fields.casesNotApplicable')}</span>
          <span className="legend-chip chip-spo">{t(lang, 'columns.spoAssigned')}</span>
        </div>
        <div
          className="dp-trend-chart"
          role="img"
          aria-label={t(lang, 'history.completionResults')}
        >
          {history.map((row) => (
            <StackedCompletionColumn key={row.snapshot.id} row={row} totalCases={totalCases} lang={lang} />
          ))}
        </div>
      </div>

      <div className="eh-trend">
        <div className="dp-trend-title">{t(lang, 'history.openStatuses')}</div>
        <div className="dp-trend-legend">
          <span className="legend-chip chip-blocked">{t(lang, 'fields.casesBlocked')}</span>
          <span className="legend-chip chip-retest">{t(lang, 'fields.casesRetest')}</span>
          <span className="legend-chip chip-questioned">{t(lang, 'fields.casesQuestioned')}</span>
        </div>
        <div
          className="dp-trend-chart"
          role="img"
          aria-label={t(lang, 'history.openStatuses')}
        >
          {history.map((row) => (
            <div
              key={row.snapshot.id}
              className="dp-trend-col"
              title={`${row.date} — ${t(lang, 'fields.casesBlocked')}: ${num(row.blocked, lang)} / ${t(lang, 'fields.casesRetest')}: ${num(row.retest, lang)} / ${t(lang, 'fields.casesQuestioned')}: ${num(row.questioned, lang)}`}
            >
              <div className="dp-trend-bars">
                <div className="dp-trend-bar eh-bar-blocked" style={{ height: `${((row.blocked ?? 0) / openMax) * 100}%` }} />
                <div className="dp-trend-bar eh-bar-retest" style={{ height: `${((row.retest ?? 0) / openMax) * 100}%` }} />
                <div className="dp-trend-bar eh-bar-questioned" style={{ height: `${((row.questioned ?? 0) / openMax) * 100}%` }} />
              </div>
              <div className="dp-trend-date">{row.date.slice(5)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** One stacked completion-results column; legacy rows show an "unknown" block. */
function StackedCompletionColumn({ row, totalCases, lang }: { row: ExecutionHistoryRow; totalCases: number; lang: Language }) {
  const pct = (value: number): number => (totalCases > 0 ? Math.min(100, (value / totalCases) * 100) : 0);
  if (!row.granularKnown) {
    return (
      <div
        className="dp-trend-col"
        title={`${row.date} — ${t(lang, 'history.granularUnavailable')} (${t(lang, 'metrics.qaCompleted')}: ${formatCases(row.qaCompleted, lang)})`}
      >
        <div className="dp-trend-bars">
          <div className="dp-trend-bar eh-bar-unknown" style={{ height: `${pct(row.qaCompleted)}%` }} />
        </div>
        <div className="dp-trend-date">{row.date.slice(5)}</div>
      </div>
    );
  }
  const pass = row.pass;
  const fail = row.fail ?? 0;
  const na = row.notApplicable ?? 0;
  const spo = row.spo ?? 0;
  const uncategorized = Math.max(0, row.qaCompleted - pass - fail - na - spo);
  return (
    <div
      className="dp-trend-col"
      title={`${row.date} — ${t(lang, 'columns.pass')}: ${formatCases(pass, lang)} / ${t(lang, 'fields.casesFailed')}: ${formatCases(fail, lang)} / ${t(lang, 'fields.casesNotApplicable')}: ${formatCases(na, lang)} / ${t(lang, 'columns.spoAssigned')}: ${formatCases(spo, lang)}`}
    >
      <div className="dp-trend-bars eh-stack">
        <div className="eh-seg eh-seg-pass" style={{ height: `${pct(pass)}%` }} />
        <div className="eh-seg eh-seg-fail" style={{ height: `${pct(fail)}%` }} />
        <div className="eh-seg eh-seg-na" style={{ height: `${pct(na)}%` }} />
        <div className="eh-seg eh-seg-spo" style={{ height: `${pct(spo)}%` }} />
        {uncategorized > 0 ? <div className="eh-seg eh-seg-unknown" style={{ height: `${pct(uncategorized)}%` }} /> : null}
      </div>
      <div className="dp-trend-date">{row.date.slice(5)}</div>
    </div>
  );
}

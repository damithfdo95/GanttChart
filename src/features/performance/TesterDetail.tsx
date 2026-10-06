import type { Language, ProjectRecord } from '../../types';
import { t } from '../../i18n';
import { MetricCard } from '../../components/MetricCard';
import { formatInteger, formatNumber } from '../../lib/formatting/format';
import type { TesterMonthlyTrendPoint, TesterProjectBreakdownRow } from '../../lib/calculations/testerPerformance';
import { ProjectBreakdown } from './ProjectBreakdown';

/** Per-tester summary figures shown in the detail view. */
export interface TesterDetailSummary {
  casesTested: number;
  activeDays: number;
  projects: number;
  bugsFound: number;
}

interface TesterDetailProps {
  lang: Language;
  testerName: string;
  periodLabel: string;
  summary: TesterDetailSummary;
  breakdown: TesterProjectBreakdownRow[];
  trend: TesterMonthlyTrendPoint[];
  projects: ProjectRecord[];
  onClose: () => void;
}

/** Monthly trend as a lightweight CSS bar chart (no chart library). */
function MonthlyTrendChart({ lang, trend }: { lang: Language; trend: TesterMonthlyTrendPoint[] }) {
  const max = Math.max(1, ...trend.map((point) => point.casesTested));
  return (
    <div className="perf-trend" role="img" aria-label={t(lang, 'performance.monthlyTrend')}>
      {trend.map((point) => (
        <div key={point.month} className="perf-trend-month" title={`${point.month}: ${point.casesTested}`}>
          <div className="perf-trend-bar-track">
            <div className="perf-trend-bar" style={{ height: `${Math.round((point.casesTested / max) * 100)}%` }} />
          </div>
          <span className="perf-trend-value">{point.casesTested}</span>
          <span className="perf-trend-label">{point.month}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Tester detail view (V6.6 §18): objective summary, per-project breakdown
 * and monthly trend. No ranking, no score, no interpretation of the bug
 * discovery rate — the underlying numbers are always shown alongside it.
 */
export function TesterDetail({ lang, testerName, periodLabel, summary, breakdown, trend, projects, onClose }: TesterDetailProps) {
  const bugDiscoveryRate =
    summary.casesTested > 0 ? (summary.bugsFound / summary.casesTested) * 1000 : null;
  return (
    <section className="dr-section">
      <h2>
        {t(lang, 'performance.testerDetail')} — {testerName}
      </h2>
      <p className="dr-summary">
        {t(lang, 'performance.period')}: {periodLabel}
      </p>
      <div className="metrics-grid">
        <MetricCard label={t(lang, 'performance.casesTested')} value={formatInteger(summary.casesTested, lang)} />
        <MetricCard label={t(lang, 'performance.activeDays')} value={formatInteger(summary.activeDays, lang)} />
        <MetricCard
          label={t(lang, 'performance.averagePerDay')}
          value={formatNumber(summary.activeDays > 0 ? summary.casesTested / summary.activeDays : 0, 1, lang)}
        />
        <MetricCard label={t(lang, 'performance.projectsCount')} value={formatInteger(summary.projects, lang)} />
        <MetricCard label={t(lang, 'performance.bugsFound')} value={formatInteger(summary.bugsFound, lang)} />
      </div>
      <p className="dr-summary">
        {bugDiscoveryRate === null
          ? t(lang, 'performance.bugDiscoveryRate')
          : t(lang, 'performance.bugDiscoveryRateDetail', {
              rate: formatNumber(bugDiscoveryRate, 2, lang),
              bugs: formatInteger(summary.bugsFound, lang),
              cases: formatInteger(summary.casesTested, lang),
            })}
      </p>

      <h3>{t(lang, 'performance.projectBreakdown')}</h3>
      <ProjectBreakdown lang={lang} rows={breakdown} projects={projects} />

      <h3>{t(lang, 'performance.monthlyTrend')}</h3>
      {trend.length === 0 ? (
        <p className="dr-empty">{t(lang, 'performance.noData')}</p>
      ) : (
        <MonthlyTrendChart lang={lang} trend={trend} />
      )}

      <div className="dr-button-row">
        <button type="button" className="btn" onClick={onClose}>
          {t(lang, 'buttons.close')}
        </button>
      </div>
    </section>
  );
}

import type { Language } from '../../types';
import { t } from '../../i18n';
import { MetricCard } from '../../components/MetricCard';
import { formatInteger } from '../../lib/formatting/format';
import type { PerformanceSummary } from '../../lib/calculations/testerPerformance';

interface PerformanceSummaryCardsProps {
  lang: Language;
  summary: PerformanceSummary;
}

/** Team-level summary (V6.6 §16) — objective evidence, never a rating. */
export function PerformanceSummaryCards({ lang, summary }: PerformanceSummaryCardsProps) {
  return (
    <div className="metrics-grid">
      <MetricCard label={t(lang, 'performance.totalTesters')} value={formatInteger(summary.totalTesters, lang)} />
      <MetricCard label={t(lang, 'performance.totalCasesTested')} value={formatInteger(summary.totalCasesTested, lang)} />
      <MetricCard label={t(lang, 'performance.totalBugs')} value={formatInteger(summary.totalBugs, lang)} />
      <MetricCard label={t(lang, 'performance.activeTesterDays')} value={formatInteger(summary.activeTesterDays, lang)} />
      <MetricCard label={t(lang, 'performance.projectsCount')} value={formatInteger(summary.projects, lang)} />
    </div>
  );
}

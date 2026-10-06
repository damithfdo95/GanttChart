import type { Language, ScheduleStatus } from '../types';
import type { ExecutiveSummary } from '../lib/calculations/executive';
import { t, type TranslationKey } from '../i18n';
import { formatClock, formatInteger, formatNumber, formatSignedDuration } from '../lib/formatting/format';
import { MetricCard } from './MetricCard';

interface ExecutiveSummaryProps {
  summary: ExecutiveSummary;
  lang: Language;
}

/** Shared mapping from schedule status to its translation key. */
export const STATUS_LABEL_KEY: Record<ScheduleStatus, TranslationKey> = {
  NOT_STARTED: 'status.notStarted',
  ON_SCHEDULE: 'status.onSchedule',
  AHEAD: 'status.ahead',
  DELAYED: 'status.delayed',
  COMPLETED: 'status.completed',
};

/**
 * Level 2 §1: the 13 five-second metrics. Pure presentation — every value
 * comes from the composed executive summary (existing engine functions).
 */
export function ExecutiveSummaryView({ summary, lang }: ExecutiveSummaryProps) {
  const varianceTone = summary.varianceMinutes === null ? 'default' : summary.varianceMinutes >= 0 ? 'good' : 'bad';
  return (
    <>
    <div className="metrics-grid exec-strip">
      <MetricCard label={t(lang, 'fields.totalCases')} value={formatInteger(summary.totalCases, lang)} />
      <MetricCard label={t(lang, 'fields.casesCompleted')} value={formatInteger(summary.casesCompleted, lang)} hint={t(lang, 'hint.qaCompleted')} />
      <MetricCard
        label={t(lang, 'metrics.qaTested')}
        value={`${formatInteger(summary.qaTested, lang)} ${t(lang, 'units.cases')}`}
        hint={t(lang, 'hint.qaTested')}
      />
      <MetricCard
        label={t(lang, 'metrics.spoAssigned')}
        value={`${formatInteger(summary.spoAssigned, lang)} ${t(lang, 'units.cases')}`}
      />
      <MetricCard label={t(lang, 'dashboard.remainingCases')} value={formatInteger(summary.casesRemaining, lang)} hint={t(lang, 'hint.remaining')} />
      <MetricCard
        label={t(lang, 'metrics.qaTestedRatio')}
        value={summary.qaTestedRatio === null ? '—' : `${formatNumber(summary.qaTestedRatio * 100, 1, lang)}%`}
        hint={t(lang, 'hint.qaTestedRatio')}
      />
      <MetricCard
        label={t(lang, 'exec.progress')}
        value={summary.progressRatio === null ? '—' : `${formatNumber(summary.progressRatio * 100, 1, lang)}%`}
        hint={t(lang, 'hint.progress')}
      />
      <MetricCard label={t(lang, 'fields.currentTesters')} value={formatInteger(summary.currentTesters, lang)} />
      <MetricCard
        label={t(lang, 'dashboard.requiredTesters')}
        value={summary.requiredTesters === null ? '—' : formatInteger(summary.requiredTesters, lang)}
        hint={t(lang, 'hint.requiredTesters')}
      />
      <MetricCard
        label={t(lang, 'exec.currentRate')}
        value={summary.currentRatePerHour === null ? '—' : `${formatNumber(summary.currentRatePerHour, 1, lang)} ${t(lang, 'units.casesPerHour')}`}
        hint={t(lang, 'hint.currentRate')}
      />
      <MetricCard
        label={t(lang, 'exec.requiredRate')}
        value={summary.requiredRatePerHour === null ? '—' : `${formatNumber(summary.requiredRatePerHour, 1, lang)} ${t(lang, 'units.casesPerHour')}`}
        hint={t(lang, 'hint.requiredRate')}
      />
      <MetricCard label={t(lang, 'labels.expectedFinish')} value={formatClock(summary.expectedFinish)} hint={t(lang, 'hint.plannedFinish')} />
      <MetricCard label={t(lang, 'dashboard.predictedFinish')} value={formatClock(summary.projectedFinish)} hint={t(lang, 'hint.forecastFinish')} />
      <MetricCard label={t(lang, 'fields.targetFinish')} value={formatClock(summary.targetFinish)} />
      <MetricCard
        label={t(lang, 'metrics.scheduleVariance')}
        value={formatSignedDuration(summary.varianceMinutes)}
        tone={varianceTone}
        hint={t(lang, 'hint.scheduleVariance')}
      />
      <MetricCard label={t(lang, 'exec.status')} value={t(lang, STATUS_LABEL_KEY[summary.status])} tone={varianceTone} />
    </div>

    {/* V6.5 §10: compact granular execution breakdown — read-only, derived
        from the same canonical fields via calculateExecutionCounts. */}
    <div className="exec-breakdown">
      <div className="exec-breakdown-title">{t(lang, 'exec.breakdownTitle')}</div>
      <div className="metrics-grid exec-breakdown-grid">
        <MetricCard label={t(lang, 'columns.pass')} value={formatInteger(summary.pass, lang)} />
        <MetricCard label={t(lang, 'fields.casesFailed')} value={formatInteger(summary.fail, lang)} />
        <MetricCard label={t(lang, 'fields.casesNotApplicable')} value={formatInteger(summary.notApplicable, lang)} />
        <MetricCard label={t(lang, 'metrics.spoAssigned')} value={formatInteger(summary.spoAssigned, lang)} />
        <MetricCard label={t(lang, 'fields.casesBlocked')} value={formatInteger(summary.blocked, lang)} />
        <MetricCard label={t(lang, 'fields.casesRetest')} value={formatInteger(summary.retest, lang)} />
        <MetricCard label={t(lang, 'fields.casesQuestioned')} value={formatInteger(summary.questioned, lang)} />
      </div>
    </div>
    </>
  );
}

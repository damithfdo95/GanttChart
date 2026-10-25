import { MetricCard } from '../../components/MetricCard';
import { t } from '../../i18n';
import { formatInteger } from '../../lib/formatting/format';
import type { TesterCapacitySummary } from '../../domain/testerCapacity';
import type { Language } from '../../types';

/** Planned vs Assigned vs Actual-today testers, side by side. Display only: it writes nothing and feeds no calculation. */
export function TesterCapacityStrip({ lang, summary }: { lang: Language; summary: TesterCapacitySummary }) {
  const stateText =
    summary.assignmentState === 'fullyStaffed'
      ? t(lang, 'capacity.fullyStaffed')
      : summary.assignmentState === 'assignmentGap'
        ? t(lang, 'capacity.assignmentGap', { n: summary.assignmentGap })
        : t(lang, 'capacity.overAssigned', { n: -summary.assignmentGap });
  return (
    <section className="dr-section" aria-label={t(lang, 'capacity.title')}>
      <div className="metrics-grid">
        <MetricCard label={t(lang, 'fields.currentTesters')} value={formatInteger(summary.planned, lang)} hint={t(lang, 'hint.plannedTesters')} />
        <MetricCard label={t(lang, 'capacity.assigned')} value={formatInteger(summary.assigned, lang)} hint={t(lang, 'capacity.assignedHint')} tone={summary.assignmentState === 'fullyStaffed' ? 'good' : 'warn'} />
        <MetricCard
          label={t(lang, 'capacity.actualToday')}
          value={summary.actual === null ? '—' : formatInteger(summary.actual, lang)}
          hint={t(lang, 'exec.actualTestersHint')}
        />
      </div>
      <p className="link-help" role="note">
        {stateText}
        {summary.actualGap !== null && summary.actualGap !== 0 ? ` · ${t(lang, summary.actualGap > 0 ? 'capacity.actualBelow' : 'capacity.actualAbove', { n: Math.abs(summary.actualGap) })}` : ''}
      </p>
    </section>
  );
}

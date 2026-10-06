import type { Language } from '../../types';
import { t } from '../../i18n';
import { MetricCard } from '../../components/MetricCard';
import type { TicketSummary } from '../../domain/tickets';

interface TicketSummaryCardsProps {
  lang: Language;
  summary: TicketSummary;
}

/** Derived ticket counts (V6.6 §8) — never a manually-entered total. */
export function TicketSummaryCards({ lang, summary }: TicketSummaryCardsProps) {
  return (
    <div className="metrics-grid">
      <MetricCard label={t(lang, 'tickets.totalTickets')} value={String(summary.total)} />
      <MetricCard label={t(lang, 'tickets.thisMonth')} value={String(summary.thisMonth)} />
      <MetricCard label={t(lang, 'tickets.openTickets')} value={String(summary.open)} />
      <MetricCard label={t(lang, 'tickets.criticalMajor')} value={String(summary.criticalOrMajor)} />
      <MetricCard label={t(lang, 'tickets.closedTickets')} value={String(summary.closed)} />
      <MetricCard label={t(lang, 'tickets.uniqueReporters')} value={String(summary.uniqueReporters)} />
    </div>
  );
}

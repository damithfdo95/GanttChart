import { useMemo } from 'react';
import type { Language, ProjectRecord, RcsMember, TesterDailyPerformance, BugTicket } from '../../types';
import { t } from '../../i18n';
import {
  aggregateTesterPerformance,
  performanceSummary,
  unlinkedTesterNames,
  type AggregateOptions,
  type PeriodRange,
} from '../../lib/calculations/testerPerformance';
import { PerformanceSummaryCards } from './PerformanceSummary';
import { TesterPerformanceTable } from './TesterPerformanceTable';

interface PerformanceOverviewTabProps {
  lang: Language;
  projects: readonly ProjectRecord[];
  members: readonly RcsMember[];
  allRecords: readonly TesterDailyPerformance[];
  allTickets: readonly BugTicket[];
  options: AggregateOptions;
  range: PeriodRange | null;
  selectedTester: string | null;
  /** Toggle a tester's selection (pass the row key; null clears). */
  onToggleTester: (key: string) => void;
}

/**
 * Overview tab (V6.10): team-level summary cards + the aggregated per-tester
 * table for the selected period/project scope. Unknown (unlinked) testers
 * are hidden from the table and reported as a hint — the Unlinked Testers
 * panel is where they are confirmed/merged.
 */
export function PerformanceOverviewTab({
  lang,
  projects,
  allRecords,
  allTickets,
  options,
  selectedTester,
  onToggleTester,
}: PerformanceOverviewTabProps) {
  const rows = useMemo(
    () => aggregateTesterPerformance(allRecords, allTickets, options),
    [allRecords, allTickets, options],
  );
  const summary = useMemo(
    () => performanceSummary(allRecords, allTickets, options),
    [allRecords, allTickets, options],
  );
  const unlinkedTesters = useMemo(
    () => unlinkedTesterNames(allRecords, allTickets, options),
    [allRecords, allTickets, options],
  );

  return (
    <>
      <PerformanceSummaryCards lang={lang} summary={summary} />
      <section className="dr-section">
        <h2>{t(lang, 'performance.title')}</h2>
        {unlinkedTesters.length > 0 ? (
          <p className="dr-summary">
            {t(lang, 'performance.unlinkedHidden', { count: unlinkedTesters.length, names: unlinkedTesters.join(' / ') })}
          </p>
        ) : null}
        <TesterPerformanceTable
          lang={lang}
          rows={rows}
          projects={projects}
          selectedTester={selectedTester}
          onSelect={(key) => onToggleTester(key)}
        />
      </section>
    </>
  );
}
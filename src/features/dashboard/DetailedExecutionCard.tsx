import { MetricCard } from '../../components/MetricCard';
import { t, type TranslationKey } from '../../i18n';
import { formatInteger } from '../../lib/formatting/format';
import { executionSourceLabelKey, executionSourceOf } from '../../domain/executionSource';
import type { DailyDetailedSummary, DailyExecutionComparison } from '../../domain/testManagement';
import type { DailyExecutionEntry, Language } from '../../types';

const pct = (v: number | null): string => (v === null ? '—' : `${Math.round(v * 100)}%`);

/**
 * Detailed Case Execution of ONE date, derived from the immutable case history and shown BESIDE the saved daily aggregate. It is
 * a comparison only: nothing here writes the saved figures, switches their source or reconciles the two.
 *
 * Terminology is deliberate: "Execution Events" counts history events; "Unique Cases Executed" counts cases (the latest event of
 * the day is a case's final status). The status counts add up to the unique cases, never to the events.
 */
export function DetailedExecutionCard({ lang, summary, saved, comparison, title }: { lang: Language; summary: DailyDetailedSummary; saved?: DailyExecutionEntry | null; comparison?: DailyExecutionComparison | null; title?: string }) {
  const none = summary.eventCount === 0;
  const status = (key: 'pass' | 'fail' | 'blocked' | 'inProgress', value: number) => <MetricCard label={t(lang, `tm.status.${key}` as TranslationKey)} value={formatInteger(value, lang)} />;
  return (
    <section className="exec-detail" aria-label={title ?? t(lang, 'exec.detail.title')}>
      <h4 className="exec-detail-title">
        {title ?? t(lang, 'exec.detail.title')} <span className="gap-pill">{t(lang, 'exec.detail.derived')}</span>
      </h4>
      {summary.registeredCases === 0 && none ? (
        <p className="exec-help">{t(lang, 'exec.detail.noCases')}</p>
      ) : (
        <>
          {none ? <p className="exec-help">{t(lang, 'exec.detail.empty')}</p> : null}
          <div className="metrics-grid">
            <MetricCard label={t(lang, 'exec.detail.unique')} value={formatInteger(summary.uniqueCasesExecuted, lang)} hint={t(lang, 'exec.detail.uniqueHint')} />
            <MetricCard label={t(lang, 'exec.detail.events')} value={formatInteger(summary.eventCount, lang)} hint={t(lang, 'exec.detail.eventsHint')} />
            {status('pass', summary.passed)}
            {status('fail', summary.failed)}
            {status('blocked', summary.blocked)}
            {status('inProgress', summary.inProgress)}
            <MetricCard label={t(lang, 'exec.detail.registered')} value={formatInteger(summary.registeredCases, lang)} />
            <MetricCard label={t(lang, 'exec.detail.scopeTotal')} value={summary.scopeTotalCases === null ? '—' : formatInteger(summary.scopeTotalCases, lang)} />
          </div>
          {summary.registeredCases > 0 ? (
            <p className="exec-help">
              {summary.scopeTotalCases === null
                ? t(lang, 'exec.detail.coverageRegisteredNoTotal', { registered: summary.registeredCases })
                : t(lang, 'exec.detail.coverageRegistered', { registered: summary.registeredCases, total: summary.scopeTotalCases })}
              {' · '}
              {t(lang, 'exec.detail.coverageExecuted', { executed: summary.executedRegisteredCases, registered: summary.registeredCases, pct: pct(summary.coverage.executedVsRegistered) })}
            </p>
          ) : null}
          {summary.manualEvents + summary.testrailEvents > 0 ? (
            <p className="exec-help">
              {t(lang, 'exec.detail.sources')}: {t(lang, 'exec.detail.sourceManual', { n: summary.manualEvents })} · {t(lang, 'exec.detail.sourceTestrail', { n: summary.testrailEvents })}
            </p>
          ) : null}
        </>
      )}
      <p className="exec-help">{summary.firstEventDate === null ? t(lang, 'exec.detail.partialNone') : t(lang, 'exec.detail.partial', { date: summary.firstEventDate })}</p>

      {comparison === undefined || comparison === null ? null : (
        <div className="exec-detail-compare" role="status">
          <h4 className="exec-detail-title">{t(lang, 'exec.detail.savedTitle')}</h4>
          {saved === undefined || saved === null || !comparison.hasSaved ? (
            <p className="exec-help">{t(lang, 'exec.detail.noSaved')}</p>
          ) : (
            <p className="exec-help">
              {t(lang, 'exec.detail.savedExecuted', { n: comparison.executed.saved ?? 0 })} · {t(lang, 'exec.source.label')}: {t(lang, executionSourceLabelKey(executionSourceOf(saved)))}
            </p>
          )}
          {comparison.hasSaved && comparison.hasDetailed && comparison.executed.difference !== null ? (
            <>
              <p className="exec-help">
                <strong>{t(lang, 'exec.detail.diffTitle')}:</strong>{' '}
                {comparison.relation === 'equal'
                  ? t(lang, 'exec.detail.diffEqual')
                  : comparison.relation === 'savedHigher'
                    ? t(lang, 'exec.detail.diffSavedHigher', { n: Math.abs(comparison.executed.difference) })
                    : t(lang, 'exec.detail.diffDetailedHigher', { n: Math.abs(comparison.executed.difference) })}
              </p>
              <p className="exec-help">{t(lang, 'exec.detail.completedNote', { n: comparison.completed.detailed ?? 0 })}</p>
              <p className="exec-help">{t(lang, 'exec.detail.diffNote')}</p>
              <p className="exec-help">{t(lang, 'exec.detail.notComparable')}</p>
            </>
          ) : null}
        </div>
      )}
    </section>
  );
}

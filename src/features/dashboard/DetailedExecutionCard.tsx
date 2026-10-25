import { useState } from 'react';
import { MetricCard } from '../../components/MetricCard';
import { t, type TranslationKey } from '../../i18n';
import { formatInteger } from '../../lib/formatting/format';
import { executionSourceLabelKey, executionSourceOf } from '../../domain/executionSource';
import type { DailyDetailedSummary, DailyExecutionComparison } from '../../domain/testManagement';
import { resolveAdoptionConfirmation, type AdoptionReason, type Reconciliation } from '../../domain/executionReconciliation';
import type { DailyExecutionEntry, Language } from '../../types';

const pct = (v: number | null): string => (v === null ? '—' : `${Math.round(v * 100)}%`);

/**
 * Detailed Case Execution of ONE date, derived from the immutable case history and shown BESIDE the saved daily aggregate. It is
 * a comparison only: nothing here writes the saved figures, switches their source or reconciles the two.
 *
 * Terminology is deliberate: "Execution Events" counts history events; "Unique Cases Executed" counts cases (the latest event of
 * the day is a case's final status). The status counts add up to the unique cases, never to the events.
 */
/** Reconciliation of the saved day with the detailed history, and the explicit, confirmed adoption of it (SV only; never automatic). */
export interface ReconciliationProps {
  reconciliation: Reconciliation;
  /** Fingerprint of what the history says NOW (stale-preview protection). */
  fingerprint: string;
  /** The entry an adoption would write right now (stamped at call time), or null when none can be built. */
  buildEntry: () => DailyExecutionEntry | null;
  onAdopt: (entry: DailyExecutionEntry) => void;
  date: string;
}

function ReconciliationBlock({ lang, recon, summary, saved }: { lang: Language; recon: ReconciliationProps; summary: DailyDetailedSummary; saved: DailyExecutionEntry | null | undefined }) {
  const r = recon.reconciliation;
  const [preview, setPreview] = useState<{ fingerprint: string } | null>(null);
  const [changed, setChanged] = useState(false);
  const refresh = r.savedSource === 'caseExecution';
  const covKey = `exec.rec.coverage.${r.coverage}` as TranslationKey;
  const stateKey = `exec.rec.state.${r.state}` as TranslationKey;
  const msgKey = (r.coverage === 'none' ? 'exec.rec.msg.none' : r.coverage === 'partial' ? 'exec.rec.msg.partial' : 'exec.rec.msg.complete') as TranslationKey;
  const blocking = r.reasons.filter((x: AdoptionReason) => x !== 'notPermitted' && x !== 'alreadyUpToDate');
  const registeredMismatch = r.coverageReasons.includes('registeredMismatch') && summary.scopeTotalCases !== null;
  const open = (): void => {
    setChanged(false);
    setPreview({ fingerprint: recon.fingerprint });
  };
  const confirm = (): void => {
    if (preview === null) return;
    const result = resolveAdoptionConfirmation({ previewFingerprint: preview.fingerprint, currentFingerprint: recon.fingerprint, currentEntry: r.canAdopt ? recon.buildEntry() : null });
    if (result.ok) {
      setPreview(null);
      recon.onAdopt(result.entry);
    } else if (result.reason === 'changed') {
      setChanged(true);
      setPreview({ fingerprint: recon.fingerprint }); // show the updated values; nothing was written
    } else {
      setPreview(null);
    }
  };
  const row = (label: string, a: number | null, b: number | null) => (
    <tr>
      <th scope="row">{label}</th>
      <td className="num">{a === null ? '—' : formatInteger(a, lang)}</td>
      <td className="num">{b === null ? '—' : formatInteger(b, lang)}</td>
    </tr>
  );
  return (
    <div className="exec-detail-recon" role="status">
      <p className="exec-help">
        <span className={`gap-pill exec-cov-${r.coverage}`}>
          {t(lang, 'exec.rec.coverage')}: {t(lang, covKey)}
        </span>{' '}
        <span className="gap-pill">
          {t(lang, 'exec.rec.state')}: {t(lang, stateKey)}
        </span>{' '}
        {r.savedSource === null ? null : (
          <span className="gap-pill">
            {t(lang, 'exec.rec.savedSource')}: {t(lang, executionSourceLabelKey(r.savedSource))}
          </span>
        )}
      </p>
      <p className="exec-help">{t(lang, msgKey)}</p>
      {r.savedSource === 'caseExecution' && r.coverage !== 'complete' ? <p className="exec-help">{t(lang, 'exec.rec.coverageLost')}</p> : null}
      {r.stale ? <p className="exec-help">{t(lang, 'exec.rec.stale')}</p> : null}
      {r.savedSource === 'caseExecution' && r.state === 'match' && r.coverage === 'complete' ? <p className="exec-help">{t(lang, 'exec.rec.upToDate')}</p> : null}
      {r.canAdopt ? (
        <p className="exec-help">
          <strong>{t(lang, 'exec.rec.eligible')}</strong>
        </p>
      ) : null}
      {!r.canAdopt && blocking.length > 0 && r.state !== 'notComparable' ? (
        <p className="exec-help">
          {registeredMismatch
            ? t(lang, 'exec.rec.cannotRegistered', { registered: summary.registeredCases, total: summary.scopeTotalCases ?? 0 })
            : t(lang, 'exec.rec.cannot', { reasons: blocking.map((x) => t(lang, `exec.rec.reason.${x}` as TranslationKey)).join(', ') })}
        </p>
      ) : null}
      {r.canAdopt && preview === null ? (
        <button type="button" className="btn" onClick={open}>
          {t(lang, refresh ? 'exec.rec.refresh' : 'exec.rec.adopt')}
        </button>
      ) : null}
      {preview !== null && r.canAdopt && r.saved !== null && r.detailed !== null ? (
        <div className="recovery-confirm" role="alertdialog" aria-label={t(lang, 'exec.rec.previewTitle')}>
          <div className="recovery-confirm-title">{t(lang, 'exec.rec.previewTitle')}</div>
          {changed ? (
            <p className="qa-warning" role="alert">
              {t(lang, 'exec.rec.changed')}
            </p>
          ) : null}
          <p className="exec-help">
            {t(lang, 'exec.rec.previewDate')}: {recon.date}
          </p>
          <table className="dr-table">
            <thead>
              <tr>
                <th />
                <th scope="col">
                  {t(lang, 'exec.rec.previewCurrent')}
                  {saved === undefined || saved === null ? '' : ` (${t(lang, executionSourceLabelKey(executionSourceOf(saved)))})`}
                </th>
                <th scope="col">
                  {t(lang, 'exec.rec.previewDetailed')} ({t(lang, 'exec.source.caseExecution')})
                </th>
              </tr>
            </thead>
            <tbody>
              {row(t(lang, 'exec.rec.f.executed'), r.saved.executed, r.detailed.executed)}
              {row(t(lang, 'tm.status.pass'), r.saved.passed, r.detailed.passed)}
              {row(t(lang, 'tm.status.fail'), r.saved.failed, r.detailed.failed)}
              {row(t(lang, 'tm.status.blocked'), r.saved.blocked, r.detailed.blocked)}
            </tbody>
          </table>
          <p className="recovery-note">{t(lang, 'exec.rec.previewNote')}</p>
          <p className="exec-help">{t(lang, 'exec.rec.mapNote')}</p>
          <div className="recovery-confirm-actions">
            <button type="button" className="btn" onClick={confirm}>
              {t(lang, 'exec.rec.confirm')}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setPreview(null)}>
              {t(lang, 'exec.rec.cancel')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function DetailedExecutionCard({ lang, summary, saved, comparison, title, recon }: { lang: Language; summary: DailyDetailedSummary; saved?: DailyExecutionEntry | null; comparison?: DailyExecutionComparison | null; title?: string; recon?: ReconciliationProps }) {
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
      {recon === undefined ? null : <ReconciliationBlock lang={lang} recon={recon} summary={summary} saved={saved} />}
    </section>
  );
}

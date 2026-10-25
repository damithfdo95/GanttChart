import { t } from '../../i18n';
import type { DailyReportDateState, PreparedDailyReportDraft } from '../../domain/dailyReportDraft';
import { MISSING_KEY, preparedDraftPreview, preparedTopicLine } from './preparedDraft';
import type { Language } from '../../types';

/**
 * The prepared-draft proposal inside the Daily Report screen. It shows exactly what would go into the report, and writes nothing
 * itself: the supervisor creates the draft (or keeps an existing one) with an explicit click. A finalized report is only described -
 * it is a snapshot and is never regenerated here.
 */
export function PreparedDraftPanel({
  lang,
  date,
  prepared,
  state,
  onApply,
  onStartEmpty,
  onRegenerate,
}: {
  lang: Language;
  date: string;
  prepared: PreparedDailyReportDraft;
  state: DailyReportDateState;
  onApply: () => void;
  onStartEmpty: () => void;
  onRegenerate: () => void;
}) {
  const preview = preparedDraftPreview(lang, prepared);
  return (
    <section className="dr-section prepared-draft" aria-label={t(lang, 'dailyReport.prepare.title', { date })}>
      <h2>{t(lang, 'dailyReport.prepare.title', { date })}</h2>
      {state === 'finalized' ? <p className="exec-help">{t(lang, 'dailyReport.prepare.finalizedNote')}</p> : null}
      {state === 'draft' ? <p className="exec-help">{t(lang, 'dailyReport.prepare.draftNote')}</p> : null}
      {state === 'none' ? <p className="exec-help">{t(lang, 'dailyReport.prepare.note')}</p> : null}
      {prepared.isHistorical ? <p className="qa-warning" role="note">{t(lang, 'dailyReport.prepare.historical')}</p> : null}
      {state === 'finalized' ? null : (
        <>
          <h3>{t(lang, 'dailyReport.prepare.staffing')}</h3>
          <p>{preview.staffing === '' ? t(lang, MISSING_KEY.noStaffing) : preview.staffing}</p>
          <h3>{t(lang, 'dailyReport.prepare.activities')}</h3>
          {preview.activities === '' ? <p className="exec-help">{t(lang, MISSING_KEY.noActivity)}</p> : <pre className="dr-progress-preview">{preview.activities}</pre>}
          <h3>{t(lang, 'dailyReport.prepare.topics')}</h3>
          {preview.topics.length === 0 ? (
            <p className="exec-help">{t(lang, MISSING_KEY.noTopics)}</p>
          ) : (
            <ul>
              {prepared.topics.map((topic) => (
                <li key={`${topic.projectId}-${topic.code}`}>{preparedTopicLine(lang, topic)}</li>
              ))}
            </ul>
          )}
          {prepared.currentContext.length > 0 ? (
            <>
              <h3>{t(lang, 'dailyReport.prepare.currentContext')}</h3>
              <ul className="exec-help">
                {prepared.currentContext.map((a) => (
                  <li key={`${a.projectId}-${a.reasonCode}`}>
                    {preparedTopicLine(lang, { projectId: a.projectId, projectName: a.projectName, severity: a.severity === 'blocking' ? 'blocking' : 'warning', scope: 'current', code: a.reasonCode, source: { kind: 'readiness', reason: a.reason } })}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      )}
      <div className="dr-button-row">
        {state === 'none' ? (
          <>
            <button type="button" className="btn btn-primary" onClick={onApply}>
              {t(lang, 'dailyReport.prepare.apply')}
            </button>
            <button type="button" className="btn btn-ghost" onClick={onStartEmpty}>
              {t(lang, 'dailyReport.prepare.empty')}
            </button>
          </>
        ) : null}
        {state === 'draft' ? (
          <button type="button" className="btn" onClick={onRegenerate}>
            {t(lang, 'dailyReport.prepare.regenerate')}
          </button>
        ) : null}
      </div>
    </section>
  );
}

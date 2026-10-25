import { t, type TranslationKey } from '../../i18n';
import type { CaseExecutionEvent } from '../../domain/testManagement';
import type { Language } from '../../types';

/** "Oct 25, 10:15" / "10月25日 10:15" - the time the execution itself happened. */
export function eventTimeText(lang: Language, iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * The execution history of ONE case, newest first (the caller passes the case's events already ordered): when, what status, who,
 * through which source, and the ticket / memo recorded with it. Read-only - history is never edited from here.
 */
export function CaseHistoryList({ lang, events, actorLabel }: { lang: Language; events: readonly CaseExecutionEvent[]; actorLabel: (e: CaseExecutionEvent) => string }) {
  if (events.length === 0) return <p className="link-help">{t(lang, 'tm.history.empty')}</p>;
  const oldest = events[events.length - 1];
  return (
    <div className="tm-case-history">
      <ol className="tm-history-list" aria-label={t(lang, 'tm.history.title')}>
        {events.map((e) => (
          <li key={e.id} className="tm-history-item">
            <span className="tm-history-time">{eventTimeText(lang, e.executedAt)}</span>
            <span className={`tm-history-status tm-status-${e.status}`}>{t(lang, `tm.status.${e.status}` as TranslationKey)}</span>
            {e.retest === true ? <span className="tag">{t(lang, 'tm.col.retest')}</span> : null}
            <span className="tm-history-actor">{actorLabel(e)}</span>
            <span className="tm-history-source">{t(lang, e.source === 'testrail' ? 'tm.history.sourceTestrail' : 'tm.history.sourceManual')}</span>
            {e.ticketRef === undefined ? null : <span className="tm-history-ticket">{e.ticketRef}</span>}
            {e.memo === undefined ? null : <span className="tm-history-memo">{e.memo}</span>}
          </li>
        ))}
      </ol>
      {oldest === undefined ? null : <p className="link-help">{t(lang, 'tm.history.since', { date: eventTimeText(lang, oldest.executedAt) })}</p>}
    </div>
  );
}

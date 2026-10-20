import { useState } from 'react';
import { useAppStateCtx } from '../app/state-contexts';
import { JIRA_JQL_PLACEHOLDER } from '../lib/jira/jql';
import { useJiraSearch } from '../lib/jira/useJiraSearch';
import { JiraErrorHint } from './JiraErrorHint';
import { t } from '../i18n';
import type { Language } from '../types';
import type { JiraIssue } from '../../shared/jira';
import { BLOCKING_CATEGORIES, type BlockingCategory, type BlockingEvent } from '../types';
import { editableNoteText, jiraIssuesToBlockingEvents, mergeBlockingEvents, withNoteText } from '../domain/blocking/jiraBlockers';
import { BLOCKING_CAT_KEY } from '../lib/statusKeys';

/** The unavailable minutes each imported event starts with (editable per row afterwards). */
const DEFAULT_MINUTES = 30;

interface JiraBlockingImportProps {
  lang: Language;
  /** The date new events default to — the panel's "today" semantics, so imports land where the panel is looking. */
  defaultDate: string;
  onClose: () => void;
  /** Called after Apply with (events added, duplicates skipped, from `mergeBlockingEvents`). */
  onApply: (imported: number, skipped: number) => void;
}

/**
 * "Import from JIRA" for the Dashboard blocking panel (SV view): JQL → fetch
 * → editable preview of derived blocking events (one per issue, date =
 * today, category guessed, minutes 30). Apply merges into the existing
 * events with `mergeBlockingEvents`, so a re-import of the same JIRA key on
 * the same date with the same category is skipped — count feedback shows it.
 */
export function JiraBlockingImport({ lang, defaultDate, onClose, onApply }: JiraBlockingImportProps) {
  const { state, updateField } = useAppStateCtx();
  const { loading, error, search } = useJiraSearch();
  const [jql, setJql] = useState(JIRA_JQL_PLACEHOLDER);
  const [draft, setDraft] = useState<BlockingEvent[] | null>(null);
  const [minutes, setMinutes] = useState(DEFAULT_MINUTES);
  const [applying, setApplying] = useState(false);

  const fetchEvents = async (): Promise<void> => {
    const q = jql.trim();
    if (q === '') return;
    setDraft(null);
    try {
      const found: JiraIssue[] = await search(q);
      setDraft(found.length === 0 ? [] : jiraIssuesToBlockingEvents(found, defaultDate, { minutes }));
    } catch {
      // The typed failure is exposed by the hook in `error`; the hint below renders it.
    }
  };

  const updateDraft = (index: number, patch: Partial<BlockingEvent>): void => {
    setDraft((d) => (d === null ? d : d.map((e, i) => (i === index ? { ...e, ...patch } : e))));
  };

  const removeDraft = (index: number): void => {
    setDraft((d) => (d === null ? d : d.filter((_, i) => i !== index)));
  };

  const applyEvents = (): void => {
    if (draft === null || draft.length === 0 || applying) return;
    setApplying(true);
    const existing = state.blockingEvents ?? [];
    const { merged, skipped } = mergeBlockingEvents(existing, draft);
    updateField('blockingEvents', merged);
    setApplying(false);
    onApply(merged.length - existing.length, skipped.length);
    onClose();
  };

  return (
    <div className="tenancy-form">
      <h3>{t(lang, 'jira.import.blocking.title')}</h3>
      <p className="link-help">{t(lang, 'jira.import.blocking.help', { date: defaultDate })}</p>
      <label className="link-confirm">
        {t(lang, 'jira.import.jql')}
        <input
          className="input"
          value={jql}
          aria-label={t(lang, 'jira.import.jql')}
          onChange={(e) => {
            setJql(e.target.value);
            setDraft(null);
          }}
        />
      </label>
      <label className="link-confirm">
        {t(lang, 'jira.import.blocking.minutesEach')}
        <input
          className="input input-cell"
          type="number"
          min={1}
          step={5}
          value={minutes}
          onChange={(e) => {
            setMinutes(Math.max(1, Math.floor(Number(e.target.value)) || 1));
            setDraft(null);
          }}
        />
      </label>
      <div className="dr-button-row">
        <button type="button" className="btn" disabled={jql.trim() === '' || loading || applying} onClick={() => void fetchEvents()}>
          {loading ? t(lang, 'jira.import.fetching') : t(lang, 'jira.import.fetch')}
        </button>
        <button type="button" className="btn btn-primary" disabled={applying || draft === null || draft.length === 0} onClick={applyEvents}>
          {applying ? t(lang, 'jira.import.blocking.applying') : t(lang, 'jira.import.blocking.apply', { count: draft?.length ?? 0 })}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          {t(lang, 'tenancy.cancel')}
        </button>
      </div>
      {error !== null ? <JiraErrorHint lang={lang} error={error} notConfiguredMessage="jira.import.notConfigured" /> : null}
      {draft === null ? null : draft.length === 0 ? (
        <p className="tenancy-empty" role="status">
          {t(lang, 'jira.import.empty')}
        </p>
      ) : (
        <div className="table-wrap">
          <p role="status">{t(lang, 'jira.import.blocking.rows', { count: draft.length, date: defaultDate })}</p>
          <table className="dr-table blocking-table">
            <thead>
              <tr>
                <th scope="col">{t(lang, 'columns.date')}</th>
                <th scope="col">{t(lang, 'blocking.category')}</th>
                <th scope="col" className="num">
                  {t(lang, 'blocking.minutes')}
                </th>
                <th scope="col">{t(lang, 'blocking.note')}</th>
                <th scope="col">
                  <span className="sr-only">{t(lang, 'columns.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {draft.map((event, i) => (
                <tr key={event.id}>
                  <td>
                    <input
                      className="input input-date"
                      type="date"
                      aria-label={t(lang, 'columns.date')}
                      value={event.date}
                      onChange={(e) => updateDraft(i, { date: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      className="input"
                      aria-label={t(lang, 'blocking.category')}
                      value={event.category}
                      onChange={(e) => updateDraft(i, { category: e.target.value as BlockingCategory })}
                    >
                      {BLOCKING_CATEGORIES.map((category) => (
                        <option key={category} value={category}>
                          {t(lang, BLOCKING_CAT_KEY[category])}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="num">
                    <input
                      className="input input-cell"
                      type="number"
                      min={1}
                      step={5}
                      aria-label={t(lang, 'blocking.minutes')}
                      value={event.minutes}
                      onChange={(e) => updateDraft(i, { minutes: Math.max(1, Number(e.target.value) || 0) })}
                    />
                  </td>
                  <td>
                    <span className="dr-summary">{event.note.match(/^\[JIRA [^\]]+\]/)?.[0]} </span>
                    <input
                      className="input"
                      aria-label={t(lang, 'blocking.note')}
                      value={editableNoteText(event.note)}
                      onChange={(e) => updateDraft(i, { note: withNoteText(event.note, e.target.value) })}
                    />
                  </td>
                  <td>
                    <button type="button" className="btn btn-ghost" onClick={() => removeDraft(i)}>
                      {t(lang, 'buttons.remove')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
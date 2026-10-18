import { useMemo, useState } from 'react';
import { useJiraSearch } from '../../lib/jira/useJiraSearch';
import { JIRA_JQL_PLACEHOLDER } from '../../lib/jira/jql';
import { JiraErrorHint } from '../../components/JiraErrorHint';
import { t, type TranslationKey } from '../../i18n';
import { dictionaries } from '../../i18n/dictionaries';
import type { Language } from '../../types';
import type { JiraIssue } from '../../../shared/jira';
import { buildBulkCases } from '../../domain/testManagement';
import type { TestScope } from '../../domain/testManagement';
import { existingJiraImportKeys, planJiraCaseImport, type JiraCaseImportPlan, type JiraCaseSkipReason } from './jiraImportUi';
import type { useTestManagement } from './useTestManagement';

const SKIP_BADGE_KEY: Record<JiraCaseSkipReason, TranslationKey> = {
  duplicate: 'jira.import.duplicateLabel',
  noTitle: 'jira.import.noTitle',
};

interface JiraImportDialogProps {
  lang: Language;
  /** The target scope — the one selected in the Cases tab, exactly like Bulk Add. */
  scope: TestScope;
  /** Test-management API: the project's cases (for duplicate detection) and the one-update commit path. */
  tm: ReturnType<typeof useTestManagement>;
  onClose: () => void;
  /** Called after a successful commit with what happened (imported / duplicates skipped / no-title skipped). */
  onDone: (imported: number, duplicates: number, invalid: number) => void;
}

/**
 * "Import from JIRA" for Test Management (SV screen): JQL → fetch → preview
 * the would-be Test Cases (mirroring the Bulk Add dialog: same scope, same
 * `buildBulkCases` commit path, one functional update). Duplicate JIRA keys
 * and issues without a title are shown in the preview but never committed.
 */
export function JiraImportDialog({ lang, scope, tm, onClose, onDone }: JiraImportDialogProps) {
  const { loading, error, search } = useJiraSearch();
  const [jql, setJql] = useState(JIRA_JQL_PLACEHOLDER);
  const [issues, setIssues] = useState<JiraIssue[] | null>(null);
  const [plan, setPlan] = useState<JiraCaseImportPlan | null>(null);
  const [committing, setCommitting] = useState(false);
  const [failKey, setFailKey] = useState<TranslationKey | null>(null);

  const existingKeys = useMemo(() => existingJiraImportKeys(tm.testCases, scope.projectId), [tm.testCases, scope.projectId]);

  const fetchIssues = async (): Promise<void> => {
    const q = jql.trim();
    if (q === '') return;
    setFailKey(null);
    setIssues(null);
    setPlan(null);
    try {
      const found = await search(q);
      setIssues(found);
      if (found.length > 0) setPlan(planJiraCaseImport(found, existingKeys, scope.code ?? ''));
    } catch {
      // The typed failure is exposed by the hook in `error`; the hint below renders it.
    }
  };

  const confirmImport = (): void => {
    if (plan === null || plan.commitRows.length === 0 || committing) return;
    setFailKey(null);
    setCommitting(true);
    const now = new Date().toISOString();
    let failed: string | null = null;
    let imported = 0;
    tm.update((state) => {
      const built = buildBulkCases(state, scope.id, plan.commitRows, now);
      if (!built.ok) {
        failed = built.error;
        return state;
      }
      imported = built.value.length;
      return { ...state, testCases: [...state.testCases, ...built.value] };
    });
    setCommitting(false);
    if (failed !== null) {
      const key = `tm.error.${failed}` as TranslationKey;
      setFailKey(key in dictionaries.en ? key : 'tm.error.generic');
    } else {
      onDone(imported, plan.duplicateCount, plan.invalidCount);
      onClose();
    }
  };

  const skippedCount = plan === null ? 0 : plan.duplicateCount + plan.invalidCount;

  return (
    <div className="tenancy-form tm-bulk">
      <h3>{t(lang, 'jira.import.title')}</h3>
      <p className="link-help">{t(lang, 'jira.import.help')}</p>
      <label className="link-confirm">
        {t(lang, 'jira.import.jql')}
        <input
          className="input"
          value={jql}
          aria-label={t(lang, 'jira.import.jql')}
          onChange={(e) => {
            setJql(e.target.value);
            setPlan(null);
            setIssues(null);
            setFailKey(null);
          }}
        />
      </label>
      <p className="link-help">{t(lang, 'jira.import.jqlHelp')}</p>
      <p className="link-help">{t(lang, 'jira.import.scope', { scope: scope.name })}</p>
      <div className="dr-button-row">
        <button type="button" className="btn" disabled={jql.trim() === '' || loading || committing} onClick={() => void fetchIssues()}>
          {loading ? t(lang, 'jira.import.fetching') : t(lang, 'jira.import.fetch')}
        </button>
        <button type="button" className="btn btn-primary" disabled={committing || plan === null || plan.commitRows.length === 0} onClick={confirmImport}>
          {committing ? t(lang, 'jira.import.committing') : t(lang, 'jira.import.confirm', { count: plan?.commitRows.length ?? 0 })}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          {t(lang, 'tenancy.cancel')}
        </button>
      </div>
      {error !== null ? <JiraErrorHint lang={lang} error={error} notConfiguredMessage="jira.import.notConfigured" /> : null}
      {failKey !== null ? (
        <p className="data-controls-message error" role="alert">
          {t(lang, failKey)}
        </p>
      ) : null}
      {issues === null ? null : issues.length === 0 ? (
        <p className="tenancy-empty" role="status">
          {t(lang, 'jira.import.empty')}
        </p>
      ) : plan === null ? null : (
        <div className="tenancy-table-wrap">
          <p role="status">
            {t(lang, 'jira.import.found', { count: issues.length })}
            {skippedCount > 0 ? ` ${t(lang, 'jira.import.counts', { duplicates: plan.duplicateCount, invalid: plan.invalidCount })}` : ''}
          </p>
          <table className="tenancy-table">
            <thead>
              <tr>
                <th scope="col">{t(lang, 'tm.field.key')}</th>
                <th scope="col">{t(lang, 'jira.import.colJiraKey')}</th>
                <th scope="col">{t(lang, 'jira.import.colTitle')}</th>
                <th scope="col">
                  <span className="sr-only">{t(lang, 'jira.import.colState')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {plan.rows.map((row, i) => (
                <tr key={`${row.issue.key}-${i}`}>
                  <td>{row.importable ? row.key : '—'}</td>
                  <td>{row.issue.key}</td>
                  <td>{row.title}</td>
                  <td>
                    {row.importable || row.skipReason === null ? null : (
                      <span className="tm-warning" role="status">
                        {t(lang, SKIP_BADGE_KEY[row.skipReason])}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {plan.commitRows.length === 0 ? (
            <p className="qa-warning" role="status">
              {t(lang, 'jira.import.noneImportable')}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
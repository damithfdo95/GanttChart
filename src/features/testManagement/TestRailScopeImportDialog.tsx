import { useMemo, useState } from 'react';
import { useReportsStateCtx } from '../../app/state-contexts';
import { newScope, planImportRows, type TestManagementState, type TestRailScopeImportPlan } from '../../domain/testManagement';
import { createTestRailClient } from '../../lib/testrail/client';
import { parseTestRailUrl } from '../../domain/testrail';
import { passedPct } from '../../../shared/testrail';
import { TestRailErrorHint } from '../../components/TestRailErrorHint';
import type { TestRailClientError } from '../../../shared/testrail';
import { t, type TranslationKey } from '../../i18n';
import { dictionaries } from '../../i18n/dictionaries';
import type { Language, ProjectRecord } from '../../types';
import type { useTestManagement } from './useTestManagement';

interface TestRailScopeImportDialogProps {
  lang: Language;
  project: ProjectRecord;
  /** Test-management API: the existing scopes (for duplicate detection) and the one-update commit path. */
  tm: ReturnType<typeof useTestManagement>;
  onClose: () => void;
  /** Called after a successful commit with what happened (imported / duplicates skipped). */
  onDone: (imported: number, duplicates: number) => void;
}

/**
 * "Import from TestRail" for Test Management (SV screen): plan URL → fetch the
 * plan's runs with the device-local TestRail connection → preview each run
 * with its current counts, an editable default scope name and a checkbox
 * (default unchecked) → confirm creates ONE scope per selected run through the
 * existing `newScope` commit path, with Total Test Cases = the run's total and
 * `testrail: { planId, runId }` on the scope (the shared link). Runs already
 * linked by a scope of this project are visibly skipped, never duplicated.
 */
export function TestRailScopeImportDialog({ lang, project, tm, onClose, onDone }: TestRailScopeImportDialogProps) {
  const reports = useReportsStateCtx();
  const conn = reports.state.settings.testrail;
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<TestRailClientError | null>(null);
  const [urlError, setUrlError] = useState(false);
  const [planId, setPlanId] = useState<number | null>(null);
  const [plan, setPlan] = useState<TestRailScopeImportPlan | null>(null);
  const [names, setNames] = useState<Record<number, string>>({});
  const [selected, setSelected] = useState<Record<number, boolean>>({});
  const [committing, setCommitting] = useState(false);
  const [failKey, setFailKey] = useState<TranslationKey | null>(null);

  // Duplicate detection is per project: a run already linked by ANY scope of
  // THIS project is skipped; links in other projects never block.
  const scopesOfProject = useMemo(() => tm.scopes.filter((s) => s.projectId === project.projectId), [tm.scopes, project.projectId]);

  const nameOf = (runId: number, fallback: string): string => names[runId] ?? fallback;

  const fetchRuns = async (): Promise<void> => {
    const link = parseTestRailUrl(url);
    // Plan URLs only: runs have no entries of their own to import.
    if (link === null || link.kind !== 'plan') {
      setUrlError(true);
      setError(null);
      setPlan(null);
      setPlanId(null);
      return;
    }
    if (conn === undefined) {
      setError({ kind: 'notConfigured', message: 'TestRail is not configured (no connection in Settings).' });
      return;
    }
    setUrlError(false);
    setError(null);
    setPlan(null);
    setPlanId(null);
    setLoading(true);
    try {
      const client = createTestRailClient(conn);
      const runs = await client.getPlanRuns(link.id);
      setPlanId(link.id);
      setPlan(planImportRows(runs, scopesOfProject, project.projectId));
      setNames({});
      setSelected({});
    } catch (e) {
      // The typed failure is exposed in `error`; the hint below renders it.
      if ((e as TestRailClientError).kind === undefined) throw e;
      setError(e as TestRailClientError);
    } finally {
      setLoading(false);
    }
  };

  const confirmImport = (): void => {
    if (plan === null || planId === null || committing) return;
    // Only importable rows can be ticked; skipped/duplicate runs never commit.
    const rows = plan.rows.filter((r) => r.importable && selected[r.run.id] === true);
    if (rows.length === 0) return;
    setFailKey(null);
    setCommitting(true);
    const now = new Date().toISOString();
    let failed: string | null = null;
    let imported = 0;
    tm.update((state: TestManagementState) => {
      // Accumulate so each new scope sees the previous one's order (one scope
      // per run, never the same order twice); on any failure NOTHING writes.
      let acc = state;
      for (const row of rows) {
        const made = newScope(acc, {
          projectId: project.projectId,
          name: nameOf(row.run.id, row.name),
          totalTestCases: row.totalTestCases,
          testrail: { planId: row.run.planId ?? planId, runId: row.run.id },
        }, now);
        if (!made.ok) {
          failed = made.error;
          return state;
        }
        acc = { ...acc, scopes: [...acc.scopes, made.value] };
      }
      imported = rows.length;
      return acc;
    });
    setCommitting(false);
    if (failed !== null) {
      const key = `tm.error.${failed}` as TranslationKey;
      setFailKey(key in dictionaries.en ? key : 'tm.error.generic');
    } else {
      onDone(imported, plan.duplicateCount);
      onClose();
    }
  };

  const selectedCount = plan === null ? 0 : plan.rows.filter((r) => r.importable && selected[r.run.id] === true).length;

  return (
    <div className="tenancy-form tm-bulk">
      <h3>{t(lang, 'tm.testrailImport.title')}</h3>
      <p className="link-help">{t(lang, 'tm.testrailImport.help')}</p>
      <label className="link-confirm">
        {t(lang, 'tm.testrailImport.planUrl')}
        <input
          className="input"
          value={url}
          aria-label={t(lang, 'tm.testrailImport.planUrl')}
          placeholder={t(lang, 'tm.testrailImport.planUrlPlaceholder')}
          onChange={(e) => {
            setUrl(e.target.value);
            setPlan(null);
            setPlanId(null);
            setError(null);
            setUrlError(false);
          }}
        />
      </label>
      <p className="link-help">{t(lang, 'tm.testrailImport.planUrlHelp')}</p>
      <div className="dr-button-row">
        <button type="button" className="btn" disabled={url.trim() === '' || loading || committing} onClick={() => void fetchRuns()}>
          {loading ? t(lang, 'tm.testrailImport.fetching') : t(lang, 'tm.testrailImport.fetch')}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={committing || plan === null || selectedCount === 0}
          onClick={confirmImport}
        >
          {committing ? t(lang, 'tm.testrailImport.committing') : t(lang, 'tm.testrailImport.confirm', { count: selectedCount })}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          {t(lang, 'tenancy.cancel')}
        </button>
      </div>
      {urlError ? (
        <p className="qa-warning" role="alert">
          <strong>{t(lang, 'tm.testrailImport.invalidPlanUrl')}</strong>
        </p>
      ) : null}
      {error !== null ? <TestRailErrorHint lang={lang} error={error} notConfiguredMessage="tm.testrailImport.notConfigured" /> : null}
      {failKey !== null ? (
        <p className="data-controls-message error" role="alert">
          {t(lang, failKey)}
        </p>
      ) : null}
      {plan === null ? null : plan.rows.length === 0 ? (
        <p className="tenancy-empty" role="status">
          {t(lang, 'tm.testrailImport.empty')}
        </p>
      ) : (
        <div className="tenancy-table-wrap">
          <p role="status">
            {t(lang, 'tm.testrailImport.found', { count: plan.rows.length })}
            {plan.duplicateCount > 0 ? ` ${t(lang, 'tm.testrailImport.duplicatesSkipped', { count: plan.duplicateCount })}` : ''}
          </p>
          <p className="link-help">{t(lang, 'tm.testrailImport.selectHelp')}</p>
          <table className="tenancy-table">
            <thead>
              <tr>
                <th scope="col">
                  <span className="sr-only">{t(lang, 'tm.testrailImport.colAdd')}</span>
                </th>
                <th scope="col">{t(lang, 'tm.testrailImport.colRun')}</th>
                <th scope="col">{t(lang, 'tm.testrailImport.colConfig')}</th>
                <th scope="col">{t(lang, 'tm.testrailImport.colCounts')}</th>
                <th scope="col">{t(lang, 'tm.testrailImport.colName')}</th>
                <th scope="col">
                  <span className="sr-only">{t(lang, 'jira.import.colState')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {plan.rows.map((row, i) => (
                // A run id can legitimately appear twice when one plan repeats an entry —
                // index the key so React never sees duplicates.
                <tr key={`${row.run.id}-${i}`} className={row.importable ? undefined : 'tm-archived'}>
                  <td>
                    {row.importable ? (
                      <input
                        type="checkbox"
                        aria-label={t(lang, 'tm.testrailImport.colAdd')}
                        checked={selected[row.run.id] === true}
                        onChange={(e) => setSelected((s) => ({ ...s, [row.run.id]: e.target.checked }))}
                      />
                    ) : null}
                  </td>
                  <td>
                    <strong>{row.name}</strong> <span className="link-help">#{row.run.id}</span>
                  </td>
                  <td>{row.run.config ?? '—'}</td>
                  <td>
                    {row.run.progress === undefined ? (
                      '—'
                    ) : (
                      <span className="link-help">
                        {t(lang, 'tm.testrailProgress.line', { passed: row.run.progress.passed, blocked: row.run.progress.blocked, retest: row.run.progress.retest, failed: row.run.progress.failed, untested: row.run.progress.untested, pct: Math.round(passedPct(row.run.progress) * 100) })}
                      </span>
                    )}
                  </td>
                  <td>
                    {row.importable ? (
                      <input
                        className="input"
                        value={nameOf(row.run.id, row.name)}
                        maxLength={80}
                        aria-label={`${t(lang, 'tm.testrailImport.colName')}: ${row.name}`}
                        onChange={(e) => setNames((n) => ({ ...n, [row.run.id]: e.target.value }))}
                      />
                    ) : (
                      row.name
                    )}
                  </td>
                  <td>
                    {row.importable || row.skipReason === null ? null : (
                      <span className="tm-warning" role="status">
                        {t(lang, 'tm.testrailImport.duplicateLabel')}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {plan.importableCount === 0 ? (
            <p className="qa-warning" role="status">
              {t(lang, 'tm.testrailImport.noneSelectable')}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
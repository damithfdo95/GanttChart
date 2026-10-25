import { useMemo, useState } from 'react';
import { useReportsStateCtx } from '../../app/state-contexts';
import { createTestRailClient } from '../../lib/testrail/client';
import { t, type TranslationKey } from '../../i18n';
import { dictionaries } from '../../i18n/dictionaries';
import { newTestCase, type TestManagementState } from '../../domain/testManagement';
import { planTestRailCaseImport, type TestRailCaseImportPlan } from '../../domain/testManagement/testrailCases';
import type { TestScope } from '../../domain/testManagement';
import type { Language } from '../../types';
import type { useTestManagement } from './useTestManagement';

interface TestRailCaseImportDialogProps {
  lang: Language;
  /** The target scope — the one selected in the Cases tab; must carry a TestRail run link. */
  scope: TestScope;
  /** Test-management API: the project's cases (for duplicate detection) and the one-update commit path. */
  tm: ReturnType<typeof useTestManagement>;
  onClose: () => void;
  /** Called after a successful commit with what happened (imported / duplicates skipped / no-title skipped). */
  onDone: (imported: number, duplicates: number, invalid: number) => void;
}

/**
 * "Import from TestRail" for the Cases tab (SV screen): the linked run's
 * suite cases (get_cases) → preview the would-be Test Cases (mirroring the
 * JIRA import dialog: same scope, same `newTestCase` commit path, one
 * functional update). Cases whose TestRail id is already linked and cases
 * without a title are shown in the preview but never committed.
 */
export function TestRailCaseImportDialog({ lang, scope, tm, onClose, onDone }: TestRailCaseImportDialogProps) {
  const reports = useReportsStateCtx();
  const conn = reports.state.settings.testrail;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<TranslationKey | null>(null);
  const [clientError, setClientError] = useState<{ kind: string; message: string } | null>(null);
  const [plan, setPlan] = useState<TestRailCaseImportPlan | null>(null);
  const [committing, setCommitting] = useState(false);
  const [failKey, setFailKey] = useState<TranslationKey | null>(null);

  const link = scope.testrail;

  const existingCases = useMemo(() => tm.testCases, [tm.testCases]);

  const fetchCases = async (): Promise<void> => {
    if (conn === undefined) {
      setError('tm.testrailCases.notConfigured');
      return;
    }
    if (link === undefined) {
      setError('tm.testrailCases.noLink');
      return;
    }
    setError(null);
    setClientError(null);
    setPlan(null);
    setFailKey(null);
    setLoading(true);
    try {
      const client = createTestRailClient(conn);
      // The run carries its suite id; the suite's cases are the import source.
      const run = await client.getRun(link.runId);
      if (run.suiteId === undefined) {
        setError('tm.testrailCases.noSuite');
        return;
      }
      const cases = await client.getCasesForRun({ suiteId: run.suiteId, ...(run.projectId === undefined ? {} : { projectId: run.projectId }) });
      if (cases.length === 0) {
        setError('tm.testrailCases.empty');
        return;
      }
      setPlan(planTestRailCaseImport(cases, existingCases, scope.projectId, scope.code ?? ''));
    } catch (e) {
      const err = e as { kind?: string; message?: string };
      if (err.kind === undefined) throw e;
      setClientError({ kind: err.kind, message: err.message ?? '' });
    } finally {
      setLoading(false);
    }
  };

  const confirmImport = (): void => {
    if (plan === null || plan.commitRows.length === 0 || committing) return;
    setFailKey(null);
    setCommitting(true);
    const now = new Date().toISOString();
    let failed: string | null = null;
    let imported = 0;
    tm.update((state: TestManagementState) => {
      // Accumulate so each new case sees the previous one's order; on any
      // failure NOTHING writes (the same all-or-nothing rule as bulk add).
      let acc = state;
      const baseOrder = state.testCases.filter((c) => c.scopeId === scope.id).reduce((m, c) => Math.max(m, c.order), 0);
      for (const [i, row] of plan.commitRows.entries()) {
        const made = newTestCase(acc, scope.id, { title: row.title, priority: row.priority, ...(row.type === undefined ? {} : { type: row.type }), testrailCaseId: row.testrailCaseId }, now, {
          reservedKeys: acc.testCases.filter((c) => c.projectId === scope.projectId).map((c) => c.key),
          order: baseOrder + (i + 1) * 10,
        });
        if (!made.ok) {
          failed = made.error;
          return state;
        }
        acc = { ...acc, testCases: [...acc.testCases, made.value] };
      }
      imported = plan.commitRows.length;
      return acc;
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

  return (
    <div className="tenancy-form tm-bulk">
      <h3>{t(lang, 'tm.testrailCases.title')}</h3>
      <p className="link-help">{t(lang, 'tm.testrailCases.help')}</p>
      <p className="link-help">{t(lang, 'tm.testrailCases.scope', { scope: scope.name })}</p>
      <div className="dr-button-row">
        <button type="button" className="btn" disabled={loading || committing || conn === undefined} onClick={() => void fetchCases()}>
          {loading ? t(lang, 'tm.testrailCases.fetching') : t(lang, 'tm.testrailCases.fetch')}
        </button>
        <button type="button" className="btn btn-primary" disabled={committing || plan === null || plan.commitRows.length === 0} onClick={confirmImport}>
          {committing ? t(lang, 'tm.testrailCases.committing') : t(lang, 'tm.testrailCases.confirm', { count: plan?.commitRows.length ?? 0 })}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          {t(lang, 'tenancy.cancel')}
        </button>
      </div>
      {error !== null ? (
        <p className="qa-warning" role="alert">
          <strong>{t(lang, error)}</strong>
        </p>
      ) : null}
      {clientError !== null ? (
        <p className="qa-warning" role="alert">
          <strong>{t(lang, `testrail.error.${clientError.kind}` as TranslationKey)}</strong>
          {clientError.message === '' ? '' : ` — ${clientError.message}`}
        </p>
      ) : null}
      {failKey !== null ? (
        <p className="data-controls-message error" role="alert">
          {t(lang, failKey)}
        </p>
      ) : null}
      {plan === null ? null : (
        <div className="tenancy-table-wrap">
          <p role="status">
            {t(lang, 'tm.testrailCases.found', { count: plan.rows.length })}
            {plan.duplicateCount + plan.invalidCount > 0
              ? ` ${t(lang, 'tm.testrailCases.counts', { duplicates: plan.duplicateCount, invalid: plan.invalidCount })}`
              : ''}
          </p>
          <table className="tenancy-table">
            <thead>
              <tr>
                <th scope="col">{t(lang, 'tm.testrailCases.colCaseId')}</th>
                <th scope="col">{t(lang, 'tm.field.key')}</th>
                <th scope="col">{t(lang, 'tm.col.title')}</th>
                <th scope="col">{t(lang, 'tm.col.priority')}</th>
                <th scope="col">{t(lang, 'tm.field.type')}</th>
                <th scope="col">
                  <span className="sr-only">{t(lang, 'jira.import.colState')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {plan.rows.slice(0, 50).map((row) => (
                <tr key={row.case.caseId} className={row.importable ? undefined : 'tm-archived'}>
                  <td>#{row.case.caseId}</td>
                  <td>{row.key ?? '—'}</td>
                  <td>{row.title === '' ? t(lang, 'jira.import.noTitle') : row.title}</td>
                  <td>{row.case.priorityName ?? '—'}</td>
                  <td>{row.case.typeName ?? '—'}</td>
                  <td>
                    {row.importable ? null : (
                      <span className="tm-warning" role="status">
                        {t(lang, row.skipReason === 'duplicate' ? 'jira.import.duplicateLabel' : 'jira.import.noTitle')}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {plan.rows.length > 50 ? <p className="link-help">{t(lang, 'tm.bulk.more', { count: plan.rows.length - 50 })}</p> : null}
          {plan.commitRows.length === 0 ? (
            <p className="qa-warning" role="status">
              {t(lang, 'tm.testrailCases.noneImportable')}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

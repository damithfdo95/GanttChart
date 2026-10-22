/**
 * Test Management → Execution tab (SV): scope filter + the execution results
 * table. Extracted from TestManagementScreen.tsx.
 *
 * The TestRail sync (Stage: TestRail result sync) fetches the linked runs'
 * tests + results and maps them onto the registered cases (matched by
 * testrailCaseId) as a PREVIEW — the SV confirms before any result is
 * written, and only cases whose status would change are touched.
 */

import { useMemo, useState } from 'react';
import { useReportsStateCtx } from '../../app/state-contexts';
import { t } from '../../i18n';
import { userLabel } from '../../domain/people';
import { sortScopes, summarize } from '../../domain/testManagement';
import { planTestRailResultSync, type TestRailSyncPlan } from '../../domain/testManagement/testrailResults';
import { createTestRailClient } from '../../lib/testrail/client';
import { TestRailErrorHint } from '../../components/TestRailErrorHint';
import { ExecutionTable } from './ExecutionTable';
import { SummaryBlock } from './SummaryParts';
import { useTestManagement } from './useTestManagement';
import { useDirectory } from './OverviewTab';
import type { Language, ProjectRecord } from '../../types';
import type { TestRailClientError } from '../../../shared/testrail';

export function ExecutionTab({ lang, project }: { lang: Language; project: ProjectRecord }) {
  const tm = useTestManagement();
  const reports = useReportsStateCtx();
  const conn = reports.state.settings.testrail;
  const { directory } = useDirectory();
  const scopes = useMemo(() => sortScopes(tm.scopes.filter((s) => s.projectId === project.projectId)), [tm.scopes, project.projectId]);
  const [scopeId, setScopeId] = useState('all');
  const active = scopes.filter((s) => s.status === 'active');
  const chosen = scopeId === 'all' ? active : scopes.filter((s) => s.id === scopeId);
  const ids = new Set(chosen.map((s) => s.id));
  const cases = tm.testCases.filter((c) => ids.has(c.scopeId) && c.status === 'active');
  const summary = useMemo(() => summarize(cases, tm.byCase), [cases, tm.byCase]);
  const updaterIds = [...new Set(tm.caseResults.filter((r) => r.projectId === project.projectId && r.updatedByUserId !== null).map((r) => r.updatedByUserId as string))];
  const scopeById = new Map(scopes.map((s) => [s.id, s]));

  // ---- TestRail sync (preview → confirm; only linked scopes are fetched) ----
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<TestRailClientError | null>(null);
  const [syncPlan, setSyncPlan] = useState<TestRailSyncPlan | null>(null);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const linkedScopes = chosen.filter((s) => s.testrail !== undefined);

  const runSync = async (): Promise<void> => {
    if (conn === undefined) {
      setSyncError({ kind: 'notConfigured', message: 'TestRail is not configured (no connection in Settings).' });
      return;
    }
    if (linkedScopes.length === 0) {
      setSyncNote(t(lang, 'tm.execSync.noLinkedScopes'));
      return;
    }
    setSyncing(true);
    setSyncError(null);
    setSyncPlan(null);
    setSyncNote(null);
    try {
      const client = createTestRailClient(conn);
      const patches: TestRailSyncPlan['patches'] = [];
      const merged: TestRailSyncPlan = { patches, unmatchedCaseIds: [], unchangedCount: 0, customStatusCount: 0, statusCounts: { notStarted: 0, inProgress: 0, pass: 0, fail: 0, na: 0, blocked: 0, spo: 0 } };
      for (const scope of linkedScopes) {
        const runId = scope.testrail?.runId;
        if (runId === undefined) continue;
        const [tests, results] = await Promise.all([client.getTestsForRun(runId), client.getResultsForRun(runId)]);
        const scopeCases = cases.filter((c) => c.scopeId === scope.id);
        const plan = planTestRailResultSync(tests, results, scopeCases, tm.byCase);
        merged.patches.push(...plan.patches);
        merged.unmatchedCaseIds.push(...plan.unmatchedCaseIds);
        merged.unchangedCount += plan.unchangedCount;
        merged.customStatusCount += plan.customStatusCount;
        for (const [k, v] of Object.entries(plan.statusCounts)) merged.statusCounts[k as keyof typeof merged.statusCounts] += v;
      }
      if (merged.patches.length === 0) {
        setSyncNote(t(lang, 'tm.execSync.noChanges'));
        return;
      }
      setSyncPlan(merged);
    } catch (e) {
      const err = e as TestRailClientError;
      if (err.kind === undefined) throw e;
      setSyncError(err);
    } finally {
      setSyncing(false);
    }
  };

  const confirmSync = (): void => {
    if (syncPlan === null) return;
    for (const patch of syncPlan.patches) {
      tm.patchResult(patch.testCase, { status: patch.status, ...(patch.memo === undefined ? {} : { memo: patch.memo }), ...(patch.ticketRef === undefined ? {} : { ticketRef: patch.ticketRef }) });
    }
    setSyncNote(t(lang, 'tm.execSync.done', { count: syncPlan.patches.length }));
    setSyncPlan(null);
  };

  if (scopes.length === 0) {
    return (
      <section className="dr-section tenancy-empty" role="note">
        <p>{t(lang, 'tm.empty.noScopes')}</p>
      </section>
    );
  }
  return (
    <section className="dr-section">
      <div className="dr-button-row">
        <h2>{t(lang, 'tm.exec.title')}</h2>
        <label className="dr-toolbar-field">
          {t(lang, 'tm.col.scope')}
          <select className="input" value={scopeId} onChange={(e) => setScopeId(e.target.value)}>
            <option value="all">{t(lang, 'tm.exec.allScopes')}</option>
            {scopes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.status === 'archived' ? ` (${t(lang, 'tm.status.archived')})` : ''}
              </option>
            ))}
          </select>
        </label>
        {conn !== undefined ? (
          <button type="button" className="btn" disabled={syncing} onClick={() => void runSync()}>
            {syncing ? t(lang, 'tm.execSync.fetching') : t(lang, 'tm.execSync.open')}
          </button>
        ) : (
          <span className="link-help">{t(lang, 'tm.execSync.notConfigured')}</span>
        )}
      </div>
      {syncError !== null ? <TestRailErrorHint lang={lang} error={syncError} notConfiguredMessage="tm.execSync.notConfigured" /> : null}
      {syncNote !== null ? (
        <p className="data-controls-message ok" role="status">
          {syncNote}
        </p>
      ) : null}
      {syncPlan === null ? null : (
        <div className="tenancy-form tm-bulk">
          <h3>{t(lang, 'tm.execSync.title')}</h3>
          <p className="link-help">{t(lang, 'tm.execSync.help')}</p>
          <p role="status">{t(lang, 'tm.execSync.found', { count: syncPlan.patches.length })}</p>
          <p className="link-help">
            {t(lang, 'tm.execSync.statusLine', {
              pass: syncPlan.statusCounts.pass,
              fail: syncPlan.statusCounts.fail,
              blocked: syncPlan.statusCounts.blocked,
              inProgress: syncPlan.statusCounts.inProgress,
              notStarted: syncPlan.statusCounts.notStarted,
            })}
            {syncPlan.unchangedCount > 0 ? ` ${t(lang, 'tm.execSync.unchanged', { count: syncPlan.unchangedCount })}` : ''}
          </p>
          {syncPlan.customStatusCount > 0 ? (
            <p className="qa-warning" role="status">
              {t(lang, 'tm.execSync.customStatuses', { count: syncPlan.customStatusCount })}
            </p>
          ) : null}
          {syncPlan.unmatchedCaseIds.length > 0 ? (
            <p className="link-help">{t(lang, 'tm.execSync.unmatched', { count: syncPlan.unmatchedCaseIds.length })}</p>
          ) : null}
          <div className="dr-button-row">
            <button type="button" className="btn btn-primary" onClick={confirmSync}>
              {t(lang, 'tm.execSync.confirm', { count: syncPlan.patches.length })}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setSyncPlan(null)}>
              {t(lang, 'tenancy.cancel')}
            </button>
          </div>
        </div>
      )}
      <SummaryBlock lang={lang} summary={summary} />
      <ExecutionTable
        lang={lang}
        cases={cases}
        scopes={scopes}
        byCase={tm.byCase}
        showScope={scopeId === 'all'}
        canEdit={(tc) => tc.status === 'active' && scopeById.get(tc.scopeId)?.status === 'active'}
        onPatch={(tc, patch) => tm.patchResult(tc, patch)}
        nameOf={(id) => userLabel(lang, id, directory)}
        updaters={updaterIds.map((id) => ({ id, label: userLabel(lang, id, directory) }))}
      />
    </section>
  );
}

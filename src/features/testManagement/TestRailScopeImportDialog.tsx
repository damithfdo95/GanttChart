import { useMemo, useState } from 'react';
import { useReportsStateCtx } from '../../app/state-contexts';
import { newScope, newTestCase, planImportRows, type TestManagementState, type TestRailScopeImportPlan } from '../../domain/testManagement';
import { planTestRailCaseImport } from '../../domain/testManagement/testrailCases';
import { planTestRailAssignments, type UnmatchedTestRailTester } from '../../domain/testManagement/testrailAssignments';
import { buildExternalIdentityLink } from '../../domain/attribution';
import { personOptionText, personOptions, selectableMembers } from '../../domain/teamMembers';
import { createTestRailClient } from '../../lib/testrail/client';
import { backfillTestRailUsers } from '../../lib/testrail/client';
import { TestRailStatusLine } from '../../components/TestRailStatusLine';
import { parseTestRailUrl } from '../../domain/testrail';
import { type TestRailTestRow, type TestRailUser } from '../../../shared/testrail';
import { TestRailErrorHint } from '../../components/TestRailErrorHint';
import type { TestRailClientError } from '../../../shared/testrail';
import { t, type TranslationKey } from '../../i18n';
import { dictionaries } from '../../i18n/dictionaries';
import { businessDate } from '../../../shared/businessTime';
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
  /** After the scopes commit: the tester-assignment step (TestRail testers → Team Members). */
  const [assignStep, setAssignStep] = useState<{
    plan: ReturnType<typeof planTestRailAssignments>;
    scopeIdsByRunId: Map<number, string>;
    /** The TestRail user list fetched for the step (kept for re-planning after a link). */
    users: TestRailUser[];
    /** The runs' tests (kept for re-planning after a link). */
    testsByRunId: Map<number, TestRailTestRow[]>;
  } | null>(null);
  const [assignBusy, setAssignBusy] = useState(false);
  const [assignNote, setAssignNote] = useState<string | null>(null);

  // The member dropdown for linking unmatched TestRail users (the JIRA
  // unmatched-reporter idiom: active testers AND SVs — an SV may execute
  // tests too — name order, never an id).
  const memberOptions = useMemo(
    () => personOptions(lang, selectableMembers(reports.state.rcsMembers ?? [], { role: ['tester', 'sv'], today: businessDate() }), businessDate()),
    [lang, reports.state.rcsMembers],
  );

  // Duplicate detection is per project: a run already linked by ANY scope of
  // THIS project is skipped; links in other projects never block.
  const scopesOfProject = useMemo(() => tm.scopes.filter((s) => s.projectId === project.projectId), [tm.scopes, project.projectId]);

  const nameOf = (runId: number, fallback: string): string => names[runId] ?? fallback;

  const fetchRuns = async (): Promise<void> => {
    const link = parseTestRailUrl(url);
    // Plan URLs list their runs; a standalone run URL imports that ONE run.
    if (link === null) {
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
      // A plan URL fetches the plan's runs; a run URL fetches that single run
      // (get_run carries the counts, so no backfill is needed for it).
      const runs = link.kind === 'plan' ? await client.getPlanRuns(link.id) : [await client.getRun(link.id)];
      // Some TestRail versions omit the flat *_count fields on plan-entry
      // runs — a run showing total 0 would import a scope with Total 0 and
      // the project's derived Total would silently stay behind. Backfill
      // each count-less run with its real counts (one get_run per run).
      const backfilled = await Promise.all(
        runs.map(async (run) => {
          if (run.progress !== undefined && run.progress.total > 0) return run;
          try {
            const progress = await client.getRunProgress(run.id);
            return { ...run, progress };
          } catch {
            return run; // keep the plan's own counts (0) — the SV can fix the Total by hand
          }
        }),
      );
      setPlanId(link.kind === 'plan' ? link.id : null);
      setPlan(planImportRows(backfilled, scopesOfProject, project.projectId));
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
    if (plan === null || committing) return;
    // Only importable rows can be ticked; skipped/duplicate runs never commit.
    const rows = plan.rows.filter((r) => r.importable && selected[r.run.id] === true);
    if (rows.length === 0) return;
    setFailKey(null);
    setCommitting(true);
    const now = new Date().toISOString();
    let failed: string | null = null;
    let imported = 0;
    const scopeIdsByRunId = new Map<number, string>();
    tm.update((state: TestManagementState) => {
      // Accumulate so each new scope sees the previous one's order (one scope
      // per run, never the same order twice); on any failure NOTHING writes.
      let acc = state;
      for (const row of rows) {
        const made = newScope(acc, {
          projectId: project.projectId,
          name: nameOf(row.run.id, row.name),
          totalTestCases: row.totalTestCases,
          // A standalone run has no parent plan: the link carries the run id
          // and the plan id only when one is known (plan imports).
          testrail: row.run.planId !== undefined || planId !== null ? { planId: row.run.planId ?? (planId as number), runId: row.run.id } : { planId: row.run.id, runId: row.run.id },
        }, now);
        if (!made.ok) {
          failed = made.error;
          return state;
        }
        scopeIdsByRunId.set(row.run.id, made.value.id);
        acc = { ...acc, scopes: [...acc.scopes, made.value] };
      }
      imported = rows.length;
      return acc;
    });
    setCommitting(false);
    if (failed !== null) {
      const key = `tm.error.${failed}` as TranslationKey;
      setFailKey(key in dictionaries.en ? key : 'tm.error.generic');
      return;
    }
    // The scopes are in. Offer the tester-assignment step: the run's
    // assigned TestRail testers, resolved to Team Members by email, become
    // scope assignments (the Testers column of the Scopes tab reads them).
    void prepareAssignStep(rows.map((r) => r.run.id), scopeIdsByRunId, imported);
  };

  /**
   * Open the tester-assignment/linking step for runs that were imported
   * EARLIER (all duplicates now): the SV can still link TestRail testers to
   * Team Members and create the assignments they missed back then. Uses
   * the EXISTING scopes' ids (found by their testrail run link) instead of
   * newly created ones.
   */
  const openAssignForDuplicates = (): void => {
    if (plan === null) return;
    // The duplicate rows are the runs this project already links.
    const duplicateRunIds = plan.rows.filter((r) => !r.importable).map((r) => r.run.id);
    if (duplicateRunIds.length === 0) return;
    // Map each run to the EXISTING scope that links it.
    const scopeIdsByRunId = new Map<number, string>();
    for (const runId of duplicateRunIds) {
      const scope = scopesOfProject.find((s) => s.testrail?.runId === runId);
      if (scope !== undefined) scopeIdsByRunId.set(runId, scope.id);
    }
    if (scopeIdsByRunId.size === 0) return;
    void prepareAssignStep([...scopeIdsByRunId.keys()], scopeIdsByRunId, 0);
  };

  /**
   * Auto-import the suite's cases for the just-created scopes: the run's
   * suite cases become Test Cases (with their testrailCaseId link) through
   * the SAME pure plan the Cases tab's manual import uses — so after ONE
   * fetch the whole Test Management page works (Overview counts, Cases
   * list, Execution sync, Analysis) without registering anything by hand.
   * Best-effort: a run without a suite id or an empty suite is skipped
   * silently (the SV can still import cases by hand from the Cases tab).
   */
  const autoImportCases = async (client: ReturnType<typeof createTestRailClient>, runIds: readonly number[], scopeIdsByRunId: Map<number, string>): Promise<number> => {
    let imported = 0;
    for (const runId of runIds) {
      const scopeId = scopeIdsByRunId.get(runId);
      if (scopeId === undefined) continue;
      try {
        const run = await client.getRun(runId);
        if (run.suiteId === undefined) continue;
        const cases = await client.getCases(run.suiteId);
        if (cases.length === 0) continue;
        const scope = tm.scopes.find((s) => s.id === scopeId);
        const casePlan = planTestRailCaseImport(cases, tm.testCases, project.projectId, scope?.code ?? '');
        if (casePlan.commitRows.length === 0) continue;
        const now = new Date().toISOString();
        let failed: string | null = null;
        tm.update((state: TestManagementState) => {
          let acc = state;
          const baseOrder = acc.testCases.filter((c) => c.scopeId === scopeId).reduce((m, c) => Math.max(m, c.order), 0);
          for (const [i, row] of casePlan.commitRows.entries()) {
            const made = newTestCase(acc, scopeId, { title: row.title, priority: row.priority, ...(row.type === undefined ? {} : { type: row.type }), testrailCaseId: row.testrailCaseId }, now, {
              reservedKeys: acc.testCases.filter((c) => c.projectId === project.projectId).map((c) => c.key),
              order: baseOrder + (i + 1) * 10,
            });
            if (!made.ok) {
              failed = made.error;
              return state;
            }
            acc = { ...acc, testCases: [...acc.testCases, made.value] };
          }
          return acc;
        });
        if (failed === null) imported += casePlan.commitRows.length;
      } catch {
        /* best-effort: this run's cases are skipped, the import continues */
      }
    }
    return imported;
  };

  /** Fetch the imported runs' tests + the TestRail user list and plan the assignments. */
  const prepareAssignStep = async (runIds: readonly number[], scopeIdsByRunId: Map<number, string>, imported: number): Promise<void> => {
    if (conn === undefined) {
      onDone(imported, plan?.duplicateCount ?? 0);
      onClose();
      return;
    }
    setAssignBusy(true);
    setAssignNote(null);
    try {
      const client = createTestRailClient(conn);
      // The suite's cases become Test Cases automatically (best-effort), so
      // the whole Test Management page works after this one import.
      const casesImported = await autoImportCases(client, runIds, scopeIdsByRunId);
      if (casesImported > 0) {
        setAssignNote(t(lang, 'tm.testrailImport.casesAutoImported', { count: casesImported }));
      }
      const testsByRunId = new Map<number, TestRailTestRow[]>();
      await Promise.all(
        runIds.map(async (runId) => {
          try {
            testsByRunId.set(runId, await client.getTestsForRun(runId));
          } catch {
            testsByRunId.set(runId, []); // a run's tests are optional for this step
          }
        }),
      );
      // Names are cosmetic: without user-list access the step still plans
      // (unmatched) — same fallback rule as the progress readout.
      let users: TestRailUser[] = [];
      try {
        users = await client.getUsers();
      } catch {
        /* self-hosted instances may restrict get_users to admins */
      }
      // A deactivated tester drops out of get_users while their tests stay
      // assigned: fetch each missing id with get_user so the SV sees the
      // person's NAME (and their email can link a Team Member by itself).
      const assignedIds = [...testsByRunId.values()]
        .flat()
        .map((test) => test.assignedToId)
        .filter((id): id is number => id !== null);
      users = await backfillTestRailUsers(client, users, assignedIds);
      const assignPlan = planTestRailAssignments(
        testsByRunId,
        users,
        reports.state.rcsMembers ?? [],
        project.projectId,
        scopeIdsByRunId,
        reports.state.testerAssignments ?? [],
        businessDate(),
        reports.state.externalIdentities ?? [],
      );
      if (assignPlan.assignments.length === 0 && assignPlan.unmatched.length === 0) {
        // No testers on any run: nothing to offer — finish like before.
        onDone(imported, plan?.duplicateCount ?? 0);
        onClose();
        return;
      }
      setAssignStep({ plan: assignPlan, scopeIdsByRunId, users, testsByRunId });
    } catch {
      // The assignment step is best-effort: the scopes are already committed.
      onDone(imported, plan?.duplicateCount ?? 0);
      onClose();
    } finally {
      setAssignBusy(false);
    }
  };

  /** Commit the planned assignments (one upsert each; the SV saw the preview). */
  const confirmAssignments = (): void => {
    if (assignStep === null || assignBusy) return;
    setAssignBusy(true);
    for (const assignment of assignStep.plan.assignments) {
      reports.upsertTesterAssignment(assignment);
    }
    const importedCount = assignStep.plan.assignments.length;
    const unmatchedCount = assignStep.plan.unmatched.length;
    setAssignBusy(false);
    setAssignStep(null);
    const parts = [t(lang, 'tm.testrailImport.assignDone', { count: importedCount })];
    if (unmatchedCount > 0) parts.push(t(lang, 'tm.testrailImport.assignUnmatchedHint', { count: unmatchedCount }));
    onDoneWithAssign(importedCount, unmatchedCount, parts.join(' '));
  };

  /**
   * Link one unmatched TestRail user to a Team Member: an ACTIVE external
   * identity (provider 'testrail', the TestRail user id) is created — the
   * same record the JIRA reporter linking writes — and the assignment plan
   * is re-planned so the member's assignments appear immediately.
   */
  const linkTester = (testrailUserId: number, memberId: string): void => {
    if (assignStep === null || memberId === '') return;
    const user = assignStep.users.find((u) => u.id === testrailUserId);
    reports.upsertExternalIdentity(
      buildExternalIdentityLink({
        provider: 'testrail',
        externalId: String(testrailUserId),
        memberId,
        displayName: user?.name,
        linkedAt: new Date().toISOString(),
      }),
    );
    // Re-plan with the new identity in place (the link wins over email).
    const nextPlan = planTestRailAssignments(
      assignStep.testsByRunId,
      assignStep.users,
      reports.state.rcsMembers ?? [],
      project.projectId,
      assignStep.scopeIdsByRunId,
      reports.state.testerAssignments ?? [],
      businessDate(),
      [...(reports.state.externalIdentities ?? []), buildExternalIdentityLink({
        provider: 'testrail',
        externalId: String(testrailUserId),
        memberId,
        displayName: user?.name,
        linkedAt: new Date().toISOString(),
      })],
    );
    setAssignStep({ ...assignStep, plan: nextPlan });
  };

  /** Finish the whole import (scopes + assignments) with one summary. */
  const onDoneWithAssign = (assigned: number, unmatched: number, text: string): void => {
    void assigned;
    void unmatched;
    setAssignNote(text);
    onDone(plan?.rows.filter((r) => r.importable && selected[r.run.id] === true).length ?? 0, plan?.duplicateCount ?? 0);
    onClose();
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
      {urlError ? (
        <p className="qa-warning" role="alert">
          <strong>{t(lang, 'tm.testrailImport.invalidPlanUrl')}</strong>
        </p>
      ) : null}
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
                      <TestRailStatusLine lang={lang} progress={row.run.progress} className="link-help" />
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
          {/* Runs imported earlier (duplicates): their testers can still be
              linked and assigned — the step the original import never showed
              (or that was skipped). */}
          {plan.duplicateCount > 0 ? (
            <div className="dr-button-row">
              <button type="button" className="btn" disabled={assignBusy} onClick={openAssignForDuplicates}>
                {t(lang, 'tm.testrailImport.assignExisting')}
              </button>
            </div>
          ) : null}
        </div>
      )}

      {/* ---- tester-assignment step (after the scopes committed) ---- */}
      {assignBusy ? (
        <p className="link-help" role="status">
          {t(lang, 'tm.testrailImport.assignFetching')}
        </p>
      ) : null}
      {assignNote !== null ? (
        <p className="data-controls-message ok" role="status">
          {assignNote}
        </p>
      ) : null}
      {assignStep === null ? null : (
        <div className="tenancy-table-wrap">
          <h4>{t(lang, 'tm.testrailImport.assignTitle')}</h4>
          <p className="link-help">{t(lang, 'tm.testrailImport.assignHelp')}</p>
          {assignStep.plan.assignments.length > 0 ? (
            <>
              <p role="status">{t(lang, 'tm.testrailImport.assignFound', { count: assignStep.plan.assignments.length })}</p>
              <table className="tenancy-table">
                <thead>
                  <tr>
                    <th scope="col">{t(lang, 'tm.col.testers')}</th>
                    <th scope="col">{t(lang, 'tm.col.scope')}</th>
                  </tr>
                </thead>
                <tbody>
                  {assignStep.plan.assignments.map((a) => (
                    <tr key={a.id}>
                      <td>{a.testerName}</td>
                      <td>{plan?.rows.find((r) => assignStep.scopeIdsByRunId.get(r.run.id) === a.scopeId)?.name ?? a.scopeId}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <p className="link-help" role="status">{t(lang, 'tm.testrailImport.assignNone')}</p>
          )}
          {assignStep.plan.unmatched.length > 0 ? (
            <>
              <p className="qa-warning" role="status">
                {t(lang, 'tm.testrailImport.assignUnmatched', { count: assignStep.plan.unmatched.length })}
              </p>
              <table className="tenancy-table">
                <thead>
                  <tr>
                    <th scope="col">{t(lang, 'tm.testrailImport.assignColTester')}</th>
                    <th scope="col" className="num">{t(lang, 'tm.testrailImport.assignUnmatchedTestsHeader')}</th>
                    <th scope="col">{t(lang, 'tm.testrailImport.assignLinkToMember')}</th>
                  </tr>
                </thead>
                <tbody>
                  {assignStep.plan.unmatched.map((u: UnmatchedTestRailTester) => (
                    <tr key={u.testrailUserId}>
                      <td>{u.name}</td>
                      <td className="num">{u.tests}</td>
                      <td>
                        <select
                          className="table-input"
                          aria-label={t(lang, 'tm.testrailImport.assignLinkToMember')}
                          value=""
                          onChange={(e) => linkTester(u.testrailUserId, e.target.value)}
                        >
                          <option value="">{t(lang, 'jira.tab.linkMemberPlaceholder')}</option>
                          {memberOptions.map((option) => (
                            <option key={option.memberId} value={option.memberId}>
                              {personOptionText(lang, option)}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
          <div className="dr-button-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={assignBusy || assignStep.plan.assignments.length === 0}
              onClick={confirmAssignments}
            >
              {t(lang, 'tm.testrailImport.assignConfirm', { count: assignStep.plan.assignments.length })}
            </button>
            <button type="button" className="btn btn-ghost" disabled={assignBusy} onClick={() => { setAssignStep(null); onDone(plan?.rows.filter((r) => r.importable && selected[r.run.id] === true).length ?? 0, plan?.duplicateCount ?? 0); onClose(); }}>
              {t(lang, 'tm.testrailImport.assignSkip')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
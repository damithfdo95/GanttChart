/**
 * Test Management → Overview tab: read-only per-scope summary table and cards
 * for one project. Extracted from TestManagementScreen.tsx.
 */

import { useMemo } from 'react';
import { t } from '../../i18n';
import { assigneeLabel, compactNames } from '../../domain/people';
import { detailedCoverage, projectOverview, projectTotals, scopeAssignees } from '../../domain/testManagement';
import { SummaryBlock, TotalsPanel, pct } from './SummaryParts';
import { useBusinessToday, usePeopleDirectory, useTestManagement } from './useTestManagement';
import { useTesters } from '../cycles/parts';
import type { Language, ProjectRecord } from '../../types';
import type { TestScope } from '../../domain/testManagement';

export function useDirectory() {
  const { testers } = useTesters();
  return { testers, directory: usePeopleDirectory(testers) };
}

export function OverviewTab({ lang, project, onOpen }: { lang: Language; project: ProjectRecord; onOpen: () => void }) {
  const tm = useTestManagement();
  const today = useBusinessToday();
  const { directory } = useDirectory();
  const overview = useMemo(() => projectOverview(project.projectId, tm.state), [project.projectId, tm.state]);
  const totals = useMemo(() => projectTotals(project, tm.scopes, tm.testCases), [project, tm.scopes, tm.testCases]);
  const totalOf = (scopeId: string) => totals.scopes.find((r) => r.scope.id === scopeId);
  const assignments = tm.reports.state.testerAssignments ?? [];
  if (overview.rows.length === 0) {
    return (
      <section className="dr-section tenancy-empty" role="note">
        <p>{t(lang, 'tm.empty.noScopes')}</p>
        <button type="button" className="btn btn-primary" onClick={onOpen}>
          {t(lang, 'tm.scope.add')}
        </button>
      </section>
    );
  }
  const people = (scope: TestScope): string => compactNames(scopeAssignees(scope, assignments, today).map((who) => assigneeLabel(lang, who, directory)));
  return (
    <section className="dr-section">
      <h2>{t(lang, 'tm.overview.title')}</h2>
      <p className="link-help">{t(lang, 'tm.overview.sourceNote')}</p>
      <TotalsPanel lang={lang} totals={totals} completed={project.inputs.casesCompleted} />
      <h3>{t(lang, 'tm.overview.detailTitle')}</h3>
      <p className="link-help">{t(lang, 'tm.overview.detailNote', { registered: totals.registered })}</p>
      <SummaryBlock lang={lang} summary={overview.total} />
      <div className="tenancy-table-wrap">
        <table className="tenancy-table">
          <caption className="sr-only">{t(lang, 'tm.overview.title')}</caption>
          <thead>
            <tr>
              <th scope="col">{t(lang, 'tm.col.scope')}</th>
              <th scope="col">{t(lang, 'tm.col.testers')}</th>
              <th scope="col">{t(lang, 'tm.col.totalCases')}</th>
              <th scope="col">{t(lang, 'tm.col.registered')}</th>
              <th scope="col">{t(lang, 'tm.sum.completed')}</th>
              <th scope="col">{t(lang, 'tm.col.coverage')}</th>
              <th scope="col">{t(lang, 'tm.sum.passRate')}</th>
              <th scope="col">{t(lang, 'tm.sum.fail')}</th>
              <th scope="col">{t(lang, 'tm.sum.blocked')}</th>
            </tr>
          </thead>
          <tbody>
            {overview.rows.map(({ scope, summary }) => (
              <tr key={scope.id} className={scope.status === 'archived' ? 'tm-archived' : undefined}>
                <th scope="row" className="tenancy-user-cell">
                  <strong>{scope.name}</strong>
                  {scope.code === undefined ? null : <span>{scope.code}</span>}
                  {scope.status === 'archived' ? <span>{t(lang, 'tm.status.archived')}</span> : null}
                </th>
                <td>{people(scope) || '—'}</td>
                <td>{totalOf(scope.id)?.total ?? '—'}</td>
                <td>
                  {summary.total}
                  {totalOf(scope.id)?.overRegistered === true ? <span title={t(lang, 'tm.total.warnOverHint')}> ⚠</span> : null}
                </td>
                <td>{summary.completed}</td>
                <td>{pct(detailedCoverage(summary.completed, summary.total))}</td>
                <td>{pct(summary.passRate)}</td>
                <td>{summary.fail}</td>
                <td>{summary.blocked}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="tm-cards">
        {overview.rows
          .filter((r) => r.scope.status === 'active')
          .map(({ scope, summary }) => (
            <article key={scope.id} className="summary-card tm-card">
              <h3>
                {scope.name} <small>{t(lang, 'tm.overview.casesCount', { count: summary.total })}</small>
              </h3>
              <SummaryBlock lang={lang} summary={summary} />
              <p className="link-help">
                {t(lang, 'tm.col.testers')}: {people(scope) || t(lang, 'tm.empty.noTesters')}
              </p>
            </article>
          ))}
      </div>
    </section>
  );
}

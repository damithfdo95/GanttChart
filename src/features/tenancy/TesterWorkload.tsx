import { useMemo } from 'react';
import { useReportsStateCtx } from '../../app/state-contexts';
import { t } from '../../i18n';
import { formatDate, todayEpochDays } from '../../lib/dates/dates';
import { testerWorkload, unassignedProjects } from '../../domain/qaMetrics';
import { StatusBadge } from './UsersManager';
import { useTesters } from '../cycles/parts';
import type { Language } from '../../types';

/**
 * Who is on what (Admin, Web storage). "Shared remaining" is the remaining cases of the projects a Tester is on, each counted
 * IN FULL: where several people share a project there is no weighting in the data, so nothing is divided or turned into a percentage.
 */
export function TesterWorkload({ lang }: { lang: Language }) {
  const reports = useReportsStateCtx();
  const { testers } = useTesters();
  const today = formatDate(todayEpochDays());
  const projects = reports.state.projects;
  const assignments = reports.state.testerAssignments ?? [];
  const cycles = reports.state.cycles ?? [];
  const rows = useMemo(() => (testers === null ? [] : testerWorkload(testers.map((x) => x.id), projects, assignments, today)), [testers, projects, assignments, today]);
  const unassigned = useMemo(() => unassignedProjects(projects, assignments, today), [projects, assignments, today]);
  if (testers === null) return null;

  return (
    <section className="dr-section" aria-labelledby="workload-title">
      <h2 id="workload-title">{t(lang, 'workload.title')}</h2>
      <p className="dr-summary">{t(lang, 'workload.help')}</p>
      {testers.length === 0 ? (
        <p>{t(lang, 'workload.noTesters')}</p>
      ) : (
        <div className="tenancy-table-wrap">
          <table className="tenancy-table">
            <caption className="sr-only">{t(lang, 'workload.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{t(lang, 'tenancy.users.colUser')}</th>
                <th scope="col">{t(lang, 'tenancy.users.colStatus')}</th>
                <th scope="col">{t(lang, 'workload.assigned')}</th>
                <th scope="col">{t(lang, 'workload.projects')}</th>
                <th scope="col">{t(lang, 'workload.sharedRemaining')}</th>
              </tr>
            </thead>
            <tbody>
              {testers.map((tester) => {
                const w = rows.find((r) => r.userId === tester.id);
                const list = w?.assignedProjects ?? [];
                return (
                  <tr key={tester.id}>
                    <th scope="row" className="tenancy-user-cell">
                      {tester.displayName === null ? null : <strong>{tester.displayName}</strong>}
                      <span>{tester.email}</span>
                    </th>
                    <td>
                      <StatusBadge lang={lang} status={tester.status} />
                    </td>
                    <td>{list.length}</td>
                    <td>
                      {list.length === 0 ? (
                        '—'
                      ) : (
                        <ul className="cc-people">
                          {list.map((p) => {
                            const cycle = p.cycleId === null ? null : cycles.find((c) => c.id === p.cycleId);
                            return (
                              <li key={p.projectId}>
                                {p.name} <code>{p.projectId}</code>
                                {cycle === null || cycle === undefined ? '' : ` — ${cycle.name}`}
                                {p.peopleOnProject > 1 ? ` (${t(lang, 'workload.sharedWith', { count: p.peopleOnProject - 1 })})` : ''}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </td>
                    <td>{list.length === 0 ? '—' : w?.sharedRemaining}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <h3>{t(lang, 'workload.unassigned')}</h3>
      {unassigned.length === 0 ? (
        <p>{t(lang, 'workload.allAssigned')}</p>
      ) : (
        <ul>
          {unassigned.map((p) => (
            <li key={p.id}>
              {p.nameEn || p.nameJa} <code>{p.projectId}</code>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

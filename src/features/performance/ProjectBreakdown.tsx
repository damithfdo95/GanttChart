import type { Language, ProjectRecord } from '../../types';
import { t } from '../../i18n';
import { projectDisplayName } from '../../domain/projects';
import { formatInteger, formatNumber } from '../../lib/formatting/format';
import type { TesterProjectBreakdownRow } from '../../lib/calculations/testerPerformance';

interface ProjectBreakdownProps {
  lang: Language;
  rows: TesterProjectBreakdownRow[];
  projects: ProjectRecord[];
}

/** Per-project breakdown for one tester (V6.6 §21) — traceable evidence. */
export function ProjectBreakdown({ lang, rows, projects }: ProjectBreakdownProps) {
  if (rows.length === 0) {
    return <p className="dr-empty">{t(lang, 'performance.noData')}</p>;
  }
  const nameOf = (projectId: string): string => {
    const project = projects.find((p) => p.projectId === projectId);
    return project !== undefined ? projectDisplayName(project, lang) : '—';
  };
  return (
    <div className="table-wrap">
      <table className="dr-table">
        <thead>
          <tr>
            <th scope="col">{t(lang, 'performance.projectScope')}</th>
            <th scope="col" className="num">{t(lang, 'performance.cases')}</th>
            <th scope="col" className="num">{t(lang, 'performance.activeDays')}</th>
            <th scope="col" className="num">{t(lang, 'performance.avgPerDay')}</th>
            <th scope="col" className="num">{t(lang, 'performance.bugs')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.projectId}>
              <td>{nameOf(row.projectId)}</td>
              <td className="num">{formatInteger(row.casesTested, lang)}</td>
              <td className="num">{formatInteger(row.activeDays, lang)}</td>
              <td className="num">{formatNumber(row.averageCasesPerDay, 1, lang)}</td>
              <td className="num">{formatInteger(row.bugsFound, lang)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

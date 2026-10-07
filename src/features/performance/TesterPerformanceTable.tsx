import type { Language, PerformanceRecordSource, ProjectRecord } from '../../types';
import { t } from '../../i18n';
import { projectDisplayName } from '../../domain/projects';
import { formatInteger, formatNumber } from '../../lib/formatting/format';
import type { TesterPerformanceRow } from '../../lib/calculations/testerPerformance';

/** Localized label of one execution source (V6.7 §16). */
export function sourceLabel(lang: Language, source: PerformanceRecordSource | undefined): string {
  switch (source) {
    case 'automatic':
      return t(lang, 'performance.sourceAutomatic');
    case 'assisted':
      return t(lang, 'performance.sourceAssisted');
    case 'manual':
      return t(lang, 'performance.sourceManual');
    case 'manualOverride':
      return t(lang, 'performance.sourceManualOverride');
    default:
      return t(lang, 'performance.sourceUnknown');
  }
}

/** All sources a tester's records came from, joined for one cell. */
export function sourcesLabel(lang: Language, sources: readonly PerformanceRecordSource[]): string {
  if (sources.length === 0) return t(lang, 'performance.sourceUnknown');
  return sources.map((source) => sourceLabel(lang, source)).join(' / ');
}

interface TesterPerformanceTableProps {
  lang: Language;
  rows: TesterPerformanceRow[];
  projects: ProjectRecord[];
  /** Selected tester name (row highlight); null when none. */
  selectedTester: string | null;
  onSelect: (testerName: string) => void;
}

/**
 * Per-tester table (V6.6 §17). Sorted by tester name — testers are never
 * ranked, scored or graded. The "Projects" cell shows every project the
 * tester worked on inside the selected scope. V6.7 adds the execution
 * source column (automatic / assisted / manual) so the supervisor can see
 * how each figure was captured. V6.8 resolves the tester through the
 * member master: the row identity is the stable memberId when one exists.
 */
export function TesterPerformanceTable({ lang, rows, projects, selectedTester, onSelect }: TesterPerformanceTableProps) {
  if (rows.length === 0) {
    return <p className="dr-empty">{t(lang, 'performance.noData')}</p>;
  }
  const nameOf = (projectId: string): string => {
    const project = projects.find((p) => p.projectId === projectId);
    return project !== undefined ? projectDisplayName(project, lang) : '—';
  };
  return (
    <div className="table-wrap">
      <table className="dr-table table-wide">
        <thead>
          <tr>
            <th scope="col">{t(lang, 'performance.tester')}</th>
            <th scope="col">{t(lang, 'performance.projectsCount')}</th>
            <th scope="col" className="num">{t(lang, 'performance.activeDays')}</th>
            <th scope="col" className="num">{t(lang, 'performance.cases')}</th>
            <th scope="col" className="num">{t(lang, 'performance.avgPerDay')}</th>
            <th scope="col" className="num">{t(lang, 'columns.pass')}</th>
            <th scope="col" className="num">{t(lang, 'fields.casesFailed')}</th>
            <th scope="col" className="num">{t(lang, 'columns.blocked')}</th>
            <th scope="col" className="num">{t(lang, 'fields.casesRetest')}</th>
            <th scope="col" className="num">{t(lang, 'performance.bugs')}</th>
            <th scope="col">{t(lang, 'performance.executionSource')}</th>
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.memberId ?? row.testerName}
              className={(row.memberId ?? row.testerName) === selectedTester ? 'row-selected' : undefined}
            >
              <td>{row.testerName}</td>
              <td>
                {row.projectIds.length === 0 ? '—' : row.projectIds.map((id) => nameOf(id)).join(' / ')}
              </td>
              <td className="num">{formatInteger(row.activeDays, lang)}</td>
              <td className="num">{formatInteger(row.casesTested, lang)}</td>
              <td className="num">{formatNumber(row.averageCasesPerDay, 1, lang)}</td>
              <td className="num">{formatInteger(row.casesPassed, lang)}</td>
              <td className="num">{formatInteger(row.casesFailed, lang)}</td>
              <td className="num">{formatInteger(row.casesBlocked, lang)}</td>
              <td className="num">{formatInteger(row.casesRetest, lang)}</td>
              <td className="num">{formatInteger(row.bugsFound, lang)}</td>
              <td>{sourcesLabel(lang, row.sources)}</td>
              <td>
                <button type="button" className="btn" onClick={() => onSelect(row.memberId ?? row.testerName)}>
                  {t(lang, 'performance.viewTester')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

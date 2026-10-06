import type { Language, ProjectRecord } from '../../types';
import { t } from '../../i18n';
import { MetricCard } from '../../components/MetricCard';
import { formatInteger, formatNumber } from '../../lib/formatting/format';
import { projectDisplayName } from '../../domain/projects';
import type { TesterReviewMetrics } from '../../lib/calculations/testerPerformance';

interface ReviewSummaryProps {
  lang: Language;
  metrics: TesterReviewMetrics;
  projects: readonly ProjectRecord[];
}

/**
 * Objective review evidence for one tester and period (V6.7 §20): every
 * figure is recalculated from the evidence chain — nothing is stored, and
 * nothing is converted into a score, grade or ranking.
 */
export function ReviewSummary({ lang, metrics, projects }: ReviewSummaryProps) {
  const row = metrics.row;
  if (row === null && metrics.breakdown.length === 0) {
    return <p className="dr-empty">{t(lang, 'review.noData')}</p>;
  }
  const casesTested = row?.casesTested ?? 0;
  const activeDays = row?.activeDays ?? 0;
  const bugsFound = row?.bugsFound ?? 0;
  const bugDiscoveryRate = casesTested > 0 ? (bugsFound / casesTested) * 1000 : null;
  const nameOf = (projectId: string): string => {
    const project = projects.find((p) => p.projectId === projectId);
    return project !== undefined ? projectDisplayName(project, lang) : '—';
  };
  return (
    <>
      <div className="metrics-grid">
        <MetricCard label={t(lang, 'performance.projectsCount')} value={formatInteger(row?.projectIds.length ?? 0, lang)} />
        <MetricCard label={t(lang, 'performance.activeDays')} value={formatInteger(activeDays, lang)} />
        <MetricCard label={t(lang, 'performance.casesTested')} value={formatInteger(casesTested, lang)} />
        <MetricCard
          label={t(lang, 'performance.averagePerDay')}
          value={activeDays > 0 ? formatNumber(casesTested / activeDays, 1, lang) : '—'}
        />
        <MetricCard label={t(lang, 'performance.bugsFound')} value={formatInteger(bugsFound, lang)} />
        <MetricCard
          label={t(lang, 'performance.bugDiscoveryRate')}
          value={bugDiscoveryRate === null ? '—' : formatNumber(bugDiscoveryRate, 2, lang)}
        />
      </div>
      <div className="table-wrap">
        <table className="dr-table">
          <thead>
            <tr>
              <th scope="col" className="num">{t(lang, 'columns.pass')}</th>
              <th scope="col" className="num">{t(lang, 'fields.casesFailed')}</th>
              <th scope="col" className="num">{t(lang, 'columns.notApplicable')}</th>
              <th scope="col" className="num">{t(lang, 'columns.blocked')}</th>
              <th scope="col" className="num">{t(lang, 'fields.casesRetest')}</th>
              <th scope="col" className="num">{t(lang, 'fields.casesQuestioned')}</th>
              <th scope="col" className="num">{t(lang, 'columns.spoAssigned')}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="num">{formatInteger(row?.casesPassed ?? 0, lang)}</td>
              <td className="num">{formatInteger(row?.casesFailed ?? 0, lang)}</td>
              <td className="num">{formatInteger(row?.casesNotApplicable ?? 0, lang)}</td>
              <td className="num">{formatInteger(row?.casesBlocked ?? 0, lang)}</td>
              <td className="num">{formatInteger(row?.casesRetest ?? 0, lang)}</td>
              <td className="num">{formatInteger(row?.casesQuestioned ?? 0, lang)}</td>
              <td className="num">{formatInteger(row?.casesSpoAssigned ?? 0, lang)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3>{t(lang, 'review.projectContribution')}</h3>
      {metrics.breakdown.length === 0 ? (
        <p className="dr-empty">{t(lang, 'review.noData')}</p>
      ) : (
        <div className="table-wrap">
          <table className="dr-table">
            <thead>
              <tr>
                <th scope="col">{t(lang, 'performance.projectScope')}</th>
                <th scope="col" className="num">{t(lang, 'performance.cases')}</th>
                <th scope="col" className="num">{t(lang, 'performance.activeDays')}</th>
                <th scope="col" className="num">{t(lang, 'performance.bugs')}</th>
              </tr>
            </thead>
            <tbody>
              {metrics.breakdown.map((entry) => (
                <tr key={entry.projectId}>
                  <td>{nameOf(entry.projectId)}</td>
                  <td className="num">{formatInteger(entry.casesTested, lang)}</td>
                  <td className="num">{formatInteger(entry.activeDays, lang)}</td>
                  <td className="num">{formatInteger(entry.bugsFound, lang)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

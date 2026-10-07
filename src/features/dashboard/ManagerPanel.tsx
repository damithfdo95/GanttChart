import { useMemo, useState } from 'react';
import { useReportsStateCtx } from '../../app/state-contexts';
import { t } from '../../i18n';
import { formatDate, todayEpochDays } from '../../lib/dates/dates';
import { managerSummary } from '../../domain/projects/managerSummary';
import { needsAttention, portfolioMetrics, projectRiskSignals, type RiskContext } from '../../domain/qaMetrics';
import { MetricsGrid, RiskList, percent } from '../cycles/parts';
import type { Language } from '../../types';

/** At most this many projects are listed under "Needs attention" (the rest are one click away in Projects). */
const ATTENTION_LIST_LIMIT = 8;

/**
 * The QA manager's overview: portfolio and cycle counts, execution results, today, and what needs attention.
 * Every number is derived from data the workspace already stores; the definitions are in docs/QA_EXECUTION.md.
 */
export function ManagerPanel({ lang }: { lang: Language }) {
  const reports = useReportsStateCtx();
  const [cycleId, setCycleId] = useState<string>('');
  const today = formatDate(todayEpochDays());
  const nowIso = useMemo(() => new Date().toISOString(), []);
  const projects = reports.state.projects;
  const cycles = reports.state.cycles ?? [];
  const ctx: RiskContext = useMemo(() => ({ today, nowIso, assignments: reports.state.testerAssignments ?? [] }), [today, nowIso, reports.state.testerAssignments]);
  const scopeId = cycleId !== '' && cycles.some((c) => c.id === cycleId) ? cycleId : null;
  const scoped = scopeId === null ? projects : projects.filter((p) => p.cycleId === scopeId);
  const summary = useMemo(() => portfolioMetrics(projects, cycles, ctx, scopeId), [projects, cycles, ctx, scopeId]);
  const executing = managerSummary(scoped, today, nowIso).executingToday;
  const attention = useMemo(
    () =>
      scoped
        .filter((p) => p.status !== 'done')
        .map((p) => ({ project: p, signals: projectRiskSignals(p, ctx) }))
        .filter((x) => needsAttention(x.signals))
        .slice(0, ATTENTION_LIST_LIMIT),
    [scoped, ctx],
  );

  if (projects.length === 0) return null;
  const k = summary.today;
  const cards: Array<{ label: string; value: string; warn?: boolean }> = [
    { label: t(lang, 'mgr.activeCycles'), value: String(summary.activeCycles) },
    { label: t(lang, 'mgr.activeExecutions'), value: String(summary.activeProjects) },
    { label: t(lang, 'mgr.completedExecutions'), value: String(summary.completedProjects) },
    { label: t(lang, 'mgr.needsAttention'), value: String(summary.needsAttention), warn: summary.needsAttention > 0 },
    { label: t(lang, 'mgr.overdue'), value: String(summary.overdue), warn: summary.overdue > 0 },
  ];
  const todayCards = [
    { label: t(lang, 'mgr.executingToday'), value: String(executing) },
    { label: t(lang, 'mgr.todayExecuted'), value: String(k.executed) },
    { label: t(lang, 'mgr.todayPassed'), value: String(k.passed) },
    { label: t(lang, 'mgr.todayFailed'), value: String(k.failed) },
    { label: t(lang, 'mgr.todayBlocked'), value: String(k.blocked) },
    { label: t(lang, 'mgr.todayTesters'), value: k.projectsWithEntry === 0 ? '—' : String(k.testersMax) },
  ];

  return (
    <section className="dr-section manager-panel" aria-labelledby="manager-title">
      <div className="dr-button-row">
        <h2 id="manager-title">{t(lang, 'mgr.title')}</h2>
        {cycles.length > 0 ? (
          <label className="manager-scope">
            {t(lang, 'mgr.scope')}
            <select className="input" value={scopeId ?? ''} onChange={(e) => setCycleId(e.target.value)}>
              <option value="">{t(lang, 'mgr.allCycles')}</option>
              {cycles
                .filter((c) => c.status !== 'archived')
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.version === undefined ? '' : ` (${c.version})`}
                  </option>
                ))}
            </select>
          </label>
        ) : null}
      </div>

      <div className="overall-summary" role="group" aria-label={t(lang, 'mgr.portfolio')}>
        {cards.map((c) => (
          <div key={c.label} className={`summary-card${c.warn === true ? ' summary-card-warn' : ''}`}>
            <span className="summary-card-label">{c.label}</span>
            <span className="summary-card-value">
              {c.warn === true ? <span aria-hidden="true">⚠ </span> : null}
              {c.value}
            </span>
          </div>
        ))}
      </div>

      <h3>{t(lang, 'mgr.results')}</h3>
      <MetricsGrid lang={lang} m={summary.metrics} />

      <h3>{t(lang, 'mgr.today')}</h3>
      <div className="overall-summary" role="group" aria-label={t(lang, 'mgr.today')}>
        {todayCards.map((c) => (
          <div key={c.label} className="summary-card">
            <span className="summary-card-label">{c.label}</span>
            <span className="summary-card-value">{c.value}</span>
          </div>
        ))}
      </div>
      {k.projectsWithEntry === 0 ? <p className="link-help">{t(lang, 'mgr.noResultsToday')}</p> : null}

      <h3>{t(lang, 'mgr.attention')}</h3>
      {attention.length === 0 ? (
        <p>{t(lang, 'mgr.noAttention')}</p>
      ) : (
        <ul className="attention-list">
          {attention.map(({ project, signals }) => (
            <li key={project.id}>
              <strong>{project.nameEn || project.nameJa || project.projectId}</strong> <code>{project.projectId}</code>
              <RiskList lang={lang} signals={signals} />
            </li>
          ))}
        </ul>
      )}
      <p className="link-help">
        {t(lang, 'mgr.passRateNote')} {summary.metrics.passRate === null ? '' : `(${percent(summary.metrics.passRate)})`}
      </p>
    </section>
  );
}

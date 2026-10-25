import { useMemo, useState } from 'react';
import { useAppStateCtx, useReportsStateCtx } from '../../app/state-contexts';
import type { Screen } from '../../app/navigation';
import { t, type TranslationKey } from '../../i18n';
import { businessDate } from '../../../shared/businessTime';
import { resolveQaPolicy } from '../../../shared/qaPolicy';
import { formatInteger } from '../../lib/formatting/format';
import { buildSupervisorDailyOperations, type AttentionCategory, type ProjectDayOps, type SupervisorDailyOperations } from '../../domain/supervisorOperations';
import { ReadinessBadge } from '../readiness/ReadinessCard';
import { readinessReasonText } from '../readiness/readinessText';
import { MetricCard } from '../../components/MetricCard';
import { executionSourceLabelKey } from '../../domain/executionSource';
import { prepareDailyReportDraft, reportStateForDate } from '../../domain/dailyReportDraft';
import { MISSING_KEY, preparedDraftPreview, preparedTopicLine } from '../daily-report/preparedDraft';
import type { Language } from '../../types';

/** Where each kind of attention item is handled (the Command Center links there; it never duplicates an edit control). */
const TARGET: Record<AttentionCategory, { screen: Screen; key: TranslationKey }> = {
  defect: { screen: 'tickets', key: 'nav.tickets' },
  schedule: { screen: 'gantt', key: 'nav.gantt' },
  execution: { screen: 'testManagement', key: 'nav.testManagement' },
  staffing: { screen: 'team', key: 'nav.team' },
  dataQuality: { screen: 'testManagement', key: 'nav.testManagement' },
};

const addDays = (date: string, n: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const num = (n: number | null, lang: Language): string => (n === null ? '—' : formatInteger(n, lang));
const delta = (cur: number, prev: number): string => (cur - prev > 0 ? `+${cur - prev}` : String(cur - prev));

function WorkTypeChips({ lang, types }: { lang: Language; types: readonly string[] }) {
  return (
    <>
      {types.map((w) => (
        <span key={w} className={`tag qa-worktype qa-worktype-${w}`}>
          {t(lang, `qa.workType.${w}` as TranslationKey)}
        </span>
      ))}
    </>
  );
}

/** The supervisor's daily operating view. Management only; everything is derived from the workspace state, with no network call. */
export function CommandCenter({ onNavigate, onOpenGantt, onPrepareReport }: { onNavigate: (screen: Screen) => void; onOpenGantt: (projectId: string) => void; onPrepareReport: (date: string) => void }) {
  const lang = useAppStateCtx().state.language;
  const { state } = useReportsStateCtx();
  const today = businessDate();
  const [date, setDate] = useState(today);

  const ops: SupervisorDailyOperations = useMemo(
    () =>
      buildSupervisorDailyOperations({
        projects: state.projects,
        scopes: state.scopes ?? [],
        cases: state.testCases ?? [],
        caseResults: state.caseResults ?? [],
        caseExecution: state.caseExecutions ?? [],
        assignments: state.testerAssignments ?? [],
        members: state.rcsMembers ?? [],
        policy: resolveQaPolicy(state.settings.qaPolicy),
        selectedDate: date,
        today,
        nowIso: new Date().toISOString(),
      }),
    [state.projects, state.scopes, state.testCases, state.caseResults, state.caseExecutions, state.testerAssignments, state.rcsMembers, state.settings.qaPolicy, date, today],
  );
  // The Daily Report proposal comes from the same generator the report composer starts from (one data source); previewing it saves nothing.
  const prepared = useMemo(
    () =>
      prepareDailyReportDraft({
        language: lang,
        projects: state.projects,
        scopes: state.scopes ?? [],
        cases: state.testCases ?? [],
        caseResults: state.caseResults ?? [],
        caseExecution: state.caseExecutions ?? [],
        assignments: state.testerAssignments ?? [],
        members: state.rcsMembers ?? [],
        policy: resolveQaPolicy(state.settings.qaPolicy),
        selectedDate: date,
        today,
        nowIso: new Date().toISOString(),
      }),
    [lang, state.projects, state.scopes, state.testCases, state.caseResults, state.caseExecutions, state.testerAssignments, state.rcsMembers, state.settings.qaPolicy, date, today],
  );
  const preview = preparedDraftPreview(lang, prepared);
  const reportState = reportStateForDate(state.reports, date);
  const s = ops.summary;
  const byId = new Map(ops.projects.map((p) => [p.projectId, p] as const));
  const ranked: ProjectDayOps[] = ops.projectRanking.flatMap((id) => (byId.has(id) ? [byId.get(id) as ProjectDayOps] : []));
  const tested = ops.projects.filter((p) => p.hadExecution);
  const currentTag = ops.isHistorical ? <span className="gap-pill">{t(lang, 'ops.currentTag')}</span> : null;

  return (
    <div className="app command-center">
      <header className="page-header">
        <h1>{t(lang, 'ops.title')}</h1>
        <p className="dr-summary">{t(lang, 'ops.subtitle')}</p>
        <div className="dr-button-row" role="group" aria-label={t(lang, 'ops.date')}>
          <button type="button" className="btn" onClick={() => setDate(addDays(date, -1))}>
            {t(lang, 'ops.prev')}
          </button>
          <button type="button" className="btn" disabled={date === today} onClick={() => setDate(today)}>
            {t(lang, 'ops.today')}
          </button>
          <button type="button" className="btn" disabled={date >= today} onClick={() => setDate(addDays(date, 1))}>
            {t(lang, 'ops.next')}
          </button>
          <input className="input" type="date" aria-label={t(lang, 'ops.date')} value={date} max={today} onChange={(e) => e.target.value !== '' && e.target.value <= today && setDate(e.target.value)} />
        </div>
        {ops.isHistorical ? <p className="qa-warning" role="note">{t(lang, 'ops.historicalNote', { date })}</p> : null}
      </header>

      <section className="dr-section" aria-labelledby="ops-situation">
        <h2 id="ops-situation">
          {t(lang, 'ops.situation.title')} {currentTag}
        </h2>
        {s.activeProjects === 0 ? (
          <p className="exec-help">{t(lang, 'ops.situation.noneActive')}</p>
        ) : (
          <>
            <div className="metrics-grid">
              <MetricCard label={t(lang, 'ops.situation.active', { n: s.activeProjects })} value={String(s.activeProjects)} />
              <MetricCard label={t(lang, 'readiness.state.blocked')} value={String(s.blockedProjects)} tone={s.blockedProjects > 0 ? 'bad' : 'default'} />
              <MetricCard label={t(lang, 'readiness.state.atRisk')} value={String(s.atRiskProjects)} tone={s.atRiskProjects > 0 ? 'warn' : 'default'} />
              <MetricCard label={t(lang, 'readiness.state.ready')} value={String(s.readyProjects)} tone={s.readyProjects > 0 ? 'good' : 'default'} />
            </div>
            <p className="exec-help">{t(lang, 'ops.situation.testers', { planned: s.plannedTesters, assigned: s.assignedTesters, actual: s.actualTesters })}</p>
            <p className="exec-help">{t(lang, 'ops.situation.withExecution', { n: s.testersWithExecution })}</p>
            <p className="exec-help">{t(lang, 'ops.situation.execution', { saved: s.execution.savedExecuted, unique: s.execution.uniqueCasesExecuted, events: s.execution.executionEvents })}</p>
            {s.workTypeBreakdown.length > 0 ? (
              <ul className="work-mix-list">
                {s.workTypeBreakdown.map((w) => (
                  <li key={w.workType}>
                    <span className={`tag qa-worktype qa-worktype-${w.workType}`}>{t(lang, `qa.workType.${w.workType}` as TranslationKey)}</span> <strong>{t(lang, 'qa.workMix.cases', { n: formatInteger(w.cases, lang) })}</strong>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </section>

      <section className="dr-section" aria-labelledby="ops-attention">
        <h2 id="ops-attention">
          {t(lang, 'ops.attention.title')} {currentTag}
        </h2>
        {s.attentionItems.length === 0 ? (
          <p className="exec-help">{t(lang, 'ops.attention.empty')}</p>
        ) : (
          <ol className="ops-attention-list">
            {s.attentionItems.map((a) => {
              const target = TARGET[a.category];
              return (
                <li key={`${a.projectId}-${a.reasonCode}`} className={`ops-attention ops-attention-${a.severity}`}>
                  <span className="tag">{t(lang, `ops.priority.${a.priority}` as TranslationKey)}</span> <strong>{a.projectName}</strong> — {readinessReasonText(lang, a.reason)}{' '}
                  <button type="button" className="btn btn-ghost" onClick={() => (a.category === 'schedule' ? onOpenGantt(a.projectRecordId) : onNavigate(target.screen))}>
                    {t(lang, 'ops.attention.open')}: {t(lang, target.key)}
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section className="dr-section" aria-labelledby="ops-testing">
        <h2 id="ops-testing">{t(lang, 'ops.testing.title')} — {date}</h2>
        {tested.length === 0 ? (
          <p className="exec-help">{t(lang, 'ops.testing.empty')}</p>
        ) : (
          <>
            <p className="exec-help">{t(lang, 'ops.testing.note')}</p>
            <div className="table-wrap">
              <table className="dr-table">
                <thead>
                  <tr>
                    <th scope="col">{t(lang, 'ops.col.project')}</th>
                    <th scope="col">{t(lang, 'ops.col.workTypes')}</th>
                    <th scope="col" className="num">{t(lang, 'ops.col.saved')}</th>
                    <th scope="col" className="num">{t(lang, 'tm.status.pass')}</th>
                    <th scope="col" className="num">{t(lang, 'tm.status.fail')}</th>
                    <th scope="col" className="num">{t(lang, 'tm.status.blocked')}</th>
                    <th scope="col">{t(lang, 'ops.col.source')}</th>
                    <th scope="col" className="num">{t(lang, 'ops.col.unique')}</th>
                    <th scope="col" className="num">{t(lang, 'ops.col.events')}</th>
                    <th scope="col" className="num">{t(lang, 'exec.actualTesters')}</th>
                  </tr>
                </thead>
                <tbody>
                  {tested.map((p) => (
                    <tr key={p.projectId}>
                      <th scope="row">{p.projectName}</th>
                      <td>
                        <WorkTypeChips lang={lang} types={p.workTypes} />
                      </td>
                      <td className="num">{num(p.saved?.executed ?? null, lang)}</td>
                      <td className="num">{num(p.saved?.passed ?? null, lang)}</td>
                      <td className="num">{num(p.saved?.failed ?? null, lang)}</td>
                      <td className="num">{num(p.saved?.blocked ?? null, lang)}</td>
                      <td>{p.saved === null ? '—' : t(lang, executionSourceLabelKey(p.saved.source))}</td>
                      <td className="num">{formatInteger(p.detailed.uniqueCasesExecuted, lang)}</td>
                      <td className="num">{formatInteger(p.detailed.eventCount, lang)}</td>
                      <td className="num">{num(p.staffing.actual, lang)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {tested.some((p) => p.detailedByWorkType.length > 0) ? (
              <ul className="work-mix-list">
                {tested.flatMap((p) =>
                  p.detailedByWorkType
                    .filter((d) => d.uniqueCasesExecuted > 0)
                    .map((d) => (
                      <li key={`${p.projectId}-${d.workType}`}>
                        <span className={`tag qa-worktype qa-worktype-${d.workType}`}>{t(lang, `qa.workType.${d.workType}` as TranslationKey)}</span> {p.projectName}:{' '}
                        <strong>{t(lang, 'qa.workMix.cases', { n: d.uniqueCasesExecuted })}</strong> <span className="exec-help">{d.passed} {t(lang, 'tm.status.pass')} · {d.failed} {t(lang, 'tm.status.fail')} · {d.blocked} {t(lang, 'tm.status.blocked')}</span>
                      </li>
                    )),
                )}
              </ul>
            ) : null}
          </>
        )}
      </section>

      <section className="dr-section" aria-labelledby="ops-staffing">
        <h2 id="ops-staffing">{t(lang, 'ops.staffing.title')}</h2>
        <p className="exec-help">{t(lang, 'ops.staffing.note')}</p>
        {ops.projects.filter((p) => p.status === 'ongoing' || p.status === 'extended').length === 0 ? (
          <p className="exec-help">{t(lang, 'ops.situation.noneActive')}</p>
        ) : (
          <div className="table-wrap">
            <table className="dr-table">
              <thead>
                <tr>
                  <th scope="col">{t(lang, 'ops.col.project')}</th>
                  <th scope="col" className="num">{t(lang, 'fields.currentTesters')}</th>
                  <th scope="col" className="num">{t(lang, 'capacity.assigned')}</th>
                  <th scope="col" className="num">{t(lang, 'exec.actualTesters')}</th>
                  <th scope="col" className="num">{t(lang, 'readiness.metric.staffingGap')}</th>
                </tr>
              </thead>
              <tbody>
                {ops.projects
                  .filter((p) => p.status === 'ongoing' || p.status === 'extended')
                  .map((p) => (
                    <tr key={p.projectId}>
                      <th scope="row">{p.projectName}</th>
                      <td className="num">{formatInteger(p.staffing.planned, lang)}</td>
                      <td className="num">{formatInteger(p.staffing.assigned, lang)}</td>
                      <td className="num">{num(p.staffing.actual, lang)}</td>
                      <td className="num">{formatInteger(Math.max(0, p.staffing.gap), lang)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="dr-button-row">
          <button type="button" className="btn btn-ghost" onClick={() => onNavigate('team')}>
            {t(lang, 'ops.staffing.manage')}
          </button>
        </div>
        <h3>{t(lang, 'ops.allocation.title')}</h3>
        {ops.allocation.length === 0 ? (
          <p className="exec-help">{t(lang, 'ops.allocation.empty')}</p>
        ) : (
          <ul className="ops-allocation">
            {ops.allocation.map((a) => (
              <li key={a.key}>
                <strong>{a.name}</strong>{' '}
                {a.assignments.map((x, i) => (
                  <span key={i} className="exec-help">
                    {x.projectName}
                    {x.scopeId === null ? ` (${t(lang, 'ops.allocation.allScopes')})` : ''}
                    {x.workType === null ? '' : <WorkTypeChips lang={lang} types={[x.workType]} />}
                    {i < a.assignments.length - 1 ? '; ' : ''}
                  </span>
                ))}{' '}
                {a.noExecutionRecorded ? <span className="gap-pill">{t(lang, 'ops.allocation.none')}</span> : <span className="exec-help">{t(lang, 'ops.allocation.events', { events: a.eventsToday, unique: a.uniqueCasesToday })}{a.recordedCasesToday === null ? '' : ` · ${t(lang, 'ops.allocation.recorded', { n: a.recordedCasesToday })}`}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="dr-section" aria-labelledby="ops-schedule">
        <h2 id="ops-schedule">
          {t(lang, 'ops.schedule.title')} {currentTag}
        </h2>
        <p className="exec-help">{t(lang, 'ops.schedule.note')}</p>
        {ranked.length === 0 ? (
          <p className="exec-help">{t(lang, 'ops.situation.noneActive')}</p>
        ) : (
          <div className="table-wrap">
            <table className="dr-table">
              <thead>
                <tr>
                  <th scope="col">{t(lang, 'ops.col.project')}</th>
                  <th scope="col">{t(lang, 'ops.col.readiness')}</th>
                  <th scope="col">{t(lang, 'ops.col.schedule')}</th>
                  <th scope="col">{t(lang, 'ops.col.plannedEnd')}</th>
                  <th scope="col">{t(lang, 'ops.col.projected')}</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {ranked.map((p) => (
                  <tr key={p.projectId}>
                    <th scope="row">{p.projectName}</th>
                    <td>
                      <ReadinessBadge lang={lang} readiness={p.readiness} />
                    </td>
                    <td>
                      {t(lang, `ops.schedule.${p.schedule.state}` as TranslationKey)}
                      {p.schedule.daysLate === null ? '' : ` (${t(lang, 'ops.schedule.daysLate', { n: p.schedule.daysLate })})`}
                    </td>
                    <td>{p.schedule.plannedEnd ?? '—'}</td>
                    <td>{p.schedule.projectedFinish ?? '—'}</td>
                    <td>
                      <button type="button" className="btn btn-ghost" onClick={() => onOpenGantt(p.projectRecordId)}>
                        {t(lang, 'ops.schedule.open')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="dr-section" aria-labelledby="ops-changes">
        <h2 id="ops-changes">{t(lang, 'ops.changes.title')} — {date}</h2>
        {ops.changes.passEvents + ops.changes.failEvents + ops.changes.blockedEvents === 0 && ops.changes.criticalTicketsRecorded === 0 ? (
          <p className="exec-help">{t(lang, 'ops.changes.empty')}</p>
        ) : (
          <ul>
            <li>{t(lang, 'ops.changes.first', { n: ops.changes.casesFirstExecuted })}</li>
            <li>{t(lang, 'ops.changes.statusChanged', { n: ops.changes.casesStatusChanged, passed: ops.changes.casesNewlyPassed, failed: ops.changes.casesNewlyFailed })}</li>
            <li>{t(lang, 'ops.changes.events', { pass: ops.changes.passEvents, fail: ops.changes.failEvents, blocked: ops.changes.blockedEvents })}</li>
            {ops.changes.retestRaised > 0 ? <li>{t(lang, 'ops.changes.retest', { n: ops.changes.retestRaised })}</li> : null}
            {ops.changes.criticalTicketsRecorded > 0 ? <li>{t(lang, 'ops.changes.critical', { n: ops.changes.criticalTicketsRecorded })}</li> : null}
          </ul>
        )}
        {ops.comparison === null ? (
          <p className="exec-help">{t(lang, 'ops.compare.none')}</p>
        ) : (
          <div className="metrics-grid">
            <MetricCard label={`${t(lang, 'ops.compare.unique')} (${t(lang, 'ops.compare.title', { date: ops.comparison.previous.date })})`} value={`${ops.comparison.current.uniqueCasesExecuted} (${delta(ops.comparison.current.uniqueCasesExecuted, ops.comparison.previous.uniqueCasesExecuted)})`} />
            <MetricCard label={t(lang, 'ops.compare.failed')} value={`${ops.comparison.current.failedCases} (${delta(ops.comparison.current.failedCases, ops.comparison.previous.failedCases)})`} />
            <MetricCard label={t(lang, 'ops.compare.saved')} value={`${ops.comparison.current.savedExecuted} (${delta(ops.comparison.current.savedExecuted, ops.comparison.previous.savedExecuted)})`} />
            <MetricCard label={t(lang, 'ops.compare.actual')} value={`${ops.comparison.current.actualTesters} (${delta(ops.comparison.current.actualTesters, ops.comparison.previous.actualTesters)})`} />
          </div>
        )}
      </section>

      <section className="dr-section" aria-labelledby="ops-defects">
        <h2 id="ops-defects">
          {t(lang, 'ops.defects.title')} {currentTag}
        </h2>
        {ranked.every((p) => p.tickets.criticalUnresolved + p.tickets.openOrInProgress + p.tickets.statusUnknownCritical === 0) ? (
          <p className="exec-help">{t(lang, 'ops.defects.none')}</p>
        ) : (
          <ul>
            {ranked
              .filter((p) => p.tickets.criticalUnresolved + p.tickets.openOrInProgress + p.tickets.statusUnknownCritical > 0)
              .map((p) => (
                <li key={p.projectId}>
                  <strong>{p.projectName}</strong>: {t(lang, 'ops.defects.critical', { n: p.tickets.criticalUnresolved })} · {t(lang, 'ops.defects.open', { n: p.tickets.openOrInProgress })}
                  {p.tickets.statusUnknownCritical > 0 ? ` · ${t(lang, 'ops.defects.unknown', { n: p.tickets.statusUnknownCritical })}` : ''}
                </li>
              ))}
          </ul>
        )}
        <button type="button" className="btn btn-ghost" onClick={() => onNavigate('tickets')}>
          {t(lang, 'ops.defects.open_link')}
        </button>
        <h3>{t(lang, 'ops.failures.title')}</h3>
        {ops.failures.items.length === 0 ? (
          <p className="exec-help">{t(lang, 'ops.failures.none')}</p>
        ) : (
          <>
            <p className="exec-help">{t(lang, 'ops.failures.summary', { failed: ops.failures.failedToday, blocked: ops.failures.blockedToday })}</p>
            <ul>
              {ops.failures.items.map((f) => (
                <li key={`${f.projectId}-${f.key}`}>
                  <span className="tag">{t(lang, `tm.status.${f.status}` as TranslationKey)}</span> {f.projectName} · {f.scopeName} · {f.key} {f.title}
                </li>
              ))}
            </ul>
            {ops.failures.topScopes.length > 0 ? (
              <p className="exec-help">
                {t(lang, 'ops.failures.topScopes')}: {ops.failures.topScopes.map((x) => `${x.scopeName} (${x.failed})`).join(', ')}
              </p>
            ) : null}
            <button type="button" className="btn btn-ghost" onClick={() => onNavigate('testManagement')}>
              {t(lang, 'ops.failures.viewAll')}
            </button>
          </>
        )}
      </section>

      <section className="dr-section" aria-labelledby="ops-report">
        <h2 id="ops-report">{t(lang, 'ops.report.title')} — {date}</h2>
        <p className="exec-help">{t(lang, 'ops.report.note')}</p>
        <p>
          {t(lang, 'ops.report.status')}: <span className="gap-pill">{t(lang, `ops.report.status.${reportState}` as TranslationKey)}</span>
        </p>
        {reportState === 'finalized' ? (
          <p className="exec-help">{t(lang, 'dailyReport.prepare.finalizedNote')}</p>
        ) : (
          <>
            <p>{preview.staffing === '' ? t(lang, 'dailyReport.prepare.missing.noStaffing') : preview.staffing}</p>
            <h3>{t(lang, 'ops.report.activities')}</h3>
            {preview.activities === '' ? <p className="exec-help">{t(lang, 'ops.report.noActivities')}</p> : <pre className="dr-progress-preview">{preview.activities}</pre>}
            <h3>{t(lang, 'ops.report.topics')}</h3>
            {prepared.topics.length === 0 ? (
              <p className="exec-help">{t(lang, 'ops.attention.empty')}</p>
            ) : (
              <ul>
                {prepared.topics.map((topic) => (
                  <li key={`${topic.projectId}-${topic.code}`}>{preparedTopicLine(lang, topic)}</li>
                ))}
              </ul>
            )}
            {prepared.currentContext.length > 0 ? (
              <>
                <h3>{t(lang, 'ops.report.contextHistorical')}</h3>
                <ul className="exec-help">
                  {prepared.currentContext.map((a) => (
                    <li key={`${a.projectId}-${a.reasonCode}`}>
                      {a.projectName} — {readinessReasonText(lang, a.reason)}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {prepared.missing.length > 0 ? (
              <p className="exec-help">
                {t(lang, 'ops.report.missing')}: {prepared.missing.map((m) => t(lang, MISSING_KEY[m])).join(' ')}
              </p>
            ) : null}
          </>
        )}
        <button type="button" className="btn btn-primary" onClick={() => onPrepareReport(date)}>
          {t(lang, reportState === 'draft' ? 'ops.report.continue' : reportState === 'finalized' ? 'ops.report.viewFinal' : 'ops.report.prepare')}
        </button>
      </section>
    </div>
  );
}

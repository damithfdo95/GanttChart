import { useMemo, useState } from 'react';
import { useAppStateCtx, useReportsStateCtx } from '../../app/state-contexts';
import { t, type TranslationKey } from '../../i18n';
import { businessDate } from '../../../shared/businessTime';
import { MetricCard } from '../../components/MetricCard';
import { formatInteger, formatNumber } from '../../lib/formatting/format';
import { buildXlsx } from '../../lib/export/xlsx';
import { downloadBinaryFile } from '../../lib/export/download';
import { improvementSheets } from '../../lib/export/exportData';
import { XLSX_MIME } from '../../lib/statusKeys';
import {
  buildQaImprovementAnalytics,
  presetRange,
  WORK_TYPE_ORDER,
  type AnalyticsRange,
  type AnalyticsSignal,
  type ComparisonRow,
  type QaImprovementAnalytics,
  type WorkTypeFilter,
} from '../../domain/qaImprovementAnalytics';
import type { Language } from '../../types';

type Preset = 7 | 30 | 90 | 'custom';

const pct = (r: number | null): string => (r === null ? '—' : `${(r * 100).toFixed(1)}%`);
const signed = (n: number, digits = 1): string => `${n > 0 ? '+' : ''}${n.toFixed(digits)}`;

/** One sentence of an Areas to Review / Improved item: numbers are formatted here, the words come from the dictionary. */
export function signalText(lang: Language, s: AnalyticsSignal): string {
  const v = s.values;
  const n = (x: number | string | undefined, digits = 0): string => (typeof x === 'number' ? Math.abs(x).toFixed(digits) : String(x ?? ''));
  const vars: Record<string, string | number> = {
    percent: n(v.percent),
    pp: n(v.pp, 1),
    current: typeof v.current === 'number' ? (s.id === 'staffingVariance' ? v.current.toFixed(1) : s.id.endsWith('Rate') || s.id === 'onTimeReleases' || s.id === 'blockerPersistence' ? v.current.toFixed(1) : formatInteger(v.current, lang)) : '',
    previous: typeof v.previous === 'number' ? (s.id === 'staffingVariance' ? v.previous.toFixed(1) : s.id.endsWith('Rate') || s.id === 'onTimeReleases' || s.id === 'blockerPersistence' ? v.previous.toFixed(1) : formatInteger(v.previous, lang)) : '',
    days: n(v.days),
    of: n(v.of),
    count: n(v.count),
    workType: typeof v.workType === 'string' ? t(lang, `qa.workType.${v.workType}` as TranslationKey) : '',
  };
  return t(lang, `ia.sig.${s.id}.${s.kind}` as TranslationKey, vars);
}

interface Series {
  key: string;
  label: string;
  values: Array<number | null>;
  dash?: string;
}

/** A simple line chart: title, legend with line styles (not colour alone), and the same numbers in a table. */
function LineChart({ lang, title, labels, series, digits = 0, legend = true }: { lang: Language; title: string; labels: string[]; series: Series[]; digits?: number; legend?: boolean }) {
  const all = series.flatMap((s) => s.values).filter((x): x is number => x !== null);
  if (all.length === 0) {
    return (
      <figure className="ia-chart">
        <figcaption>{title}</figcaption>
        <p className="exec-help">{t(lang, 'ia.chart.noData')}</p>
      </figure>
    );
  }
  const W = 640;
  const H = 180;
  const pad = { l: 40, r: 10, t: 10, b: 24 };
  const max = Math.max(...all, 1);
  const x = (i: number): number => pad.l + (labels.length <= 1 ? (W - pad.l - pad.r) / 2 : (i * (W - pad.l - pad.r)) / (labels.length - 1));
  const y = (v: number): number => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  const COLORS = ['var(--accent, #1a56db)', 'var(--text, #1f2733)'];
  return (
    <figure className="ia-chart">
      <figcaption>{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}: ${series.map((s) => s.label).join(', ')}`} className="ia-svg">
        <line x1={pad.l} y1={H - pad.b} x2={W - pad.r} y2={H - pad.b} stroke="currentColor" strokeOpacity="0.4" />
        <line x1={pad.l} y1={pad.t} x2={pad.l} y2={H - pad.b} stroke="currentColor" strokeOpacity="0.4" />
        <text x={pad.l - 4} y={pad.t + 8} textAnchor="end" fontSize="10" fill="currentColor">{formatNumber(max, digits, lang)}</text>
        <text x={pad.l - 4} y={H - pad.b} textAnchor="end" fontSize="10" fill="currentColor">0</text>
        <text x={pad.l} y={H - 8} fontSize="10" fill="currentColor">{labels[0]}</text>
        <text x={W - pad.r} y={H - 8} textAnchor="end" fontSize="10" fill="currentColor">{labels[labels.length - 1]}</text>
        {series.map((s, si) => {
          const segments: string[] = [];
          let open = false;
          s.values.forEach((v, i) => {
            if (v === null) {
              open = false;
              return;
            }
            segments.push(`${open ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`);
            open = true;
          });
          return (
            <g key={s.key}>
              <path d={segments.join(' ')} fill="none" stroke={COLORS[si % COLORS.length]} strokeWidth="2" {...(s.dash === undefined ? {} : { strokeDasharray: s.dash })} />
              {s.values.map((v, i) => (v === null ? null : <circle key={i} cx={x(i)} cy={y(v)} r={si === 0 ? 2.5 : 2} fill={COLORS[si % COLORS.length]} />))}
            </g>
          );
        })}
      </svg>
      {legend ? (
        <p className="exec-help">
          {series.map((s) => (
            <span key={s.key} style={{ marginRight: 12 }}>
              <svg width="28" height="8" aria-hidden="true">
                <line x1="0" y1="4" x2="28" y2="4" stroke="currentColor" strokeWidth="2" {...(s.dash === undefined ? {} : { strokeDasharray: s.dash })} />
              </svg>{' '}
              {s.label}
            </span>
          ))}
        </p>
      ) : null}
      <details>
        <summary>{t(lang, 'ia.chart.table')}</summary>
        <div className="table-wrap">
          <table className="dr-table">
            <thead>
              <tr>
                <th scope="col">{t(lang, 'ia.col.date')}</th>
                {series.map((s) => (
                  <th key={s.key} scope="col">{s.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {labels.map((label, i) => (
                <tr key={label}>
                  <td>{label}</td>
                  {series.map((s) => (
                    <td key={s.key}>{s.values[i] === null || s.values[i] === undefined ? '—' : formatNumber(s.values[i] as number, digits, lang)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

function BarChart({ lang, title, rows }: { lang: Language; title: string; rows: Array<{ label: string; value: number }> }) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <figure className="ia-chart">
      <figcaption>{title}</figcaption>
      {rows.length === 0 ? (
        <p className="exec-help">{t(lang, 'ia.chart.noData')}</p>
      ) : (
        <ul className="ia-bars" aria-label={title}>
          {rows.map((r) => (
            <li key={r.label}>
              <span className="ia-bar-label">{r.label}</span>
              <span className="ia-bar" aria-hidden="true">
                <span style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} />
              </span>
              <span className="ia-bar-value">{formatInteger(r.value, lang)}</span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}

function changeText(row: ComparisonRow | undefined, kind: 'percent' | 'pp' | 'abs'): string {
  if (row === undefined) return '—';
  if (kind === 'percent') return row.percent === null ? '—' : `${row.percent > 0 ? '+' : ''}${(row.percent * 100).toFixed(0)}%`;
  if (row.absolute === null) return '—';
  return kind === 'pp' ? `${signed(row.absolute * 100)} pp` : signed(row.absolute, 1);
}

/** Management view of QA process improvement over time. Everything shown is derived from the workspace (no network call, nothing stored). */
export function ImprovementAnalytics() {
  const lang = useAppStateCtx().state.language;
  const { state } = useReportsStateCtx();
  const today = businessDate();
  const [preset, setPreset] = useState<Preset>(30);
  const [custom, setCustom] = useState<AnalyticsRange>(presetRange(30, today));
  const [projectId, setProjectId] = useState<string>('');
  const [workType, setWorkType] = useState<WorkTypeFilter>('all');
  const [message, setMessage] = useState<string | null>(null);
  const range = useMemo(() => (preset === 'custom' ? custom : presetRange(preset, today)), [preset, custom, today]);

  const a: QaImprovementAnalytics = useMemo(
    () =>
      buildQaImprovementAnalytics({
        projects: state.projects,
        scopes: state.scopes ?? [],
        caseExecution: state.caseExecutions ?? [],
        assignments: state.testerAssignments ?? [],
        members: state.rcsMembers ?? [],
        range,
        today,
        projectId: projectId === '' ? null : projectId,
        workType,
      }),
    [state.projects, state.scopes, state.caseExecutions, state.testerAssignments, state.rcsMembers, range, today, projectId, workType],
  );

  const s = a.summary;
  const cmp = (m: ComparisonRow['metric']): ComparisonRow | undefined => a.comparison.find((r) => r.metric === m);
  const withChange = (value: string, row: ComparisonRow | undefined, kind: 'percent' | 'pp' | 'abs'): string => {
    const c = changeText(row, kind);
    return c === '—' ? value : `${value}  (${c})`;
  };
  const dayLabels = a.days.map((d) => d.date.slice(5));
  const noProjects = a.projects.length === 0;
  const noHistory = !a.history.hasEvents;
  const allProjects = useMemo(() => [...state.projects].sort((x, y) => (x.nameEn || x.projectId).localeCompare(y.nameEn || y.projectId)), [state.projects]);

  const exportWorkbook = (): void => {
    downloadBinaryFile(`ganttchart-qa-improvement-${a.range.from}_${a.range.to}.xlsx`, XLSX_MIME, buildXlsx(improvementSheets(lang, a)));
    setMessage(t(lang, 'ia.export.exported'));
  };

  const SignalList = ({ items, empty }: { items: AnalyticsSignal[]; empty: TranslationKey }) =>
    items.length === 0 ? (
      <p className="exec-help">{t(lang, empty)}</p>
    ) : (
      <ul className="ia-signals">
        {items.map((sig, i) => (
          <li key={`${sig.id}-${i}`}>
            {signalText(lang, sig)}
            {sig.projects.length > 0 ? (
              <details>
                <summary>{t(lang, 'ia.details')}</summary>
                <ul>
                  {sig.projects.map((p) => (
                    <li key={p.projectId}>{p.projectName}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </li>
        ))}
      </ul>
    );

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title-group">
          <h1>{t(lang, 'ia.title')}</h1>
          <p className="exec-help">{t(lang, 'ia.note')}</p>
        </div>
      </header>

      <section className="dr-section" aria-label={t(lang, 'ia.range.label')}>
        <div className="dr-button-row" role="group" aria-label={t(lang, 'ia.range.label')}>
          {([7, 30, 90, 'custom'] as const).map((p) => (
            <button key={String(p)} type="button" className={preset === p ? 'btn btn-primary' : 'btn'} aria-pressed={preset === p} onClick={() => setPreset(p)}>
              {t(lang, p === 'custom' ? 'ia.range.custom' : (`ia.range.d${p}` as TranslationKey))}
            </button>
          ))}
        </div>
        {preset === 'custom' ? (
          <div className="dr-button-row">
            <label>
              {t(lang, 'ia.range.from')} <input type="date" value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
            </label>
            <label>
              {t(lang, 'ia.range.to')} <input type="date" value={custom.to} max={today} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
            </label>
          </div>
        ) : null}
        <div className="dr-button-row">
          <label>
            {t(lang, 'ia.filter.project')}{' '}
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">{t(lang, 'ia.filter.allProjects')}</option>
              {allProjects.map((p) => (
                <option key={p.projectId} value={p.projectId}>{p.nameEn || p.nameJa || p.projectId}</option>
              ))}
            </select>
          </label>
          <label>
            {t(lang, 'ia.filter.workType')}{' '}
            <select value={workType} onChange={(e) => setWorkType(e.target.value as WorkTypeFilter)}>
              <option value="all">{t(lang, 'ia.filter.allTypes')}</option>
              {WORK_TYPE_ORDER.map((w) => (
                <option key={w} value={w}>{t(lang, `qa.workType.${w}` as TranslationKey)}</option>
              ))}
            </select>
          </label>
          <button type="button" className="btn" onClick={exportWorkbook}>{t(lang, 'ia.export')}</button>
        </div>
        <p className="exec-help">{a.range.from} – {a.range.to} · {t(lang, a.basis === 'saved' ? 'ia.basis.saved' : 'ia.basis.history')}</p>
        <p className="exec-help">{t(lang, 'ia.rule.inclusion')}</p>
        {message !== null ? <p className="dr-message ok" role="status">{message}</p> : null}
        {a.history.partial && a.history.firstEventDate !== null ? <p className="qa-warning" role="note">{t(lang, 'ia.warn.partial', { date: a.history.firstEventDate })}</p> : null}
      </section>

      {noProjects ? (
        <p className="dr-empty">{t(lang, 'ia.empty.noProjects')}</p>
      ) : (
        <>
          <section className="dr-section" aria-labelledby="ia-summary">
            <h2 id="ia-summary">{t(lang, 'ia.summary.title')}</h2>
            <p className="exec-help">{t(lang, 'ia.summary.compare', { from: a.range.from, to: a.range.to, pfrom: a.previousRange.from, pto: a.previousRange.to })}</p>
            <div className="metrics-grid">
              <MetricCard label={t(lang, 'ia.m.completed')} value={s.completed === 0 && a.days.every((d) => d.completed === null) ? '—' : withChange(formatInteger(s.completed, lang), cmp('completed'), 'percent')} />
              <MetricCard label={t(lang, 'ia.m.failureRate')} value={withChange(pct(s.failureRate), cmp('failureRate'), 'pp')} />
              <MetricCard label={t(lang, 'ia.m.retest')} value={noHistory ? '—' : withChange(formatInteger(s.retestEvents, lang), cmp('retestEvents'), 'percent')} />
              <MetricCard label={t(lang, 'ia.m.events')} value={noHistory ? '—' : withChange(formatInteger(s.executionEvents, lang), cmp('executionEvents'), 'percent')} />
              <MetricCard label={t(lang, 'ia.m.unique')} value={noHistory ? '—' : withChange(formatInteger(s.uniqueCases, lang), cmp('uniqueCases'), 'percent')} />
              <MetricCard label={t(lang, 'ia.m.avgActual')} value={s.avgActualTesters === null ? '—' : formatNumber(s.avgActualTesters, 1, lang)} />
              <MetricCard label={t(lang, 'ia.m.releases')} value={formatInteger(s.completedReleases, lang)} />
              <MetricCard label={t(lang, 'ia.m.late')} value={s.completedReleases === 0 ? '—' : formatInteger(s.lateReleases, lang)} tone={s.lateReleases > 0 ? 'warn' : 'default'} />
            </div>
            <p className="exec-help">{t(lang, 'ia.unit.note')}</p>
          </section>

          <section className="dr-section" aria-labelledby="ia-review">
            <h2 id="ia-review">{t(lang, 'ia.review.title')}</h2>
            <SignalList items={a.signals.review} empty="ia.review.none" />
            <h2 id="ia-improved">{t(lang, 'ia.improved.title')}</h2>
            <SignalList items={a.signals.improved} empty="ia.improved.none" />
          </section>

          <section className="dr-section" aria-labelledby="ia-trend">
            <h2 id="ia-trend">{t(lang, 'ia.sec.trend')}</h2>
            {noHistory && a.basis === 'history' ? <p className="exec-help">{t(lang, 'ia.empty.noHistory')}</p> : null}
            <LineChart lang={lang} title={t(lang, 'ia.chart.completed')} labels={dayLabels} series={[{ key: 'completed', label: t(lang, 'ia.m.completed'), values: a.days.map((d) => d.completed) }]} legend={false} />
            <LineChart lang={lang} title={t(lang, 'ia.chart.failure')} labels={a.weeks.map((w) => t(lang, 'ia.week', { date: w.weekStart }))} series={[{ key: 'rate', label: t(lang, 'ia.m.failureRate') + ' %', values: a.weeks.map((w) => (w.failureRate === null ? null : w.failureRate * 100)) }]} digits={1} legend={false} />
            <LineChart lang={lang} title={t(lang, 'ia.chart.retest')} labels={dayLabels} series={[{ key: 'retest', label: t(lang, 'ia.m.retest'), values: a.days.map((d) => d.retestEvents) }]} legend={false} />
            {noHistory ? null : <p className="exec-help">{t(lang, 'ia.m.repeated')}: {formatInteger(s.casesRunMoreThanOnce, lang)} · {t(lang, 'ia.m.retestPer100')}: {s.retestPer100Events === null ? '—' : formatNumber(s.retestPer100Events, 1, lang)}</p>}
            <p className="exec-help">{t(lang, 'ia.m.blockedDays')}: {a.basis === 'saved' && s.activeProjectDays === 0 ? '—' : `${formatInteger(s.blockedProjectDays, lang)} / ${formatInteger(s.activeProjectDays, lang)}`}</p>
          </section>

          <section className="dr-section" aria-labelledby="ia-wt">
            <h2 id="ia-wt">{t(lang, 'ia.sec.workTypes')}</h2>
            {a.workTypes.length === 0 ? (
              <p className="exec-help">{t(lang, 'ia.empty.noHistory')}</p>
            ) : (
              <>
                <BarChart lang={lang} title={t(lang, 'ia.chart.workType')} rows={a.workTypes.map((w) => ({ label: t(lang, `qa.workType.${w.workType}` as TranslationKey), value: w.completedCases }))} />
                <div className="table-wrap">
                  <table className="dr-table">
                    <thead>
                      <tr>
                        <th scope="col">{t(lang, 'ia.col.workType')}</th>
                        <th scope="col">{t(lang, 'ia.col.scopes')}</th>
                        <th scope="col">{t(lang, 'ia.col.completed')}</th>
                        <th scope="col">{t(lang, 'ia.col.perDay')}</th>
                        <th scope="col">{t(lang, 'ia.col.failureRate')}</th>
                        <th scope="col">{t(lang, 'ia.col.events')}</th>
                        <th scope="col">{t(lang, 'ia.col.unique')}</th>
                        <th scope="col">{t(lang, 'ia.col.retest')}</th>
                        <th scope="col">{t(lang, 'ia.col.retestPer100')}</th>
                        <th scope="col">{t(lang, 'ia.col.tickets')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {a.workTypes.map((w) => (
                        <tr key={w.workType}>
                          <td>{t(lang, `qa.workType.${w.workType}` as TranslationKey)}</td>
                          <td>{w.scopes}</td>
                          <td>{formatInteger(w.completedCases, lang)}</td>
                          <td>{w.completedPerActiveDay === null ? '—' : formatNumber(w.completedPerActiveDay, 1, lang)}</td>
                          <td>{pct(w.failureRate)}</td>
                          <td>{formatInteger(w.events, lang)}</td>
                          <td>{formatInteger(w.uniqueCases, lang)}</td>
                          <td>{formatInteger(w.retestEvents, lang)}</td>
                          <td>{w.retestPer100Events === null ? '—' : formatNumber(w.retestPer100Events, 1, lang)}</td>
                          <td>{w.tickets === null ? '—' : formatInteger(w.tickets, lang)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {a.basis === 'saved' && a.workTypes.length > 0 ? <p className="exec-help">{t(lang, 'ia.wt.note')}</p> : null}
            <p className="exec-help">{t(lang, 'ia.sec.tickets')}: {formatInteger(a.tickets.raised, lang)}</p>
          </section>

          {a.staffing === null ? null : (
            <section className="dr-section" aria-labelledby="ia-staffing">
              <h2 id="ia-staffing">{t(lang, 'ia.sec.staffing')}</h2>
              {a.staffing.comparedDays === 0 ? (
                <p className="exec-help">{t(lang, 'ia.empty.noData')}</p>
              ) : (
                <div className="metrics-grid">
                  <MetricCard label={t(lang, 'ia.staffing.compared')} value={formatInteger(a.staffing.comparedDays, lang)} />
                  <MetricCard label={t(lang, 'ia.staffing.avgPlanned')} value={a.staffing.avgPlanned === null ? '—' : formatNumber(a.staffing.avgPlanned, 1, lang)} />
                  <MetricCard label={t(lang, 'ia.staffing.avgActual')} value={a.staffing.avgActual === null ? '—' : formatNumber(a.staffing.avgActual, 1, lang)} />
                  <MetricCard label={t(lang, 'ia.staffing.avgVariance')} value={a.staffing.avgVariance === null ? '—' : signed(a.staffing.avgVariance)} />
                  <MetricCard label={t(lang, 'ia.staffing.under')} value={formatInteger(a.staffing.understaffedDays, lang)} />
                  <MetricCard label={t(lang, 'ia.staffing.over')} value={formatInteger(a.staffing.overPlannedDays, lang)} />
                </div>
              )}
              <p className="exec-help">{t(lang, 'ia.staffing.missing')}: {formatInteger(a.staffing.missingActualDays, lang)}</p>
              <LineChart lang={lang} title={t(lang, 'ia.chart.staffing')} labels={dayLabels} series={[{ key: 'actual', label: t(lang, 'ia.legend.actual'), values: a.days.map((d) => d.actualTesters) }, { key: 'planned', label: t(lang, 'ia.legend.planned'), values: a.days.map((d) => d.plannedTesters), dash: '6 4' }]} />
              <p className="exec-help">{t(lang, 'ia.staffing.note')}</p>
            </section>
          )}

          <section className="dr-section" aria-labelledby="ia-releases">
            <h2 id="ia-releases">{t(lang, 'ia.sec.releases')}</h2>
            {a.releases.length === 0 ? (
              <p className="exec-help">{t(lang, 'ia.empty.noReleases')}</p>
            ) : (
              <div className="table-wrap">
                <table className="dr-table table-wide">
                  <thead>
                    <tr>
                      <th scope="col">{t(lang, 'ia.col.project')}</th>
                      <th scope="col">{t(lang, 'ia.col.plannedFinish')}</th>
                      <th scope="col">{t(lang, 'ia.col.actualCompletion')}</th>
                      <th scope="col">{t(lang, 'ia.col.variance')}</th>
                      <th scope="col">{t(lang, 'ia.col.outcome')}</th>
                      <th scope="col">{t(lang, 'ia.col.completed')}</th>
                      <th scope="col">{t(lang, 'ia.col.failureRate')}</th>
                      <th scope="col">{t(lang, 'ia.col.blockedAtEnd')}</th>
                      <th scope="col">{t(lang, 'ia.col.duration')}</th>
                      <th scope="col">{t(lang, 'ia.col.testers')}</th>
                      <th scope="col">{t(lang, 'ia.col.volume')}</th>
                      <th scope="col">{t(lang, 'ia.col.workMix')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.releases.map((r) => (
                      <tr key={r.projectId}>
                        <td>{r.projectName}</td>
                        <td>{r.plannedFinish ?? '—'}</td>
                        <td>{r.actualCompletion}</td>
                        <td>{r.daysVariance === null ? '—' : `${r.daysVariance > 0 ? '+' : ''}${r.daysVariance}`}</td>
                        <td>{t(lang, `ia.outcome.${r.outcome}` as TranslationKey)}</td>
                        <td>{formatInteger(r.completedCases, lang)}</td>
                        <td>{pct(r.failureRate)}</td>
                        <td>{r.blockedAtEnd === null ? '—' : r.blockedAtEnd}</td>
                        <td>{r.plannedDurationDays ?? '—'} / {r.actualDurationDays ?? '—'}</td>
                        <td>{r.plannedAvgTesters === null ? '—' : formatNumber(r.plannedAvgTesters, 1, lang)} / {r.actualAvgTesters === null ? '—' : formatNumber(r.actualAvgTesters, 1, lang)}</td>
                        <td>{formatInteger(r.plannedVolume, lang)}</td>
                        <td>{r.workMix.length === 0 ? '—' : r.workMix.map((m) => `${t(lang, `qa.workType.${m.workType}` as TranslationKey)} ${m.scopes}`).join(', ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="dr-section" aria-labelledby="ia-cmp">
            <h2 id="ia-cmp">{t(lang, 'ia.sec.comparison')}</h2>
            <div className="table-wrap">
              <table className="dr-table">
                <thead>
                  <tr>
                    <th scope="col">{t(lang, 'ia.col.metric')}</th>
                    <th scope="col">{t(lang, 'ia.col.current')}</th>
                    <th scope="col">{t(lang, 'ia.col.previous')}</th>
                    <th scope="col">{t(lang, 'ia.col.change')}</th>
                  </tr>
                </thead>
                <tbody>
                  {a.comparison.map((r) => {
                    const isRate = r.metric === 'failureRate';
                    const fmt = (v: number | null): string => (v === null ? '—' : isRate ? pct(v) : r.metric === 'staffingVariance' ? signed(v) : formatInteger(v, lang));
                    const label: Record<ComparisonRow['metric'], TranslationKey> = { completed: 'ia.m.completed', failureRate: 'ia.m.failureRate', retestEvents: 'ia.m.retest', staffingVariance: 'ia.m.staffingVariance', executionEvents: 'ia.m.events', uniqueCases: 'ia.m.unique' };
                    return (
                      <tr key={r.metric}>
                        <td>{t(lang, label[r.metric])}</td>
                        <td>{fmt(r.current)}</td>
                        <td>{fmt(r.previous)}</td>
                        <td>{changeText(r, isRate ? 'pp' : r.metric === 'staffingVariance' ? 'abs' : 'percent')}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {a.testers.length > 0 ? (
            <section className="dr-section" aria-labelledby="ia-people">
              <h2 id="ia-people">{t(lang, 'ia.sec.people')}</h2>
              <p className="exec-help">{t(lang, 'ia.people.note')}</p>
              <div className="table-wrap">
                <table className="dr-table">
                  <thead>
                    <tr>
                      <th scope="col">{t(lang, 'ia.col.name')}</th>
                      <th scope="col">{t(lang, 'ia.col.events')}</th>
                      <th scope="col">{t(lang, 'ia.col.unique')}</th>
                      <th scope="col">{t(lang, 'ia.col.activeDays')}</th>
                      <th scope="col">{t(lang, 'ia.col.assigned')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.testers.map((p) => (
                      <tr key={p.key}>
                        <td>{p.name}</td>
                        <td>{formatInteger(p.events, lang)}</td>
                        <td>{formatInteger(p.uniqueCases, lang)}</td>
                        <td>{p.activeDays}</td>
                        <td>{p.assignedScopes}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          <section className="dr-section" aria-labelledby="ia-limits">
            <h2 id="ia-limits">{t(lang, 'ia.sec.limits')}</h2>
            <ul>
              <li>{t(lang, 'ia.limit.forecast')}</li>
              <li>{t(lang, 'ia.limit.readiness')}</li>
              <li>{t(lang, 'ia.limit.assignment')}</li>
            </ul>
            {a.assignmentHistory.currentGaps.length > 0 ? (
              <ul className="exec-help">
                {a.assignmentHistory.currentGaps.map((g) => (
                  <li key={g.projectId}>{t(lang, 'ia.limit.currentGap', { project: g.projectName, planned: g.planned, assigned: g.assigned })}</li>
                ))}
              </ul>
            ) : null}
          </section>
        </>
      )}
    </div>
  );
}

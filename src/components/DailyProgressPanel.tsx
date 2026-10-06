import { useMemo } from 'react';
import { useAppStateCtx } from '../app/state-contexts';
import { t } from '../i18n';
import { formatDate, todayEpochDays } from '../lib/dates/dates';
import {
  calculateCurrentGap,
  calculateDailyGaps,
  generateDailyPlan,
} from '../lib/calculations/dailyPlan';
import {
  dayWindowsFromRows,
  projectDayWindowDefaults,
  workdayProductiveHours,
} from '../lib/calculations/workday';
import { entryCompletedCases, sortDailyExecuted } from '../lib/calculations/dailyExecuted';
import { formatCases, formatDuration, formatInteger, formatNumber, minutesToTimeInput } from '../lib/formatting/format';
import { usePagedRows } from '../lib/pagination/usePagedRows';
import { ExecutionHistoryPanel } from './ExecutionHistoryPanel';
import { TablePager } from './TablePager';
import type { DailyTargetOverride } from '../types';

/**
 * Level 2 §3–§4 (V7): automatic daily execution/pass plan (AUTO/MANUAL) and
 * plan-vs-actual gap analysis. Actuals come from the daily execution
 * entries (the single source of truth): the cumulative totals are Σ entries
 * and the end-of-day snapshots are regenerated automatically, so the table
 * below is fully derived — past days are edited through the daily execution
 * form on the OPERATOR view (never by hand here). MANUAL plan rows are
 * stored as overrides and survive recalculation.
 */
export function DailyProgressPanel({
  onEnterExecution,
  onEditEntry,
  onDeleteEntry,
}: {
  onEnterExecution?: () => void;
  /** Load one recorded day into the execution form for editing. */
  onEditEntry?: (date: string) => void;
  /** Delete one recorded day's entry (after confirmation). */
  onDeleteEntry?: (date: string) => void;
}) {
  const { state, updateField } = useAppStateCtx();
  const lang = state.language;
  const today = formatDate(todayEpochDays());

  const productiveHours = workdayProductiveHours(state.startTime, state.dailyOvertimeMinutes);

  const plan = useMemo(
    () =>
      generateDailyPlan(
        state.planningRows,
        state.perHourPerTester,
        productiveHours,
        state.totalCases,
        state.targetPassRate ?? 1,
        state.dailyTargetOverrides ?? [],
        dayWindowsFromRows(state.planningRows, projectDayWindowDefaults(state)),
      ),
    [state.planningRows, state.perHourPerTester, productiveHours, state.totalCases, state.targetPassRate, state.dailyTargetOverrides, state],
  );

  const gaps = useMemo(
    () => calculateDailyGaps(plan, state.dailyActuals ?? [], today, state.casesCompleted, state.casesPassed ?? 0),
    [plan, state.dailyActuals, today, state.casesCompleted, state.casesPassed],
  );

  const currentGap = useMemo(
    () => calculateCurrentGap(plan, today, state.totalCases, state.casesCompleted, state.casesPassed ?? 0),
    [plan, today, state.totalCases, state.casesCompleted, state.casesPassed],
  );

  const entries = useMemo(() => sortDailyExecuted(state.dailyExecuted ?? []), [state.dailyExecuted]);
  // One entry per executed day (chronological) — paginate with the newest
  // day visible on load.
  const pager = usePagedRows(entries, 10, { initialPage: 'last' });

  // ---- plan editing ---------------------------------------------------------

  const setOverride = (date: string, plannedExecute: number, plannedPass: number): void => {
    const rest = (state.dailyTargetOverrides ?? []).filter((o) => o.date !== date);
    const override: DailyTargetOverride = { id: `${date}-override`, date, plannedExecute: Math.max(0, plannedExecute), plannedPass: Math.max(0, plannedPass) };
    updateField('dailyTargetOverrides', [...rest, override]);
  };

  const toggleMode = (date: string, toManual: boolean): void => {
    if (toManual) {
      const row = plan.find((r) => r.date === date);
      if (row === undefined) return;
      setOverride(date, row.plannedExecute, row.plannedPass);
    } else {
      updateField('dailyTargetOverrides', (state.dailyTargetOverrides ?? []).filter((o) => o.date !== date));
    }
  };

  const gapTone = (gap: number | null): 'default' | 'good' | 'bad' =>
    gap === null || gap === 0 ? 'default' : gap > 0 ? 'good' : 'bad';

  const trendMax = plan.reduce((max, row) => Math.max(max, row.cumulativeExecute), 0);

  // V6.5 §14 (V7): previous day vs today — derived from the regenerated
  // snapshots (cumulative at end of each recorded day).
  const previous = useMemo(() => {
    const before = (state.dailyActuals ?? []).filter((a) => a.date < today);
    const latest = before.length > 0 ? before.reduce((a, b) => (a.date >= b.date ? a : b)) : null;
    if (latest === null) return null;
    const spo = latest.spoAssigned ?? 0;
    const qaCompleted = Math.max(0, latest.executed);
    return {
      date: latest.date,
      qaTested: Math.max(0, qaCompleted - spo),
      qaCompleted,
    };
  }, [state.dailyActuals, today]);
  const currentQaCompleted = state.casesCompleted;

  return (
    <section className="daily-progress">
      <div className="dp-config">
        <label className="field">
          <span className="field-label">{t(lang, 'gap.targetPassRate')}</span>
          <input
            className="input input-narrow"
            type="number"
            min={1}
            max={100}
            step={1}
            value={Math.round((state.targetPassRate ?? 1) * 100)}
            onChange={(e) => {
              const pct = Number(e.target.value);
              if (Number.isFinite(pct) && pct > 0 && pct <= 100) updateField('targetPassRate', pct / 100);
            }}
          />
        </label>
        <span className="dp-hint">{t(lang, 'gap.snapshotHint')}</span>
      </div>

      <div className="dp-summary">
        <span className={`gap-pill ${gapTone(currentGap.executeGap)}`}>
          {t(lang, 'gap.executeGap')}: {formatNumber(currentGap.executeGap, 1, lang)}
        </span>
        <span className={`gap-pill ${gapTone(currentGap.passGap)}`}>
          {t(lang, 'gap.passGap')}: {formatNumber(currentGap.passGap, 1, lang)}
        </span>
        <span className="gap-pill">
          {t(lang, 'gap.executePct')}: {currentGap.executeAchievementPct === null ? '—' : `${formatNumber(currentGap.executeAchievementPct, 1, lang)}%`}
        </span>
        <span className="gap-pill">
          {t(lang, 'gap.passPct')}: {currentGap.passAchievementPct === null ? '—' : `${formatNumber(currentGap.passAchievementPct, 1, lang)}%`}
        </span>
      </div>

      {/* V6.5 §14 (V7): previous day → today comparison, from the entries. */}
      <div className="dp-history-compare" role="status">
        {previous === null ? (
          <span className="gap-pill">{t(lang, 'history.noPrevious')}</span>
        ) : (
          <>
            <span className="gap-pill">
              {t(lang, 'history.previous')} ({previous.date}) — {t(lang, 'metrics.qaCompleted')}: {formatCases(previous.qaCompleted, lang)}
            </span>
            <span className="gap-pill">
              {t(lang, 'history.current')} — {t(lang, 'metrics.qaCompleted')}: {formatCases(currentQaCompleted, lang)}
            </span>
            <span className={`gap-pill ${gapTone(currentQaCompleted - previous.qaCompleted)}`}>
              {t(lang, 'history.change')}: {currentQaCompleted - previous.qaCompleted >= 0 ? '+' : ''}
              {formatCases(currentQaCompleted - previous.qaCompleted, lang)}
            </span>
          </>
        )}
      </div>

      {plan.length === 0 ? (
        <p className="empty-note">{t(lang, 'gap.noPlan')}</p>
      ) : (
        <div className="table-wrap">
          <table className="dr-table dp-table table-wide">
            <thead>
              <tr>
                <th scope="col">{t(lang, 'columns.date')}</th>
                <th scope="col" className="num">{t(lang, 'gap.plannedExecute')}</th>
                <th scope="col" className="num">{t(lang, 'gap.plannedPass')}</th>
                <th scope="col" className="num">{t(lang, 'gap.cumExecute')}</th>
                <th scope="col" className="num">{t(lang, 'gap.cumPass')}</th>
                <th scope="col" className="num" title={t(lang, 'gap.dayDetailHint')}>{t(lang, 'gap.dayExecuted')}</th>
                <th scope="col" className="num">{t(lang, 'gap.actual')}</th>
                <th scope="col" className="num">{t(lang, 'gap.executeGap')}</th>
                <th scope="col" className="num">{t(lang, 'gap.passGap')}</th>
                <th scope="col" className="num">{t(lang, 'gap.executePct')}</th>
                <th scope="col" className="num">{t(lang, 'gap.passPct')}</th>
              </tr>
            </thead>
            <tbody>
              {gaps.map((row) => {
                const planRow = plan.find((p) => p.date === row.date);
                const modeManual = planRow?.mode === 'MANUAL';
                const entry = entries.find((e) => e.date === row.date);
                const dayDetail =
                  entry === undefined
                    ? null
                    : `P${formatInteger(entry.pass, lang)} F${formatInteger(entry.fail, lang)} N${formatInteger(entry.notApplicable, lang)} S${formatInteger(entry.spo, lang)}`;
                return (
                  <tr key={row.date} className={row.isToday ? 'completes' : undefined}>
                    <td>
                      {row.date}
                      {row.isToday ? <span className="tag-today"> {t(lang, 'gap.todayTag')}</span> : null}
                    </td>
                    <td>
                      <button
                        type="button"
                        className={`mode-badge ${modeManual ? 'manual' : 'auto'}`}
                        onClick={() => toggleMode(row.date, !modeManual)}
                        title={t(lang, 'gap.toggleModeHint')}
                        aria-pressed={modeManual}
                      >
                        {modeManual ? t(lang, 'gap.manual') : t(lang, 'gap.auto')}
                      </button>
                      {modeManual ? (
                        <input
                          className="input input-cell"
                          type="number"
                          min={0}
                          step={1}
                          value={planRow?.plannedExecute ?? 0}
                          onChange={(e) => setOverride(row.date, Number(e.target.value) || 0, planRow?.plannedPass ?? 0)}
                        />
                      ) : (
                        <span className="dp-inline-num">{formatCases(planRow?.plannedExecute ?? 0, lang)}</span>
                      )}
                    </td>
                    <td>
                      {modeManual ? (
                        <input
                          className="input input-cell"
                          type="number"
                          min={0}
                          step={1}
                          value={planRow?.plannedPass ?? 0}
                          onChange={(e) => setOverride(row.date, planRow?.plannedExecute ?? 0, Number(e.target.value) || 0)}
                        />
                      ) : (
                        <span className="dp-inline-num">{formatCases(planRow?.plannedPass ?? 0, lang)}</span>
                      )}
                    </td>
                    <td className="num">{formatCases(row.plannedExecuteCum, lang)}</td>
                    <td className="num">{formatCases(row.plannedPassCum, lang)}</td>
                    <td className="num" title={dayDetail ?? undefined}>
                      {entry === undefined ? '—' : formatCases(entryCompletedCases(entry), lang)}
                    </td>
                    <td className="num dp-actual">
                      {row.actualExecuteCum === null ? '—' : `${formatCases(row.actualExecuteCum, lang)} / ${formatCases(row.actualPassCum ?? 0, lang)}`}
                    </td>
                    <td className={`num tone-text-${gapTone(row.executeGap)}`}>
                      {row.executeGap === null ? '—' : formatNumber(row.executeGap, 1, lang)}
                    </td>
                    <td className={`num tone-text-${gapTone(row.passGap)}`}>
                      {row.passGap === null ? '—' : formatNumber(row.passGap, 1, lang)}
                    </td>
                    <td className="num">{row.executeAchievementPct === null ? '—' : `${formatNumber(row.executeAchievementPct, 1, lang)}%`}</td>
                    <td className="num">{row.passAchievementPct === null ? '—' : `${formatNumber(row.passAchievementPct, 1, lang)}%`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {plan.length === 0 ? null : (
        <div className="dp-trend">
          <div className="dp-trend-title">{t(lang, 'gap.trend')}</div>
          <div className="dp-trend-legend">
            <span className="legend-chip chip-planned">{t(lang, 'gap.plannedSeries')}</span>
            <span className="legend-chip chip-progress">{t(lang, 'gap.actualSeries')}</span>
          </div>
          <div className="dp-trend-chart">
            {gaps.map((row) => {
              const plannedHeight = trendMax > 0 ? (row.plannedExecuteCum / trendMax) * 100 : 0;
              const actualHeight =
                row.actualExecuteCum === null || trendMax === 0 ? null : (row.actualExecuteCum / trendMax) * 100;
              return (
                <div key={row.date} className="dp-trend-col" title={`${row.date} — ${formatCases(row.plannedExecuteCum, lang)} / ${row.actualExecuteCum === null ? '—' : formatCases(row.actualExecuteCum, lang)}`}>
                  <div className="dp-trend-bars">
                    <div className="dp-trend-bar planned" style={{ height: `${plannedHeight}%` }} />
                    <div
                      className={`dp-trend-bar actual${actualHeight === null ? ' empty' : ''}`}
                      style={{ height: `${actualHeight ?? 0}%` }}
                    />
                  </div>
                  <div className="dp-trend-date">{row.date.slice(5)}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* V7: the daily execution entries — the single source of truth for
          actuals. Execution results are ENTERED on the Operator view; the
          table below shows the full history (read-only here). */}
      <h3 className="exec-subsection-title">{t(lang, 'exec.entryListTitle')}</h3>
      <p className="exec-help">{t(lang, 'exec.entriesHint')}</p>
      {onEnterExecution !== undefined ? (
        <div className="exec-enter-notice">
          <span className="exec-help">{t(lang, 'gap.enterExecutionNotice')}</span>
          <button type="button" className="btn" onClick={onEnterExecution}>
            {t(lang, 'gap.enterExecutionButton')}
          </button>
        </div>
      ) : null}
      {entries.length === 0 ? (
        <p className="empty-note">{t(lang, 'exec.noEntries')}</p>
      ) : (
        <div className="table-wrap">
          <table className="dr-table dp-table table-wide">
            <thead>
              <tr>
                <th scope="col">{t(lang, 'columns.date')}</th>
                <th scope="col">{t(lang, 'exec.actualStart')}</th>
                <th scope="col">{t(lang, 'exec.actualEnd')}</th>
                <th scope="col" className="num">{t(lang, 'columns.overtime')}</th>
                <th scope="col" className="center">{t(lang, 'columns.interval')}</th>
                <th scope="col" className="num">{t(lang, 'exec.actualTesters')}</th>
                <th scope="col" className="num">{t(lang, 'columns.pass')}</th>
                <th scope="col" className="num">{t(lang, 'fields.casesFailed')}</th>
                <th scope="col" className="num">{t(lang, 'columns.notApplicable')}</th>
                <th scope="col" className="num">{t(lang, 'fields.spoAssigned')}</th>
                <th scope="col" className="num">{t(lang, 'columns.blocked')}</th>
                <th scope="col" className="num">{t(lang, 'fields.casesRetest')}</th>
                <th scope="col" className="num">{t(lang, 'fields.casesQuestioned')}</th>
                <th scope="col" className="num">{t(lang, 'gap.dayExecuted')}</th>
                {onEditEntry !== undefined || onDeleteEntry !== undefined ? <th scope="col">{t(lang, 'columns.actions')}</th> : null}
              </tr>
            </thead>
            <tbody>
              {pager.pagedRows.map((entry) => (
                <tr key={entry.id} className={entry.date === today ? 'completes' : undefined}>
                  <td>
                    {entry.date}
                    {entry.date === today ? <span className="tag-today"> {t(lang, 'gap.todayTag')}</span> : null}
                  </td>
                  <td>{entry.startTime === null ? '—' : minutesToTimeInput(entry.startTime)}</td>
                  <td>{entry.endTime === null ? '—' : minutesToTimeInput(entry.endTime)}</td>
                  <td className="num">{formatDuration(entry.overtimeMinutes)}</td>
                  <td className="center">{entry.intervalEnabled ? '✔' : '—'}</td>
                  <td className="num">{formatInteger(entry.testers, lang)}</td>
                  <td className="num">{formatInteger(entry.pass, lang)}</td>
                  <td className="num">{formatInteger(entry.fail, lang)}</td>
                  <td className="num">{formatInteger(entry.notApplicable, lang)}</td>
                  <td className="num">{formatInteger(entry.spo, lang)}</td>
                  <td className="num">{formatInteger(entry.blocked, lang)}</td>
                  <td className="num">{formatInteger(entry.retest, lang)}</td>
                  <td className="num">{formatInteger(entry.questioned, lang)}</td>
                  <td className="num">
                    {formatCases(entryCompletedCases(entry), lang)}
                    {entry.uncategorizedCompleted !== undefined && entry.uncategorizedCompleted > 0 ? (
                      <span className="tag tag-warn" title={t(lang, 'exec.uncategorized')}> +{formatInteger(entry.uncategorizedCompleted, lang)}</span>
                    ) : null}
                  </td>
                  {onEditEntry !== undefined || onDeleteEntry !== undefined ? (
                    <td className="dr-row-actions">
                      {onEditEntry !== undefined ? (
                        <button type="button" className="btn" onClick={() => onEditEntry(entry.date)}>
                          {t(lang, 'buttons.edit')}
                        </button>
                      ) : null}
                      {onDeleteEntry !== undefined ? (
                        <button
                          type="button"
                          className="btn btn-danger"
                          onClick={() => {
                            if (window.confirm(t(lang, 'exec.confirmDeleteEntry', { date: entry.date }))) {
                              onDeleteEntry(entry.date);
                            }
                          }}
                        >
                          {t(lang, 'buttons.remove')}
                        </button>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <TablePager lang={lang} pager={pager} />

      {/* V6.5 §7–§9: historical execution timeline, trends and status
          breakdown — regenerated from the daily entries. */}
      <ExecutionHistoryPanel snapshots={state.dailyActuals ?? []} totalCases={state.totalCases} lang={lang} />
    </section>
  );
}

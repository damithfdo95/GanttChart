import { useEffect, useMemo, useState } from 'react';
import { useAppStateCtx } from '../app/state-contexts';
import { t, type TranslationKey } from '../i18n';
import { formatDate, todayEpochDays } from '../lib/dates/dates';
import { sumBlockingMinutes } from '../lib/calculations/blocking';
import {
  RECOVERY_PRESET_IDS,
  buildBlockingScenarios,
  buildCurrentScenario,
  buildPresetScenario,
  buildRateScenarios,
  buildRecoveryBaseline,
  buildTesterScenarios,
  calculateRecoveryGapCases,
  calculateRecoveryGapMinutes,
  calculateScenarioResult,
  findRecoveryOptions,
  type RecoveryBaseline,
  type RecoveryOption,
  type RecoveryPresetId,
  type RecoveryScenario,
  type ScenarioResult,
} from '../lib/calculations/recovery';
import { formatCases, formatClock, formatDuration, formatInteger, formatNumber, formatSignedDuration } from '../lib/formatting/format';
import { effectiveTodayWindow } from '../lib/calculations/dailyExecuted';
import { MetricCard } from './MetricCard';
import { STATUS_LABEL_KEY } from './ExecutiveSummary';
import { RecoveryScenarioTable, type RecoveryRowData, type RecoveryTableLabels } from './RecoveryScenarioTable';
import { RecoveryExplanation } from './RecoveryExplanation';

const PRESET_KEY: Record<RecoveryPresetId, TranslationKey> = {
  plus1Tester: 'recovery.preset.plus1Tester',
  plus2Testers: 'recovery.preset.plus2Testers',
  plus10Rate: 'recovery.preset.plus10Rate',
  plus20Rate: 'recovery.preset.plus20Rate',
  minus30Blocking: 'recovery.preset.minus30Blocking',
  balanced: 'recovery.preset.balanced',
};

interface RecoveryPanelProps {
  /** Current wall-clock minutes-of-day; passed explicitly (the engine is pure). */
  now: number;
}

/**
 * V6 — Recovery & What-If Analysis. The panel reads the shared project
 * state (single source of truth), simulates a separate scenario and renders
 * the results of the pure recovery engine. The scenario NEVER modifies the
 * project unless the user explicitly confirms "Apply Scenario" — and even
 * then only the tester count and execution rate are written.
 */
export function RecoveryPanel({ now }: RecoveryPanelProps) {
  const { state, updateField } = useAppStateCtx();
  const lang = state.language;
  const todayEpoch = todayEpochDays();
  const today = formatDate(todayEpoch);

  const unavailableMinutes = useMemo(
    () => sumBlockingMinutes(state.blockingEvents ?? [], today),
    [state.blockingEvents, today],
  );
  const baseline: RecoveryBaseline = useMemo(
    () => buildRecoveryBaseline(state, now, unavailableMinutes, effectiveTodayWindow(state, today), todayEpoch),
    [state, now, unavailableMinutes, today, todayEpoch],
  );
  const defaultScenario = useMemo(() => buildCurrentScenario(baseline), [baseline]);

  const [scenario, setScenario] = useState<RecoveryScenario>(defaultScenario);
  const [showOptions, setShowOptions] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // Reset the simulation when the underlying project parameters change
  // (project switch, applied scenario, input edits) — deliberately NOT on
  // the 30-second clock tick.
  const resetKey = [
    baseline.currentTesters,
    baseline.planPerHourPerTester,
    baseline.startTime,
    baseline.targetFinish,
    baseline.lunch.start,
    baseline.lunch.end,
    baseline.unavailableMinutes,
    baseline.totalCases,
    baseline.casesCompleted,
  ].join('|');
  useEffect(() => {
    setScenario(defaultScenario);
    setConfirming(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  const result = useMemo(() => calculateScenarioResult(baseline, scenario), [baseline, scenario]);
  const gapMinutes = useMemo(() => calculateRecoveryGapMinutes(baseline), [baseline]);
  const gapCases = calculateRecoveryGapCases(gapMinutes, baseline.currentRatePerHour);
  const found = useMemo(() => findRecoveryOptions(baseline), [baseline]);

  const statusLabel = (status: ScenarioResult['status']): string => t(lang, STATUS_LABEL_KEY[status]);
  const rowTone = (variance: number | null): 'default' | 'good' | 'bad' =>
    variance === null || variance === 0 ? 'default' : variance > 0 ? 'good' : 'bad';

  const rowFromResult = (key: string, label: string, r: ScenarioResult, isCurrent = false): RecoveryRowData => ({
    key,
    label,
    testers: formatInteger(r.scenario.testers, lang),
    rate: formatNumber(r.scenario.casesPerHourPerTester, 2, lang),
    capacity: formatNumber(r.teamCapacityPerHour, 1, lang),
    projected: formatClock(r.projectedFinish),
    variance: formatSignedDuration(r.varianceMinutes),
    tone: rowTone(r.varianceMinutes),
    statusLabel: statusLabel(r.status),
    recovered: r.recovered,
    isCurrent,
  });

  const currentRow = (key: string): RecoveryRowData =>
    rowFromResult(
      key,
      t(lang, 'recovery.currentTag'),
      calculateScenarioResult(baseline, buildCurrentScenario(baseline)),
      true,
    );

  const optionLabel = (option: RecoveryOption): string => {
    switch (option.kind) {
      case 'testers':
        return option.value >= baseline.currentTesters
          ? t(lang, 'recovery.opt.plusTesters', { n: option.value - baseline.currentTesters })
          : t(lang, 'recovery.opt.minusTesters', { n: baseline.currentTesters - option.value });
      case 'rate':
        return t(lang, 'recovery.opt.ratePct', { pct: option.value - 100 });
      case 'blocking':
        return t(lang, 'recovery.opt.blockingMin', { min: option.value });
      case 'additionalTime':
        return t(lang, 'recovery.opt.additionalMin', { min: option.value });
      case 'balanced':
        return t(lang, 'recovery.preset.balanced');
      default:
        return t(lang, 'recovery.currentTag');
    }
  };

  const testerRows = useMemo(() => {
    const rows = [currentRow('cur')];
    for (const option of buildTesterScenarios(baseline)) {
      const r = calculateScenarioResult(baseline, option.scenario);
      rows.push(rowFromResult(`t${option.value}`, formatInteger(option.value, lang), r, option.value === baseline.currentTesters));
    }
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseline, lang]);

  const rateRows = useMemo(() => {
    const rows = [currentRow('cur')];
    for (const option of buildRateScenarios(baseline)) {
      const r = calculateScenarioResult(baseline, option.scenario);
      rows.push(rowFromResult(`r${option.value}`, `${option.value - 100}%`, r, option.value === 100));
    }
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseline, lang]);

  const blockingRows = useMemo(() => {
    const rows = [currentRow('cur')];
    for (const option of buildBlockingScenarios(baseline)) {
      const r = calculateScenarioResult(baseline, option.scenario);
      rows.push(rowFromResult(`b${option.value}`, t(lang, 'recovery.opt.blockingMin', { min: option.value }), r));
    }
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseline, lang]);

  const optionRows = useMemo(
    () => found.options.map((row) => rowFromResult(`o-${row.option.kind}-${row.option.value}`, optionLabel(row.option), row.result)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [found, lang],
  );

  // ---- chart positions (§15): data-driven, never hard-coded --------------
  const chartTimes = [
    baseline.targetFinish,
    baseline.currentProjectedFinish ?? baseline.targetFinish,
    result.projectedFinish ?? baseline.currentProjectedFinish ?? baseline.targetFinish,
  ];
  const chartMin = Math.min(...chartTimes) - 30;
  const chartMax = Math.max(...chartTimes) + 30;
  const chartPct = (time: number): number => ((time - chartMin) / (chartMax - chartMin)) * 100;

  // ---- what-if controls ---------------------------------------------------
  const maxTesters = Math.max(baseline.currentTesters + 10, Math.round(scenario.testers));
  const maxRate = Math.max(1, Math.ceil(Math.max(baseline.baselinePerTesterRate, baseline.planPerHourPerTester) * 2 * 10) / 10);

  const applyScenario = (): void => {
    const testers = Math.round(scenario.testers);
    if (testers !== baseline.currentTesters) updateField('currentTesters', testers);
    const rateChanged = Math.abs(scenario.casesPerHourPerTester - baseline.baselinePerTesterRate) > 0.005;
    if (rateChanged) updateField('perHourPerTester', Math.round(scenario.casesPerHourPerTester * 100) / 100);
    setConfirming(false);
  };

  const tableLabels: RecoveryTableLabels = {
    change: t(lang, 'recovery.change'),
    testers: t(lang, 'recovery.testers'),
    rate: t(lang, 'recovery.rate'),
    capacity: `${t(lang, 'metrics.teamCapacityHour')}`,
    projected: t(lang, 'dashboard.predictedFinish'),
    variance: t(lang, 'metrics.scheduleVariance'),
    result: t(lang, 'metrics.result'),
  };

  const recoveredBadge =
    baseline.currentStatus === 'DELAYED' && result.recovered ? (
      <span className="recovered-pill">{t(lang, 'recovery.recovered')}</span>
    ) : null;

  return (
    <section className="recovery-panel">
      <div className="recovery-subtitle">{t(lang, 'recovery.baseline')}</div>
      <div className="metrics-grid">
        <MetricCard label={t(lang, 'fields.totalCases')} value={formatInteger(baseline.totalCases, lang)} />
        <MetricCard label={t(lang, 'fields.casesCompleted')} value={formatInteger(baseline.casesCompleted, lang)} />
        <MetricCard label={t(lang, 'dashboard.remainingCases')} value={formatInteger(baseline.casesRemaining, lang)} />
        <MetricCard label={t(lang, 'fields.currentTesters')} value={formatInteger(baseline.currentTesters, lang)} />
        <MetricCard
          label={t(lang, 'exec.currentRate')}
          value={baseline.currentRatePerHour === null ? '—' : `${formatNumber(baseline.currentRatePerHour, 1, lang)} ${t(lang, 'units.casesPerHour')}`}
        />
        <MetricCard
          label={t(lang, 'recovery.productiveRemaining')}
          value={formatDuration(baseline.productiveRemainingMinutes)}
        />
        <MetricCard label={t(lang, 'fields.targetFinish')} value={formatClock(baseline.targetFinish)} />
        <MetricCard label={t(lang, 'dashboard.predictedFinish')} value={formatClock(baseline.currentProjectedFinish)} />
        <MetricCard
          label={t(lang, 'metrics.scheduleVariance')}
          value={formatSignedDuration(baseline.currentVarianceMinutes)}
          tone={rowTone(baseline.currentVarianceMinutes)}
        />
        <MetricCard label={t(lang, 'exec.status')} value={statusLabel(baseline.currentStatus)} tone={rowTone(baseline.currentVarianceMinutes)} />
        <MetricCard label={t(lang, 'blocking.todayUnavailable')} value={formatDuration(baseline.unavailableMinutes)} />
      </div>

      <div className="recovery-subtitle">{t(lang, 'recovery.whatIf')}</div>
      <div className="recovery-controls">
        <label className="recovery-control">
          <span className="field-label">
            {t(lang, 'recovery.testers')} ({t(lang, 'recovery.currentValue')}: {formatInteger(baseline.currentTesters, lang)})
          </span>
          <span className="recovery-control-inputs">
            <input
              type="range"
              min={1}
              max={maxTesters}
              step={1}
              value={scenario.testers}
              onChange={(e) => setScenario((s) => ({ ...s, testers: Number(e.target.value) }))}
            />
            <input
              className="input input-narrow"
              type="number"
              min={1}
              step={1}
              value={scenario.testers}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n >= 1) setScenario((s) => ({ ...s, testers: Math.round(n) }));
              }}
            />
          </span>
        </label>
        <label className="recovery-control">
          <span className="field-label">
            {t(lang, 'recovery.rate')} ({t(lang, 'recovery.currentValue')}: {formatNumber(baseline.baselinePerTesterRate, 2, lang)})
          </span>
          <span className="recovery-control-inputs">
            <input
              type="range"
              min={0.1}
              max={maxRate}
              step={0.1}
              value={Math.min(maxRate, scenario.casesPerHourPerTester)}
              onChange={(e) => setScenario((s) => ({ ...s, casesPerHourPerTester: Number(e.target.value) }))}
            />
            <input
              className="input input-narrow"
              type="number"
              min={0.1}
              step={0.1}
              value={scenario.casesPerHourPerTester}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n > 0) setScenario((s) => ({ ...s, casesPerHourPerTester: n }));
              }}
            />
          </span>
        </label>
        <label className="recovery-control">
          <span className="field-label">
            {t(lang, 'recovery.blockingReduction')} ({t(lang, 'recovery.currentValue')}: {formatInteger(baseline.unavailableMinutes, lang)} {t(lang, 'units.minutes')})
          </span>
          <span className="recovery-control-inputs">
            <input
              type="range"
              min={0}
              max={Math.max(0, baseline.unavailableMinutes)}
              step={5}
              value={Math.min(scenario.unavailableMinutesReduction, baseline.unavailableMinutes)}
              disabled={baseline.unavailableMinutes <= 0}
              onChange={(e) => setScenario((s) => ({ ...s, unavailableMinutesReduction: Number(e.target.value) }))}
            />
            <input
              className="input input-narrow"
              type="number"
              min={0}
              step={5}
              value={scenario.unavailableMinutesReduction}
              disabled={baseline.unavailableMinutes <= 0}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n >= 0) {
                  setScenario((s) => ({ ...s, unavailableMinutesReduction: Math.min(n, baseline.unavailableMinutes) }));
                }
              }}
            />
          </span>
        </label>
        <label className="recovery-control">
          <span className="field-label">{t(lang, 'recovery.additionalTime')}</span>
          <span className="recovery-control-inputs">
            <input
              type="range"
              min={0}
              max={180}
              step={15}
              value={scenario.additionalProductiveMinutes}
              onChange={(e) => setScenario((s) => ({ ...s, additionalProductiveMinutes: Number(e.target.value) }))}
            />
            <input
              className="input input-narrow"
              type="number"
              min={0}
              step={15}
              value={scenario.additionalProductiveMinutes}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n >= 0) setScenario((s) => ({ ...s, additionalProductiveMinutes: n }));
              }}
            />
          </span>
        </label>
      </div>

      <div className="recovery-presets">
        {RECOVERY_PRESET_IDS.map((id) => (
          <button
            key={id}
            type="button"
            className="btn btn-ghost"
            onClick={() => setScenario(buildPresetScenario(id, baseline))}
          >
            {t(lang, PRESET_KEY[id])}
          </button>
        ))}
        <button type="button" className="btn btn-ghost" onClick={() => setScenario(defaultScenario)}>
          {t(lang, 'recovery.reset')}
        </button>
      </div>

      <div className="recovery-subtitle">{t(lang, 'recovery.result')}</div>
      <div className="recovery-result">
        <div className="metrics-grid">
          <MetricCard label={t(lang, 'dashboard.predictedFinish')} value={formatClock(result.projectedFinish)} />
          <MetricCard
            label={t(lang, 'metrics.scheduleVariance')}
            value={formatSignedDuration(result.varianceMinutes)}
            tone={rowTone(result.varianceMinutes)}
          />
          <MetricCard label={t(lang, 'metrics.result')} value={statusLabel(result.status)} tone={rowTone(result.varianceMinutes)} />
          <MetricCard
            label={t(lang, 'metrics.teamCapacityHour')}
            value={`${formatNumber(result.teamCapacityPerHour, 1, lang)} ${t(lang, 'units.casesPerHour')}`}
          />
          <MetricCard label={t(lang, 'recovery.expectedCases')} value={formatCases(result.expectedCasesByTarget, lang)} />
          <MetricCard
            label={t(lang, 'exec.requiredRate')}
            value={result.requiredRatePerHour === null ? '—' : `${formatNumber(result.requiredRatePerHour, 1, lang)} ${t(lang, 'units.casesPerHour')}`}
          />
        </div>
        {recoveredBadge}
        <div className="recovery-note">{t(lang, 'recovery.simulationNote')}</div>
        <button type="button" className="btn" onClick={() => setConfirming(true)} disabled={baseline.casesRemaining <= 0}>
          {t(lang, 'recovery.apply')}
        </button>
        {confirming ? (
          <div className="recovery-confirm">
            <div className="recovery-confirm-title">{t(lang, 'recovery.confirmTitle')}</div>
            <table className="dr-table">
              <thead>
                <tr>
                  <th>{t(lang, 'recovery.confirmCurrent')}</th>
                  <th>{t(lang, 'recovery.confirmNew')}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="num">{formatInteger(baseline.currentTesters, lang)}</td>
                  <td className="num">{formatInteger(Math.round(scenario.testers), lang)}</td>
                </tr>
                <tr>
                  <td className="num">{formatNumber(baseline.baselinePerTesterRate, 2, lang)}</td>
                  <td className="num">{formatNumber(scenario.casesPerHourPerTester, 2, lang)}</td>
                </tr>
              </tbody>
            </table>
            <p className="recovery-note">{t(lang, 'recovery.confirmNote')}</p>
            <div className="recovery-confirm-actions">
              <button type="button" className="btn" onClick={applyScenario}>
                {t(lang, 'recovery.confirmOk')}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>
                {t(lang, 'recovery.cancel')}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="recovery-chart">
        <div className="recovery-chart-canvas">
          <div className="recovery-chart-axis" />
          <div className="recovery-chart-marker marker-target" style={{ left: `${chartPct(baseline.targetFinish)}%` }}>
            <span className="recovery-chart-label">{t(lang, 'recovery.chartTarget')} {formatClock(baseline.targetFinish)}</span>
          </div>
          <div className="recovery-chart-marker marker-current" style={{ left: `${chartPct(chartTimes[1])}%` }}>
            <span className="recovery-chart-label">{t(lang, 'recovery.chartCurrent')} {formatClock(chartTimes[1])}</span>
          </div>
          <div className="recovery-chart-marker marker-scenario" style={{ left: `${chartPct(chartTimes[2])}%` }}>
            <span className="recovery-chart-label">{t(lang, 'recovery.chartScenario')} {formatClock(chartTimes[2])}</span>
          </div>
        </div>
      </div>

      {gapMinutes !== null && gapMinutes > 0 ? (
        <div className="recovery-gap">
          <div className="recovery-subtitle">{t(lang, 'recovery.recoveryGap')}</div>
          <div className="metrics-grid">
            <MetricCard label={t(lang, 'fields.targetFinish')} value={formatClock(baseline.targetFinish)} />
            <MetricCard label={t(lang, 'dashboard.predictedFinish')} value={formatClock(baseline.currentProjectedFinish)} />
            <MetricCard
              label={t(lang, 'labels.delay')}
              value={formatDuration(-1 * (baseline.currentVarianceMinutes ?? 0))}
              tone="bad"
            />
            <MetricCard label={t(lang, 'recovery.gapMinutes')} value={formatDuration(gapMinutes)} tone="bad" />
            <MetricCard
              label={t(lang, 'recovery.gapCases')}
              value={gapCases === null ? '—' : `${formatCases(gapCases, lang)} ${t(lang, 'units.cases')}`}
            />
          </div>
        </div>
      ) : null}

      <RecoveryScenarioTable title={t(lang, 'recovery.testerRecovery')} labels={tableLabels} rows={testerRows} showCapacity />
      <RecoveryScenarioTable title={t(lang, 'recovery.rateRecovery')} labels={tableLabels} rows={rateRows} showRate showCapacity />
      <RecoveryScenarioTable title={t(lang, 'recovery.blockingRecovery')} labels={tableLabels} rows={blockingRows} />

      <div className="recovery-actions">
        <button type="button" className="btn" onClick={() => setShowOptions((v) => !v)}>
          {t(lang, 'recovery.find')}
        </button>
      </div>
      {showOptions ? (
        <div className="recovery-options">
          {found.anyRecovered ? null : (
            <div className="recovery-no-recovery">
              <p className="empty-note">{t(lang, 'recovery.noRecovery')}</p>
              {found.best !== null ? (
                <div className="metrics-grid">
                  <MetricCard
                    label={t(lang, 'recovery.bestScenario')}
                    value={optionLabel(found.best.option)}
                  />
                  <MetricCard label={t(lang, 'dashboard.predictedFinish')} value={formatClock(found.best.result.projectedFinish)} />
                  <MetricCard
                    label={t(lang, 'metrics.scheduleVariance')}
                    value={formatSignedDuration(found.best.result.varianceMinutes)}
                    tone={rowTone(found.best.result.varianceMinutes)}
                  />
                </div>
              ) : null}
            </div>
          )}
          <RecoveryScenarioTable
            title={t(lang, 'recovery.options')}
            labels={tableLabels}
            rows={optionRows}
            showTesters
            showRate
          />
        </div>
      ) : null}

      <RecoveryExplanation baseline={baseline} result={result} lang={lang} />
    </section>
  );
}

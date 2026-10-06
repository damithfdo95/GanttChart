import type { Language } from '../types';
import type { RecoveryBaseline, ScenarioResult } from '../lib/calculations/recovery';
import { t } from '../i18n';
import { formatCases, formatClock, formatInteger, formatNumber, formatSignedDuration } from '../lib/formatting/format';

interface RecoveryExplanationProps {
  baseline: RecoveryBaseline;
  result: ScenarioResult;
  lang: Language;
}

/**
 * V6 §20–§21: scenario explanation generated from the calculation result
 * (never hard-coded numbers), plus labeled historical context
 * (PLAN / ACTUAL / SIMULATION) so the user can judge whether the simulated
 * rate is realistic. No predictive claims beyond the mathematical scenario.
 */
export function RecoveryExplanation({ baseline, result, lang }: RecoveryExplanationProps) {
  const currentRate = baseline.currentRatePerHour ?? baseline.planTeamCapacityPerHour;
  const scenarioPace = result.effectivePacePerHour;
  return (
    <div className="recovery-explanation">
      <div className="recovery-why-title">{t(lang, 'recovery.why')}</div>
      <dl className="recovery-why-facts">
        <div className="recovery-why-fact">
          <dt>{t(lang, 'recovery.currentTag')}</dt>
          <dd>
            {formatInteger(baseline.currentTesters, lang)} × {formatNumber(baseline.baselinePerTesterRate, 2, lang)} ={' '}
            {formatNumber(currentRate, 1, lang)} {t(lang, 'units.casesPerHour')}
          </dd>
        </div>
        <div className="recovery-why-fact">
          <dt>{t(lang, 'recovery.simulationTag')}</dt>
          <dd>
            {formatInteger(result.scenario.testers, lang)} × {formatNumber(result.scenario.casesPerHourPerTester, 2, lang)} ={' '}
            {formatNumber(result.teamCapacityPerHour, 1, lang)} {t(lang, 'units.casesPerHour')}
          </dd>
        </div>
        <div className="recovery-why-fact">
          <dt>{t(lang, 'dashboard.remainingCases')}</dt>
          <dd>{formatCases(baseline.casesRemaining, lang)}</dd>
        </div>
        <div className="recovery-why-fact">
          <dt>{t(lang, 'dashboard.predictedFinish')}</dt>
          <dd>
            {formatClock(baseline.currentProjectedFinish)} → {formatClock(result.projectedFinish)}
          </dd>
        </div>
        <div className="recovery-why-fact">
          <dt>{t(lang, 'metrics.scheduleVariance')}</dt>
          <dd>
            {formatSignedDuration(baseline.currentVarianceMinutes)} → {formatSignedDuration(result.varianceMinutes)}
          </dd>
        </div>
        {scenarioPace !== null ? (
          <div className="recovery-why-fact">
            <dt>{t(lang, 'recovery.simulatedValue')}</dt>
            <dd>
              {formatNumber(scenarioPace, 1, lang)} {t(lang, 'units.casesPerHour')}
            </dd>
          </div>
        ) : null}
      </dl>
      <div className="recovery-context">
        <span className="gap-pill">
          {t(lang, 'recovery.planTag')}: {formatInteger(baseline.planTeamCapacityPerHour, lang)} {t(lang, 'units.casesPerHour')}
        </span>
        <span className="gap-pill">
          {t(lang, 'recovery.actualTag')}: {baseline.currentRatePerHour === null ? '—' : `${formatNumber(baseline.currentRatePerHour, 1, lang)} ${t(lang, 'units.casesPerHour')}`}
        </span>
        {baseline.effectiveRatePerHour !== null ? (
          <span className="gap-pill">
            {t(lang, 'blocking.effectiveTime')}: {formatNumber(baseline.effectiveRatePerHour, 1, lang)} {t(lang, 'units.casesPerHour')}
          </span>
        ) : null}
        <span className="gap-pill">
          {t(lang, 'recovery.simulationTag')}: {scenarioPace === null ? '—' : `${formatNumber(scenarioPace, 1, lang)} ${t(lang, 'units.casesPerHour')}`}
        </span>
      </div>
    </div>
  );
}

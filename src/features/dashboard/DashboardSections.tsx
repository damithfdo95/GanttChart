/**
 * Dashboard operator-grid sections: the Input form, Capacity/Projection metric
 * cards and the Execution live-status block. Extracted from Dashboard.tsx so
 * the screen file holds state wiring and derivation only.
 */

import { t, type TranslationKey } from '../../i18n';
import { Field } from '../../components/Field';
import { MetricCard } from '../../components/MetricCard';
import { SectionCard } from '../../components/SectionCard';
import { DailyExecutionForm } from '../../components/DailyExecutionForm';
import { TestRailErrorHint } from '../../components/TestRailErrorHint';
import { TestRailStatusLine } from '../../components/TestRailStatusLine';
import type { TestRailExecutionStatus } from './hooks/useTestRailScopeProgress';
import { formatInteger, formatNumber, formatDuration, formatSignedDuration, formatSignedMultiDayDuration, formatClock } from '../../lib/formatting/format';
import type { Language } from '../../types';

export interface InputSectionProps {
  lang: Language;
  sub: Language;
  tester: boolean;
  totalFromScopes: boolean;
  state: {
    totalCases: number;
    currentTesters: number;
    startDate: string;
    targetCompletionDate?: string | null;
    perHourPerTester: number;
    dailyOvertimeMinutes?: number | null;
  };

  errors: {
    totalCases?: TranslationKey;
    currentTesters?: TranslationKey;
    perHourPerTester?: TranslationKey;
    dailyOvertimeMinutes?: TranslationKey;
  };
  planningValidation: { targetDateInvalid: boolean };
  onNumberChange: (field: 'totalCases' | 'currentTesters' | 'perHourPerTester' | 'dailyOvertimeMinutes', value: string) => void;
  onStartDateChange: (value: string) => void;
  onEndDateChange: (value: string | null) => void;
}

export function InputSection({
  lang,
  sub,
  tester,
  totalFromScopes,
  state,
  errors,
  planningValidation,
  onNumberChange,
  onStartDateChange,
  onEndDateChange,
}: InputSectionProps) {
  return (
    <SectionCard title={t(lang, 'sections.input')} subtitle={t(sub, 'sections.input')} span={5} fill>
      {tester ? <p className="dr-summary" role="note">{t(lang, 'dashboard.testerReadOnlyInputs')}</p> : null}
      <fieldset className="plain-fieldset" disabled={tester}>
        <div className="input-grid">
          <Field label={t(lang, 'fields.totalCases')} error={errors.totalCases ? t(lang, errors.totalCases) : undefined}>
            <input
              className="input"
              type="number"
              min={0}
              step={1}
              value={state.totalCases}
              readOnly={totalFromScopes}
              aria-describedby={totalFromScopes ? 'total-from-scopes' : undefined}
              onChange={(e) => onNumberChange('totalCases', e.target.value)}
            />
            {totalFromScopes ? (
              <span id="total-from-scopes" className="link-help">
                {t(lang, 'tm.total.fromScopes')}
              </span>
            ) : null}
          </Field>
          <Field label={t(lang, 'fields.currentTesters')} error={errors.currentTesters ? t(lang, errors.currentTesters) : undefined}>
            <input
              className="input"
              type="number"
              min={1}
              step={1}
              value={state.currentTesters}
              onChange={(e) => onNumberChange('currentTesters', e.target.value)}
            />
          </Field>
          <Field label={t(lang, 'fields.startDate')}>
            <input
              className="input"
              type="date"
              value={state.startDate}
              onChange={(e) => onStartDateChange(e.target.value)}
            />
          </Field>
          <Field
            label={t(lang, 'fields.endDate')}
            error={planningValidation.targetDateInvalid ? t(lang, 'errors.targetDateInvalid') : undefined}
          >
            <input
              className="input"
              type="date"
              value={state.targetCompletionDate ?? ''}
              onChange={(e) => onEndDateChange(e.target.value === '' ? null : e.target.value)}
            />
          </Field>
          <Field
            label={t(lang, 'fields.perHourPerTester')}
            error={errors.perHourPerTester ? t(lang, errors.perHourPerTester) : undefined}
          >
            <input
              className="input"
              type="number"
              min={0.5}
              step={0.5}
              value={state.perHourPerTester}
              onChange={(e) => onNumberChange('perHourPerTester', e.target.value)}
            />
          </Field>
          <Field
            label={t(lang, 'fields.dailyOvertime')}
            error={errors.dailyOvertimeMinutes ? t(lang, errors.dailyOvertimeMinutes) : undefined}
          >
            <input
              className="input"
              type="number"
              min={0}
              max={180}
              step={15}
              value={state.dailyOvertimeMinutes ?? 0}
              onChange={(e) => onNumberChange('dailyOvertimeMinutes', e.target.value)}
              title={t(lang, 'hint.dailyOvertime')}
            />
          </Field>
        </div>
      </fieldset>
    </SectionCard>
  );
}

export interface ExecutionSectionProps {
  lang: Language;
  sub: Language;
  executionDate: string;
  onExecutionDateChange: (date: string) => void;
  tester: boolean;
  blockedReason: string | undefined;
  executionStatusKey: TranslationKey;
  executionTone: 'good' | 'default';
  executionCounts: {
    qaTested: number;
    qaCompleted: number;
    qaTestedRatio: number | null;
    qaCompletedRatio: number | null;
    blocked: number;
    retest: number;
    questioned: number;
  };
  remainingCases: number;
  actualRate: number | null;
  projectedFinish: number | null;
  variance: number | null;
  varianceTone: 'good' | 'bad' | 'default';
  /** Live TestRail progress of the project's linked scopes (refresh control). */
  testrail: TestRailExecutionStatus;
}

export function ExecutionSection({
  lang,
  sub,
  executionDate,
  onExecutionDateChange,
  tester,
  blockedReason,
  executionStatusKey,
  executionTone,
  executionCounts,
  remainingCases,
  actualRate,
  projectedFinish,
  variance,
  varianceTone,
  testrail,
}: ExecutionSectionProps) {
  // The refresh control appears only when the project has at least one
  // active scope linked to a TestRail run (Test Management → Scopes).
  const testrailLinked = testrail.scopes.some((s) => s.status === 'active' && s.testrail !== undefined);
  const testrailUpdatedTime =
    testrail.fetchedAt === null ? null : new Date(testrail.fetchedAt).toLocaleTimeString(lang === 'ja' ? 'ja-JP' : 'en-US');
  return (
    <SectionCard
      title={t(lang, 'sections.execution')}
      subtitle={t(sub, 'sections.execution')}
      span={12}
      actions={
        testrailLinked ? (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={testrail.loading}
            aria-label={t(lang, 'tm.testrailProgress.refresh')}
            title={t(lang, 'tm.testrailProgress.refresh')}
            onClick={testrail.onRefresh}
          >
            {testrail.loading ? t(lang, 'tm.testrailProgress.fetching') : '⟳'}
          </button>
        ) : undefined
      }
    >
      {/* V7: daily execution entries are the single source of truth for
          actuals. This form records ONE day's counts (not cumulative);
          saving recomputes the canonical totals as Σ entries —
          casesCompleted = Σ(Pass + Fail + N/A + SPO), exactly the
          previous V6.4 composition, one level up. */}
      <h3 className="exec-subsection-title" id="todays-execution">{t(lang, 'exec.todayTitle')}</h3>
      <DailyExecutionForm lang={lang} date={executionDate} onDateChange={onExecutionDateChange} todayOnly={tester} blockedReason={blockedReason} />
      <h3 className="exec-subsection-title exec-subsection-derived">{t(lang, 'exec.liveStatus')}</h3>
      {/* Live TestRail progress of the linked scopes (device-local fetch;
          counts never persist — same rule as Test Management → Scopes). */}
      {testrailLinked && testrail.error !== null ? (
        <TestRailErrorHint lang={lang} error={testrail.error} notConfiguredMessage="tm.testrailProgress.notConfigured" />
      ) : null}
      {testrail.lines !== null ? (
        <div className="link-help testrail-progress" role="status">
          {testrail.lines.map(({ scope, progress }) => (
            <p key={scope.id} className="testrail-progress-line">
              <strong>{scope.name}</strong>{' '}
              <TestRailStatusLine lang={lang} progress={progress} />
            </p>
          ))}
          {testrailUpdatedTime !== null ? <small>{t(lang, 'tm.testrailProgress.updatedAt', { time: testrailUpdatedTime })}</small> : null}
        </div>
      ) : null}
      <div className="metrics-grid execution-metrics">
        <MetricCard
          label={t(lang, 'metrics.executionStatus')}
          value={t(lang, executionStatusKey)}
          tone={executionTone}
        />
        <MetricCard
          label={t(lang, 'metrics.qaTested')}
          value={`${formatInteger(executionCounts.qaTested, lang)} ${t(lang, 'units.cases')}`}
          hint={t(lang, 'hint.qaTested')}
        />
        <MetricCard
          label={t(lang, 'metrics.qaCompleted')}
          value={`${formatInteger(executionCounts.qaCompleted, lang)} ${t(lang, 'units.cases')}`}
          hint={t(lang, 'hint.qaCompleted')}
        />
        <MetricCard
          label={t(lang, 'dashboard.remainingCases')}
          value={`${formatInteger(remainingCases, lang)} ${t(lang, 'units.cases')}`}
          hint={t(lang, 'hint.remaining')}
        />
        <MetricCard
          label={t(lang, 'metrics.qaTestedRatio')}
          value={executionCounts.qaTestedRatio === null ? '—' : `${formatNumber(executionCounts.qaTestedRatio * 100, 1, lang)}%`}
          hint={t(lang, 'hint.qaTestedRatio')}
        />
        <MetricCard
          label={t(lang, 'metrics.qaCompletedRatio')}
          value={executionCounts.qaCompletedRatio === null ? '—' : `${formatNumber(executionCounts.qaCompletedRatio * 100, 1, lang)}%`}
          hint={t(lang, 'hint.qaCompletedRatio')}
        />
        <MetricCard
          label={t(lang, 'metrics.actualRate')}
          value={actualRate === null ? '—' : `${formatNumber(actualRate, 1, lang)} ${t(lang, 'units.casesPerHour')}`}
          hint={t(lang, 'hint.actualRate')}
        />
        <MetricCard
          label={t(lang, 'dashboard.predictedFinish')}
          value={formatClock(projectedFinish)}
          hint={t(lang, 'hint.forecastFinish')}
        />
        <MetricCard
          label={t(lang, 'metrics.scheduleVariance')}
          value={formatSignedDuration(variance)}
          tone={varianceTone}
          hint={t(lang, 'hint.scheduleVariance')}
        />
      </div>
      <p className="exec-help">{t(lang, 'exec.qaCompletedHelp')}</p>
      <p className="exec-help">{t(lang, 'exec.statusesHelp')}</p>
      {/* V6.5 §11: risk / open-status visibility — derived from the
          canonical state, read-only, no scoring or severity levels. */}
      <div
        className={`risk-strip${executionCounts.blocked > 0 || executionCounts.retest > 0 || executionCounts.questioned > 0 ? ' has-open' : ''}`}
        role="status"
      >
        <span className="risk-strip-label">{t(lang, 'risk.title')}:</span>
        {executionCounts.blocked > 0 || executionCounts.retest > 0 || executionCounts.questioned > 0 ? (
          <>
            <span className="risk-chip">{t(lang, 'fields.casesBlocked')}: {formatInteger(executionCounts.blocked, lang)}</span>
            <span className="risk-chip">{t(lang, 'fields.casesRetest')}: {formatInteger(executionCounts.retest, lang)}</span>
            <span className="risk-chip">{t(lang, 'fields.casesQuestioned')}: {formatInteger(executionCounts.questioned, lang)}</span>
          </>
        ) : (
          <span className="risk-chip risk-none">{t(lang, 'risk.noneOpen')}</span>
        )}
      </div>
    </SectionCard>
  );
}

export interface CapacityProjectionSectionsProps {
  lang: Language;
  sub: Language;
  productiveHours: number;
  capacityPerHour: number;
  capacityPerDay: number;
  requiredTesters: number | null;
  requiredMinutes: number | null;
  expectedFinishText: string;
  buffer: number | null;
  resultTone: 'good' | 'bad' | 'default';
  resultText: string;
}

export function CapacityProjectionSections({
  lang,
  sub,
  productiveHours,
  capacityPerHour,
  capacityPerDay,
  requiredTesters,
  requiredMinutes,
  expectedFinishText,
  buffer,
  resultTone,
  resultText,
}: CapacityProjectionSectionsProps) {
  return (
    <>
      <SectionCard title={t(lang, 'sections.capacity')} subtitle={t(sub, 'sections.capacity')} span={3} fill>
        <div className="metrics-grid">
          <MetricCard label={t(lang, 'metrics.productiveHoursDay')} value={formatDuration(productiveHours * 60)} />
          <MetricCard
            label={t(lang, 'metrics.teamCapacityHour')}
            value={`${formatInteger(capacityPerHour, lang)} ${t(lang, 'units.casesPerHour')}`}
          />
          <MetricCard
            label={t(lang, 'metrics.teamCapacityDay')}
            value={`${formatInteger(capacityPerDay, lang)} ${t(lang, 'units.cases')}`}
          />
        </div>
      </SectionCard>

      <SectionCard title={t(lang, 'sections.projection')} subtitle={t(sub, 'sections.projection')} span={4} fill>
        <div className="metrics-grid">
          <MetricCard label={t(lang, 'dashboard.requiredTesters')} value={requiredTesters === null ? '—' : formatInteger(requiredTesters, lang)} hint={t(lang, 'hint.requiredTesters')} />
          <MetricCard label={t(lang, 'metrics.requiredHours')} value={formatDuration(requiredMinutes)} hint={t(lang, 'hint.requiredHours')} />
          <MetricCard label={t(lang, 'metrics.expectedEnd')} value={expectedFinishText} hint={t(lang, 'hint.plannedFinish')} />
          <MetricCard label={t(lang, 'metrics.buffer')} value={formatSignedMultiDayDuration(buffer)} tone={resultTone} hint={t(lang, 'hint.buffer')} />
          <MetricCard label={t(lang, 'metrics.result')} value={resultText} tone={resultTone} />
        </div>
      </SectionCard>
    </>
  );
}

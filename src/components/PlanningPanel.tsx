import type { AppState, Language, PlanningRowPatch } from '../types';
import { Field } from './Field';
import { MetricCard } from './MetricCard';
import { SectionCard } from './SectionCard';
import { StaffingEditor } from './StaffingEditor';
import { PlanCapacityTable } from './PlanCapacityTable';
import { calculateMultiDayProjection } from '../lib/calculations/planning';
import { buildPlanExplanation, type PlanStatus } from '../lib/calculations/explanations';
import { WORK_DAY_END, WORK_LUNCH, projectDayWindowDefaults } from '../lib/calculations/workday';
import { validateInputs, validatePlanning } from '../lib/validation/validate';
import {
  formatCases,
  formatClock,
  formatInteger,
  formatSignedMultiDayDuration,
  minutesToTimeInput,
  parseTimeToMinutes,
} from '../lib/formatting/format';
import { formatDateDisplay, parseDate } from '../lib/dates/dates';
import { otherLanguage, t } from '../i18n';

interface PlanningPanelProps {
  inputs: AppState;
  lang: Language;
  /** Total Test Cases is derived from the project's scopes: shown read-only (same rule as the Dashboard INPUT section). */
  totalFromScopes?: boolean;
  onChangeStartDate: (date: string) => void;
  onSetTargetCompletionDate: (value: string | null) => void;
  onSetTargetCompletionTime: (value: string | null) => void;
  onSetPlanStartTime: (minutes: number) => void;
  onSetProjectName: (field: 'projectNameEn' | 'projectNameJa', value: string) => void;
  /** Editable execution inputs (same fields as the Dashboard INPUT section — one editing surface, two entry points). */
  onSetTotalCases: (value: number) => void;
  onSetCurrentTesters: (value: number) => void;
  onSetPerHourPerTester: (value: number) => void;
  onUpdateRow: (index: number, patch: PlanningRowPatch) => void;
  onAddRow: (copyPrevious: boolean) => void;
  onRemoveRow: (index: number) => void;
  onMoveRow: (index: number, direction: -1 | 1) => void;
  onInsertRowAfter: (index: number, copyRow: boolean) => void;
}

const PLAN_STATUS_KEY: Record<PlanStatus, 'status.completed' | 'status.capacityShortage' | 'status.atRisk' | 'status.onTrack' | 'plan.noTargetSet'> = {
  completed: 'status.completed',
  capacityShortage: 'status.capacityShortage',
  atRisk: 'status.atRisk',
  onTrack: 'status.onTrack',
  noTarget: 'plan.noTargetSet',
};

/**
 * Multi-day planning panel (V2). Composes the staffing editor, the capacity
 * projection table, the summary card set and a localizable calculation
 * explanation. All business math is done by the pure planning engine; the
 * plan shares work hours, lunch and per-hour rate with the v1 INPUT section,
 * and accounts for already-completed cases.
 */
export function PlanningPanel({
  inputs,
  lang,
  totalFromScopes = false,
  onChangeStartDate,
  onSetTargetCompletionDate,
  onSetTargetCompletionTime,
  onSetPlanStartTime,
  onSetProjectName,
  onSetTotalCases,
  onSetCurrentTesters,
  onSetPerHourPerTester,
  onUpdateRow,
  onAddRow,
  onRemoveRow,
  onMoveRow,
  onInsertRowAfter,
}: PlanningPanelProps) {
  const sub = otherLanguage(lang);
  const validation = validatePlanning(inputs);
  // Plan Start Time validation (must leave room for the fixed lunch etc.).
  const planStartTimeError = validateInputs(inputs).errors.startTime;

  const casesRemaining = Math.max(0, inputs.totalCases - inputs.casesCompleted);
  const targetTimeMinutes = inputs.targetCompletionTime === null ? null : parseTimeToMinutes(inputs.targetCompletionTime);

  const projection = calculateMultiDayProjection({
    casesRemaining,
    planningRows: inputs.planningRows,
    perHourPerTester: inputs.perHourPerTester,
    workStartTime: inputs.startTime,
    workEndTime: WORK_DAY_END,
    lunch: WORK_LUNCH,
    targetCompletionDate: inputs.targetCompletionDate,
    targetCompletionTime: targetTimeMinutes,
    dailyOvertimeMinutes: inputs.dailyOvertimeMinutes,
  });

  const explanation = buildPlanExplanation(lang, projection, {
    totalCases: inputs.totalCases,
    casesRemaining,
    planningDayCount: inputs.planningRows.length,
    targetCompletionDate: inputs.targetCompletionDate,
    targetCompletionTime: targetTimeMinutes,
    workEndTimeMinutes: WORK_DAY_END,
  });

  const { projectedCompletion } = projection;
  const completionText =
    projectedCompletion === null
      ? t(lang, 'plan.insufficient')
      : (() => {
          const epoch = parseDate(projectedCompletion.date);
          return epoch === null ? '—' : `${formatDateDisplay(epoch, lang)} ${formatClock(projectedCompletion.time)}`;
        })();
  const completionTone: 'good' | 'bad' =
    projectedCompletion === null || (projection.targetVarianceMinutes !== null && projection.targetVarianceMinutes < 0)
      ? 'bad'
      : 'good';

  const errorMessages = new Set<string>();
  for (const e of validation.rowErrors) {
    if (e.plannedTestersInvalid) errorMessages.add(t(lang, 'errors.plannedTesters'));
    if (e.absentTestersInvalid) errorMessages.add(t(lang, 'errors.absentTesters'));
    if (e.dateInvalid) errorMessages.add(t(lang, 'errors.planDateInvalid'));
    if (e.dateOrder) errorMessages.add(t(lang, 'errors.planDateOrder'));
  }
  if (validation.targetDateInvalid) errorMessages.add(t(lang, 'errors.targetDateInvalid'));
  if (validation.targetTimeInvalid) errorMessages.add(t(lang, 'errors.targetTimeInvalid'));

  return (
    <>
      <SectionCard title={t(lang, 'sections.plan')} subtitle={t(sub, 'sections.plan')} span={12}>
        <div className="plan-config-grid">
          <Field label={t(lang, 'fields.projectNameEn')}>
            <input
              className="input"
              type="text"
              value={inputs.projectNameEn}
              onChange={(e) => onSetProjectName('projectNameEn', e.target.value)}
            />
          </Field>
          <Field label={t(lang, 'fields.projectNameJa')}>
            <input
              className="input"
              type="text"
              value={inputs.projectNameJa}
              onChange={(e) => onSetProjectName('projectNameJa', e.target.value)}
            />
          </Field>
          <Field label={t(lang, 'plan.startDate')}>
            <input
              className="input"
              type="date"
              value={inputs.startDate}
              onChange={(e) => onChangeStartDate(e.target.value)}
            />
          </Field>
          <Field
            label={t(lang, 'plan.startTime')}
            error={planStartTimeError !== undefined ? t(lang, planStartTimeError) : undefined}
          >
            <input
              className="input"
              type="time"
              value={minutesToTimeInput(inputs.startTime)}
              onChange={(e) => {
                const minutes = parseTimeToMinutes(e.target.value);
                if (minutes !== null) onSetPlanStartTime(minutes);
              }}
            />
          </Field>
          <Field
            label={t(lang, 'plan.targetDate')}
            error={validation.targetDateInvalid ? t(lang, 'errors.targetDateInvalid') : undefined}
          >
            <input
              className="input"
              type="date"
              value={inputs.targetCompletionDate ?? ''}
              onChange={(e) => onSetTargetCompletionDate(e.target.value === '' ? null : e.target.value)}
            />
          </Field>
          <Field
            label={t(lang, 'plan.targetTime')}
            error={validation.targetTimeInvalid ? t(lang, 'errors.targetTimeInvalid') : undefined}
          >
            <input
              className="input"
              type="time"
              value={inputs.targetCompletionTime ?? ''}
              onChange={(e) => onSetTargetCompletionTime(e.target.value === '' ? null : e.target.value)}
            />
          </Field>
          <Field label={t(lang, 'fields.totalCases')}>
            <input
              className="input"
              type="number"
              min={0}
              step={1}
              value={inputs.totalCases}
              aria-label={t(lang, 'fields.totalCases')}
              readOnly={totalFromScopes}
              aria-describedby={totalFromScopes ? 'plan-total-from-scopes' : undefined}
              onChange={(e) => onSetTotalCases(Math.max(0, Number(e.target.value) || 0))}
            />
            {totalFromScopes ? (
              <span id="plan-total-from-scopes" className="link-help">
                {t(lang, 'tm.total.fromScopes')}
              </span>
            ) : null}
          </Field>
          <Field label={t(lang, 'fields.currentTesters')}>
            <input
              className="input"
              type="number"
              min={0}
              step={1}
              value={inputs.currentTesters}
              aria-label={t(lang, 'fields.currentTesters')}
              aria-describedby="plan-planned-testers-hint"
              onChange={(e) => onSetCurrentTesters(Math.max(0, Number(e.target.value) || 0))}
            />
            <span id="plan-planned-testers-hint" className="link-help">
              {t(lang, 'hint.plannedTesters')}
            </span>
          </Field>
          <Field label={t(lang, 'fields.perHourPerTester')}>
            <input
              className="input"
              type="number"
              min={0}
              step={0.5}
              value={inputs.perHourPerTester}
              aria-label={t(lang, 'fields.perHourPerTester')}
              onChange={(e) => onSetPerHourPerTester(Math.max(0, Number(e.target.value) || 0))}
            />
          </Field>
        </div>
        <div className="plan-actions">
          <button type="button" className="btn" onClick={() => onAddRow(false)}>
            {t(lang, 'buttons.addNextDay')}
          </button>
          <button type="button" className="btn" onClick={() => onAddRow(true)}>
            {t(lang, 'buttons.duplicateRow')}
          </button>
          <span className="plan-hint">{t(lang, 'plan.staffingHint')}</span>
        </div>
        <StaffingEditor
          rows={inputs.planningRows}
          rowErrors={validation.rowErrors}
          lang={lang}
          defaults={projectDayWindowDefaults(inputs)}
          onUpdateRow={onUpdateRow}
          onRemoveRow={onRemoveRow}
          onMoveRow={onMoveRow}
          onInsertRowAfter={onInsertRowAfter}
        />
        {errorMessages.size > 0 ? <div className="plan-error-summary">{Array.from(errorMessages).join(' / ')}</div> : null}
      </SectionCard>

      <SectionCard title={t(lang, 'sections.planCapacity')} subtitle={t(sub, 'sections.planCapacity')} span={12}>
        <div className="metrics-grid plan-summary">
          <MetricCard
            label={t(lang, 'columns.totalCapacity')}
            value={`${formatCases(projection.totalPlannedCapacity, lang)} ${t(lang, 'units.cases')}`}
          />
          <MetricCard
            label={t(lang, 'dashboard.remainingCases')}
            value={`${formatCases(casesRemaining, lang)} ${t(lang, 'units.cases')}`}
            hint={t(lang, 'hint.remaining')}
          />
          <MetricCard label={t(lang, 'plan.projectedCompletion')} value={completionText} tone={completionTone} />
          <MetricCard
            label={t(lang, 'dashboard.capacityShortage')}
            value={`${formatCases(projection.shortage, lang)} ${t(lang, 'units.cases')}`}
            tone={projection.shortage > 0 ? 'bad' : 'default'}
            hint={t(lang, 'hint.capacityShortage')}
          />
          <MetricCard
            label={t(lang, 'plan.extraDays')}
            value={projection.extraDaysNeeded === null ? '—' : formatInteger(projection.extraDaysNeeded, lang)}
            tone={(projection.extraDaysNeeded ?? 0) > 0 ? 'bad' : 'default'}
            hint={t(lang, 'hint.extraDays')}
          />
          <MetricCard
            label={t(lang, 'plan.recommended')}
            value={
              projection.recommendedTesters === null
                ? inputs.targetCompletionDate === null
                  ? t(lang, 'plan.noTargetSet')
                  : '—'
                : `${formatInteger(projection.recommendedTesters, lang)} ${t(lang, 'units.testers')}`
            }
            hint={t(lang, 'hint.recommended')}
          />
          <MetricCard
            label={t(lang, 'plan.vsTarget')}
            value={formatSignedMultiDayDuration(projection.targetVarianceMinutes)}
            tone={projection.targetVarianceMinutes !== null && projection.targetVarianceMinutes < 0 ? 'bad' : 'default'}
            hint={t(lang, 'hint.vsTarget')}
          />
        </div>
        <div className={`plan-explanation plan-status-${explanation.status}`}>
          <span className="plan-status-tag">{t(lang, PLAN_STATUS_KEY[explanation.status])}</span>
          <p className="plan-explanation-text">{explanation.text}</p>
        </div>
        <PlanCapacityTable rows={inputs.planningRows} projection={projection} lang={lang} />
      </SectionCard>
    </>
  );
}

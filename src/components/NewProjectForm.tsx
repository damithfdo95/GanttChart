import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectLifecycleStatus } from '../types';
import { useAppStateCtx, useReportsStateCtx, activateProjectRecord } from '../app/state-contexts';
import { t, type TranslationKey } from '../i18n';
import { newProjectRecord } from '../domain/projects';
import {
  defaultNewProjectForm,
  validateNewProjectForm,
  type NewProjectForm,
} from '../lib/validation/newProjectForm';
import {
  calculateTeamCapacity,
} from '../lib/calculations/capacity';
import {
  calculateWorkdayProjection,
  dayWindowsFromRows,
  projectDayWindowDefaults,
  dayWindowProductiveHours,
  workingEpochDays,
} from '../lib/calculations/workday';
import { formatDateDisplay, formatDate, nowMinutesOfDay, todayEpochDays } from '../lib/dates/dates';
import { formatClock, formatDuration, formatInteger } from '../lib/formatting/format';
import { Field } from './Field';
import { MetricCard } from './MetricCard';

const LIFECYCLE_KEY: Record<ProjectLifecycleStatus, TranslationKey> = {
  todo: 'overall.todo',
  ongoing: 'overall.ongoing',
  extended: 'overall.extended',
  onHold: 'overall.onHold',
  done: 'overall.done',
};

interface NewProjectFormProps {
  open: boolean;
  onClose: () => void;
  /** Called after the project is created, stored and activated. */
  onCreated: () => void;
}

/**
 * V6.2 — New Project form with initial QA planning. The form edits a
 * temporary NewProjectForm model only; "Create Project" builds the
 * canonical QaInputs (single source of truth), stores the project through
 * the existing registry and activates it. The calculation preview uses the
 * existing engine exclusively — nothing is recalculated locally. A created
 * project has no execution progress: casesCompleted/casesPassed are 0 and
 * no daily snapshots or blocking events are fabricated.
 */
export function NewProjectForm({ open, onClose, onCreated }: NewProjectFormProps) {
  const app = useAppStateCtx();
  const reportsApi = useReportsStateCtx();
  const lang = app.state.language;

  const [form, setForm] = useState<NewProjectForm>(() => defaultNewProjectForm(formatDate(todayEpochDays())));
  // Field errors appear only after the first Create attempt — a freshly
  // opened form never greets the user with red validation text.
  const [showErrors, setShowErrors] = useState(false);

  const firstInputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) setForm(defaultNewProjectForm(formatDate(todayEpochDays())));
  }, [open]);

  // Modal focus management: focus the first field on open, restore focus to
  // the trigger on close, close on Escape and keep Tab inside the dialog.
  useEffect(() => {
    if (!open) return;
    setShowErrors(false);
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    firstInputRef.current?.focus();
    return () => {
      restoreFocusRef.current?.focus();
      restoreFocusRef.current = null;
    };
  }, [open]);

  const handleBackdropKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusables = modalRef.current?.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusables === undefined || focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const validation = useMemo(() => validateNewProjectForm(form), [form]);

  const set = (patch: Partial<NewProjectForm>): void => setForm((prev) => ({ ...prev, ...patch }));

  // Calculation preview — the same workday method as the whole system
  // (default 9:00 plan start, fixed 17:30 end, 12:00–13:00 lunch) applied
  // over the Start → End dates. A new project has nothing completed; when
  // it starts today the preview runs from NOW, otherwise from the first
  // working day.
  const preview = useMemo(() => {
    if (validation.inputs === null) return null;
    const inputs = validation.inputs;
    const capacityPerHour = calculateTeamCapacity(inputs.currentTesters, inputs.perHourPerTester);
    const workingDays = workingEpochDays(inputs.planningRows, inputs.startDate);
    const defaults = projectDayWindowDefaults(inputs);
    const productiveHours = dayWindowProductiveHours(defaults);
    const anchor = {
      epochDay: todayEpochDays(),
      timeOfDay: Math.floor(nowMinutesOfDay()),
    };
    const projection = calculateWorkdayProjection({
      totalCases: inputs.totalCases,
      currentTesters: inputs.currentTesters,
      perHourPerTester: inputs.perHourPerTester,
      planningRows: inputs.planningRows,
      startDate: inputs.startDate,
      endDate: inputs.targetCompletionDate,
      planStartTime: inputs.startTime,
      anchor,
      dailyOvertimeMinutes: inputs.dailyOvertimeMinutes,
      dayWindows: dayWindowsFromRows(inputs.planningRows, defaults),
    });
    const finish = projection.expectedFinish;
    return {
      capacityPerHour,
      productiveHours,
      capacityPerDay: capacityPerHour * productiveHours,
      requiredTesters: projection.requiredTesters,
      requiredMinutes: projection.requiredMinutes,
      expectedFinishText:
        finish === null ? '—' : `${formatDateDisplay(finish.epochDay, lang)} ${formatClock(finish.time)}`,
      planningDays: inputs.planningRows.length,
      workingDays: workingDays.length,
    };
  }, [validation.inputs, lang]);

  const handleCreate = (): void => {
    if (!validation.isValid || validation.inputs === null) return;
    const nowIso = new Date().toISOString();
    const record = newProjectRecord(
      validation.inputs,
      {
        nameEn: form.name.trim(),
        nameJa: form.name.trim(),
        // Team is internal-only now (kept for exports/legacy data); the RCS
        // side is the only team in operation.
        team: 'RCS',
        status: form.status,
      },
      nowIso,
      reportsApi.state.projects,
    );
    reportsApi.addProject({
      ...record,
      description: form.description.trim(),
      owner: form.owner.trim(),
    });
    activateProjectRecord(reportsApi, app, record);
    onCreated();
  };

  if (!open) return null;

  const errorText = (field: keyof NewProjectForm): string | undefined =>
    !showErrors || validation.errors[field] === undefined
      ? undefined
      : t(lang, validation.errors[field] as TranslationKey);

  return (
    <div
      className="npf-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t(lang, 'newProject.title')}
      onKeyDown={handleBackdropKeyDown}
    >
      <div className="npf-modal" ref={modalRef}>
        <header className="npf-header">
          <h2>{t(lang, 'newProject.title')}</h2>
          <button
            type="button"
            className="btn-row-remove npf-close"
            aria-label={t(lang, 'buttons.close')}
            title={t(lang, 'buttons.close')}
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        <div className="npf-body">
          <fieldset className="npf-section">
            <legend>{t(lang, 'newProject.sectionProject')}</legend>
            <div className="npf-grid">
              <Field label={t(lang, 'newProject.projectName')} error={errorText('name')}>
                <input
                  ref={firstInputRef}
                  className="input"
                  type="text"
                  value={form.name}
                  maxLength={120}
                  onChange={(e) => set({ name: e.target.value })}
                />
              </Field>
              <Field label={t(lang, 'newProject.description')}>
                <input
                  className="input"
                  type="text"
                  value={form.description}
                  maxLength={200}
                  onChange={(e) => set({ description: e.target.value })}
                />
              </Field>
              <Field label={t(lang, 'newProject.owner')}>
                <input
                  className="input"
                  type="text"
                  value={form.owner}
                  maxLength={200}
                  onChange={(e) => set({ owner: e.target.value })}
                />
              </Field>
              <Field label={t(lang, 'newProject.status')}>
                <select
                  className="input"
                  value={form.status}
                  onChange={(e) => set({ status: e.target.value as ProjectLifecycleStatus })}
                >
                  {(['todo', 'ongoing', 'done'] as const).map((status) => (
                    <option key={status} value={status}>
                      {t(lang, LIFECYCLE_KEY[status])}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </fieldset>

          <fieldset className="npf-section">
            <legend>{t(lang, 'newProject.sectionTestPlan')}</legend>
            <div className="npf-grid">
              <Field label={t(lang, 'fields.totalCases')} error={errorText('totalCases')}>
                <input
                  className="input"
                  type="number"
                  min={0}
                  step={1}
                  value={form.totalCases}
                  onChange={(e) => set({ totalCases: e.target.value })}
                />
              </Field>
              <Field label={t(lang, 'fields.currentTesters')} error={errorText('currentTesters')}>
                <input
                  className="input"
                  type="number"
                  min={1}
                  step={1}
                  value={form.currentTesters}
                  onChange={(e) => set({ currentTesters: e.target.value })}
                />
              </Field>
              <Field label={t(lang, 'fields.perHourPerTester')} error={errorText('perHourPerTester')}>
                <input
                  className="input"
                  type="number"
                  min={0.5}
                  step={0.5}
                  value={form.perHourPerTester}
                  onChange={(e) => set({ perHourPerTester: e.target.value })}
                />
              </Field>
              <Field label={t(lang, 'newProject.targetPassRate')} error={errorText('targetPassRate')}>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={100}
                  step={1}
                  value={form.targetPassRate}
                  onChange={(e) => set({ targetPassRate: e.target.value })}
                />
              </Field>
            </div>
          </fieldset>

          <fieldset className="npf-section">
            <legend>{t(lang, 'newProject.sectionSchedule')}</legend>
            <div className="npf-grid">
              <Field label={t(lang, 'newProject.startDate')} error={errorText('startDate')}>
                <input
                  className="input"
                  type="date"
                  value={form.startDate}
                  onChange={(e) => set({ startDate: e.target.value })}
                />
              </Field>
              <Field label={t(lang, 'newProject.targetDate')} error={errorText('targetDate')}>
                <input
                  className="input"
                  type="date"
                  value={form.targetDate}
                  onChange={(e) => set({ targetDate: e.target.value })}
                />
              </Field>
              <Field label={t(lang, 'newProject.dailyOvertime')} error={errorText('dailyOvertime')}>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={180}
                  step={15}
                  value={form.dailyOvertime}
                  onChange={(e) => set({ dailyOvertime: e.target.value })}
                  title={t(lang, 'hint.dailyOvertime')}
                />
              </Field>
              <Field label={t(lang, 'newProject.startTime')} error={errorText('startTime')}>
                <input
                  className="input"
                  type="time"
                  value={form.startTime}
                  onChange={(e) => set({ startTime: e.target.value })}
                />
              </Field>
              <Field label={t(lang, 'newProject.endTime')} error={errorText('endTime')}>
                <input
                  className="input"
                  type="time"
                  value={form.endTime}
                  onChange={(e) => set({ endTime: e.target.value })}
                />
              </Field>
              <Field label={t(lang, 'newProject.interval')}>
                <select
                  className="input"
                  value={form.intervalEnabled ? 'yes' : 'no'}
                  onChange={(e) => set({ intervalEnabled: e.target.value === 'yes' })}
                >
                  <option value="yes">{t(lang, 'newProject.intervalOn')}</option>
                  <option value="no">{t(lang, 'newProject.intervalOff')}</option>
                </select>
              </Field>
            </div>
            <p className="npf-hint">{t(lang, 'newProject.fixedWorkdayHint')}</p>
          </fieldset>

          <fieldset className="npf-section">
            <legend>{t(lang, 'newProject.sectionPreview')}</legend>
            {preview === null ? (
              <p className="dr-empty">—</p>
            ) : (
              <div className="metrics-grid">
                <MetricCard
                  label={t(lang, 'metrics.teamCapacityHour')}
                  value={`${formatInteger(preview.capacityPerHour, lang)} ${t(lang, 'units.casesPerHour')}`}
                />
                <MetricCard label={t(lang, 'metrics.productiveHoursDay')} value={formatDuration(preview.productiveHours * 60)} />
                <MetricCard
                  label={t(lang, 'metrics.teamCapacityDay')}
                  value={`${formatInteger(preview.capacityPerDay, lang)} ${t(lang, 'units.cases')}`}
                />
                <MetricCard
                  label={t(lang, 'dashboard.requiredTesters')}
                  value={preview.requiredTesters === null ? '—' : formatInteger(preview.requiredTesters, lang)}
                />
                <MetricCard label={t(lang, 'metrics.requiredHours')} value={formatDuration(preview.requiredMinutes)} />
                <MetricCard label={t(lang, 'metrics.expectedEnd')} value={preview.expectedFinishText} />
                <MetricCard
                  label={t(lang, 'newProject.planningDays')}
                  value={formatInteger(preview.planningDays, lang)}
                />
              </div>
            )}
          </fieldset>
        </div>

        <footer className="npf-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t(lang, 'recovery.cancel')}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              if (!validation.isValid) {
                setShowErrors(true);
                return;
              }
              handleCreate();
            }}
          >
            {t(lang, 'newProject.create')}
          </button>
        </footer>
      </div>
    </div>
  );
}

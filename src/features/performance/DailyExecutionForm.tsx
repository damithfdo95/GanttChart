import { useState } from 'react';
import type { Language, RcsMember } from '../../types';
import { t } from '../../i18n';
import { formatDate, todayEpochDays } from '../../lib/dates/dates';
import { Field } from '../../components/Field';
import type { TesterDailyPerformance } from '../../types';

export interface DailyExecutionFormValues {
  date: string;
  testerName: string;
  memberId: string;
  team: string;
  casesTested: string;
  casesPassed: string;
  casesFailed: string;
  casesNotApplicable: string;
  casesBlocked: string;
  casesRetest: string;
  casesQuestioned: string;
  casesSpoAssigned: string;
}

function emptyForm(today: string): DailyExecutionFormValues {
  return {
    date: today,
    testerName: '',
    memberId: '',
    team: '',
    casesTested: '',
    casesPassed: '',
    casesFailed: '',
    casesNotApplicable: '',
    casesBlocked: '',
    casesRetest: '',
    casesQuestioned: '',
    casesSpoAssigned: '',
  };
}

function fromRecord(record: TesterDailyPerformance): DailyExecutionFormValues {
  const num = (v: number | undefined): string => (v === undefined ? '' : String(v));
  return {
    date: record.date,
    testerName: record.testerName,
    memberId: record.memberId ?? '',
    team: record.team ?? '',
    casesTested: String(record.casesTested),
    casesPassed: num(record.casesPassed),
    casesFailed: num(record.casesFailed),
    casesNotApplicable: num(record.casesNotApplicable),
    casesBlocked: num(record.casesBlocked),
    casesRetest: num(record.casesRetest),
    casesQuestioned: num(record.casesQuestioned),
    casesSpoAssigned: num(record.casesSpoAssigned),
  };
}

/** Parsed record payload; NaN-free (empty string → undefined). */
export interface ParsedDailyExecution {
  date: string;
  testerName: string;
  /** Stable RCS member identity (V6.8); absent for legacy name-only entries. */
  memberId?: string;
  team: string;
  casesTested: number;
  casesPassed?: number;
  casesFailed?: number;
  casesNotApplicable?: number;
  casesBlocked?: number;
  casesRetest?: number;
  casesQuestioned?: number;
  casesSpoAssigned?: number;
}

function parseCount(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

interface DailyExecutionFormProps {
  lang: Language;
  /** Active RCS members for the selector (V6.8); empty → legacy free-text fallback. */
  members: readonly RcsMember[];
  /** Legacy name suggestions for the free-text fallback. */
  memberNames: string[];
  /** Existing record being edited (same date + tester). */
  existing: TesterDailyPerformance | undefined;
  /** True when no active project exists — the form cannot submit anywhere. */
  disabled?: boolean;
  onSubmit: (values: ParsedDailyExecution) => void;
  onCancelEdit: () => void;
}

/**
 * Daily execution entry for the ACTIVE project. V6.8: the tester is selected
 * from the active RCS members ("USER0003 — Yamauchi Kentaro") instead of
 * typed every day; the free-text input remains as a fallback when no member
 * master exists. Totals stay authoritative and the status tallies optional
 * overlays.
 */
export function DailyExecutionForm({ lang, members, memberNames, existing, disabled = false, onSubmit, onCancelEdit }: DailyExecutionFormProps) {
  const today = formatDate(todayEpochDays());
  const [form, setForm] = useState<DailyExecutionFormValues>(() => (existing === undefined ? emptyForm(today) : fromRecord(existing)));
  const [errors, setErrors] = useState<Partial<Record<keyof DailyExecutionFormValues, string>>>({});

  const handleChange = (patch: Partial<DailyExecutionFormValues>): void => {
    setForm((prev) => ({ ...prev, ...patch }));
  };

  const handleSubmit = (): void => {
    const nextErrors: Partial<Record<keyof DailyExecutionFormValues, string>> = {};
    if (form.date === '' || /^\d{4}-\d{2}-\d{2}$/.test(form.date) === false) {
      nextErrors.date = t(lang, 'errors.ticketDateInvalid');
    }
    if (form.testerName.trim() === '') {
      nextErrors.testerName = t(lang, 'errors.testerNameRequired');
    }
    const casesTested = form.casesTested.trim() === '' ? NaN : Number(form.casesTested);
    if (!Number.isFinite(casesTested) || casesTested < 0) {
      nextErrors.casesTested = t(lang, 'errors.casesTestedMin');
    }
    // Optional tallies: non-empty but invalid input is an error, not a silent drop.
    for (const field of numericFields) {
      const value = form[field.key].trim();
      if (value !== '' && (!Number.isFinite(Number(value)) || Number(value) < 0)) {
        nextErrors[field.key] = t(lang, 'errors.countInvalid');
      }
    }
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    setErrors({});
    onSubmit({
      date: form.date,
      testerName: form.testerName.trim(),
      ...(form.memberId !== '' ? { memberId: form.memberId } : {}),
      team: form.team,
      casesTested: Math.round(casesTested),
      casesPassed: parseCount(form.casesPassed),
      casesFailed: parseCount(form.casesFailed),
      casesNotApplicable: parseCount(form.casesNotApplicable),
      casesBlocked: parseCount(form.casesBlocked),
      casesRetest: parseCount(form.casesRetest),
      casesQuestioned: parseCount(form.casesQuestioned),
      casesSpoAssigned: parseCount(form.casesSpoAssigned),
    });
    setForm(emptyForm(today));
  };

  const numericFields: { key: keyof DailyExecutionFormValues; label: string }[] = [
    { key: 'casesPassed', label: t(lang, 'columns.pass') },
    { key: 'casesFailed', label: t(lang, 'fields.casesFailed') },
    { key: 'casesNotApplicable', label: t(lang, 'columns.notApplicable') },
    { key: 'casesBlocked', label: t(lang, 'columns.blocked') },
    { key: 'casesRetest', label: t(lang, 'fields.casesRetest') },
    { key: 'casesQuestioned', label: t(lang, 'fields.casesQuestioned') },
    { key: 'casesSpoAssigned', label: t(lang, 'columns.spoAssigned') },
  ];

  return (
    <form
      className="input-grid"
      onSubmit={(e) => {
        e.preventDefault();
        handleSubmit();
      }}
    >
      <Field label={t(lang, 'columns.date')} error={errors.date}>
        <input
          className="input"
          type="date"
          value={form.date}
          onChange={(e) => handleChange({ date: e.target.value })}
        />
      </Field>
      <Field label={t(lang, 'performance.testerName')} error={errors.testerName}>
        {members.length > 0 ? (
          <select
            className="input"
            value={form.memberId}
            onChange={(e) => {
              const memberId = e.target.value;
              const member = members.find((m) => m.id === memberId);
              handleChange({
                memberId,
                ...(member !== undefined ? { testerName: member.name, team: member.team } : { testerName: '' }),
              });
            }}
          >
            <option value="">{t(lang, 'performance.testerName')}</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.id} — {member.name} ({member.role})
              </option>
            ))}
            {/* Keep the edited legacy record selectable when it is not in the active roster. */}
            {form.memberId !== '' && !members.some((m) => m.id === form.memberId) ? (
              <option value={form.memberId}>{form.memberId} — {form.testerName}</option>
            ) : null}
          </select>
        ) : (
          <input
            className="input"
            type="text"
            list="daily-execution-tester-options"
            value={form.testerName}
            onChange={(e) => handleChange({ testerName: e.target.value })}
          />
        )}
        {members.length === 0 ? (
          <datalist id="daily-execution-tester-options">
            {memberNames.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        ) : null}
      </Field>
      <Field label={t(lang, 'performance.casesTestedField')} error={errors.casesTested}>
        <input
          className="input"
          type="number"
          min={0}
          step={1}
          value={form.casesTested}
          onChange={(e) => handleChange({ casesTested: e.target.value })}
        />
      </Field>
      {numericFields.map((field) => (
        <Field key={field.key} label={field.label} error={errors[field.key]}>
          <input
            className="input"
            type="number"
            min={0}
            step={1}
            value={form[field.key]}
            onChange={(e) => handleChange({ [field.key]: e.target.value } as Partial<DailyExecutionFormValues>)}
          />
        </Field>
      ))}
      <div className="dr-button-row">
        {disabled ? <p className="dr-empty">{t(lang, 'performance.noActiveProject')}</p> : null}
        <button type="submit" className="btn" disabled={disabled}>
          {t(lang, 'performance.addDailyExecution')}
        </button>
        {existing !== undefined ? (
          <button type="button" className="btn btn-ghost" onClick={onCancelEdit}>
            {t(lang, 'buttons.close')}
          </button>
        ) : null}
      </div>
    </form>
  );
}

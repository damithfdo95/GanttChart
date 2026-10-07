import { useEffect, useMemo, useState } from 'react';
import type { DailyExecutionEntry, Language } from '../types';
import { useAppStateCtx } from '../app/state-contexts';
import { t } from '../i18n';
import { formatDate, todayEpochDays } from '../lib/dates/dates';
import { generateId } from '../lib/id';
import { clampOvertimeMinutes, WORK_DAY_END } from '../lib/calculations/workday';
import {
  cumulativeBeforeDate,
  cumulativeThroughDate,
  dailyDeltaFromTotals,
  entryCompletedCases,
  entryForDate,
  sortDailyExecuted,
  type ExecutionStatusTotals,
} from '../lib/calculations/dailyExecuted';
import { formatInteger, minutesToTimeInput, parseTimeToMinutes } from '../lib/formatting/format';
import { Field } from './Field';
import { businessDate } from '../../shared/businessTime';

interface DailyExecutionFormProps {
  lang: Language;
  /** Controlled selected date (optional; uncontrolled = today by default). */
  date?: string;
  onDateChange?: (date: string) => void;
  /** A Tester records today's entry only; earlier days are the SV's to correct (the server enforces it as well). */
  todayOnly?: boolean;
  /** Why recording is not possible right now (e.g. a Tester not assigned to this execution). Shown instead of a save that would be refused. */
  blockedReason?: string;
}

/**
 * "Today's Execution" (V7) — the daily ACTUAL input form. One entry per
 * date: the actual time window (start / end / overtime / interval), the
 * actual tester count and THAT DAY's status counts (Pass / Fail / N/A /
 * SPO / Blocked / Retest / 質問中). Defaults to today; past days stay
 * editable (date picker or the recorded-days quick-select). Saving
 * recomputes every cumulative total and schedule calculation (Σ entries —
 * the canonical fields are a projection).
 *
 * Input modes for the status counts:
 * - TOTAL (default): enter the RUNNING TOTALS as of the selected date; the
 *   day's counts are derived (total − everything before that date, clamped
 *   at 0) and displayed, so nobody has to subtract yesterday by hand.
 * - DAY: enter that day's counts directly (previous behavior).
 * The stored model is unchanged — one per-day entry either way.
 */
type InputMode = 'DAY' | 'TOTAL';

const DELTA_KEYS = ['pass', 'fail', 'notApplicable', 'spo', 'blocked', 'retest', 'questioned'] as const;
const STATUS_KEYS = [...DELTA_KEYS, 'uncategorizedCompleted'] as const;
type StatusKey = (typeof STATUS_KEYS)[number];

export function DailyExecutionForm({ lang, date: controlledDate, onDateChange, todayOnly = false, blockedReason }: DailyExecutionFormProps) {
  const { state, saveDailyExecutionEntry } = useAppStateCtx();
  const today = formatDate(todayEpochDays());
  const [dateState, setDateState] = useState<string>(today);
  // A Tester's day is the business day the server will accept (not the browser's own calendar day).
  const date = todayOnly ? businessDate() : (controlledDate ?? dateState);
  const [mode, setMode] = useState<InputMode>('TOTAL');

  const setDate = (next: string): void => {
    setDateState(next);
    onDateChange?.(next);
  };

  const allEntries = useMemo(() => state.dailyExecuted ?? [], [state.dailyExecuted]);
  const existing = useMemo(() => entryForDate(allEntries, date), [allEntries, date]);
  const recordedDays = useMemo(() => sortDailyExecuted(allEntries), [allEntries]);

  // Form state re-seeds whenever the selected date (or its saved entry)
  // changes; unsaved edits to another date are intentionally discarded.
  const [form, setForm] = useState<DailyExecutionEntry>(() =>
    seed(date, existing, state.startTime, state.currentTesters, mode, allEntries),
  );
  useEffect(() => {
    setForm(seed(date, existing, state.startTime, state.currentTesters, mode, allEntries));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, existing, mode, allEntries]);

  // In TOTAL mode the status fields hold running totals; this is what the
  // day's entry will actually record (derived, clamped at 0).
  const previous = useMemo(() => cumulativeBeforeDate(allEntries, date), [allEntries, date]);
  const derive = (from: DailyExecutionEntry): ExecutionStatusTotals =>
    mode === 'TOTAL'
      ? dailyDeltaFromTotals(statusTotalsOf(from), previous)
      : statusTotalsOf(from);
  const derived = derive(form);
  const clampedKeys = mode === 'TOTAL' ? DELTA_KEYS.filter((key) => form[key] < previous[key]) : [];

  const set = (patch: Partial<DailyExecutionEntry>): void => setForm((prev) => ({ ...prev, ...patch }));
  const setCount = (key: StatusKey, raw: string): void => {
    const trimmed = raw.trim();
    const n = trimmed === '' ? 0 : Number(trimmed);
    set({ [key]: Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0 } as Partial<DailyExecutionEntry>);
  };

  const handleSave = (): void => {
    saveDailyExecutionEntry({
      ...form,
      ...derive(form),
      overtimeMinutes: clampOvertimeMinutes(form.overtimeMinutes),
      testers: Math.max(0, Math.round(form.testers)),
    });
  };

  const dayTotal = derived.pass + derived.fail + derived.notApplicable + derived.spo + (form.uncategorizedCompleted ?? 0);
  const withTotalSuffix = (label: string): string =>
    mode === 'TOTAL' ? `${label} (${t(lang, 'exec.totalShort')})` : label;

  return (
    <div className="daily-execution-form">
      <div className="execution-inputs-grid">
        <Field label={t(lang, 'exec.entryDate')} error={undefined}>
          <input
            className="input"
            type="date"
            max={today}
            disabled={todayOnly}
            value={date}
            onChange={(e) => {
              if (e.target.value !== '') setDate(e.target.value);
            }}
          />
        </Field>
        {todayOnly ? null : (
        <Field label={t(lang, 'exec.pickRecordedDay')}>
          <select
            className="input"
            value={existing !== null ? date : ''}
            onChange={(e) => {
              if (e.target.value !== '') setDate(e.target.value);
            }}
          >
            <option value="">{t(lang, 'exec.pickRecordedDayPlaceholder')}</option>
            {recordedDays.map((recorded) => (
              <option key={recorded.id} value={recorded.date}>
                {recorded.date} ({formatInteger(entryCompletedCases(recorded), lang)})
              </option>
            ))}
          </select>
        </Field>
        )}
        <Field label={t(lang, 'exec.actualStart')}>
          <input
            className="input"
            type="time"
            value={form.startTime === null ? '' : minutesToTimeInput(form.startTime)}
            onChange={(e) => set({ startTime: e.target.value === '' ? null : parseTimeToMinutes(e.target.value) })}
          />
        </Field>
        <Field label={t(lang, 'exec.actualEnd')}>
          <input
            className="input"
            type="time"
            value={form.endTime === null ? '' : minutesToTimeInput(form.endTime)}
            onChange={(e) => set({ endTime: e.target.value === '' ? null : parseTimeToMinutes(e.target.value) })}
          />
        </Field>
        <Field label={t(lang, 'exec.actualOvertime')}>
          <input
            className="input"
            type="number"
            min={0}
            max={180}
            step={15}
            value={form.overtimeMinutes}
            onChange={(e) => set({ overtimeMinutes: clampOvertimeMinutes(Number(e.target.value) || 0) })}
          />
        </Field>
        <Field label={t(lang, 'exec.intervalTaken')}>
          <input
            type="checkbox"
            checked={form.intervalEnabled}
            onChange={(e) => set({ intervalEnabled: e.target.checked })}
          />
        </Field>
        <Field label={t(lang, 'exec.actualTesters')}>
          <input
            className="input"
            type="number"
            min={0}
            step={1}
            value={form.testers}
            onChange={(e) => set({ testers: Math.max(0, Number(e.target.value) || 0) })}
          />
        </Field>
      </div>

      {/* Status-count input mode: running totals (default) or per-day. */}
      <div className="exec-mode-row">
        <span className="field-label">{t(lang, 'exec.inputMode')}</span>
        <div className="exec-mode-toggle" role="group" aria-label={t(lang, 'exec.inputMode')}>
          <button
            type="button"
            className={`exec-mode-btn${mode === 'TOTAL' ? ' active' : ''}`}
            aria-pressed={mode === 'TOTAL'}
            onClick={() => setMode('TOTAL')}
          >
            {t(lang, 'exec.inputModeTotal')}
          </button>
          <button
            type="button"
            className={`exec-mode-btn${mode === 'DAY' ? ' active' : ''}`}
            aria-pressed={mode === 'DAY'}
            onClick={() => setMode('DAY')}
          >
            {t(lang, 'exec.inputModeDay')}
          </button>
        </div>
      </div>

      <div className="execution-inputs-grid">
        <Field label={withTotalSuffix(t(lang, 'fields.casesPassed'))}>
          <input className="input" type="number" min={0} step={1} value={form.pass} onChange={(e) => setCount('pass', e.target.value)} />
        </Field>
        <Field label={withTotalSuffix(t(lang, 'fields.casesFailed'))}>
          <input className="input" type="number" min={0} step={1} value={form.fail} onChange={(e) => setCount('fail', e.target.value)} />
        </Field>
        <Field label={withTotalSuffix(t(lang, 'fields.casesNotApplicable'))}>
          <input className="input" type="number" min={0} step={1} value={form.notApplicable} onChange={(e) => setCount('notApplicable', e.target.value)} />
        </Field>
        <Field label={withTotalSuffix(t(lang, 'fields.spoAssigned'))}>
          <input className="input" type="number" min={0} step={1} value={form.spo} onChange={(e) => setCount('spo', e.target.value)} />
        </Field>
        <Field label={withTotalSuffix(t(lang, 'fields.casesBlocked'))}>
          <input className="input" type="number" min={0} step={1} value={form.blocked} onChange={(e) => setCount('blocked', e.target.value)} />
        </Field>
        <Field label={withTotalSuffix(t(lang, 'fields.casesRetest'))}>
          <input className="input" type="number" min={0} step={1} value={form.retest} onChange={(e) => setCount('retest', e.target.value)} />
        </Field>
        <Field label={withTotalSuffix(t(lang, 'fields.casesQuestioned'))}>
          <input className="input" type="number" min={0} step={1} value={form.questioned} onChange={(e) => setCount('questioned', e.target.value)} />
        </Field>
        <Field label={t(lang, 'exec.uncategorized')} error={undefined}>
          <input
            className="input"
            type="number"
            min={0}
            step={1}
            value={form.uncategorizedCompleted ?? 0}
            title={t(lang, 'exec.uncategorizedHint')}
            onChange={(e) => setCount('uncategorizedCompleted', e.target.value)}
          />
        </Field>
      </div>

      <div className="exec-form-actions">
        <button type="button" className="btn" onClick={handleSave} disabled={blockedReason !== undefined}>
          {t(lang, 'exec.saveEntry')}
        </button>
        {blockedReason === undefined ? null : (
          <span className="exec-help exec-clamped" role="note">
            {blockedReason}
          </span>
        )}
        {mode === 'TOTAL' ? (
          <span className="exec-help">
            {t(lang, 'exec.derivedDayLabel')}: P+{formatInteger(derived.pass, lang)} F+{formatInteger(derived.fail, lang)} N+{' '}
            {formatInteger(derived.notApplicable, lang)} S+{formatInteger(derived.spo, lang)} — {t(lang, 'gap.dayExecuted')}:{' '}
            {formatInteger(dayTotal, lang)}
          </span>
        ) : (
          <span className="exec-help">
            {t(lang, 'exec.dayCountsHelp')} ({t(lang, 'gap.dayExecuted')}: {formatInteger(dayTotal, lang)})
          </span>
        )}
        {clampedKeys.length > 0 ? <span className="exec-help exec-clamped">{t(lang, 'exec.clampedHint')}</span> : null}
        {date !== today ? <span className="exec-help">{t(lang, 'exec.entryDateHelp')}</span> : null}
      </div>
    </div>
  );
}

function statusTotalsOf(entry: DailyExecutionEntry): ExecutionStatusTotals {
  return {
    pass: entry.pass,
    fail: entry.fail,
    notApplicable: entry.notApplicable,
    spo: entry.spo,
    blocked: entry.blocked,
    retest: entry.retest,
    questioned: entry.questioned,
  };
}

function seed(
  date: string,
  existing: DailyExecutionEntry | null,
  projectStart: number,
  currentTesters: number,
  mode: InputMode,
  entries: readonly DailyExecutionEntry[],
): DailyExecutionEntry {
  const base: DailyExecutionEntry =
    existing !== null
      ? { ...existing }
      : {
          id: generateId(),
          date,
          startTime: projectStart,
          endTime: WORK_DAY_END,
          overtimeMinutes: 0,
          intervalEnabled: true,
          testers: currentTesters,
          pass: 0,
          fail: 0,
          notApplicable: 0,
          spo: 0,
          blocked: 0,
          retest: 0,
          questioned: 0,
          note: '',
        };
  // TOTAL mode seeds the status fields with the running totals through the
  // selected date, so re-saving an adjusted total just works. The
  // completion time window / testers stay that day's actuals either way.
  if (mode === 'TOTAL') {
    return { ...base, ...cumulativeThroughDate(entries, date) };
  }
  return base;
}

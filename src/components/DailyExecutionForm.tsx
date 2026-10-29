import { useEffect, useMemo, useState } from 'react';
import type { DailyExecutionEntry, Language } from '../types';
import { useAppStateCtx, useReportsStateCtx } from '../app/state-contexts';
import { useAccess } from '../app/access';
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
import { createTestRailClient } from '../lib/testrail/client';
import { backfillTestRailUsers } from '../lib/testrail/client';
import type { TestRailClientError, TestRailResultRow, TestRailUser } from '../../shared/testrail';
import {
  aggregateTestRailDay,
  applyTestRailDayToEntry,
  DEFAULT_TESTRAIL_STATUS_MAP,
  linkTestRailMembers,
  mergeTestRailTesterRecords,
  parseTestRailUrl,
  testrailHostMatches,
  tokyoDayStartUnix,
} from '../domain/testrail';
import { Field } from './Field';
import { CsvFileButton } from './CsvFileButton';
import { testrailDayFromCsv } from '../domain/testrail/csvImport';
import { businessDate } from '../../shared/businessTime';
import { decideImport, decideManualSave, detailedExecutionSummary, executionSourceLabelKey, executionSourceOf, withExecutionProvenance, type ExecutionSource, type ExecutionSourceRef } from '../domain/executionSource';

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
type StatusKey = (typeof DELTA_KEYS)[number] | 'uncategorizedCompleted';

export function DailyExecutionForm({ lang, date: controlledDate, onDateChange, todayOnly = false, blockedReason }: DailyExecutionFormProps) {
  const { state, updateField, saveDailyExecutionEntry } = useAppStateCtx();
  const reports = useReportsStateCtx();
  const access = useAccess();
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
  // day's entry will actually record (derived — a total below the previous
  // cumulative yields a negative day delta so the cumulative can decrease).
  const previous = useMemo(() => cumulativeBeforeDate(allEntries, date), [allEntries, date]);
  const derive = (from: DailyExecutionEntry): ExecutionStatusTotals =>
    mode === 'TOTAL'
      ? dailyDeltaFromTotals(statusTotalsOf(from), previous)
      : statusTotalsOf(from);
  const derived = derive(form);
  const reducedKeys = mode === 'TOTAL' ? DELTA_KEYS.filter((key) => form[key] < previous[key]) : [];

  const set = (patch: Partial<DailyExecutionEntry>): void => setForm((prev) => ({ ...prev, ...patch }));
  const setCount = (key: StatusKey, raw: string): void => {
    const trimmed = raw.trim();
    const n = trimmed === '' ? 0 : Number(trimmed);
    set({ [key]: Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0 } as Partial<DailyExecutionEntry>);
  };

  // A source replacement waits here for the user's confirmation (never applied silently).
  const [pending, setPending] = useState<{ replaces: ExecutionSource; to: ExecutionSource; run: () => void } | null>(null);
  useEffect(() => setPending(null), [date]);

  const handleSave = (): void => {
    const built: DailyExecutionEntry = {
      ...form,
      ...derive(form),
      overtimeMinutes: clampOvertimeMinutes(form.overtimeMinutes),
      testers: Math.max(0, Math.round(form.testers)),
    };
    const decision = decideManualSave(existing, built, new Date().toISOString());
    if (decision.needsConfirmation && decision.replaces !== null) {
      setPending({ replaces: decision.replaces, to: 'manual', run: () => saveDailyExecutionEntry(decision.entry) });
      return;
    }
    saveDailyExecutionEntry(decision.entry);
  };

  const confirmPending = (): void => {
    const run = pending?.run;
    setPending(null);
    run?.();
  };

  const dayTotal = derived.pass + derived.fail + derived.notApplicable + derived.spo + (form.uncategorizedCompleted ?? 0);
  const withTotalSuffix = (label: string): string =>
    mode === 'TOTAL' ? `${label} (${t(lang, 'exec.totalShort')})` : label;

  // ---- TestRail import (SV / plain local use; the project must be linked) ----
  const activeProject = reports.state.projects.find((p) => p.id === reports.state.activeProjectId) ?? null;
  const testrailConnection = reports.state.settings.testrail;
  const testrailLink = activeProject?.testrailPlanUrl !== undefined ? parseTestRailUrl(activeProject.testrailPlanUrl) : null;
  const showTestRail = access.canManage && testrailConnection !== undefined && activeProject !== null;
  // While a TestRail link exists the status counts are READ-ONLY: they may
  // only be filled by the TestRail fetch (or the CSV import of a TestRail
  // export) — never typed by hand — so the day's entry always mirrors what
  // TestRail actually recorded for that day. The time window, overtime,
  // interval and tester count stay editable (they are the team's own facts,
  // not TestRail data).
  const testrailLocked = showTestRail && testrailLink !== null;
  const [testrailBusy, setTestrailBusy] = useState(false);
  const [testrailMessage, setTestrailMessage] = useState<{ kind: 'ok' | 'error' | 'note'; text: string } | null>(null);
  const [linkDraft, setLinkDraft] = useState('');

  /**
   * Write one imported TestRail day: merge the per-tester records, fill the form and save the entry stamped with its TestRail
   * provenance. Only called once any source replacement has been confirmed.
   */
  const commitTestRailDay = (day: Parameters<typeof applyTestRailDayToEntry>[1], ref: ExecutionSourceRef | undefined): ReturnType<typeof mergeTestRailTesterRecords> => {
    if (activeProject === null) throw new Error('no active project');
    const merged = mergeTestRailTesterRecords(state.testerDailyPerformance ?? [], activeProject.projectId, day);
    updateField('testerDailyPerformance', merged.records);
    const entry = applyTestRailDayToEntry(form, day, previous, mode);
    setForm(entry);
    // The imported numbers are TestRail's facts for this day: saved at once, stamped as TestRail's.
    saveDailyExecutionEntry(
      withExecutionProvenance(
        {
          ...entry,
          ...derive(entry),
          overtimeMinutes: clampOvertimeMinutes(entry.overtimeMinutes),
          testers: Math.max(0, Math.round(entry.testers)),
        },
        'testrail',
        new Date().toISOString(),
        ref,
      ),
    );
    return merged;
  };

  /**
   * Fetch the linked plan/run's results for the SELECTED date (default today)
   * and apply them: the status counts and the tester count are replaced, the
   * time window and note stay untouched. Per-tester records are committed
   * immediately (idempotent; manual / manualOverride records are never
   * overwritten) — and so is the day's ENTRY itself: a linked project's
   * numbers are TestRail's facts, so the fetch saves them right away (the
   * SV can still adjust the time window and Save afterwards).
   */
  const runTestrailFetch = async (): Promise<void> => {
    if (testrailConnection === undefined || testrailLink === null || activeProject === null) return;
    setTestrailBusy(true);
    setTestrailMessage(null);
    try {
      const client = createTestRailClient(testrailConnection);
      const runs = testrailLink.kind === 'plan' ? await client.getPlanRuns(testrailLink.id) : [await client.getRun(testrailLink.id)];
      const dayStart = tokyoDayStartUnix(date);
      if (dayStart === null) {
        setTestrailMessage({ kind: 'error', text: t(lang, 'testrail.error.badRequest') });
        return;
      }
      const results: TestRailResultRow[] = [];
      for (const run of runs) {
        const rows = await client.getResultsForRun(run.id, { createdAfter: dayStart, createdBefore: dayStart + 86_400 });
        results.push(...rows);
      }
      // Names are cosmetic: without user-list access the import still works ("User #id").
      let users: TestRailUser[] = [];
      try {
        users = await client.getUsers();
      } catch {
        /* self-hosted instances may restrict get_users to admins */
      }
      // A deactivated tester drops out of get_users while their results stay:
      // fetch each missing id so the row carries the person's name and email
      // (the email is what links the row to a Team Member).
      users = await backfillTestRailUsers(
        client,
        users,
        results.map((r) => r.assignedToId).filter((id): id is number => id !== null),
      );
      const day = linkTestRailMembers(aggregateTestRailDay(results, users, DEFAULT_TESTRAIL_STATUS_MAP, date), users, reports.state.rcsMembers ?? [], reports.state.externalIdentities ?? []);
      if (day.totals.executed === 0) {
        setTestrailMessage({ kind: 'note', text: t(lang, 'exec.testrailNoResults', { date }) });
        return;
      }
      const ref: ExecutionSourceRef = testrailLink.kind === 'plan' ? { provider: 'testrail', planId: testrailLink.id } : { provider: 'testrail', runId: testrailLink.id };
      const apply = (): void => {
        const merged = commitTestRailDay(day, ref);
        const parts = [t(lang, 'exec.testrailFetched', { executed: day.totals.executed, testers: day.totals.testers })];
        if (day.unassignedCount > 0) parts.push(t(lang, 'exec.testrailUnassigned', { count: day.unassignedCount }));
        if (merged.keptManual > 0) parts.push(t(lang, 'exec.testrailKeptManual', { count: merged.keptManual }));
        setTestrailMessage({ kind: 'ok', text: parts.join(' ') });
      };
      const decision = decideImport(existing, 'testrail');
      if (decision.needsConfirmation && decision.replaces !== null) {
        setPending({ replaces: decision.replaces, to: 'testrail', run: apply });
      } else {
        apply();
      }
    } catch (e) {
      const err = e as TestRailClientError;
      const hint = t(lang, `testrail.error.${err.kind}`);
      setTestrailMessage({ kind: 'error', text: err.message !== undefined && err.message !== '' ? `${hint} — ${err.message}` : hint });
    } finally {
      setTestrailBusy(false);
    }
  };

  const applyLink = (): void => {
    if (activeProject === null || testrailConnection === undefined) return;
    const url = linkDraft.trim();
    if (parseTestRailUrl(url) === null) {
      setTestrailMessage({ kind: 'error', text: t(lang, 'exec.testrailLinkInvalid') });
      return;
    }
    if (!testrailHostMatches(testrailConnection.baseUrl, url)) {
      setTestrailMessage({ kind: 'error', text: t(lang, 'exec.testrailLinkHostMismatch') });
      return;
    }
    reports.updateProject(activeProject.id, { testrailPlanUrl: url });
    setLinkDraft('');
    setTestrailMessage(null);
  };

  const removeLink = (): void => {
    if (activeProject === null) return;
    reports.updateProject(activeProject.id, { testrailPlanUrl: undefined });
    setTestrailMessage(null);
  };

  /**
   * CSV import: a TestRail results export (or a per-tester summary sheet)
   * becomes the SAME day import a live fetch produces — same merge rules
   * (idempotent; manual records never overwritten), same editable proposal
   * into the form. Works without a TestRail connection (offline / restricted
   * API access). The date is the form's selected date unless the file has a
   * parseable Date column.
   */
  const handleImportCsv = (text: string, fileName: string): void => {
    if (activeProject === null) return;
    const imported = testrailDayFromCsv(text, date);
    if (imported.day === null || imported.day.totals.executed === 0) {
      setTestrailMessage({ kind: 'error', text: t(lang, 'exec.testrailCsvFailed', { file: fileName }) });
      return;
    }
    const day = linkTestRailMembers(imported.day, [], reports.state.rcsMembers ?? [], reports.state.externalIdentities ?? []);
    const apply = (): void => {
      // Same rule as the live fetch: the imported numbers are saved immediately (and stamped TestRail).
      const merged = commitTestRailDay(day, undefined);
      const parts = [t(lang, 'exec.testrailCsvLoaded', { file: fileName, executed: day.totals.executed, testers: day.totals.testers })];
      if (day.skippedUntested > 0) parts.push(t(lang, 'exec.testrailUnassigned', { count: day.skippedUntested }));
      if (merged.keptManual > 0) parts.push(t(lang, 'exec.testrailKeptManual', { count: merged.keptManual }));
      if (imported.errors.length > 0) parts.push(t(lang, 'exec.testrailCsvRowErrors', { count: imported.errors.length }));
      setTestrailMessage({ kind: imported.errors.length > 0 ? 'error' : 'ok', text: parts.join(' ') });
    };
    const decision = decideImport(existing, 'testrail');
    if (decision.needsConfirmation && decision.replaces !== null) setPending({ replaces: decision.replaces, to: 'testrail', run: apply });
    else apply();
  };

  const detailed =
    activeProject === null
      ? null
      : detailedExecutionSummary(activeProject, reports.state.scopes ?? [], reports.state.testCases ?? [], reports.state.caseResults ?? []);

  return (
    <div className="daily-execution-form">
      <ExecutionSourceBar lang={lang} entry={existing} detailed={detailed} />
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
        <Field label={t(lang, 'exec.actualTesters')}>
          <input
            className="input"
            type="number"
            min={0}
            step={1}
            value={form.testers}
            aria-describedby="actual-testers-hint"
            onChange={(e) => set({ testers: Math.max(0, Number(e.target.value) || 0) })}
          />
          <span id="actual-testers-hint" className="link-help">
            {t(lang, 'exec.actualTestersHint')}
          </span>
        </Field>
        {/* Interval Taken: an inline checkbox on the INPUT row (bottom-aligned
            with the neighbouring inputs — not a label-above-tiny-box field). */}
        <label className="field field-check">
          <input
            type="checkbox"
            checked={form.intervalEnabled}
            onChange={(e) => set({ intervalEnabled: e.target.checked })}
          />
          <span>{t(lang, 'exec.intervalTaken')}</span>
        </label>
      </div>

      {/* Status-count input mode: running totals (default) or per day. A
          header OF the counts grid below — the toggle governs those fields,
          so it sits attached to them, not floating between sections. */}
      <div className="exec-mode-row exec-counts-header">
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
          <input className="input" type="number" min={0} step={1} value={form.pass} disabled={testrailLocked} onChange={(e) => setCount('pass', e.target.value)} />
        </Field>
        <Field label={withTotalSuffix(t(lang, 'fields.casesFailed'))}>
          <input className="input" type="number" min={0} step={1} value={form.fail} disabled={testrailLocked} onChange={(e) => setCount('fail', e.target.value)} />
        </Field>
        <Field label={withTotalSuffix(t(lang, 'fields.casesNotApplicable'))}>
          <input className="input" type="number" min={0} step={1} value={form.notApplicable} disabled={testrailLocked} onChange={(e) => setCount('notApplicable', e.target.value)} />
        </Field>
        <Field label={withTotalSuffix(t(lang, 'fields.spoAssigned'))}>
          <input className="input" type="number" min={0} step={1} value={form.spo} disabled={testrailLocked} onChange={(e) => setCount('spo', e.target.value)} />
        </Field>
        <Field label={withTotalSuffix(t(lang, 'fields.casesBlocked'))}>
          <input className="input" type="number" min={0} step={1} value={form.blocked} disabled={testrailLocked} onChange={(e) => setCount('blocked', e.target.value)} />
        </Field>
        <Field label={withTotalSuffix(t(lang, 'fields.casesRetest'))}>
          <input className="input" type="number" min={0} step={1} value={form.retest} disabled={testrailLocked} onChange={(e) => setCount('retest', e.target.value)} />
        </Field>
        <Field label={withTotalSuffix(t(lang, 'fields.casesQuestioned'))}>
          <input className="input" type="number" min={0} step={1} value={form.questioned} disabled={testrailLocked} onChange={(e) => setCount('questioned', e.target.value)} />
        </Field>
        <Field label={t(lang, 'exec.uncategorized')} error={undefined}>
          <input
            className="input"
            type="number"
            min={0}
            step={1}
            value={form.uncategorizedCompleted ?? 0}
            title={t(lang, 'exec.uncategorizedHint')}
            disabled={testrailLocked}
            onChange={(e) => setCount('uncategorizedCompleted', e.target.value)}
          />
        </Field>
      </div>
      {testrailLocked ? (
        <p className="exec-help" role="note">
          {t(lang, 'exec.testrailLockedHint')}
        </p>
      ) : null}

      {pending !== null ? (
        <div className="recovery-confirm" role="alertdialog" aria-label={t(lang, 'exec.sourceConfirmTitle')}>
          <div className="recovery-confirm-title">{t(lang, 'exec.sourceConfirmTitle')}</div>
          <p className="recovery-note">
            {t(lang, 'exec.sourceConfirmBody', { from: t(lang, executionSourceLabelKey(pending.replaces)), to: t(lang, executionSourceLabelKey(pending.to)), date })}
          </p>
          <div className="recovery-confirm-actions">
            <button type="button" className="btn" onClick={confirmPending}>
              {t(lang, 'exec.sourceConfirmOk')}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setPending(null)}>
              {t(lang, 'exec.sourceConfirmCancel')}
            </button>
          </div>
        </div>
      ) : null}

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
        {reducedKeys.length > 0 ? <span className="exec-help exec-clamped">{t(lang, 'exec.reducedHint')}</span> : null}
        {date !== today ? <span className="exec-help">{t(lang, 'exec.entryDateHelp')}</span> : null}
      </div>

      {/* TestRail import (opt-in): the SV links the project to a TestRail
          plan/run URL once, then fetches that day's results per tester. The
          fetched counts land in the form above as an editable proposal.
          The CSV lane needs no connection: a TestRail results export (or a
          per-tester summary sheet) follows the same path. */}
      {showTestRail ? (
        <div className="exec-mode-row exec-testrail-row" role="group" aria-label={t(lang, 'exec.testrailGroup')}>
          <span className="field-label">TestRail</span>
          {testrailLink === null ? (
            <>
              <input
                className="input exec-testrail-input"
                type="text"
                placeholder={t(lang, 'exec.testrailLinkPlaceholder')}
                value={linkDraft}
                aria-label={t(lang, 'exec.testrailLinkLabel')}
                onChange={(e) => setLinkDraft(e.target.value)}
              />
              <button type="button" className="btn" disabled={linkDraft.trim() === ''} onClick={applyLink}>
                {t(lang, 'exec.testrailLinkButton')}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn" disabled={testrailBusy} onClick={() => void runTestrailFetch()}>
                {testrailBusy ? t(lang, 'exec.testrailFetching') : t(lang, 'exec.testrailFetch')}
              </button>
              <button type="button" className="btn btn-ghost" onClick={removeLink}>
                {t(lang, 'exec.testrailUnlink')}
              </button>
            </>
          )}
          <CsvFileButton label={t(lang, 'exec.testrailImportCsv')} onText={handleImportCsv} />
        </div>
      ) : null}
      {showTestRail && testrailMessage !== null ? (
        <p className={`exec-help${testrailMessage.kind === 'error' ? ' exec-clamped' : ''}`} role={testrailMessage.kind === 'error' ? 'alert' : 'status'}>
          {testrailMessage.text}
        </p>
      ) : null}
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

/** "10:42" for today, else "2026-10-07 10:42" (local time): when the figures were last written by their source. */
function stampText(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number): string => String(n).padStart(2, '0');
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? time : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${time}`;
}

/** Compact provenance line of the selected day: its source, when it was last written, the TestRail run, and the detailed-case counts. */
export function ExecutionSourceBar({ lang, entry, detailed }: { lang: Language; entry: DailyExecutionEntry | null; detailed: { registered: number; executed: number; scopeTotal: number } | null }) {
  const source = executionSourceOf(entry);
  const ref = entry?.sourceRef;
  return (
    <div className="exec-source-bar" role="status">
      {entry === null ? (
        <span className="exec-help">{t(lang, 'exec.source.noEntry')}</span>
      ) : (
        <>
          <span className={`gap-pill exec-source-${source}`}>
            {t(lang, 'exec.source.label')}: {t(lang, executionSourceLabelKey(source))}
          </span>
          {ref?.runId !== undefined ? <span className="exec-help">{t(lang, 'exec.source.run', { id: ref.runId })}</span> : null}
          {ref?.planId !== undefined ? <span className="exec-help">{t(lang, 'exec.source.plan', { id: ref.planId })}</span> : null}
          {entry.sourceUpdatedAt !== undefined && stampText(entry.sourceUpdatedAt) !== '' ? (
            <span className="exec-help">
              {t(lang, source === 'testrail' ? 'exec.source.lastSynced' : 'exec.source.lastUpdated')}: {stampText(entry.sourceUpdatedAt)}
            </span>
          ) : null}
        </>
      )}
      {detailed !== null && detailed.registered > 0 ? (
        <span className="exec-help" title={t(lang, 'exec.source.detailedHint')}>
          {t(lang, 'exec.source.detailed', { registered: detailed.registered, executed: detailed.executed, total: detailed.scopeTotal })}
        </span>
      ) : null}
    </div>
  );
}

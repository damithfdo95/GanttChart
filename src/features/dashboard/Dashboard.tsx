import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ScheduleStatus } from '../../types';
import { activateProject, useAppStateCtx, useReportsStateCtx } from '../../app/state-contexts';
import { useNow } from './hooks/useNow';
import { validateInputs, validatePlanning } from '../../lib/validation/validate';
import { calculateTeamCapacity, calculateProductiveHours } from '../../lib/calculations/capacity';
import {
  calculateProductiveElapsedTime,
  calculateScheduleStatus,
  calculateExpectedProgress,
} from '../../lib/calculations/schedule';
import {
  WORK_DAY_END,
  WORK_LUNCH,
  clampOvertimeMinutes,
  advanceOverWorkDays,
  calculateWorkdayProjection,
  dayWindowsFromRows,
  excludedEpochDays,
  projectDayWindowDefaults,
  workingEpochDays,
  workdayProductiveHours,
} from '../../lib/calculations/workday';
import {
  calculateActualRate,
  calculateExecutionCounts,
  calculateProjectedActualFinish,
  calculateScheduleVariance,
} from '../../lib/calculations/execution';
import { effectiveTodayWindow } from '../../lib/calculations/dailyExecuted';
import { calculateExecutiveSummary } from '../../lib/calculations/executive';
import { generateDailyPlan, calculateCurrentGap } from '../../lib/calculations/dailyPlan';
import { evaluateMilestones } from '../../lib/calculations/milestones';
import { sumBlockingMinutes } from '../../lib/calculations/blocking';
import {
  formatCases,
  formatClock,
  formatDuration,
  formatInteger,
  formatNumber,
  formatSignedDuration,
  formatSignedMultiDayDuration,
} from '../../lib/formatting/format';
import { LANGUAGES, otherLanguage, resolveBilingualName, t, type TranslationKey } from '../../i18n';
import { downloadStateAsJson, parseImportPayload } from '../../lib/jsonio/jsonio';
import { SectionCard } from '../../components/SectionCard';
import { MetricCard } from '../../components/MetricCard';
import { Field } from '../../components/Field';
import { CollapsibleSection } from '../../components/CollapsibleSection';
import { StatusCard, FreeStatusCard, type StatusFact } from '../../components/StatusCard';
import { StatusExplanation } from '../../components/StatusExplanation';
import { ExecutiveSummaryView } from '../../components/ExecutiveSummary';
import { Timeline } from '../../components/Timeline';
import { WhatIfTable, type WhatIfRow } from '../../components/WhatIfTable';
import { DataControls, type ImportMessage } from '../../components/DataControls';
import { DailyProgressPanel } from '../../components/DailyProgressPanel';
import { DailyExecutionForm } from '../../components/DailyExecutionForm';
import { BlockingPanel } from '../../components/BlockingPanel';
import { MilestonePanel } from '../../components/MilestonePanel';
import { RecoveryPanel } from '../../components/RecoveryPanel';
import { useSharedGuard } from '../../app/useSharedGuard';
import { useTenant } from '../../app/tenant-context';
import { WorkspaceEmptyNotice } from './WorkspaceEmptyNotice';
import { MultiDayTimeline } from '../../components/MultiDayTimeline';
import { formatDate, formatDateDisplay, parseDate, todayEpochDays } from '../../lib/dates/dates';
import { buildDayTimeline, getActiveProjects, managerSummary, portfolioSummary, type OverallFocus } from '../../domain/projects';

/** Upper bound of what-if rows (one projection per tester count). */
const MAX_WHAT_IF_TESTERS = 200;

type NumberField =
  | 'totalCases'
  | 'currentTesters'
  | 'perHourPerTester'
  | 'dailyOvertimeMinutes';

const STATUS_KEY: Record<ScheduleStatus, TranslationKey> = {
  NOT_STARTED: 'status.notStarted',
  ON_SCHEDULE: 'status.onSchedule',
  AHEAD: 'status.ahead',
  DELAYED: 'status.delayed',
  COMPLETED: 'status.completed',
};

/**
 * QA execution dashboard for the active project. All business math lives in
 * pure functions under src/lib/calculations; this component only wires
 * state → engine → UI. Derived values recompute on every input change and
 * on the 30s tick (§14). Portfolio summary cards navigate to Overall.
 */
export function Dashboard({ onOpenOverall }: { onOpenOverall?: (focus: OverallFocus) => void }) {
  const app = useAppStateCtx();
  const { state, updateField, replaceState, resetToDemo, changeStartDate, deleteDailyExecutionEntry } = app;
  const guard = useSharedGuard();
  const { principal } = useTenant();
  const reportsApi = useReportsStateCtx();
  const now = useNow(30_000);
  const [importMessage, setImportMessage] = useState<ImportMessage | null>(null);
  // The date loaded in the "Today's Execution" form (editable past days
  // included) — owned here so the Daily Progress panel's per-row Edit
  // button can preload a recorded day.
  const [executionDate, setExecutionDate] = useState<string>(formatDate(todayEpochDays()));

  const lang = state.language;
  const sub = otherLanguage(lang);
  const todayEpoch = todayEpochDays();
  const today = formatDate(todayEpoch);

  const projectName = resolveBilingualName(lang, { nameEn: state.projectNameEn, nameJa: state.projectNameJa });
  const portfolio = useMemo(
    () => portfolioSummary(reportsApi.state.projects, today),
    [reportsApi.state.projects, today],
  );
  const manager = useMemo(
    () => managerSummary(reportsApi.state.projects, today, new Date().toISOString()),
    [reportsApi.state.projects, today],
  );
  // Project selector (header): every project, ordered by its stable Project
  // ID; switching loads the project into the Dashboard editing surface via
  // the established activateProject path (the write-back keeps records in
  // sync). The selected value falls back to the first project so the
  // selector never disagrees with what is being edited.
  const selectableProjects = useMemo(
    () => [...reportsApi.state.projects].sort((a, b) => a.projectId.localeCompare(b.projectId)),
    [reportsApi.state.projects],
  );
  const selectedProjectId =
    reportsApi.state.projects.find((p) => p.id === reportsApi.state.activeProjectId)?.id ??
    selectableProjects[0]?.id ??
    '';
  // Multi-day progress across every active project; one colored segment per
  // project per day when several run on the same date.
  const dayTimeline = useMemo(
    () => buildDayTimeline(getActiveProjects(reportsApi.state.projects), lang, today),
    [reportsApi.state.projects, lang, today],
  );
  const activeTimelineProjectId =
    reportsApi.state.projects.find((p) => p.id === reportsApi.state.activeProjectId)?.projectId ?? '';
  // The status card shows the schedule calculation only while the active
  // project is In Progress (ongoing); other lifecycle states (Scheduled /
  // Extended / On Hold / Done) display the neutral "Free" state instead.
  // A missing project record (legacy data) keeps the normal card.
  const activeProjectStatus =
    reportsApi.state.projects.find((p) => p.id === reportsApi.state.activeProjectId)?.status;
  const showStatusCalculation = activeProjectStatus === undefined || activeProjectStatus === 'ongoing';

  useEffect(() => {
    document.title = t(lang, 'dashboard.title');
  }, [lang]);

  // ---- validation (§24) -----------------------------------------------------
  const { errors } = useMemo(() => validateInputs(state), [state]);
  const planningValidation = useMemo(() => validatePlanning(state), [state]);

  // ---- derived values (pure calculations, §9–§16) ---------------------------
  // Whole calculation uses the workday model (§workday.ts): every day works
  // from the per-project Plan Start Time (state.startTime, default 9:00)
  // until the fixed 17:30 end with the 1-hour 12:00–13:00 lunch, and the
  // projection spans Start Date → End Date over the planning rows
  // (non-working days contribute nothing). The expected finish projects the
  // REMAINING cases from NOW: today contributes only its leftover productive
  // time, so a running project never shows a finish in the past.
  const capacityPerHour = calculateTeamCapacity(state.currentTesters, state.perHourPerTester);
  const overtimeMinutes = clampOvertimeMinutes(state.dailyOvertimeMinutes);
  const dayEnd = WORK_DAY_END + overtimeMinutes;
  const lunchMinutes = WORK_LUNCH.end - WORK_LUNCH.start;
  const productiveHours = workdayProductiveHours(state.startTime, overtimeMinutes);
  const capacityPerDay = capacityPerHour * productiveHours;
  const nowAnchor = { epochDay: todayEpoch, timeOfDay: now };
  // V7: each planning row may carry its own window; today's pace uses the
  // window that actually applies today (today's execution entry when one
  // exists, otherwise the planned/defaults window).
  const dayWindows = useMemo(
    () => dayWindowsFromRows(state.planningRows, projectDayWindowDefaults(state)),
    [state.planningRows, state.startTime, state.dailyOvertimeMinutes, state.intervalEnabled],
  );
  const todayWindow = useMemo(() => effectiveTodayWindow(state, today), [state, today]);

  const workdayProjection = calculateWorkdayProjection({
    totalCases: state.totalCases,
    casesCompleted: state.casesCompleted,
    currentTesters: state.currentTesters,
    perHourPerTester: state.perHourPerTester,
    planningRows: state.planningRows,
    startDate: state.startDate,
    endDate: state.targetCompletionDate,
    planStartTime: state.startTime,
    anchor: nowAnchor,
    dailyOvertimeMinutes: overtimeMinutes,
    dayWindows,
  });
  const requiredMinutes = workdayProjection.requiredMinutes;
  const expectedFinish = workdayProjection.expectedFinish;
  const buffer = workdayProjection.bufferMinutes;
  const requiredTesters = workdayProjection.requiredTesters;

  const expectedFinishText =
    expectedFinish === null
      ? '—'
      : `${formatDateDisplay(expectedFinish.epochDay, lang)} ${formatClock(expectedFinish.time)}`;
  const deadlineEpoch = state.targetCompletionDate === null ? null : parseDate(state.targetCompletionDate);
  const deadlineText = deadlineEpoch === null ? '—' : `${formatDateDisplay(deadlineEpoch, lang)} ${formatClock(WORK_DAY_END)}`;

  const productiveElapsedMinutes = calculateProductiveElapsedTime(now, todayWindow.start, todayWindow.lunch);
  const executionCounts = calculateExecutionCounts(state);
  const actualRate = calculateActualRate(state.casesCompleted, productiveElapsedMinutes / 60);
  const remainingCases = Math.max(0, state.totalCases - state.casesCompleted);
  const projectedFinish = calculateProjectedActualFinish(now, remainingCases, actualRate, todayWindow.lunch);
  const variance = calculateScheduleVariance(projectedFinish, WORK_DAY_END);
  const status = calculateScheduleStatus(state, now, { start: todayWindow.start, lunch: todayWindow.lunch }, buffer);
  const progress = state.totalCases > 0 ? Math.min(1, state.casesCompleted / state.totalCases) : 1;

  // ---- Level 2: executive summary, daily plan, blocking (single source of truth) ----
  const view = state.dashboardView ?? 'operator';
  const executive = useMemo(
    () => calculateExecutiveSummary(state, now, todayEpoch),
    [state, now, todayEpoch],
  );

  const dailyPlan = useMemo(
    () =>
      generateDailyPlan(
        state.planningRows,
        state.perHourPerTester,
        productiveHours,
        state.totalCases,
        state.targetPassRate ?? 1,
        state.dailyTargetOverrides ?? [],
        dayWindows,
      ),
    [state.planningRows, state.perHourPerTester, productiveHours, state.totalCases, state.targetPassRate, state.dailyTargetOverrides, dayWindows],
  );
  const currentGap = useMemo(
    () => calculateCurrentGap(dailyPlan, today, state.totalCases, state.casesCompleted, state.casesPassed ?? 0),
    [dailyPlan, today, state.totalCases, state.casesCompleted, state.casesPassed],
  );
  const todayUnavailableMinutes = useMemo(
    () => sumBlockingMinutes(state.blockingEvents ?? [], today),
    [state.blockingEvents, today],
  );

  // Planned progress for the timeline overlay: what the current pace should
  // have achieved by now (existing expected-progress engine).
  const plannedProgressRatio =
    state.totalCases > 0
      ? Math.min(1, calculateExpectedProgress(state.totalCases, capacityPerHour, productiveElapsedMinutes / 60) / state.totalCases)
      : null;

  // ---- milestone auto-detection (Level 2 §7) ----------------------------------
  const executedPct = state.totalCases > 0 ? (state.casesCompleted / state.totalCases) * 100 : null;
  const passedPct = state.totalCases > 0 ? ((state.casesPassed ?? 0) / state.totalCases) * 100 : null;
  useEffect(() => {
    const next = evaluateMilestones(state.milestones ?? [], executedPct, passedPct, new Date().toISOString());
    if (next !== state.milestones) updateField('milestones', next);
  }, [executedPct, passedPct, state.milestones, updateField]);

  /**
   * Manager view → Operator view: the single place execution results are
   * entered ("Today's Execution"). Switches the view and scrolls the form
   * into view so the daily entry workflow is one click away. With a date,
   * the form is preloaded with that recorded day for editing.
   */
  const enterExecution = useCallback(
    (date?: string): void => {
      if (date !== undefined) setExecutionDate(date);
      updateField('dashboardView', 'operator');
      requestAnimationFrame(() => {
        document.getElementById('todays-execution')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    },
    [updateField],
  );

  /** Delete a recorded day's execution entry (confirmation is asked in the panel). */
  const handleDeleteEntry = useCallback(
    (date: string): void => {
      deleteDailyExecutionEntry(date);
    },
    [deleteDailyExecutionEntry],
  );

  // ---- what-if rows (§19) ----------------------------------------------------
  // 10 tester rows by default; the user can add more or reduce them. The
  // row matching the current tester count is always kept visible. Every row
  // uses the same workday method as the projection: the REMAINING work from
  // NOW, and the finish clock carries a "(+Nd)" day offset from today.
  const workingDays = useMemo(
    () => workingEpochDays(state.planningRows, state.startDate),
    [state.planningRows, state.startDate],
  );
  const offDays = useMemo(() => excludedEpochDays(state.planningRows), [state.planningRows]);
  const [whatIfCount, setWhatIfCount] = useState(10);
  const whatIfRemainingCases = Math.max(0, state.totalCases - state.casesCompleted);
  const whatIfRows = useMemo<WhatIfRow[]>(() => {
    // Bounded like the More button (200): a huge tester count must not
    // generate one projection row per tester.
    const maxTesters = Math.min(MAX_WHAT_IF_TESTERS, Math.max(whatIfCount, state.currentTesters));
    const rows: WhatIfRow[] = [];
    for (let n = 1; n <= maxTesters; n++) {
      const hourlyCapacity = calculateTeamCapacity(n, state.perHourPerTester);
      const minutes = hourlyCapacity > 0 ? (whatIfRemainingCases / hourlyCapacity) * 60 : null;
      const finish =
        minutes === null
          ? null
          : advanceOverWorkDays(
              minutes,
              workingDays,
              state.startDate,
              state.startTime,
              nowAnchor,
              overtimeMinutes,
              offDays,
            );
      rows.push({
        testers: n,
        hourlyCapacity,
        requiredMinutes: minutes,
        expectedFinish: finish === null ? null : (finish.epochDay - todayEpoch) * 1440 + finish.time,
      });
    }
    return rows;
  }, [state.totalCases, state.casesCompleted, state.perHourPerTester, state.currentTesters, state.startDate, state.startTime, workingDays, offDays, overtimeMinutes, whatIfCount, whatIfRemainingCases, todayEpoch, now]);

  // ---- handlers (§22–§24) ----------------------------------------------------
  const handleNumberChange = (field: NumberField, raw: string): void => {
    const trimmed = raw.trim();
    if (trimmed === '') {
      updateField(field, 0);
      return;
    }
    const n = Number(trimmed);
    if (Number.isFinite(n)) updateField(field, n);
  };

  const handleExport = (): void => {
    downloadStateAsJson(state);
  };

  const handleImportFile = (file: File): void => {
    if (!guard.guardWrite()) return; // read-only people cannot replace the shared project's data
    const reader = new FileReader();
    reader.onload = () => {
      const result = parseImportPayload(String(reader.result ?? ''));
      if (result.ok) {
        replaceState(result.data);
        setImportMessage({ kind: 'ok', text: t(lang, 'messages.importOk') });
      } else {
        setImportMessage({ kind: 'error', text: t(lang, result.errorKey) });
      }
    };
    reader.onerror = () => setImportMessage({ kind: 'error', text: t(lang, 'messages.importErrRead') });
    reader.readAsText(file);
  };

  /**
   * Reset the active project's inputs to demo data. Destructive for the
   * active project (execution counts, plan, name are replaced), so an
   * explicit confirmation identifying the project is required first —
   * consistent with Delete Project / Clear All Local Data.
   */
  const handleReset = (): void => {
    const name =
      resolveBilingualName(lang, { nameEn: state.projectNameEn, nameJa: state.projectNameJa }) ||
      t(lang, 'app.title');
    if (!window.confirm(t(lang, 'dashboard.confirmReset', { name }))) return;
    // In shared mode the project is everyone's: say so, and never for read-only people.
    if (!guard.confirmEveryone('shared.confirm.resetProject')) return;
    resetToDemo();
    setImportMessage(null);
  };

  // ---- status card facts (§17) -----------------------------------------------
  const statusFacts: StatusFact[] = [
    { label: t(lang, 'labels.expectedFinish'), value: expectedFinishText, hint: t(lang, 'hint.plannedFinish') },
    { label: t(lang, 'dashboard.deadline'), value: deadlineText },
    buffer === null
      ? { label: t(lang, 'labels.buffer'), value: '—' }
      : buffer >= 0
        ? { label: t(lang, 'labels.buffer'), value: formatSignedMultiDayDuration(buffer), hint: t(lang, 'hint.buffer') }
        : { label: t(lang, 'labels.delay'), value: formatSignedMultiDayDuration(-buffer) },
    { label: t(lang, 'labels.now'), value: formatClock(now) },
  ];

  const resultTone = buffer === null ? 'default' : buffer >= 0 ? 'good' : 'bad';
  const resultText =
    buffer === null ? '—' : t(lang, buffer >= 0 ? 'dashboard.feasible' : 'dashboard.overtimeRequired');
  const varianceTone = variance === null ? 'default' : variance >= 0 ? 'good' : 'bad';

  // ---- Level 2 §6: explainable status facts ----------------------------------
  // The last three facts expose the capacity arithmetic behind the planned
  // finish date (team rate → execution time needed → time actually left
  // today), so "why this date?" is answerable at a glance.
  const timeLeftTodayMinutes =
    now >= todayWindow.end
      ? 0
      : Math.max(
          0,
          calculateProductiveHours(
            Math.min(todayWindow.end, Math.max(now, todayWindow.start)),
            todayWindow.end,
            todayWindow.lunch,
          ) * 60,
        );
  const explanationFacts: StatusFact[] = [
    {
      label: t(lang, 'statusExplain.execute'),
      value: `${formatInteger(state.casesCompleted, lang)} / ${formatCases(currentGap.plannedExecuteToDate, lang)}`,
    },
    {
      label: t(lang, 'statusExplain.executeAchievement'),
      value: currentGap.executeAchievementPct === null ? '—' : `${formatNumber(currentGap.executeAchievementPct, 1, lang)}%`,
    },
    {
      label: t(lang, 'statusExplain.pass'),
      value: `${formatInteger(state.casesPassed ?? 0, lang)} / ${formatCases(currentGap.plannedPassToDate, lang)}`,
    },
    {
      label: t(lang, 'statusExplain.passAchievement'),
      value: currentGap.passAchievementPct === null ? '—' : `${formatNumber(currentGap.passAchievementPct, 1, lang)}%`,
    },
    { label: t(lang, 'statusExplain.qaUnavailable'), value: formatDuration(todayUnavailableMinutes) },
    { label: t(lang, 'statusExplain.projectedFinish'), value: formatClock(projectedFinish), hint: t(lang, 'hint.forecastFinish') },
    { label: t(lang, 'statusExplain.scheduleVariance'), value: formatSignedDuration(variance), hint: t(lang, 'hint.scheduleVariance') },
    {
      label: t(lang, 'statusExplain.teamRate'),
      value: `${formatInteger(state.currentTesters, lang)} × ${formatNumber(state.perHourPerTester, 1, lang)} = ${formatInteger(capacityPerHour, lang)} ${t(lang, 'units.casesPerHour')}`,
    },
    {
      label: t(lang, 'statusExplain.executionTimeNeeded'),
      value: requiredMinutes === null ? '—' : formatDuration(requiredMinutes),
      hint: t(lang, 'hint.requiredHours'),
    },
    {
      label: t(lang, 'statusExplain.timeLeftToday'),
      value: formatDuration(timeLeftTodayMinutes),
      hint: t(lang, 'hint.dailyOvertime'),
    },
  ];

  // ---- execution progress status (Working / Completed / Not Started) ----------
  const executionStatusKey: TranslationKey =
    state.casesCompleted > 0 && state.casesCompleted >= state.totalCases
      ? 'status.completed'
      : state.casesCompleted > 0
        ? 'status.working'
        : 'status.notStarted';
  const executionTone = executionStatusKey === 'status.completed' ? 'good' : 'default';

  // ---- render (§8, §26) ------------------------------------------------------
  return (
    <div className="app">
      <WorkspaceEmptyNotice lang={lang} principal={principal} projectCount={reportsApi.state.projects.length} />
      <header className="app-header">
        <div className="app-title-group">
          <h1>{t(lang, 'app.title')}</h1>
          {projectName === '' ? null : <span className="app-project-name">{projectName}</span>}
          <span className="app-subtitle">{t(lang, 'app.subtitle')}</span>
        </div>
        <div className="app-header-actions">
          {selectableProjects.length > 0 ? (
            <label className="dr-toolbar-field">
              {t(lang, 'overall.projects')}
              <select
                className="input"
                value={selectedProjectId}
                onChange={(e) => activateProject(reportsApi, app, e.target.value)}
              >
                {selectableProjects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {resolveBilingualName(lang, { nameEn: project.nameEn, nameJa: project.nameJa }) || project.projectId}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="view-toggle" role="group" aria-label={t(lang, 'buttons.view')}>
            <button
              type="button"
              className={view === 'operator' ? 'active' : undefined}
              aria-pressed={view === 'operator'}
              onClick={() => updateField('dashboardView', 'operator')}
            >
              {t(lang, 'views.operator')}
            </button>
            <button
              type="button"
              className={view === 'manager' ? 'active' : undefined}
              aria-pressed={view === 'manager'}
              onClick={() => updateField('dashboardView', 'manager')}
            >
              {t(lang, 'views.manager')}
            </button>
          </div>
          <div className="lang-toggle" role="group" aria-label={t(lang, 'app.languageLabel')}>
            {LANGUAGES.map((option) => (
              <button
                key={option.code}
                type="button"
                className={lang === option.code ? 'active' : undefined}
                aria-pressed={lang === option.code}
                onClick={() => updateField('language', option.code)}
              >
                {option.short}
              </button>
            ))}
          </div>
          <DataControls
            labels={{
              export: t(lang, 'buttons.export'),
              import: t(lang, 'buttons.import'),
              reset: t(lang, 'buttons.reset'),
            }}
            message={importMessage}
            onExport={handleExport}
            onImportFile={handleImportFile}
            onReset={handleReset}
          />
        </div>
      </header>

      {showStatusCalculation ? (
        <>
          <StatusCard status={status} statusLabel={t(lang, STATUS_KEY[status])} facts={statusFacts} />
          <StatusExplanation title={t(lang, 'statusExplain.title')} facts={explanationFacts} />
        </>
      ) : (
        <FreeStatusCard label={t(lang, 'status.free')} />
      )}
      <ExecutiveSummaryView summary={executive} lang={lang} />

      {onOpenOverall !== undefined ? (
        <div className="overall-summary dashboard-portfolio-summary">
          {(
            [
              { key: 'dashboard.activeProjects' as TranslationKey, value: portfolio.total - portfolio.done, focus: { lifecycle: 'active' } as OverallFocus },
              { key: 'overall.ongoing' as TranslationKey, value: portfolio.ongoing, focus: { lifecycle: 'ongoing' } as OverallFocus },
              { key: 'overall.todo' as TranslationKey, value: portfolio.todo, focus: { lifecycle: 'todo' } as OverallFocus },
              { key: 'overall.extended' as TranslationKey, value: portfolio.extended, focus: { lifecycle: 'extended' } as OverallFocus },
              { key: 'overall.onHold' as TranslationKey, value: portfolio.onHold, focus: { lifecycle: 'onHold' } as OverallFocus },
              { key: 'overall.done' as TranslationKey, value: portfolio.done, focus: { lifecycle: 'done' } as OverallFocus },
              { key: 'status.atRisk' as TranslationKey, value: portfolio.atRisk, focus: { planning: 'atRisk' } as OverallFocus },
            ] as const
          ).map((card) => (
            <button key={card.key} type="button" className="summary-card" onClick={() => onOpenOverall(card.focus)}>
              <span className="summary-card-label">{t(lang, card.key)}</span>
              <span className="summary-card-value">{formatInteger(card.value, lang)}</span>
              <span className="summary-card-arrow" aria-hidden="true">→</span>
            </button>
          ))}
        </div>
      ) : null}

      {onOpenOverall !== undefined && manager.activeProjects + manager.completedProjects > 0 ? (
        <div className="overall-summary dashboard-manager-summary" role="group" aria-label={t(lang, 'dashboard.manager.title')}>
          {(
            [
              { key: 'dashboard.manager.needsAttention' as TranslationKey, value: formatInteger(manager.needsAttention, lang), warn: manager.needsAttention > 0 },
              { key: 'dashboard.manager.overdue' as TranslationKey, value: formatInteger(manager.overdue, lang), warn: manager.overdue > 0 },
              { key: 'dashboard.manager.executingToday' as TranslationKey, value: formatInteger(manager.executingToday, lang), warn: false },
              { key: 'dashboard.manager.plannedCases' as TranslationKey, value: formatInteger(manager.plannedCases, lang), warn: false },
              { key: 'dashboard.manager.remainingCases' as TranslationKey, value: formatInteger(manager.remainingCases, lang), warn: false },
              { key: 'dashboard.manager.progress' as TranslationKey, value: manager.progress === null ? '—' : `${Math.round(manager.progress * 100)}%`, warn: false },
            ] as const
          ).map((card) => (
            <div key={card.key} className={`summary-card${card.warn ? ' summary-card-warn' : ''}`}>
              <span className="summary-card-label">{t(lang, card.key)}</span>
              <span className="summary-card-value">
                {card.warn ? <span aria-hidden="true">⚠ </span> : null}
                {card.value}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {view === 'operator' ? (
        <div className="dashboard-grid">
          <SectionCard title={t(lang, 'sections.input')} subtitle={t(sub, 'sections.input')} span={5}>
          <div className="input-grid">
            <Field label={t(lang, 'fields.totalCases')} error={errors.totalCases ? t(lang, errors.totalCases) : undefined}>
              <input
                className="input"
                type="number"
                min={0}
                step={1}
                value={state.totalCases}
                onChange={(e) => handleNumberChange('totalCases', e.target.value)}
              />
            </Field>
            <Field label={t(lang, 'fields.currentTesters')} error={errors.currentTesters ? t(lang, errors.currentTesters) : undefined}>
              <input
                className="input"
                type="number"
                min={1}
                step={1}
                value={state.currentTesters}
                onChange={(e) => handleNumberChange('currentTesters', e.target.value)}
              />
            </Field>
            <Field label={t(lang, 'fields.startDate')}>
              <input
                className="input"
                type="date"
                value={state.startDate}
                onChange={(e) => changeStartDate(e.target.value)}
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
                onChange={(e) => updateField('targetCompletionDate', e.target.value === '' ? null : e.target.value)}
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
                onChange={(e) => handleNumberChange('perHourPerTester', e.target.value)}
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
                onChange={(e) => handleNumberChange('dailyOvertimeMinutes', e.target.value)}
                title={t(lang, 'hint.dailyOvertime')}
              />
            </Field>
          </div>
        </SectionCard>

        <SectionCard title={t(lang, 'sections.capacity')} subtitle={t(sub, 'sections.capacity')} span={3}>
          <div className="metrics-grid">
            <MetricCard label={t(lang, 'metrics.lunchHours')} value={formatDuration(lunchMinutes)} />
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

        <SectionCard title={t(lang, 'sections.projection')} subtitle={t(sub, 'sections.projection')} span={4}>
          <div className="metrics-grid">
            <MetricCard label={t(lang, 'dashboard.requiredTesters')} value={formatInteger(requiredTesters, lang)} hint={t(lang, 'hint.requiredTesters')} />
            <MetricCard label={t(lang, 'metrics.requiredHours')} value={formatDuration(requiredMinutes)} hint={t(lang, 'hint.requiredHours')} />
            <MetricCard label={t(lang, 'metrics.expectedEnd')} value={expectedFinishText} hint={t(lang, 'hint.plannedFinish')} />
            <MetricCard label={t(lang, 'metrics.buffer')} value={formatSignedMultiDayDuration(buffer)} tone={resultTone} hint={t(lang, 'hint.buffer')} />
            <MetricCard label={t(lang, 'metrics.result')} value={resultText} tone={resultTone} />
          </div>
        </SectionCard>

        <SectionCard title={t(lang, 'sections.execution')} subtitle={t(sub, 'sections.execution')} span={12}>
          {/* V7: daily execution entries are the single source of truth for
              actuals. This form records ONE day's counts (not cumulative);
              saving recomputes the canonical totals as Σ entries —
              casesCompleted = Σ(Pass + Fail + N/A + SPO), exactly the
              previous V6.4 composition, one level up. */}
          <h3 className="exec-subsection-title" id="todays-execution">{t(lang, 'exec.todayTitle')}</h3>
          <DailyExecutionForm lang={lang} date={executionDate} onDateChange={setExecutionDate} />
          <h3 className="exec-subsection-title exec-subsection-derived">{t(lang, 'exec.liveStatus')}</h3>
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

        <SectionCard title={t(lang, 'timeline.title')} subtitle={t(sub, 'timeline.title')} span={12}>
          <Timeline
            startTime={state.startTime}
            targetFinish={dayEnd}
            lunch={WORK_LUNCH}
            expectedFinish={
              // Today's intraday chart only shows the marker when the
              // expected finish falls on TODAY (never a past/future day).
              expectedFinish !== null && expectedFinish.epochDay === todayEpoch ? expectedFinish.time : null
            }
            projectedFinish={projectedFinish}
            now={now}
            progress={progress}
            labels={{
              start: t(lang, 'timeline.start'),
              now: t(lang, 'timeline.now'),
              expected: t(lang, 'timeline.expected'),
              projected: t(lang, 'timeline.projected'),
              target: t(lang, 'timeline.target'),
              lunch: t(lang, 'timeline.lunch'),
              progress: t(lang, 'timeline.progress'),
              planned: t(lang, 'timeline.planned'),
              capacity: t(lang, 'timeline.capacity'),
            }}
            plannedProgress={plannedProgressRatio}
            capacityPerHour={capacityPerHour}
          />
          {dayTimeline.days.length > 1 ? <MultiDayTimeline data={dayTimeline} lang={lang} defaultProjectId={activeTimelineProjectId} /> : null}
        </SectionCard>

        <WhatIfTable
          rows={whatIfRows}
          currentTesters={state.currentTesters}
          onSelect={(testers) => updateField('currentTesters', testers)}
          lang={lang}
          labels={{
            title: t(lang, 'whatIf.title'),
            hint: t(lang, 'whatIf.hint'),
            testers: t(lang, 'whatIf.testers'),
            hourlyCapacity: t(lang, 'whatIf.hourlyCapacity'),
            requiredTime: t(lang, 'whatIf.requiredTime'),
            expectedFinish: t(lang, 'whatIf.expectedFinish'),
            currentTag: t(lang, 'whatIf.currentTag'),
            more: t(lang, 'whatIf.showMore'),
            fewer: t(lang, 'whatIf.showFewer'),
          }}
          onMore={() => setWhatIfCount((count) => Math.min(MAX_WHAT_IF_TESTERS, count + 5))}
          onFewer={() => setWhatIfCount((count) => Math.max(1, count - 5))}
        />
        </div>
      ) : (
        <div className="dashboard-grid">
          <CollapsibleSection title={t(lang, 'recovery.title')} subtitle={t(sub, 'recovery.title')} defaultOpen>
            <RecoveryPanel now={now} />
          </CollapsibleSection>
          <CollapsibleSection title={t(lang, 'gap.title')} subtitle={t(sub, 'gap.title')} defaultOpen>
            <DailyProgressPanel onEnterExecution={enterExecution} onEditEntry={enterExecution} onDeleteEntry={handleDeleteEntry} />
          </CollapsibleSection>
          <CollapsibleSection title={t(lang, 'blocking.title')} subtitle={t(sub, 'blocking.title')}>
            <BlockingPanel now={now} />
          </CollapsibleSection>
          <CollapsibleSection title={t(lang, 'milestones.title')} subtitle={t(sub, 'milestones.title')}>
            <MilestonePanel now={now} />
          </CollapsibleSection>
        </div>
      )}
    </div>
  );
}

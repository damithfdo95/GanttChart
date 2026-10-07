import { useEffect, useMemo, useState } from 'react';
import type { AttendanceRecord, DailyReport as DailyReportEntity, DailyTopic, Language, ReportActivity } from '../../types';
import { useAppStateCtx } from '../../app/state-contexts';
import { useReportsStateCtx } from '../../app/state-contexts';
import { t, LANGUAGES } from '../../i18n';
import { generateId } from '../../lib/id';
import { formatDate, todayEpochDays } from '../../lib/dates/dates';
import { calculateMultiDayProjection } from '../../lib/calculations/planning';
import { WORK_DAY_END, WORK_LUNCH } from '../../lib/calculations/workday';
import { buildNextDaySuggestions, nextBusinessDay } from '../../lib/reporting/nextday';
import { renderMorningAttendanceLine, renderMorningReport } from '../../lib/reporting/morning';
import { buildReportSections, renderAttendanceSection, renderProgressSection } from '../../lib/reporting/sections';
import { renderReport } from '../../lib/reporting/template';
import { buildExecutionReport, renderExecutionSummarySection } from '../../lib/reporting/execution';
import { createRevision, finalizeReport, findDraft, newDraft, seedAutoActivities } from '../../lib/reporting/drafts';
import { entryForDate } from '../../lib/calculations/dailyExecuted';
import { buildXlsx, type XlsxSheet } from '../../lib/export/xlsx';
import { downloadBinaryFile, downloadTextFile } from '../../lib/export/download';
import { printHtml, textToHtml } from '../../lib/export/print';
import { AttendanceSection } from './AttendanceSection';
import { ActivitiesSection } from './ActivitiesSection';
import { TopicsSection } from './TopicsSection';
import { NextDaySection } from './NextDaySection';
import { MorningScheduleSection } from './MorningScheduleSection';
import { TablePager } from '../../components/TablePager';
import { usePagedRows } from '../../lib/pagination/usePagedRows';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Daily Report screen. The report language is independent of the UI language
 * (UI = English + Report = Japanese is fully supported). Drafts are created
 * per date; finalizing freezes a snapshot so historical numbers are never
 * recalculated; revised versions preserve previous ones.
 */
export function DailyReport() {
  const app = useAppStateCtx();
  const reportsApi = useReportsStateCtx();
  const uiLang = app.state.language;
  const settings = reportsApi.state.settings;

  const [selectedDate, setSelectedDate] = useState<string>(() => formatDate(todayEpochDays()));
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [mode, setMode] = useState<'morning' | 'eod'>('eod');
  const [previewText, setPreviewText] = useState('');
  const [morningPreview, setMorningPreview] = useState('');
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const draft = useMemo(
    () => findDraft(reportsApi.state.reports, selectedDate),
    [reportsApi.state.reports, selectedDate],
  );
  const viewingReport: DailyReportEntity | null =
    viewingId !== null ? reportsApi.state.reports.find((r) => r.id === viewingId) ?? null : null;
  const finalizedForDate = useMemo(
    () => reportsApi.state.reports.some((r) => r.reportDate === selectedDate && r.status === 'FINALIZED'),
    [reportsApi.state.reports, selectedDate],
  );

  // One draft per selected date, created on first visit. The draft references
  // the active project by its stable Project ID (names may be edited later;
  // finalized snapshots keep the displayed names). A date with a FINALIZED
  // report never auto-spawns a replacement draft — revisions are explicit.
  const activeProjectId = reportsApi.state.projects.find(
    (p) => p.id === reportsApi.state.activeProjectId,
  )?.projectId ?? null;

  useEffect(() => {
    if (findDraft(reportsApi.state.reports, selectedDate) === undefined && !finalizedForDate) {
      const created = newDraft(selectedDate, uiLang, settings.supervisorName, nowIso(), activeProjectId);
      // Seed today's schedule for the morning report from the live plan.
      const seeded = morningScheduleSuggestions(uiLang);
      if (seeded.length > 0) {
        created.morningSchedule = seeded.map((text) => ({ id: generateId(), text, source: 'AUTO' as const }));
      }
      reportsApi.upsertReport(created);
    }
  }, [selectedDate, reportsApi, uiLang, settings.supervisorName, activeProjectId, finalizedForDate]);

  useEffect(() => {
    setPreviewText(draft?.previewText ?? '');
    setMorningPreview(draft?.morningPreviewText ?? '');
    setMessage(null);
  }, [draft?.id, selectedDate]);

  const attendanceForDate = reportsApi.state.attendance.filter((r) => r.date === selectedDate);
  // The canonical daily execution entry for the report date (if any): the
  // copy button and the auto-seed draw the day's counts from it.
  const dayEntry = entryForDate(app.state.dailyExecuted ?? [], selectedDate);
  const topicsForDate = reportsApi.state.topics
    .filter((tp) => tp.reportDate === selectedDate)
    .sort((a, b) => a.displayOrder - b.displayOrder);

  const reportLanguage: Language = draft?.language ?? uiLang;
  const nbDate = nextBusinessDay(selectedDate, settings.holidays);
  const planningRow = app.state.planningRows.find((r) => r.date === nbDate);

  const projection = useMemo(
    () =>
      calculateMultiDayProjection({
        casesRemaining: Math.max(0, app.state.totalCases - app.state.casesCompleted),
        planningRows: app.state.planningRows,
        perHourPerTester: app.state.perHourPerTester,
        workStartTime: app.state.startTime,
        workEndTime: WORK_DAY_END,
        lunch: WORK_LUNCH,
        targetCompletionDate: app.state.targetCompletionDate,
        targetCompletionTime: null,
        dailyOvertimeMinutes: app.state.dailyOvertimeMinutes,
      }),
    [app.state],
  );

  const projectNameFor = (language: Language): string =>
    (language === 'en' ? app.state.projectNameEn : app.state.projectNameJa) ||
    (language === 'en' ? app.state.projectNameJa : app.state.projectNameEn) ||
    t(language, 'app.title');

  const todayPlanningRow = app.state.planningRows.find((r) => r.date === selectedDate);
  /** Suggested "Today's schedule" items for the morning report, in the report language. */
  const morningScheduleSuggestions = (language: Language): string[] => {
    const remaining = Math.max(0, app.state.totalCases - app.state.casesCompleted);
    if (todayPlanningRow === undefined && remaining <= 0) return [];
    return [projectNameFor(language)];
  };

  const suggestions = buildNextDaySuggestions(reportLanguage, {
    projectName: projectNameFor(reportLanguage),
    remainingCases: Math.max(0, app.state.totalCases - app.state.casesCompleted),
    shortageByDeadline: projection.shortageByDeadline,
    nextBusinessDate: nbDate,
    scheduledTesters: planningRow ? Math.max(0, planningRow.plannedTesters - planningRow.absentTesters) : null,
  });

  const upsertDraft = (mutate: (report: DailyReportEntity) => DailyReportEntity): void => {
    if (draft === undefined) return;
    reportsApi.upsertReport(mutate(draft));
  };

  // ---- handlers ---------------------------------------------------------------

  const handleRefreshData = (): void => {
    if (draft === undefined) return;
    // Refresh replaces auto-seeded activities and suggested next-day items;
    // manual entries are kept. Confirm first so edits are never lost silently.
    if (!window.confirm(t(uiLang, 'dailyReport.refreshConfirm'))) return;
    const seeded = seedAutoActivities(draft.language, app.state, selectedDate);
    const manual = draft.activities.filter((a) => a.source === 'MANUAL');
    const freshSuggestions = buildNextDaySuggestions(draft.language, {
      projectName: projectNameFor(draft.language),
      remainingCases: Math.max(0, app.state.totalCases - app.state.casesCompleted),
      shortageByDeadline: projection.shortageByDeadline,
      nextBusinessDate: nbDate,
      scheduledTesters: planningRow ? Math.max(0, planningRow.plannedTesters - planningRow.absentTesters) : null,
    });
    reportsApi.upsertReport({
      ...draft,
      activities: [...seeded, ...manual],
      nextDay: [
        ...freshSuggestions.map((text) => ({ id: generateId(), text, source: 'SUGGESTED' as const })),
        ...draft.nextDay.filter((n) => n.source === 'MANUAL'),
      ],
      updatedAt: nowIso(),
    });
    setMessage({ kind: 'ok', text: t(uiLang, 'dailyReport.refreshedMessage') });
  };

  const handleGenerate = (): void => {
    if (draft === undefined) return;
    const sections = buildReportSections({
      language: draft.language,
      activities: draft.activities,
      attendance: attendanceForDate,
      members: reportsApi.state.rcsMembers ?? [],
      topics: topicsForDate,
      nextDay: draft.nextDay,
      jiraUrl: draft.jiraUrl ?? settings.projectJiraUrl ?? '',
      rules: settings.progressRules,
      executionSummary: renderExecutionSummarySection(
        draft.language,
        buildExecutionReport({
          date: draft.reportDate,
          projects: reportsApi.state.projects,
          cycles: reportsApi.state.cycles ?? [],
          assignments: reportsApi.state.testerAssignments ?? [],
          members: reportsApi.state.rcsMembers ?? [],
          nowIso: nowIso(),
        }),
      ),
    });
    const text = renderReport(settings.templates[draft.language], sections);
    setPreviewText(text);
    // Generation always references the project whose live data seeded the report.
    reportsApi.upsertReport({ ...draft, projectId: activeProjectId, previewText: text, updatedAt: nowIso() });
  };

  const handleSaveDraft = (): void => {
    if (draft === undefined) return;
    reportsApi.upsertReport({ ...draft, previewText, morningPreviewText: morningPreview, updatedAt: nowIso() });
  };

  // ---- shared export helpers (used by both report modes) -------------------------

  const copyReportText = (text: string): void => {
    void navigator.clipboard
      .writeText(text)
      .then(() => setMessage({ kind: 'ok', text: t(uiLang, 'dailyReport.copied') }))
      .catch(() => setMessage({ kind: 'error', text: t(uiLang, 'dailyReport.copyFailed') }));
  };

  const exportReportTxt = (fileName: string, text: string): void => {
    downloadTextFile(fileName, 'text/plain;charset=utf-8', text);
    setMessage({ kind: 'ok', text: t(uiLang, 'dailyReport.exportedMessage') });
  };

  const exportReportPdf = (title: string, text: string): void => {
    const opened = printHtml(`${title} — ${selectedDate}`, textToHtml(text));
    if (!opened) setMessage({ kind: 'error', text: t(uiLang, 'dailyReport.popupBlocked') });
  };

  const exportReportExcel = (fileName: string, title: string, text: string): void => {
    try {
      const sheet: XlsxSheet = {
        name: title,
        headers: [title],
        rows: text.split('\n').map((line) => [line]),
      };
      downloadBinaryFile(fileName, XLSX_MIME, buildXlsx([sheet]));
      setMessage({ kind: 'ok', text: t(uiLang, 'dailyReport.exportedMessage') });
    } catch {
      setMessage({ kind: 'error', text: t(uiLang, 'dailyReport.exportFailed') });
    }
  };

  const handleCopy = (): void => copyReportText(previewText);

  const handleExportTxt = (): void => exportReportTxt(`daily-report-${selectedDate}.txt`, previewText);

  const handleExportPdf = (): void => exportReportPdf(t(uiLang, 'dailyReport.title'), previewText);

  const handleExportExcel = (): void =>
    exportReportExcel(`daily-report-${selectedDate}.xlsx`, t(uiLang, 'dailyReport.title'), previewText);

  // ---- morning report handlers ----------------------------------------------------

  const handleGenerateMorning = (): void => {
    if (draft === undefined) return;
    const text = renderMorningReport(reportLanguage, {
      date: selectedDate,
      records: attendanceForDate,
      members: reportsApi.state.rcsMembers ?? [],
      schedule: draft.morningSchedule ?? [],
    });
    setMorningPreview(text);
    reportsApi.upsertReport({ ...draft, morningPreviewText: text, updatedAt: nowIso() });
  };

  const handleRefreshMorning = (): void => {
    if (draft === undefined) return;
    // Refresh replaces the auto-seeded schedule item; manual items are kept.
    if (!window.confirm(t(uiLang, 'dailyReport.morningRefreshConfirm'))) return;
    const seeded = morningScheduleSuggestions(draft.language).map((text) => ({
      id: generateId(),
      text,
      source: 'AUTO' as const,
    }));
    const manual = (draft.morningSchedule ?? []).filter((item) => item.source === 'MANUAL');
    reportsApi.upsertReport({ ...draft, morningSchedule: [...seeded, ...manual], updatedAt: nowIso() });
    setMessage({ kind: 'ok', text: t(uiLang, 'dailyReport.refreshedMessage') });
  };

  const handleCopyMorning = (): void => copyReportText(morningPreview);

  const handleExportMorningTxt = (): void => exportReportTxt(`morning-report-${selectedDate}.txt`, morningPreview);

  const handleExportMorningPdf = (): void =>
    exportReportPdf(t(uiLang, 'dailyReport.modeMorning'), morningPreview);

  const handleExportMorningExcel = (): void =>
    exportReportExcel(`morning-report-${selectedDate}.xlsx`, t(uiLang, 'dailyReport.modeMorning'), morningPreview);

  const handleFinalize = (): void => {
    if (draft === undefined) return;
    // Finalizing freezes an immutable snapshot; require an explicit confirm.
    if (!window.confirm(t(uiLang, 'dailyReport.finalizeConfirm'))) return;
    const finalized = finalizeReport(draft, attendanceForDate, topicsForDate, settings.supervisorName, nowIso());
    reportsApi.upsertReport(finalized);
    setViewingId(finalized.id);
    setMessage({ kind: 'ok', text: t(uiLang, 'dailyReport.finalizedMessage') });
  };

  const handleDeleteDraft = (): void => {
    if (draft === undefined) return;
    if (!window.confirm(t(uiLang, 'dailyReport.confirmDeleteDraft'))) return;
    reportsApi.removeReport(draft.id);
    setMessage({ kind: 'ok', text: t(uiLang, 'dailyReport.draftDeleted') });
  };

  const handleAddAttendance = (): void => {
    // Absence-only input (V6.9-B): rows are absences; members without a
    // record attend by default.
    const record: AttendanceRecord = {
      id: generateId(),
      date: selectedDate,
      memberName: '',
      // Team is internal-only now (kept for exports/legacy data); it is
      // filled from the selected member's master entry.
      team: '',
      status: 'ABSENT',
      workingStart: null,
      workingEnd: null,
      leaveType: null,
      comment: '',
    };
    reportsApi.addAttendance(record);
  };

  const handleAddActivity = (): void => {
    const activity: ReportActivity = {
      id: generateId(),
      source: 'MANUAL',
      name: '',
      memberCount: 1,
      completedCases: 0,
      workingStatus: '',
      included: true,
      totalCases: 0,
      workingEligibleCases: 0,
      startedCases: 0,
      blockedCases: 0,
      notApplicableCases: 0,
      spoAssigned: 0,
      casesPassed: 0,
      casesFailed: 0,
      casesRetest: 0,
      casesQuestioned: 0,
      dueDate: null,
    };
    upsertDraft((report) => ({ ...report, activities: [...report.activities, activity], updatedAt: nowIso() }));
  };

  const handleAddTopic = (): void => {
    const iso = nowIso();
    const topic: DailyTopic = {
      id: generateId(),
      reportDate: selectedDate,
      title: '',
      description: '',
      displayOrder: topicsForDate.length,
      createdBy: settings.supervisorName,
      createdAt: iso,
      updatedAt: iso,
    };
    reportsApi.addTopic(topic);
  };

  const handleTopicsChange = (updated: DailyTopic[]): void => {
    const others = reportsApi.state.topics.filter((tp) => tp.reportDate !== selectedDate);
    reportsApi.setTopics([...others, ...updated.map((tp, i) => ({ ...tp, displayOrder: i }))]);
  };

  const createRevisionFrom = (report: DailyReportEntity): void => {
    const revision = createRevision(report, nowIso());
    reportsApi.upsertReport(revision);
    setViewingId(null);
    setSelectedDate(revision.reportDate);
  };

  const handleCreateRevision = (): void => {
    if (viewingReport === null) return;
    createRevisionFrom(viewingReport);
  };

  // ---- render -------------------------------------------------------------------

  const sortedReports = [...reportsApi.state.reports].sort(
    (a, b) => (b.reportDate === a.reportDate ? b.createdAt.localeCompare(a.createdAt) : b.reportDate.localeCompare(a.reportDate)),
  );
  // The report history grows daily (drafts, revisions, finalized) — the
  // table paginates instead of scrolling 420px; the list is newest-first.
  const pager = usePagedRows(sortedReports, 10);

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title-group">
          <h1>{t(uiLang, 'dailyReport.title')}</h1>
        </div>
        <div className="app-header-actions">
          <div className="dr-mode-toggle" role="group" aria-label={t(uiLang, 'dailyReport.title')}>
            <button
              type="button"
              className={mode === 'eod' ? 'active' : undefined}
              aria-pressed={mode === 'eod'}
              onClick={() => setMode('eod')}
            >
              {t(uiLang, 'dailyReport.modeEod')}
            </button>
            <button
              type="button"
              className={mode === 'morning' ? 'active' : undefined}
              aria-pressed={mode === 'morning'}
              onClick={() => setMode('morning')}
            >
              {t(uiLang, 'dailyReport.modeMorning')}
            </button>
          </div>
          <label className="dr-toolbar-field">
            {t(uiLang, 'dailyReport.date')}
            <input
              className="input"
              type="date"
              value={selectedDate}
              onChange={(e) => {
                if (e.target.value !== '') {
                  setViewingId(null);
                  setSelectedDate(e.target.value);
                }
              }}
            />
          </label>
          <label className="dr-toolbar-field">
            {t(uiLang, 'dailyReport.reportLanguage')}
            <select
              className="input"
              value={reportLanguage}
              disabled={viewingReport !== null || draft === undefined}
              onChange={(e) => {
                const value = e.target.value as Language;
                if (draft !== undefined) reportsApi.upsertReport({ ...draft, language: value, updatedAt: nowIso() });
              }}
            >
              {LANGUAGES.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.native}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      {message !== null ? <div className={`dr-message ${message.kind}`} role="status">{message.text}</div> : null}

      {viewingReport !== null ? (
        <section className="dr-section dr-finalized">
          <h2>
            {t(uiLang, 'dailyReport.readOnly')} — {viewingReport.reportDate} (
            {LANGUAGES.find((option) => option.code === viewingReport.language)?.native ?? viewingReport.language})
            {viewingReport.revisionOf !== null ? ` · ${t(uiLang, 'dailyReport.revision', { date: viewingReport.reportDate })}` : ''}
          </h2>
          <p className="dr-summary">
            {t(uiLang, 'columns.finalizedAt')}: {viewingReport.finalizedAt ?? '—'} · {t(uiLang, 'columns.finalizedBy')}:{' '}
            {viewingReport.finalizedBy ?? '—'}
          </p>
          <pre className="dr-preview-readonly">{viewingReport.previewText}</pre>
          <p className="exec-help">{t(uiLang, 'dailyReport.editRevisionHint')}</p>
          <div className="dr-button-row">
            <button type="button" className="btn" onClick={() => setViewingId(null)}>
              {t(uiLang, 'buttons.close')}
            </button>
            <button type="button" className="btn" onClick={handleCreateRevision}>
              {t(uiLang, 'buttons.revise')}
            </button>
          </div>
        </section>
      ) : (
        <>
          {draft === undefined && finalizedForDate ? (
            <section className="dr-section dr-finalized">
              <h2>{t(uiLang, 'dailyReport.finalizedExistsTitle')}</h2>
              <p className="dr-empty">{t(uiLang, 'dailyReport.finalizedExistsBody')}</p>
              <div className="dr-button-row">
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    const finalized = reportsApi.state.reports.find(
                      (r) => r.reportDate === selectedDate && r.status === 'FINALIZED',
                    );
                    if (finalized !== undefined) createRevisionFrom(finalized);
                  }}
                >
                  {t(uiLang, 'dailyReport.editRevision')}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    const finalized = reportsApi.state.reports.find(
                      (r) => r.reportDate === selectedDate && r.status === 'FINALIZED',
                    );
                    if (finalized !== undefined) setViewingId(finalized.id);
                  }}
                >
                  {t(uiLang, 'buttons.view')}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    reportsApi.upsertReport(
                      newDraft(selectedDate, uiLang, settings.supervisorName, nowIso(), activeProjectId),
                    )
                  }
                >
                  {t(uiLang, 'dailyReport.newDraftForDate')}
                </button>
              </div>
            </section>
          ) : null}

          <AttendanceSection
            records={attendanceForDate}
            members={reportsApi.state.rcsMembers ?? []}
            lang={uiLang}
            summary={
              mode === 'morning'
                ? renderMorningAttendanceLine(uiLang, attendanceForDate, reportsApi.state.rcsMembers ?? [])
                : renderAttendanceSection(uiLang, attendanceForDate, reportsApi.state.rcsMembers ?? [])
            }
            onAdd={handleAddAttendance}
            onUpdate={reportsApi.updateAttendance}
            onRemove={reportsApi.removeAttendance}
          />

          {mode === 'eod' ? (
            <>
              <div className="dr-section-tools">
                <button type="button" className="btn" onClick={handleAddActivity}>
                  {t(uiLang, 'buttons.add')}
                </button>
              </div>
              <ActivitiesSection
                activities={draft?.activities ?? []}
                lang={uiLang}
                dayEntry={dayEntry}
                onChange={(activities) => upsertDraft((report) => ({ ...report, activities, updatedAt: nowIso() }))}
              />

              <section className="dr-section">
                <h2>{t(uiLang, 'dailyReport.progressSection')}</h2>
                <pre className="dr-progress-preview">
                  {renderProgressSection(uiLang, draft?.activities ?? [], settings.progressRules)}
                </pre>
              </section>

              <div className="dr-section-tools">
                <button type="button" className="btn" onClick={handleAddTopic}>
                  {t(uiLang, 'buttons.add')}
                </button>
              </div>
              <TopicsSection topics={topicsForDate} lang={uiLang} onChange={handleTopicsChange} />

              <NextDaySection
                lang={uiLang}
                nextBusinessDate={nbDate}
                suggestions={suggestions}
                items={draft?.nextDay ?? []}
                onChange={(nextDay) => upsertDraft((report) => ({ ...report, nextDay, updatedAt: nowIso() }))}
              />

              <section className="dr-section">
                <h2>{t(uiLang, 'dailyReport.jiraSection')}</h2>
                <input
                  className="input"
                  type="text"
                  placeholder="https://…"
                  value={draft?.jiraUrl ?? ''}
                  onChange={(e) => {
                    if (draft !== undefined) {
                      reportsApi.upsertReport({ ...draft, jiraUrl: e.target.value === '' ? null : e.target.value, updatedAt: nowIso() });
                    }
                  }}
                />
                <p className="dr-empty">{t(uiLang, 'dailyReport.jiraFallbackHint')}</p>
              </section>

              <section className="dr-section">
                <h2>{t(uiLang, 'dailyReport.previewSection')}</h2>
                <div className="dr-button-row">
                  <button type="button" className="btn" disabled={draft === undefined} onClick={handleGenerate}>
                    {t(uiLang, 'buttons.generate')}
                  </button>
                  <button type="button" className="btn" disabled={draft === undefined} onClick={handleRefreshData}>
                    {t(uiLang, 'buttons.refreshData')}
                  </button>
                  <button type="button" className="btn" disabled={draft === undefined} onClick={handleSaveDraft}>
                    {t(uiLang, 'buttons.saveDraft')}
                  </button>
                  <button type="button" className="btn" disabled={draft === undefined} onClick={handleFinalize}>
                    {t(uiLang, 'buttons.finalize')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={draft === undefined}
                    title={t(uiLang, 'dailyReport.deleteDraftHint')}
                    onClick={handleDeleteDraft}
                  >
                    {t(uiLang, 'buttons.deleteDraft')}
                  </button>
                </div>
                <textarea
                  className="dr-preview"
                  rows={20}
                  value={previewText}
                  onChange={(e) => setPreviewText(e.target.value)}
                />
                <div className="dr-button-row">
                  <button type="button" className="btn" onClick={handleCopy}>
                    {t(uiLang, 'buttons.copy')}
                  </button>
                  <button type="button" className="btn" onClick={handleExportTxt}>
                    {t(uiLang, 'buttons.exportTxt')}
                  </button>
                  <button type="button" className="btn" onClick={handleExportPdf}>
                    {t(uiLang, 'buttons.exportPdf')}
                  </button>
                  <button type="button" className="btn" onClick={handleExportExcel}>
                    {t(uiLang, 'buttons.exportExcel')}
                  </button>
                </div>
              </section>
            </>
          ) : (
            <>
              <MorningScheduleSection
                lang={uiLang}
                suggestions={morningScheduleSuggestions(reportLanguage)}
                items={draft?.morningSchedule ?? []}
                onChange={(morningSchedule) =>
                  upsertDraft((report) => ({ ...report, morningSchedule, updatedAt: nowIso() }))
                }
              />

              <section className="dr-section">
                <h2>{t(uiLang, 'dailyReport.morningPreviewSection')}</h2>
                <div className="dr-button-row">
                  <button type="button" className="btn" disabled={draft === undefined} onClick={handleGenerateMorning}>
                    {t(uiLang, 'buttons.generate')}
                  </button>
                  <button type="button" className="btn" disabled={draft === undefined} onClick={handleRefreshMorning}>
                    {t(uiLang, 'buttons.refreshData')}
                  </button>
                  <button type="button" className="btn" disabled={draft === undefined} onClick={handleSaveDraft}>
                    {t(uiLang, 'buttons.saveDraft')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={draft === undefined}
                    title={t(uiLang, 'dailyReport.deleteDraftHint')}
                    onClick={handleDeleteDraft}
                  >
                    {t(uiLang, 'buttons.deleteDraft')}
                  </button>
                </div>
                <textarea
                  className="dr-preview"
                  rows={20}
                  value={morningPreview}
                  onChange={(e) => setMorningPreview(e.target.value)}
                />
                <div className="dr-button-row">
                  <button type="button" className="btn" onClick={handleCopyMorning}>
                    {t(uiLang, 'buttons.copy')}
                  </button>
                  <button type="button" className="btn" onClick={handleExportMorningTxt}>
                    {t(uiLang, 'buttons.exportTxt')}
                  </button>
                  <button type="button" className="btn" onClick={handleExportMorningPdf}>
                    {t(uiLang, 'buttons.exportPdf')}
                  </button>
                  <button type="button" className="btn" onClick={handleExportMorningExcel}>
                    {t(uiLang, 'buttons.exportExcel')}
                  </button>
                </div>
              </section>
            </>
          )}
        </>
      )}

      <section className="dr-section">
        <h2>{t(uiLang, 'dailyReport.historySection')}</h2>
        <div className="table-wrap">
          <table className="dr-table">
            <thead>
              <tr>
                <th scope="col">{t(uiLang, 'columns.date')}</th>
                <th scope="col">{t(uiLang, 'columns.language')}</th>
                <th scope="col">{t(uiLang, 'columns.status')}</th>
                <th scope="col">{t(uiLang, 'columns.finalizedAt')}</th>
                <th scope="col">{t(uiLang, 'columns.finalizedBy')}</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {pager.pagedRows.map((report) => (
                <tr
                  key={report.id}
                  className={
                    report.status === 'FINALIZED' ? 'completes' : draft !== undefined && report.id === draft.id ? 'current-draft' : undefined
                  }
                >
                  <td>{report.reportDate}</td>
                  <td>{LANGUAGES.find((option) => option.code === report.language)?.native ?? report.language}</td>
                <td>
                  {report.status === 'FINALIZED'
                    ? t(uiLang, 'dailyReport.statusFinalized')
                    : t(uiLang, 'dailyReport.statusDraft')}
                  {report.revisionOf !== null
                    ? ` (${t(uiLang, 'dailyReport.revision', { date: report.reportDate })})`
                    : ''}
                </td>
                <td>{report.finalizedAt ?? '—'}</td>
                <td>{report.finalizedBy ?? '—'}</td>
                <td>
                  <button type="button" className="btn" onClick={() => setViewingId(report.id)}>
                    {t(uiLang, 'buttons.view')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          </table>
        </div>
        <TablePager lang={uiLang} pager={pager} />
      </section>
    </div>
  );
}

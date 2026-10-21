import { useAskConfirm } from '../../components/ConfirmDialog';
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
import {
  EodPreviewSection,
  FinalizedExistsBanner,
  MorningPreviewSection,
  ReportHistoryTable,
  ViewingReportBanner,
} from './DailyReportSections';
import { usePagedRows } from '../../lib/pagination/usePagedRows';
import { XLSX_MIME } from '../../lib/statusKeys';

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
  const ask = useAskConfirm(uiLang);
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

  const handleRefreshData = async (): Promise<void> => {
    if (draft === undefined) return;
    // Refresh replaces auto-seeded activities and suggested next-day items;
    // manual entries are kept. Confirm first so edits are never lost silently.
    if (!(await ask(t(uiLang, 'dailyReport.refreshConfirm'), { severity: 'warning' }))) return;
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

  const handleRefreshMorning = async (): Promise<void> => {
    if (draft === undefined) return;
    // Refresh replaces the auto-seeded schedule item; manual items are kept.
    if (!(await ask(t(uiLang, 'dailyReport.morningRefreshConfirm'), { severity: 'warning' }))) return;
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

  const handleFinalize = async (): Promise<void> => {
    if (draft === undefined) return;
    // Finalizing freezes an immutable snapshot; require an explicit confirm.
    if (!(await ask(t(uiLang, 'dailyReport.finalizeConfirm'), { severity: 'warning' }))) return;
    const finalized = finalizeReport(draft, attendanceForDate, topicsForDate, settings.supervisorName, nowIso());
    reportsApi.upsertReport(finalized);
    setViewingId(finalized.id);
    setMessage({ kind: 'ok', text: t(uiLang, 'dailyReport.finalizedMessage') });
  };

  const handleDeleteDraft = async (): Promise<void> => {
    if (draft === undefined) return;
    if (!(await ask(t(uiLang, 'dailyReport.confirmDeleteDraft'), { severity: 'danger' }))) return;
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
        <ViewingReportBanner
          uiLang={uiLang}
          viewingReport={viewingReport}
          onClose={() => setViewingId(null)}
          onRevise={handleCreateRevision}
        />
      ) : (
        <>
          {draft === undefined && finalizedForDate ? (
            <FinalizedExistsBanner
              uiLang={uiLang}
              onEditRevision={() => {
                const finalized = reportsApi.state.reports.find(
                  (r) => r.reportDate === selectedDate && r.status === 'FINALIZED',
                );
                if (finalized !== undefined) createRevisionFrom(finalized);
              }}
              onView={() => {
                const finalized = reportsApi.state.reports.find(
                  (r) => r.reportDate === selectedDate && r.status === 'FINALIZED',
                );
                if (finalized !== undefined) setViewingId(finalized.id);
              }}
              onNewDraft={() =>
                reportsApi.upsertReport(
                  newDraft(selectedDate, uiLang, settings.supervisorName, nowIso(), activeProjectId),
                )
              }
            />
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

              <EodPreviewSection
                uiLang={uiLang}
                hasDraft={draft !== undefined}
                previewText={previewText}
                onPreviewChange={setPreviewText}
                onGenerate={handleGenerate}
                onRefreshData={handleRefreshData}
                onSaveDraft={handleSaveDraft}
                onFinalize={handleFinalize}
                onDeleteDraft={handleDeleteDraft}
                onCopy={handleCopy}
                onExportTxt={handleExportTxt}
                onExportPdf={handleExportPdf}
                onExportExcel={handleExportExcel}
              />
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

              <MorningPreviewSection
                uiLang={uiLang}
                hasDraft={draft !== undefined}
                morningPreview={morningPreview}
                onPreviewChange={setMorningPreview}
                onGenerate={handleGenerateMorning}
                onRefreshData={handleRefreshMorning}
                onSaveDraft={handleSaveDraft}
                onDeleteDraft={handleDeleteDraft}
                onCopy={handleCopyMorning}
                onExportTxt={handleExportMorningTxt}
                onExportPdf={handleExportMorningPdf}
                onExportExcel={handleExportMorningExcel}
              />
            </>
          )}
        </>
      )}

      <ReportHistoryTable uiLang={uiLang} pager={pager} currentDraftId={draft?.id} onView={setViewingId} />
    </div>
  );
}

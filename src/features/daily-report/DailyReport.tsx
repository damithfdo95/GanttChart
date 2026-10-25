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
import { useAccess } from '../../app/access';
import { canPublishReport, copyWithFallback, dailyReportFileName, formatDailyReportChatText, formatDailyReportPlainText, markReportPublished } from '../../lib/reporting/publication';
import type { ReportPublicationMethod } from '../../../shared/reportPublication';
import { PreparedDraftPanel } from './PreparedDraftPanel';
import { preparedTopicsAsRecords } from './preparedDraft';
import { prepareDailyReportDraft, reportStateForDate } from '../../domain/dailyReportDraft';
import { businessDate } from '../../../shared/businessTime';
import { resolveQaPolicy } from '../../../shared/qaPolicy';

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Daily Report screen. The report language is independent of the UI language
 * (UI = English + Report = Japanese is fully supported). Drafts are created
 * per date; finalizing freezes a snapshot so historical numbers are never
 * recalculated; revised versions preserve previous ones.
 */
export function DailyReport({ initialDate, prepare = false }: { initialDate?: string; prepare?: boolean } = {}) {
  const app = useAppStateCtx();
  const reportsApi = useReportsStateCtx();
  const uiLang = app.state.language;
  const ask = useAskConfirm(uiLang);
  const settings = reportsApi.state.settings;
  const access = useAccess();

  const [selectedDate, setSelectedDate] = useState<string>(() => initialDate ?? formatDate(todayEpochDays()));
  // Opened from the Command Center with "Prepare Daily Report": the date it carries is the date shown (never silently today), and no
  // draft is created until the supervisor chooses to (an empty one, or one from the prepared proposal).
  const [proposing, setProposing] = useState(prepare);
  useEffect(() => {
    if (initialDate !== undefined) setSelectedDate(initialDate);
    setProposing(prepare);
  }, [initialDate, prepare]);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [mode, setMode] = useState<'morning' | 'eod'>('eod');
  const [previewText, setPreviewText] = useState('');
  const [morningPreview, setMorningPreview] = useState('');
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  // Delivery of a finalized report: the clipboard fallback text, and how the supervisor last delivered it (recorded when they mark it published).
  const [fallbackText, setFallbackText] = useState<string | null>(null);
  const [deliveryMethod, setDeliveryMethod] = useState<ReportPublicationMethod>('other');
  useEffect(() => setFallbackText(null), [viewingId]);
  // "View / Publish" from the Command Center lands directly on the date's finalized report (a draft, if one exists, is still continued).
  useEffect(() => {
    if (!prepare || initialDate === undefined) return;
    const finalized = reportsApi.state.reports
      .filter((r) => r.reportDate === initialDate && r.status === 'FINALIZED')
      .sort((a, b) => (b.finalizedAt ?? '').localeCompare(a.finalizedAt ?? ''))[0];
    if (finalized !== undefined && findDraft(reportsApi.state.reports, initialDate) === undefined) setViewingId(finalized.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prepare, initialDate]);

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
    if (findDraft(reportsApi.state.reports, selectedDate) === undefined && !finalizedForDate && !proposing) {
      const created = newDraft(selectedDate, uiLang, settings.supervisorName, nowIso(), activeProjectId);
      // Seed today's schedule for the morning report from the live plan.
      const seeded = morningScheduleSuggestions(uiLang);
      if (seeded.length > 0) {
        created.morningSchedule = seeded.map((text) => ({ id: generateId(), text, source: 'AUTO' as const }));
      }
      reportsApi.upsertReport(created);
    }
  }, [selectedDate, reportsApi, uiLang, settings.supervisorName, activeProjectId, finalizedForDate, proposing]);

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

  /** The report text for a draft and its topics (the staffing facts, when the draft carries them, sit under the Attendance heading). */
  const renderPreviewText = (report: DailyReportEntity, topics: DailyTopic[]): string => {
    const sections = buildReportSections({
      language: report.language,
      activities: report.activities,
      attendance: attendanceForDate,
      members: reportsApi.state.rcsMembers ?? [],
      topics,
      nextDay: report.nextDay,
      jiraUrl: report.jiraUrl ?? settings.projectJiraUrl ?? '',
      rules: settings.progressRules,
      ...(report.staffing === undefined ? {} : { staffing: report.staffing }),
      executionSummary: renderExecutionSummarySection(
        report.language,
        buildExecutionReport({
          date: report.reportDate,
          projects: reportsApi.state.projects,
          cycles: reportsApi.state.cycles ?? [],
          assignments: reportsApi.state.testerAssignments ?? [],
          members: reportsApi.state.rcsMembers ?? [],
          nowIso: nowIso(),
        }),
      ),
    });
    return renderReport(settings.templates[report.language], sections);
  };

  // ---- prepared draft (Command Center -> Prepare Daily Report) --------------------------------
  const dateState = reportStateForDate(reportsApi.state.reports, selectedDate);
  const prepared = useMemo(
    () =>
      prepare
        ? prepareDailyReportDraft({
            language: reportLanguage,
            projects: reportsApi.state.projects,
            scopes: reportsApi.state.scopes ?? [],
            cases: reportsApi.state.testCases ?? [],
            caseResults: reportsApi.state.caseResults ?? [],
            caseExecution: reportsApi.state.caseExecutions ?? [],
            assignments: reportsApi.state.testerAssignments ?? [],
            members: reportsApi.state.rcsMembers ?? [],
            policy: resolveQaPolicy(settings.qaPolicy),
            selectedDate,
            today: businessDate(),
            nowIso: new Date().toISOString(),
          })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prepare, reportLanguage, reportsApi.state, selectedDate],
  );

  /** Explicit action: create the draft from the proposal. Nothing is written before this click. */
  const handleApplyPrepared = (): void => {
    if (prepared === null || draft !== undefined || finalizedForDate) return;
    const now = nowIso();
    const created: DailyReportEntity = {
      ...newDraft(selectedDate, uiLang, settings.supervisorName, now, activeProjectId),
      activities: prepared.activities,
      staffing: prepared.staffing,
      preparedFrom: { generatedAt: now, generatedForDate: selectedDate },
    };
    const records = preparedTopicsAsRecords(created.language, prepared.topics, selectedDate, settings.supervisorName, now, topicsForDate.length);
    reportsApi.upsertReport({ ...created, previewText: renderPreviewText(created, [...topicsForDate, ...records]) });
    for (const record of records) reportsApi.addTopic(record);
    setProposing(false);
    setMessage({ kind: 'ok', text: t(uiLang, 'dailyReport.prepare.applied') });
  };

  const handleStartEmpty = (): void => setProposing(false);

  /** Explicit, confirmed: replace the GENERATED activities and staffing with current data. Manual activities and topics are kept. */
  const handleRegeneratePrepared = async (): Promise<void> => {
    if (prepared === null || draft === undefined) return;
    if (!(await ask(t(uiLang, 'dailyReport.prepare.regenerateConfirm'), { severity: 'warning' }))) return;
    const now = nowIso();
    reportsApi.upsertReport({
      ...draft,
      activities: [...prepared.activities, ...draft.activities.filter((a) => a.source === 'MANUAL')],
      staffing: prepared.staffing,
      preparedFrom: { generatedAt: now, generatedForDate: selectedDate },
      updatedAt: now,
    });
    setMessage({ kind: 'ok', text: t(uiLang, 'dailyReport.prepare.regenerated') });
  };

  const handleGenerate = (): void => {
    if (draft === undefined) return;
    const text = renderPreviewText(draft, topicsForDate);
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

  // ---- delivery of a finalized report (copy / export / print / publish) ------------------------

  const copyFinalized = async (text: string, doneKey: 'dailyReport.publication.copiedPlain' | 'dailyReport.publication.copiedChat'): Promise<void> => {
    const result = await copyWithFallback(text, typeof navigator === 'undefined' ? undefined : navigator.clipboard);
    if (result.ok) {
      setFallbackText(null);
      setDeliveryMethod('manualCopy');
      setMessage({ kind: 'ok', text: t(uiLang, doneKey) });
    } else {
      setMessage(null);
      setFallbackText(result.fallbackText);
    }
  };

  const exportFinalized = (report: DailyReportEntity): void => {
    downloadTextFile(dailyReportFileName(report), 'text/plain;charset=utf-8', formatDailyReportPlainText(report));
    setDeliveryMethod('export');
    setMessage({ kind: 'ok', text: t(uiLang, 'dailyReport.exportedMessage') });
  };

  const printFinalized = (report: DailyReportEntity): void => {
    const opened = printHtml(`${t(uiLang, 'dailyReport.title')} — ${report.reportDate}`, textToHtml(formatDailyReportPlainText(report)));
    if (opened) setDeliveryMethod('print');
    else setMessage({ kind: 'error', text: t(uiLang, 'dailyReport.popupBlocked') });
  };

  /** Explicit and confirmed: records that the finalized report was delivered. It changes nothing in the report itself. */
  const handleMarkPublished = async (report: DailyReportEntity): Promise<void> => {
    if (!canPublishReport(report, access.canManage)) return;
    if (!(await ask(t(uiLang, 'dailyReport.publication.confirm'), { severity: 'warning' }))) return;
    reportsApi.upsertReport(markReportPublished(report, { userId: access.userId, memberId: access.ownMemberId }, deliveryMethod, nowIso()));
    setMessage({ kind: 'ok', text: t(uiLang, 'dailyReport.publication.done') });
  };

  const publisherLabel = (report: DailyReportEntity): string => {
    const member = (reportsApi.state.rcsMembers ?? []).find((m) => m.id === report.publishedByMemberId);
    return member?.name ?? report.publishedByMemberId ?? report.publishedByUserId ?? '';
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
          delivery={{
            canPublish: canPublishReport(viewingReport, access.canManage),
            publishedByLabel: publisherLabel(viewingReport),
            fallbackText,
            onCopyPlain: () => void copyFinalized(formatDailyReportPlainText(viewingReport), 'dailyReport.publication.copiedPlain'),
            onCopyChat: () => void copyFinalized(formatDailyReportChatText(viewingReport), 'dailyReport.publication.copiedChat'),
            onExport: () => exportFinalized(viewingReport),
            onPrint: () => printFinalized(viewingReport),
            onMarkPublished: () => void handleMarkPublished(viewingReport),
          }}
        />
      ) : (
        <>
          {prepared !== null ? (
            <PreparedDraftPanel
              lang={uiLang}
              date={selectedDate}
              prepared={prepared}
              state={dateState}
              onApply={handleApplyPrepared}
              onStartEmpty={handleStartEmpty}
              onRegenerate={() => void handleRegeneratePrepared()}
            />
          ) : null}
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

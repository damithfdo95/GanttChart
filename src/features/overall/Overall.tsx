import { useAskConfirm } from '../../components/ConfirmDialog';
import { useEffect, useMemo, useState } from 'react';
import { LIFECYCLE_KEY } from '../../lib/statusKeys';
import { useSharedGuard } from '../../app/useSharedGuard';
import type { ProjectLifecycleStatus, ProjectRecord } from '../../types';
import { useAppStateCtx, useReportsStateCtx, activateProject, activateProjectRecord } from '../../app/state-contexts';
import { t, resolveBilingualName, type TranslationKey } from '../../i18n';
import { formatDate, formatDateDisplay, parseDate, todayEpochDays } from '../../lib/dates/dates';
import { NewProjectForm } from '../../components/NewProjectForm';
import { overallCapabilities, useAccess } from '../../app/access';
import { PortfolioStatusCard, type StatusFact } from '../../components/StatusCard';
import { useNow } from '../dashboard/hooks/useNow';
import {
  DEFAULT_PORTFOLIO_FILTERS,
  filterProjects,
  isProjectOverdue,
  portfolioSummary,
  projectPlanningStatus,
  sortProjects,
  summarizeProjectGroup,
  type OverallFocus,
  type PortfolioVerdict,
  type ProjectScheduleMetrics,
  type ProjectSortKey,
  type SortDirection,
} from '../../domain/projects';
import { OverallProjectTable, PortfolioToolbar } from './OverallTable';
import {
  WORK_DAY_END,
  calculateWorkdayProjection,
  dayWindowsFromRows,
  projectDayWindowDefaults,
} from '../../lib/calculations/workday';
import { formatClock, formatInteger, formatSignedMultiDayDuration } from '../../lib/formatting/format';
import { DEMO_STATE } from '../../lib/storage/storage';
import { createBackupPayload } from '../../lib/backup/backup';
import { createProjectBackupPayload, importProjectIntoRegistry } from '../../lib/backup/projectBackup';
import { detectImportFile } from '../../lib/backup/importFile';
import { sanitizeRestoredAccountLinks } from '../../lib/backup/restoreLinks';
import { downloadTextFile } from '../../lib/export/download';


const GROUP_VERDICT_KEY: Record<PortfolioVerdict, TranslationKey> = {
  onTrack: 'status.onTrack',
  atRisk: 'status.atRisk',
  capacityShortage: 'status.capacityShortage',
  overdue: 'status.overdue',
  completed: 'status.completed',
  noProjects: 'overall.noProjects',
};

interface OverallProps {
  focus: OverallFocus;
  onOpenGantt: (projectId: string) => void;
  /** Called after a project created via the New Project form was stored and activated. */
  onProjectCreated: () => void;
}


/**
 * Overall — the portfolio control center. Shows every project (not only
 * those visible in the Gantt viewport), with lifecycle status management,
 * summary cards, search/filter/sort, bulk operations and Open in Gantt.
 * Lifecycle status (To Do / In Progress / Extended / On Hold / Done) is a
 * user-set workflow property, always displayed alongside — never instead
 * of — the calculated planning status.
 */
export function Overall({ focus, onOpenGantt, onProjectCreated }: OverallProps) {
  const app = useAppStateCtx();
  const reportsApi = useReportsStateCtx();
  const guard = useSharedGuard();
  const lang = app.state.language;
  const ask = useAskConfirm(lang);
  const settings = reportsApi.state.settings;
  // A Tester reads this screen; every change to projects is an SV's (the server enforces the same).
  const access = useAccess();
  const readOnly = !overallCapabilities(access.isTester).canChangeStatus;

  const [filters, setFilters] = useState({ ...DEFAULT_PORTFOLIO_FILTERS });
  const [sortKey, setSortKey] = useState<ProjectSortKey>('default');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reopenFor, setReopenFor] = useState<string | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [importMessage, setImportMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  // Portfolio status card scope: which summary-card group the card
  // aggregates. Default = Total Projects (all projects); summary-card clicks
  // (and Clear filters) change it, search/dropdowns affect the table only.
  const [statusScope, setStatusScope] = useState<OverallFocus>({ lifecycle: 'all' });

  // Transient action feedback (imports, bulk changes) auto-clears after a few
  // seconds so stale messages never linger next to the toolbar.
  useEffect(() => {
    if (importMessage === null) return;
    const timer = window.setTimeout(() => setImportMessage(null), 6000);
    return () => window.clearTimeout(timer);
  }, [importMessage]);

  useEffect(() => {
    if (focus.lifecycle !== undefined || focus.planning !== undefined) {
      setFilters((prev) => ({ ...prev, lifecycle: focus.lifecycle ?? prev.lifecycle, planning: focus.planning ?? prev.planning }));
      setStatusScope(focus);
    }
  }, [focus]);

  const todayEpoch = todayEpochDays();
  const today = formatDate(todayEpoch);
  const nowIso = new Date().toISOString();
  const now = useNow(30_000);

  // Memoized derived data — no recalculation on row interactions (§28).
  const projects = reportsApi.state.projects;
  const summary = useMemo(() => portfolioSummary(projects, today), [projects, today]);
  const planningStatuses = useMemo(
    () => new Map(projects.map((p) => [p.id, projectPlanningStatus(p)])),
    [projects],
  );
  const visible = useMemo(
    () => sortProjects(filterProjects(projects, filters, today, nowIso), sortKey, sortDirection),
    [projects, filters, today, nowIso, sortKey, sortDirection],
  );

  // ---- portfolio status card (worst-case group aggregate) -------------------

  /** Per-project schedule metrics (planning status + anchored capacity projection). */
  const projectScheduleMetrics = useMemo(() => {
    const map = new Map<string, ProjectScheduleMetrics>();
    for (const project of projects) {
      const inputs = project.inputs;
      const projection = calculateWorkdayProjection({
        totalCases: inputs.totalCases,
        casesCompleted: inputs.casesCompleted,
        currentTesters: inputs.currentTesters,
        perHourPerTester: inputs.perHourPerTester,
        planningRows: inputs.planningRows,
        startDate: inputs.startDate,
        endDate: inputs.targetCompletionDate,
        planStartTime: inputs.startTime,
        anchor: { epochDay: todayEpoch, timeOfDay: now },
        dailyOvertimeMinutes: inputs.dailyOvertimeMinutes,
        dayWindows: dayWindowsFromRows(inputs.planningRows, projectDayWindowDefaults(inputs)),
      });
      map.set(project.id, {
        planningStatus: projectPlanningStatus(project),
        overdue: isProjectOverdue(project, today),
        deadline: inputs.targetCompletionDate,
        plannedFinish: projection.expectedFinish,
        bufferMinutes: projection.bufferMinutes,
      });
    }
    return map;
  }, [projects, today, todayEpoch, now]);

  const statusGroupProjects = useMemo(() => {
    if (statusScope.lifecycle === 'all' && statusScope.planning === undefined) return projects;
    if (statusScope.lifecycle !== undefined) {
      return statusScope.lifecycle === 'all'
        ? projects
        : projects.filter((p) => p.status === statusScope.lifecycle);
    }
    if (statusScope.planning !== undefined) {
      return projects.filter((p) =>
        statusScope.planning === 'overdue'
          ? isProjectOverdue(p, today)
          : projectPlanningStatus(p) === statusScope.planning,
      );
    }
    return projects;
  }, [projects, statusScope, today]);

  const groupSummary = useMemo(
    () =>
      summarizeProjectGroup(
        statusGroupProjects
          .map((p) => projectScheduleMetrics.get(p.id))
          .filter((metric): metric is ProjectScheduleMetrics => metric !== undefined),
      ),
    [statusGroupProjects, projectScheduleMetrics],
  );

  const groupFacts: StatusFact[] =
    groupSummary.verdict === 'noProjects'
      ? []
      : [
          { label: t(lang, 'overall.projectsCount'), value: formatInteger(groupSummary.projectCount, lang) },
          {
            label: t(lang, 'labels.expectedFinish'),
            value:
              groupSummary.latestPlannedFinish === null
                ? '—'
                : `${formatDateDisplay(groupSummary.latestPlannedFinish.epochDay, lang)} ${formatClock(groupSummary.latestPlannedFinish.time)}`,
            hint: t(lang, 'hint.plannedFinish'),
          },
          {
            label: t(lang, 'dashboard.deadline'),
            value:
              groupSummary.earliestDeadline === null || parseDate(groupSummary.earliestDeadline) === null
                ? '—'
                : `${formatDateDisplay(parseDate(groupSummary.earliestDeadline)!, lang)} ${formatClock(WORK_DAY_END)}`,
          },
          groupSummary.worstBufferMinutes === null
            ? { label: t(lang, 'labels.buffer'), value: '—' }
            : groupSummary.worstBufferMinutes >= 0
              ? { label: t(lang, 'labels.buffer'), value: formatSignedMultiDayDuration(groupSummary.worstBufferMinutes), hint: t(lang, 'hint.buffer') }
              : { label: t(lang, 'labels.delay'), value: formatSignedMultiDayDuration(-groupSummary.worstBufferMinutes) },
          { label: t(lang, 'labels.now'), value: formatClock(now) },
        ];

  const handleStatusChange = async (project: ProjectRecord, status: ProjectLifecycleStatus): Promise<void> => {
    if (status === 'done' && project.status !== 'done') {
      // V6.6 §23: informational completion summary — objective evidence for
      // the review, never a completion blocker.
      const tickets = project.inputs.bugTickets ?? [];
      const testers = new Set<string>();
      for (const record of project.inputs.testerDailyPerformance ?? []) {
        const name = record.testerName.trim();
        if (name !== '') testers.add(name);
      }
      for (const ticket of tickets) {
        const name = ticket.reportedBy.trim();
        if (name !== '') testers.add(name);
      }
      const casesExecuted = (project.inputs.testerDailyPerformance ?? []).reduce(
        (sum, record) => sum + record.casesTested,
        0,
      );
      const summary = t(lang, 'overall.completionSummary', {
        tickets: tickets.length,
        testers: testers.size,
        cases: casesExecuted,
      });
      if (!(await ask(`${t(lang, 'overall.confirmMarkDone')}\n\n${summary}`))) return;
    }
    reportsApi.setProjectStatus(project.id, status, settings.supervisorName || undefined);
    setReopenFor(null);
  };

  const handleBulkStatus = async (status: ProjectLifecycleStatus): Promise<void> => {
    const targets = projects.filter((p) => selected.has(p.id));
    if (targets.length === 0) return;
    // The Done confirmation counts only projects that will actually change —
    // already-done projects are skipped by the loop below.
    const changing = status === 'done' ? targets.filter((p) => p.status !== 'done') : targets;
    if (changing.length === 0) return;
    if (status === 'done' && !(await ask(t(lang, 'overall.confirmBulkDone', { count: changing.length })))) return;
    for (const project of targets) {
      if (status === 'done' && project.status === 'done') continue;
      reportsApi.setProjectStatus(project.id, status, settings.supervisorName || undefined);
    }
    setSelected(new Set());
    setImportMessage({
      kind: 'ok',
      text: t(lang, 'overall.bulkApplied', { count: changing.length, status: t(lang, LIFECYCLE_KEY[status]) }),
    });
  };

  const handleOpenGantt = (project: ProjectRecord): void => {
    activateProject(reportsApi, app, project.id);
    onOpenGantt(project.id);
  };

  /** New Project (V6.2): the modal form builds the canonical project inputs. */
  const handleAddProject = (): void => {
    setNewProjectOpen(true);
  };

  // ---- V6.3: project export / workspace export / import / delete ----

  const handleExportProject = (project: ProjectRecord): void => {
    const payload = createProjectBackupPayload(project, reportsApi.state.reports, undefined, { scopes: reportsApi.state.scopes, testCases: reportsApi.state.testCases, caseResults: reportsApi.state.caseResults, caseExecutions: reportsApi.state.caseExecutions }, reportsApi.state.dailyPlans);
    downloadTextFile(
      `ganttchart-project-${project.projectId}-${today}.json`,
      'application/json',
      JSON.stringify(payload, null, 2),
    );
  };

  const handleExportAll = (): void => {
    const payload = createBackupPayload(app.state, reportsApi.state);
    downloadTextFile(
      `ganttchart-workspace-${today}.json`,
      'application/json',
      JSON.stringify(payload, null, 2),
    );
  };

  const handleImportFile = (file: File): void => {
    if (!guard.guardWrite()) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const result = detectImportFile(String(reader.result ?? ''));
      if (result.kind === 'invalid') {
        setImportMessage({ kind: 'error', text: t(lang, 'import.invalidFile') });
        return;
      }
      if (result.kind === 'backup') {
        if (!(await ask(t(lang, 'import.confirmBackup'), { severity: 'warning' }))) return;
        // A full backup replaces the WHOLE shared workspace for everyone: administrators only, typed confirmation.
        if (!guard.confirmReplace()) return;
        app.replaceState(result.data.appState);
        // A file never creates or changes a login link: people with a login keep the link this workspace has now.
        reportsApi.replaceReportsState(sanitizeRestoredAccountLinks(result.data.reportsState, reportsApi.state, access.userId));
        setImportMessage({ kind: 'ok', text: t(lang, 'import.backupOk') });
        return;
      }
      if (result.kind === 'project') {
        const name =
          resolveBilingualName(lang, { nameEn: result.data.project.nameEn, nameJa: result.data.project.nameJa }) || '—';
        if (!(await ask(t(lang, 'import.confirmProject', {
              name,
              count: result.data.reports.length,
            }), { severity: 'warning' }))) {
          return;
        }
        const merged = importProjectIntoRegistry(reportsApi.state.projects, reportsApi.state.reports, result.data, {
          existing: { scopes: reportsApi.state.scopes, testCases: reportsApi.state.testCases, caseExecutions: reportsApi.state.caseExecutions },
          members: reportsApi.state.rcsMembers ?? [],
          // In a shared workspace the restored results are attributed to the person restoring them; in plain local use they stay as exported.
          ...(access.userId === null ? {} : { actor: access.userId }),
        });
        reportsApi.setProjects(merged.projects);
        const added = merged.testManagement;
        const addedEvents = added.caseExecutions ?? [];
        if (added.scopes.length + added.testCases.length + added.caseResults.length + addedEvents.length > 0) {
          reportsApi.updateTestManagement((tm) => ({ scopes: [...tm.scopes, ...added.scopes], testCases: [...tm.testCases, ...added.testCases], caseResults: [...tm.caseResults, ...added.caseResults], caseExecutions: [...(tm.caseExecutions ?? []), ...addedEvents] }));
        }
        if (merged.dailyPlans.length > 0) {
          const planned = merged.dailyPlans;
          reportsApi.updateMeeting((m) => ({ ...m, dailyPlans: [...m.dailyPlans.filter((p) => !planned.some((q) => q.id === p.id)), ...planned] }));
        }
        for (const report of merged.newReports) reportsApi.upsertReport(report);
        activateProjectRecord(reportsApi, app, merged.importedProject);
        setImportMessage({
          kind: 'ok',
          text: t(lang, 'import.projectOk', { name }),
        });
        return;
      }
      // Legacy app-state export: replaces the editing surface of the active project.
      if (!(await ask(t(lang, 'import.confirmAppState'), { severity: 'warning' }))) return;
      app.replaceState(result.data);
      setImportMessage({ kind: 'ok', text: t(lang, 'import.appStateOk') });
    };
    reader.onerror = () => setImportMessage({ kind: 'error', text: t(lang, 'import.invalidFile') });
    reader.readAsText(file);
  };

  const handleDeleteProject = async (project: ProjectRecord): Promise<void> => {
    const name = resolveBilingualName(lang, { nameEn: project.nameEn, nameJa: project.nameJa }) || '—';
    if (!(await ask(t(lang, 'overall.confirmDeleteProject', { name }), { severity: 'danger' }))) return;
    if (!guard.confirmEveryone('shared.confirm.deleteProject')) return;
    const wasActive = reportsApi.state.activeProjectId === project.id;
    const fallback = reportsApi.state.projects.find((p) => p.id !== project.id) ?? null;
    reportsApi.removeProject(project.id);
    if (wasActive) {
      if (fallback !== null) {
        activateProjectRecord(reportsApi, app, fallback);
      } else {
        // Last project deleted: return to the normal initial state (§12).
        const fresh: typeof DEMO_STATE = {
          ...DEMO_STATE,
          language: app.state.language,
          dashboardView: app.state.dashboardView,
        };
        app.resetToDemo();
        reportsApi.seedInitialProject(fresh);
      }
    }
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(project.id);
      return next;
    });
  };

  const toggleSelected = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSort = (key: ProjectSortKey): void => {
    if (key === sortKey) {
      // Tri-state: ascending → descending → back to the default portfolio
      // ordering (To Do → Ongoing → Done, earliest deadline first).
      if (sortDirection === 'asc') {
        setSortDirection('desc');
      } else {
        setSortKey('default');
        setSortDirection('asc');
      }
    } else {
      setSortKey(key);
      setSortDirection('asc');
    }
  };

  const summaryCards: { key: TranslationKey; value: number; focus: OverallFocus }[] = [
    { key: 'overall.totalProjects', value: summary.total, focus: { lifecycle: 'all' } },
    { key: 'overall.todo', value: summary.todo, focus: { lifecycle: 'todo' } },
    { key: 'overall.ongoing', value: summary.ongoing, focus: { lifecycle: 'ongoing' } },
    { key: 'overall.extended', value: summary.extended, focus: { lifecycle: 'extended' } },
    { key: 'overall.onHold', value: summary.onHold, focus: { lifecycle: 'onHold' } },
    { key: 'overall.done', value: summary.done, focus: { lifecycle: 'done' } },
    { key: 'status.atRisk', value: summary.atRisk, focus: { planning: 'atRisk' } },
    { key: 'status.overdue', value: summary.overdue, focus: { planning: 'overdue' } },
    { key: 'status.capacityShortage', value: summary.capacityShortage, focus: { planning: 'capacityShortage' } },
  ];

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title-group">
          <h1>{t(lang, 'overall.title')}</h1>
        </div>
      </header>

      <PortfolioStatusCard
        verdict={groupSummary.verdict}
        verdictLabel={t(lang, GROUP_VERDICT_KEY[groupSummary.verdict])}
        facts={groupFacts}
      />

      <div className="overall-summary">
        {summaryCards.map((card) => (
          <button
            key={card.key}
            type="button"
            className={`summary-card${card.key === 'status.atRisk' || card.key === 'status.overdue' || card.key === 'status.capacityShortage' ? ' tone-bad' : ''}${(card.focus.lifecycle ?? 'all') === filters.lifecycle && (card.focus.planning ?? 'all') === filters.planning ? ' active' : ''}`}
            aria-pressed={(card.focus.lifecycle ?? 'all') === filters.lifecycle && (card.focus.planning ?? 'all') === filters.planning}
            onClick={() => {
              setFilters((prev) => ({ ...prev, lifecycle: card.focus.lifecycle ?? 'all', planning: card.focus.planning ?? 'all' }));
              setStatusScope(card.focus);
            }}
          >
            <span className="summary-card-label">{t(lang, card.key)}</span>
            <span className="summary-card-value">{formatInteger(card.value, lang)}</span>
          </button>
        ))}
      </div>

      <PortfolioToolbar
        lang={lang}
        readOnly={readOnly}
        filters={filters}
        onFiltersChange={(next) => setFilters(next)}        selectedCount={selected.size}
        onAddProject={handleAddProject}
        onExportAll={handleExportAll}
        onImportFile={handleImportFile}
        onBulkStatus={handleBulkStatus}
        onClearFilters={() => { setFilters({ ...DEFAULT_PORTFOLIO_FILTERS }); setStatusScope({ lifecycle: 'all' }); }}
        importMessage={importMessage}
      />

      <OverallProjectTable
        lang={lang}
        readOnly={readOnly}
        visible={visible}
        planningStatuses={planningStatuses}
        selected={selected}
        sortKey={sortKey}
        sortDirection={sortDirection}
        reopenFor={reopenFor}
        onToggleSelected={toggleSelected}
        onToggleSort={toggleSort}
        onSelectAll={setSelected}
        onStatusChange={handleStatusChange}
        onReopenFor={setReopenFor}
        onOpenGantt={handleOpenGantt}
        onExportProject={handleExportProject}
        onDeleteProject={handleDeleteProject}
      />

      {readOnly ? null : (
      <NewProjectForm
        open={newProjectOpen}
        onClose={() => setNewProjectOpen(false)}
        onCreated={() => {
          setNewProjectOpen(false);
          onProjectCreated();
        }}
      />
      )}
    </div>
  );
}

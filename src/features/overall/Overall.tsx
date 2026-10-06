import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectLifecycleStatus, ProjectRecord } from '../../types';
import { useAppStateCtx, useReportsStateCtx, activateProject, activateProjectRecord } from '../../app/state-contexts';
import { t, resolveBilingualName, type TranslationKey } from '../../i18n';
import { formatDate, formatDateDisplay, parseDate, todayEpochDays } from '../../lib/dates/dates';
import { NewProjectForm } from '../../components/NewProjectForm';
import { PortfolioStatusCard, type StatusFact } from '../../components/StatusCard';
import { useNow } from '../dashboard/hooks/useNow';
import {
  DEFAULT_PORTFOLIO_FILTERS,
  filterProjects,
  isProjectOverdue,
  portfolioSummary,
  projectDailyCapacity,
  projectPlanningStatus,
  projectProgress,
  sortProjects,
  summarizeProjectGroup,
  type LifecycleFilter,
  type OverallFocus,
  type PlanningFilter,
  type PortfolioVerdict,
  type ProjectScheduleMetrics,
  type ProjectSortKey,
  type SortDirection,
} from '../../domain/projects';
import {
  WORK_DAY_END,
  calculateWorkdayProjection,
  dayWindowsFromRows,
  projectDayWindowDefaults,
} from '../../lib/calculations/workday';
import { formatClock, formatInteger, formatNumber, formatSignedMultiDayDuration } from '../../lib/formatting/format';
import { DEMO_STATE } from '../../lib/storage/storage';
import { createBackupPayload } from '../../lib/backup/backup';
import { createProjectBackupPayload, importProjectIntoRegistry } from '../../lib/backup/projectBackup';
import { detectImportFile } from '../../lib/backup/importFile';
import { downloadTextFile } from '../../lib/export/download';

const LIFECYCLE_KEY: Record<ProjectLifecycleStatus, TranslationKey> = {
  todo: 'overall.todo',
  ongoing: 'overall.ongoing',
  extended: 'overall.extended',
  onHold: 'overall.onHold',
  done: 'overall.done',
};

const PLANNING_KEY: Record<ReturnType<typeof projectPlanningStatus>, TranslationKey> = {
  onTrack: 'status.onTrack',
  atRisk: 'status.atRisk',
  capacityShortage: 'status.capacityShortage',
  completed: 'status.completed',
  noTarget: 'plan.noTargetSet',
  onHold: 'status.onHold',
};

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

interface SortableColumn {
  key: ProjectSortKey;
  labelKey: TranslationKey;
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
  const lang = app.state.language;
  const settings = reportsApi.state.settings;

  const [filters, setFilters] = useState({ ...DEFAULT_PORTFOLIO_FILTERS });
  const [sortKey, setSortKey] = useState<ProjectSortKey>('default');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reopenFor, setReopenFor] = useState<string | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [importMessage, setImportMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const importFileRef = useRef<HTMLInputElement>(null);
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

  const handleStatusChange = (project: ProjectRecord, status: ProjectLifecycleStatus): void => {
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
      if (!window.confirm(`${t(lang, 'overall.confirmMarkDone')}\n\n${summary}`)) return;
    }
    reportsApi.setProjectStatus(project.id, status, settings.supervisorName || undefined);
    setReopenFor(null);
  };

  const handleBulkStatus = (status: ProjectLifecycleStatus): void => {
    const targets = projects.filter((p) => selected.has(p.id));
    if (targets.length === 0) return;
    // The Done confirmation counts only projects that will actually change —
    // already-done projects are skipped by the loop below.
    const changing = status === 'done' ? targets.filter((p) => p.status !== 'done') : targets;
    if (changing.length === 0) return;
    if (status === 'done' && !window.confirm(t(lang, 'overall.confirmBulkDone', { count: changing.length }))) return;
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
    const payload = createProjectBackupPayload(project, reportsApi.state.reports);
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
    const reader = new FileReader();
    reader.onload = () => {
      const result = detectImportFile(String(reader.result ?? ''));
      if (result.kind === 'invalid') {
        setImportMessage({ kind: 'error', text: t(lang, 'import.invalidFile') });
        return;
      }
      if (result.kind === 'backup') {
        if (!window.confirm(t(lang, 'import.confirmBackup'))) return;
        app.replaceState(result.data.appState);
        reportsApi.replaceReportsState(result.data.reportsState);
        setImportMessage({ kind: 'ok', text: t(lang, 'import.backupOk') });
        return;
      }
      if (result.kind === 'project') {
        const name =
          resolveBilingualName(lang, { nameEn: result.data.project.nameEn, nameJa: result.data.project.nameJa }) || '—';
        if (
          !window.confirm(
            t(lang, 'import.confirmProject', {
              name,
              count: result.data.reports.length,
            }),
          )
        ) {
          return;
        }
        const merged = importProjectIntoRegistry(reportsApi.state.projects, reportsApi.state.reports, result.data);
        reportsApi.setProjects(merged.projects);
        for (const report of merged.newReports) reportsApi.upsertReport(report);
        activateProjectRecord(reportsApi, app, merged.importedProject);
        setImportMessage({
          kind: 'ok',
          text: t(lang, 'import.projectOk', { name }),
        });
        return;
      }
      // Legacy app-state export: replaces the editing surface of the active project.
      if (!window.confirm(t(lang, 'import.confirmAppState'))) return;
      app.replaceState(result.data);
      setImportMessage({ kind: 'ok', text: t(lang, 'import.appStateOk') });
    };
    reader.onerror = () => setImportMessage({ kind: 'error', text: t(lang, 'import.invalidFile') });
    reader.readAsText(file);
  };

  const handleDeleteProject = (project: ProjectRecord): void => {
    const name = resolveBilingualName(lang, { nameEn: project.nameEn, nameJa: project.nameJa }) || '—';
    if (!window.confirm(t(lang, 'overall.confirmDeleteProject', { name }))) return;
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

  const sortableColumns: SortableColumn[] = [
    { key: 'name', labelKey: 'columns.name' },
    { key: 'status', labelKey: 'columns.status' },
    { key: 'start', labelKey: 'columns.date' },
    { key: 'deadline', labelKey: 'dashboard.deadline' },
    { key: 'progress', labelKey: 'overall.progress' },
    { key: 'remaining', labelKey: 'columns.remaining' },
    { key: 'updated', labelKey: 'overall.updated' },
  ];

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

      <section className="dr-section">
        <div className="overall-search-row">
          <input
            className="input overall-search"
            type="search"
            placeholder={t(lang, 'overall.searchProjects')}
            value={filters.search}
            onChange={(e) => setFilters((prev) => ({ ...prev, search: e.target.value }))}
          />
          <button type="button" className="btn" onClick={handleAddProject}>
            {t(lang, 'overall.addProject')}
          </button>
          <button type="button" className="btn" onClick={handleExportAll}>
            {t(lang, 'overall.exportAll')}
          </button>
          <button type="button" className="btn" onClick={() => importFileRef.current?.click()}>
            {t(lang, 'overall.importData')}
          </button>
          <input
            ref={importFileRef}
            type="file"
            accept="application/json,.json"
            className="visually-hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleImportFile(file);
              e.target.value = ''; // allow re-importing the same file
            }}
          />
          {importMessage ? (
            <span className={`data-controls-message ${importMessage.kind}`} role="status">
              {importMessage.text}
            </span>
          ) : null}
        </div>        <div className="dr-filter-bar">
          <label>
            {t(lang, 'overall.lifecycleStatus')}
            <select
              className="input"
              value={filters.lifecycle}
              onChange={(e) => setFilters((prev) => ({ ...prev, lifecycle: e.target.value as LifecycleFilter }))}
            >
              <option value="active">{t(lang, 'overall.active')}</option>
              <option value="all">{t(lang, 'overall.all')}</option>
              <option value="todo">{t(lang, 'overall.todo')}</option>
              <option value="ongoing">{t(lang, 'overall.ongoing')}</option>
              <option value="extended">{t(lang, 'overall.extended')}</option>
              <option value="onHold">{t(lang, 'overall.onHold')}</option>
              <option value="done">{t(lang, 'overall.done')}</option>
            </select>
          </label>
          <label>
            {t(lang, 'overall.planningStatus')}
            <select
              className="input"
              value={filters.planning}
              onChange={(e) => setFilters((prev) => ({ ...prev, planning: e.target.value as PlanningFilter }))}
            >
              <option value="all">{t(lang, 'overall.all')}</option>
              <option value="onTrack">{t(lang, 'status.onTrack')}</option>
              <option value="atRisk">{t(lang, 'status.atRisk')}</option>
              <option value="overdue">{t(lang, 'status.overdue')}</option>
              <option value="capacityShortage">{t(lang, 'status.capacityShortage')}</option>
              <option value="completed">{t(lang, 'status.completed')}</option>
              <option value="needsAttention">{t(lang, 'overall.needsAttention')}</option>
              <option value="onHold">{t(lang, 'status.onHold')}</option>
            </select>
          </label>
          {selected.size > 0 ? (
            <label>
              {t(lang, 'overall.bulkChangeStatus')} ({t(lang, 'overall.selectedCount', { count: selected.size })})
              <select
                className="input"
                value=""
                onChange={(e) => {
                  if (e.target.value !== '') handleBulkStatus(e.target.value as ProjectLifecycleStatus);
                }}
              >
                <option value="" />
                <option value="todo">{t(lang, 'overall.setTodo')}</option>
                <option value="ongoing">{t(lang, 'overall.setOngoing')}</option>
                <option value="extended">{t(lang, 'overall.setExtended')}</option>
                <option value="onHold">{t(lang, 'overall.setOnHold')}</option>
                <option value="done">{t(lang, 'overall.setDone')}</option>
              </select>
            </label>
          ) : null}
          {filters.search !== '' || filters.lifecycle !== DEFAULT_PORTFOLIO_FILTERS.lifecycle || filters.planning !== DEFAULT_PORTFOLIO_FILTERS.planning ? (
            <button type="button" className="btn btn-ghost" onClick={() => { setFilters({ ...DEFAULT_PORTFOLIO_FILTERS }); setStatusScope({ lifecycle: 'all' }); }}>
              {t(lang, 'overall.clearFilters')}
            </button>
          ) : null}
        </div>
      </section>

      <section className="dr-section">
        <div className="table-wrap overall-scroll">
          <table className="overall-table">
            <thead>
              <tr>
                <th scope="col" className="overall-check">
                  <input
                    type="checkbox"
                    aria-label={t(lang, 'overall.selectAll')}
                    checked={visible.length > 0 && visible.every((p) => selected.has(p.id))}
                    ref={(el) => {
                      if (el !== null) {
                        const selectedVisible = visible.filter((p) => selected.has(p.id)).length;
                        el.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
                      }
                    }}
                    onChange={(e) =>
                      setSelected(e.target.checked ? new Set(visible.map((p) => p.id)) : new Set())
                    }
                  />
                </th>
                {sortableColumns.map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    className={sortKey === column.key ? 'sorted' : undefined}
                    aria-sort={
                      sortKey === column.key ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'
                    }
                  >
                    <button type="button" className="th-sort" onClick={() => toggleSort(column.key)}>
                      {t(lang, column.labelKey)}
                      {sortKey === column.key ? (sortDirection === 'asc' ? ' ▲' : ' ▼') : ''}
                    </button>
                  </th>
                ))}
                <th scope="col" className="num">{t(lang, 'columns.totalCases')}</th>
                <th scope="col" className="num">{t(lang, 'overall.completion')}</th>
                <th scope="col" className="num">{t(lang, 'overall.capacity')}</th>
                <th scope="col" className="num">{t(lang, 'overall.testers')}</th>
                <th scope="col">{t(lang, 'overall.planningStatus')}</th>
                <th scope="col">{t(lang, 'overall.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={14} className="dr-empty">
                    {t(lang, 'overall.noProjects')}
                  </td>
                </tr>
              ) : null}
            {visible.map((project) => {
              const progress = projectProgress(project);
              const planning = planningStatuses.get(project.id) ?? 'noTarget';
              const planningTone =
                planning === 'atRisk' || planning === 'capacityShortage'
                  ? 'bad'
                  : planning === 'onTrack' || planning === 'completed'
                    ? 'good'
                    : 'default';
              return (
                <tr
                  key={project.id}
                  className={
                    project.status === 'done' ? (selected.has(project.id) ? 'off selected' : 'off') : selected.has(project.id) ? 'selected' : undefined
                  }
                >
                  <td className="overall-check">
                    <input
                      type="checkbox"
                      aria-label={`${t(lang, 'overall.selectProject')}: ${resolveBilingualName(lang, { nameEn: project.nameEn, nameJa: project.nameJa }) || '—'}`}
                      checked={selected.has(project.id)}
                      onChange={() => toggleSelected(project.id)}
                    />
                  </td>
                  <td className="overall-name">
                    <span className="overall-project-name">
                      {resolveBilingualName(lang, { nameEn: project.nameEn, nameJa: project.nameJa }) || '—'}
                    </span>
                  </td>
                  <td>
                    {project.status === 'done' && reopenFor === project.id ? (
                      <span className="dr-row-actions">
                        <span className="overall-reopen-label">{t(lang, 'overall.reopenAs')}:</span>
                        <button type="button" className="btn btn-ghost" onClick={() => handleStatusChange(project, 'todo')}>
                          {t(lang, 'overall.todo')}
                        </button>
                        <button type="button" className="btn btn-ghost" onClick={() => handleStatusChange(project, 'ongoing')}>
                          {t(lang, 'overall.ongoing')}
                        </button>
                        <button type="button" className="btn btn-ghost" onClick={() => handleStatusChange(project, 'extended')}>
                          {t(lang, 'overall.extended')}
                        </button>
                        <button type="button" className="btn btn-ghost" onClick={() => handleStatusChange(project, 'onHold')}>
                          {t(lang, 'overall.onHold')}
                        </button>
                      </span>
                    ) : (
                      <select
                        className="table-input"
                        value={project.status}
                        onChange={(e) => handleStatusChange(project, e.target.value as ProjectLifecycleStatus)}
                      >
                        {(['todo', 'ongoing', 'extended', 'onHold', 'done'] as const).map((status) => (
                          <option key={status} value={status}>
                            {t(lang, LIFECYCLE_KEY[status])}
                          </option>
                        ))}
                      </select>
                    )}
                    {project.status === 'done' && reopenFor !== project.id ? (
                      <button type="button" className="btn btn-ghost" onClick={() => setReopenFor(project.id)}>
                        {t(lang, 'overall.reopen')}
                      </button>
                    ) : null}
                  </td>
                  <td>{project.inputs.startDate}</td>
                  <td>{project.inputs.targetCompletionDate ?? '—'}</td>
                  <td className="num">{progress.ratio === null ? '—' : `${formatNumber(progress.ratio * 100, 2, lang)}%`}</td>
                  <td className="num">{formatInteger(progress.remaining, lang)}</td>
                  <td>{project.updatedAt.slice(0, 10)}</td>
                  <td className="num">{formatInteger(project.inputs.totalCases, lang)}</td>
                  <td className="num">
                    {formatInteger(progress.completed, lang)}/{formatInteger(progress.total, lang)}
                  </td>
                  <td className="num">{formatInteger(projectDailyCapacity(project), lang)}</td>
                  <td className="num">{formatInteger(project.inputs.currentTesters, lang)}</td>
                  <td>
                    <span className={`plan-status-tag tag-${planningTone}`}>{t(lang, PLANNING_KEY[planning])}</span>
                  </td>
                  <td className="dr-row-actions">
                    <button type="button" className="btn" onClick={() => handleOpenGantt(project)}>
                      {t(lang, 'overall.openGantt')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      title={t(lang, 'overall.exportProject')}
                      aria-label={`${t(lang, 'overall.exportProject')}: ${resolveBilingualName(lang, { nameEn: project.nameEn, nameJa: project.nameJa }) || '—'}`}
                      onClick={() => handleExportProject(project)}
                    >
                      ⭳
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger"
                      title={t(lang, 'overall.deleteProject')}
                      aria-label={`${t(lang, 'overall.deleteProject')}: ${resolveBilingualName(lang, { nameEn: project.nameEn, nameJa: project.nameJa }) || '—'}`}
                      onClick={() => handleDeleteProject(project)}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          </table>
        </div>
      </section>

      <NewProjectForm
        open={newProjectOpen}
        onClose={() => setNewProjectOpen(false)}
        onCreated={() => {
          setNewProjectOpen(false);
          onProjectCreated();
        }}
      />
    </div>
  );
}

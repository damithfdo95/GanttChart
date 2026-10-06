import { useEffect, useMemo, useState } from 'react';
import type { ProjectLifecycleStatus, ProjectRecord } from '../../types';
import { useAppStateCtx, useReportsStateCtx, activateProject } from '../../app/state-contexts';
import { t, resolveBilingualName, otherLanguage, type TranslationKey } from '../../i18n';
import { formatDate, formatDateDisplay, parseDate, todayEpochDays } from '../../lib/dates/dates';
import { calculateMultiDayProjection } from '../../lib/calculations/planning';
import { WORK_DAY_END, WORK_LUNCH } from '../../lib/calculations/workday';
import { projectPlanningStatus, projectProgress, buildDayTimeline } from '../../domain/projects';
import { formatCases, formatClock, formatInteger, formatNumber } from '../../lib/formatting/format';
import { PlanningPanel } from '../../components/PlanningPanel';
import { SectionCard } from '../../components/SectionCard';
import { MetricCard } from '../../components/MetricCard';
import { MultiDayTimeline } from '../../components/MultiDayTimeline';
import { GanttChartView } from '../../components/GanttChartView';

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

type GanttStatusFilter = 'active' | 'all' | 'todo' | 'ongoing' | 'extended' | 'onHold' | 'done';

interface GanttProps {
  focusProjectId: string | null;
  onFocusHandled: () => void;
}

/**
 * Gantt — detailed scheduling and resource planning for one selected project.
 * Project selection and status filtering live here; Done projects stay out of
 * the way but are never deleted.
 */
export function Gantt({ focusProjectId, onFocusHandled }: GanttProps) {
  const app = useAppStateCtx();
  const reportsApi = useReportsStateCtx();
  const lang = app.state.language;
  const sub = otherLanguage(lang);

  const [statusFilter, setStatusFilter] = useState<GanttStatusFilter>('active');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const projects = reportsApi.state.projects;

  // "Open in Gantt" from the Overall screen focuses the requested project.
  useEffect(() => {
    if (focusProjectId !== null) {
      const project = projects.find((p) => p.id === focusProjectId);
      if (project !== undefined) activateProject(reportsApi, app, focusProjectId);
      else if (projects.length > 0) activateProject(reportsApi, app, projects[0].id);
      // Selecting a project always reveals its day table.
      setCollapsed((prev) => {
        if (!prev.has(focusProjectId)) return prev;
        const next = new Set(prev);
        next.delete(focusProjectId);
        return next;
      });
      onFocusHandled();
    }
  }, [focusProjectId, projects, reportsApi, app, onFocusHandled]);

  const activeProject =
    projects.find((p) => p.id === reportsApi.state.activeProjectId) ?? projects[0] ?? null;

  const visibleProjects = useMemo(
    () =>
      projects.filter((project) => {
        if (
          statusFilter === 'todo' ||
          statusFilter === 'ongoing' ||
          statusFilter === 'extended' ||
          statusFilter === 'onHold' ||
          statusFilter === 'done'
        ) {
          return project.status === statusFilter;
        }
        if (statusFilter === 'active') return project.status !== 'done';
        return true;
      }),
    [projects, statusFilter],
  );

  // Daily progress across the visible projects, one colored segment per
  // project per day.
  const today = formatDate(todayEpochDays());
  const dayTimeline = useMemo(
    () => buildDayTimeline(visibleProjects, lang, today),
    [visibleProjects, lang, today],
  );

  const handleSelectProject = (id: string): void => {
    activateProject(reportsApi, app, id);
    // Selecting a project always reveals its day table.
    setCollapsed((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const toggleCollapsed = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const activeProgress = activeProject !== null ? projectProgress(activeProject) : null;
  const activePlanning = activeProject !== null ? projectPlanningStatus(activeProject) : 'noTarget';
  // The active project can be excluded by the status filter; it must stay
  // selectable so the summary card and selector never disagree about which
  // project is being edited.
  const activeHiddenByFilter = activeProject !== null && !visibleProjects.some((p) => p.id === activeProject.id);

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title-group">
          <h1>{t(lang, 'nav.gantt')}</h1>
        </div>
        <div className="app-header-actions">
          <label className="dr-toolbar-field">
            {t(lang, 'overall.projects')}
            <select
              className="input"
              value={activeProject?.id ?? ''}
              onChange={(e) => handleSelectProject(e.target.value)}
            >
              {activeHiddenByFilter && activeProject !== null ? (
                <option value={activeProject.id}>
                  {resolveBilingualName(lang, { nameEn: activeProject.nameEn, nameJa: activeProject.nameJa }) || activeProject.id}
                </option>
              ) : null}
              {visibleProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {resolveBilingualName(lang, { nameEn: project.nameEn, nameJa: project.nameJa }) || project.id}
                </option>
              ))}
            </select>
          </label>
          <label className="dr-toolbar-field">
            {t(lang, 'columns.status')}
            <select
              className="input"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as GanttStatusFilter)}
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
        </div>
      </header>

      {activeProject !== null ? (
        <>
          <SectionCard title={t(lang, 'gantt.projectSummary')} span={12}>
            <div className="metrics-grid">
              <MetricCard label={t(lang, 'columns.name')} value={resolveBilingualName(lang, { nameEn: activeProject.nameEn, nameJa: activeProject.nameJa }) || '—'} />
              <MetricCard
                label={t(lang, 'overall.lifecycleStatus')}
                value={t(lang, LIFECYCLE_KEY[activeProject.status])}
              />
              <MetricCard label={t(lang, 'overall.planningStatus')} value={t(lang, PLANNING_KEY[activePlanning])} />
              <MetricCard label={t(lang, 'columns.date')} value={activeProject.inputs.startDate} />
              <MetricCard label={t(lang, 'dashboard.deadline')} value={activeProject.inputs.targetCompletionDate ?? '—'} />
              <MetricCard
                label={t(lang, 'overall.progress')}
                value={activeProgress === null || activeProgress.ratio === null ? '—' : `${formatNumber(activeProgress.ratio * 100, 2, lang)}%`}
              />
              <MetricCard
                label={t(lang, 'columns.remaining')}
                value={activeProgress === null ? '—' : `${formatInteger(activeProgress.remaining, lang)} ${t(lang, 'units.cases')}`}
              />
              <MetricCard
                label={t(lang, 'overall.testers')}
                value={`${formatInteger(activeProject.inputs.currentTesters, lang)} ${t(lang, 'units.testers')}`}
              />
            </div>
          </SectionCard>

          <PlanningPanel
            inputs={app.state}
            lang={lang}
            onChangeStartDate={app.changeStartDate}
            onSetTargetCompletionDate={(value) => app.updateField('targetCompletionDate', value)}
            onSetTargetCompletionTime={(value) => app.updateField('targetCompletionTime', value)}
            onSetPlanStartTime={(minutes) => app.updateField('startTime', minutes)}
            onSetProjectName={(field, value) => app.updateField(field, value)}
            onUpdateRow={app.updatePlanningRow}
            onAddRow={app.addPlanningRow}
            onRemoveRow={app.removePlanningRow}
          />
        </>
      ) : null}

      {dayTimeline.days.length > 1 ? (
        <SectionCard title={t(lang, 'timeline.title')} span={12}>
          <MultiDayTimeline data={dayTimeline} lang={lang} defaultProjectId={activeProject?.projectId ?? ''} />
        </SectionCard>
      ) : null}

      {visibleProjects.length > 0 ? (
        <SectionCard title={t(lang, 'gantt.chart.title')} subtitle={t(sub, 'gantt.chart.title')} span={12}>
          <p className="gantt-chart-hint">{t(lang, 'gantt.chart.hint')}</p>
          <GanttChartView
            projects={visibleProjects}
            activeProjectId={activeProject?.id ?? null}
            lang={lang}
            onSelect={handleSelectProject}
          />
        </SectionCard>
      ) : null}

      <SectionCard title={t(lang, 'gantt.projects')} span={12}>
        <div className="gantt-project-list">
          {activeHiddenByFilter && activeProject !== null ? (
            <p className="empty-note">{t(lang, 'gantt.activeHiddenByFilter')}</p>
          ) : null}
          {visibleProjects.length === 0 ? (
            <p className="empty-note">{t(lang, 'gantt.noProjectsMatch')}</p>
          ) : null}
          {visibleProjects.map((project) => {
            // Only the selected (active) project shows its day table; every
            // other project stays collapsed. The active one can still be
            // collapsed manually via its toggle.
            const isCollapsed = project.id !== activeProject?.id || collapsed.has(project.id);
            const planning = projectPlanningStatus(project);
            const progress = projectProgress(project);
            const projectName = resolveBilingualName(lang, { nameEn: project.nameEn, nameJa: project.nameJa }) || project.id;
            return (
              <div
                key={project.id}
                className={`gantt-project ${isCollapsed ? 'collapsed' : 'expanded'}${activeProject?.id === project.id ? ' active' : ''}`}
              >
                <div className="gantt-project-head">
                  <div className="gantt-project-title-row">
                    <button
                      type="button"
                      className="btn-icon gantt-collapse"
                      title={isCollapsed ? t(lang, 'gantt.expandProject') : t(lang, 'gantt.collapseProject')}
                      aria-label={`${isCollapsed ? t(lang, 'gantt.expandProject') : t(lang, 'gantt.collapseProject')}: ${projectName}`}
                      aria-expanded={!isCollapsed}
                      aria-controls={`gantt-days-${project.id}`}
                      onClick={() => {
                        // Expanding a non-selected project selects it (which
                        // reveals its table); the selected one just toggles.
                        if (project.id === activeProject?.id) toggleCollapsed(project.id);
                        else handleSelectProject(project.id);
                      }}
                    >
                      {isCollapsed ? '▶' : '▼'}
                    </button>
                    <span className="overall-project-name" title={projectName}>
                      {projectName}
                    </span>
                    {activeProject?.id === project.id ? (
                      <span className="gantt-active-tag">{t(lang, 'gantt.activeProject')}</span>
                    ) : null}
                    <span className="gantt-project-statuses">
                      {t(lang, LIFECYCLE_KEY[project.status])} · {t(lang, PLANNING_KEY[planning])}
                    </span>
                    {activeProject?.id !== project.id ? (
                      <button type="button" className="btn btn-ghost" onClick={() => handleSelectProject(project.id)}>
                        {t(lang, 'overall.openGantt')}
                      </button>
                    ) : null}
                  </div>
                  <div className="gantt-project-meta-grid">
                    <span className="gantt-meta-cell">
                      <span className="gantt-meta-label">{t(lang, 'dashboard.deadline')}</span>
                      <span className="gantt-meta-value">{project.inputs.targetCompletionDate ?? '—'}</span>
                    </span>
                    <span className="gantt-meta-cell">
                      <span className="gantt-meta-label">{t(lang, 'overall.progress')}</span>
                      <span className="gantt-meta-value">
                        {progress.ratio === null ? '—' : `${formatNumber(progress.ratio * 100, 2, lang)}%`}
                      </span>
                    </span>
                    <span className="gantt-meta-cell">
                      <span className="gantt-meta-label">{t(lang, 'columns.remaining')}</span>
                      <span className="gantt-meta-value">{formatInteger(progress.remaining, lang)}</span>
                    </span>
                    <span className="gantt-meta-cell">
                      <span className="gantt-meta-label">{t(lang, 'overall.testers')}</span>
                      <span className="gantt-meta-value">{formatInteger(project.inputs.currentTesters, lang)}</span>
                    </span>
                  </div>
                </div>
                {isCollapsed ? null : (
                  <div id={`gantt-days-${project.id}`}>
                    <ProjectDayTable project={project} lang={lang} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </SectionCard>
    </div>
  );
}

/** Read-only per-day planning rows for one project (expanded view). */
function ProjectDayTable({ project, lang }: { project: ProjectRecord; lang: 'en' | 'ja' }) {
  const projection = useMemo(
    () =>
      calculateMultiDayProjection({
        casesRemaining: Math.max(0, project.inputs.totalCases - project.inputs.casesCompleted),
        planningRows: project.inputs.planningRows,
        perHourPerTester: project.inputs.perHourPerTester,
        workStartTime: project.inputs.startTime,
        workEndTime: WORK_DAY_END,
        lunch: WORK_LUNCH,
        targetCompletionDate: project.inputs.targetCompletionDate,
        targetCompletionTime: null,
        dailyOvertimeMinutes: project.inputs.dailyOvertimeMinutes,
      }),
    [project.inputs],
  );
  const today = formatDate(todayEpochDays());
  return (
    <div className="table-wrap">
      <table className="dr-table gantt-day-table">
        <thead>
          <tr>
            <th>{t(lang, 'columns.date')}</th>
            <th className="num">{t(lang, 'columns.availableTesters')}</th>
            <th className="num">{t(lang, 'columns.dailyCapacity')}</th>
            <th className="num">{t(lang, 'columns.cumulativeCapacity')}</th>
            <th className="num">{t(lang, 'columns.remaining')}</th>
            <th>{t(lang, 'plan.projectedCompletion')}</th>
          </tr>
        </thead>
        <tbody>
          {projection.rows.map((row) => {
            const epoch = parseDate(row.date);
            return (
              <tr key={row.date} className={row.date === today ? 'completes' : row.nonWorkingDay ? 'off' : undefined}>
                <td>
                  {epoch === null ? row.date : formatDateDisplay(epoch, lang)}
                  {row.date === today ? <span className="tag tag-today">{t(lang, 'gap.todayTag')}</span> : null}
                </td>
                <td className="num">{formatInteger(row.availableTesters, lang)}</td>
                <td className="num">{formatCases(row.dailyCapacity, lang)}</td>
                <td className="num">{formatCases(row.cumulativeCapacity, lang)}</td>
                <td className="num">{formatCases(Math.max(0, row.remainingCases), lang)}</td>
                <td>
                  {projection.projectedCompletion?.date === row.date
                    ? `${projection.projectedCompletion.date} ${formatClock(projection.projectedCompletion.time)}`
                    : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

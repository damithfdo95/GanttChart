/**
 * Overall screen table + toolbar. Extracted from Overall.tsx so the screen
 * file holds state wiring and derivation only.
 */

import { useRef } from 'react';
import { t, resolveBilingualName, type TranslationKey } from '../../i18n';
import type { ProjectLifecycleStatus, ProjectRecord } from '../../types';
import type { ProjectPlanningStatus } from '../../domain/projects/types';
import {
  DEFAULT_PORTFOLIO_FILTERS,
  projectDailyCapacity,
  projectProgress,
  type LifecycleFilter,
  type PlanningFilter,
  type ProjectSortKey,
  type SortDirection,
} from '../../domain/projects';
import { formatInteger, formatNumber } from '../../lib/formatting/format';
import { LIFECYCLE_KEY, PLANNING_KEY } from '../../lib/statusKeys';
import { ReadinessBadge } from '../readiness/ReadinessCard';
import type { ReleaseReadiness } from '../../domain/readiness';
import type { Language } from '../../types';

export interface PortfolioFilters {
  search: string;
  lifecycle: LifecycleFilter;
  planning: PlanningFilter;
  team: string | null;
}

export interface SortableColumn {
  key: ProjectSortKey;
  labelKey: TranslationKey;
}

export const SORTABLE_COLUMNS: SortableColumn[] = [
  { key: 'name', labelKey: 'columns.name' },
  { key: 'status', labelKey: 'columns.status' },
  { key: 'start', labelKey: 'columns.date' },
  { key: 'deadline', labelKey: 'dashboard.deadline' },
  { key: 'progress', labelKey: 'overall.progress' },
  { key: 'remaining', labelKey: 'columns.remaining' },
  { key: 'updated', labelKey: 'overall.updated' },
];

export interface PortfolioToolbarProps {
  lang: Language;
  readOnly: boolean;
  filters: PortfolioFilters;
  onFiltersChange: (next: PortfolioFilters) => void;
  selectedCount: number;
  onAddProject: () => void;
  onExportAll: () => void;
  onImportFile: (file: File) => void;
  onBulkStatus: (status: ProjectLifecycleStatus) => void;
  onClearFilters: () => void;
  importMessage: { kind: 'ok' | 'error'; text: string } | null;
}

export function PortfolioToolbar({
  lang,
  readOnly,
  filters,
  onFiltersChange,
  selectedCount,
  onAddProject,
  onExportAll,
  onImportFile,
  onBulkStatus,
  onClearFilters,
  importMessage,
}: PortfolioToolbarProps) {
  const importFileRef = useRef<HTMLInputElement>(null);
  return (
    <section className="dr-section">
      <div className="overall-search-row">
        <input
          className="input overall-search"
          type="search"
          placeholder={t(lang, 'overall.searchProjects')}
          value={filters.search}
          onChange={(e) => onFiltersChange({ ...filters, search: e.target.value })}
        />
        {readOnly ? null : (
          <>
            <button type="button" className="btn" onClick={onAddProject}>
              {t(lang, 'overall.addProject')}
            </button>
            <button type="button" className="btn" onClick={onExportAll}>
              {t(lang, 'overall.exportAll')}
            </button>
            <button type="button" className="btn" onClick={() => importFileRef.current?.click()}>
              {t(lang, 'overall.importData')}
            </button>
          </>
        )}
        <input
          ref={importFileRef}
          type="file"
          accept="application/json,.json"
          className="visually-hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onImportFile(file);
            e.target.value = ''; // allow re-importing the same file
          }}
        />
        {importMessage ? (
          <span className={`data-controls-message ${importMessage.kind}`} role="status">
            {importMessage.text}
          </span>
        ) : null}
      </div>
      <div className="dr-filter-bar">
        <label>
          {t(lang, 'overall.lifecycleStatus')}
          <select
            className="input"
            value={filters.lifecycle}
            onChange={(e) => onFiltersChange({ ...filters, lifecycle: e.target.value as LifecycleFilter })}
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
            onChange={(e) => onFiltersChange({ ...filters, planning: e.target.value as PlanningFilter })}
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
        {selectedCount > 0 ? (
          <label>
            {t(lang, 'overall.bulkChangeStatus')} ({t(lang, 'overall.selectedCount', { count: selectedCount })})
            <select
              className="input"
              value=""
              onChange={(e) => {
                if (e.target.value !== '') onBulkStatus(e.target.value as ProjectLifecycleStatus);
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
          <button type="button" className="btn btn-ghost" onClick={onClearFilters}>
            {t(lang, 'overall.clearFilters')}
          </button>
        ) : null}
      </div>
    </section>
  );
}

export interface OverallProjectTableProps {
  lang: Language;
  /** Release readiness per project id; omitted for a Tester (no readiness column). */
  readiness?: ReadonlyMap<string, ReleaseReadiness>;
  readOnly: boolean;
  visible: ProjectRecord[];
  planningStatuses: Map<string, ProjectPlanningStatus>;
  selected: Set<string>;
  sortKey: ProjectSortKey;
  sortDirection: SortDirection;
  reopenFor: string | null;
  onToggleSelected: (id: string) => void;
  onToggleSort: (key: ProjectSortKey) => void;
  onSelectAll: (ids: Set<string>) => void;
  onStatusChange: (project: ProjectRecord, status: ProjectLifecycleStatus) => void;
  onReopenFor: (id: string | null) => void;
  onOpenGantt: (project: ProjectRecord) => void;
  onExportProject: (project: ProjectRecord) => void;
  onDeleteProject: (project: ProjectRecord) => void;
}

export function OverallProjectTable({
  lang,
  readiness,
  readOnly,
  visible,
  planningStatuses,
  selected,
  sortKey,
  sortDirection,
  reopenFor,
  onToggleSelected,
  onToggleSort,
  onSelectAll,
  onStatusChange,
  onReopenFor,
  onOpenGantt,
  onExportProject,
  onDeleteProject,
}: OverallProjectTableProps) {
  return (
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
                    onSelectAll(e.target.checked ? new Set(visible.map((p) => p.id)) : new Set())
                  }
                />
              </th>
              {SORTABLE_COLUMNS.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={sortKey === column.key ? 'sorted' : undefined}
                  aria-sort={
                    sortKey === column.key ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'
                  }
                >
                  <button type="button" className="th-sort" onClick={() => onToggleSort(column.key)}>
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
              {readiness === undefined ? null : <th scope="col">{t(lang, 'readiness.column')}</th>}
              <th scope="col">{t(lang, 'overall.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={readiness === undefined ? 14 : 15} className="dr-empty">
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
                      onChange={() => onToggleSelected(project.id)}
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
                        <button type="button" className="btn btn-ghost" onClick={() => onStatusChange(project, 'todo')}>
                          {t(lang, 'overall.todo')}
                        </button>
                        <button type="button" className="btn btn-ghost" onClick={() => onStatusChange(project, 'ongoing')}>
                          {t(lang, 'overall.ongoing')}
                        </button>
                        <button type="button" className="btn btn-ghost" onClick={() => onStatusChange(project, 'extended')}>
                          {t(lang, 'overall.extended')}
                        </button>
                        <button type="button" className="btn btn-ghost" onClick={() => onStatusChange(project, 'onHold')}>
                          {t(lang, 'overall.onHold')}
                        </button>
                      </span>
                    ) : readOnly ? (
                      <span>{t(lang, LIFECYCLE_KEY[project.status])}</span>
                    ) : (
                      <select
                        className="table-input"
                        value={project.status}
                        onChange={(e) => onStatusChange(project, e.target.value as ProjectLifecycleStatus)}
                      >
                        {(['todo', 'ongoing', 'extended', 'onHold', 'done'] as const).map((status) => (
                          <option key={status} value={status}>
                            {t(lang, LIFECYCLE_KEY[status])}
                          </option>
                        ))}
                      </select>
                    )}
                    {!readOnly && project.status === 'done' && reopenFor !== project.id ? (
                      <button type="button" className="btn btn-ghost" onClick={() => onReopenFor(project.id)}>
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
                  {readiness === undefined ? null : <td>{readiness.get(project.id) === undefined ? '—' : <ReadinessBadge lang={lang} readiness={readiness.get(project.id) as ReleaseReadiness} />}</td>}
                  <td className="dr-row-actions">
                    <button type="button" className="btn" onClick={() => onOpenGantt(project)}>
                      {t(lang, 'overall.openGantt')}
                    </button>
                    {readOnly ? null : (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      title={t(lang, 'overall.exportProject')}
                      aria-label={`${t(lang, 'overall.exportProject')}: ${resolveBilingualName(lang, { nameEn: project.nameEn, nameJa: project.nameJa }) || '—'}`}
                      onClick={() => onExportProject(project)}
                    >
                      ⭳
                    </button>
                    )}
                    {readOnly ? null : (
                    <button
                      type="button"
                      className="btn btn-danger"
                      title={t(lang, 'overall.deleteProject')}
                      aria-label={`${t(lang, 'overall.deleteProject')}: ${resolveBilingualName(lang, { nameEn: project.nameEn, nameJa: project.nameJa }) || '—'}`}
                      onClick={() => onDeleteProject(project)}
                    >
                      ×
                    </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

import type { Language, ProjectLifecycleStatus, ProjectRecord } from '../types';
import { t, resolveBilingualName, type TranslationKey } from '../i18n';
import { formatDate, parseDate, todayEpochDays } from '../lib/dates/dates';
import { formatInteger, formatNumber } from '../lib/formatting/format';
import { compareByStartDateTime, projectPlanningStatus, projectProgress } from '../domain/projects';

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

interface GanttChartViewProps {
  projects: ProjectRecord[];
  activeProjectId: string | null;
  lang: Language;
  onSelect: (id: string) => void;
}

interface BarRow {
  project: ProjectRecord;
  startEpoch: number;
  /** Deadline epoch day; null when no target date is set (bar runs to the domain end, dashed). */
  deadlineEpoch: number | null;
  ratio: number | null;
  planning: ReturnType<typeof projectPlanningStatus>;
  statusText: string;
  tooltip: string;
}

function shortDate(epochDay: number): string {
  const raw = formatDate(epochDay);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (m === null) return raw;
  return `${Number(m[2])}/${Number(m[3])}`;
}

/**
 * Horizontal schedule bars (one row per project): start date → deadline,
 * progress fill inside the bar, a today marker line and a status color per
 * planning status. Pure presentation — all values come from the existing
 * domain selectors. Clicking a bar (or its name button) selects the project.
 */
export function GanttChartView({ projects, activeProjectId, lang, onSelect }: GanttChartViewProps) {
  const today = todayEpochDays();

  // Rows display in start-datetime order (earliest first); the caller's
  // array order is never relied upon.
  const orderedProjects = [...projects].sort(compareByStartDateTime);

  const candidates: BarRow[] = [];
  for (const project of orderedProjects) {
    const startEpoch = parseDate(project.inputs.startDate);
    if (startEpoch === null) continue;
    const deadlineEpoch =
      project.inputs.targetCompletionDate === null ? null : parseDate(project.inputs.targetCompletionDate);
    const progress = projectProgress(project);
    const planning = projectPlanningStatus(project);
    const lifecycle = t(lang, LIFECYCLE_KEY[project.status]);
    const planningLabel = t(lang, PLANNING_KEY[planning]);
    const name = resolveBilingualName(lang, { nameEn: project.nameEn, nameJa: project.nameJa }) || project.id;
    const tooltip = t(lang, 'gantt.barTooltip', {
      name,
      start: shortDate(startEpoch),
      deadline: deadlineEpoch === null ? '—' : shortDate(deadlineEpoch),
      pct: progress.ratio === null ? 0 : Math.round(progress.ratio * 100),
      completed: formatInteger(progress.completed, lang),
      total: formatInteger(progress.total, lang),
      status: `${lifecycle} / ${planningLabel}`,
    });
    candidates.push({
      project,
      startEpoch,
      deadlineEpoch,
      ratio: progress.ratio,
      planning,
      statusText: planningLabel,
      tooltip,
    });
  }

  if (candidates.length === 0) {
    return <p className="dr-empty">{t(lang, 'gantt.chart.noDates')}</p>;
  }

  let minEpoch = Math.min(...candidates.map((row) => row.startEpoch), today);
  let maxEpoch = Math.max(...candidates.map((row) => row.deadlineEpoch ?? row.startEpoch), today);
  if (maxEpoch <= minEpoch) maxEpoch = minEpoch + 1; // avoid a zero-span domain
  const span = maxEpoch - minEpoch;
  const pct = (epoch: number): number => {
    const value = ((epoch - minEpoch) / span) * 100;
    return Math.min(100, Math.max(0, value));
  };
  const todayPct = pct(today);

  return (
    <div className="gantt-chart">
      <div className="gantt-chart-body">
        <div className="gantt-chart-labels">
          {candidates.map((row) => {
            const name = resolveBilingualName(lang, { nameEn: row.project.nameEn, nameJa: row.project.nameJa }) || row.project.id;
            const active = row.project.id === activeProjectId;
            return (
              <button
                key={row.project.id}
                type="button"
                className={`gantt-chart-label${active ? ' active' : ''}`}
                title={row.tooltip}
                onClick={() => onSelect(row.project.id)}
              >
                <span className="gantt-chart-label-name">{name}</span>
              </button>
            );
          })}
        </div>
        <div className="gantt-chart-tracks">
          {candidates.map((row) => {
            const active = row.project.id === activeProjectId;
            const barLeft = pct(row.startEpoch);
            const barRight = row.deadlineEpoch === null ? 100 : pct(row.deadlineEpoch);
            const barWidth = Math.max(1.5, barRight - barLeft);
            const fillPct = row.ratio === null ? 0 : Math.round(row.ratio * 100);
            return (
              <div
                key={row.project.id}
                className={`gantt-chart-track${row.project.status === 'done' ? ' is-done' : ''}${row.project.status === 'onHold' ? ' is-on-hold' : ''}`}
                title={row.tooltip}
                onClick={() => onSelect(row.project.id)}
              >
                <div
                  className={`gantt-chart-bar status-${row.planning}${row.deadlineEpoch === null ? ' no-deadline' : ''}${active ? ' active' : ''}`}
                  style={{ left: `${barLeft}%`, width: `${barWidth}%` }}
                >
                  <div className="gantt-chart-fill" style={{ width: `${fillPct}%` }} />
                </div>
                {barRight <= 88 && row.ratio !== null ? (
                  <span className="gantt-chart-pct" style={{ left: `calc(${barRight}% + 6px)` }}>
                    {formatNumber(row.ratio * 100, 0, lang)}%
                  </span>
                ) : null}
              </div>
            );
          })}
          <div className="gantt-chart-today" style={{ left: `${todayPct}%` }} />
        </div>
      </div>
      <div className="gantt-chart-axis">
        <span className="gantt-chart-axis-label gantt-chart-axis-start">{shortDate(minEpoch)}</span>
        {todayPct >= 8 && todayPct <= 92 ? (
          <span className="gantt-chart-axis-label gantt-chart-axis-today" style={{ left: `${todayPct}%` }}>
            {t(lang, 'gap.todayTag')}
          </span>
        ) : null}
        <span className="gantt-chart-axis-label gantt-chart-axis-end">{shortDate(maxEpoch)}</span>
      </div>
    </div>
  );
}

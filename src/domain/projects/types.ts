import type {
  ProjectLifecycleStatus,
  ProjectRecord,
  ProjectStatusChange,
  QaInputs,
} from '../../types';

/**
 * Project domain types. The canonical entity types live in src/types; the
 * domain-specific view/filter types are defined here so every screen uses
 * exactly one vocabulary for lifecycle and planning status.
 */

export type { ProjectLifecycleStatus, ProjectRecord, ProjectStatusChange, QaInputs };

/**
 * Planning/risk status — always derived from the existing calculation
 * engine. "onHold" is the derived display state for projects whose lifecycle
 * is On Hold: the engine result is masked because paused work has neither
 * schedule pressure nor progress.
 */
export type ProjectPlanningStatus = 'onTrack' | 'atRisk' | 'capacityShortage' | 'completed' | 'noTarget' | 'onHold';

/** Lifecycle order used for the default portfolio sort. */
export const LIFECYCLE_ORDER: Record<ProjectLifecycleStatus, number> = {
  todo: 0,
  ongoing: 1,
  extended: 2,
  onHold: 3,
  done: 4,
};

export type LifecycleFilter = 'active' | 'all' | 'todo' | 'ongoing' | 'extended' | 'onHold' | 'done';

export type PlanningFilter =
  | 'all'
  | 'onTrack'
  | 'atRisk'
  | 'capacityShortage'
  | 'completed'
  | 'overdue'
  | 'needsAttention'
  | 'onHold';

export interface PortfolioFilters {
  lifecycle: LifecycleFilter;
  planning: PlanningFilter;
  team: string | null;
  search: string;
}

export const DEFAULT_PORTFOLIO_FILTERS: PortfolioFilters = {
  lifecycle: 'active',
  planning: 'all',
  team: null,
  search: '',
};

/** Initial filter preset applied when navigating from Dashboard cards. */
export interface OverallFocus {
  lifecycle?: LifecycleFilter;
  planning?: PlanningFilter;
}

export type ProjectSortKey = 'default' | 'id' | 'name' | 'status' | 'start' | 'deadline' | 'progress' | 'remaining' | 'updated';
export type SortDirection = 'asc' | 'desc';

export interface ProjectProgress {
  /** completed/total as 0–1, or null when totalCases is 0. */
  ratio: number | null;
  completed: number;
  total: number;
  remaining: number;
}

export interface PortfolioSummary {
  total: number;
  todo: number;
  ongoing: number;
  extended: number;
  onHold: number;
  done: number;
  atRisk: number;
  overdue: number;
  capacityShortage: number;
}

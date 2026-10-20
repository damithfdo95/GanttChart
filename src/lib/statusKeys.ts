import type { TranslationKey } from '../i18n';
import type { ProjectLifecycleStatus, BlockingCategory } from '../types';
import { projectPlanningStatus } from '../domain/projects';

/**
 * Single source of truth for the translation keys of project lifecycle and
 * planning statuses. Previously duplicated across Gantt.tsx, Overall.tsx,
 * GanttChartView.tsx and NewProjectForm.tsx.
 */
export const LIFECYCLE_KEY: Record<ProjectLifecycleStatus, TranslationKey> = {
  todo: 'overall.todo',
  ongoing: 'overall.ongoing',
  extended: 'overall.extended',
  onHold: 'overall.onHold',
  done: 'overall.done',
};

export const PLANNING_KEY: Record<ReturnType<typeof projectPlanningStatus>, TranslationKey> = {
  onTrack: 'status.onTrack',
  atRisk: 'status.atRisk',
  capacityShortage: 'status.capacityShortage',
  completed: 'status.completed',
  noTarget: 'plan.noTargetSet',
  onHold: 'status.onHold',
};

/** Translation keys for blocking-event categories (was duplicated in BlockingPanel + JiraBlockingImport). */
export const BLOCKING_CAT_KEY: Record<BlockingCategory, TranslationKey> = {
  ENVIRONMENT: 'blocking.cat.ENVIRONMENT',
  BUILD: 'blocking.cat.BUILD',
  TEST_DATA: 'blocking.cat.TEST_DATA',
  REQUIREMENT: 'blocking.cat.REQUIREMENT',
  SYSTEM_ISSUE: 'blocking.cat.SYSTEM_ISSUE',
  OTHER: 'blocking.cat.OTHER',
};

/** MIME type for .xlsx downloads (was duplicated in DailyReport, JiraScreen, ReportsExport). */
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** The valid project lifecycle status values (was duplicated in storage integrity + reports). */
export const PROJECT_LIFECYCLE_STATUSES: readonly ProjectLifecycleStatus[] = [
  'todo',
  'ongoing',
  'extended',
  'onHold',
  'done',
];


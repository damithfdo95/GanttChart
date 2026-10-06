import type { AppState, Language } from '../../types';
import type { MultiDayProjectionResult } from '../calculations/planning';
import { countWorkingDays } from '../calculations/planning';
import { derivePlanStatus, type PlanExplanationInput, type PlanStatus } from '../calculations/explanations';
import { WORK_DAY_END } from '../calculations/workday';
import { formatDateDisplay, parseDate } from '../dates/dates';
import { t } from '../../i18n';

/**
 * Management report row (single-project). All values come from the pure
 * planning engine — identical in every language; only labels are localized.
 */

export interface ManagementReportRow {
  project: string;
  dueDate: string | null;
  dueDateEpoch: number | null;
  remainingTestCases: number;
  currentTesters: number;
  requiredTesters: number | null;
  capacityGap: number | null;
  predictedFinishEpoch: number | null;
  requiredOtPerTesterPerDay: number | null;
  totalOtPersonHours: number | null;
  riskStatus: PlanStatus;
}

export function buildManagementReportRow(
  state: AppState,
  projection: MultiDayProjectionResult,
): ManagementReportRow {
  const casesRemaining = Math.max(0, state.totalCases - state.casesCompleted);
  const workingDays =
    state.targetCompletionDate !== null ? countWorkingDays(state.planningRows, state.targetCompletionDate) : 0;
  const totalOtPersonHours =
    projection.shortageByDeadline !== null && state.perHourPerTester > 0
      ? projection.shortageByDeadline / state.perHourPerTester
      : null;
  const requiredOtPerTesterPerDay =
    totalOtPersonHours !== null && totalOtPersonHours > 0 && state.currentTesters > 0 && workingDays > 0
      ? totalOtPersonHours / (state.currentTesters * workingDays)
      : null;
  const explanationInput: PlanExplanationInput = {
    totalCases: state.totalCases,
    casesRemaining,
    planningDayCount: state.planningRows.length,
    targetCompletionDate: state.targetCompletionDate,
    targetCompletionTime: null,
    workEndTimeMinutes: WORK_DAY_END,
  };
  return {
    project: state.projectNameEn !== '' || state.projectNameJa !== '' ? state.projectNameEn || state.projectNameJa : 'GanttChart',
    dueDate: state.targetCompletionDate,
    dueDateEpoch: state.targetCompletionDate !== null ? parseDate(state.targetCompletionDate) : null,
    remainingTestCases: casesRemaining,
    currentTesters: state.currentTesters,
    requiredTesters: projection.recommendedTesters,
    capacityGap:
      projection.recommendedTesters !== null
        ? Math.max(0, projection.recommendedTesters - state.currentTesters)
        : null,
    predictedFinishEpoch:
      projection.projectedCompletion !== null ? parseDate(projection.projectedCompletion.date) : null,
    requiredOtPerTesterPerDay,
    totalOtPersonHours,
    riskStatus: derivePlanStatus(projection, explanationInput),
  };
}

const RISK_STATUS_KEY: Record<PlanStatus, 'status.completed' | 'status.capacityShortage' | 'status.atRisk' | 'status.onTrack' | 'plan.noTargetSet'> = {
  completed: 'status.completed',
  capacityShortage: 'status.capacityShortage',
  atRisk: 'status.atRisk',
  onTrack: 'status.onTrack',
  noTarget: 'plan.noTargetSet',
};

export function riskStatusLabel(lang: Language, status: PlanStatus): string {
  return t(lang, RISK_STATUS_KEY[status]);
}

/** Human-readable due/predicted dates for TXT/PDF exports. */
export function managementDateText(lang: Language, epoch: number | null): string {
  return epoch === null ? '—' : formatDateDisplay(epoch, lang);
}

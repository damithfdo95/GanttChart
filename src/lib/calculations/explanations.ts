import type { Language } from '../../types';
import { t } from '../../i18n';
import { formatCases, formatClock, formatSignedMultiDayDuration } from '../formatting/format';
import { formatDateDisplay, parseDate } from '../dates/dates';
import type { MultiDayProjectionResult } from './planning';

/**
 * Localizable calculation explanations.
 *
 * Every sentence comes from a single translation template with {variables}
 * (locales/en.json, locales/ja.json) — never from concatenating translated
 * fragments. Only the wording differs per language; the underlying numbers
 * come straight from the pure planning engine, so results are identical in
 * every language.
 */

/** Coarse plan health used for the status tag shown next to the explanation. */
export type PlanStatus = 'completed' | 'capacityShortage' | 'atRisk' | 'onTrack' | 'noTarget';

export interface PlanExplanation {
  status: PlanStatus;
  text: string;
}

/** Raw (language-independent) inputs the explanation is derived from. */
export interface PlanExplanationInput {
  totalCases: number;
  casesRemaining: number;
  planningDayCount: number;
  targetCompletionDate: string | null;
  /** Target time in minutes since midnight, or null to use the work end. */
  targetCompletionTime: number | null;
  workEndTimeMinutes: number;
}

function formatDateTime(date: string, timeMinutes: number, lang: Language): string {
  const epoch = parseDate(date);
  const dateText = epoch === null ? date : formatDateDisplay(epoch, lang);
  return `${dateText} ${formatClock(timeMinutes)}`;
}

/** Classify the plan: completed > no target > shortage > at risk > on track. */
export function derivePlanStatus(
  projection: MultiDayProjectionResult,
  input: PlanExplanationInput,
): PlanStatus {
  if (input.casesRemaining <= 0) return 'completed';
  if (input.targetCompletionDate === null) return 'noTarget';
  if (projection.shortageByDeadline !== null && projection.shortageByDeadline > 0) return 'capacityShortage';
  if (projection.targetVarianceMinutes !== null && projection.targetVarianceMinutes < 0) return 'atRisk';
  return 'onTrack';
}

/**
 * Build the human-readable plan explanation in the requested language.
 * The projection numbers are identical for every language; only templates
 * and locale formatting differ.
 */
export function buildPlanExplanation(
  lang: Language,
  projection: MultiDayProjectionResult,
  input: PlanExplanationInput,
): PlanExplanation {
  const status = derivePlanStatus(projection, input);
  const targetTime = input.targetCompletionTime ?? input.workEndTimeMinutes;

  switch (status) {
    case 'completed':
      return {
        status,
        text: t(lang, 'explanation.allDone', { total: formatCases(input.totalCases, lang) }),
      };
    case 'noTarget':
      return {
        status,
        text: t(lang, 'explanation.noTarget', {
          capacity: formatCases(projection.totalPlannedCapacity, lang),
          days: String(input.planningDayCount),
        }),
      };
    case 'capacityShortage':
      return {
        status,
        text: t(lang, 'explanation.shortage', {
          capacity: formatCases(projection.capacityByDeadline ?? 0, lang),
          remaining: formatCases(input.casesRemaining, lang),
          shortage: formatCases(projection.shortageByDeadline ?? 0, lang),
        }),
      };
    case 'atRisk': {
      const finish = projection.projectedCompletion;
      const finishText =
        finish === null
          ? t(lang, 'plan.insufficient')
          : formatDateTime(finish.date, finish.time, lang);
      const deadlineText = formatDateTime(input.targetCompletionDate!, targetTime, lang);
      return {
        status,
        text: t(lang, 'explanation.late', {
          total: formatCases(input.totalCases, lang),
          finish: finishText,
          overrun: formatSignedMultiDayDuration(-(projection.targetVarianceMinutes ?? 0)),
          deadline: deadlineText,
        }),
      };
    }
    case 'onTrack': {
      const finish = projection.projectedCompletion;
      const finishText =
        finish === null
          ? t(lang, 'plan.insufficient')
          : formatDateTime(finish.date, finish.time, lang);
      return {
        status,
        text: t(lang, 'explanation.feasible', {
          capacity: formatCases(projection.capacityByDeadline ?? 0, lang),
          total: formatCases(input.totalCases, lang),
          finish: finishText,
          buffer: formatSignedMultiDayDuration(projection.targetVarianceMinutes),
        }),
      };
    }
  }
}

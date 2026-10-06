import type { Language } from '../../types';
import { addDays, formatDate, parseDate } from '../dates/dates';
import { isBusinessDate } from '../dates/businessDays';
import { t } from '../../i18n';

/**
 * Business-day helpers. A business day is neither a weekend (Sat/Sun), a
 * Japanese public holiday, nor a date in the configurable extra-holiday list
 * from Settings.
 */

export function isBusinessDay(date: string, holidays: readonly string[]): boolean {
  return isBusinessDate(date, holidays);
}

/** Next business day strictly after `date` (skips weekends and holidays). */
export function nextBusinessDay(date: string, holidays: readonly string[]): string {
  const epoch = parseDate(date);
  if (epoch === null) return date;
  for (let i = 1; i <= 400; i++) {
    const candidate = formatDate(addDays(epoch, i));
    if (isBusinessDay(candidate, holidays)) return candidate;
  }
  return formatDate(addDays(epoch, 1));
}

/** Language-independent inputs for next-business-day suggestions. */
export interface NextDaySuggestionInput {
  projectName: string;
  remainingCases: number;
  /** Cases the deadline capacity cannot cover; null when no target date. */
  shortageByDeadline: number | null;
  nextBusinessDate: string;
  /** Testers scheduled on the next business day; null when not planned. */
  scheduledTesters: number | null;
}

/**
 * Suggested items for the Next Business Day section, rendered in the report
 * language. The supervisor can add/remove/reorder them freely.
 */
export function buildNextDaySuggestions(lang: Language, input: NextDaySuggestionInput): string[] {
  const suggestions: string[] = [];
  if (input.remainingCases > 0) {
    suggestions.push(t(lang, 'suggestion.continueWork', { project: input.projectName, remaining: input.remainingCases }));
  }
  if (input.shortageByDeadline !== null && input.shortageByDeadline > 0) {
    suggestions.push(t(lang, 'suggestion.capacityRisk', { shortage: input.shortageByDeadline }));
  }
  if (input.scheduledTesters !== null && input.scheduledTesters > 0) {
    suggestions.push(t(lang, 'suggestion.staffedDay', { project: input.projectName, testers: input.scheduledTesters }));
  }
  return suggestions;
}

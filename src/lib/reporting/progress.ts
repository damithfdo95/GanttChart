import type { ProgressDenominator, ProgressRules, ReportActivity } from '../../types';

/**
 * Progress calculations for report activities. Working and Complete use
 * independent, explicitly stored denominators — never assume they match.
 */

export interface ActivityProgress {
  /** Percentage 0–100, or null when the denominator is 0. */
  workingPct: number | null;
  workingCount: number;
  workingDenom: number;
  completePct: number | null;
  completeCount: number;
  completeDenom: number;
}

export const DEFAULT_PROGRESS_RULES: ProgressRules = { working: 'workingEligibleCases', complete: 'totalCases' };

function denominator(activity: ReportActivity, basis: ProgressDenominator): number {
  return basis === 'totalCases' ? activity.totalCases : activity.workingEligibleCases;
}

function pct(count: number, denom: number): number | null {
  return denom > 0 ? (count / denom) * 100 : null;
}

export function calculateActivityProgress(activity: ReportActivity, rules: ProgressRules): ActivityProgress {
  const workingDenom = denominator(activity, rules.working);
  const completeDenom = denominator(activity, rules.complete);
  return {
    workingPct: pct(activity.startedCases, workingDenom),
    workingCount: activity.startedCases,
    workingDenom,
    completePct: pct(activity.completedCases, completeDenom),
    completeCount: activity.completedCases,
    completeDenom,
  };
}

/** Fixed two-decimal percentage text ("86.49"); null → "—". */
export function formatPercent(value: number | null): string {
  return value === null ? '—' : value.toFixed(2);
}

/** Percent as a 0–1 ratio for XLSX percentage cells; null when undefined. */
export function percentRatio(value: number | null): number | null {
  return value === null ? null : value / 100;
}

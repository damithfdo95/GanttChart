import type { BlockingCategory, BlockingEvent } from '../../types';
import { BLOCKING_CATEGORIES } from '../../types';

/**
 * Level 2 §5: QA blocking / lost-time analysis. All existing calculation
 * semantics elsewhere are untouched — these are additive functions. The
 * classic engine keeps using gross productive elapsed time; the metrics
 * below expose the QA-specific effective view.
 */

/** Total unavailable minutes; optionally restricted to one date (YYYY-MM-DD). */
export function sumBlockingMinutes(events: readonly BlockingEvent[], date?: string): number {
  let total = 0;
  for (const event of events) {
    if (date === undefined || event.date === date) total += Math.max(0, event.minutes);
  }
  return total;
}

/** Unavailable minutes per category (same optional date scope). */
export function sumBlockingMinutesByCategory(
  events: readonly BlockingEvent[],
  date?: string,
): Record<BlockingCategory, number> {
  const result = Object.fromEntries(BLOCKING_CATEGORIES.map((c) => [c, 0])) as Record<BlockingCategory, number>;
  for (const event of events) {
    if (date === undefined || event.date === date) result[event.category] += Math.max(0, event.minutes);
  }
  return result;
}

/**
 * Effective QA time: gross productive elapsed minus unavailable time,
 * clamped so it can never go negative.
 */
export function calculateEffectiveElapsedMinutes(productiveElapsedMinutes: number, unavailableMinutes: number): number {
  if (productiveElapsedMinutes <= 0) return 0;
  return Math.max(0, productiveElapsedMinutes - Math.max(0, unavailableMinutes));
}

/** Cases the team could have processed during the unavailable time. */
export function calculateLostCapacityCases(unavailableMinutes: number, teamCapacityPerHour: number): number {
  if (unavailableMinutes <= 0 || teamCapacityPerHour <= 0) return 0;
  return (unavailableMinutes / 60) * teamCapacityPerHour;
}

/** Cases the team can still process in the effective (unblocked) time available. */
export function calculateAvailableCapacityCases(effectiveMinutes: number, teamCapacityPerHour: number): number {
  if (effectiveMinutes <= 0 || teamCapacityPerHour <= 0) return 0;
  return (effectiveMinutes / 60) * teamCapacityPerHour;
}

/**
 * Tester utilization: the share of productive elapsed time during which QA
 * was actually able to work (1 = fully available, 0 = fully blocked).
 * Null while no time has elapsed.
 */
export function calculateTesterUtilization(productiveElapsedMinutes: number, unavailableMinutes: number): number | null {
  if (productiveElapsedMinutes <= 0) return null;
  const unavailable = Math.min(Math.max(0, unavailableMinutes), productiveElapsedMinutes);
  return (productiveElapsedMinutes - unavailable) / productiveElapsedMinutes;
}

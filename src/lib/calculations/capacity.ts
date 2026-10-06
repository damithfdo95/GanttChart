import type { LunchWindow, MinutesOfDay } from '../../types';

/**
 * Team hourly capacity: testers × cases per hour per tester (§10).
 * Example: 8 testers × 4 cases/h = 32 cases/h.
 */
export function calculateTeamCapacity(testers: number, perHourPerTester: number): number {
  return testers * perHourPerTester;
}

/** Overlap in minutes between half-open intervals [aStart, aEnd) and [bStart, bEnd). */
export function overlapMinutes(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/** Minutes of lunch that fall inside the window [windowStart, windowEnd). */
export function lunchOverlapMinutes(windowStart: MinutesOfDay, windowEnd: MinutesOfDay, lunch: LunchWindow): number {
  return overlapMinutes(windowStart, windowEnd, lunch.start, lunch.end);
}

/**
 * Productive (working) hours between two clock times, minus any lunch overlap
 * (§10). Returns fractional hours; 0 when end <= start.
 * Example: 09:00–17:30 with 12:00–13:00 lunch → 7.5h.
 */
export function calculateProductiveHours(start: MinutesOfDay, end: MinutesOfDay, lunch: LunchWindow): number {
  if (end <= start) return 0;
  return (end - start - lunchOverlapMinutes(start, end, lunch)) / 60;
}

/**
 * Pure execution hours needed: totalCases / teamCapacityPerHour (§12).
 * Returns null when capacity is not positive (division would be undefined).
 * Example: 36 / 32 = 1.125 hours.
 */
export function calculateRequiredHours(totalCases: number, teamCapacityPerHour: number): number | null {
  if (teamCapacityPerHour <= 0 || totalCases < 0) return null;
  return totalCases / teamCapacityPerHour;
}

/**
 * Minimum testers to finish totalCases within productiveHours (§11):
 * ceil(totalCases / (perHourPerTester × productiveHours)).
 * Returns null when the window cannot fit any work at all.
 * Example: 36 / (4 × 4) = 2.25 → 3 testers.
 */
export function calculateRequiredTesters(totalCases: number, perHourPerTester: number, productiveHours: number): number | null {
  const throughputPerTester = perHourPerTester * productiveHours;
  if (throughputPerTester <= 0) return null;
  return Math.ceil(totalCases / throughputPerTester);
}

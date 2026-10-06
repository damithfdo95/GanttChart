import type { LunchWindow, MinutesOfDay, QaInputs, ScheduleStatus } from '../../types';
import { calculateTeamCapacity, lunchOverlapMinutes } from './capacity';
import { WORK_LUNCH } from './workday';

/**
 * Advance `durationMinutes` of productive work from `from`, skipping any lunch
 * time encountered (single-day model: lunch applies at most once).
 * Fractional minutes are preserved; display formatting floors to whole minutes.
 */
export function advanceThroughLunch(from: MinutesOfDay, durationMinutes: number, lunch: LunchWindow): number {
  if (durationMinutes <= 0) return from;
  let position = from;
  let remaining = durationMinutes;
  if (position < lunch.start) {
    const beforeLunch = lunch.start - position;
    const used = Math.min(beforeLunch, remaining);
    position += used;
    remaining -= used;
  }
  if (remaining > 0 && position >= lunch.start && position < lunch.end) {
    position = lunch.end;
  }
  return position + remaining;
}

/**
 * Expected finish clock time (§13): start advanced by the required productive
 * execution minutes, skipping lunch.
 * Example: 13:00 + 1.125h → 14:07:30 (displayed floored as 14:07).
 */
export function calculateExpectedFinish(start: MinutesOfDay, requiredMinutes: number, lunch: LunchWindow): number {
  return advanceThroughLunch(start, requiredMinutes, lunch);
}

/** Buffer in minutes: positive = slack before target, negative = overrun (§17). */
export function calculateBuffer(expectedFinish: MinutesOfDay, targetFinish: MinutesOfDay): number {
  return targetFinish - expectedFinish;
}

/**
 * Productive minutes elapsed since start, excluding any lunch overlap (§14–§15).
 * Returns 0 before start.
 */
export function calculateProductiveElapsedTime(now: MinutesOfDay, start: MinutesOfDay, lunch: LunchWindow): number {
  if (now <= start) return 0;
  return now - start - lunchOverlapMinutes(start, now, lunch);
}

/**
 * Cases that should be completed by now, given team capacity and the
 * productive hours elapsed so far. Capped at totalCases.
 */
export function calculateExpectedProgress(totalCases: number, capacityPerHour: number, productiveElapsedHours: number): number {
  if (totalCases <= 0) return 0;
  return Math.max(0, Math.min(totalCases, capacityPerHour * productiveElapsedHours));
}

/**
 * Schedule status (§16). The whole calculation uses the workday model: each
 * day runs from the per-project Plan Start Time (inputs.startTime, default
 * 9:00) to the fixed 17:30 end with the 12:00–13:00 lunch.
 * - COMPLETED has priority when casesCompleted >= totalCases (or nothing to do).
 * - NOT_STARTED before start with no progress.
 * - `deadlineBufferMinutes` (from the multi-day capacity projection:
 *   deadline minus the planned finish) makes the verdict deadline-dominant —
 *   DELAYED only when the deadline is genuinely at risk (buffer < 0),
 *   matching the card's Buffer/Delay fact and the projection's "overtime
 *   required" result. When the deadline is safe (buffer >= 0), the pace
 *   comparison refines AHEAD vs ON_SCHEDULE only — being behind today's
 *   expected pace is NOT a red "Delayed" while the overall capacity still
 *   finishes before the deadline (the pace evidence stays visible in the
 *   "Why this status?" explanation). Without a deadline projection
 *   (undefined/null, e.g. no deadline set), the pace comparison decides.
 * - The pace comparison itself: actual progress vs expected progress with a
 *   tolerance of ~5 minutes of team throughput (min 1 case) so that rounding
 *   does not make the status flicker between states.
 *
 * V7: an optional `window` (today's effective start/lunch — from today's
 * execution entry or the day's planned window) overrides the project
 * defaults for the pace comparison.
 */
export function calculateScheduleStatus(
  inputs: QaInputs,
  now: MinutesOfDay,
  window?: { start: MinutesOfDay; lunch: LunchWindow },
  deadlineBufferMinutes?: number | null,
): ScheduleStatus {
  const { totalCases, casesCompleted } = inputs;
  const startTime = window?.start ?? inputs.startTime;
  if (totalCases <= 0) return 'COMPLETED';
  if (casesCompleted >= totalCases) return 'COMPLETED';
  if (now < startTime && casesCompleted === 0) return 'NOT_STARTED';

  const lunch: LunchWindow = window?.lunch ?? WORK_LUNCH;
  const capacityPerHour = calculateTeamCapacity(inputs.currentTesters, inputs.perHourPerTester);
  const elapsedHours = calculateProductiveElapsedTime(now, startTime, lunch) / 60;
  const expected = calculateExpectedProgress(totalCases, capacityPerHour, elapsedHours);

  const tolerance = Math.max(1, capacityPerHour * (5 / 60));
  if (deadlineBufferMinutes !== undefined && deadlineBufferMinutes !== null) {
    if (deadlineBufferMinutes < 0) return 'DELAYED';
    return casesCompleted > expected + tolerance ? 'AHEAD' : 'ON_SCHEDULE';
  }
  if (casesCompleted > expected + tolerance) return 'AHEAD';
  if (casesCompleted < expected - tolerance) return 'DELAYED';
  return 'ON_SCHEDULE';
}

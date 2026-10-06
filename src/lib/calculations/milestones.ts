import type { Milestone } from '../../types';
import { DEFAULT_TIME_ZONE, parseDate } from '../dates/dates';
import { parseTimeToMinutes } from '../formatting/format';

/**
 * Level 2 §7: milestone tracking. Reach detection is automatic, idempotent
 * and pure — evaluateMilestones receives the current progress percentages
 * and a now-ISO string, and stamps actualAt exactly once per milestone.
 */

export type MilestoneStatus = 'PENDING' | 'REACHED' | 'OVERDUE';

/**
 * Stamp actualAt on every milestone whose target percentage has just been
 * reached (execute or pass, by milestone type). Returns the SAME array
 * reference when nothing changed so React effects and memoized callers
 * stay stable (no infinite update loops).
 */
export function evaluateMilestones(
  milestones: Milestone[],
  executePct: number | null,
  passPct: number | null,
  nowIso: string,
): Milestone[] {
  let changed = false;
  const next = milestones.map((milestone) => {
    if (milestone.actualAt !== null) return milestone;
    const pct = milestone.type === 'EXECUTE' ? executePct : passPct;
    if (pct !== null && pct >= milestone.targetPct) {
      changed = true;
      return { ...milestone, actualAt: nowIso };
    }
    return milestone;
  });
  return changed ? next : milestones;
}

/** Absolute minutes (epoch-days × 1440 + minutes-of-day) of a milestone's planned point; null when unset or malformed. */
export function milestonePlannedMinutes(milestone: Milestone): number | null {
  if (milestone.plannedDate === null) return null;
  const days = parseDate(milestone.plannedDate);
  if (days === null) return null;
  const time = milestone.plannedTime === null ? 0 : parseTimeToMinutes(milestone.plannedTime);
  if (time === null) return null;
  return days * 1440 + time;
}

/**
 * Convert an ISO timestamp into absolute minutes in the application's
 * default timezone (Asia/Tokyo) using built-in Intl — deterministic for a
 * given string, fully offline. Null when the string cannot be parsed.
 */
export function isoToAbsoluteMinutes(iso: string): number | null {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: DEFAULT_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(parsed);
    const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
    const days = parseDate(`${get('year')}-${get('month')}-${get('day')}`);
    const hour = Number(get('hour')) % 24;
    const minute = Number(get('minute'));
    if (days === null || Number.isNaN(hour) || Number.isNaN(minute)) return null;
    return days * 1440 + hour * 60 + minute;
  } catch {
    return null;
  }
}

/** Milestone variance in minutes: actual − planned (negative = reached early). Null when either side is unknown. */
export function milestoneVarianceMinutes(milestone: Milestone): number | null {
  if (milestone.actualAt === null) return null;
  const planned = milestonePlannedMinutes(milestone);
  const actual = isoToAbsoluteMinutes(milestone.actualAt);
  if (planned === null || actual === null) return null;
  return actual - planned;
}

/**
 * Milestone status: REACHED when actualAt is stamped; OVERDUE when the
 * planned point has passed without being reached; otherwise PENDING.
 * `nowAbsoluteMinutes` is epoch-days × 1440 + minutes-of-day (UI boundary).
 */
export function milestoneStatus(milestone: Milestone, nowAbsoluteMinutes: number): MilestoneStatus {
  if (milestone.actualAt !== null) return 'REACHED';
  const planned = milestonePlannedMinutes(milestone);
  if (planned !== null && nowAbsoluteMinutes > planned) return 'OVERDUE';
  return 'PENDING';
}

import type { LunchWindow, MinutesOfDay, PlanningRow, QaInputs } from '../../types';
import { parseDate } from '../dates/dates';
import { isNonWorkingCalendarDay, isNonWorkingDate, nextBusinessDayEpoch } from '../dates/businessDays';
import { calculateProductiveHours, calculateTeamCapacity } from './capacity';
import { advanceThroughLunch } from './schedule';

/**
 * Fixed workday model (user spec): every day works 09:00–17:30 with a 1-hour
 * lunch break 12:00–13:00. The workday START is the per-project Plan Start
 * Time (persisted as QaInputs.startTime, default 9:00): a later start
 * shrinks that day's productive hours, while the end (17:30) and the lunch
 * (12:00–13:00) stay fixed.
 *
 * DAILY OVERTIME (optional, per project): every day's window is extended
 * past 17:30 by QaInputs.dailyOvertimeMinutes (0–180, fixed daily value,
 * including the current day). Deadline/buffer comparisons stay at 17:30 —
 * overtime shows up as a reduced delay, never as a moved deadline.
 *
 * V7 PER-DAY WINDOW OVERRIDES: each planning row may override its own start
 * time, end time, overtime and whether the lunch interval is taken
 * (intervalEnabled). Row fields win over the project defaults; days without
 * a row (implicit anchor day, fallback continuation) always use the
 * project defaults. Interval = no means the 12:00–13:00 lunch is NOT
 * deducted — the whole window is productive.
 */

/** Default plan start: 09:00. */
export const WORK_DAY_START: MinutesOfDay = 9 * 60;
/** Work end: 17:30. */
export const WORK_DAY_END: MinutesOfDay = 17 * 60 + 30;
/** Lunch break: 12:00–13:00. */
export const WORK_LUNCH: LunchWindow = { start: 12 * 60, end: 13 * 60 };
/** Zero-length lunch used when the interval is not taken. */
export const NO_LUNCH: LunchWindow = { start: 0, end: 0 };
/** Productive minutes for the default 9:00 start: 8.5h span − 1h lunch = 7.5h. */
export const WORK_MINUTES_PER_DAY = WORK_DAY_END - WORK_DAY_START - (WORK_LUNCH.end - WORK_LUNCH.start);
/** Productive hours for the default 9:00 start: 7.5. */
export const WORK_PRODUCTIVE_HOURS = WORK_MINUTES_PER_DAY / 60;
/** Maximum accepted daily overtime (minutes). */
export const MAX_DAILY_OVERTIME_MINUTES = 180;
/**
 * Exact projection horizon (≈10 years of business days). Beyond it the
 * overflow walk jumps whole weeks (5 business days = 7 calendar days,
 * holidays ignored) instead of stepping day by day, so absurd inputs (e.g. a
 * mistyped extra zero) cannot freeze the UI. The finish stays far past any
 * deadline, so buffers and statuses are unchanged in sign.
 */
export const EXACT_PROJECTION_BUSINESS_DAYS = 2600;
/**
 * Beyond this (≈190,000 years, ~70M calendar days) no finish is returned —
 * dates would approach the Date range limit (±100M days from 1970).
 */
export const MAX_PROJECTION_BUSINESS_DAYS = 50_000_000;

/**
 * Consume whole business days after `epoch` until at most one day of work
 * remains. Exact for the first EXACT_PROJECTION_BUSINESS_DAYS, then a single
 * week-granular jump (approximation only for finishes ~10+ years out).
 */
function consumeBusinessDays(epoch: number, remaining: number, dayMinutes: number): { epoch: number; remaining: number } {
  let steps = 0;
  let jumped = false;
  while (remaining > dayMinutes) {
    if (!jumped && steps >= EXACT_PROJECTION_BUSINESS_DAYS) {
      jumped = true;
      const weeks = Math.floor((Math.ceil(remaining / dayMinutes) - 1) / 5);
      epoch += weeks * 7;
      remaining -= weeks * 5 * dayMinutes;
      if (isNonWorkingCalendarDay(epoch)) epoch = nextBusinessDayEpoch(epoch);
      continue;
    }
    remaining -= dayMinutes;
    epoch = nextBusinessDayEpoch(epoch);
    steps += 1;
  }
  return { epoch, remaining };
}

/** Clamp an overtime value to a safe 0–180 integer; 0 for anything invalid. */
export function clampOvertimeMinutes(overtimeMinutes: number | null | undefined): number {
  if (overtimeMinutes === null || overtimeMinutes === undefined || !Number.isFinite(overtimeMinutes)) return 0;
  return Math.min(MAX_DAILY_OVERTIME_MINUTES, Math.max(0, Math.round(overtimeMinutes)));
}

/** The lunch window actually applied on a day: the fixed interval or none. */
export function lunchForInterval(intervalEnabled: boolean): LunchWindow {
  return intervalEnabled ? WORK_LUNCH : NO_LUNCH;
}

/**
 * One day's effective work window (V7): start, end (already including
 * overtime) and the lunch window actually applied on that day.
 */
export interface DayWindow {
  start: MinutesOfDay;
  end: MinutesOfDay;
  lunch: LunchWindow;
}

/** Per-day windows keyed by UTC epoch day, plus the default for unlisted days. */
export interface DayWindowsContext {
  byDay: ReadonlyMap<number, DayWindow>;
  default: DayWindow;
}

/** Project-level window defaults derived from the canonical inputs. */
export function projectDayWindowDefaults(
  inputs: Pick<QaInputs, 'startTime' | 'dailyOvertimeMinutes' | 'intervalEnabled'>,
): DayWindow {
  return {
    start: inputs.startTime,
    end: WORK_DAY_END + clampOvertimeMinutes(inputs.dailyOvertimeMinutes),
    lunch: lunchForInterval(inputs.intervalEnabled ?? true),
  };
}

/** A row (or any day-shaped object) with optional V7 window overrides. */
export type DayWindowOverrideCarrier = Pick<PlanningRow, 'startTime' | 'endTime' | 'overtimeMinutes' | 'intervalEnabled'>;

/**
 * The effective window of one day: row overrides win, project defaults fill
 * the gaps. Row end = (row.endTime ?? 17:30) + (row OT ?? project OT), so
 * "End 17:30 + OT 60" means an 18:30 window end as expected.
 */
export function rowDayWindow(row: DayWindowOverrideCarrier, defaults: DayWindow): DayWindow {
  const overtime = clampOvertimeMinutes(row.overtimeMinutes ?? (defaults.end - WORK_DAY_END));
  return {
    start: row.startTime ?? defaults.start,
    end: (row.endTime ?? WORK_DAY_END) + overtime,
    // Value-based interval check: any non-empty default lunch means the
    // interval applies (a custom lunch object must behave like WORK_LUNCH).
    lunch: lunchForInterval(row.intervalEnabled ?? defaults.lunch.end > defaults.lunch.start),
  };
}

/** Build the per-day window context from planning rows + project defaults. */
export function dayWindowsFromRows(rows: readonly PlanningRow[], defaults: DayWindow): DayWindowsContext {
  const byDay = new Map<number, DayWindow>();
  for (const row of rows) {
    const epoch = parseDate(row.date);
    if (epoch === null) continue;
    byDay.set(epoch, rowDayWindow(row, defaults));
  }
  return { byDay, default: defaults };
}

/** The window of a day inside a context (default for unlisted days). */
export function windowForDay(ctx: DayWindowsContext, epochDay: number): DayWindow {
  return ctx.byDay.get(epochDay) ?? ctx.default;
}

/**
 * Productive hours in one workday starting at `workStart` (end 17:30 +
 * overtime, lunch fixed 12:00–13:00). Example: 10:00 start → 6.5h (+OT).
 */
export function workdayProductiveHours(workStart: MinutesOfDay, overtimeMinutes: number | null | undefined = 0): number {
  const dayEnd = WORK_DAY_END + clampOvertimeMinutes(overtimeMinutes);
  return calculateProductiveHours(workStart, dayEnd, WORK_LUNCH);
}

/** Productive hours of one explicit day window (V7). */
export function dayWindowProductiveHours(window: DayWindow): number {
  return calculateProductiveHours(window.start, window.end, window.lunch);
}

/** A finish point on the calendar: date (UTC epoch day) + minutes of day. */
export interface WorkdayFinish {
  epochDay: number;
  time: MinutesOfDay;
}

/**
 * Ordered epoch days of the working planning rows dated on/after startDate.
 * A row contributes nothing when its own flag marks it non-working OR when
 * it falls on a Saturday, Sunday or Japanese public holiday. Sorted
 * ascending; duplicates kept.
 */
export function workingEpochDays(rows: PlanningRow[], startDate: string): number[] {
  const start = parseDate(startDate);
  const days: number[] = [];
  for (const row of rows) {
    if (row.nonWorkingDay || isNonWorkingDate(row.date)) continue;
    const d = parseDate(row.date);
    if (d === null) continue;
    if (start !== null && d < start) continue;
    days.push(d);
  }
  days.sort((a, b) => a - b);
  return days;
}

/**
 * Anchor for a from-now projection: the current date (UTC epoch day) and
 * clock time. The expected finish is computed from this point on — the
 * anchor day itself contributes only its remaining productive time.
 */
export interface WorkdayAnchor {
  epochDay: number;
  timeOfDay: MinutesOfDay;
}

/**
 * Epoch days that HAVE a planning row but contribute nothing (the row's own
 * non-working flag; calendar non-working days are handled separately). Used
 * to keep an explicitly-flagged off day off even when it is the anchor day.
 */
export function excludedEpochDays(rows: PlanningRow[]): number[] {
  const days: number[] = [];
  for (const row of rows) {
    if (!row.nonWorkingDay) continue;
    const d = parseDate(row.date);
    if (d !== null) days.push(d);
  }
  return days;
}

/**
 * Advance `requiredMinutes` of productive work across consecutive working
 * days (each day's productive capacity computed from `workStart` and the
 * daily overtime — the window ends at 17:30+OT), starting at `workStart` on
 * the first working day and skipping lunch intraday.
 *
 * V7: when `dayWindows` is supplied, each listed day uses its OWN effective
 * window (start/end+OT/interval from the planning row), and every other day
 * (implicit anchor day, fallback continuation) uses ctx.default. Without a
 * context every day uses the scalar workStart/overtime/WORK_LUNCH model —
 * byte-for-byte the previous behavior.
 *
 * With an `anchor` (the current moment): only working days on or after the
 * anchor count, the anchor day contributes only its remaining productive
 * time (clamped to the work window, OT included) — INCLUDING when the anchor
 * day is a business day without a planning row (an implicit working day, so
 * today's remaining time is never silently dropped). An anchor day listed in
 * `offDays` (explicitly flagged non-working) or on a weekend/Japanese
 * holiday never produces work. Without an anchor the walk starts at the
 * first listed working day (schedule view, e.g. the new-project preview).
 *
 * When the listed working days are exhausted, work continues on consecutive
 * BUSINESS days after the last working day (weekends and Japanese public
 * holidays are skipped). Returns null when work remains but no working day
 * exists.
 */
export function advanceOverWorkDays(
  requiredMinutes: number,
  workingDays: number[],
  fallbackStart: string,
  workStart: MinutesOfDay = WORK_DAY_START,
  anchor?: WorkdayAnchor,
  overtimeMinutes: number | null | undefined = 0,
  offDays: readonly number[] = [],
  dayWindows?: DayWindowsContext,
): WorkdayFinish | null {
  if (!Number.isFinite(requiredMinutes) || requiredMinutes < 0) return null;
  const defaultWindow: DayWindow =
    dayWindows !== undefined
      ? dayWindows.default
      : { start: workStart, end: WORK_DAY_END + clampOvertimeMinutes(overtimeMinutes), lunch: WORK_LUNCH };
  const windowOf = (day: number): DayWindow => (dayWindows !== undefined ? windowForDay(dayWindows, day) : defaultWindow);
  const dayMinutes = dayWindowProductiveHours(defaultWindow) * 60;
  if (dayMinutes <= 0) return null;
  if (requiredMinutes === 0) {
    if (anchor !== undefined) return { epochDay: anchor.epochDay, time: anchor.timeOfDay };
    const fallback = parseDate(fallbackStart);
    if (fallback === null) return null;
    return { epochDay: fallback, time: defaultWindow.start };
  }
  if (workingDays.length === 0 && anchor === undefined) return null;
  const anchorDay = anchor === undefined ? Number.NEGATIVE_INFINITY : anchor.epochDay;
  const upcoming = workingDays.filter((day) => day >= anchorDay);
  // Implicit anchor day: a business day that is not listed as a planning row
  // still counts with its remaining window — the team is working today. A
  // day explicitly flagged non-working (offDays) stays off.
  const anchorImplicit =
    anchor !== undefined &&
    anchor.epochDay !== upcoming[0] &&
    !isNonWorkingCalendarDay(anchor.epochDay) &&
    !offDays.includes(anchor.epochDay);
  const days = anchorImplicit ? [anchor.epochDay, ...upcoming] : upcoming;
  let remaining = requiredMinutes;
  if (days.length > 0) {
    let last = days[0];
    for (const day of days) {
      last = day;
      const win = windowOf(day);
      // On the anchor day only the time from the anchor (clamped into the
      // work window) is still available.
      const from =
        anchor !== undefined && day === anchor.epochDay
          ? Math.min(win.end, Math.max(anchor.timeOfDay, win.start))
          : win.start;
      const capacity = from >= win.end ? 0 : calculateProductiveHours(from, win.end, win.lunch) * 60;
      if (remaining <= capacity) {
        return { epochDay: day, time: advanceThroughLunch(from, remaining, win.lunch) };
      }
      remaining -= capacity;
    }
    // The working days are all fully consumed — continue on consecutive
    // business days after the last one.
    if (remaining / dayMinutes > MAX_PROJECTION_BUSINESS_DAYS) return null;
    const rest = consumeBusinessDays(nextBusinessDayEpoch(last), remaining, dayMinutes);
    return { epochDay: rest.epoch, time: advanceThroughLunch(defaultWindow.start, rest.remaining, defaultWindow.lunch) };
  }
  // No working day remains from the anchor on — continue on consecutive
  // business days from the day after the later of (last listed working day,
  // anchor). This branch is only reached when the anchor falls on a
  // non-working calendar day (weekend/Japanese holiday) or there is no
  // anchor and no listed days at all — an anchor on a business day always
  // enters the implicit-day path above, so it never produces weekend work.
  const last = workingDays.length > 0 ? workingDays[workingDays.length - 1] : anchorDay;
  if (remaining / dayMinutes > MAX_PROJECTION_BUSINESS_DAYS) return null;
  const rest = consumeBusinessDays(nextBusinessDayEpoch(Math.max(last, anchorDay)), remaining, dayMinutes);
  return { epochDay: rest.epoch, time: advanceThroughLunch(defaultWindow.start, rest.remaining, defaultWindow.lunch) };
}

/** Raw inputs for the date-based projection. */
export interface WorkdayProjectionInput {
  totalCases: number;
  /** Completed cases — the projection covers the REMAINING work (default 0). */
  casesCompleted?: number;
  currentTesters: number;
  perHourPerTester: number;
  planningRows: PlanningRow[];
  startDate: string;
  endDate: string | null;
  /** Plan Start Time as minutes of day; defaults to the fixed 9:00. */
  planStartTime?: MinutesOfDay;
  /** "Now" anchor: the expected finish is computed from this point on (default: the plan start). */
  anchor?: WorkdayAnchor | null;
  /** Fixed daily overtime minutes; every day runs to 17:30 + overtime (default 0). */
  dailyOvertimeMinutes?: number | null;
  /**
   * V7 per-day windows (planning-row overrides). When supplied, each listed
   * day contributes its own effective window; unlisted days (implicit anchor
   * day) and the fallback continuation use ctx.default. Without it every day
   * uses the uniform scalar window (previous behavior).
   */
  dayWindows?: DayWindowsContext;
}

/** Composed projection result (all derived, never persisted). */
export interface WorkdayProjectionResult {
  /** Working days between the anchor (or plan start) and endDate inclusive; null when no valid end date. */
  workingDaysToTarget: number | null;
  /** Productive hours in that window (today counts only its remaining time when anchored); null when no valid end date. */
  productiveHours: number | null;
  /** Execution minutes needed for the REMAINING cases; null when capacity is not positive. */
  requiredMinutes: number | null;
  /** Expected finish (date + time) of the remaining work, walking one workday at a time from the anchor. */
  expectedFinish: WorkdayFinish | null;
  /** Buffer vs the end date at 17:30; positive = slack, negative = overrun; null when not comparable. */
  bufferMinutes: number | null;
  /** Minimum testers to finish the remaining work within the window; null when not computable. */
  requiredTesters: number | null;
}

/**
 * Compose the whole date-based projection of the REMAINING work: every day
 * contributes its effective window's productive hours (per-day overrides
 * via dayWindows, otherwise workdayProductiveHours(planStartTime, overtime))
 * between the anchor (or plan start) and the end, and non-working planning
 * rows contribute nothing. Anchored projections never finish in the past.
 * The BUFFER is always measured against the deadline at 17:30 (not 17:30+OT):
 * overtime shows as reduced delay, never as a moved deadline.
 */
export function calculateWorkdayProjection(input: WorkdayProjectionInput): WorkdayProjectionResult {
  const planStart = input.planStartTime ?? WORK_DAY_START;
  const ot = clampOvertimeMinutes(input.dailyOvertimeMinutes);
  const dayEnd = WORK_DAY_END + ot;
  const perDayHours = workdayProductiveHours(planStart, ot);
  const anchor = input.anchor ?? null;
  const anchorDay = anchor === null ? null : anchor.epochDay;
  const remainingCases = Math.max(0, input.totalCases - (input.casesCompleted ?? 0));
  const workingDays = workingEpochDays(input.planningRows, input.startDate);
  const offDays = excludedEpochDays(input.planningRows);
  const end = input.endDate === null ? null : parseDate(input.endDate);

  // Window [anchor-or-plan-start, end]: the anchor day counts only while it
  // still has work time left (before its effective window end). Like the walk
  // in advanceOverWorkDays, a business-day anchor without a planning row is
  // included implicitly so today's remaining time is never dropped — unless
  // its row is explicitly flagged non-working.
  const anchorImplicit =
    anchor !== null &&
    anchorDay !== null &&
    !workingDays.includes(anchorDay) &&
    !isNonWorkingCalendarDay(anchorDay) &&
    !offDays.includes(anchorDay);
  const anchorWindowEnd =
    anchor !== null && anchorDay !== null && input.dayWindows !== undefined
      ? windowForDay(input.dayWindows, anchorDay).end
      : dayEnd;
  const listedWindow =
    end === null
      ? null
      : workingDays.filter(
          (d) =>
            d <= end &&
            (anchorDay === null || d > anchorDay || (d === anchorDay && anchor!.timeOfDay < anchorWindowEnd)),
        );
  const windowDays =
    end === null ? null : anchorImplicit && anchorDay <= end ? [anchorDay!, ...listedWindow!] : listedWindow;
  const workingDaysToTarget = windowDays === null ? null : windowDays.length;
  let productiveHours: number | null = null;
  if (windowDays !== null) {
    productiveHours = 0;
    for (const d of windowDays) {
      if (anchor !== null && d === anchorDay) {
        const from =
          input.dayWindows !== undefined
            ? Math.min(
                windowForDay(input.dayWindows, d).end,
                Math.max(anchor.timeOfDay, windowForDay(input.dayWindows, d).start),
              )
            : Math.min(dayEnd, Math.max(anchor.timeOfDay, planStart));
        productiveHours += calculateProductiveHours(
          from,
          input.dayWindows !== undefined ? windowForDay(input.dayWindows, d).end : dayEnd,
          input.dayWindows !== undefined ? windowForDay(input.dayWindows, d).lunch : WORK_LUNCH,
        );
      } else {
        productiveHours += input.dayWindows !== undefined ? dayWindowProductiveHours(windowForDay(input.dayWindows, d)) : perDayHours;
      }
    }
  }

  const capacityPerHour = calculateTeamCapacity(input.currentTesters, input.perHourPerTester);
  const requiredMinutes =
    capacityPerHour > 0 && remainingCases >= 0 ? (remainingCases / capacityPerHour) * 60 : null;
  const defaultWindowHours = input.dayWindows !== undefined ? dayWindowProductiveHours(input.dayWindows.default) : perDayHours;
  const expectedFinish =
    requiredMinutes === null || defaultWindowHours <= 0
      ? null
      : advanceOverWorkDays(
          requiredMinutes,
          workingDays,
          input.startDate,
          planStart,
          anchor === null ? undefined : anchor,
          ot,
          offDays,
          input.dayWindows,
        );

  let bufferMinutes: number | null = null;
  if (expectedFinish !== null && end !== null) {
    bufferMinutes = end * 1440 + WORK_DAY_END - (expectedFinish.epochDay * 1440 + expectedFinish.time);
  }

  let requiredTesters: number | null = null;
  if (input.perHourPerTester > 0 && productiveHours !== null && productiveHours > 0) {
    requiredTesters =
      remainingCases <= 0 ? 0 : Math.ceil(remainingCases / (input.perHourPerTester * productiveHours));
  }

  return { workingDaysToTarget, productiveHours, requiredMinutes, expectedFinish, bufferMinutes, requiredTesters };
}

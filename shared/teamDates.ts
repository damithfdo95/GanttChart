/**
 * Team Management date semantics (TM-00 Phase 1).
 *
 * The Team Management records use HALF-OPEN intervals: an inclusive start
 * date and an EXCLUSIVE end date, with `undefined` meaning open-ended. This
 * differs from the older inclusive-end convention of `RcsMember` and
 * `TesterProjectAssignment`, so EVERY conversion between the two conventions
 * goes through this module — never hand-written. The UI always shows an
 * inclusive end (the last covered day); the stored value stays exclusive.
 *
 * Plain TypeScript with no dependencies: the same helpers run in the browser,
 * the Worker and both test suites.
 */

/** A real calendar date in "YYYY-MM-DD" form (no month 13, no 31 February). */
export function isTeamDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** The day BEFORE `date` ("YYYY-MM-DD"), the exclusive start of anything ending at `date`. */
export function dayBefore(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const ms = Date.UTC(y, m - 1, d - 1);
  return new Date(ms).toISOString().slice(0, 10);
}

/** The day AFTER `date` ("YYYY-MM-DD"), the exclusive end of anything covering `date` as its last day. */
export function dayAfter(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const ms = Date.UTC(y, m - 1, d + 1);
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The stored (exclusive) end for a period whose last covered day is
 * `inclusiveEnd`. `undefined` (open-ended) passes through unchanged.
 */
export function exclusiveEndOf(inclusiveEnd: string | undefined): string | undefined {
  return inclusiveEnd === undefined ? undefined : dayAfter(inclusiveEnd);
}

/**
 * The last covered day (inclusive, for display) of a period stored with an
 * exclusive `end`. `undefined` (open-ended) passes through unchanged.
 */
export function inclusiveEndOf(exclusiveEnd: string | undefined): string | undefined {
  return exclusiveEnd === undefined ? undefined : dayBefore(exclusiveEnd);
}

/** Is `date` inside the half-open period [start, end)? `end === undefined` means open-ended. */
export function coversDate(start: string, end: string | undefined, date: string): boolean {
  if (date < start) return false;
  return end === undefined || date < end;
}

/** Do the half-open periods [aStart, aEnd) and [bStart, bEnd) overlap? `undefined` end = open-ended. */
export function periodsOverlap(aStart: string, aEnd: string | undefined, bStart: string, bEnd: string | undefined): boolean {
  const aTo = aEnd ?? '9999-12-31';
  const bTo = bEnd ?? '9999-12-31';
  return aStart < bTo && bStart < aTo;
}

/**
 * The half-open intersection of two periods, or null when they do not
 * overlap. `undefined` end = open-ended; an open result end stays `undefined`.
 */
export function periodIntersection(
  aStart: string,
  aEnd: string | undefined,
  bStart: string,
  bEnd: string | undefined,
): { start: string; end: string | undefined } | null {
  if (!periodsOverlap(aStart, aEnd, bStart, bEnd)) return null;
  const start = aStart > bStart ? aStart : bStart;
  const aTo = aEnd ?? '9999-12-31';
  const bTo = bEnd ?? '9999-12-31';
  const to = aTo < bTo ? aTo : bTo;
  return { start, end: to === '9999-12-31' ? undefined : to };
}

/**
 * Convert an INCLUSIVE-end period (the older convention: `RcsMember`,
 * `TesterProjectAssignment`) to the half-open convention. `undefined` end
 * (open-ended) passes through unchanged.
 */
export function inclusiveToHalfOpen(start: string, inclusiveEnd: string | undefined): { start: string; end: string | undefined } {
  return { start, end: exclusiveEndOf(inclusiveEnd) };
}

/**
 * Convert a half-open period to the INCLUSIVE-end convention for display or
 * for writing the older record types. `undefined` end (open-ended) passes
 * through unchanged.
 */
export function halfOpenToInclusive(start: string, exclusiveEnd: string | undefined): { start: string; end: string | undefined } {
  return { start, end: inclusiveEndOf(exclusiveEnd) };
}

/**
 * The ONE place that says what "today" means for the QA team.
 *
 * Authorization must not depend on a browser clock or on the UTC date (Japan is 9 hours ahead of UTC, so for part of every day the
 * two differ). The server converts its own authoritative time into the business time zone and compares calendar dates. Every
 * "today" in a rule (a Tester's Today's Execution, an assignment's start/end) comes from here.
 *
 * Tenant-configurable time zones are future work: today every workspace uses the deployment's business time zone.
 */
export const BUSINESS_TIMEZONE = 'Asia/Tokyo';

const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

/** The calendar date (YYYY-MM-DD) in the business time zone at the given instant (default: now). */
export function businessDate(at: number | Date = Date.now()): string {
  const parts = formatter.formatToParts(at);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const clockFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** The business-time calendar date and minute of the day (0..1439) at an instant. Schedules are evaluated with this, never with the browser's zone. */
export function businessClock(at: number | Date = Date.now()): { date: string; minutes: number } {
  const parts = clockFormatter.formatToParts(at);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

/** The instant (ms) of a business-time calendar day and "HH:mm". The business zone (Asia/Tokyo) is UTC+9 all year, with no daylight saving. */
export function businessMomentMs(date: string, time: string): number {
  return Date.parse(`${date}T${time}:00+09:00`);
}

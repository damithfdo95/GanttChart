import { describe, expect, it } from 'vitest';
import {
  isBusinessDate,
  isJapanHoliday,
  isNonWorkingCalendarDay,
  isNonWorkingDate,
  isWeekend,
  japanHolidayDatesOf,
  nextBusinessDayEpoch,
} from '../lib/dates/businessDays';
import { formatDate, parseDate } from '../lib/dates/dates';
import { calculateCumulativeCapacityByDay } from '../lib/calculations/planning';
import { advanceOverWorkDays, workingEpochDays } from '../lib/calculations/workday';
import { isBusinessDay, nextBusinessDay } from '../lib/reporting/nextday';
import type { PlanningRow } from '../types';

function row(date: string, nonWorkingDay = false): PlanningRow {
  return { id: date, date, plannedTesters: 2, absentTesters: 0, nonWorkingDay, note: '' };
}

function epoch(date: string): number {
  return parseDate(date)!;
}

describe('Japanese public holidays', () => {
  it('computes the fixed-date and nth-Monday holidays of 2026', () => {
    expect(japanHolidayDatesOf(2026)).toEqual([
      '2026-01-01', // New Year's Day (Thu)
      '2026-01-12', // Coming of Age Day (2nd Mon)
      '2026-02-11', // Foundation Day
      '2026-02-23', // Emperor's Birthday
      '2026-03-20', // Vernal Equinox
      '2026-04-29', // Showa Day
      '2026-05-03', // Constitution Memorial Day
      '2026-05-04', // Greenery Day
      '2026-05-05', // Children's Day
      '2026-05-06', // Substitute holiday (May 3 falls on Sunday)
      '2026-07-20', // Marine Day (3rd Mon)
      '2026-08-11', // Mountain Day
      '2026-09-21', // Respect for the Aged Day (3rd Mon)
      '2026-09-22', // Sandwich day between Sep 21 and the autumnal equinox
      '2026-09-23', // Autumnal Equinox
      '2026-10-12', // Sports Day (2nd Mon)
      '2026-11-03', // Culture Day
      '2026-11-23', // Labour Thanksgiving Day
    ]);
  });

  it('computes the 2025 holidays including Sunday substitutes', () => {
    const holidays = japanHolidayDatesOf(2025);
    expect(holidays).toContain('2025-02-24'); // Feb 23 falls on Sunday → substitute
    expect(holidays).toContain('2025-05-06'); // May 4 (Sun) sandwiched by holidays → next weekday
    expect(holidays).toContain('2025-11-24'); // Nov 23 falls on Sunday → substitute
    expect(holidays).not.toContain('2025-09-22'); // regular Monday stays a working day
  });

  it('marks the equinoxes for 2024 and 2025 from the table', () => {
    expect(isJapanHoliday(epoch('2024-03-20'))).toBe(true);
    expect(isJapanHoliday(epoch('2024-09-22'))).toBe(true);
    expect(isJapanHoliday(epoch('2025-03-20'))).toBe(true);
    expect(isJapanHoliday(epoch('2025-09-23'))).toBe(true);
    expect(isJapanHoliday(epoch('2025-09-22'))).toBe(false);
  });

  it('recognizes weekends', () => {
    expect(isWeekend(epoch('2026-10-03'))).toBe(true); // Saturday
    expect(isWeekend(epoch('2026-10-04'))).toBe(true); // Sunday
    expect(isWeekend(epoch('2026-10-05'))).toBe(false); // Monday
  });
});

describe('business-day helpers', () => {
  it('combines weekends and Japanese holidays', () => {
    expect(isNonWorkingDate('2026-10-03')).toBe(true); // Sat
    expect(isNonWorkingDate('2026-10-04')).toBe(true); // Sun
    expect(isNonWorkingDate('2026-09-22')).toBe(true); // 国民の休日
    expect(isNonWorkingDate('2026-09-24')).toBe(false); // regular Thursday
    expect(isNonWorkingDate('not-a-date')).toBe(false);
  });

  it('returns the next business day, skipping weekends and holidays', () => {
    expect(formatDate(nextBusinessDayEpoch(epoch('2026-10-02')))).toBe('2026-10-05'); // Fri → Mon
    expect(formatDate(nextBusinessDayEpoch(epoch('2026-09-18')))).toBe('2026-09-24'); // Fri → over the Sep 21–23 holiday block
    expect(formatDate(nextBusinessDayEpoch(epoch('2026-09-21')))).toBe('2026-09-24'); // holiday → Thu
    expect(formatDate(nextBusinessDayEpoch(epoch('2026-10-05')))).toBe('2026-10-06'); // Mon → Tue
  });

  it('supports extra user holidays through isBusinessDate', () => {
    expect(isBusinessDate('2026-10-07', ['2026-10-07'])).toBe(false);
    expect(isBusinessDate('2026-10-07', [])).toBe(true);
    expect(isBusinessDate('2026-10-10', [])).toBe(false); // Saturday
  });

  it('reporting nextBusinessDay skips the September 2026 holiday block', () => {
    expect(nextBusinessDay('2026-09-18', [])).toBe('2026-09-24'); // Fri → Thu (21/22/23 are holidays)
    expect(nextBusinessDay('2026-10-02', [])).toBe('2026-10-05'); // Fri → Mon
    expect(isBusinessDay('2026-09-23', [])).toBe(false); // equinox
  });
});

describe('engine uses business days only', () => {
  it('workingEpochDays drops weekend and holiday rows', () => {
    // 2026-10-02 Fri, 10-03 Sat, 10-04 Sun, 10-05 Mon
    const days = workingEpochDays([row('2026-10-02'), row('2026-10-03'), row('2026-10-04'), row('2026-10-05')], '2026-10-02');
    expect(days).toEqual([epoch('2026-10-02'), epoch('2026-10-05')]);
  });

  it('capacity rows on weekends contribute zero capacity automatically', () => {
    const rows = calculateCumulativeCapacityByDay([row('2026-10-02'), row('2026-10-03'), row('2026-10-05')], 4, 7.5);
    expect(rows[0]).toMatchObject({ date: '2026-10-02', nonWorkingDay: false, dailyCapacity: 60 });
    expect(rows[1]).toMatchObject({ date: '2026-10-03', nonWorkingDay: true, effectiveTesters: 0, dailyCapacity: 0 });
    expect(rows[2]).toMatchObject({ date: '2026-10-05', nonWorkingDay: false, dailyCapacity: 60 });
    expect(rows[2].cumulativeCapacity).toBe(120);
  });

  it('advanceOverWorkDays lands the finish on the next business day (never a weekend)', () => {
    // One full day (7.5h) fits Friday; the overflow lands on Monday, not Saturday.
    const days = workingEpochDays([row('2026-10-02')], '2026-10-02');
    const finish = advanceOverWorkDays(7.5 * 60 + 60, days, '2026-10-02');
    expect(finish).toEqual({ epochDay: epoch('2026-10-05'), time: 10 * 60 }); // Monday 10:00
  });

  it('advanceOverWorkDays fallback skips whole weekends (Sat+Sun = 0 work)', () => {
    const days = workingEpochDays([row('2026-10-02')], '2026-10-02');
    // 4 full days of work after Friday → Mon, Tue, Wed; finish Wed at 17:30 (a full day).
    const finish = advanceOverWorkDays(4 * 7.5 * 60, days, '2026-10-02');
    expect(finish).toEqual({ epochDay: epoch('2026-10-07'), time: 17 * 60 + 30 });
  });

  it('a projection never finishes on the weekend without any listed rows after it', () => {
    const days = workingEpochDays([row('2026-10-01'), row('2026-10-02')], '2026-10-01');
    // 2.5 days of work over two listed days → half a day lands on Monday 13:45 (after lunch).
    const finish = advanceOverWorkDays(2.5 * 7.5 * 60, days, '2026-10-01');
    expect(finish).toEqual({ epochDay: epoch('2026-10-05'), time: 13 * 60 + 45 });
  });

  it('anchor on a holiday never produces work on that day', () => {
    const days = workingEpochDays([row('2026-10-01'), row('2026-10-02')], '2026-10-01');
    // Anchored Sunday 2026-10-04 at 10:00 with 1h of work → Monday 10:00.
    const finish = advanceOverWorkDays(60, days, '2026-10-01', 9 * 60, { epochDay: epoch('2026-10-04'), timeOfDay: 10 * 60 });
    expect(finish).toEqual({ epochDay: epoch('2026-10-05'), time: 10 * 60 });
  });

  it('a planning row on a Japanese holiday is treated as non-working even when flagged working', () => {
    const rows = calculateCumulativeCapacityByDay([row('2026-09-23')], 4, 7.5); // autumnal equinox
    expect(rows[0].nonWorkingDay).toBe(true);
    expect(rows[0].dailyCapacity).toBe(0);
  });

  it('isNonWorkingCalendarDay agrees with isNonWorkingDate', () => {
    for (const date of ['2026-01-01', '2026-05-06', '2026-09-22', '2026-10-03', '2026-10-07']) {
      expect(isNonWorkingCalendarDay(epoch(date))).toBe(isNonWorkingDate(date));
    }
  });
});

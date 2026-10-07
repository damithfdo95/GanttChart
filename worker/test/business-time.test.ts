import { describe, expect, it } from 'vitest';
import { BUSINESS_TIMEZONE, businessDate } from '../../shared/businessTime';
import { isToday } from '../../shared/testerRules';

/** "Today" is the calendar date in the business time zone (Asia/Tokyo, UTC+9, no daylight saving), from the server's own clock. */
describe('business date', () => {
  it('is Asia/Tokyo for now (tenant-configurable time zones are future work)', () => {
    expect(BUSINESS_TIMEZONE).toBe('Asia/Tokyo');
  });

  it('differs from the UTC date during the 9 hours before midnight UTC', () => {
    expect(businessDate(Date.parse('2026-10-07T14:59:59Z'))).toBe('2026-10-07'); // 23:59:59 JST
    expect(businessDate(Date.parse('2026-10-07T15:00:00Z'))).toBe('2026-10-08'); // 00:00:00 JST, next day, while UTC still says the 7th
    expect(businessDate(Date.parse('2026-10-07T00:00:00Z'))).toBe('2026-10-07'); // 09:00 JST
    expect(businessDate(Date.parse('2026-12-31T15:00:00Z'))).toBe('2027-01-01'); // year boundary
    expect(businessDate(Date.parse('2024-02-28T15:00:00Z'))).toBe('2024-02-29'); // leap day
  });

  it('drives the Tester rule at the midnight boundary: before midnight JST only that day, after it only the next', () => {
    const before = businessDate(Date.parse('2026-10-07T14:59:59Z'));
    const after = businessDate(Date.parse('2026-10-07T15:00:00Z'));
    expect(isToday('2026-10-07', before)).toBe(true);
    expect(isToday('2026-10-08', before)).toBe(false); // tomorrow, even though UTC midnight is hours away
    expect(isToday('2026-10-07', after)).toBe(false); // yesterday as soon as JST midnight passes
    expect(isToday('2026-10-08', after)).toBe(true);
  });

  it('a browser in another time zone cannot change it: the rule takes the server date only', () => {
    // 2026-10-07 16:00 UTC is already the 8th in Japan but still the 7th in UTC, London and New York.
    const server = businessDate(Date.parse('2026-10-07T16:00:00Z'));
    expect(server).toBe('2026-10-08');
    expect(isToday('2026-10-07', server)).toBe(false);
  });
});

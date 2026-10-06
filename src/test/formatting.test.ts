import { describe, expect, it } from 'vitest';
import {
  formatCases,
  formatClock,
  formatDuration,
  formatInteger,
  formatNumber,
  formatSignedDuration,
  formatSignedMultiDayDuration,
  minutesToTimeInput,
  parseTimeToMinutes,
} from '../lib/formatting/format';

describe('formatClock (§25, §30)', () => {
  it('formats minutes since midnight as HH:mm', () => {
    expect(formatClock(540)).toBe('09:00');
    expect(formatClock(847)).toBe('14:07');
  });

  it('floors fractional minutes conservatively: 14:07:30 → 14:07', () => {
    expect(formatClock(847.5)).toBe('14:07');
  });

  it('annotates values past midnight with (+Nd)', () => {
    expect(formatClock(1500)).toBe('01:00 (+1d)');
  });

  it('null and non-finite → em dash, never NaN/Invalid Date', () => {
    expect(formatClock(null)).toBe('—');
    expect(formatClock(Number.NaN)).toBe('—');
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatDuration (§30)', () => {
  it('formats as "42m"', () => {
    expect(formatDuration(42)).toBe('42m');
  });

  it('formats as "1h 08m"', () => {
    expect(formatDuration(68)).toBe('1h 08m');
  });

  it('formats as "2h 53m"', () => {
    expect(formatDuration(173)).toBe('2h 53m');
  });

  it('floors fractional minutes', () => {
    expect(formatDuration(67.5)).toBe('1h 07m');
  });

  it('keeps the sign for negative durations', () => {
    expect(formatDuration(-45)).toBe('-45m');
    expect(formatDuration(-90)).toBe('-1h 30m');
  });

  it('null → em dash', () => {
    expect(formatDuration(null)).toBe('—');
  });
});

describe('formatSignedDuration', () => {
  it('explicit plus sign for positive variance', () => {
    expect(formatSignedDuration(150)).toBe('+2h 30m');
  });

  it('minus sign for negative variance', () => {
    expect(formatSignedDuration(-42)).toBe('-42m');
  });

  it('zero renders as "0m"', () => {
    expect(formatSignedDuration(0)).toBe('0m');
  });

  it('null → em dash', () => {
    expect(formatSignedDuration(null)).toBe('—');
  });
});

describe('formatNumber / formatInteger', () => {
  it('null-safe number formatting', () => {
    expect(formatNumber(1.125, 3)).toBe('1.125');
    expect(formatNumber(null)).toBe('—');
    expect(formatNumber(Number.NaN)).toBe('—');
  });

  it('null-safe integer formatting', () => {
    expect(formatInteger(3)).toBe('3');
    expect(formatInteger(null)).toBe('—');
  });
});

describe('time parsing round-trip', () => {
  it('parses "HH:mm" to minutes', () => {
    expect(parseTimeToMinutes('09:00')).toBe(540);
    expect(parseTimeToMinutes('23:59')).toBe(1439);
    expect(parseTimeToMinutes('0:00')).toBe(0);
  });

  it('rejects invalid time strings', () => {
    expect(parseTimeToMinutes('24:00')).toBeNull();
    expect(parseTimeToMinutes('12:60')).toBeNull();
    expect(parseTimeToMinutes('abc')).toBeNull();
    expect(parseTimeToMinutes('')).toBeNull();
  });

  it('minutes → "HH:mm" for <input type="time">', () => {
    expect(minutesToTimeInput(540)).toBe('09:00');
    expect(minutesToTimeInput(0)).toBe('00:00');
    expect(minutesToTimeInput(1439)).toBe('23:59');
  });
});

describe('formatCases (V2)', () => {
  it('integers render plain', () => {
    expect(formatCases(120)).toBe('120');
  });

  it('fractional values render with one decimal', () => {
    expect(formatCases(18.75)).toBe('18.8');
  });

  it('null → em dash', () => {
    expect(formatCases(null)).toBe('—');
  });
});

describe('formatSignedMultiDayDuration (V2)', () => {
  it('positive within a day', () => {
    expect(formatSignedMultiDayDuration(90)).toBe('+1h 30m');
  });

  it('positive across days', () => {
    expect(formatSignedMultiDayDuration(1590)).toBe('+1d 2h 30m');
  });

  it('negative values keep the sign', () => {
    expect(formatSignedMultiDayDuration(-45)).toBe('-45m');
    expect(formatSignedMultiDayDuration(-1500)).toBe('-1d 1h 00m');
  });

  it('zero and null', () => {
    expect(formatSignedMultiDayDuration(0)).toBe('0m');
    expect(formatSignedMultiDayDuration(null)).toBe('—');
  });
});

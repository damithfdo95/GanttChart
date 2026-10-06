import { describe, expect, it } from 'vitest';
import type { AttendanceRecord, TesterDailyPerformance } from '../types';
import { calculateAttendanceConsistency } from '../lib/calculations/testerAttribution';

/**
 * V6.7 §15 — Attendance cross-check. Warnings are hints only: the check is
 * pure, never deletes or modifies execution records, and a missing
 * attendance record is not proof that execution data is invalid.
 */

function record(overrides: Partial<TesterDailyPerformance> = {}): TesterDailyPerformance {
  return {
    id: 'r-' + Math.random().toString(36).slice(2, 8),
    date: '2026-09-10',
    testerName: 'Tanaka',
    projectId: 'PRJ-001',
    casesTested: 50,
    ...overrides,
  };
}

function attendance(overrides: Partial<AttendanceRecord> = {}): AttendanceRecord {
  return {
    id: 'att-' + Math.random().toString(36).slice(2, 8),
    date: '2026-09-10',
    memberName: 'Tanaka',
    team: 'PrV',
    status: 'PRESENT',
    workingStart: null,
    workingEnd: null,
    leaveType: null,
    comment: '',
    ...overrides,
  };
}

describe('V6.7 attendance cross-check', () => {
  it('produces no warning when the tester attended and executed', () => {
    expect(calculateAttendanceConsistency([record()], [attendance()])).toEqual([]);
  });

  it('treats LATE and HALF_DAY as attending', () => {
    expect(calculateAttendanceConsistency([record()], [attendance({ status: 'LATE' })])).toEqual([]);
    expect(calculateAttendanceConsistency([record()], [attendance({ status: 'HALF_DAY' })])).toEqual([]);
  });

  it('flags execution recorded on a day marked ABSENT or PAID_LEAVE', () => {
    const records = [record()];
    const warnings = calculateAttendanceConsistency(records, [attendance({ status: 'ABSENT' })]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].kind).toBe('absent');
    expect(warnings[0].attendanceStatus).toBe('ABSENT');
    expect(warnings[0].casesTested).toBe(50);
    expect(warnings[0].testerName).toBe('Tanaka');
    expect(warnings[0].date).toBe('2026-09-10');

    const paidLeave = calculateAttendanceConsistency(records, [attendance({ status: 'PAID_LEAVE' })]);
    expect(paidLeave[0].kind).toBe('absent');
  });

  it('treats missing attendance as attending by default (absence-only input)', () => {
    // No attendance record = attending (V6.9-B absence-only semantics) —
    // execution without any record is normal, never a warning.
    expect(calculateAttendanceConsistency([record({ casesTested: 20 })], [])).toEqual([]);
  });

  it('never deletes or modifies execution records (pure check)', () => {
    const records = [record(), record({ testerName: 'Sato', date: '2026-09-11', casesTested: 30 })];
    const before = JSON.stringify(records);
    calculateAttendanceConsistency(records, []);
    expect(JSON.stringify(records)).toBe(before);
  });

  it('checks multiple dates and testers independently, sorted for display', () => {
    const records = [
      record({ testerName: 'Suzuki', date: '2026-09-12' }),
      record({ testerName: 'Sato', date: '2026-09-11' }),
      record({ testerName: 'Tanaka', date: '2026-09-10' }),
      record({ testerName: 'Tanaka', date: '2026-09-11' }),
    ];
    const attendanceRecords = [
      attendance({ memberName: 'Tanaka', date: '2026-09-10', status: 'ABSENT' }),
      attendance({ memberName: 'Tanaka', date: '2026-09-11' }), // present → fine
      attendance({ memberName: 'Sato', date: '2026-09-11' }),
    ];
    const warnings = calculateAttendanceConsistency(records, attendanceRecords);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].date).toBe('2026-09-10');
    expect(warnings[0].kind).toBe('absent');
  });
});

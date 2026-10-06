import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AttendanceRecord,
  ProjectRecord,
  QaInputs,
  RcsMember,
  ReportsState,
  TesterDailyPerformance,
} from '../types';
import { DEMO_STATE, normalizeQaInputs } from '../lib/storage/storage';
import { defaultReportsState, loadReportsState, saveReportsState } from '../lib/storage/reports';
import { createBackupPayload, parseBackupPayload } from '../lib/backup/backup';
import { newProjectRecord } from '../domain/projects/lifecycle';
import {
  collectIdentityIssues,
  migrateAttendanceIdentity,
  resolveAttendanceRecord,
} from '../domain/identityResolution';
import {
  calculateAttendanceConsistency,
  suggestAttendanceAwareAllocation,
  type AssignedTesterAttendance,
} from '../lib/calculations/testerAttribution';

/**
 * V6.9-A §38 — attendance identity: new records store memberId, legacy
 * records migrate conservatively (never guessing, never rewriting the
 * recorded name), consistency/allocation prefer the stable identity, and
 * everything survives backup/restore.
 */

class MemoryStorage {
  map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal('window', { localStorage: storage });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function member(overrides: Partial<RcsMember> = {}): RcsMember {
  return {
    id: 'USER0003',
    name: 'Yamauchi K.',
    team: 'RCS',
    role: 'Tester',
    startDate: '2026-07-01',
    active: true,
    ...overrides,
  };
}

function attendance(overrides: Partial<AttendanceRecord> = {}): AttendanceRecord {
  return {
    id: 'att-1',
    date: '2026-09-10',
    memberName: 'Yamauchi Kentaro',
    team: 'RCS',
    status: 'PRESENT',
    workingStart: '09:00',
    workingEnd: '18:00',
    leaveType: null,
    comment: '',
    ...overrides,
  };
}

function baseInputs(): QaInputs {
  return normalizeQaInputs({
    totalCases: 100,
    currentTesters: 8,
    startTime: 13 * 60,
    targetFinish: 17 * 60,
    lunchStart: 0,
    lunchEnd: 0,
    perHourPerTester: 4,
    casesCompleted: 0,
    startDate: '2026-09-28',
    targetCompletionDate: '2026-09-30',
    targetCompletionTime: '17:00',
    planningRows: [{ id: 'row-1', date: '2026-09-28', plannedTesters: 8, absentTesters: 0, nonWorkingDay: false, note: '' }],
  });
}

function project(existing: readonly ProjectRecord[] = []): ProjectRecord {
  return newProjectRecord(baseInputs(), { nameEn: 'Project A' }, '2026-09-01T00:00:00.000Z', existing);
}

describe('V6.9-A attendance identity migration', () => {
  it('stores memberId on new attendance records and validates the shape', () => {
    const record = attendance({ memberId: 'USER0003' });
    expect(record.memberName).toBe('Yamauchi Kentaro'); // snapshot preserved
    const state: ReportsState = { ...defaultReportsState(), attendance: [record] };
    expect(saveReportsState(state)).toBe(true);
    const loaded = loadReportsState();
    expect(loaded.attendance[0].memberId).toBe('USER0003');
    expect(loaded.attendance[0].memberName).toBe('Yamauchi Kentaro');
  });

  it('migrates a legacy record whose name resolves to exactly one member (incl. history)', () => {
    const members = [member({ nameHistory: [{ name: 'Yamauchi Kentaro' }] })];
    const result = migrateAttendanceIdentity([attendance()], members);
    expect(result.resolved).toHaveLength(1);
    expect(result.attendance[0].memberId).toBe('USER0003');
    expect(result.attendance[0].memberName).toBe('Yamauchi Kentaro'); // never rewritten
  });

  it('preserves unmatched and ambiguous legacy records verbatim', () => {
    const members = [
      member({ nameHistory: [{ name: 'Yamauchi Kentaro' }] }),
      member({ id: 'USER0012', name: 'Yamauchi Kentaro' }),
    ];
    const result = migrateAttendanceIdentity(
      [attendance({ id: 'a1', memberName: 'Nobody' }), attendance({ id: 'a2' })],
      members,
    );
    expect(result.resolved).toHaveLength(0);
    expect(result.unmatched.map((r) => r.id)).toEqual(['a1']);
    expect(result.ambiguous.map((r) => r.id)).toEqual(['a2']);
    expect(result.attendance.every((r) => r.memberId === undefined)).toBe(true);
    expect(result.attendance.every((r) => r.identityResolution === undefined)).toBe(true);
  });

  it('is idempotent: a second run changes nothing', () => {
    const members = [member({ nameHistory: [{ name: 'Yamauchi Kentaro' }] })];
    const first = migrateAttendanceIdentity([attendance()], members);
    const second = migrateAttendanceIdentity(first.attendance, members);
    expect(second.attendance).toEqual(first.attendance);
    expect(second.resolved).toHaveLength(0);
  });

  it('never overwrites a manual resolution decision', () => {
    const members = [member({ nameHistory: [{ name: 'Yamauchi Kentaro' }] })];
    const manually = resolveAttendanceRecord(attendance(), undefined, '2026-09-30T00:00:00.000Z');
    const result = migrateAttendanceIdentity([manually], members);
    expect(result.resolved).toHaveLength(0);
    expect(result.unmatched).toHaveLength(0);
    expect(result.ambiguous).toHaveLength(0);
    expect(result.attendance[0].identityResolution).toEqual({
      method: 'manual',
      resolvedAt: '2026-09-30T00:00:00.000Z',
    });
  });

  it('migration runs through normalizeReportsState on load', () => {
    const members = [member({ nameHistory: [{ name: 'Yamauchi Kentaro' }] })];
    const state: ReportsState = {
      ...defaultReportsState(),
      rcsMembers: members,
      attendance: [attendance()],
    };
    saveReportsState(state);
    const loaded = loadReportsState();
    expect(loaded.attendance[0].memberId).toBe('USER0003');
  });
});

describe('V6.9-A attendance consistency by stable identity', () => {
  const members = [member({ nameHistory: [{ name: 'Yamauchi Kentaro' }] })];

  it('matches a legacy-name execution record against a memberId attendance row', () => {
    const records: TesterDailyPerformance[] = [
      { id: 'r1', date: '2026-09-10', testerName: 'Yamauchi Kentaro', projectId: 'PRJ-001', casesTested: 20 },
    ];
    // Attendance recorded through the member selector (memberId + snapshot).
    const attendanceRows = [attendance({ memberId: 'USER0003', memberName: 'Yamauchi K.' })];
    const warnings = calculateAttendanceConsistency(records, attendanceRows, members);
    expect(warnings).toEqual([]); // PRESENT — no warning despite different names
  });

  it('matches a memberId execution record against a legacy-name attendance row', () => {
    const records: TesterDailyPerformance[] = [
      { id: 'r1', date: '2026-09-10', testerName: 'Yamauchi K.', memberId: 'USER0003', projectId: 'PRJ-001', casesTested: 20 },
    ];
    const attendanceRows = [attendance({ memberName: 'Yamauchi Kentaro' })]; // legacy row
    const warnings = calculateAttendanceConsistency(records, attendanceRows, members);
    expect(warnings).toEqual([]);
  });

  it('treats missing attendance as attending by default (absence-only input)', () => {
    const records: TesterDailyPerformance[] = [
      { id: 'r1', date: '2026-09-10', testerName: 'Yamauchi Kentaro', projectId: 'PRJ-001', casesTested: 20 },
    ];
    const warnings = calculateAttendanceConsistency(records, [], members);
    expect(warnings).toEqual([]); // no record = attending — never a warning
    expect(records).toHaveLength(1); // execution record untouched
  });

  it('reports absent attendance (memberId matched) with the recorded status', () => {
    const records: TesterDailyPerformance[] = [
      { id: 'r1', date: '2026-09-10', testerName: 'Yamauchi K.', memberId: 'USER0003', projectId: 'PRJ-001', casesTested: 20 },
    ];
    const attendanceRows = [attendance({ memberId: 'USER0003', memberName: 'Yamauchi K.', status: 'ABSENT' })];
    const warnings = calculateAttendanceConsistency(records, attendanceRows, members);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].kind).toBe('absent');
    expect(warnings[0].attendanceStatus).toBe('ABSENT');
  });
});

describe('V6.9-A attendance-aware allocation by stable identity', () => {
  it('suggests only attending testers; absent ones are excluded (memberId-based)', () => {
    const assigned: AssignedTesterAttendance[] = [
      { key: 'USER0003', memberId: 'USER0003', testerName: 'Yamauchi K.', attendance: 'PRESENT' },
      { key: 'USER0004', memberId: 'USER0004', testerName: 'Kobayashi Masashi', attendance: 'ABSENT' },
      { key: 'USER0005', memberId: 'USER0005', testerName: 'Osaki Kazuki', attendance: 'PRESENT' },
    ];
    const suggestion = suggestAttendanceAwareAllocation(10, assigned);
    expect(suggestion.basis).toBe('attendance');
    expect(suggestion.allocations.map((a) => a.memberId)).toEqual(['USER0003', 'USER0005']);
    expect(suggestion.excludedKeys).toEqual(['USER0004']);
    expect(suggestion.allocations.every((a) => a.cases === 5)).toBe(true);
  });

  it('falls back to all assigned testers when nobody is attending (supervisor confirms)', () => {
    const assigned: AssignedTesterAttendance[] = [
      { key: 'USER0003', memberId: 'USER0003', testerName: 'Yamauchi K.', attendance: 'PAID_LEAVE' },
      { key: 'USER0004', memberId: 'USER0004', testerName: 'Kobayashi Masashi', attendance: 'OTHER' },
    ];
    const suggestion = suggestAttendanceAwareAllocation(10, assigned);
    expect(suggestion.basis).toBe('none');
    expect(suggestion.allocations).toHaveLength(2);
  });
});

describe('V6.9-A attendance backup/restore and issue collection', () => {
  it('round-trips attendance identity through backup/restore', () => {
    const state: ReportsState = {
      ...defaultReportsState(),
      attendance: [
        attendance({ memberId: 'USER0003', memberName: 'Yamauchi K.' }),
        resolveAttendanceRecord(attendance({ id: 'att-2', memberName: 'Visitor' }), undefined, '2026-09-30T00:00:00.000Z'),
      ],
    };
    const payload = createBackupPayload(DEMO_STATE, state);
    const parsed = parseBackupPayload(JSON.stringify(payload));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const [withId, kept] = parsed.data.reportsState.attendance;
    expect(withId.memberId).toBe('USER0003');
    expect(withId.memberName).toBe('Yamauchi K.');
    expect(kept.memberId).toBeUndefined();
    expect(kept.identityResolution).toEqual({ method: 'manual', resolvedAt: '2026-09-30T00:00:00.000Z' });
  });

  it('collects unmatched/ambiguous attendance for the Identity Resolution Center', () => {
    const members = [
      member({ nameHistory: [{ name: 'Yamauchi Kentaro' }] }),
      member({ id: 'USER0012', name: 'Yamauchi Kentaro' }),
    ];
    const issues = collectIdentityIssues(
      [
        attendance({ id: 'a1', memberName: 'Nobody' }),
        attendance({ id: 'a2' }),
        attendance({ id: 'a3', memberId: 'USER0005' }),
        resolveAttendanceRecord(attendance({ id: 'a4', memberName: 'Nobody' }), undefined, '2026-09-30T00:00:00.000Z'),
      ],
      [project()],
      members,
    );
    expect(issues.attendance.map((i) => i.recordId)).toEqual(['a1', 'a2']);
    expect(issues.attendance[0].kind).toBe('unmatched');
    expect(issues.attendance[1].kind).toBe('ambiguous');
    expect(issues.attendance[1].candidates.map((c) => c.memberId)).toEqual(['USER0003', 'USER0012']);
    // Manually kept-unresolved (a4) never reappears; a3 is resolved.
    expect(issues.resolvedAttendance.map((r) => r.recordId)).toEqual(['a4']);
  });
});

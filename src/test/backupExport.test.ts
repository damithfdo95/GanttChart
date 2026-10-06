import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBackupPayload, parseBackupPayload } from '../lib/backup/backup';
import { DEMO_STATE, saveState } from '../lib/storage/storage';
import { defaultReportsState, saveReportsState } from '../lib/storage/reports';
import { filterAttendanceRecords, attendanceSheet, managementSheet, reportsSheet } from '../lib/export/exportData';
import { buildManagementReportRow, riskStatusLabel } from '../lib/export/management';
import { calculateMultiDayProjection } from '../lib/calculations/planning';
import type { AppState, AttendanceRecord, DailyReport } from '../types';

class MemoryStorage {
  private map = new Map<string, string>();
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

function state(overrides: Partial<AppState> = {}): AppState {
  return { ...DEMO_STATE, ...overrides };
}

function report(overrides: Partial<DailyReport> = {}): DailyReport {
  return {
    id: 'rep1',
    reportDate: '2026-09-17',
    language: 'en',
    status: 'FINALIZED',
    projectId: 'PRJ-001',
    revisionOf: null,
    jiraUrl: null,
    activities: [],
    nextDay: [],
    previewText: 'text',
    createdBy: 'sup',
    createdAt: '2026-09-17T09:00:00.000Z',
    updatedAt: '2026-09-17T09:00:00.000Z',
    finalizedAt: '2026-09-17T18:00:00.000Z',
    finalizedBy: 'sup',
    snapshot: null,
    ...overrides,
  };
}

describe('backup round-trip', () => {
  it('exports and re-imports the full application data', () => {
    const appState = state({ totalCases: 77 });
    const reportsState = defaultReportsState();
    reportsState.reports.push(report());
    const payload = createBackupPayload(appState, reportsState);
    const text = JSON.stringify(payload);
    expect(payload.app).toBe('ganttchart');
    expect(payload.kind).toBe('backup');

    const parsed = parseBackupPayload(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.data.appState.totalCases).toBe(77);
      expect(parsed.data.reportsState.reports).toHaveLength(1);
    }
  });

  it('rejects invalid payloads clearly', () => {
    expect(parseBackupPayload('not json').ok).toBe(false);
    expect(parseBackupPayload('{"app":"other"}').ok).toBe(false);
    expect(parseBackupPayload(JSON.stringify({ app: 'ganttchart', kind: 'backup', version: 1, data: {} })).ok).toBe(false);
    expect(
      parseBackupPayload(
        JSON.stringify({
          app: 'ganttchart',
          kind: 'backup',
          version: 1,
          data: { appState: { totalCases: 'x' }, reportsState: defaultReportsState() },
        }),
      ).ok,
    ).toBe(false);
  });

  it('writes both storages so a reload restores everything', () => {
    const appState = state({ totalCases: 88 });
    const reportsState = defaultReportsState();
    saveState(appState);
    saveReportsState(reportsState);
    expect(storage.getItem('ganttchart.v2')).toContain('"totalCases":88');
    expect(storage.getItem('ganttchart.reports.v1')).not.toBeNull();
  });
});

describe('export filters', () => {
  const records: AttendanceRecord[] = [
    { id: '1', date: '2026-09-16', memberName: 'A', team: 'PrV', status: 'PRESENT', workingStart: null, workingEnd: null, leaveType: null, comment: '' },
    { id: '2', date: '2026-09-17', memberName: 'B', team: 'RCS', status: 'ABSENT', workingStart: null, workingEnd: null, leaveType: null, comment: '' },
    { id: '3', date: '2026-09-18', memberName: 'C', team: 'PrV', status: 'LATE', workingStart: null, workingEnd: null, leaveType: null, comment: '' },
  ];

  it('filters by date range, team and status', () => {
    expect(filterAttendanceRecords(records, { dateFrom: '2026-09-17', dateTo: null, team: null, status: null }).map((r) => r.id)).toEqual(['2', '3']);
    expect(filterAttendanceRecords(records, { dateFrom: null, dateTo: '2026-09-16', team: null, status: null }).map((r) => r.id)).toEqual(['1']);
    expect(filterAttendanceRecords(records, { dateFrom: null, dateTo: null, team: 'PrV', status: null }).map((r) => r.id)).toEqual(['1', '3']);
    expect(filterAttendanceRecords(records, { dateFrom: null, dateTo: null, team: null, status: 'ABSENT' }).map((r) => r.id)).toEqual(['2']);
  });

  it('builds localized sheet headers', () => {
    const en = attendanceSheet('en', records).headers;
    expect(en[0]).toBe('Date');
    expect(en[1]).toBe('Member');
    const ja = attendanceSheet('ja', records).headers;
    expect(ja[0]).toBe('日付');
    expect(ja[1]).toBe('メンバー');
  });

  it('report sheets expose status and finalization info', () => {
    const sheet = reportsSheet('en', [report(), report({ id: 'rep2', status: 'DRAFT', finalizedAt: null, finalizedBy: null })]);
    expect(sheet.rows[0][3]).toBe('Finalized');
    expect(sheet.rows[1][3]).toBe('Draft');
  });
});

describe('management report', () => {
  const appState = state({
    totalCases: 200,
    casesCompleted: 50,
    currentTesters: 4,
    perHourPerTester: 4,
    startDate: '2026-09-14',
    targetCompletionDate: '2026-09-16',
    targetCompletionTime: '17:30',
    planningRows: [
      { id: 'p1', date: '2026-09-14', plannedTesters: 4, absentTesters: 0, nonWorkingDay: false, note: '' },
      { id: 'p2', date: '2026-09-15', plannedTesters: 4, absentTesters: 0, nonWorkingDay: false, note: '' },
      { id: 'p3', date: '2026-09-16', plannedTesters: 4, absentTesters: 0, nonWorkingDay: false, note: '' },
    ],
  });

  function projection() {
    return calculateMultiDayProjection({
      casesRemaining: 150,
      planningRows: appState.planningRows,
      perHourPerTester: 4,
      workStartTime: 540,
      workEndTime: 1050,
      lunch: { start: 720, end: 780 },
      targetCompletionDate: '2026-09-16',
      targetCompletionTime: null,
    });
  }

  it('builds the row from the pure planning engine', () => {
    const row = buildManagementReportRow(appState, projection());
    expect(row.remainingTestCases).toBe(150);
    expect(row.currentTesters).toBe(4);
    expect(row.requiredTesters).toBe(2);
    expect(row.capacityGap).toBe(0);
    expect(row.dueDate).toBe('2026-09-16');
    expect(row.riskStatus).toBe('onTrack');
  });

  it('computes overtime person-hours from the deadline shortage', () => {
    const shortState = state({
      ...appState,
      totalCases: 600,
      casesCompleted: 0,
      planningRows: [
        { id: 'p1', date: '2026-09-14', plannedTesters: 4, absentTesters: 0, nonWorkingDay: false, note: '' },
      ],
      targetCompletionDate: '2026-09-14',
    });
    const row = buildManagementReportRow(
      shortState,
      calculateMultiDayProjection({
        casesRemaining: 600,
        planningRows: shortState.planningRows,
        perHourPerTester: 4,
        workStartTime: 540,
        workEndTime: 1050,
        lunch: { start: 720, end: 780 },
        targetCompletionDate: '2026-09-14',
        targetCompletionTime: null,
      }),
    );
    // capacity 120 by deadline; shortage 480 cases → 480/4 = 120 person-hours
    expect(row.totalOtPersonHours).toBeCloseTo(120, 6);
    expect(row.riskStatus).toBe('capacityShortage');
    expect(riskStatusLabel('ja', row.riskStatus)).toBe('キャパシティ不足');
    expect(riskStatusLabel('en', 'atRisk')).toBe('At Risk');
  });

  it('management sheet headers are localized', () => {
    const row = buildManagementReportRow(appState, projection());
    expect(managementSheet('en', row).headers).toContain('Predicted Finish Date');
    expect(managementSheet('ja', row).headers).toContain('予測完了日');
  });
});

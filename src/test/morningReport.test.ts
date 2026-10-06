import { describe, expect, it } from 'vitest';
import {
  morningAttendingTotal,
  renderMorningAttendanceLine,
  renderMorningAbsenceNotes,
  renderMorningReport,
} from '../lib/reporting/morning';
import { ABSENCE_REASON_PRESETS, absenceReasonLabel, isPresetReason } from '../lib/reporting/absenceReasons';
import { createRevision, finalizeReport, newDraft } from '../lib/reporting/drafts';
import { isDailyReportGuard } from '../lib/storage/reports';
import { SEED_RCS_MEMBERS, type AttendanceRecord, type DailyReport, type RcsMember } from '../types';

function attendance(overrides: Partial<AttendanceRecord> = {}): AttendanceRecord {
  return {
    id: 'a1',
    date: '2026-10-05',
    memberName: 'Yamauchi Kentaro',
    memberId: 'USER0003',
    team: 'RCS',
    status: 'ABSENT',
    workingStart: null,
    workingEnd: null,
    leaveType: 'poorHealth',
    comment: '',
    ...overrides,
  };
}

function report(overrides: Partial<DailyReport> = {}): DailyReport {
  return {
    id: 'r1',
    reportDate: '2026-10-05',
    language: 'en',
    status: 'DRAFT',
    projectId: null,
    revisionOf: null,
    jiraUrl: null,
    activities: [],
    nextDay: [],
    morningSchedule: [],
    morningPreviewText: '',
    previewText: '',
    createdBy: 'SV',
    createdAt: '2026-10-05T09:00:00.000Z',
    updatedAt: '2026-10-05T09:00:00.000Z',
    finalizedAt: null,
    finalizedBy: null,
    snapshot: null,
    ...overrides,
  };
}

describe('morningAttendingTotal', () => {
  it('counts 7/8 for one absence out of an 8-member active roster', () => {
    expect(morningAttendingTotal([attendance()], SEED_RCS_MEMBERS)).toEqual({ attending: 7, total: 8 });
  });

  it('falls back to the record count without a roster (legacy behavior)', () => {
    const records = [
      attendance({ status: 'PRESENT', leaveType: null }),
      attendance({ id: 'a2', memberId: 'USER0004', memberName: 'Kobayashi Masashi', status: 'ABSENT' }),
    ];
    expect(morningAttendingTotal(records)).toEqual({ attending: 1, total: 2 });
  });

  it('uses the record count when it exceeds the active roster', () => {
    const roster = SEED_RCS_MEMBERS.slice(0, 2);
    const records = [
      attendance(),
      attendance({ id: 'a2', memberId: 'USER0004', memberName: 'Kobayashi Masashi' }),
      attendance({ id: 'a3', memberId: 'USER0005', memberName: 'Osaki Kazuki', status: 'PRESENT', leaveType: null }),
    ];
    expect(morningAttendingTotal(records, roster)).toEqual({ attending: 1, total: 3 });
  });

  it('ignores inactive roster members', () => {
    const roster: RcsMember[] = SEED_RCS_MEMBERS.map((m) => ({ ...m, active: false }));
    expect(morningAttendingTotal([], roster)).toEqual({ attending: 0, total: 0 });
  });

  it('treats half-day and late records as attending', () => {
    const records = [
      attendance({ status: 'HALF_DAY', leaveType: null }),
      attendance({ id: 'a2', memberId: 'USER0004', memberName: 'Kobayashi Masashi', status: 'LATE' }),
    ];
    expect(morningAttendingTotal(records, SEED_RCS_MEMBERS)).toEqual({ attending: 8, total: 8 });
  });
});

describe('renderMorningAttendanceLine', () => {
  it('renders the single overall line in both languages', () => {
    expect(renderMorningAttendanceLine('en', [attendance()], SEED_RCS_MEMBERS)).toBe('7/8 members attending');
    expect(renderMorningAttendanceLine('ja', [attendance()], SEED_RCS_MEMBERS)).toBe('7/8名出席予定');
  });
});

describe('absence reason presets', () => {
  it('recognizes preset keys and rejects custom text', () => {
    for (const preset of ABSENCE_REASON_PRESETS) expect(isPresetReason(preset.key)).toBe(true);
    expect(isPresetReason('poorHealth')).toBe(true);
    expect(isPresetReason('sick (family matter)')).toBe(false);
    expect(isPresetReason(null)).toBe(false);
    expect(isPresetReason('')).toBe(false);
  });

  it('translates presets and keeps manual text verbatim', () => {
    expect(absenceReasonLabel('en', 'poorHealth')).toBe('poor health');
    expect(absenceReasonLabel('ja', 'poorHealth')).toBe('体調不良');
    expect(absenceReasonLabel('en', 'hospital visit')).toBe('hospital visit');
    expect(absenceReasonLabel('ja', '通院')).toBe('通院');
    expect(absenceReasonLabel('en', null)).toBe('');
    expect(absenceReasonLabel('en', '')).toBe('');
  });
});

describe('renderMorningAbsenceNotes', () => {
  it('composes one note per non-attending record from status + reason', () => {
    const records = [
      attendance(),
      attendance({ id: 'a2', memberId: 'USER0004', memberName: 'Kobayashi Masashi', status: 'PAID_LEAVE', leaveType: null }),
      attendance({ id: 'a3', memberId: 'USER0005', memberName: 'Osaki Kazuki', status: 'OTHER', leaveType: 'hospital visit' }),
    ];
    expect(renderMorningAbsenceNotes('en', records)).toEqual([
      '※Yamauchi Kentaro will be absent for the entire day due to poor health.',
      '※Kobayashi Masashi will be on paid leave for the entire day.',
      '※Osaki Kazuki will be absent for the entire day (hospital visit).',
    ]);
  });

  it('renders paid leave and other statuses in Japanese', () => {
    const records = [
      attendance({ memberId: 'USER0004', memberName: 'Kobayashi Masashi', status: 'PAID_LEAVE', leaveType: null }),
      attendance({ id: 'a2', memberId: 'USER0005', memberName: 'Osaki Kazuki', status: 'OTHER', leaveType: null }),
    ];
    expect(renderMorningAbsenceNotes('ja', records)).toEqual([
      '※Kobayashi Masashiは終日有給休暇予定です。',
      '※Osaki Kazukiはその他の理由で欠席予定です。',
    ]);
  });

  it('skips attending records', () => {
    const records = [attendance({ status: 'PRESENT', leaveType: null })];
    expect(renderMorningAbsenceNotes('en', records)).toEqual([]);
  });
});

describe('renderMorningReport', () => {
  it('renders the SPO morning format (10/5 example)', () => {
    const text = renderMorningReport('en', {
      date: '2026-10-05',
      records: [attendance()],
      members: SEED_RCS_MEMBERS,
      schedule: [{ id: 's1', text: 'Android 4.1.0 Regression', source: 'MANUAL' }],
    });
    expect(text).toBe(
      [
        '10/5',
        '■Attendance',
        '7/8 members attending',
        '※Yamauchi Kentaro will be absent for the entire day due to poor health.',
        '■Today\'s schedule',
        '　・Android 4.1.0 Regression',
      ].join('\n'),
    );
  });

  it('renders a Japanese report with multiple schedule bullets', () => {
    const text = renderMorningReport('ja', {
      date: '2026-12-01',
      records: [],
      members: SEED_RCS_MEMBERS,
      schedule: [
        { id: 's1', text: 'Android 4.1.0 Regression', source: 'AUTO' },
        { id: 's2', text: 'iOS 4.1.0 R-can Sanity', source: 'MANUAL' },
      ],
    });
    expect(text).toBe(
      [
        '12/1',
        '■Attendance',
        '8/8名出席予定',
        '■Today\'s schedule',
        '　・Android 4.1.0 Regression',
        '　・iOS 4.1.0 R-can Sanity',
      ].join('\n'),
    );
  });

  it('renders without absence notes when everyone attends', () => {
    const text = renderMorningReport('en', {
      date: '2026-10-05',
      records: [],
      members: SEED_RCS_MEMBERS,
      schedule: [],
    });
    expect(text).not.toContain('※');
  });
});

describe('morning report draft lifecycle', () => {
  it('newDraft initializes the morning fields', () => {
    const draft = newDraft('2026-10-05', 'en', 'SV', '2026-10-05T09:00:00.000Z');
    expect(draft.morningSchedule).toEqual([]);
    expect(draft.morningPreviewText).toBe('');
  });

  it('finalizeReport snapshots the morning schedule and preview', () => {
    const draft = report({
      morningSchedule: [{ id: 's1', text: 'Android 4.1.0 Regression', source: 'AUTO' }],
      morningPreviewText: '10/5\n■Attendance',
    });
    const finalized = finalizeReport(draft, [], [], 'SV', '2026-10-05T18:00:00.000Z');
    expect(finalized.snapshot?.morningSchedule).toEqual([{ id: 's1', text: 'Android 4.1.0 Regression', source: 'AUTO' }]);
    expect(finalized.snapshot?.morningPreviewText).toBe('10/5\n■Attendance');
  });

  it('createRevision copies morning items with fresh ids and defaults missing ones', () => {
    const finalized = finalizeReport(
      report({
        morningSchedule: [{ id: 's1', text: 'Regression', source: 'AUTO' }],
        morningPreviewText: 'text',
      }),
      [],
      [],
      'SV',
      '2026-10-05T18:00:00.000Z',
    );
    const revision = createRevision(finalized, '2026-10-06T08:00:00.000Z');
    expect(revision.morningSchedule).toEqual([{ id: expect.any(String), text: 'Regression', source: 'AUTO' }]);
    expect(revision.morningSchedule?.[0]?.id).not.toBe('s1');
    expect(revision.morningPreviewText).toBe('text');

    // Legacy reports without morning fields still revise cleanly.
    const legacy = report({ morningSchedule: undefined, morningPreviewText: undefined });
    const legacyFinalized = finalizeReport(legacy, [], [], 'SV', '2026-10-05T18:00:00.000Z');
    const legacyRevision = createRevision(legacyFinalized, '2026-10-06T08:00:00.000Z');
    expect(legacyRevision.morningSchedule).toEqual([]);
    expect(legacyRevision.morningPreviewText).toBe('');
  });
});

describe('persisted report shape guard', () => {
  it('accepts legacy reports without morning fields', () => {
    const legacy = report({ morningSchedule: undefined, morningPreviewText: undefined });
    expect(isDailyReportGuard(legacy)).toBe(true);
  });

  it('accepts reports with valid morning fields', () => {
    expect(isDailyReportGuard(report())).toBe(true);
  });

  it('rejects an invalid morningSchedule', () => {
    expect(isDailyReportGuard(report({ morningSchedule: 'nope' as unknown as DailyReport['morningSchedule'] }))).toBe(false);
    expect(
      isDailyReportGuard(report({ morningSchedule: [{ id: 's1', text: 1 as unknown as string, source: 'MANUAL' }] })),
    ).toBe(false);
  });

  it('rejects a non-string morningPreviewText', () => {
    expect(isDailyReportGuard(report({ morningPreviewText: 42 as unknown as string }))).toBe(false);
  });
});

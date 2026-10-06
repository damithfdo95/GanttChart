import { describe, expect, it } from 'vitest';
import { createRevision, finalizeReport, findDraft, newDraft, seedAutoActivities } from '../lib/reporting/drafts';
import type { AppState, AttendanceRecord, DailyTopic } from '../types';
import { DEMO_STATE } from '../lib/storage/storage';

function appState(overrides: Partial<AppState> = {}): AppState {
  return { ...DEMO_STATE, ...overrides };
}

function attendance(id: string, team: string, status: AttendanceRecord['status']): AttendanceRecord {
  return { id, date: '2026-09-17', memberName: `M${id}`, team, status, workingStart: '09:00', workingEnd: '17:30', leaveType: null, comment: '' };
}

describe('draft lifecycle', () => {
  it('finds only DRAFT reports for a date', () => {
    const draft = newDraft('2026-09-17', 'ja', 'supervisor', '2026-09-17T09:00:00.000Z');
    const finalized = { ...draft, status: 'FINALIZED' as const };
    expect(findDraft([draft], '2026-09-17')?.id).toBe(draft.id);
    expect(findDraft([finalized], '2026-09-17')).toBeUndefined();
    expect(findDraft([draft], '2026-09-18')).toBeUndefined();
  });

  it('finalizing freezes a snapshot of attendance and topics', () => {
    const draft = newDraft('2026-09-17', 'en', 'supervisor', '2026-09-17T09:00:00.000Z');
    draft.activities = [
      {
        id: 'a1', source: 'AUTO', name: 'Suite', memberCount: 4, completedCases: 30, workingStatus: 'Working',
        included: true, totalCases: 120, workingEligibleCases: 120, startedCases: 30, blockedCases: 0,
        notApplicableCases: 0, dueDate: '2026-09-20',
      },
    ];
    const attendanceRecords: AttendanceRecord[] = [attendance('1', 'PrV', 'PRESENT')];
    const topics: DailyTopic[] = [];
    const finalized = finalizeReport(draft, attendanceRecords, topics, 'Yamada', '2026-09-17T18:00:00.000Z');

    expect(finalized.status).toBe('FINALIZED');
    expect(finalized.finalizedAt).toBe('2026-09-17T18:00:00.000Z');
    expect(finalized.finalizedBy).toBe('Yamada');
    expect(finalized.snapshot?.attendance).toHaveLength(1);
    expect(finalized.snapshot?.activities[0]?.name).toBe('Suite');

    // Later edits to the live collections never leak into the snapshot.
    attendanceRecords[0].status = 'ABSENT';
    draft.activities[0].name = 'Changed';
    expect(finalized.snapshot?.attendance[0].status).toBe('PRESENT');
    expect(finalized.snapshot?.activities[0].name).toBe('Suite');
  });

  it('revisions copy the snapshot and start as a fresh draft', () => {
    const original = newDraft('2026-09-17', 'ja', 'supervisor', '2026-09-17T09:00:00.000Z');
    original.previewText = 'original text';
    const finalized = finalizeReport(original, [], [], 'supervisor', '2026-09-17T18:00:00.000Z');
    const revision = createRevision(finalized, '2026-09-18T09:00:00.000Z');

    expect(revision.id).not.toBe(finalized.id);
    expect(revision.revisionOf).toBe(finalized.id);
    expect(revision.status).toBe('DRAFT');
    expect(revision.snapshot).toBeNull();
    expect(revision.previewText).toBe('original text');
    expect(revision.finalizedAt).toBeNull();
    // The original stays intact.
    expect(finalized.status).toBe('FINALIZED');
  });
});

describe('activity auto-seeding', () => {
  it('seeds from live plan state with planning-row staffing for the date', () => {
    const state = appState({
      totalCases: 120,
      casesCompleted: 30,
      currentTesters: 4,
      perHourPerTester: 4,
      projectNameEn: 'Login Suite',
      projectNameJa: 'ログインスイート',
      targetCompletionDate: '2026-09-20',
      planningRows: [
        { id: 'p1', date: '2026-09-17', plannedTesters: 6, absentTesters: 2, nonWorkingDay: false, note: '' },
      ],
    });
    const seeded = seedAutoActivities('en', state, '2026-09-17');
    expect(seeded).toHaveLength(1);
    expect(seeded[0].source).toBe('AUTO');
    expect(seeded[0].name).toBe('Login Suite');
    expect(seeded[0].memberCount).toBe(4); // 6 planned − 2 absent
    expect(seeded[0].completedCases).toBe(30);
    expect(seeded[0].totalCases).toBe(120);
    expect(seeded[0].dueDate).toBe('2026-09-20');
    expect(seeded[0].workingStatus).toBe('Working');

    // Japanese name resolution without plan modification.
    const seededJa = seedAutoActivities('ja', state, '2026-09-17');
    expect(seededJa[0].name).toBe('ログインスイート');
    expect(state.planningRows[0].plannedTesters).toBe(6);
  });

  it('falls back to current testers when no planning row matches the date', () => {
    const state = appState({ totalCases: 50, casesCompleted: 0, currentTesters: 3 });
    const seeded = seedAutoActivities('en', state, '2026-12-25');
    expect(seeded[0].memberCount).toBe(3);
    expect(seeded[0].workingStatus).toBe('Not Started');
  });
});

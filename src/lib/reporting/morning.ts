import type { AttendanceRecord, AttendanceStatus, Language, NextDayItem, RcsMember } from '../../types';
import { t } from '../../i18n';
import { isAttending, formatDueDateShort, overallAttendingTotal } from './sections';
import { absenceReasonLabel } from './absenceReasons';

/**
 * Morning report to SPO. Format (report language, headings fixed):
 *
 *   10/5
 *   ■Attendance
 *   7/8 members attending
 *   ※One of the members will be absent for the entire day due to poor health.
 *   ■Today's schedule
 *   　・Android 4.1.0 Regression
 *
 * Attendance input is absence-only (see renderAttendanceSection): members
 * without a record attend by default, and the overall total is the ACTIVE
 * roster size (or the record count when more rows exist — external people
 * / legacy full rosters).
 */
export interface MorningReportInput {
  /** Report date (YYYY-MM-DD). */
  date: string;
  records: AttendanceRecord[];
  members: readonly RcsMember[];
  schedule: NextDayItem[];
}

/** Overall attending/total pair across every team (shared with the EOD report). */
export function morningAttendingTotal(
  records: readonly AttendanceRecord[],
  members: readonly RcsMember[] = [],
): { attending: number; total: number } {
  return overallAttendingTotal(records, members);
}

/** The single overall "7/8 members attending" line. */
export function renderMorningAttendanceLine(
  lang: Language,
  records: readonly AttendanceRecord[],
  members: readonly RcsMember[] = [],
): string {
  const { attending, total } = morningAttendingTotal(records, members);
  return t(lang, 'morning.attendanceTotal', { attending, total });
}

/** One ※ note per non-attending record, composed from status + reason. */
export function renderMorningAbsenceNotes(lang: Language, records: readonly AttendanceRecord[]): string[] {
  return records
    .filter((r) => !isAttending(r.status))
    .map((r) => {
      const name = r.memberName.trim() === '' ? t(lang, 'columns.member') : r.memberName;
      const reason = absenceReasonLabel(lang, r.leaveType);
      return absenceNote(lang, r.status, name, reason);
    });
}

function absenceNote(lang: Language, status: AttendanceStatus, name: string, reason: string): string {
  const withReason = reason !== '';
  switch (status) {
    case 'PAID_LEAVE':
      return t(lang, withReason ? 'morning.paidLeaveWithReason' : 'morning.paidLeaveWithoutReason', { name, reason });
    case 'OTHER':
      return t(lang, withReason ? 'morning.otherWithReason' : 'morning.otherWithoutReason', { name, reason });
    default:
      return t(lang, withReason ? 'morning.absentWithReason' : 'morning.absentWithoutReason', { name, reason });
  }
}

/** The full morning report text. */
export function renderMorningReport(lang: Language, input: MorningReportInput): string {
  const lines: string[] = [
    formatDueDateShort(lang, input.date),
    t(lang, 'morning.attendanceHeading'),
    renderMorningAttendanceLine(lang, input.records, input.members),
    ...renderMorningAbsenceNotes(lang, input.records),
    t(lang, 'morning.scheduleHeading'),
    ...input.schedule.map((item) => `　・${item.text}`),
  ];
  return lines.join('\n');
}

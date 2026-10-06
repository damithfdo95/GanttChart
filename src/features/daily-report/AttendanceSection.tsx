import type { AttendanceRecord, AttendanceStatus, Language, RcsMember } from '../../types';
import { NON_ATTENDING_STATUSES } from '../../types';
import { t, type TranslationKey } from '../../i18n';
import { resolveMemberIdentity } from '../../domain/members';
import { ABSENCE_REASON_PRESETS, isPresetReason } from '../../lib/reporting/absenceReasons';

const STATUS_KEY: Record<AttendanceStatus, TranslationKey> = {
  PRESENT: 'attendance.statusPresent',
  ABSENT: 'attendance.statusAbsent',
  PAID_LEAVE: 'attendance.statusPaidLeave',
  HALF_DAY: 'attendance.statusHalfDay',
  LATE: 'attendance.statusLate',
  OTHER: 'attendance.statusOther',
};

interface AttendanceSectionProps {
  records: AttendanceRecord[];
  /** RCS member master (V6.9-A) — powers the member selector and resolution hints. */
  members?: RcsMember[];
  lang: Language;
  summary: string;
  readOnly?: boolean;
  onAdd: () => void;
  onUpdate: (id: string, patch: Partial<AttendanceRecord>) => void;
  onRemove: (id: string) => void;
}

/**
 * Attendance editor + auto-generated "x/y members attending" summary.
 *
 * V6.9-B — absence-only input: rows record ABSENCES (ABSENT / paid leave /
 * other); a member with no record for the date attends by default. The
 * status select offers only non-attending statuses for new input — legacy
 * explicit-attendance rows (PRESENT / LATE / HALF_DAY) keep their recorded
 * value selectable so nothing is silently rewritten.
 *
 * V6.9-A: the member cell is a member selector backed by the RCS Member
 * Master — active members first, inactive members still selectable (their
 * historical attendance remains). Choosing a member stores the stable
 * memberId plus a display-name snapshot; "Other" keeps the legacy free-text
 * workflow (external people are never forced into the master). Legacy rows
 * whose recorded name resolves to exactly one member show the current
 * identity next to the original recorded name — history is never rewritten.
 */
export function AttendanceSection({ records, members = [], lang, summary, readOnly, onAdd, onUpdate, onRemove }: AttendanceSectionProps) {
  const selectableMembers = [...members].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1; // active first
    return a.id.localeCompare(b.id);
  });
  const memberById = new Map(members.map((member) => [member.id, member]));
  return (
    <section className="dr-section">
      <h2>{t(lang, 'dailyReport.attendanceSection')}</h2>
      <p className="dr-summary">{t(lang, 'attendance.absenceOnlyHint')}</p>
      {records.length === 0 ? (
        <p className="dr-empty">{t(lang, 'attendance.noAbsences')}</p>
      ) : (
        <p className="dr-summary">{summary}</p>
      )}
      {readOnly !== true && (
        <div className="table-wrap">
          <table className="dr-table">
            <thead>
              <tr>
                <th scope="col">{t(lang, 'attendance.member')}</th>
                <th scope="col">{t(lang, 'columns.status')}</th>
                <th scope="col">{t(lang, 'columns.workingStart')}</th>
                <th scope="col">{t(lang, 'columns.workingEnd')}</th>
                <th scope="col">{t(lang, 'columns.leaveType')}</th>
                <th scope="col">{t(lang, 'columns.comment')}</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {records.map((record) => {
                const memberLabel =
                  record.memberName.trim() === ''
                    ? t(lang, 'columns.member')
                    : `${t(lang, 'columns.member')} (${record.memberName})`;
                const timeInvalid =
                  record.workingStart !== null &&
                  record.workingEnd !== null &&
                  record.workingEnd <= record.workingStart;
                const linkedMember = record.memberId !== undefined ? memberById.get(record.memberId) : undefined;
                const nameResolution = record.memberId === undefined ? resolveMemberIdentity(record.memberName, members) : null;
                return (
                  <tr key={record.id}>
                    <td>
                      <select
                        className="table-input"
                        aria-label={`${t(lang, 'attendance.member')} (${record.memberName || '—'})`}
                        value={record.memberId ?? ''}
                        onChange={(e) => {
                          const value = e.target.value;
                          if (value === '') {
                            // Other / external person: legacy free-text workflow.
                            onUpdate(record.id, { memberId: undefined });
                            return;
                          }
                          const member = memberById.get(value);
                          // memberName snapshots the current display name;
                          // the recorded history above is never rewritten.
                          // The member's team is kept as internal data
                          // (team is no longer displayed).
                          onUpdate(record.id, {
                            memberId: value,
                            memberName: member?.name ?? record.memberName,
                            team: member !== undefined ? member.team : record.team,
                          });
                        }}
                      >
                        <option value="">{t(lang, 'attendance.memberOther')}</option>
                        {selectableMembers.map((member) => (
                          <option key={member.id} value={member.id}>
                            {member.id} — {member.name}
                            {member.active ? '' : ` (${t(lang, 'members.inactive')})`}
                          </option>
                        ))}
                        {/* Keep an edited record selectable when its member is not in the master. */}
                        {record.memberId !== undefined && !memberById.has(record.memberId) ? (
                          <option value={record.memberId}>{record.memberId}</option>
                        ) : null}
                      </select>
                      {record.memberId === undefined ? (
                        <input
                          className="table-input attendance-name-input"
                          type="text"
                          aria-label={memberLabel}
                          placeholder={t(lang, 'attendance.memberNamePlaceholder')}
                          value={record.memberName}
                          onChange={(e) => onUpdate(record.id, { memberName: e.target.value })}
                        />
                      ) : null}
                      {linkedMember !== undefined && linkedMember.name !== record.memberName ? (
                        <div className="attendance-identity-hint">
                          {t(lang, 'attendance.recordedName')}: {record.memberName}
                        </div>
                      ) : null}
                      {nameResolution !== null && nameResolution.status === 'resolved' ? (
                        <div className="attendance-identity-hint">
                          {t(lang, 'attendance.resolvedAs', {
                            id: nameResolution.memberId,
                            name: memberById.get(nameResolution.memberId)?.name ?? nameResolution.memberId,
                          })}
                        </div>
                      ) : null}
                      {nameResolution !== null && nameResolution.status === 'ambiguous' ? (
                        <div className="attendance-identity-hint attendance-identity-warn">
                          {t(lang, 'attendance.ambiguousName')}
                        </div>
                      ) : null}
                      {nameResolution !== null && nameResolution.status === 'unmatched' ? (
                        <div className="attendance-identity-hint">{t(lang, 'attendance.identityUnresolved')}</div>
                      ) : null}
                    </td>
                    <td>
                      <select
                        className="table-input"
                        aria-label={`${t(lang, 'columns.status')} (${record.memberName || '—'})`}
                        value={record.status}
                        onChange={(e) => onUpdate(record.id, { status: e.target.value as AttendanceStatus })}
                      >
                        {NON_ATTENDING_STATUSES.map((status) => (
                          <option key={status} value={status}>
                            {t(lang, STATUS_KEY[status])}
                          </option>
                        ))}
                        {/* Legacy explicit-attendance rows keep their recorded value selectable. */}
                        {!NON_ATTENDING_STATUSES.includes(record.status) ? (
                          <option value={record.status}>{t(lang, STATUS_KEY[record.status])}</option>
                        ) : null}
                      </select>
                    </td>
                    <td>
                      <input
                        className="table-input"
                        type="time"
                        aria-label={`${t(lang, 'columns.workingStart')} (${record.memberName || '—'})`}
                        value={record.workingStart ?? ''}
                        onChange={(e) => onUpdate(record.id, { workingStart: e.target.value === '' ? null : e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        className={`table-input${timeInvalid ? ' table-input-invalid' : ''}`}
                        type="time"
                        aria-label={`${t(lang, 'columns.workingEnd')} (${record.memberName || '—'})`}
                        title={timeInvalid ? t(lang, 'attendance.timeInvalid') : undefined}
                        aria-invalid={timeInvalid}
                        value={record.workingEnd ?? ''}
                        onChange={(e) => onUpdate(record.id, { workingEnd: e.target.value === '' ? null : e.target.value })}
                      />
                    </td>
                    <td>
                      {/* Absence reason: preset dropdown + "Other" free text. */}
                      <select
                        className="table-input"
                        aria-label={`${t(lang, 'columns.leaveType')} (${record.memberName || '—'})`}
                        value={record.leaveType !== null && isPresetReason(record.leaveType) ? record.leaveType : ''}
                        onChange={(e) => {
                          // '' = Other (manual input): clear any preset reason;
                          // free text is typed in the input below.
                          onUpdate(record.id, { leaveType: e.target.value === '' ? null : e.target.value });
                        }}
                      >
                        <option value="">{t(lang, 'absenceReason.other')}</option>
                        {ABSENCE_REASON_PRESETS.map((preset) => (
                          <option key={preset.key} value={preset.key}>
                            {t(lang, preset.labelKey)}
                          </option>
                        ))}
                      </select>
                      {!isPresetReason(record.leaveType) ? (
                        <input
                          className="table-input attendance-reason-input"
                          type="text"
                          aria-label={`${t(lang, 'absenceReason.other')} (${record.memberName || '—'})`}
                          placeholder={t(lang, 'attendance.memberNamePlaceholder')}
                          value={record.leaveType ?? ''}
                          onChange={(e) => onUpdate(record.id, { leaveType: e.target.value === '' ? null : e.target.value })}
                        />
                      ) : null}
                    </td>
                    <td>
                      <textarea
                        className="table-input"
                        aria-label={`${t(lang, 'columns.comment')} (${record.memberName || '—'})`}
                        rows={1}
                        value={record.comment}
                        onChange={(e) => onUpdate(record.id, { comment: e.target.value })}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn-row-remove"
                        title={t(lang, 'buttons.remove')}
                        aria-label={`${t(lang, 'buttons.remove')} (${record.memberName || '—'})`}
                        onClick={() => onRemove(record.id)}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {readOnly !== true && (
        <button type="button" className="btn" onClick={onAdd}>
          {t(lang, 'buttons.add')}
        </button>
      )}
    </section>
  );
}


import { useMemo, useState } from 'react';
import type { AttendanceRecord, Language, ProjectRecord, RcsMember, TesterDailyPerformance, TesterProjectAssignment } from '../../types';
import { t, type TranslationKey } from '../../i18n';
import { formatDate, todayEpochDays } from '../../lib/dates/dates';
import { projectDisplayName } from '../../domain/projects';
import { findMemberById } from '../../domain/members';
import {
  createTesterAssignment,
  getAssignmentsForProject,
} from '../../domain/assignments';
import {
  applyTesterPerformanceSync,
  buildTesterPerformanceSyncPlan,
  calculateAttendanceConsistency,
  type AttendanceInconsistency,
  type TesterPerformanceSyncPlan,
} from '../../lib/calculations/testerAttribution';
import { AllocationEditor, type AllocationEntry } from './AllocationEditor';
import { TablePager } from '../../components/TablePager';
import { usePagedRows } from '../../lib/pagination/usePagedRows';

interface AssignmentDraft {
  memberId: string;
  startDate: string;
  endDate: string;
}

interface SyncSectionProps {
  lang: Language;
  /** Stable Project ID ("PRJ-001") of the active project ('' when none). */
  activeProjectId: string;
  activeProjectName: string;
  projects: readonly ProjectRecord[];
  assignments: readonly TesterProjectAssignment[];
  attendance: readonly AttendanceRecord[];
  members: readonly RcsMember[];
  /** Write helper: replaces one project's tester records array. */
  onProjectRecordsChange: (projectRecordId: string, records: readonly TesterDailyPerformance[]) => void;
  /** Applies one confirmed allocation for a date (upserts each entry). */
  onApplyAllocation: (projectId: string, date: string, entries: readonly AllocationEntry[]) => void;
  /** Workspace-level assignment mutation. */
  onUpsertAssignment: (assignment: TesterProjectAssignment) => void;
  onRemoveAssignment: (id: string) => void;
}

function attendanceStatusLabelKey(status: string): TranslationKey {
  switch (status) {
    case 'PRESENT':
      return 'attendance.statusPresent';
    case 'ABSENT':
      return 'attendance.statusAbsent';
    case 'PAID_LEAVE':
      return 'attendance.statusPaidLeave';
    case 'HALF_DAY':
      return 'attendance.statusHalfDay';
    case 'LATE':
      return 'attendance.statusLate';
    default:
      return 'attendance.statusOther';
  }
}

/**
 * V6.7 Part A workspace: tester assignments for the active project, the
 * idempotent tester-performance sync (preview → confirm), and the
 * non-destructive attendance cross-check. Nothing syncs automatically on
 * render — every write happens behind the explicit Sync buttons.
 */
export function SyncSection({
  lang,
  activeProjectId,
  activeProjectName,
  projects,
  assignments,
  attendance,
  members,
  onProjectRecordsChange,
  onApplyAllocation,
  onUpsertAssignment,
  onRemoveAssignment,
}: SyncSectionProps) {
  const today = formatDate(todayEpochDays());
  const [draft, setDraft] = useState<AssignmentDraft>({ memberId: '', startDate: today, endDate: '' });
  const [draftError, setDraftError] = useState<string | null>(null);
  const [preview, setPreview] = useState<TesterPerformanceSyncPlan | null>(null);
  const [showAttendance, setShowAttendance] = useState(false);
  const [syncApplied, setSyncApplied] = useState(false);

  const selectableMembers = useMemo(
    () => members.filter((member) => member.active).sort((a, b) => a.name.localeCompare(b.name)),
    [members],
  );

  const projectAssignments = useMemo(
    () => (activeProjectId === '' ? [] : getAssignmentsForProject(assignments, activeProjectId)),
    [assignments, activeProjectId],
  );
  // Assignments accumulate with team churn (chronological, newest last) —
  // paginated per project, starting on the newest assignment.
  const assignmentsPager = usePagedRows(projectAssignments, 10, { resetKey: activeProjectId, initialPage: 'last' });

  const syncPlan = useMemo(
    () => buildTesterPerformanceSyncPlan(projects, assignments, members),
    [projects, assignments, members],
  );

  // V6.9-B §24: the current-project plan — a current-project sync never
  // touches other projects' records.
  const currentProjectPlan = useMemo(
    () =>
      activeProjectId === ''
        ? null
        : buildTesterPerformanceSyncPlan(projects, assignments, members, { projectIds: [activeProjectId] }),
    [projects, assignments, members, activeProjectId],
  );

  const allRecords = useMemo(
    () => projects.flatMap((p) => p.inputs.testerDailyPerformance ?? []),
    [projects],
  );
  const attendanceWarnings = useMemo(
    () => calculateAttendanceConsistency(allRecords, attendance, members),
    [allRecords, attendance, members],
  );

  const handleAddAssignment = (): void => {
    if (draft.memberId === '') {
      setDraftError(t(lang, 'errors.assignmentTesterRequired'));
      return;
    }
    const member = findMemberById(members, draft.memberId);
    if (member === undefined) {
      setDraftError(t(lang, 'errors.assignmentTesterRequired'));
      return;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(draft.startDate) === false) {
      setDraftError(t(lang, 'errors.assignmentDateInvalid'));
      return;
    }
    if (draft.endDate !== '' && /^\d{4}-\d{2}-\d{2}$/.test(draft.endDate) === false) {
      setDraftError(t(lang, 'errors.assignmentDateInvalid'));
      return;
    }
    if (draft.endDate !== '' && draft.endDate < draft.startDate) {
      setDraftError(t(lang, 'errors.assignmentEndBeforeStart'));
      return;
    }
    setDraftError(null);
    onUpsertAssignment(
      createTesterAssignment({
        projectId: activeProjectId,
        memberId: member.id,
        testerName: member.name,
        team: member.team,
        startDate: draft.startDate,
        endDate: draft.endDate === '' ? undefined : draft.endDate,
        active: true,
      }),
    );
    setDraft({ memberId: '', startDate: draft.endDate !== '' && draft.endDate >= today ? draft.endDate : today, endDate: '' });
  };

  const handlePreview = (): void => {
    setPreview(syncPlan);
    setSyncApplied(false);
  };

  /** Apply a sync plan through the single per-project write helper (§24/§25). */
  const applyPlan = (plan: TesterPerformanceSyncPlan): void => {
    const byProjectId = new Map<string, ProjectRecord>();
    for (const project of projects) byProjectId.set(project.projectId, project);
    const itemsByProject = new Map<string, typeof plan.items>();
    for (const item of plan.items) {
      if (item.action !== 'create' && item.action !== 'update') continue;
      const project = byProjectId.get(item.record.projectId);
      if (project === undefined) continue;
      const list = itemsByProject.get(project.id) ?? [];
      list.push(item);
      itemsByProject.set(project.id, list);
    }
    for (const [projectRecordId, items] of itemsByProject) {
      const project = projects.find((p) => p.id === projectRecordId);
      if (project === undefined) continue;
      onProjectRecordsChange(
        projectRecordId,
        applyTesterPerformanceSync(project.inputs.testerDailyPerformance ?? [], items, members),
      );
    }
    setPreview(plan);
    setSyncApplied(true);
  };

  const handleSync = (scope: 'current' | 'all'): void => {
    // Bulk write: confirm first (authored locale keys confirmSync /
    // syncApplied), then apply through the single write helper. The scope
    // only selects WHICH projects are visited — manual overrides,
    // manual records and identities are preserved in both (§25).
    const plan = scope === 'current' ? currentProjectPlan : syncPlan;
    if (plan === null || plan.toCreate + plan.toUpdate === 0) return;
    const confirmKey: TranslationKey = scope === 'current' ? 'performance.confirmSyncCurrent' : 'performance.confirmSync';
    if (!window.confirm(t(lang, confirmKey, scope === 'current' ? { project: activeProjectName } : undefined))) return;
    applyPlan(plan);
  };

  const hasSyncChanges = syncPlan.toCreate > 0 || syncPlan.toUpdate > 0;
  const hasCurrentSyncChanges = currentProjectPlan !== null && (currentProjectPlan.toCreate > 0 || currentProjectPlan.toUpdate > 0);

  return (
    <>
      <section className="dr-section">
        <h2>{t(lang, 'performance.syncTitle')}</h2>
        <p className="dr-summary">{t(lang, 'performance.syncDescription')}</p>
        <div className="dr-button-row">
          <button type="button" className="btn" onClick={handlePreview}>
            {t(lang, 'performance.syncPreview')}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => handleSync('current')}
            disabled={!hasCurrentSyncChanges}
            title={
              currentProjectPlan === null
                ? t(lang, 'performance.noActiveProject')
                : hasCurrentSyncChanges
                  ? undefined
                  : t(lang, 'performance.syncNoChanges')
            }
          >
            {t(lang, 'performance.syncCurrentProject')}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => handleSync('all')}
            disabled={!hasSyncChanges}
            title={hasSyncChanges ? undefined : t(lang, 'performance.syncNoChanges')}
          >
            {t(lang, 'performance.syncApply')}
          </button>
        </div>
        {preview !== null ? (
          <div className="dr-summary">
            <p>{t(lang, 'performance.syncToCreate', { count: preview.toCreate })}</p>
            <p>{t(lang, 'performance.syncToUpdate', { count: preview.toUpdate })}</p>
            <p>{t(lang, 'performance.syncUnchanged', { count: preview.unchanged })}</p>
            <p>{t(lang, 'performance.syncPreserved', { count: preview.manualPreserved })}</p>
            {preview.unassignedDates.length > 0 ? (
              <p>{t(lang, 'performance.syncUnassigned', { count: preview.unassignedDates.length })}</p>
            ) : null}
            {!hasSyncChanges ? <p>{t(lang, 'performance.syncNoChanges')}</p> : null}
          </div>
        ) : null}
        {syncApplied ? (
          <p className="data-controls-message ok" role="status">
            {t(lang, 'performance.syncApplied')}
          </p>
        ) : null}
      </section>

      <section className="dr-section">
        <h2>{t(lang, 'performance.assignmentTitle')}{activeProjectName === '' ? '' : ` — ${activeProjectName}`}</h2>
        <form
          className="input-grid"
          onSubmit={(e) => {
            e.preventDefault();
            handleAddAssignment();
          }}
        >
          <label>
            {t(lang, 'performance.testerName')}
            <select
              className="input"
              value={draft.memberId}
              onChange={(e) => setDraft((prev) => ({ ...prev, memberId: e.target.value }))}
            >
              <option value="">{t(lang, 'performance.testerName')}</option>
              {selectableMembers.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name} ({member.role})
                </option>
              ))}
            </select>
          </label>
          <label>
            {t(lang, 'performance.assignmentStartDate')}
            <input
              className="input"
              type="date"
              value={draft.startDate}
              onChange={(e) => setDraft((prev) => ({ ...prev, startDate: e.target.value }))}
            />
          </label>
          <label>
            {t(lang, 'performance.assignmentEndDate')}
            <input
              className="input"
              type="date"
              value={draft.endDate}
              onChange={(e) => setDraft((prev) => ({ ...prev, endDate: e.target.value }))}
            />
          </label>
          {draftError !== null ? (
            <p className="field-error" role="alert">
              {draftError}
            </p>
          ) : null}
          <div className="dr-button-row">
            <button
              type="submit"
              className="btn"
              disabled={activeProjectId === '' || selectableMembers.length === 0}
              title={activeProjectId === '' ? t(lang, 'performance.noActiveProject') : undefined}
            >
              {t(lang, 'performance.assignmentAdd')}
            </button>
          </div>
        </form>
        {projectAssignments.length === 0 ? (
          <p className="dr-empty">{t(lang, 'performance.assignmentNone')}</p>
        ) : (
          <div className="table-wrap">
            <table className="dr-table">
              <thead>
                <tr>
                  <th scope="col">{t(lang, 'performance.testerName')}</th>
                  <th scope="col">{t(lang, 'performance.assignmentStartDate')}</th>
                  <th scope="col">{t(lang, 'performance.assignmentEndDate')}</th>
                  <th scope="col">{t(lang, 'members.status')}</th>
                  <th scope="col">{t(lang, 'columns.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {assignmentsPager.pagedRows.map((assignment) => {
                  const member = assignment.memberId !== undefined ? findMemberById(members, assignment.memberId) : undefined;
                  return (
                    <tr key={assignment.id}>
                      <td>
                        {member !== undefined
                          ? member.name
                          : `${assignment.testerName ?? '—'} (${t(lang, 'performance.legacyAssignment')})`}
                      </td>
                      <td>{assignment.startDate}</td>
                      <td>{assignment.endDate ?? '—'}</td>
                      <td>
                        {member !== undefined && !member.active
                          ? t(lang, 'members.inactive')
                          : assignment.active
                            ? t(lang, 'performance.assignmentActive')
                            : t(lang, 'performance.assignmentInactive')}
                      </td>
                      <td className="dr-row-actions">
                        <button
                          type="button"
                          className="btn"
                          onClick={() => onUpsertAssignment({ ...assignment, active: !assignment.active })}
                        >
                          {t(lang, 'performance.assignmentToggleActive')}
                        </button>
                        <button
                          type="button"
                          className="btn btn-danger"
                          onClick={() => {
                            if (window.confirm(t(lang, 'performance.confirmRemoveAssignment'))) {
                              onRemoveAssignment(assignment.id);
                            }
                          }}
                        >
                          {t(lang, 'buttons.remove')}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <TablePager lang={lang} pager={assignmentsPager} />
      </section>

      <section className="dr-section">
        <h2>{t(lang, 'performance.allocationTitle')}</h2>
        <p className="dr-summary">{t(lang, 'performance.allocationDescription')}</p>
        <AllocationEditor
          lang={lang}
          activeProjectId={activeProjectId}
          projects={projects}
          assignments={assignments}
          members={members}
          attendance={attendance}
          onApply={onApplyAllocation}
        />
      </section>

      <section className="dr-section">
        <h2>{t(lang, 'performance.attendanceCheck')}</h2>
        {attendanceWarnings.length === 0 ? (
          <p className="dr-empty">{t(lang, 'performance.attendanceNone')}</p>
        ) : (
          <>
            <p className="dr-summary">
              ⚠ {t(lang, 'performance.attendanceCheck')} — {t(lang, 'performance.attendanceRecordsRequireReview', { count: attendanceWarnings.length })}
            </p>
            <div className="dr-button-row">
              <button type="button" className="btn" onClick={() => setShowAttendance((prev) => !prev)}>
                {showAttendance ? t(lang, 'buttons.close') : t(lang, 'performance.attendanceCheck')}
              </button>
            </div>
            {showAttendance ? <AttendanceWarningList lang={lang} warnings={attendanceWarnings} projects={projects} /> : null}
          </>
        )}
      </section>
    </>
  );
}

function AttendanceWarningList({
  lang,
  warnings,
  projects,
}: {
  lang: Language;
  warnings: readonly AttendanceInconsistency[];
  projects: readonly ProjectRecord[];
}) {
  // Warnings accumulate with every inconsistent day — paginated.
  const pager = usePagedRows(warnings, 10);
  const nameOf = (projectId: string): string => {
    const project = projects.find((p) => p.projectId === projectId);
    return project !== undefined ? projectDisplayName(project, lang) : '—';
  };
  return (
    <>
      <table className="dr-table">
        <thead>
          <tr>
            <th>{t(lang, 'columns.date')}</th>
            <th>{t(lang, 'performance.tester')}</th>
            <th>{t(lang, 'performance.projectScope')}</th>
            <th>{t(lang, 'performance.attendancePotentialInconsistency')}</th>
          </tr>
        </thead>
        <tbody>
          {pager.pagedRows.map((warning) => (
            <tr key={`${warning.projectId}-${warning.date}-${warning.testerName}`}>
              <td>{warning.date}</td>
              <td>{warning.testerName}</td>
              <td>{nameOf(warning.projectId)}</td>
              <td>
                {t(lang, 'performance.attendanceAbsent', {
                  status: t(lang, attendanceStatusLabelKey(warning.attendanceStatus ?? 'OTHER')),
                  cases: warning.casesTested,
                })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <TablePager lang={lang} pager={pager} />
    </>
  );
}

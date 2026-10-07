import { useMemo, useState } from 'react';
import type { AttendanceRecord, AttendanceStatus, Language, PerformanceRecordSource, ProjectRecord, RcsMember, TesterProjectAssignment } from '../../types';
import { t, type TranslationKey } from '../../i18n';
import {
  getAssignedTestersForDate,
  getDailyExecutionFacts,
  suggestAttendanceAwareAllocation,
  type DailyExecutionFact,
} from '../../lib/calculations/testerAttribution';
import {
  validateGranularAllocation,
  type GranularMetricKey,
  type GranularMemberAllocation,
} from '../../lib/validation/validateMember';
import { assignmentIdentityKey, attendanceIdentityKey, findMemberById } from '../../domain/members';
import { TablePager } from '../../components/TablePager';
import { usePagedRows } from '../../lib/pagination/usePagedRows';

/** One member/tester allocation the supervisor confirmed for a date (V6.9-B §11). */
export interface AllocationEntry {
  memberId?: string;
  testerName: string;
  casesTested: number;
  casesPassed?: number;
  casesFailed?: number;
  casesNotApplicable?: number;
  casesBlocked?: number;
  casesRetest?: number;
  casesQuestioned?: number;
  casesSpoAssigned?: number;
  source: PerformanceRecordSource;
}

interface AllocationEditorProps {
  lang: Language;
  activeProjectId: string;
  projects: readonly ProjectRecord[];
  assignments: readonly TesterProjectAssignment[];
  members: readonly RcsMember[];
  attendance: readonly AttendanceRecord[];
  onApply: (projectId: string, date: string, entries: readonly AllocationEntry[]) => void;
}

function attendanceStatusLabelKey(status: AttendanceStatus): TranslationKey {
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

/** Editable metrics (columns) — casesTested plus the seven granular statuses. */
const METRIC_KEYS: readonly GranularMetricKey[] = [
  'casesTested',
  'casesPassed',
  'casesFailed',
  'casesNotApplicable',
  'casesBlocked',
  'casesRetest',
  'casesQuestioned',
  'casesSpoAssigned',
];

const METRIC_HEADER_KEY: Record<GranularMetricKey, TranslationKey> = {
  casesTested: 'performance.casesTestedField',
  casesPassed: 'columns.pass',
  casesFailed: 'fields.casesFailed',
  casesNotApplicable: 'columns.notApplicable',
  casesBlocked: 'columns.blocked',
  casesRetest: 'fields.casesRetest',
  casesQuestioned: 'fields.casesQuestioned',
  casesSpoAssigned: 'columns.spoAssigned',
};

interface AssignedTesterView {
  key: string;
  memberId?: string;
  testerName: string;
  attendance: AttendanceStatus | undefined;
}

interface DateRow {
  fact: Omit<DailyExecutionFact, 'projectId'>;
  assigned: readonly TesterProjectAssignment[];
  suggestion: ReturnType<typeof suggestAttendanceAwareAllocation>;
  withAttendance: readonly AssignedTesterView[];
}

/**
 * Assisted granular allocation editor (V6.8 §17–§21, V6.9-B §14–§23): for
 * each day with executed cases and assigned testers, the attendance-aware
 * suggestion is pre-filled for EVERY metric (Cases, Pass, Fail, NA,
 * Blocked, Retest, Questioned, SPO) using the same eligible-member set
 * (§22). The supervisor can adjust every value; the per-metric unassigned
 * remainder is always visible and never silently distributed. Metrics
 * without source data stay disabled — undefined historical values are
 * never reconstructed (§13). Edited allocations are applied as manual
 * overrides that synchronization never overwrites (§18/§19).
 */
export function AllocationEditor({ lang, activeProjectId, projects, assignments, members, attendance, onApply }: AllocationEditorProps) {
  // values[date][identityKey][metric] = raw string while typing.
  const [values, setValues] = useState<Record<string, Record<string, Partial<Record<GranularMetricKey, string>>>>>({});
  const [editedDates, setEditedDates] = useState<Set<string>>(new Set());

  const rows: DateRow[] = useMemo(() => {
    if (activeProjectId === '') return [];
    const project = projects.find((p) => p.projectId === activeProjectId);
    if (project === undefined) return [];
    // V6.9-A/V6.9-B: attendance is keyed by the canonical identity
    // (memberId → date-aware name/history resolution → legacy trimmed name)
    // so an attendance row recorded under a member id matches a legacy
    // name-based assignment of the same person, and vice versa.
    const attendanceByKeyDate = new Map<string, AttendanceStatus>();
    for (const record of attendance) {
      attendanceByKeyDate.set(`${attendanceIdentityKey(record, members)}\u0000${record.date}`, record.status);
    }
    const result: DateRow[] = [];
    for (const fact of getDailyExecutionFacts(project.inputs)) {
      const assigned = getAssignedTestersForDate(assignments, activeProjectId, fact.date, members);
      if (assigned.length === 0) continue;
      const withAttendance = assigned.map((assignment) => {
        const member = assignment.memberId !== undefined ? findMemberById(members, assignment.memberId) : undefined;
        const displayName = member?.name ?? assignment.testerName ?? '';
        return {
          key: assignmentIdentityKey(assignment, members),
          ...(assignment.memberId !== undefined ? { memberId: assignment.memberId } : {}),
          testerName: displayName,
          attendance: attendanceByKeyDate.get(`${assignmentIdentityKey(assignment, members)}\u0000${fact.date}`),
        };
      });
      // Granular totals come straight from the fact: undefined metrics are
      // never allocated (§13) — only defined ones are suggested (§17).
      result.push({
        fact,
        assigned,
        suggestion: suggestAttendanceAwareAllocation(
          fact.casesExecuted,
          withAttendance,
          {
            casesPassed: fact.casesPassed ?? undefined,
            casesFailed: fact.casesFailed ?? undefined,
            casesNotApplicable: fact.casesNotApplicable ?? undefined,
            casesBlocked: fact.casesBlocked ?? undefined,
            casesRetest: fact.casesRetest ?? undefined,
            casesQuestioned: fact.casesQuestioned ?? undefined,
            casesSpoAssigned: fact.casesSpoAssigned ?? undefined,
          },
        ),
        withAttendance,
      });
    }
    return result.sort((a, b) => b.fact.date.localeCompare(a.fact.date));
  }, [activeProjectId, projects, assignments, members, attendance]);

  // One tbody group per executed date (newest-first) — paginated by date so
  // a group's tester rows are never split across pages. Switching projects
  // resets to the first page of the new project's dates.
  const pager = usePagedRows(rows, 10, { resetKey: activeProjectId });

  const displayFor = (row: DateRow, key: string, metric: GranularMetricKey): string => {
    const edited = values[row.fact.date]?.[key]?.[metric];
    if (edited !== undefined) return edited;
    const allocation = row.suggestion.allocations.find((candidate) => candidate.key === key);
    if (allocation === undefined) return '0';
    // The split's tested total is named `cases` (§11), the metric key `casesTested`.
    return String(metric === 'casesTested' ? allocation.cases : allocation[metric] ?? 0);
  };

  const handleChange = (date: string, key: string, metric: GranularMetricKey, next: string): void => {
    setValues((prev) => ({
      ...prev,
      [date]: { ...(prev[date] ?? {}), [key]: { ...(prev[date]?.[key] ?? {}), [metric]: next } },
    }));
    setEditedDates((prev) => new Set(prev).add(date));
  };

  const handleApply = (row: DateRow): void => {
    const edited = editedDates.has(row.fact.date);
    const entries: AllocationEntry[] = row.suggestion.allocations.map((allocation) => ({
      ...(allocation.memberId !== undefined ? { memberId: allocation.memberId } : {}),
      testerName: allocation.testerName,
      casesTested: Math.max(0, Number(displayFor(row, allocation.key, 'casesTested')) || 0),
      ...('casesPassed' in allocation && allocation.casesPassed !== undefined
        ? { casesPassed: Math.max(0, Number(displayFor(row, allocation.key, 'casesPassed')) || 0) }
        : {}),
      ...('casesFailed' in allocation && allocation.casesFailed !== undefined
        ? { casesFailed: Math.max(0, Number(displayFor(row, allocation.key, 'casesFailed')) || 0) }
        : {}),
      ...('casesNotApplicable' in allocation && allocation.casesNotApplicable !== undefined
        ? { casesNotApplicable: Math.max(0, Number(displayFor(row, allocation.key, 'casesNotApplicable')) || 0) }
        : {}),
      ...('casesBlocked' in allocation && allocation.casesBlocked !== undefined
        ? { casesBlocked: Math.max(0, Number(displayFor(row, allocation.key, 'casesBlocked')) || 0) }
        : {}),
      ...('casesRetest' in allocation && allocation.casesRetest !== undefined
        ? { casesRetest: Math.max(0, Number(displayFor(row, allocation.key, 'casesRetest')) || 0) }
        : {}),
      ...('casesQuestioned' in allocation && allocation.casesQuestioned !== undefined
        ? { casesQuestioned: Math.max(0, Number(displayFor(row, allocation.key, 'casesQuestioned')) || 0) }
        : {}),
      ...('casesSpoAssigned' in allocation && allocation.casesSpoAssigned !== undefined
        ? { casesSpoAssigned: Math.max(0, Number(displayFor(row, allocation.key, 'casesSpoAssigned')) || 0) }
        : {}),
      source: edited ? 'manualOverride' : 'assisted',
    }));
    onApply(activeProjectId, row.fact.date, entries);
  };

  if (activeProjectId === '') {
    return <p className="dr-empty">{t(lang, 'performance.noActiveProject')}</p>;
  }
  if (rows.length === 0) {
    return <p className="dr-empty">{t(lang, 'performance.allocationNoDates')}</p>;
  }

  const totalsOf = (fact: Omit<DailyExecutionFact, 'projectId'>): Partial<Record<GranularMetricKey, number | null>> => ({
    casesTested: fact.casesExecuted,
    casesPassed: fact.casesPassed,
    casesFailed: fact.casesFailed,
    casesNotApplicable: fact.casesNotApplicable,
    casesBlocked: fact.casesBlocked,
    casesRetest: fact.casesRetest,
    casesQuestioned: fact.casesQuestioned,
    casesSpoAssigned: fact.casesSpoAssigned,
  });

  return (
    <>
      <div className="table-wrap">
        <table className="dr-table allocation-table">
        <thead>
          <tr>
            <th scope="col">{t(lang, 'columns.date')}</th>
            <th scope="col">{t(lang, 'performance.tester')}</th>
            <th scope="col">{t(lang, 'members.status')}</th>
            {METRIC_KEYS.map((metric) => (
              <th key={metric} scope="col" className="num">{t(lang, METRIC_HEADER_KEY[metric])}</th>
            ))}
            <th scope="col">{t(lang, 'columns.actions')}</th>
          </tr>
        </thead>
        {pager.pagedRows.map((row) => {
          const date = row.fact.date;
          const totals = totalsOf(row.fact);
          const memberAllocations: GranularMemberAllocation[] = row.suggestion.allocations.map((allocation) => ({
            member: allocation.testerName,
            casesTested: Math.max(0, Number(displayFor(row, allocation.key, 'casesTested')) || 0),
            casesPassed: Math.max(0, Number(displayFor(row, allocation.key, 'casesPassed')) || 0),
            casesFailed: Math.max(0, Number(displayFor(row, allocation.key, 'casesFailed')) || 0),
            casesNotApplicable: Math.max(0, Number(displayFor(row, allocation.key, 'casesNotApplicable')) || 0),
            casesBlocked: Math.max(0, Number(displayFor(row, allocation.key, 'casesBlocked')) || 0),
            casesRetest: Math.max(0, Number(displayFor(row, allocation.key, 'casesRetest')) || 0),
            casesQuestioned: Math.max(0, Number(displayFor(row, allocation.key, 'casesQuestioned')) || 0),
            casesSpoAssigned: Math.max(0, Number(displayFor(row, allocation.key, 'casesSpoAssigned')) || 0),
          }));
          const validation = validateGranularAllocation(totals, memberAllocations);
          return (
            <tbody key={date}>
              <tr className="allocation-date-row">
                <td colSpan={3 + METRIC_KEYS.length + 1}>
                  {date}
                  {editedDates.has(date) ? (
                    <span className="tag tag-completes"> {t(lang, 'allocation.manualOverrideTag')}</span>
                  ) : null}
                  {' '}
                  <span className="gantt-project-meta">
                    {row.suggestion.basis === 'attendance'
                      ? t(lang, 'performance.allocationSuggestedAttendance')
                      : row.suggestion.basis === 'none'
                        ? t(lang, 'performance.allocationSuggestedNone')
                        : ''}
                  </span>
                </td>
              </tr>
              {row.suggestion.allocations.map((allocation) => {
                const tester = row.withAttendance.find((candidate) => candidate.key === allocation.key);
                return (
                  <tr key={`${date}-${allocation.key}`}>
                    <td />
                    <td>
                      {allocation.testerName}
                    </td>
                    <td className="note-cell">
                      {tester?.attendance !== undefined ? t(lang, attendanceStatusLabelKey(tester.attendance)) : '—'}
                    </td>
                    {METRIC_KEYS.map((metric) => {
                      const known = totals[metric] !== null && totals[metric] !== undefined;
                      return (
                        <td key={metric} className="num">
                          <input
                            className="input input-cell allocation-input"
                            type="number"
                            min={0}
                            step={1}
                            disabled={!known}
                            aria-label={`${t(lang, METRIC_HEADER_KEY[metric])} — ${allocation.testerName} (${date})`}
                            value={displayFor(row, allocation.key, metric)}
                            onChange={(e) => handleChange(date, allocation.key, metric, e.target.value)}
                          />
                        </td>
                      );
                    })}
                    <td />
                  </tr>
                );
              })}
              {/* Unassigned row: the per-metric remainder is always visible (§12/§23). */}
              <tr className="allocation-summary-row">
                <td />
                <td colSpan={2}>{t(lang, 'allocation.unassigned')}</td>
                {METRIC_KEYS.map((metric) => {
                  const total = totals[metric];
                  const unassigned = validation.unassigned[metric];
                  return (
                    <td key={metric} className="num">
                      {total === null || total === undefined || unassigned === undefined ? '—' : unassigned}
                    </td>
                  );
                })}
                <td />
              </tr>
              {/* Total row: the project's own execution totals (§14). */}
              <tr className="allocation-summary-row allocation-total-row">
                <td />
                <td colSpan={2}>{t(lang, 'allocation.projectTotal')}</td>
                {METRIC_KEYS.map((metric) => {
                  const total = totals[metric];
                  return (
                    <td key={metric} className="num">
                      {total === null || total === undefined ? '—' : total}
                    </td>
                  );
                })}
                <td>
                  <button
                    type="button"
                    className="btn"
                    disabled={!validation.isValid}
                    title={!validation.isValid ? t(lang, 'allocation.invalidTitle') : undefined}
                    onClick={() => handleApply(row)}
                  >
                    {t(lang, 'performance.allocationApply')}
                  </button>
                </td>
              </tr>
              {!validation.isValid ? (
                <tr className="allocation-error-row">
                  <td colSpan={3 + METRIC_KEYS.length + 1}>
                    <p className="field-error" role="alert">
                      {validation.overAllocated.length > 0
                        ? t(lang, 'allocation.overAllocated', {
                            metrics: validation.overAllocated.map((metric) => t(lang, METRIC_HEADER_KEY[metric])).join(', '),
                          })
                        : ''}
                      {validation.overAllocated.length > 0 && validation.unsupported.length > 0 ? ' ' : ''}
                      {validation.unsupported.length > 0
                        ? t(lang, 'allocation.unsupportedMetric', {
                            metrics: validation.unsupported.map((metric) => t(lang, METRIC_HEADER_KEY[metric])).join(', '),
                          })
                        : ''}
                      {validation.memberOverlaps.length > 0
                        ? ` ${t(lang, 'allocation.memberOverlap', {
                            member: validation.memberOverlaps[0].member,
                            sum: validation.memberOverlaps[0].sum,
                            cases: validation.memberOverlaps[0].casesTested,
                          })}`
                        : ''}
                    </p>
                  </td>
                </tr>
              ) : null}
            </tbody>
          );
        })}
      </table>
      </div>
      <TablePager lang={lang} pager={pager} />
    </>
  );
}

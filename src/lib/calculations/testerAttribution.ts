import type {
  AttendanceRecord,
  AttendanceStatus,
  DailyActualSnapshot,
  DailyExecutionEntry,
  ProjectRecord,
  QaInputs,
  RcsMember,
  TesterDailyPerformance,
  TesterProjectAssignment,
} from '../../types';
import { generateId } from '../id';
import { isAttending } from '../reporting/sections';
import { assignmentIdentityKey, attendanceIdentityKey, findMemberById, testerIdentityKey } from '../../domain/members';
import { entryCompletedCases } from './dailyExecuted';

/**
 * V6.7/V6.8 — Tester execution attribution & synchronization (pure; no
 * React, no storage, no clock, no browser APIs).
 *
 * Attribution strategy (Level 2 — assisted): the existing execution model
 * records project-level totals only (DailyActualSnapshot deltas), so
 * individual case ownership cannot be derived from it. Attribution is built
 * from the two facts the system DOES know — which testers were assigned to
 * the project on a date, and how many cases the project executed that day —
 * as an equal-split (V6.8: or attendance-aware) PROPOSAL that the
 * supervisor explicitly confirms via the sync controls or the allocation
 * editor. Nothing is invented silently: dates without an assignment are
 * reported, never guessed, and the manual V6.6 workflow remains available
 * as the fallback.
 *
 * V6.8 identity: records are keyed by RCS memberId wherever the assignment
 * provides one; legacy name-based assignments keep the V6.7 behavior. The
 * canonical sync identity is the existing (projectId, date, tester) key,
 * resolved through the member master — so memberId and legacy name records
 * for the same person share one slot instead of duplicating.
 *
 * Synchronization is idempotent: records with a manual source
 * (manual / manualOverride / legacy-unknown) are never overwritten, and
 * re-running a sync on unchanged source data produces zero changes.
 */

// ---- Assignment matching -------------------------------------------------------

/**
 * Assignments covering a project on a date: active, started on or before
 * the date, and not yet ended. Sorted by identity key (memberId, else the
 * legacy tester name) for a deterministic — and therefore idempotent —
 * allocation order.
 */
export function getAssignedTestersForDate(
  assignments: readonly TesterProjectAssignment[],
  projectId: string,
  date: string,
  members: readonly RcsMember[] = [],
): TesterProjectAssignment[] {
  return assignments
    .filter(
      (assignment) =>
        assignment.projectId === projectId &&
        assignment.active &&
        assignment.startDate <= date &&
        (assignment.endDate === undefined || assignment.endDate >= date),
    )
    .sort((a, b) => assignmentIdentityKey(a, members).localeCompare(assignmentIdentityKey(b, members)));
}

// ---- Daily execution facts (project-level, from the V6.5 snapshot chain) ------

/**
 * One project's executed cases on one date, derived as the delta between
 * consecutive DailyActualSnapshot entries (the same chronological logic as
 * buildExecutionHistory). Granular breakdowns are null when either snapshot
 * predates V6.5 — unknown values are never reconstructed from aggregates.
 */
export interface DailyExecutionFact {
  projectId: string;
  date: string;
  casesExecuted: number;
  casesPassed: number | null;
  casesFailed: number | null;
  casesNotApplicable: number | null;
  casesBlocked: number | null;
  casesRetest: number | null;
  casesQuestioned: number | null;
  casesSpoAssigned: number | null;
}

/** Granular breakdown keys on the derived per-day fact. */
type GranularFactKey = Exclude<keyof DailyExecutionFact, 'projectId' | 'date' | 'casesExecuted'>;

/** Numeric granular breakdown keys on a snapshot. */
type GranularSnapshotKey =
  | 'casesPassed'
  | 'casesFailed'
  | 'casesNotApplicable'
  | 'casesBlocked'
  | 'casesRetest'
  | 'casesQuestioned'
  | 'spoAssigned';

/** Granular snapshot fields mapped to their TesterDailyPerformance equivalents. */
const GRANULAR_FIELDS: readonly { snapshot: GranularSnapshotKey; fact: GranularFactKey }[] = [
  { snapshot: 'casesPassed', fact: 'casesPassed' },
  { snapshot: 'casesFailed', fact: 'casesFailed' },
  { snapshot: 'casesNotApplicable', fact: 'casesNotApplicable' },
  { snapshot: 'casesBlocked', fact: 'casesBlocked' },
  { snapshot: 'casesRetest', fact: 'casesRetest' },
  { snapshot: 'casesQuestioned', fact: 'casesQuestioned' },
  { snapshot: 'spoAssigned', fact: 'casesSpoAssigned' },
];

/** Per-day executed deltas for one project (facts with 0/negative execution are omitted). */
export function getDailyExecutionFacts(inputs: QaInputs): Omit<DailyExecutionFact, 'projectId'>[] {
  const snapshots = inputs.dailyActuals ?? [];
  const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const facts: Omit<DailyExecutionFact, 'projectId'>[] = [];
  let previous: DailyActualSnapshot | null = null;
  for (const snapshot of sorted) {
    const casesExecuted = snapshot.executed - (previous?.executed ?? 0);
    if (casesExecuted > 0) {
      const fact: Omit<DailyExecutionFact, 'projectId'> = {
        date: snapshot.date,
        casesExecuted,
        casesPassed: null,
        casesFailed: null,
        casesNotApplicable: null,
        casesBlocked: null,
        casesRetest: null,
        casesQuestioned: null,
        casesSpoAssigned: null,
      };
      for (const field of GRANULAR_FIELDS) {
        const current = snapshot[field.snapshot];
        // First snapshot: cumulative from zero. A later snapshot missing the
        // field (legacy) leaves the delta unknown — never reconstructed.
        const prev = previous === null ? 0 : previous[field.snapshot];
        if (current !== undefined && prev !== undefined) {
          fact[field.fact] = Math.max(0, current - prev);
        }
      }
      facts.push(fact);
    }
    previous = snapshot;
  }
  return facts;
}

// ---- Allocation ----------------------------------------------------------------

/**
 * A date where the project-level daily execution entry and the tester-level
 * records disagree: the entry's completed cases vs Σ casesTested across
 * that date's tester records. Purely informational — tester records never
 * change the project totals; the badge just tells the supervisor the two
 * views tell different stories for that date.
 */
export interface AttributionMismatch {
  date: string;
  /** Completed cases recorded in the project's daily execution entry. */
  entryCompleted: number;
  /** Σ casesTested across the tester records for that date. */
  testersTotal: number;
}

/**
 * Dates where Σ tester casesTested ≠ the project's daily entry completed
 * cases (input consolidation check). Dates recorded on neither side are
 * ignored; a date with tester records but no daily entry counts as a
 * mismatch (entered per-tester but never at project level).
 */
export function dailyAttributionMismatches(
  entries: readonly DailyExecutionEntry[],
  testerRecords: readonly TesterDailyPerformance[],
): AttributionMismatch[] {
  const dates = new Set<string>();
  for (const entry of entries) dates.add(entry.date);
  for (const record of testerRecords) dates.add(record.date);
  const mismatches: AttributionMismatch[] = [];
  for (const date of [...dates].sort()) {
    const records = testerRecords.filter((r) => r.date === date);
    const testersTotal = records.reduce((sum, r) => sum + Math.max(0, r.casesTested), 0);
    const entry = entries.find((e) => e.date === date);
    const entryCompleted = entry !== undefined ? entryCompletedCases(entry) : 0;
    if (entryCompleted !== testersTotal) {
      mismatches.push({ date, entryCompleted, testersTotal });
    }
  }
  return mismatches;
}

/**
 * Split an integer total across n testers: the base share everywhere, with
 * the remainder going to the alphabetically-first testers. Deterministic,
 * so identical inputs always produce identical records (idempotency).
 */
export function splitEvenly(total: number, parts: number): number[] {
  if (parts <= 0) return [];
  const base = Math.floor(total / parts);
  const remainder = total - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < remainder ? 1 : 0));
}

// ---- Attendance-aware allocation (V6.8 §20, V6.9-B §10–§22 granular) --------------

/** One assigned tester with their attendance status for the day. */
export interface AssignedTesterAttendance {
  /** Identity key (memberId or legacy name). */
  key: string;
  memberId?: string;
  /** Display name at allocation time. */
  testerName: string;
  attendance: AttendanceStatus | undefined;
}

export type AllocationBasis = 'attendance' | 'all' | 'none';

/** Granular per-member totals of one day's project execution (§10–§12). */
export interface GranularAllocationTotals {
  casesPassed?: number;
  casesFailed?: number;
  casesNotApplicable?: number;
  casesBlocked?: number;
  casesRetest?: number;
  casesQuestioned?: number;
  casesSpoAssigned?: number;
}

/** The granular metric keys allocatable per member (mirrors TesterDailyPerformance). */
export const GRANULAR_ALLOCATION_KEYS: readonly (keyof GranularAllocationTotals)[] = [
  'casesPassed',
  'casesFailed',
  'casesNotApplicable',
  'casesBlocked',
  'casesRetest',
  'casesQuestioned',
  'casesSpoAssigned',
];

/** One member's suggested allocation (§11): casesTested plus optional granular splits. */
export interface AllocationSplit {
  key: string;
  memberId?: string;
  testerName: string;
  cases: number;
  casesPassed?: number;
  casesFailed?: number;
  casesNotApplicable?: number;
  casesBlocked?: number;
  casesRetest?: number;
  casesQuestioned?: number;
  casesSpoAssigned?: number;
}

export interface AllocationSuggestion {
  allocations: AllocationSplit[];
  /** attendance: split among attending testers; all: no attendance input (everyone attends by default); none: nobody attending (split among all as a fallback the supervisor must confirm). */
  basis: AllocationBasis;
  /** Attending testers (suggested recipients). */
  attendingKeys: string[];
  /** Non-attending or unknown-attendance testers excluded from the suggestion. */
  excludedKeys: string[];
  /** The project's granular totals the splits were derived from (undefined stays undefined — §13). */
  granularTotals?: GranularAllocationTotals;
}

/**
  * Attendance-aware allocation suggestion (V6.8 §20, V6.9-B §17/§22): split
  * the day's executed total among the ASSIGNED testers who were attending.
  * Attendance input is absence-only (V6.9-B): a tester WITHOUT an attendance
  * record attends by default; only ABSENT / PAID_LEAVE / OTHER records mark
  * someone as not attending. When nobody is attending (everyone recorded
  * absent), the split falls back to all assigned testers (basis 'none');
  * execution records are never deleted.
  *
  * V6.9-B: granular totals (Pass/Fail/NA/Blocked/Retest/Questioned/SPO) are
  * split across the SAME eligible member set using the same deterministic
  * rule — one member set for every metric (§22). Undefined source totals
  * stay undefined per member; nothing is reconstructed (§13).
  */
export function suggestAttendanceAwareAllocation(
  total: number,
  assigned: readonly AssignedTesterAttendance[],
  granularTotals?: GranularAllocationTotals,
): AllocationSuggestion {
  // Absence-only semantics: no record = attending by default.
  const hasAttendanceData = assigned.some((tester) => tester.attendance !== undefined);
  const attending = assigned.filter((tester) => tester.attendance === undefined || isAttending(tester.attendance));
  const excluded = assigned.filter((tester) => tester.attendance !== undefined && !isAttending(tester.attendance));
  const basis: AllocationBasis = !hasAttendanceData ? 'all' : attending.length > 0 ? 'attendance' : 'none';
  const recipients = attending.length > 0 ? attending : [...assigned];
  const shares = splitEvenly(total, recipients.length);
  // Same eligible set for every metric; undefined stays undefined (§13/§17).
  const granularSplits = new Map<keyof GranularAllocationTotals, number[]>();
  if (granularTotals !== undefined) {
    for (const field of GRANULAR_ALLOCATION_KEYS) {
      const value = granularTotals[field];
      if (value !== undefined) granularSplits.set(field, splitEvenly(value, recipients.length));
    }
  }
  return {
    allocations: recipients.map((tester, index) => ({
      key: tester.key,
      memberId: tester.memberId,
      testerName: tester.testerName,
      cases: shares[index],
      ...(granularSplits.get('casesPassed') !== undefined ? { casesPassed: granularSplits.get('casesPassed')![index] } : {}),
      ...(granularSplits.get('casesFailed') !== undefined ? { casesFailed: granularSplits.get('casesFailed')![index] } : {}),
      ...(granularSplits.get('casesNotApplicable') !== undefined ? { casesNotApplicable: granularSplits.get('casesNotApplicable')![index] } : {}),
      ...(granularSplits.get('casesBlocked') !== undefined ? { casesBlocked: granularSplits.get('casesBlocked')![index] } : {}),
      ...(granularSplits.get('casesRetest') !== undefined ? { casesRetest: granularSplits.get('casesRetest')![index] } : {}),
      ...(granularSplits.get('casesQuestioned') !== undefined ? { casesQuestioned: granularSplits.get('casesQuestioned')![index] } : {}),
      ...(granularSplits.get('casesSpoAssigned') !== undefined ? { casesSpoAssigned: granularSplits.get('casesSpoAssigned')![index] } : {}),
    })),
    basis,
    attendingKeys: attending.map((tester) => tester.key),
    excludedKeys: excluded.map((tester) => tester.key),
    ...(granularTotals !== undefined ? { granularTotals } : {}),
  };
}

// ---- Sync plan -----------------------------------------------------------------

export type SyncPlanAction = 'create' | 'update' | 'unchanged' | 'preserved';

/** True when the record was entered or corrected by a human — sync never overwrites it. */
export function isManuallySourced(record: TesterDailyPerformance): boolean {
  return record.source === undefined || record.source === 'manual' || record.source === 'manualOverride';
}

function recordsEqual(a: TesterDailyPerformance, b: TesterDailyPerformance): boolean {
  return (
    a.casesTested === b.casesTested &&
    a.casesPassed === b.casesPassed &&
    a.casesFailed === b.casesFailed &&
    a.casesNotApplicable === b.casesNotApplicable &&
    a.casesBlocked === b.casesBlocked &&
    a.casesRetest === b.casesRetest &&
    a.casesQuestioned === b.casesQuestioned &&
    a.casesSpoAssigned === b.casesSpoAssigned &&
    (a.team ?? '') === (b.team ?? '') &&
    (a.memberId ?? '') === (b.memberId ?? '')
  );
}

export interface SyncPlanItem {
  action: SyncPlanAction;
  /** Proposed record; keeps the existing id for updates (stable ids). */
  record: TesterDailyPerformance;
}

export interface UnassignedExecutionDate {
  projectId: string;
  date: string;
  casesExecuted: number;
}

export interface TesterPerformanceSyncPlan {
  items: SyncPlanItem[];
  toCreate: number;
  toUpdate: number;
  unchanged: number;
  manualPreserved: number;
  /** Execution facts without a tester assignment — attribution is not invented. */
  unassignedDates: UnassignedExecutionDate[];
}

/** Sync scope options (V6.9-B §24): omit projectIds for all projects. */
export interface SyncPlanOptions {
  /** Restrict the plan to these stable Project IDs (current-project sync). */
  projectIds?: readonly string[];
}

/**
 * Build the assisted-sync plan (V6.9-B §24/§25): across every project by
 * default, or only the projects in options.projectIds ("Sync Current
 * Project" — other projects are not touched). Projects (Done included —
 * their history is evidence) resolve assignments through the member master
 * (V6.8): a memberId assignment produces a record carrying both the stable
 * memberId and the member's display name; a legacy name-only assignment
 * keeps the V6.7 behavior. Existing records are matched by resolved
 * identity (projectId + date + memberId/name — §25), so a legacy "name"
 * record and its memberId successor share one slot instead of duplicating.
 */
export function buildTesterPerformanceSyncPlan(
  projects: readonly ProjectRecord[],
  assignments: readonly TesterProjectAssignment[],
  members: readonly RcsMember[] = [],
  options?: SyncPlanOptions,
): TesterPerformanceSyncPlan {
  const items: SyncPlanItem[] = [];
  const unassignedDates: UnassignedExecutionDate[] = [];
  const scope =
    options?.projectIds !== undefined ? new Set<string>(options.projectIds) : null;

  for (const project of projects) {
    if (scope !== null && !scope.has(project.projectId)) continue;
    const projectId = project.projectId;
    const existing = project.inputs.testerDailyPerformance ?? [];
    const facts = getDailyExecutionFacts(project.inputs);

    for (const fact of facts) {
      const assigned = getAssignedTestersForDate(assignments, projectId, fact.date, members);
      if (assigned.length === 0) {
        unassignedDates.push({ projectId, date: fact.date, casesExecuted: fact.casesExecuted });
        continue;
      }

      const shares = splitEvenly(fact.casesExecuted, assigned.length);
      const granularShares = new Map<GranularFactKey, number[]>();
      for (const field of GRANULAR_FIELDS) {
        const value = fact[field.fact];
        if (value !== null && value > 0) granularShares.set(field.fact, splitEvenly(value, assigned.length));
      }

      assigned.forEach((assignment, index) => {
        const key = assignmentIdentityKey(assignment, members);
        const member = assignment.memberId !== undefined ? findMemberById(members, assignment.memberId) : undefined;
        const proposed: TesterDailyPerformance = {
          id: generateId(),
          date: fact.date,
          testerName: member?.name ?? assignment.testerName ?? '',
          team: assignment.team ?? member?.team,
          projectId,
          casesTested: shares[index],
          casesPassed: granularShares.get('casesPassed')?.[index],
          casesFailed: granularShares.get('casesFailed')?.[index],
          casesNotApplicable: granularShares.get('casesNotApplicable')?.[index],
          casesBlocked: granularShares.get('casesBlocked')?.[index],
          casesRetest: granularShares.get('casesRetest')?.[index],
          casesQuestioned: granularShares.get('casesQuestioned')?.[index],
          casesSpoAssigned: granularShares.get('casesSpoAssigned')?.[index],
          source: 'assisted',
          ...(member !== undefined ? { memberId: member.id } : {}),
        };
        const current = existing.find(
          (record) =>
            record.projectId === projectId &&
            record.date === fact.date &&
            testerIdentityKey(record, members) === key,
        );
        if (current === undefined) {
          items.push({ action: 'create', record: proposed });
        } else if (isManuallySourced(current)) {
          items.push({ action: 'preserved', record: current });
        } else {
          const candidate = { ...proposed, id: current.id };
          if (recordsEqual(current, candidate)) {
            items.push({ action: 'unchanged', record: current });
          } else {
            items.push({ action: 'update', record: candidate });
          }
        }
      });
    }
  }

  return {
    items,
    toCreate: items.filter((item) => item.action === 'create').length,
    toUpdate: items.filter((item) => item.action === 'update').length,
    unchanged: items.filter((item) => item.action === 'unchanged').length,
    manualPreserved: items.filter((item) => item.action === 'preserved').length,
    unassignedDates,
  };
}

/**
 * Apply a sync plan to one project's records (idempotent: only create/update
 * items mutate; unchanged/preserved items are returned untouched, so manual
 * records keep their exact values and ids). Records are matched by resolved
 * identity (memberId / unique name match / legacy name).
 */
export function applyTesterPerformanceSync(
  records: readonly TesterDailyPerformance[],
  items: readonly SyncPlanItem[],
  members: readonly RcsMember[] = [],
): TesterDailyPerformance[] {
  let next = [...records];
  for (const item of items) {
    if (item.action !== 'create' && item.action !== 'update') continue;
    const key = testerIdentityKey(item.record, members);
    const index = next.findIndex(
      (record) =>
        record.projectId === item.record.projectId &&
        record.date === item.record.date &&
        testerIdentityKey(record, members) === key,
    );
    if (index === -1) {
      next = [...next, item.record];
    } else {
      const copy = [...next];
      copy[index] = item.record;
      next = copy;
    }
  }
  return next;
}

// ---- Attendance cross-check (§15) ------------------------------------------------

export type AttendanceWarningKind = 'absent';

export interface AttendanceInconsistency {
  kind: AttendanceWarningKind;
  testerName: string;
  /** Stable member identity when the record resolves to one (V6.8). */
  memberId?: string;
  date: string;
  projectId: string;
  /** Cases recorded for the tester on that day (context for the warning). */
  casesTested: number;
  /** The recorded attendance status (kind === 'absent' only). */
  attendanceStatus?: AttendanceStatus;
}

/**
 * Non-destructive cross-check between tester performance records and the
 * attendance roster. Warnings are hints only — execution data is never
 * deleted or modified.
 *
 * Attendance input is absence-only (V6.9-B): a member WITHOUT a record
 * attends by default, so only an explicit non-attending record (ABSENT /
 * PAID_LEAVE / OTHER) with recorded execution produces a warning.
 *
 * V6.9-A: both sides are keyed by the canonical identity (memberId →
 * unique name/history resolution → legacy trimmed name), so an attendance
 * row recorded under a member id matches a legacy execution record that
 * still carries that member's old name, and vice versa. One shared
 * algorithm — no per-feature name matching.
 */
export function calculateAttendanceConsistency(
  records: readonly TesterDailyPerformance[],
  attendance: readonly AttendanceRecord[],
  members: readonly RcsMember[] = [],
): AttendanceInconsistency[] {
  const byKeyDate = new Map<string, AttendanceRecord>();
  for (const record of attendance) {
    byKeyDate.set(`${attendanceIdentityKey(record, members)}\u0000${record.date}`, record);
  }
  const warnings: AttendanceInconsistency[] = [];
  for (const record of records) {
    const key = testerIdentityKey(record, members);
    const attendanceRecord = byKeyDate.get(`${key}\u0000${record.date}`);
    // No record = attending by default (absence-only input) — never a warning.
    if (attendanceRecord === undefined) continue;
    if (!isAttending(attendanceRecord.status)) {
      warnings.push({
        kind: 'absent',
        testerName: record.testerName,
        ...(record.memberId !== undefined ? { memberId: record.memberId } : {}),
        date: record.date,
        projectId: record.projectId,
        casesTested: record.casesTested,
        attendanceStatus: attendanceRecord.status,
      });
    }
  }
  return warnings.sort(
    (a, b) => a.date.localeCompare(b.date) || a.testerName.localeCompare(b.testerName) || a.projectId.localeCompare(b.projectId),
  );
}

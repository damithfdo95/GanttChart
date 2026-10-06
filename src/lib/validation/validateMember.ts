import type { RcsMember, RcsMemberNameHistory } from '../../types';
import type { TranslationKey } from '../../i18n';
import { parseDate } from '../dates/dates';

export type MemberFieldErrors = Partial<
  Record<'id' | 'name' | 'team' | 'role' | 'startDate' | 'endDate' | 'duplicate' | 'nameHistory', TranslationKey>
> & {
  /** Per-entry errors for the member's name history, keyed by entry index. */
  nameHistoryEntries?: Record<number, TranslationKey>;
};

export interface MemberValidationOutcome {
  isValid: boolean;
  errors: MemberFieldErrors;
}

/**
 * RCS member validation (V6.8 §8/§28, V6.9-A §7). Errors are i18n keys
 * rendered inline next to the offending field. The member id is required,
 * trimmed and must not collide with another member (the edited member
 * itself is excluded via excludeId); name, team, role and start date are
 * required; the optional end date must be a valid date on or after the
 * start date. Name-history entries are validated for emptiness,
 * duplicates, the current-name redundancy, date validity and ordering.
 */
export function validateRcsMember(
  member: Pick<RcsMember, 'id' | 'name' | 'team' | 'role' | 'startDate' | 'endDate' | 'nameHistory'>,
  existingMembers: readonly RcsMember[],
  excludeId?: string,
): MemberValidationOutcome {
  const errors: MemberFieldErrors = {};
  if (member.id.trim() === '') {
    errors.id = 'errors.memberIdRequired';
  } else if (existingMembers.some((m) => m.id === member.id.trim() && m.id !== excludeId)) {
    errors.id = 'errors.memberIdDuplicate';
  }
  if (member.name.trim() === '') {
    errors.name = 'errors.memberNameRequired';
  }
  if (member.team.trim() === '') {
    errors.team = 'errors.memberTeamRequired';
  }
  if (member.role.trim() === '') {
    errors.role = 'errors.memberRoleRequired';
  }
  if (parseDate(member.startDate) === null) {
    errors.startDate = 'errors.memberDateInvalid';
  }
  if (member.endDate !== undefined && member.endDate !== '') {
    if (parseDate(member.endDate) === null) {
      errors.endDate = 'errors.memberDateInvalid';
    } else if (member.endDate < member.startDate) {
      errors.endDate = 'errors.memberEndBeforeStart';
    }
  }
  const nameHistoryErrors = validateMemberNameHistory(member.nameHistory ?? [], member.name);
  if (Object.keys(nameHistoryErrors).length > 0) errors.nameHistoryEntries = nameHistoryErrors;
  return { isValid: Object.keys(errors).length === 0, errors };
}

/**
 * Validate a member's name history (V6.9-A §7):
 * - names must be non-empty and are compared trimmed
 * - duplicate names within the same member's history are rejected
 * - an entry equal to the member's current name is rejected (redundant)
 * - fromDate/toDate must be valid "YYYY-MM-DD" when present
 * - toDate before fromDate is rejected
 * Returns one i18n error key per offending entry index.
 */
export function validateMemberNameHistory(
  history: readonly RcsMemberNameHistory[],
  currentName: string,
): Record<number, TranslationKey> {
  const errors: Record<number, TranslationKey> = {};
  const seen = new Set<string>();
  history.forEach((entry, index) => {
    const name = entry.name.trim();
    if (name === '') {
      errors[index] = 'errors.nameHistoryNameRequired';
      return;
    }
    if (seen.has(name)) {
      errors[index] = 'errors.nameHistoryDuplicate';
      return;
    }
    if (name === currentName.trim()) {
      errors[index] = 'errors.nameHistoryCurrentDuplicate';
      return;
    }
    seen.add(name);
    const from = entry.fromDate;
    const to = entry.toDate;
    if (from !== undefined && from !== '' && parseDate(from) === null) {
      errors[index] = 'errors.nameHistoryDateInvalid';
      return;
    }
    if (to !== undefined && to !== '' && parseDate(to) === null) {
      errors[index] = 'errors.nameHistoryDateInvalid';
      return;
    }
    if (
      from !== undefined && from !== '' &&
      to !== undefined && to !== '' &&
      to < from
    ) {
      errors[index] = 'errors.nameHistoryDateOrder';
    }
  });
  return errors;
}

// ---- Assisted allocation validation (V6.8 §17/§21, V6.9-B §12–§15) -----------------

export interface AllocationValidationOutcome {
  /** False when the allocations sum to more than the daily executed total. */
  isValid: boolean;
  /** total − sum(allocations); negative means over-allocation. */
  unassigned: number;
  total: number;
  allocated: number;
}

/**
 * Validate an assisted allocation: the sum may be less than the executed
 * total (the remainder is shown as an explicit unassigned remainder — cases
 * are never silently lost), but never more (over-allocation is rejected).
 */
export function validateAllocation(total: number, allocations: readonly number[]): AllocationValidationOutcome {
  const allocated = allocations.reduce((sum, value) => sum + Math.max(0, Number.isFinite(value) ? Math.round(value) : 0), 0);
  const unassigned = total - allocated;
  return { isValid: unassigned >= 0, unassigned, total, allocated };
}

// ---- Granular allocation validation (V6.9-B §12–§15) -------------------------------

/** Every allocatable metric (mirrors TesterDailyPerformance). */
export type GranularMetricKey =
  | 'casesTested'
  | 'casesPassed'
  | 'casesFailed'
  | 'casesNotApplicable'
  | 'casesBlocked'
  | 'casesRetest'
  | 'casesQuestioned'
  | 'casesSpoAssigned';

/** Completed categories that are subsets of casesTested (V6.4/V6.5 semantics). */
const COMPLETED_CATEGORY_KEYS: readonly Exclude<GranularMetricKey, 'casesTested'>[] = [
  'casesPassed',
  'casesFailed',
  'casesNotApplicable',
  'casesSpoAssigned',
];

export type GranularMetricTotals = Partial<Record<GranularMetricKey, number | null>>;

export interface GranularAllocationValidation {
  isValid: boolean;
  /** Metrics whose allocated sum exceeds the project total (§15). */
  overAllocated: GranularMetricKey[];
  /** Metrics allocated > 0 without source data — never invent values (§13). */
  unsupported: GranularMetricKey[];
  /** Per-metric remainder (total − allocated); only defined for known totals (§12/§23). */
  unassigned: Partial<Record<GranularMetricKey, number>>;
  /** Per-metric allocated sums. */
  allocated: Partial<Record<GranularMetricKey, number>>;
  /** Members whose completed categories sum above their own casesTested (§15). */
  memberOverlaps: { member: string; sum: number; casesTested: number }[];
}

export type GranularMemberAllocation = Partial<Record<GranularMetricKey, number>> & { member: string };

const readMetric = (value: number | undefined): number =>
  value !== undefined && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;

/**
 * Validate a granular per-member allocation (V6.9-B §12–§15):
 *
 * 1. For every metric with a KNOWN project total: allocated ≤ total. The
 *    remainder (unassigned) is surfaced, never hidden (§23).
 * 2. For metrics whose source snapshot value is null/undefined (legacy
 *    snapshot without granular data): any allocation > 0 is rejected —
 *    historical values are never reconstructed (§13).
 * 3. Per member: Pass + Fail + NA + SPO ≤ casesTested. These are the
 *    completed categories and subsets of the tested total (established
 *    V6.4/V6.5 semantics). Blocked / Retest / Questioned are open-status
 *    OVERLAYS that are NOT part of casesTested — no relationship to
 *    casesTested is imposed for them (documented deliberately, §15).
 */
export function validateGranularAllocation(
  totals: GranularMetricTotals,
  allocations: readonly GranularMemberAllocation[],
): GranularAllocationValidation {
  const overAllocated: GranularMetricKey[] = [];
  const unsupported: GranularMetricKey[] = [];
  const unassigned: Partial<Record<GranularMetricKey, number>> = {};
  const allocated: Partial<Record<GranularMetricKey, number>> = {};
  const allKeys: GranularMetricKey[] = [
    'casesTested',
    'casesPassed',
    'casesFailed',
    'casesNotApplicable',
    'casesBlocked',
    'casesRetest',
    'casesQuestioned',
    'casesSpoAssigned',
  ];
  for (const key of allKeys) {
    const sum = allocations.reduce((acc, entry) => acc + readMetric(entry[key]), 0);
    allocated[key] = sum;
    const total = totals[key];
    if (total === null || total === undefined) {
      if (sum > 0) unsupported.push(key); // §13: never invent missing historical data
      continue;
    }
    if (sum > total) overAllocated.push(key);
    unassigned[key] = total - sum;
  }
  const memberOverlaps = allocations
    .map((entry) => ({
      member: entry.member,
      sum: COMPLETED_CATEGORY_KEYS.reduce((acc, key) => acc + readMetric(entry[key]), 0),
      casesTested: readMetric(entry.casesTested),
    }))
    .filter((entry) => entry.sum > entry.casesTested);
  return {
    isValid: overAllocated.length === 0 && unsupported.length === 0 && memberOverlaps.length === 0,
    overAllocated,
    unsupported,
    unassigned,
    allocated,
    memberOverlaps,
  };
}

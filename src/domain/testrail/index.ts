import type { TestRailResultRow, TestRailUser } from '../../../shared/testrail';
import type {
  DailyExecutionEntry,
  ExternalIdentity,
  PerformanceRecordSource,
  RcsMember,
  TesterDailyPerformance,
} from '../../types';
import { parseDate } from '../../lib/dates/dates';
import { generateId } from '../../lib/id';
import type { ExecutionStatusTotals } from '../../lib/calculations/dailyExecuted';

/**
 * TestRail import domain (Stage: TestRail import) — pure, no network, no
 * Date.now(), no DOM. The fetch lane (`src/lib/testrail/client.ts`) delivers
 * raw result rows; this module decides what they MEAN for GanttChart:
 *
 * - a result URL (plan or run) parses into a stable link target
 * - results are grouped to one Asia/Tokyo DAY and one TESTER each
 * - the LATEST result per test per day counts (a test executed twice in a
 *   day is one execution with its final status)
 * - attribution is the ASSIGNED tester (`assignedto_id`), even when someone
 *   else recorded the result; unassigned results still count in the day's
 *   totals but never appear as a tester row
 * - imported tester records carry source 'testrail' and are idempotent on
 *   re-import: only testrail/automatic/assisted records are replaced —
 *   hand-entered `manual` and supervisor-corrected `manualOverride`
 *   records are never overwritten (V6.7 §10 rule)
 */

// ---- URL link ------------------------------------------------------------------------

export type TestRailLinkKind = 'plan' | 'run';

export interface TestRailLink {
  kind: TestRailLinkKind;
  id: number;
}

/** `…/plans/view/32716` (or `…/runs/view/123`) → a linkable target; null when the URL is neither. */
export function parseTestRailUrl(url: string): TestRailLink | null {
  const m = /\/(plans|runs)\/view\/(\d+)/.exec(url.trim());
  if (m === null) return null;
  const id = Number(m[2]);
  if (!Number.isFinite(id) || id <= 0) return null;
  return { kind: m[1] === 'plans' ? 'plan' : 'run', id };
}

/** Normalized persisted link URL ('' when not a plan/run view URL → dropped). */
export function normalizeTestrailPlanUrl(url: string): string {
  const v = url.trim();
  return parseTestRailUrl(v) === null ? '' : v;
}

/** True when the linked URL points at the same TestRail instance as the configured connection. */
export function testrailHostMatches(baseUrl: string, linkedUrl: string): boolean {
  try {
    return new URL(baseUrl.trim()).host.toLowerCase() === new URL(linkedUrl.trim()).host.toLowerCase();
  } catch {
    return false;
  }
}

// ---- Asia/Tokyo day bounds (pure; Tokyo has no DST, so a fixed +9h is exact) ----------

const TOKYO_OFFSET_SECONDS = 9 * 3600;
const SECONDS_PER_DAY = 86_400;

/** The Asia/Tokyo calendar day (UTC epoch-day number) a unix timestamp falls on. */
export function tokyoDayOf(unixSeconds: number): number {
  return Math.floor((unixSeconds + TOKYO_OFFSET_SECONDS) / SECONDS_PER_DAY);
}

/** Unix seconds of the START of an Asia/Tokyo day ("YYYY-MM-DD"); null when malformed. */
export function tokyoDayStartUnix(date: string): number | null {
  const day = parseDate(date);
  return day === null ? null : day * SECONDS_PER_DAY - TOKYO_OFFSET_SECONDS;
}

// ---- Status mapping ------------------------------------------------------------------

/** The GanttChart execution categories a TestRail status can map to. */
export type TestRailStatusCategory =
  | 'pass'
  | 'fail'
  | 'notApplicable'
  | 'spo'
  | 'blocked'
  | 'retest'
  | 'questioned';

/** status_id → category. Built-ins: 1 Passed, 2 Blocked, 3 Untested, 4 Retest, 5 Failed. */
export type TestRailStatusMap = Readonly<Record<number, TestRailStatusCategory>>;

/** Default mapping: TestRail's built-in statuses; SPO/Questioned have no TestRail equivalent. */
export const DEFAULT_TESTRAIL_STATUS_MAP: TestRailStatusMap = {
  1: 'pass',
  2: 'blocked',
  4: 'retest',
  5: 'fail',
};

/** Statuses never counted as an execution (3 = Untested; null = no status recorded). */
export function isUntestedStatusId(statusId: number | null): boolean {
  return statusId === null || statusId === 3;
}

// ---- Day aggregation -------------------------------------------------------------------

export interface TestRailTesterDay {
  date: string;
  testerName: string;
  /** TestRail user id of the assigned tester (the attribution key). */
  testrailUserId: number;
  /** Stable Team Member id when the tester's TestRail email matched the directory. */
  memberId?: string;
  team?: string;
  casesTested: number;
  casesPassed?: number;
  casesFailed?: number;
  casesNotApplicable?: number;
  casesBlocked?: number;
  casesRetest?: number;
  casesQuestioned?: number;
  casesSpoAssigned?: number;
  /** Counted executions that fit no mapped status (unmapped custom statuses). */
  uncategorized?: number;
}

export interface TestRailDayTotals {
  pass: number;
  fail: number;
  notApplicable: number;
  spo: number;
  blocked: number;
  retest: number;
  questioned: number;
  uncategorizedCompleted: number;
  /** Distinct assigned testers with at least one counted result. */
  testers: number;
  /** All counted results (every mapped + uncategorized category). */
  executed: number;
}

export interface TestRailDayImport {
  date: string;
  testers: TestRailTesterDay[];
  /** Counted results with no assigned tester — included in totals, never in a tester row. */
  unassignedCount: number;
  /** Results skipped because their latest status is Untested / empty. */
  skippedUntested: number;
  /** Tester rows that resolved to NO member profile (kept in `testers`, listed here for the UI). */
  unlinked: TestRailTesterDay[];
  totals: TestRailDayTotals;
}

const EMPTY_TOTALS: TestRailDayTotals = {
  pass: 0,
  fail: 0,
  notApplicable: 0,
  spo: 0,
  blocked: 0,
  retest: 0,
  questioned: 0,
  uncategorizedCompleted: 0,
  testers: 0,
  executed: 0,
};

function emptyDay(date: string): TestRailDayImport {
  return { date, testers: [], unassignedCount: 0, skippedUntested: 0, unlinked: [], totals: { ...EMPTY_TOTALS } };
}

/**
 * Aggregate raw result rows into ONE day's per-tester execution.
 *
 * Rules: only results created inside the Asia/Tokyo day of `date` count;
 * per test (testId) only the LATEST result of that day counts (tie-break:
 * higher result id); attribution is `assignedToId` (null → unassigned
 * bucket, still counted in the totals); an Untested/null latest status is
 * not an execution; statuses not in the map count as uncategorized.
 */
export function aggregateTestRailDay(
  results: readonly TestRailResultRow[],
  users: readonly TestRailUser[],
  statusMap: TestRailStatusMap,
  date: string,
): TestRailDayImport {
  const dayStart = tokyoDayStartUnix(date);
  if (dayStart === null) return emptyDay(date);
  const dayEnd = dayStart + SECONDS_PER_DAY;

  // Latest result per test within the day.
  const latest = new Map<number, TestRailResultRow>();
  let skippedUntested = 0;
  for (const row of results) {
    if (row.createdOn < dayStart || row.createdOn >= dayEnd) continue;
    const current = latest.get(row.testId);
    if (current === undefined || row.createdOn > current.createdOn || (row.createdOn === current.createdOn && row.id > current.id)) {
      latest.set(row.testId, row);
    }
  }

  const usersById = new Map(users.map((u) => [u.id, u] as const));
  interface Acc {
    testerName: string;
    testrailUserId: number;
    pass: number;
    fail: number;
    notApplicable: number;
    spo: number;
    blocked: number;
    retest: number;
    questioned: number;
    uncategorized: number;
  }
  const newAcc = (assignedToId: number): Acc => ({
    testerName: usersById.get(assignedToId)?.name ?? `User #${assignedToId}`,
    testrailUserId: assignedToId,
    pass: 0,
    fail: 0,
    notApplicable: 0,
    spo: 0,
    blocked: 0,
    retest: 0,
    questioned: 0,
    uncategorized: 0,
  });
  const byTester = new Map<number, Acc>();
  const totals: TestRailDayTotals = { ...EMPTY_TOTALS };

  const addToTester = (tester: Acc, category: TestRailStatusCategory | undefined): void => {
    if (category === undefined) tester.uncategorized += 1;
    else tester[category] += 1;
  };
  const addToTotals = (category: TestRailStatusCategory | undefined): void => {
    if (category === undefined) totals.uncategorizedCompleted += 1;
    else totals[category] += 1;
  };

  let unassignedCount = 0;
  for (const row of latest.values()) {
    if (isUntestedStatusId(row.statusId)) {
      skippedUntested += 1;
      continue;
    }
    const category = row.statusId !== null ? statusMap[row.statusId] : undefined;
    addToTotals(category); // every counted result lands in the day's totals — assigned or not
    totals.executed += 1;
    if (row.assignedToId === null) {
      unassignedCount += 1; // visible in the import summary, never a silent drop
      continue;
    }
    const tester = byTester.get(row.assignedToId) ?? newAcc(row.assignedToId);
    addToTester(tester, category);
    byTester.set(row.assignedToId, tester);
  }

  const testers: TestRailTesterDay[] = [...byTester.values()]
    .map((acc) => ({
      date,
      testerName: acc.testerName,
      testrailUserId: acc.testrailUserId,
      casesTested: acc.pass + acc.fail + acc.notApplicable + acc.spo + acc.blocked + acc.retest + acc.questioned + acc.uncategorized,
      ...(acc.pass > 0 ? { casesPassed: acc.pass } : {}),
      ...(acc.fail > 0 ? { casesFailed: acc.fail } : {}),
      ...(acc.notApplicable > 0 ? { casesNotApplicable: acc.notApplicable } : {}),
      ...(acc.spo > 0 ? { casesSpoAssigned: acc.spo } : {}),
      ...(acc.blocked > 0 ? { casesBlocked: acc.blocked } : {}),
      ...(acc.retest > 0 ? { casesRetest: acc.retest } : {}),
      ...(acc.questioned > 0 ? { casesQuestioned: acc.questioned } : {}),
      ...(acc.uncategorized > 0 ? { uncategorized: acc.uncategorized } : {}),
    }))
    .sort((a, b) => a.testerName.localeCompare(b.testerName));

  totals.testers = testers.length;
  return { date, testers, unassignedCount, skippedUntested, unlinked: [], totals };
}

/**
 * Link tester rows to Team Members. Resolution order (the JIRA reporter
 * rule): 1) an ACTIVE external identity with provider 'testrail' and the
 * row's TestRail user id (the SV's explicit link always wins); 2) a unique
 * email match (lower-case compare; Stage 8D email identity). Rows that
 * link to the same member are merged so one person is one row. Pure —
 * `day` is not mutated.
 */
export function linkTestRailMembers(
  day: TestRailDayImport,
  users: readonly TestRailUser[],
  members: readonly RcsMember[],
  externalIdentities: readonly ExternalIdentity[] = [],
): TestRailDayImport {
  const usersById = new Map(users.map((u) => [u.id, u] as const));
  const memberByEmail = new Map(
    members.filter((m) => m.email !== undefined).map((m) => [(m.email as string).toLowerCase(), m] as const),
  );
  // ACTIVE testrail identity links by TestRail user id (stringified — the
  // ExternalIdentity.externalId is a string by design).
  const memberByTestrailId = new Map(
    externalIdentities
      .filter((e) => e.active && e.provider === 'testrail')
      .map((e) => [e.externalId, e.memberId] as const),
  );
  const memberById = new Map(members.map((m) => [m.id, m] as const));
  const resolveMember = (testrailUserId: number, email: string | undefined): RcsMember | undefined => {
    // Rule 1: the SV's explicit link (external identity) always wins.
    const linkedMemberId = memberByTestrailId.get(String(testrailUserId));
    if (linkedMemberId !== undefined) return memberById.get(linkedMemberId);
    // Rule 2: a unique email match.
    return email !== undefined ? memberByEmail.get(email.toLowerCase()) : undefined;
  };
  const byMember = new Map<string, TestRailTesterDay>();
  const unlinked: TestRailTesterDay[] = [];
  for (const row of day.testers) {
    const email = usersById.get(row.testrailUserId)?.email;
    const member = resolveMember(row.testrailUserId, email);
    if (member === undefined) {
      unlinked.push(row);
      continue;
    }
    const existing = byMember.get(member.id);
    if (existing === undefined) {
      byMember.set(member.id, { ...row, testerName: row.testerName !== '' ? row.testerName : member.name, memberId: member.id, ...(member.team !== '' ? { team: member.team } : {}) });
      continue;
    }
    // Same person under two TestRail accounts: merge into one row.
    byMember.set(member.id, {
      ...existing,
      casesTested: existing.casesTested + row.casesTested,
      casesPassed: (existing.casesPassed ?? 0) + (row.casesPassed ?? 0),
      casesFailed: (existing.casesFailed ?? 0) + (row.casesFailed ?? 0),
      casesNotApplicable: (existing.casesNotApplicable ?? 0) + (row.casesNotApplicable ?? 0),
      casesSpoAssigned: (existing.casesSpoAssigned ?? 0) + (row.casesSpoAssigned ?? 0),
      casesBlocked: (existing.casesBlocked ?? 0) + (row.casesBlocked ?? 0),
      casesRetest: (existing.casesRetest ?? 0) + (row.casesRetest ?? 0),
      casesQuestioned: (existing.casesQuestioned ?? 0) + (row.casesQuestioned ?? 0),
      uncategorized: (existing.uncategorized ?? 0) + (row.uncategorized ?? 0),
    });
  }
  const testers = [...byMember.values(), ...unlinked].sort((a, b) => a.testerName.localeCompare(b.testerName));
  return { ...day, testers, unlinked };
}

// ---- Tester-record merge ---------------------------------------------------------------

export interface TestRailRecordMerge {
  records: TesterDailyPerformance[];
  /** Existing manual / manualOverride records that were preserved, not replaced. */
  keptManual: number;
}

/**
 * Merge one day's imported rows into the project's tester records
 * (idempotent on re-import). Natural key: (projectId, date, memberId ?? name)
 * — the same rule `upsertTesterDailyPerformance` applies. Existing records
 * with source manual/manualOverride are NEVER overwritten (V6.7 §10);
 * testrail / automatic / assisted / legacy-absent records are replaced.
 */
export function mergeTestRailTesterRecords(
  records: readonly TesterDailyPerformance[],
  projectId: string,
  day: TestRailDayImport,
): TestRailRecordMerge {
  let keptManual = 0;
  let next = [...records];
  for (const row of day.testers) {
    const testerName = row.testerName.trim();
    const index = next.findIndex((record) => {
      if (record.projectId !== projectId || record.date !== day.date) return false;
      if (row.memberId !== undefined && row.memberId !== '') {
        return record.memberId === row.memberId || record.testerName === testerName;
      }
      return record.testerName === testerName && record.memberId === undefined;
    });
    const existing = index >= 0 ? next[index] : undefined;
    if (existing !== undefined && (existing.source === 'manual' || existing.source === 'manualOverride')) {
      keptManual += 1;
      continue;
    }
    const imported: TesterDailyPerformance = {
      id: existing?.id ?? generateId(),
      date: day.date,
      testerName,
      ...(row.memberId !== undefined && row.memberId !== '' ? { memberId: row.memberId } : {}),
      ...(row.team !== undefined && row.team !== '' ? { team: row.team } : {}),
      projectId,
      casesTested: row.casesTested,
      casesPassed: row.casesPassed,
      casesFailed: row.casesFailed,
      casesNotApplicable: row.casesNotApplicable,
      casesBlocked: row.casesBlocked,
      casesRetest: row.casesRetest,
      casesQuestioned: row.casesQuestioned,
      casesSpoAssigned: row.casesSpoAssigned,
      source: 'testrail' as PerformanceRecordSource,
    };
    if (existing === undefined) {
      next = [...next, imported];
    } else {
      next = next.map((record, i) => (i === index ? imported : record));
    }
  }
  return { records: next, keptManual };
}

// ---- Daily-execution entry proposal -----------------------------------------------------

/**
 * Apply one day's imported totals to the CURRENT form state as an editable
 * proposal: the status counts and the tester count are replaced by the
 * import; the time window (start / end / overtime / interval), the note and
 * the entry identity stay untouched.
 *
 * In DAY mode the fields hold that day's counts. In TOTAL mode they hold
 * the RUNNING TOTALS through the date, so the day delta of the filled form
 * equals the import: `previous` is the cumulative BEFORE this date.
 */
export function applyTestRailDayToEntry(
  current: DailyExecutionEntry,
  day: TestRailDayImport,
  previous: ExecutionStatusTotals,
  /** The form's status-count input mode: per-day counts, or running totals. */
  mode: 'DAY' | 'TOTAL',
): DailyExecutionEntry {
  const totals = day.totals;
  const pass = mode === 'TOTAL' ? previous.pass + totals.pass : totals.pass;
  const fail = mode === 'TOTAL' ? previous.fail + totals.fail : totals.fail;
  const notApplicable = mode === 'TOTAL' ? previous.notApplicable + totals.notApplicable : totals.notApplicable;
  const spo = mode === 'TOTAL' ? previous.spo + totals.spo : totals.spo;
  const blocked = mode === 'TOTAL' ? previous.blocked + totals.blocked : totals.blocked;
  const retest = mode === 'TOTAL' ? previous.retest + totals.retest : totals.retest;
  const questioned = mode === 'TOTAL' ? previous.questioned + totals.questioned : totals.questioned;
  return {
    ...current,
    testers: totals.testers,
    pass,
    fail,
    notApplicable,
    spo,
    blocked,
    retest,
    questioned,
    uncategorizedCompleted: totals.uncategorizedCompleted,
  };
}

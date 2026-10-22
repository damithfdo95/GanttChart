import { TM_LIMITS, nextCaseKey, type CasePriority, type TestCase } from '../../../shared/testManagement';
import type { TestRailCaseRow } from '../../../shared/testrail';
import { collapseWhitespace, truncateText } from './jiraImport';
import type { BulkRow } from './bulk';

/**
 * TestRail case → Test Case import mapping (Stage: TestRail case import).
 *
 * The TestRail lane fetches the cases of a linked run's SUITE (`getCases`)
 * and imports them as Test Cases through the EXISTING paste pipeline: the
 * rows produced here are structurally `BulkRow`s plus the TestRail case id,
 * so the caller hands them to `newTestCase` exactly like a validated paste
 * preview — the commit logic is not reimplemented, only reused.
 *
 * Mapping decisions (documented because the shapes are fixed):
 *  - ONE TestRail case becomes ONE Test Case. The title is the case title,
 *    whitespace-collapsed and hard-capped at TM_LIMITS.title, so the value
 *    always passes validation. A case without a usable title is SKIPPED
 *    (counted as invalid — `buildBulkCases` would reject the whole batch).
 *  - Rows never carry a case key: the next free key of the scope is
 *    assigned, exactly like a blank-key paste line.
 *  - `testrailCaseId` rides along so the Execution tab's TestRail sync can
 *    match run results to these cases later. It is shared data and syncs
 *    like every other case field.
 *  - A case whose id is ALREADY linked (by an existing case of the same
 *    project, or earlier in the same batch) is SKIPPED — re-importing a
 *    suite must never create a second case for the same TestRail case.
 *
 * Everything here is pure: no Date.now, no random ids, no fetch.
 */

/** A bulk-add row produced from a TestRail case. Structurally a `BulkRow` plus the TestRail case id. */
export interface TestRailCaseBulkRow extends BulkRow {
  /** The TestRail case id — becomes `TestCase.testrailCaseId` on commit. */
  testrailCaseId: number;
}

/**
 * TestRail priority name → case priority. TestRail's default instance
 * names plus the common words some instances configure. Anything else
 * (including a missing priority) falls back to 'medium'. The result is
 * ALWAYS one of CASE_PRIORITIES — no value is invented.
 */
const TESTRAIL_PRIORITY_MAP: Record<string, CasePriority> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  normal: 'medium',
  low: 'low',
  lowest: 'low',
  blocker: 'critical',
  urgent: 'critical',
  major: 'high',
  minor: 'low',
  trivial: 'low',
  最高: 'critical',
  高: 'high',
  中: 'medium',
  低: 'low',
};

export function mapTestRailPriority(priorityName: string | undefined): CasePriority {
  if (priorityName === undefined) return 'medium';
  return TESTRAIL_PRIORITY_MAP[priorityName.normalize('NFKC').trim().toLowerCase()] ?? 'medium';
}

/** The set of TestRail case ids an import into `projectId` must not duplicate: every case of the project that already carries one. */
export function existingTestRailCaseIds(cases: readonly TestCase[], projectId: string): Set<number> {
  const ids = new Set<number>();
  for (const c of cases) {
    if (c.projectId !== projectId || c.testrailCaseId === undefined) continue;
    ids.add(c.testrailCaseId);
  }
  return ids;
}

export interface TestRailCasePlanRow {
  /** The fetched case this preview row describes. */
  case: TestRailCaseRow;
  /** The case key `newTestCase` will assign; null when the row is skipped. */
  key: string | null;
  /** The truncated case title — what the Test Case title will be (may be empty for skipped rows). */
  title: string;
  /** Whether this row will actually be imported on commit. */
  importable: boolean;
  /** Why it is skipped; null when importable. */
  skipReason: 'duplicate' | 'noTitle' | null;
}

export interface TestRailCaseImportPlan {
  /** One row per fetched case, in fetch order (skipped ones flagged). */
  rows: TestRailCasePlanRow[];
  /** The bulk rows handed to the commit path on confirm, in order. */
  commitRows: TestRailCaseBulkRow[];
  /** Cases skipped because their TestRail id is already linked (this batch included). */
  duplicateCount: number;
  /** Cases skipped because they have no title. */
  invalidCount: number;
}

/**
 * Pure import planning: one row per fetched case, with the case key that
 * will be assigned and whether importing it would duplicate a link that
 * already exists. Keys are computed over the KEPT batch only, so what the
 * user sees is exactly what the commit assigns (no phantom keys from
 * skipped duplicates).
 */
export function planTestRailCaseImport(
  cases: readonly TestRailCaseRow[],
  existingCases: readonly TestCase[],
  projectId: string,
  scopeCode: string,
): TestRailCaseImportPlan {
  const existingIds = existingTestRailCaseIds(existingCases, projectId);
  // The key space the new keys must avoid: every key of the project
  // (archived included, exactly like usedKeys/buildBulkCases).
  const existingKeys = new Set(existingCases.filter((c) => c.projectId === projectId).map((c) => c.key));
  const code = scopeCode === '' ? undefined : scopeCode;

  const seen = new Set<number>();
  const taken: string[] = [];
  const rows: TestRailCasePlanRow[] = [];
  const commitRows: TestRailCaseBulkRow[] = [];
  let duplicateCount = 0;
  let invalidCount = 0;
  for (const c of cases) {
    const title = truncateText(collapseWhitespace(c.title), TM_LIMITS.title);
    const duplicate = seen.has(c.caseId) || existingIds.has(c.caseId);
    seen.add(c.caseId);
    if (duplicate) {
      duplicateCount += 1;
      rows.push({ case: c, key: null, title, importable: false, skipReason: 'duplicate' });
      continue;
    }
    if (title === '') {
      invalidCount += 1;
      rows.push({ case: c, key: null, title, importable: false, skipReason: 'noTitle' });
      continue;
    }
    const key = nextCaseKey(code, existingKeys, taken);
    taken.push(key);
    rows.push({ case: c, key, title, importable: true, skipReason: null });
    commitRows.push({
      line: commitRows.length + 1,
      title,
      priority: mapTestRailPriority(c.priorityName),
      ...(c.typeName === undefined ? {} : { type: truncateText(c.typeName, TM_LIMITS.type) }),
      testrailCaseId: c.caseId,
    });
  }
  return { rows, commitRows, duplicateCount, invalidCount };
}

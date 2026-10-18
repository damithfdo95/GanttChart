import type { JiraIssue } from '../../../shared/jira';
import type { TestCase } from '../../../shared/testManagement';
import {
  jiraImportPreview,
  jiraIssuesToBulkRows,
  ticketRefFromCaseType,
  type JiraBulkRow,
} from '../../domain/testManagement/jiraImport';

/**
 * Pure UI-side planning for the "Import from JIRA" Test Case flow.
 *
 * The domain mapping in `src/domain/testManagement/jiraImport.ts` maps every
 * issue to a bulk row; THIS layer decides what actually gets imported:
 *  - a JIRA key that is already referenced (by an existing case or earlier in
 *    the same batch) is SKIPPED — re-importing must never create a second
 *    case for the same ticket.
 *  - an issue whose summary collapses to nothing yields an empty case title,
 *    which `buildBulkCases` would reject for the whole batch, so it is
 *    SKIPPED too (counted separately, "no title").
 * Every remaining issue commits through the exact bulk-add path
 * (`jiraIssuesToBulkRows` → `buildBulkCases`), so the import can never
 * produce a case that the paste pipeline would refuse.
 *
 * The case keys shown for the importable rows are recomputed over the KEPT
 * batch, so what the user sees is exactly what `buildBulkCases` will assign
 * (no phantom keys from skipped duplicates).
 */

/** Why one fetched issue will not be imported. */
export type JiraCaseSkipReason = 'duplicate' | 'noTitle';

export interface JiraCasePlanRow {
  /** The fetched issue this preview row describes. */
  issue: JiraIssue;
  /** The case key `buildBulkCases` will assign; null when the row is skipped. */
  key: string | null;
  /** The truncated issue summary — what the case title will be (may be empty for skipped rows). */
  title: string;
  /** Whether this row will actually be imported on commit. */
  importable: boolean;
  /** Why it is skipped; null when importable. */
  skipReason: JiraCaseSkipReason | null;
}

export interface JiraCaseImportPlan {
  /** One row per fetched issue, in fetch order (skipped ones flagged). */
  rows: JiraCasePlanRow[];
  /** The bulk rows handed to `buildBulkCases` on commit, in order. */
  commitRows: JiraBulkRow[];
  /** Issues skipped because their JIRA key is already imported (this batch included). */
  duplicateCount: number;
  /** Issues skipped because they have no title. */
  invalidCount: number;
}

/**
 * The set of keys an import into `projectId` must not collide with: every
 * case key of the project (archived included, exactly like `usedKeys`/`buildBulkCases`)
 * plus every JIRA reference already recorded on its cases' `type` — this is
 * what makes a re-import detectable before anything is written.
 */
export function existingJiraImportKeys(cases: readonly TestCase[], projectId: string): Set<string> {
  const keys = new Set<string>();
  for (const c of cases) {
    if (c.projectId !== projectId) continue;
    keys.add(c.key);
    const ref = ticketRefFromCaseType(c.type);
    if (ref !== null) keys.add(ref);
  }
  return keys;
}

export function planJiraCaseImport(issues: readonly JiraIssue[], existingKeys: Set<string>, scopeCode: string): JiraCaseImportPlan {
  const allPreview = jiraImportPreview(issues, existingKeys, scopeCode);
  const allRows = jiraIssuesToBulkRows(issues);
  const keptIssues: JiraIssue[] = [];
  const rows: JiraCasePlanRow[] = [];
  let duplicateCount = 0;
  let invalidCount = 0;
  for (let i = 0; i < issues.length; i += 1) {
    const duplicate = allPreview[i]?.duplicate === true;
    const noTitle = allRows[i].title === '';
    if (duplicate) {
      duplicateCount += 1;
      rows.push({ issue: issues[i], key: null, title: allRows[i].title, importable: false, skipReason: 'duplicate' });
    } else if (noTitle) {
      invalidCount += 1;
      rows.push({ issue: issues[i], key: null, title: allRows[i].title, importable: false, skipReason: 'noTitle' });
    } else {
      keptIssues.push(issues[i]);
      rows.push({ issue: issues[i], key: null, title: allRows[i].title, importable: true, skipReason: null });
    }
  }
  const keptPreview = jiraImportPreview(keptIssues, existingKeys, scopeCode);
  let keptIndex = 0;
  for (const row of rows) {
    if (!row.importable) continue;
    const previewKey = keptPreview[keptIndex]?.key;
    row.key = previewKey === undefined ? null : previewKey;
    keptIndex += 1;
  }
  return { rows, commitRows: jiraIssuesToBulkRows(keptIssues), duplicateCount, invalidCount };
}
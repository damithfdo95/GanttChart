import { TM_LIMITS, nextCaseKey, type CasePriority } from '../../../shared/testManagement';
import type { JiraIssue } from '../../../shared/jira';
import type { BulkRow } from './bulk';

/**
 * JIRA → Test Case import mapping (Stage: JIRA import).
 *
 * The JIRA lane fetches JQL results as `JiraIssue[]` (shared/jira.ts) and imports them as Test
 * Cases through the EXISTING paste pipeline: the rows produced here are structurally `BulkRow`s, so
 * the caller hands them to `buildBulkCases` exactly like a validated paste preview — the commit
 * logic is not reimplemented, only reused.
 *
 * Mapping decisions (documented because the bulk row shape is fixed):
 *  - `BulkRow` has NO description column (its long-text slot is `expected`). A JIRA description
 *    therefore rides in the extra `description` field of `JiraBulkRow`, and `buildBulkCases`
 *    forwards it to `TestCase.description` when present. Rows from the Excel paste never set it, so
 *    the existing pipeline behaves identically for them.
 *  - `BulkRow` has NO ticket column either. The single `type` slot (which lands in `TestCase.type`)
 *    is therefore RESERVED for the JIRA ticket reference, written as `[KEY]` with the issue type
 *    appended when present — e.g. `[PROJ-42] Bug` — so re-imports are detectable by scanning saved
 *    cases' `type` with `ticketRefFromCaseType`. The issue TYPE never influences the case PRIORITY:
 *    in the bulk pipeline the type column is display-only and priority comes from the priority
 *    column alone (a JIRA "Bug"/"Defect" maps to nothing special).
 *  - Rows never carry a case key: `buildBulkCases` assigns the next free key of the scope, exactly
 *    like a blank-key paste line.
 *  - `line` is the 1-based position of the issue in the batch, mirroring `parseBulkCases` line
 *    numbering so error reporting stays uniform.
 *
 * Everything here is pure: no Date.now, no random ids, no fetch.
 */

/** A bulk-add row produced from a JIRA issue. Structurally a `BulkRow` plus `description`, so `buildBulkCases` accepts it as-is. */
export interface JiraBulkRow extends BulkRow {
  /** The JIRA plain-text description, whitespace-collapsed and truncated to TM_LIMITS.description. */
  description?: string;
}

/** Collapse every run of whitespace (including newlines) to a single space, then trim. */
export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Whitespace-collapse, then truncate to `max` characters. `max` is counted in UTF-16 code units —
 * the same unit `checkTestCase` uses — so a truncated value always passes validation.
 */
export function truncateText(value: string, max: number): string {
  const t = collapseWhitespace(value);
  return t.length <= max ? t : t.slice(0, max);
}

/**
 * JIRA priority name → case priority. Standard JIRA priorities (Highest/High/Medium/Low/Lowest)
 * plus the common severity words some instances configure instead. Anything else (including a
 * missing priority) falls back to 'medium'. The result is ALWAYS one of CASE_PRIORITIES — no value
 * is invented.
 */
export const JIRA_PRIORITY_MAP: Record<string, CasePriority> = {
  highest: 'high',
  high: 'high',
  medium: 'medium',
  normal: 'medium',
  low: 'low',
  lowest: 'low',
  blocker: 'critical',
  critical: 'critical',
  urgent: 'critical',
  major: 'high',
  minor: 'low',
  trivial: 'low',
};

export function mapJiraPriority(priorityName: string | undefined): CasePriority {
  if (priorityName === undefined) return 'medium';
  return JIRA_PRIORITY_MAP[priorityName.normalize('NFKC').trim().toLowerCase()] ?? 'medium';
}

/**
 * Extract the JIRA ticket reference from a case `type` written by `jiraIssuesToBulkRows`
 * ("[PROJ-42] Bug" → "PROJ-42"). Null when the string is not in that shape. This is the re-import
 * hook: a caller wanting to detect duplicates parses existing cases' `type` through this function.
 */
export function ticketRefFromCaseType(type: string | undefined): string | null {
  if (type === undefined) return null;
  const m = type.trim().match(/^\[([^\]]+)\]/);
  return m === null ? null : m[1];
}

/** Map a batch of JIRA issues to bulk-add-compatible rows (one per issue, in order). */
export function jiraIssuesToBulkRows(issues: readonly JiraIssue[]): JiraBulkRow[] {
  return issues.map((issue, i) => {
    const typeName = issue.typeName.trim();
    const type = truncateText(typeName === '' ? `[${issue.key}]` : `[${issue.key}] ${typeName}`, TM_LIMITS.type);
    const description = truncateText(issue.descriptionPlain, TM_LIMITS.description);
    return {
      line: i + 1,
      title: truncateText(issue.summary, TM_LIMITS.title),
      priority: mapJiraPriority(issue.priorityName),
      type,
      ...(description === '' ? {} : { description }),
    };
  });
}

export interface JiraImportPreviewRow {
  /** The would-be case key that `buildBulkCases` will assign (the next free key of the scope). */
  key: string;
  /** The truncated issue summary — what the case title will be. */
  title: string;
  /** True when this JIRA key is ALREADY referenced: by an earlier issue in this batch, or by an existing case. */
  duplicate: boolean;
}

/**
 * Pure import preview: per issue, the case key `buildBulkCases` will assign and whether importing
 * it again would create a duplicate.
 *
 * `existingKeys` is the set of every key already used by the target project/scope — the same set
 * `nextCaseKey` scans. To detect re-imports, ALSO add the JIRA references found in existing cases'
 * `type` fields (via `ticketRefFromCaseType`) to this same set: `nextCaseKey` ignores entries that
 * are not `CODE-NNN` keys, so mixing case keys and JIRA keys is safe, and `duplicate` then means
 * exactly "same JIRA key already referenced". Duplicates inside one batch (the same key appearing
 * twice in `issues`) are flagged the same way. Being conservative: a duplicate is exactly that,
 * nothing else.
 */
export function jiraImportPreview(issues: readonly JiraIssue[], existingKeys: Set<string>, scopeCode: string): JiraImportPreviewRow[] {
  const code = scopeCode === '' ? undefined : scopeCode;
  const taken: string[] = [];
  const seen = new Set<string>();
  const rows: JiraImportPreviewRow[] = [];
  for (const issue of issues) {
    const ref = issue.key.normalize('NFKC').trim().toUpperCase();
    const duplicate = seen.has(ref) || existingKeys.has(ref);
    seen.add(ref);
    const key = nextCaseKey(code, existingKeys, taken);
    taken.push(key);
    rows.push({ key, title: truncateText(issue.summary, TM_LIMITS.title), duplicate });
  }
  return rows;
}
import type { ProjectOwnerEntry } from '../types';

/**
 * Project Owner registry operations. Pure array/string helpers — callers
 * apply the result through the reports-state actions so persistence stays
 * centralized. The registry lives at workspace level (ReportsState), and
 * every row pairs ONE free-text project with ONE free-text assignee; an
 * assignee can appear in many rows. Names are free text on purpose (they
 * may not be Team Members), so ids are the only stable identity.
 */

/**
 * Next free row id in the PO000N series ("PO0001", "PO0002", …) that does
 * not collide with any existing id — never based on array index.
 */
export function nextProjectOwnerId(entries: readonly ProjectOwnerEntry[]): string {
  let max = 0;
  for (const entry of entries) {
    const match = /^PO(\d+)$/.exec(entry.id);
    if (match !== null) max = Math.max(max, Number(match[1]));
  }
  let candidate = max + 1;
  const existing = new Set(entries.map((entry) => entry.id));
  while (existing.has(`PO${String(candidate).padStart(4, '0')}`)) candidate += 1;
  return `PO${String(candidate).padStart(4, '0')}`;
}

/** Every assignee name that has been registered, unique and name-sorted (for the datalist suggestions). */
export function distinctAssignees(entries: readonly ProjectOwnerEntry[]): string[] {
  return [...new Set(entries.map((entry) => entry.assignee))].sort((a, b) => a.localeCompare(b));
}

/** Input normalization for free-text project/assignee names (same rule as Team Directory names). */
export function normalizeOwnerText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim();
}
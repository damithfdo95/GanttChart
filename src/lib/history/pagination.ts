/**
 * Paging of the shared (QA) history by revision number, newest first. The server returns rows with `revision < before`, so a
 * page boundary can never repeat or skip a row, however many revisions are added meanwhile (new ones only appear on the
 * first page). The client asks for one row more than it shows to know whether there is a next page.
 */

export const HISTORY_PAGE_SIZES = [25, 50] as const;
export type HistoryPageSize = (typeof HISTORY_PAGE_SIZES)[number];
export const DEFAULT_HISTORY_PAGE_SIZE: HistoryPageSize = 25;

export interface HistoryPage<T extends { revision: number }> {
  rows: T[];
  /** True when at least one older revision exists beyond this page. */
  hasMore: boolean;
  /** Newest and oldest revision on this page (null when empty). */
  newest: number | null;
  oldest: number | null;
}

/** Turn what the server returned for `limit = pageSize + 1` into one page. */
export function toPage<T extends { revision: number }>(fetched: readonly T[], pageSize: number): HistoryPage<T> {
  const rows = fetched.slice(0, pageSize);
  return {
    rows,
    hasMore: fetched.length > pageSize,
    newest: rows.length === 0 ? null : rows[0].revision,
    oldest: rows.length === 0 ? null : rows[rows.length - 1].revision,
  };
}

/** The request for one page: `before` is the oldest revision of the page before it (undefined = the newest page). */
export function pageUrl(pageSize: number, before: number | undefined, filter: HistoryFilter = {}): string {
  const extra = (['kind', 'actor', 'from', 'to'] as const)
    .filter((k) => filter[k] !== undefined && filter[k] !== '')
    .map((k) => `&${k}=${encodeURIComponent(filter[k] as string)}`)
    .join('');
  return `/api/revisions?limit=${pageSize + 1}${before === undefined ? '' : `&before=${before}`}${extra}`;
}

/**
 * Narrowing of the list, applied by the server BEFORE paging, so the cursor still walks the filtered list without repeating or skipping a
 * row. `actor` is the email recorded with the change; `from` / `to` are business-time calendar days (inclusive).
 */
export interface HistoryFilter {
  kind?: string;
  actor?: string;
  from?: string;
  to?: string;
}

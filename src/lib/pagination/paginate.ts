/**
 * Pure pagination core shared by every paginated table (UI hook in
 * usePagedRows, rendering in TablePager).
 *
 * Tables in this app render user-generated data that grows with daily use
 * (execution entries, reports, tickets, reviews...). Rendering every row at
 * once makes panels unusably long — the helper below computes one page of
 * rows plus the pager metadata, with the current page clamped so a shrunken
 * list (deleted rows, tighter filter) always stays inside the valid range.
 */

export interface PagedRows<T> {
  /** Rows of the current page (a slice of the input). */
  pagedRows: readonly T[];
  /** 1-based current page after clamping (1 when there are no rows). */
  page: number;
  /** Total page count (0 when there are no rows). */
  pageCount: number;
  /** 1-based index of the first row shown on the page (0 when empty). */
  from: number;
  /** 1-based index of the last row shown on the page (0 when empty). */
  to: number;
  /** Total row count. */
  total: number;
}

/** Compute one page of rows with pager metadata; `page` is clamped into range. */
export function paginateRows<T>(rows: readonly T[], page: number, pageSize: number): PagedRows<T> {
  const total = rows.length;
  if (pageSize <= 0 || total === 0) {
    return { pagedRows: [], page: 1, pageCount: 0, from: 0, to: 0, total };
  }
  const pageCount = Math.ceil(total / pageSize);
  const clamped = Math.min(Math.max(1, Math.floor(page)), pageCount);
  const start = (clamped - 1) * pageSize;
  return {
    pagedRows: rows.slice(start, start + pageSize),
    page: clamped,
    pageCount,
    from: start + 1,
    to: Math.min(start + pageSize, total),
    total,
  };
}

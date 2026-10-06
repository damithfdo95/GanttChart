import { useEffect, useMemo, useState } from 'react';
import { paginateRows, type PagedRows } from './paginate';

export interface UsePagedRowsResult<T> extends PagedRows<T> {
  /** Move to a 1-based page (values outside the range are clamped on render). */
  setPage: (page: number) => void;
}

/**
 * Page-state wrapper around the pure paginateRows helper.
 *
 * `initialPage: 'last'` starts on the newest rows of an oldest-first list
 * (history tables). `resetKey` (typically the table's filter/sort/search
 * values) re-applies that preference whenever it changes — a fresh view must
 * never start on a page that no longer exists. When the row list itself
 * shrinks below the current page (row deleted from the last page), the state
 * is pulled back inside the range so the pager never shows "Page 7 of 3".
 */
export function usePagedRows<T>(
  rows: readonly T[],
  pageSize: number,
  options: { resetKey?: unknown; initialPage?: 'first' | 'last' } = {},
): UsePagedRowsResult<T> {
  const [page, setPage] = useState(() => (options.initialPage === 'last' ? Number.MAX_SAFE_INTEGER : 1));
  const { resetKey } = options;
  useEffect(() => {
    setPage(options.initialPage === 'last' ? Number.MAX_SAFE_INTEGER : 1);
  }, [resetKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const result = useMemo(() => paginateRows(rows, page, pageSize), [rows, page, pageSize]);
  useEffect(() => {
    if (page > 1 && page > result.pageCount) setPage(Math.max(1, result.pageCount));
  }, [result.pageCount]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...result, setPage };
}

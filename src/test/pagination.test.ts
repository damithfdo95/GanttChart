import { describe, expect, it } from 'vitest';
import { paginateRows } from '../lib/pagination/paginate';

/** Shared pagination core (usePagedRows/TablePager are its thin UI wrappers). */
describe('paginateRows', () => {
  const rows = Array.from({ length: 25 }, (_, i) => i + 1);

  it('slices the requested page', () => {
    const first = paginateRows(rows, 1, 10);
    expect(first.pagedRows).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(first.page).toBe(1);
    expect(first.pageCount).toBe(3);
    expect(first.from).toBe(1);
    expect(first.to).toBe(10);
    expect(first.total).toBe(25);

    const last = paginateRows(rows, 3, 10);
    expect(last.pagedRows).toEqual([21, 22, 23, 24, 25]);
    expect(last.from).toBe(21);
    expect(last.to).toBe(25);
  });

  it('clamps a page beyond the last page back into range', () => {
    const clamped = paginateRows(rows, 99, 10);
    expect(clamped.page).toBe(3);
    expect(clamped.pagedRows).toEqual([21, 22, 23, 24, 25]);
    expect(clamped.from).toBe(21);
    expect(clamped.to).toBe(25);
  });

  it('clamps a page below one to the first page', () => {
    expect(paginateRows(rows, 0, 10).page).toBe(1);
    expect(paginateRows(rows, -7, 10).page).toBe(1);
    expect(paginateRows(rows, 0, 10).pagedRows[0]).toBe(1);
  });

  it('returns an empty result for an empty list', () => {
    const empty = paginateRows([], 1, 10);
    expect(empty.pagedRows).toEqual([]);
    expect(empty.page).toBe(1);
    expect(empty.pageCount).toBe(0);
    expect(empty.from).toBe(0);
    expect(empty.to).toBe(0);
    expect(empty.total).toBe(0);
  });

  it('collapses to a single page when everything fits', () => {
    const single = paginateRows([1, 2, 3], 1, 10);
    expect(single.pageCount).toBe(1);
    expect(single.pagedRows).toEqual([1, 2, 3]);
    expect(single.from).toBe(1);
    expect(single.to).toBe(3);
  });

  it('treats an exact multiple of the page size without a phantom page', () => {
    const exact = paginateRows([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 1, 5);
    expect(exact.pageCount).toBe(2);
    expect(exact.to).toBe(5);
    const second = paginateRows([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 2, 5);
    expect(second.page).toBe(2);
    expect(second.to).toBe(10);
    expect(second.from).toBe(6);
  });

  it('floors fractional page numbers', () => {
    expect(paginateRows(rows, 2.7, 10).page).toBe(2);
  });

  it('returns an empty result for a non-positive page size', () => {
    const zero = paginateRows(rows, 1, 0);
    expect(zero.pagedRows).toEqual([]);
    expect(zero.pageCount).toBe(0);
    expect(zero.total).toBe(25);
  });

  it('does not mutate the input rows', () => {
    const input = [1, 2, 3];
    paginateRows(input, 1, 2);
    expect(input).toEqual([1, 2, 3]);
  });
});

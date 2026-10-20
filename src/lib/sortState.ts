/**
 * Tri-state column sort toggle (ascending → descending → reset), shared by
 * JiraScreen and any table following the Overall tri-state pattern.
 */
export interface SortState<K extends string> {
  key: K;
  dir: 'asc' | 'desc';
}

export function toggleSort<K extends string>(
  key: K,
  current: SortState<K> | null,
  commit: (next: SortState<K> | null) => void,
  reset: SortState<K> | null,
): void {
  if (current === null || current.key !== key) commit({ key, dir: 'asc' });
  else if (current.dir === 'asc') commit({ key, dir: 'desc' });
  else commit(reset);
}

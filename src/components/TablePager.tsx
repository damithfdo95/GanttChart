import { t } from '../i18n';
import type { Language } from '../types';
import type { UsePagedRowsResult } from '../lib/pagination/usePagedRows';

interface TablePagerProps {
  lang: Language;
  /** Pager state from usePagedRows (page/clamp already handled there). */
  pager: UsePagedRowsResult<unknown>;
}

/**
 * Standard table pager: previous/next, "Page X of Y" and the visible row
 * range. Renders NOTHING when everything fits on a single page — small
 * tables keep their current look.
 */
export function TablePager({ lang, pager }: TablePagerProps) {
  if (pager.pageCount <= 1) return null;
  return (
    <div className="table-pager" role="navigation" aria-label={t(lang, 'pager.pageOf', { page: pager.page, pages: pager.pageCount })}>
      <button type="button" className="btn btn-ghost" disabled={pager.page <= 1} onClick={() => pager.setPage(pager.page - 1)}>
        {t(lang, 'pager.prev')}
      </button>
      <span className="table-pager-info">
        {t(lang, 'pager.pageOf', { page: pager.page, pages: pager.pageCount })}
        {pager.total > 0 ? ` · ${t(lang, 'pager.showing', { from: pager.from, to: pager.to, total: pager.total })}` : ''}
      </span>
      <button type="button" className="btn btn-ghost" disabled={pager.page >= pager.pageCount} onClick={() => pager.setPage(pager.page + 1)}>
        {t(lang, 'pager.next')}
      </button>
    </div>
  );
}

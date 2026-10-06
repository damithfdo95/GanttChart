import type { Language } from '../../types';
import { t } from '../../i18n';
import type { TesterReview } from '../../types';
import { formatDateDisplay, parseDate } from '../../lib/dates/dates';

interface ReviewHistoryProps {
  lang: Language;
  reviews: readonly TesterReview[];
  currentPeriodStart: string;
  currentPeriodEnd: string;
  onSelect: (review: TesterReview) => void;
  onRemove: (review: TesterReview) => void;
}

function periodTypeLabel(lang: Language, periodType: TesterReview['periodType']): string {
  switch (periodType) {
    case 'month':
      return t(lang, 'review.periodTypeMonth');
    case 'h1':
      return t(lang, 'review.periodTypeH1');
    case 'h2':
      return t(lang, 'review.periodTypeH2');
    case 'year':
      return t(lang, 'review.periodTypeYear');
    default:
      return t(lang, 'review.periodTypeCustom');
  }
}

/**
 * A tester's preserved review history (V6.7 §24): each period is stored
 * independently, so H1 is never overwritten when H2 is created. Reviews are
 * listed chronologically — never ranked.
 */
export function ReviewHistory({ lang, reviews, currentPeriodStart, currentPeriodEnd, onSelect, onRemove }: ReviewHistoryProps) {
  if (reviews.length === 0) {
    return <p className="dr-empty">{t(lang, 'review.noReviews')}</p>;
  }
  const sorted = [...reviews].sort(
    (a, b) => a.periodStart.localeCompare(b.periodStart) || a.periodEnd.localeCompare(b.periodEnd),
  );
  return (
    <div className="table-wrap">
      <table className="dr-table">
        <thead>
          <tr>
            <th scope="col">{t(lang, 'review.period')}</th>
            <th scope="col">{t(lang, 'review.status')}</th>
            <th scope="col">{t(lang, 'columns.actions')}</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((review) => {
            const isCurrent = review.periodStart === currentPeriodStart && review.periodEnd === currentPeriodEnd;
            const updatedEpoch = parseDate(review.updatedAt.slice(0, 10));
            const updatedDisplay = updatedEpoch === null ? review.updatedAt.slice(0, 10) : formatDateDisplay(updatedEpoch, lang);
            return (
              <tr key={review.id} className={isCurrent ? 'row-selected' : undefined}>
                <td>
                  {periodTypeLabel(lang, review.periodType)} {review.periodStart} ~ {review.periodEnd}
                  <br />
                  <small>{t(lang, 'review.completedOn', { date: updatedDisplay })}</small>
                </td>
                <td>{review.status === 'completed' ? t(lang, 'review.completed') : t(lang, 'review.draft')}</td>
                <td className="dr-row-actions">
                  <button type="button" className="btn" onClick={() => onSelect(review)}>
                    {t(lang, 'review.loadReview')}
                  </button>
                  <button type="button" className="btn btn-danger" onClick={() => onRemove(review)}>
                    {t(lang, 'review.deleteReview')}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

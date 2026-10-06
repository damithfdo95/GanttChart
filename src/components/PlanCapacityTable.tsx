import type { Language, PlanningRow } from '../types';
import type { MultiDayProjectionResult } from '../lib/calculations/planning';
import { formatCases, formatClock, formatDuration, formatInteger } from '../lib/formatting/format';
import { formatDateDisplay, parseDate } from '../lib/dates/dates';
import { t } from '../i18n';

interface PlanCapacityTableProps {
  rows: PlanningRow[];
  projection: MultiDayProjectionResult;
  lang: Language;
}

/**
 * Multi-day capacity table (V2). Highlights the projected completion row,
 * mutes non-working days (the row's own flag, weekends and Japanese public
 * holidays) and flags working days that ended up with zero capacity
 * (low-capacity warning). Remaining cases are clamped for display.
 */
export function PlanCapacityTable({ rows, projection, lang }: PlanCapacityTableProps) {
  const { projectedCompletion } = projection;
  return (
    <div className="table-wrap">
      <table className="plan-capacity-table">
        <thead>
          <tr>
            <th scope="col" className="num">#</th>
            <th scope="col">{t(lang, 'columns.date')}</th>
            <th scope="col" className="num">{t(lang, 'columns.plannedTesters')}</th>
            <th scope="col" className="num">{t(lang, 'columns.absentTesters')}</th>
            <th scope="col" className="num">{t(lang, 'columns.availableTesters')}</th>
            <th scope="col" className="num">{t(lang, 'columns.productiveHours')}</th>
            <th scope="col" className="num">{t(lang, 'columns.dailyCapacity')}</th>
            <th scope="col" className="num">{t(lang, 'columns.cumulativeCapacity')}</th>
            <th scope="col" className="num">{t(lang, 'columns.remaining')}</th>
            <th scope="col">{t(lang, 'columns.note')}</th>
          </tr>
        </thead>
      <tbody>
        {rows.map((row, i) => {
          const dayRow = projection.rows[i];
          const effectiveOff = dayRow.nonWorkingDay;
          const completesTime =
            projectedCompletion !== null && projectedCompletion.dayIndex === i ? projectedCompletion.time : null;
          const rowClass =
            completesTime !== null
              ? 'completes'
              : effectiveOff
                ? 'off'
                : dayRow.effectiveTesters === 0
                  ? 'warn'
                  : undefined;
          const epoch = parseDate(row.date);
          return (
            <tr key={row.id} className={rowClass}>
              <td className="num">{i + 1}</td>
              <td>
                {epoch === null ? row.date : formatDateDisplay(epoch, lang)}
                {effectiveOff ? <span className="tag tag-off">{t(lang, 'plan.nonWorkingTag')}</span> : null}
                {completesTime !== null ? (
                  <span className="tag tag-completes">
                    {t(lang, 'plan.completesHere')} {formatClock(completesTime)}
                  </span>
                ) : null}
              </td>
              <td className="num">{formatInteger(row.plannedTesters, lang)}</td>
              <td className="num">{formatInteger(row.absentTesters, lang)}</td>
              <td className="num">
                {formatInteger(dayRow.availableTesters, lang)}
                {rowClass === 'warn' ? <span className="tag tag-warn">{t(lang, 'plan.zeroCapacityTag')}</span> : null}
              </td>
              <td className="num">{formatDuration(dayRow.productiveHours * 60)}</td>
              <td className="num">{formatCases(dayRow.dailyCapacity, lang)}</td>
              <td className="num">{formatCases(dayRow.cumulativeCapacity, lang)}</td>
              <td className="num">{formatCases(Math.max(0, dayRow.remainingCases), lang)}</td>
              <td className="note-cell">{row.note === '' ? '—' : row.note}</td>
            </tr>
          );
        })}
        </tbody>
      </table>
    </div>
  );
}

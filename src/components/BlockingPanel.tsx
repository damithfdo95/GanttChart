import { useMemo } from 'react';
import { useAppStateCtx } from '../app/state-contexts';
import { formatDate, todayEpochDays } from '../lib/dates/dates';
import { generateId } from '../lib/id';
import { calculateTeamCapacity } from '../lib/calculations/capacity';
import { calculateProductiveElapsedTime } from '../lib/calculations/schedule';
import { WORK_LUNCH } from '../lib/calculations/workday';
import {
  calculateAvailableCapacityCases,
  calculateEffectiveElapsedMinutes,
  calculateLostCapacityCases,
  calculateTesterUtilization,
  sumBlockingMinutes,
  sumBlockingMinutesByCategory,
} from '../lib/calculations/blocking';
import { BLOCKING_CATEGORIES, type BlockingCategory, type BlockingEvent } from '../types';
import { formatCases, formatDuration, formatInteger, formatNumber } from '../lib/formatting/format';
import { t, type TranslationKey } from '../i18n';
import { MetricCard } from './MetricCard';
import { TablePager } from './TablePager';
import { usePagedRows } from '../lib/pagination/usePagedRows';

const BLOCKING_CAT_KEY: Record<BlockingCategory, TranslationKey> = {
  ENVIRONMENT: 'blocking.cat.ENVIRONMENT',
  BUILD: 'blocking.cat.BUILD',
  TEST_DATA: 'blocking.cat.TEST_DATA',
  REQUIREMENT: 'blocking.cat.REQUIREMENT',
  SYSTEM_ISSUE: 'blocking.cat.SYSTEM_ISSUE',
  OTHER: 'blocking.cat.OTHER',
};

interface BlockingPanelProps {
  /** Current wall-clock minutes-of-day (drives the live time metrics). */
  now: number;
}

/**
 * Level 2 §5: QA blocking / lost-time analysis. Events are categorized
 * unavailable-time records in the shared project state; the classic engine
 * semantics are untouched - the metrics below are the QA-specific view.
 */
export function BlockingPanel({ now }: BlockingPanelProps) {
  const { state, updateField } = useAppStateCtx();
  const lang = state.language;
  const today = formatDate(todayEpochDays());
  const events = state.blockingEvents ?? [];

  const productiveElapsedMinutes = calculateProductiveElapsedTime(now, state.startTime, WORK_LUNCH);
  const capacityPerHour = calculateTeamCapacity(state.currentTesters, state.perHourPerTester);
  const todayUnavailable = useMemo(() => sumBlockingMinutes(events, today), [events, today]);
  const effectiveMinutes = calculateEffectiveElapsedMinutes(productiveElapsedMinutes, todayUnavailable);
  const lostCases = calculateLostCapacityCases(todayUnavailable, capacityPerHour);
  const availableCases = calculateAvailableCapacityCases(effectiveMinutes, capacityPerHour);
  const utilization = calculateTesterUtilization(productiveElapsedMinutes, todayUnavailable);
  const byCategory = useMemo(() => sumBlockingMinutesByCategory(events), [events]);
  // Events accumulate over the project's life — displayed newest-first and
  // paginated (the metrics cards above always use the complete list).
  const sortedEvents = useMemo(() => [...events].sort((a, b) => b.date.localeCompare(a.date)), [events]);
  const pager = usePagedRows(sortedEvents, 10);

  const setEvents = (next: BlockingEvent[]): void => updateField('blockingEvents', next);

  const addEvent = (): void => {
    setEvents([...events, { id: generateId(), date: today, category: 'ENVIRONMENT', minutes: 30, note: '' }]);
  };

  const updateEvent = (id: string, patch: Partial<BlockingEvent>): void => {
    setEvents(events.map((event) => (event.id === id ? { ...event, ...patch } : event)));
  };

  const removeEvent = (id: string): void => {
    if (!window.confirm(t(lang, 'blocking.confirmRemove'))) return;
    setEvents(events.filter((event) => event.id !== id));
  };

  return (
    <section className="blocking-panel">
      <div className="metrics-grid">
        <MetricCard label={t(lang, 'blocking.todayUnavailable')} value={formatDuration(todayUnavailable)} />
        <MetricCard label={t(lang, 'blocking.effectiveTime')} value={formatDuration(effectiveMinutes)} />
        <MetricCard
          label={t(lang, 'blocking.lostCapacity')}
          value={`${formatCases(lostCases, lang)} ${t(lang, 'units.cases')}`}
          tone={lostCases > 0 ? 'bad' : 'default'}
        />
        <MetricCard
          label={t(lang, 'blocking.availableCapacity')}
          value={`${formatCases(availableCases, lang)} ${t(lang, 'units.cases')}`}
        />
        <MetricCard
          label={t(lang, 'blocking.utilization')}
          value={utilization === null ? '—' : `${formatNumber(utilization * 100, 1, lang)}%`}
          tone={utilization === null ? 'default' : utilization >= 0.9 ? 'good' : utilization < 0.7 ? 'bad' : 'default'}
        />
        <MetricCard label={t(lang, 'blocking.totalUnavailable')} value={formatDuration(sumBlockingMinutes(events))} />
      </div>

      <div className="blocking-actions">
        <button type="button" className="btn" onClick={addEvent}>
          {t(lang, 'blocking.addEvent')}
        </button>
      </div>

      {events.length === 0 ? (
        <p className="empty-note">{t(lang, 'blocking.noEvents')}</p>
      ) : (
        <div className="table-wrap">
          <table className="dr-table blocking-table">
            <thead>
              <tr>
                <th scope="col">{t(lang, 'columns.date')}</th>
                <th scope="col">{t(lang, 'blocking.category')}</th>
                <th scope="col" className="num">{t(lang, 'blocking.minutes')}</th>
                <th scope="col">{t(lang, 'blocking.note')}</th>
                <th scope="col">{t(lang, 'columns.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {pager.pagedRows.map((event) => (
                <tr key={event.id}>
                  <td>
                    <input
                      className="input input-date"
                      type="date"
                      aria-label={t(lang, 'columns.date')}
                      value={event.date}
                      onChange={(e) => updateEvent(event.id, { date: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      className="input"
                      aria-label={t(lang, 'blocking.category')}
                      value={event.category}
                      onChange={(e) => updateEvent(event.id, { category: e.target.value as BlockingCategory })}
                    >
                      {BLOCKING_CATEGORIES.map((category) => (
                        <option key={category} value={category}>
                          {t(lang, BLOCKING_CAT_KEY[category])}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="num">
                    <input
                      className="input input-cell"
                      type="number"
                      min={1}
                      step={5}
                      aria-label={t(lang, 'blocking.minutes')}
                      value={event.minutes}
                      onChange={(e) => updateEvent(event.id, { minutes: Math.max(1, Number(e.target.value) || 0) })}
                    />
                  </td>
                  <td>
                    <input
                      className="input"
                      type="text"
                      aria-label={t(lang, 'blocking.note')}
                      value={event.note}
                      onChange={(e) => updateEvent(event.id, { note: e.target.value })}
                    />
                  </td>
                  <td>
                    <button type="button" className="btn btn-ghost" onClick={() => removeEvent(event.id)}>
                      {t(lang, 'buttons.remove')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <TablePager lang={lang} pager={pager} />

      {events.length === 0 ? null : (
        <div className="blocking-by-category">
          <span className="blocking-cat-title">{t(lang, 'blocking.byCategory')} ({t(lang, 'blocking.scopeAll')}):</span>
          {BLOCKING_CATEGORIES.map((category) => (
            <span key={category} className="gap-pill">
              {t(lang, BLOCKING_CAT_KEY[category])}: {formatInteger(byCategory[category], lang)} {t(lang, 'units.minutes')}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

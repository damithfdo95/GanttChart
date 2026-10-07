import { useMemo, useState } from 'react';
import type { RcsMember, TesterReview } from '../../types';
import { useAppStateCtx, useReportsStateCtx } from '../../app/state-contexts';
import { t, type TranslationKey } from '../../i18n';
import { formatDate, todayEpochDays } from '../../lib/dates/dates';
import { formatInteger } from '../../lib/formatting/format';
import {
  comparePeriods,
  getPeriodRange,
  getPreviousPeriod,
  getTesterReviewMetrics,
  type PeriodSelector,
} from '../../lib/calculations/testerPerformance';
import { findMemberById, nameHistoryEntryLabel } from '../../domain/members';
import { createTesterReview, findTesterReview, getTesterReviewHistory } from '../../domain/reviews';
import { ReviewSummary } from './ReviewSummary';
import { ReviewForm } from './ReviewForm';
import { ReviewHistory } from './ReviewHistory';

type PeriodKind = 'month' | 'h1' | 'h2' | 'year' | 'custom';

const MONTH_LABELS: string[] = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];

const COMPARISON_LABEL_KEYS: Record<string, TranslationKey> = {
  casesTested: 'performance.casesTestedField',
  casesPassed: 'columns.pass',
  casesFailed: 'fields.casesFailed',
  casesNotApplicable: 'columns.notApplicable',
  casesBlocked: 'columns.blocked',
  casesRetest: 'fields.casesRetest',
  casesQuestioned: 'fields.casesQuestioned',
  casesSpoAssigned: 'columns.spoAssigned',
  bugsFound: 'performance.bugsFound',
  activeDays: 'performance.activeDays',
};

/** One selectable tester: a stable member identity or a legacy name. */
interface TesterOption {
  key: string;
  label: string;
  member?: RcsMember;
}

/**
 * Bonus Review workspace (V6.7 Part B): the supervisor selects a period and
 * a tester, reviews the objective evidence (recalculated from the V6.6
 * evidence chain — never stored), compares with the previous period
 * factually, and records notes. The application never computes a bonus
 * amount, rating, rank or "best tester". V6.8: tester identity resolves
 * through the RCS member master ("USER0003 — Yamauchi Kentaro"); legacy
 * name-based history keeps working unchanged.
 */
export function ReviewTab() {
  const app = useAppStateCtx();
  const reportsApi = useReportsStateCtx();
  const lang = app.state.language;

  const today = formatDate(todayEpochDays());
  const defaultYear = Number(today.slice(0, 4));
  const defaultMonth = Number(today.slice(5, 7));

  const [periodKind, setPeriodKind] = useState<PeriodKind>(defaultMonth <= 6 ? 'h1' : 'h2');
  const [year, setYear] = useState<number>(defaultYear);
  const [month, setMonth] = useState<number>(defaultMonth);
  const [customStart, setCustomStart] = useState<string>(today);
  const [customEnd, setCustomEnd] = useState<string>(today);
  const [selectedTester, setSelectedTester] = useState<string>('');
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  const projects = reportsApi.state.projects;
  const reviews = reportsApi.state.reviews ?? [];
  const members = reportsApi.state.rcsMembers ?? [];

  const allRecords = useMemo(
    () => projects.flatMap((p) => p.inputs.testerDailyPerformance ?? []),
    [projects],
  );
  const allTickets = useMemo(() => projects.flatMap((p) => p.inputs.bugTickets ?? []), [projects]);

  // Registered RCS members only; inactive members stay visible for their historical reviews (§9).
  const testerOptions = useMemo<TesterOption[]>(
    () =>
      [...members]
        .map((member) => ({ key: member.id, label: member.name, member }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [members],
  );

  const years = useMemo(() => {
    const set = new Set<number>([defaultYear]);
    for (const record of allRecords) {
      const y = Number(record.date.slice(0, 4));
      if (Number.isFinite(y)) set.add(y);
    }
    for (const ticket of allTickets) {
      const y = Number(ticket.createdAt.slice(0, 4));
      if (Number.isFinite(y)) set.add(y);
    }
    return [...set].sort((a, b) => b - a);
  }, [allRecords, allTickets, defaultYear]);

  const selector: PeriodSelector = useMemo(() => {
    switch (periodKind) {
      case 'month':
        return { kind: 'month', year, month };
      case 'year':
        return { kind: 'year', year };
      case 'h1':
        return { kind: 'halfYear', year, half: 1 };
      case 'h2':
        return { kind: 'halfYear', year, half: 2 };
      default:
        return { kind: 'custom', start: customStart, end: customEnd };
    }
  }, [periodKind, year, month, customStart, customEnd]);

  const range = useMemo(() => getPeriodRange(selector), [selector]);

  const periodLabel =
    range === null
      ? '—'
      : periodKind === 'month'
        ? `${year}-${MONTH_LABELS[month - 1]}`
        : periodKind === 'h1'
          ? `${t(lang, 'performance.periodH1')} ${year}`
          : periodKind === 'h2'
            ? `${t(lang, 'performance.periodH2')} ${year}`
            : periodKind === 'year'
              ? String(year)
              : `${range.start} ~ ${range.end}`;

  const metrics = useMemo(
    () =>
      range === null || selectedTester === ''
        ? null
        : getTesterReviewMetrics(allRecords, allTickets, selectedTester, range),
    [range, selectedTester, allRecords, allTickets],
  );

  const previousSelector = useMemo(() => getPreviousPeriod(selector), [selector]);
  const previousRange = useMemo(
    () => (previousSelector === null ? null : getPeriodRange(previousSelector)),
    [previousSelector],
  );
  const comparison = useMemo(() => {
    if (previousRange === null || metrics === null) return null;
    const previousMetrics = getTesterReviewMetrics(allRecords, allTickets, selectedTester, previousRange, members);
    return { previousRow: previousMetrics.row, entries: comparePeriods(previousMetrics.row, metrics.row) };
  }, [previousRange, metrics, allRecords, allTickets, selectedTester, members]);

  const previousPeriodLabel =
    previousRange === null || previousSelector === null
      ? null
      : previousSelector.kind === 'month'
        ? `${previousSelector.year}-${MONTH_LABELS[previousSelector.month - 1]}`
        : previousSelector.kind === 'halfYear'
          ? `${t(lang, previousSelector.half === 1 ? 'performance.periodH1' : 'performance.periodH2')} ${previousSelector.year}`
          : previousSelector.kind === 'year'
            ? String(previousSelector.year)
            : `${previousRange.start} ~ ${previousRange.end}`;

  const existingReview = useMemo(
    () =>
      selectedTester === '' || range === null
        ? null
        : findTesterReview(reviews, selectedTester, range.start, range.end, members) ?? null,
    [reviews, selectedTester, range, members],
  );

  const history = useMemo(
    () => (selectedTester === '' ? [] : getTesterReviewHistory(reviews, selectedTester, members)),
    [reviews, selectedTester, members],
  );

  const handleSave = (input: Omit<TesterReview, 'id' | 'createdAt' | 'updatedAt'>, original: TesterReview | null): void => {
    const nowIso = new Date().toISOString();
    const review = original === null ? createTesterReview(input, nowIso) : { ...original, ...input, updatedAt: nowIso };
    reportsApi.upsertReview(review);
    setSavedNotice(
      review.status === 'completed' ? t(lang, 'review.savedCompleted') : t(lang, 'review.savedDraft'),
    );
  };

  const handleRemove = (review: TesterReview): void => {
    if (window.confirm(t(lang, 'review.confirmDelete'))) reportsApi.removeReview(review.id);
  };

  const selectedMember = selectedTester === '' ? undefined : findMemberById(members, selectedTester);

  const handleSelectHistory = (review: TesterReview): void => {
    switch (review.periodType) {
      case 'month':
        setPeriodKind('month');
        setYear(Number(review.periodStart.slice(0, 4)));
        setMonth(Number(review.periodStart.slice(5, 7)) || 1);
        break;
      case 'h1':
        setPeriodKind('h1');
        setYear(Number(review.periodStart.slice(0, 4)));
        break;
      case 'h2':
        setPeriodKind('h2');
        setYear(Number(review.periodStart.slice(0, 4)));
        break;
      case 'year':
        setPeriodKind('year');
        setYear(Number(review.periodStart.slice(0, 4)));
        break;
      default:
        setPeriodKind('custom');
        setCustomStart(review.periodStart);
        setCustomEnd(review.periodEnd);
        break;
    }
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title-group">
          <h1>{t(lang, 'review.title')}</h1>
          <span className="app-subtitle">{t(lang, 'review.subtitle')}</span>
        </div>
      </header>

      <section className="dr-section">
        <div className="dr-filter-bar">
          <label>
            {t(lang, 'review.period')}
            <select className="input" value={periodKind} onChange={(e) => setPeriodKind(e.target.value as PeriodKind)}>
              <option value="month">{t(lang, 'review.periodTypeMonth')}</option>
              <option value="h1">{t(lang, 'review.periodTypeH1')}</option>
              <option value="h2">{t(lang, 'review.periodTypeH2')}</option>
              <option value="year">{t(lang, 'review.periodTypeYear')}</option>
              <option value="custom">{t(lang, 'review.periodTypeCustom')}</option>
            </select>
          </label>
          {periodKind === 'month' ? (
            <>
              <label>
                {t(lang, 'performance.year')}
                <select className="input" value={year} onChange={(e) => setYear(Number(e.target.value))}>
                  {years.map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t(lang, 'performance.monthLabel')}
                <select className="input" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
                  {MONTH_LABELS.map((label, index) => (
                    <option key={label} value={index + 1}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : null}
          {periodKind === 'h1' || periodKind === 'h2' || periodKind === 'year' ? (
            <label>
              {t(lang, 'performance.year')}
              <select className="input" value={year} onChange={(e) => setYear(Number(e.target.value))}>
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {periodKind === 'custom' ? (
            <>
              <label>
                {t(lang, 'performance.startDate')}
                <input className="input" type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} />
              </label>
              <label>
                {t(lang, 'performance.endDate')}
                <input className="input" type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} />
              </label>
            </>
          ) : null}
          <label>
            {t(lang, 'performance.testerName')}
            <select
              className="input"
              value={selectedTester}
              onChange={(e) => {
                setSavedNotice(null);
                setSelectedTester(e.target.value);
              }}
            >
              <option value="">{t(lang, 'review.selectTester')}</option>
              {testerOptions.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {selectedTester !== '' && range !== null && metrics !== null ? (
        <>
          <section className="dr-section">
            <h2>
              {t(lang, 'review.objectiveMetrics')} — {selectedMember !== undefined ? `${selectedMember.id} ${selectedMember.name}` : selectedTester}
            </h2>
            <p className="dr-summary">
              {selectedMember !== undefined ? selectedMember.role : ''}
              {selectedMember !== undefined ? ' · ' : ''}
              {t(lang, 'review.period')}: {periodLabel}
              {existingReview !== null
                ? ` · ${t(lang, 'review.status')}: ${existingReview.status === 'completed' ? t(lang, 'review.completed') : t(lang, 'review.draft')}`
                : ''}
            </p>
            {selectedMember !== undefined && (selectedMember.nameHistory ?? []).length > 0 ? (
              <p className="dr-summary">
                {t(lang, 'members.nameHistory')}:{' '}
                {(selectedMember.nameHistory ?? []).map((entry) => nameHistoryEntryLabel(entry)).join(' / ')}
              </p>
            ) : null}
            <ReviewSummary lang={lang} metrics={metrics} projects={projects} />
          </section>

          {comparison !== null && previousPeriodLabel !== null ? (
            <section className="dr-section">
              <h2>
                {t(lang, 'review.previousPeriod')} ({previousPeriodLabel}) → {t(lang, 'review.currentPeriod')} ({periodLabel})
              </h2>
              <div className="table-wrap">
                <table className="dr-table">
                  <thead>
                    <tr>
                      <th scope="col">{t(lang, 'columns.item')}</th>
                      <th scope="col" className="num">{t(lang, 'review.previousPeriod')}</th>
                      <th scope="col" className="num">{t(lang, 'review.currentPeriod')}</th>
                      <th scope="col" className="num">±</th>
                    </tr>
                  </thead>
                  <tbody>
                    {comparison.entries.map((entry) => (
                      <tr key={entry.key}>
                        <td>{t(lang, COMPARISON_LABEL_KEYS[entry.key])}</td>
                        <td className="num">{formatInteger(entry.previous, lang)}</td>
                        <td className="num">{formatInteger(entry.current, lang)}</td>
                        <td className="num">{entry.difference > 0 ? `+${formatInteger(entry.difference, lang)}` : formatInteger(entry.difference, lang)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          <section className="dr-section">
            <h2>{t(lang, 'review.notesSection')}</h2>
            <p className="dr-summary">{t(lang, 'review.disclaimer')}</p>
            {savedNotice !== null ? (
              <p className="data-controls-message ok" role="status">
                {savedNotice}
              </p>
            ) : null}
            <ReviewForm
              key={`${selectedTester}|${range.start}|${range.end}`}
              lang={lang}
              existing={existingReview}
              testerName={selectedMember?.name ?? selectedTester}
              member={selectedMember}
              periodType={periodKind === 'h1' || periodKind === 'h2' ? (periodKind as 'h1' | 'h2') : periodKind}
              periodStart={range.start}
              periodEnd={range.end}
              onSave={handleSave}
            />
          </section>

          <section className="dr-section">
            <h2>{t(lang, 'review.reviewHistory')} — {selectedMember !== undefined ? `${selectedMember.id} ${selectedMember.name}` : selectedTester}</h2>
            <ReviewHistory
              lang={lang}
              reviews={history}
              currentPeriodStart={range.start}
              currentPeriodEnd={range.end}
              onSelect={handleSelectHistory}
              onRemove={handleRemove}
            />
          </section>
        </>
      ) : (
        <section className="dr-section">
          <p className="dr-empty">{t(lang, 'review.selectTester')}</p>
        </section>
      )}
    </div>
  );
}

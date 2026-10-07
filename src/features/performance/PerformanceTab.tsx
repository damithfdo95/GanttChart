import { useMemo, useState } from 'react';
import type { PerformanceRecordSource, ProjectRecord, TesterDailyPerformance } from '../../types';
import { useAppStateCtx, useReportsStateCtx } from '../../app/state-contexts';
import { t } from '../../i18n';
import { formatDate, todayEpochDays } from '../../lib/dates/dates';
import { formatInteger } from '../../lib/formatting/format';
import { resolveBilingualName } from '../../i18n';
import { projectDisplayName } from '../../domain/projects';
import {
  aggregateTesterPerformance,
  getPeriodRange,
  getTesterMonthlyTrend,
  getTesterProjectBreakdown,
  performanceSummary,
  type PeriodHalf,
  type PeriodSelector,
} from '../../lib/calculations/testerPerformance';
import {
  removeTesterDailyPerformance,
  upsertTesterDailyPerformance,
} from '../../domain/performance';
import { dailyAttributionMismatches } from '../../lib/calculations/testerAttribution';
import { PerformanceSummaryCards } from './PerformanceSummary';
import { TesterPerformanceTable, sourceLabel } from './TesterPerformanceTable';
import { TesterDetail, type TesterDetailSummary } from './TesterDetail';
import { DailyExecutionForm, type ParsedDailyExecution } from './DailyExecutionForm';
import { SyncSection } from './SyncSection';
import { useAccess } from '../../app/access';
import { TesterProfileNotice } from '../tenancy/TesterProfileNotice';
import { TablePager } from '../../components/TablePager';
import { usePagedRows } from '../../lib/pagination/usePagedRows';

type PeriodKind = PeriodSelector['kind'];

const MONTH_LABELS: string[] = [
  '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12',
];

function availableYears(projects: readonly ProjectRecord[], fallback: number): number[] {
  const years = new Set<number>([fallback]);
  for (const project of projects) {
    for (const record of project.inputs.testerDailyPerformance ?? []) {
      const year = Number(record.date.slice(0, 4));
      if (Number.isFinite(year)) years.add(year);
    }
    for (const ticket of project.inputs.bugTickets ?? []) {
      const year = Number(ticket.createdAt.slice(0, 4));
      if (Number.isFinite(year)) years.add(year);
    }
  }
  return [...years].sort((a, b) => b - a);
}

/**
 * Performance screen (V6.6): objective tester analytics over the existing
 * evidence chain. Reads every project's tester daily records and bug
 * tickets — including Done projects (§22) — aggregates them with the pure
 * calculation module, and never computes a bonus/salary/rating score.
 */
export function PerformanceTab() {
  const app = useAppStateCtx();
  const reportsApi = useReportsStateCtx();
  const lang = app.state.language;

  const today = formatDate(todayEpochDays());
  const defaultYear = Number(today.slice(0, 4));
  const defaultMonth = Number(today.slice(5, 7));

  const [periodKind, setPeriodKind] = useState<PeriodKind>('month');
  const [year, setYear] = useState<number>(defaultYear);
  const [month, setMonth] = useState<number>(defaultMonth);
  const [half, setHalf] = useState<PeriodHalf>(defaultMonth <= 6 ? 1 : 2);
  const [customStart, setCustomStart] = useState<string>(today);
  const [customEnd, setCustomEnd] = useState<string>(today);
  const [projectScope, setProjectScope] = useState<string>('');
  const [selectedTester, setSelectedTester] = useState<string | null>(null);

  const projects = reportsApi.state.projects;
  const members = reportsApi.state.rcsMembers ?? [];
  const access = useAccess();
  const tester = access.isTester;
  const ownMember = members.find((m) => m.id === access.ownMemberId) ?? null;
  /** A Tester changes only their own rows (the server enforces the same). */
  const isOwnRow = (record: TesterDailyPerformance): boolean => !tester || (access.ownMemberId !== null && record.memberId === access.ownMemberId);
  const activeMembers = useMemo(() => members.filter((member) => member.active), [members]);

  // Full evidence across ALL projects (Done included — §22).
  const allRecords = useMemo(
    () => projects.flatMap((p) => p.inputs.testerDailyPerformance ?? []),
    [projects],
  );
  const allTickets = useMemo(() => projects.flatMap((p) => p.inputs.bugTickets ?? []), [projects]);

  const memberNames = useMemo(() => {
    const names = new Set<string>();
    for (const record of reportsApi.state.attendance) {
      const name = record.memberName.trim();
      if (name !== '') names.add(name);
    }
    for (const record of allRecords) {
      const name = record.testerName.trim();
      if (name !== '') names.add(name);
    }
    return [...names].sort();
  }, [reportsApi.state.attendance, allRecords]);

  const selector: PeriodSelector = useMemo(() => {
    switch (periodKind) {
      case 'month':
        return { kind: 'month', year, month };
      case 'year':
        return { kind: 'year', year };
      case 'halfYear':
        return { kind: 'halfYear', year, half };
      default:
        return { kind: 'custom', start: customStart, end: customEnd };
    }
  }, [periodKind, year, month, half, customStart, customEnd]);

  const range = useMemo(() => getPeriodRange(selector), [selector]);
  const scopeProjectIds = projectScope === '' ? null : [projectScope];

  const options = useMemo(
    () => ({ range, projectIds: scopeProjectIds, members }),
    [range, scopeProjectIds, members],
  );

  const rows = useMemo(
    () => aggregateTesterPerformance(allRecords, allTickets, options),
    [allRecords, allTickets, options],
  );
  const summary = useMemo(
    () => performanceSummary(allRecords, allTickets, options),
    [allRecords, allTickets, options],
  );

  const selectedRow =
    selectedTester === null ? null : rows.find((row) => (row.memberId ?? row.testerName) === selectedTester) ?? null;
  const detailSummary: TesterDetailSummary | null =
    selectedRow === null
      ? null
      : {
          casesTested: selectedRow.casesTested,
          activeDays: selectedRow.activeDays,
          projects: selectedRow.projectIds.length,
          bugsFound: selectedRow.bugsFound,
        };
  const breakdown = useMemo(
    () => (selectedTester === null ? [] : getTesterProjectBreakdown(allRecords, allTickets, selectedTester, options)),
    [selectedTester, allRecords, allTickets, options],
  );
  const trend = useMemo(
    () => (selectedTester === null ? [] : getTesterMonthlyTrend(allRecords, allTickets, selectedTester, options)),
    [selectedTester, allRecords, allTickets, options],
  );

  const periodLabel =
    range === null
      ? '—'
      : periodKind === 'month'
        ? `${year}-${MONTH_LABELS[month - 1]}`
        : periodKind === 'halfYear'
          ? `${t(lang, half === 1 ? 'performance.periodH1' : 'performance.periodH2')} ${year}`
          : periodKind === 'year'
            ? String(year)
            : `${range.start} ~ ${range.end}`;

  // ---- active-project daily execution entry (V6.6 §12) ----
  const activeProject = projects.find((p) => p.id === reportsApi.state.activeProjectId);
  const activeProjectId = activeProject?.projectId ?? '';
  const activeRecords: TesterDailyPerformance[] = app.state.testerDailyPerformance ?? [];
  const activeProjectName =
    activeProject !== undefined
      ? projectDisplayName(activeProject, lang)
      : resolveBilingualName(lang, { nameEn: app.state.projectNameEn, nameJa: app.state.projectNameJa });

  const [editingRecord, setEditingRecord] = useState<TesterDailyPerformance | undefined>(undefined);

  // Input-consolidation check: dates where Σ tester casesTested disagrees
  // with the project's daily execution entry (the canonical input).
  const attributionMismatches = useMemo(
    () => (activeProjectId === '' ? [] : dailyAttributionMismatches(app.state.dailyExecuted ?? [], activeRecords)),
    [activeProjectId, app.state.dailyExecuted, activeRecords],
  );

  const handleDailySubmit = (values: ParsedDailyExecution): void => {
    if (activeProjectId === '') return;
    // Manual entries are marked 'manual'; correcting an automatic/assisted
    // record marks it as a manual override that sync never overwrites (§12).
    const source =
      editingRecord !== undefined &&
      (editingRecord.source === 'automatic' || editingRecord.source === 'assisted')
        ? 'manualOverride'
        : 'manual';
    app.updateField(
      'testerDailyPerformance',
      upsertTesterDailyPerformance(activeRecords, activeProjectId, { ...values, source }),
    );
    setEditingRecord(undefined);
  };

  /**
   * Sync write helper (V6.7): the ACTIVE project's records route through the
   * app-state editing surface (so the write-back stays authoritative), all
   * other projects through the reports registry directly.
   */
  const handleProjectRecordsChange = (
    projectRecordId: string,
    records: readonly TesterDailyPerformance[],
  ): void => {
    const next = [...records];
    if (projectRecordId === reportsApi.state.activeProjectId) {
      app.updateField('testerDailyPerformance', next);
      return;
    }
    const project = projects.find((p) => p.id === projectRecordId);
    if (project === undefined) return;
    reportsApi.updateProject(projectRecordId, {
      inputs: { ...project.inputs, testerDailyPerformance: next },
    });
  };

  const handleEditRecord = (record: TesterDailyPerformance): void => {
    setEditingRecord(record);
  };

  /**
   * Apply one confirmed assisted allocation (V6.8 §17/§18, V6.9-B §10–§19):
   * each entry — including its granular Pass/Fail/NA/Blocked/Retest/
   * Questioned/SPO values — is upserted for the active project; untouched
   * suggestions land as assisted records, supervisor-edited values as
   * manual overrides that synchronization never overwrites.
   */
  const handleApplyAllocation = (
    projectId: string,
    date: string,
    entries: readonly {
      memberId?: string;
      testerName: string;
      casesTested: number;
      casesPassed?: number;
      casesFailed?: number;
      casesNotApplicable?: number;
      casesBlocked?: number;
      casesRetest?: number;
      casesQuestioned?: number;
      casesSpoAssigned?: number;
      source: PerformanceRecordSource;
    }[],
  ): void => {
    if (projectId !== activeProjectId || activeProjectId === '') return;
    let records = activeRecords;
    for (const entry of entries) {
      records = upsertTesterDailyPerformance(records, activeProjectId, {
        date,
        testerName: entry.testerName,
        ...(entry.memberId !== undefined ? { memberId: entry.memberId } : {}),
        casesTested: entry.casesTested,
        ...(entry.casesPassed !== undefined ? { casesPassed: entry.casesPassed } : {}),
        ...(entry.casesFailed !== undefined ? { casesFailed: entry.casesFailed } : {}),
        ...(entry.casesNotApplicable !== undefined ? { casesNotApplicable: entry.casesNotApplicable } : {}),
        ...(entry.casesBlocked !== undefined ? { casesBlocked: entry.casesBlocked } : {}),
        ...(entry.casesRetest !== undefined ? { casesRetest: entry.casesRetest } : {}),
        ...(entry.casesQuestioned !== undefined ? { casesQuestioned: entry.casesQuestioned } : {}),
        ...(entry.casesSpoAssigned !== undefined ? { casesSpoAssigned: entry.casesSpoAssigned } : {}),
        source: entry.source,
      });
    }
    app.updateField('testerDailyPerformance', records);
  };

  const handleRemoveRecord = (record: TesterDailyPerformance): void => {
    // Removing a record is irreversible (sync cannot restore manual history).
    if (!window.confirm(t(lang, 'performance.confirmRemoveRecord'))) return;
    app.updateField('testerDailyPerformance', removeTesterDailyPerformance(activeRecords, record.id));
    if (editingRecord?.id === record.id) setEditingRecord(undefined);
  };

  const sortedActiveRecords = useMemo(
    () =>
      [...activeRecords].sort(
        (a, b) => b.date.localeCompare(a.date) || a.testerName.localeCompare(b.testerName),
      ),
    [activeRecords],
  );
  // One record per tester per executed day (newest-first) — paginated;
  // switching projects resets to the new project's first page.
  const pager = usePagedRows(sortedActiveRecords, 10, { resetKey: activeProjectId });

  const years = useMemo(() => availableYears(projects, defaultYear), [projects, defaultYear]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title-group">
          <h1>{t(lang, 'performance.title')}</h1>
          <span className="app-subtitle">{t(lang, 'performance.period')}: {periodLabel}</span>
        </div>
      </header>

      <section className="dr-section">
        <div className="dr-filter-bar">
          <label>
            {t(lang, 'performance.period')}
            <select className="input" value={periodKind} onChange={(e) => setPeriodKind(e.target.value as PeriodKind)}>
              <option value="month">{t(lang, 'performance.periodMonth')}</option>
              <option value="year">{t(lang, 'performance.periodYear')}</option>
              <option value="halfYear">{t(lang, 'performance.periodH1')} / {t(lang, 'performance.periodH2')}</option>
              <option value="custom">{t(lang, 'performance.periodCustom')}</option>
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
          {periodKind === 'year' ? (
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
          {periodKind === 'halfYear' ? (
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
                {t(lang, 'performance.period')}
                <select className="input" value={half} onChange={(e) => setHalf(Number(e.target.value) === 1 ? 1 : 2)}>
                  <option value={1}>{t(lang, 'performance.periodH1')}</option>
                  <option value={2}>{t(lang, 'performance.periodH2')}</option>
                </select>
              </label>
            </>
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
            {t(lang, 'performance.projectScope')}
            <select className="input" value={projectScope} onChange={(e) => setProjectScope(e.target.value)}>
              <option value="">{t(lang, 'performance.allProjects')}</option>
              {projects.map((p) => (
                <option key={p.projectId} value={p.projectId}>
                  {projectDisplayName(p, lang)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <PerformanceSummaryCards lang={lang} summary={summary} />

      <section className="dr-section">
        <h2>{t(lang, 'performance.title')}</h2>
        <TesterPerformanceTable
          lang={lang}
          rows={rows}
          projects={projects}
          selectedTester={selectedTester}
          onSelect={(key) => setSelectedTester((prev) => (prev === key ? null : key))}
        />
      </section>

      {selectedTester !== null && detailSummary !== null ? (
        <TesterDetail
          lang={lang}
          testerName={selectedTester}
          periodLabel={periodLabel}
          summary={detailSummary}
          breakdown={breakdown}
          trend={trend}
          projects={projects}
          onClose={() => setSelectedTester(null)}
        />
      ) : null}

      <section className="dr-section">
        <h2>{t(lang, 'performance.dailyExecutionTitle')}</h2>
        <p className="exec-help">{t(lang, 'performance.attributionHint')}</p>
        {activeProjectId !== '' ? (
          <div className="dp-history-compare" role="status">
            {attributionMismatches.length === 0 ? (
              <span className="gap-pill">{t(lang, 'performance.consistencyOk')}</span>
            ) : (
              <>
                <span className="gap-pill bad">{t(lang, 'performance.consistencyMismatch')}</span>
                {attributionMismatches.slice(0, 5).map((mismatch) => (
                  <span
                    key={mismatch.date}
                    className="gap-pill bad"
                    title={`${t(lang, 'performance.casesTested')}: ${mismatch.testersTotal} / ${t(lang, 'gap.dayExecuted')}: ${mismatch.entryCompleted}`}
                  >
                    {mismatch.date}: {t(lang, 'performance.casesTested')} {mismatch.testersTotal} / {t(lang, 'gap.dayExecuted')}{' '}
                    {mismatch.entryCompleted}
                  </span>
                ))}
                {attributionMismatches.length > 5 ? (
                  <span className="gap-pill bad">+{attributionMismatches.length - 5}</span>
                ) : null}
              </>
            )}
          </div>
        ) : null}
        <p className="dr-summary">
          {activeProjectName === '' ? '' : `${activeProjectName} — `}
          {t(lang, 'performance.casesTested')}: {formatInteger(activeRecords.reduce((sum, r) => sum + r.casesTested, 0), lang)}
        </p>
        <DailyExecutionForm
          key={editingRecord?.id ?? 'new'}
          lang={lang}
          members={activeMembers}
          memberNames={memberNames}
          {...(tester ? { lockedMember: ownMember } : {})}
          existing={editingRecord}
          disabled={activeProjectId === ''}
          onSubmit={handleDailySubmit}
          onCancelEdit={() => setEditingRecord(undefined)}
        />
        {tester && ownMember === null ? <TesterProfileNotice lang={lang} /> : null}
        <h3>{t(lang, 'performance.dailyRecords')}</h3>
        {sortedActiveRecords.length === 0 ? (
          <p className="dr-empty">{t(lang, 'performance.noDailyRecords')}</p>
        ) : (
          <div className="table-wrap">
            <table className="dr-table table-wide">
              <thead>
                <tr>
                  <th scope="col">{t(lang, 'columns.date')}</th>
                  <th scope="col">{t(lang, 'performance.tester')}</th>
                  <th scope="col" className="num">{t(lang, 'performance.cases')}</th>
                  <th scope="col" className="num">{t(lang, 'columns.pass')}</th>
                  <th scope="col" className="num">{t(lang, 'fields.casesFailed')}</th>
                  <th scope="col" className="num">{t(lang, 'columns.notApplicable')}</th>
                  <th scope="col" className="num">{t(lang, 'columns.blocked')}</th>
                  <th scope="col" className="num">{t(lang, 'fields.casesRetest')}</th>
                  <th scope="col" className="num">{t(lang, 'fields.casesQuestioned')}</th>
                  <th scope="col" className="num">{t(lang, 'columns.spoAssigned')}</th>
                  <th scope="col">{t(lang, 'performance.executionSource')}</th>
                  <th scope="col">{t(lang, 'columns.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {pager.pagedRows.map((record) => (
                  <tr key={record.id}>
                    <td>{record.date}</td>
                    <td>{record.memberId !== undefined ? `${record.memberId} — ` : ''}{record.testerName}</td>
                    <td className="num">{formatInteger(record.casesTested, lang)}</td>
                    <td className="num">{record.casesPassed ?? '—'}</td>
                    <td className="num">{record.casesFailed ?? '—'}</td>
                    <td className="num">{record.casesNotApplicable ?? '—'}</td>
                    <td className="num">{record.casesBlocked ?? '—'}</td>
                    <td className="num">{record.casesRetest ?? '—'}</td>
                    <td className="num">{record.casesQuestioned ?? '—'}</td>
                    <td className="num">{record.casesSpoAssigned ?? '—'}</td>
                    <td>{sourceLabel(lang, record.source)}</td>
                    <td className="dr-row-actions">
                      {isOwnRow(record) ? (
                        <>
                          <button type="button" className="btn" onClick={() => handleEditRecord(record)}>
                            {t(lang, 'buttons.edit')}
                          </button>
                          <button type="button" className="btn btn-danger" onClick={() => handleRemoveRecord(record)}>
                            {t(lang, 'buttons.remove')}
                          </button>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager lang={lang} pager={pager} />
      </section>

      {tester ? null : (
      <SyncSection
        lang={lang}
        activeProjectId={activeProjectId}
        activeProjectName={activeProjectName}
        projects={projects}
        assignments={reportsApi.state.testerAssignments ?? []}
        attendance={reportsApi.state.attendance}
        members={members}
        onProjectRecordsChange={handleProjectRecordsChange}
        onApplyAllocation={handleApplyAllocation}
        onUpsertAssignment={reportsApi.upsertTesterAssignment}
        onRemoveAssignment={reportsApi.removeTesterAssignment}
      />
      )}
    </div>
  );
}

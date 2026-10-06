import { useMemo, useRef, useState } from 'react';
import type { AttendanceStatus } from '../../types';
import { ATTENDANCE_STATUSES } from '../../types';
import { useAppStateCtx, useReportsStateCtx } from '../../app/state-contexts';
import { t, type TranslationKey } from '../../i18n';
import { calculateMultiDayProjection } from '../../lib/calculations/planning';
import { WORK_DAY_END, WORK_LUNCH } from '../../lib/calculations/workday';
import { aggregateTesterPerformance } from '../../lib/calculations/testerPerformance';
import {
  attendanceSheet,
  bugTicketsSheet,
  capacitySheet,
  dailyProgressSheet,
  executionHistorySheet,
  executionLogsSheet,
  filterAttendanceRecords,
  filterReports,
  managementSheet,
  overtimeSheet,
  projectsSheet,
  reportsSheet,
  rcsMembersSheet,
  summarySheet,
  testerAssignmentsSheet,
  testerDailyDetailSheet,
  testerPerformanceSheet,
  testerReviewsSheet,
  wbsSheet,
  type ExportFilters,
} from '../../lib/export/exportData';
import { buildManagementReportRow } from '../../lib/export/management';
import { buildXlsx, type XlsxSheet } from '../../lib/export/xlsx';
import { toCsv, csvValueFromCell } from '../../lib/export/csv';
import { downloadBinaryFile, downloadTextFile, escapeHtml } from '../../lib/export/download';
import { printHtml } from '../../lib/export/print';
import { createBackupPayload, parseBackupPayload } from '../../lib/backup/backup';
import { persistWorkspaceAsync } from '../../lib/storage/db/persistenceBackend';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

interface DatasetConfig {
  id: string;
  labelKey: TranslationKey;
  build: () => { sheet: XlsxSheet; json: unknown[] };
}

/** Reports & Export screen: filtered CSV/XLSX/JSON exports, management report, backup. */
export function ReportsExport() {
  const app = useAppStateCtx();
  const reportsApi = useReportsStateCtx();
  const lang = app.state.language;
  const settings = reportsApi.state.settings;

  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [status, setStatus] = useState('');
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const importFileRef = useRef<HTMLInputElement>(null);

  const dateRangeInvalid = dateFrom !== '' && dateTo !== '' && dateFrom > dateTo;

  // Team filtering was removed from the UI (team is no longer displayed);
  // exports always cover every team.
  const filters: ExportFilters = {
    dateFrom: dateFrom === '' ? null : dateFrom,
    dateTo: dateTo === '' ? null : dateTo,
    team: null,
    status: status === '' ? null : (status as AttendanceStatus),
  };

  const projection = useMemo(
    () =>
      calculateMultiDayProjection({
        casesRemaining: Math.max(0, app.state.totalCases - app.state.casesCompleted),
        planningRows: app.state.planningRows,
        perHourPerTester: app.state.perHourPerTester,
        workStartTime: app.state.startTime,
        workEndTime: WORK_DAY_END,
        lunch: WORK_LUNCH,
        targetCompletionDate: app.state.targetCompletionDate,
        targetCompletionTime: null,
        dailyOvertimeMinutes: app.state.dailyOvertimeMinutes,
      }),
    [app.state],
  );

  const datasets: DatasetConfig[] = useMemo(
    () => [
      {
        id: 'projects',
        labelKey: 'dataset.projects',
        build: () => {
          const projects = reportsApi.state.projects.filter((p) => {
            const date = p.inputs.startDate;
            if (filters.dateFrom !== null && date < filters.dateFrom) return false;
            if (filters.dateTo !== null && date > filters.dateTo) return false;
            return true;
          });
          return { sheet: projectsSheet(lang, projects), json: projects };
        },
      },
      {
        id: 'attendance',
        labelKey: 'dataset.attendance',
        build: () => {
          const records = filterAttendanceRecords(reportsApi.state.attendance, filters);
          return { sheet: attendanceSheet(lang, records, reportsApi.state.rcsMembers ?? []), json: records };
        },
      },
      {
        id: 'reports',
        labelKey: 'dataset.reports',
        build: () => {
          const reports = filterReports(reportsApi.state.reports, filters);
          return { sheet: reportsSheet(lang, reports), json: reports };
        },
      },
      {
        id: 'progress',
        labelKey: 'dataset.progress',
        build: () => {
          const reports = filterReports(reportsApi.state.reports, filters);
          const sheet = dailyProgressSheet(lang, reports, settings.progressRules);
          const json = reports.flatMap((r) => (r.snapshot ? r.snapshot.activities : []));
          return { sheet, json };
        },
      },
      {
        id: 'executionLogs',
        labelKey: 'dataset.executionLogs',
        build: () => {
          const reports = filterReports(reportsApi.state.reports, filters);
          const sheet = executionLogsSheet(lang, reports);
          const json = reports.flatMap((r) => (r.snapshot ? r.snapshot.activities : []));
          return { sheet, json };
        },
      },
      {
        id: 'executionHistory',
        labelKey: 'dataset.executionHistory',
        build: () => {
          const snapshots = app.state.dailyActuals ?? [];
          const sheet = executionHistorySheet(lang, snapshots, app.state.totalCases);
          return { sheet, json: snapshots };
        },
      },
      {
        id: 'bugTickets',
        labelKey: 'dataset.bugTickets',
        build: () => {
          const tickets = reportsApi.state.projects.flatMap((p) => p.inputs.bugTickets ?? []);
          const filtered = tickets.filter((ticket) => {
            if (filters.dateFrom !== null && ticket.createdAt < filters.dateFrom) return false;
            if (filters.dateTo !== null && ticket.createdAt > filters.dateTo) return false;
            return true;
          });
          return {
            sheet: bugTicketsSheet(lang, filtered, reportsApi.state.projects, reportsApi.state.rcsMembers ?? []),
            json: filtered,
          };
        },
      },
      {
        id: 'testerPerformance',
        labelKey: 'dataset.testerPerformance',
        build: () => {
          const records = reportsApi.state.projects.flatMap((p) => p.inputs.testerDailyPerformance ?? []);
          const tickets = reportsApi.state.projects.flatMap((p) => p.inputs.bugTickets ?? []);
          const inRange = (date: string): boolean =>
            (filters.dateFrom === null || date >= filters.dateFrom) && (filters.dateTo === null || date <= filters.dateTo);
          const scopedRecords = records.filter((r) => inRange(r.date));
          const scopedTickets = tickets.filter((t) => inRange(t.createdAt));
          const rows = aggregateTesterPerformance(scopedRecords, scopedTickets, { members: reportsApi.state.rcsMembers ?? [] });
          const periodLabel =
            filters.dateFrom !== null || filters.dateTo !== null
              ? `${filters.dateFrom ?? '…'} ~ ${filters.dateTo ?? '…'}`
              : 'ALL';
          return {
            sheet: testerPerformanceSheet(lang, rows, reportsApi.state.projects, periodLabel),
            json: rows,
          };
        },
      },
      {
        id: 'testerDailyDetail',
        labelKey: 'dataset.testerDailyDetail',
        build: () => {
          const records = reportsApi.state.projects.flatMap((p) => p.inputs.testerDailyPerformance ?? []);
          const tickets = reportsApi.state.projects.flatMap((p) => p.inputs.bugTickets ?? []);
          const filtered = records.filter((r) => {
            if (filters.dateFrom !== null && r.date < filters.dateFrom) return false;
            if (filters.dateTo !== null && r.date > filters.dateTo) return false;
            return true;
          });
          return {
            sheet: testerDailyDetailSheet(lang, filtered, tickets, reportsApi.state.projects),
            json: filtered,
          };
        },
      },
      {
        id: 'testerReviews',
        labelKey: 'dataset.testerReviews',
        build: () => {
          const reviews = (reportsApi.state.reviews ?? []).filter(
            (review) =>
              (filters.dateFrom === null || review.periodEnd >= filters.dateFrom) &&
              (filters.dateTo === null || review.periodStart <= filters.dateTo),
          );
          const records = reportsApi.state.projects.flatMap((p) => p.inputs.testerDailyPerformance ?? []);
          const tickets = reportsApi.state.projects.flatMap((p) => p.inputs.bugTickets ?? []);
          return {
            sheet: testerReviewsSheet(
              lang,
              reviews,
              records,
              tickets,
              reportsApi.state.projects,
              reportsApi.state.rcsMembers ?? [],
            ),
            json: reviews,
          };
        },
      },
      {
        id: 'rcsMembers',
        labelKey: 'dataset.rcsMembers',
        build: () => ({
          sheet: rcsMembersSheet(lang, reportsApi.state.rcsMembers ?? []),
          json: reportsApi.state.rcsMembers ?? [],
        }),
      },
      {
        id: 'testerAssignments',
        labelKey: 'dataset.testerAssignments',
        build: () => ({
          sheet: testerAssignmentsSheet(
            lang,
            reportsApi.state.testerAssignments ?? [],
            reportsApi.state.rcsMembers ?? [],
            reportsApi.state.projects,
          ),
          json: reportsApi.state.testerAssignments ?? [],
        }),
      },
      {
        id: 'wbs',
        labelKey: 'dataset.wbs',
        build: () => ({ sheet: wbsSheet(lang, app.state), json: app.state.planningRows }),
      },
      {
        id: 'capacity',
        labelKey: 'dataset.capacity',
        build: () => ({ sheet: capacitySheet(lang, app.state), json: projection.rows }),
      },
      {
        id: 'overtime',
        labelKey: 'dataset.overtime',
        build: () => ({ sheet: overtimeSheet(lang, app.state), json: projection.rows }),
      },
    ],
    [lang, filters.dateFrom, filters.dateTo, filters.team, filters.status, reportsApi.state, app.state, projection, settings.progressRules],
  );

  // Timestamp includes the time so same-day exports never collide.
  const timestamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');

  const exportCsv = (dataset: DatasetConfig): void => {
    const { sheet } = dataset.build();
    const csv = toCsv(
      sheet.headers,
      sheet.rows.map((row) => row.map(csvValueFromCell)),
    );
    downloadTextFile(`ganttchart-${dataset.id}-${timestamp}.csv`, 'text/csv;charset=utf-8', csv);
    setMessage({ kind: 'ok', text: t(lang, 'reports.exportedRows', { dataset: t(lang, dataset.labelKey), count: sheet.rows.length }) });
  };

  const exportXlsx = (dataset: DatasetConfig): void => {
    const { sheet } = dataset.build();
    downloadBinaryFile(`ganttchart-${dataset.id}-${timestamp}.xlsx`, XLSX_MIME, buildXlsx([sheet]));
    setMessage({ kind: 'ok', text: t(lang, 'reports.exportedRows', { dataset: t(lang, dataset.labelKey), count: sheet.rows.length }) });
  };

  const exportJson = (dataset: DatasetConfig): void => {
    const { json } = dataset.build();
    downloadTextFile(
      `ganttchart-${dataset.id}-${timestamp}.json`,
      'application/json',
      JSON.stringify({ app: 'ganttchart', dataset: dataset.id, exportedAt: new Date().toISOString(), data: json }, null, 2),
    );
    setMessage({ kind: 'ok', text: t(lang, 'reports.exportedRows', { dataset: t(lang, dataset.labelKey), count: json.length }) });
  };

  const exportWorkbook = (): void => {
    const filteredReports = filterReports(reportsApi.state.reports, filters);
    const allRecords = reportsApi.state.projects.flatMap((p) => p.inputs.testerDailyPerformance ?? []);
    const allTickets = reportsApi.state.projects.flatMap((p) => p.inputs.bugTickets ?? []);
    const sheets: XlsxSheet[] = [
      summarySheet(lang, app.state, projection),
      projectsSheet(lang, reportsApi.state.projects),
      wbsSheet(lang, app.state),
      dailyProgressSheet(lang, filteredReports, settings.progressRules),
      executionHistorySheet(lang, app.state.dailyActuals ?? [], app.state.totalCases),
      capacitySheet(lang, app.state),
      attendanceSheet(lang, filterAttendanceRecords(reportsApi.state.attendance, filters), reportsApi.state.rcsMembers ?? []),
      executionLogsSheet(lang, filteredReports),
      overtimeSheet(lang, app.state),
      bugTicketsSheet(lang, allTickets, reportsApi.state.projects, reportsApi.state.rcsMembers ?? []),
      testerPerformanceSheet(
        lang,
        aggregateTesterPerformance(allRecords, allTickets, { members: reportsApi.state.rcsMembers ?? [] }),
        reportsApi.state.projects,
        'ALL',
      ),
      testerDailyDetailSheet(lang, allRecords, allTickets, reportsApi.state.projects),
      testerReviewsSheet(
        lang,
        reportsApi.state.reviews ?? [],
        allRecords,
        allTickets,
        reportsApi.state.projects,
        reportsApi.state.rcsMembers ?? [],
      ),
      rcsMembersSheet(lang, reportsApi.state.rcsMembers ?? []),
      testerAssignmentsSheet(
        lang,
        reportsApi.state.testerAssignments ?? [],
        reportsApi.state.rcsMembers ?? [],
        reportsApi.state.projects,
      ),
    ];
    downloadBinaryFile(`ganttchart-workbook-${timestamp}.xlsx`, XLSX_MIME, buildXlsx(sheets));
  };

  const managementRow = buildManagementReportRow(app.state, projection);

  const exportManagementXlsx = (): void => {
    downloadBinaryFile(`ganttchart-management-${timestamp}.xlsx`, XLSX_MIME, buildXlsx([managementSheet(lang, managementRow)]));
  };

  const exportManagementPdf = (): void => {
    const sheet = managementSheet(lang, managementRow);
    const rows = sheet.rows[0] ?? [];
    const body =
      '<table><tr>' +
      sheet.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('') +
      '</tr><tr>' +
      rows.map((c) => `<td>${escapeHtml(String(csvValueFromCell(c) ?? ''))}</td>`).join('') +
      '</tr></table>';
    const opened = printHtml(sheet.name, body);
    if (!opened) setMessage({ kind: 'error', text: t(lang, 'dailyReport.popupBlocked') });
  };

  const exportBackup = (): void => {
    const payload = createBackupPayload(app.state, reportsApi.state);
    downloadTextFile(
      `ganttchart-backup-${timestamp}.json`,
      'application/json',
      JSON.stringify(payload, null, 2),
    );
  };

  const importBackup = (file: File): void => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = parseBackupPayload(String(reader.result ?? ''));
      if (!result.ok) {
        setMessage({ kind: 'error', text: t(lang, 'reports.importErr') });
        return;
      }
      if (
        !window.confirm(
          t(lang, 'reports.confirmRestore', {
            projects: result.data.reportsState.projects.length,
            reports: result.data.reportsState.reports.length,
          }),
        )
      ) {
        return;
      }
      // Safety first: download a backup of the current data before replacing it.
      exportBackup();
      void (async () => {
        // Commit through the persistence backend so the manifest, revision
        // journal and localStorage fallback record stay consistent. A direct
        // localStorage write would leave the fallback record stale and turn
        // the next startup into a false "recovery required" state — and in
        // healthy IndexedDB mode the database copy would win on reload,
        // silently reverting the restore.
        const saved = await persistWorkspaceAsync(result.data.appState, result.data.reportsState, {
          reason: 'import',
          forceRevision: true,
        });
        if (!saved.ok) {
          setMessage({ kind: 'error', text: t(lang, 'reports.importWriteErr') });
          return;
        }
        // Refresh the in-memory state to the restored workspace (same pattern
        // as Clear All Local Data) — no reload required.
        app.replaceState(result.data.appState);
        reportsApi.replaceReportsState(result.data.reportsState);
        setMessage({ kind: 'ok', text: t(lang, 'reports.importOk') });
      })();
    };
    reader.onerror = () => setMessage({ kind: 'error', text: t(lang, 'reports.importErr') });
    reader.readAsText(file);
  };

  const hiddenFileInput = (
    <input
      ref={importFileRef}
      type="file"
      accept="application/json,.json"
      className="visually-hidden"
      onChange={(e) => {
        const file = e.target.files?.[0];
        if (file) importBackup(file);
        e.target.value = '';
      }}
    />
  );

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title-group">
          <h1>{t(lang, 'reports.title')}</h1>
        </div>
      </header>

      {message !== null ? <div className={`dr-message ${message.kind}`} role="status">{message.text}</div> : null}

      <section className="dr-section">
        <h2>{t(lang, 'reports.filters')}</h2>
        <div className="dr-filter-bar">
          <label>
            {t(lang, 'reports.dateFrom')}
            <input className="input" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          </label>
          <label>
            {t(lang, 'reports.dateTo')}
            <input
              className={`input${dateRangeInvalid ? ' table-input-invalid' : ''}`}
              type="date"
              value={dateTo}
              aria-invalid={dateRangeInvalid}
              onChange={(e) => setDateTo(e.target.value)}
            />
          </label>
          <label>
            {t(lang, 'columns.status')}
            <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{t(lang, 'reports.all')}</option>
              {ATTENDANCE_STATUSES.map((st) => (
                <option key={st} value={st}>
                  {t(lang, attendanceStatusKey(st))}
                </option>
              ))}
            </select>
          </label>
        </div>
        {dateRangeInvalid ? <p className="field-error" role="alert">{t(lang, 'reports.dateRangeInvalid')}</p> : null}
      </section>

      <section className="dr-section">
        <h2>{t(lang, 'reports.datasets')}</h2>
        <div className="table-wrap">
          <table className="dr-table">
            <thead>
              <tr>
                <th scope="col">{t(lang, 'columns.item')}</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {datasets.map((dataset) => (
                <tr key={dataset.id}>
                  <td>{t(lang, dataset.labelKey)}</td>
                  <td className="dr-row-actions">
                    <button type="button" className="btn" disabled={dateRangeInvalid} onClick={() => exportCsv(dataset)}>
                      {t(lang, 'buttons.exportCsv')}
                    </button>
                    <button type="button" className="btn" disabled={dateRangeInvalid} onClick={() => exportXlsx(dataset)}>
                      {t(lang, 'buttons.exportXlsx')}
                    </button>
                    <button type="button" className="btn" disabled={dateRangeInvalid} onClick={() => exportJson(dataset)}>
                      {t(lang, 'buttons.exportJson')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="dr-button-row">
          <button type="button" className="btn" disabled={dateRangeInvalid} onClick={exportWorkbook}>
            {t(lang, 'reports.workbook')}
          </button>
        </div>
        {filters.dateFrom !== null || filters.dateTo !== null || filters.team !== null || filters.status !== null ? (
          <p className="dr-empty">{t(lang, 'reports.workbookFilterNote')}</p>
        ) : null}
      </section>

      <section className="dr-section">
        <h2>{t(lang, 'reports.management')}</h2>
        <div className="dr-button-row">
          <button type="button" className="btn" disabled={dateRangeInvalid} onClick={exportManagementXlsx}>
            {t(lang, 'buttons.exportXlsx')}
          </button>
          <button type="button" className="btn" disabled={dateRangeInvalid} onClick={exportManagementPdf}>
            {t(lang, 'buttons.exportPdf')}
          </button>
        </div>
      </section>

      <section className="dr-section">
        <h2>{t(lang, 'reports.backup')}</h2>
        <div className="dr-button-row">
          <button type="button" className="btn" onClick={exportBackup}>
            {t(lang, 'reports.exportBackup')}
          </button>
          {hiddenFileInput}
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => importFileRef.current?.click()}
          >
            {t(lang, 'reports.importBackup')}
          </button>
        </div>
      </section>
    </div>
  );
}

function attendanceStatusKey(status: AttendanceStatus): TranslationKey {
  switch (status) {
    case 'PRESENT':
      return 'attendance.statusPresent';
    case 'ABSENT':
      return 'attendance.statusAbsent';
    case 'PAID_LEAVE':
      return 'attendance.statusPaidLeave';
    case 'HALF_DAY':
      return 'attendance.statusHalfDay';
    case 'LATE':
      return 'attendance.statusLate';
    default:
      return 'attendance.statusOther';
  }
}

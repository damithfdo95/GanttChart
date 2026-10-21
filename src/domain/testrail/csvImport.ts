/**
 * TestRail CSV import (pure domain — no UI, no i18n, no clock, no storage).
 *
 * A CSV export of TestRail results becomes a `TestRailDayImport` — the SAME
 * shape the live "Fetch from TestRail" produces (`domain/testrail`) — so the
 * existing merge (`mergeTestRailTesterRecords`, idempotent, manual records
 * never overwritten) and the form proposal (`applyTestRailDayToEntry`) work
 * unchanged.
 *
 * Two column dialects are recognized, by header name (case-insensitive):
 *
 * 1. TestRail's own results export (Results → Export CSV): one row per
 *    result — "Test Id" (or "ID"), "Status" (name or id), "Assigned To"
 *    (name or id), "Created On" (date or unix seconds), "User" (who ran it).
 *    Rows are aggregated with the SAME rules as the live fetch: per test the
 *    LATEST result of the day counts, Untested never counts, attribution is
 *    the assigned tester.
 * 2. A per-tester summary sheet (one row per tester/day): "Date", "Tester",
 *    "Tested", "Passed", "Failed", "N/A" (or "Not Applicable"), "Blocked",
 *    "Retest", "Questioned", "SPO". This is what a team typically assembles
 *    by hand when the TestRail API is unreachable.
 *
 * Required: a tester column and a tested-count column (summary dialect), or
 * a status column (results dialect). The date comes from a Date column or
 * the caller-provided fallback (the form's selected date).
 */

import type { TestRailDayImport, TestRailStatusCategory, TestRailTesterDay } from '../testrail';
import { parseCsv, type CsvTable } from '../../lib/csv/parseCsv';

export type TestRailCsvErrorCode =
  | 'csv_empty'
  | 'csv_unclosed_quote'
  | 'csv_no_tester_column'
  | 'csv_no_counts'
  | 'csv_missing_tester'
  | 'csv_bad_count'
  | 'csv_bad_date'
  | 'csv_bad_row';

export interface TestRailCsvRowError {
  /** 1-based record number in the CSV (the header is record 1). */
  record: number;
  code: TestRailCsvErrorCode;
  value?: string;
}

export interface TestRailCsvImport {
  day: TestRailDayImport | null;
  errors: TestRailCsvRowError[];
  /** True only when the day parsed with at least one tester and no row failed. */
  ok: boolean;
}

// ---- header matching ---------------------------------------------------------

const norm = (s: string): string => s.normalize('NFKC').trim().toLowerCase().replace(/[\s_]+/g, ' ');

const ALIASES: Readonly<Record<string, readonly string[]>> = {
  date: ['date', 'day', '日付'],
  tester: ['tester', 'assigned to', 'assignee', 'user', 'テスター', '担当者'],
  tested: ['tested', 'cases tested', 'executed', '実行数'],
  passed: ['passed', 'pass', '合格'],
  failed: ['failed', 'fail', '不合格'],
  notApplicable: ['n/a', 'not applicable', 'na', '不適合'],
  blocked: ['blocked', 'ブロック'],
  retest: ['retest', 'リテスト'],
  questioned: ['questioned', '質問中'],
  spo: ['spo', 'sp o', '代行'],
  // results dialect
  testId: ['test id', 'id', 'テストid'],
  status: ['status', 'ステータス'],
  createdOn: ['created on', 'created', '作成日時'],
};

function columnIndex(table: CsvTable, field: keyof typeof ALIASES): number {
  const aliases = ALIASES[field] ?? [];
  for (let i = 0; i < table.headers.length; i += 1) {
    if (aliases.includes(norm(table.headers[i] ?? ''))) return i;
  }
  return -1;
}

/** TestRail status name/id → GanttChart category (mirrors DEFAULT_TESTRAIL_STATUS_MAP). */
const STATUS_BY_NAME: Readonly<Record<string, TestRailStatusCategory>> = {
  passed: 'pass',
  pass: 'pass',
  p: 'pass',
  '1': 'pass',
  '合格': 'pass',
  failed: 'fail',
  fail: 'fail',
  f: 'fail',
  '5': 'fail',
  '不合格': 'fail',
  blocked: 'blocked',
  b: 'blocked',
  '2': 'blocked',
  'ブロック': 'blocked',
  retest: 'retest',
  r: 'retest',
  '4': 'retest',
  'リテスト': 'retest',
  untested: 'notApplicable', // never counted; mapped so isUntested can drop it
  '3': 'notApplicable',
};

function statusCategoryOf(cell: string): TestRailStatusCategory | 'untested' | undefined {
  const v = norm(cell);
  if (v === '') return undefined;
  if (v === 'untested' || v === '3') return 'untested';
  return STATUS_BY_NAME[v];
}

/** Count cell → non-negative integer; null when blank, undefined when unparseable. */
function countOrUndefined(cell: string): number | undefined {
  const v = cell.trim();
  if (v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
}

/** 'YYYY-MM-DD' | 'YYYY/MM/DD' | unix seconds → 'YYYY-MM-DD'; null when unparseable. */
function dateOrInvalid(cell: string): string | null {
  const ts = timestampOrInvalid(cell);
  return ts === null ? null : ts.slice(0, 10);
}

/**
 * A sortable 'YYYY-MM-DDTHH:mm:ss' string (time defaults to 00:00:00), or
 * unix seconds/ms converted in the Tokyo business timezone. Null when the
 * cell is not a recognizable timestamp. The full precision is kept so
 * same-day results order correctly.
 */
function timestampOrInvalid(cell: string): string | null {
  const v = cell.trim();
  if (v === '') return null;
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(v);
  if (m !== null) {
    const y = m[1] ?? '';
    const mo = (m[2] ?? '').padStart(2, '0');
    const d = (m[3] ?? '').padStart(2, '0');
    const h = (m[4] ?? '0').padStart(2, '0');
    const mi = (m[5] ?? '0').padStart(2, '0');
    const s = (m[6] ?? '0').padStart(2, '0');
    return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  }
  if (/^\d{9,13}$/.test(v)) {
    // unix seconds (or ms) — convert in the Tokyo business timezone
    const ms = v.length > 10 ? Number(v) : Number(v) * 1000;
    const d = new Date(ms + 9 * 3600 * 1000);
    const ymd = d.toISOString();
    return /^\d{4}-\d{2}-\d{2}T/.test(ymd) ? ymd.slice(0, 19) : null;
  }
  return null;
}

// ---- import -------------------------------------------------------------------

export function testrailDayFromCsv(text: string, fallbackDate: string): TestRailCsvImport {
  const parsed = parseCsv(text);
  if (!parsed.ok) {
    const code: TestRailCsvErrorCode = parsed.fatal.kind === 'empty' ? 'csv_empty' : 'csv_unclosed_quote';
    return { day: null, errors: [{ record: 0, code }], ok: false };
  }
  const table = parsed.table;

  const cols = {
    date: columnIndex(table, 'date'),
    tester: columnIndex(table, 'tester'),
    tested: columnIndex(table, 'tested'),
    passed: columnIndex(table, 'passed'),
    failed: columnIndex(table, 'failed'),
    notApplicable: columnIndex(table, 'notApplicable'),
    blocked: columnIndex(table, 'blocked'),
    retest: columnIndex(table, 'retest'),
    questioned: columnIndex(table, 'questioned'),
    spo: columnIndex(table, 'spo'),
    testId: columnIndex(table, 'testId'),
    status: columnIndex(table, 'status'),
    createdOn: columnIndex(table, 'createdOn'),
  };

  const cell = (row: readonly string[], col: number): string => (col >= 0 && col < row.length ? (row[col] ?? '') : '');

  // ---- dialect detection: a status column (and no tested-count column) = results export ----
  const isResultsDialect = cols.status >= 0 && cols.tested === -1;

  if (cols.tester === -1) return { day: null, errors: [{ record: 0, code: 'csv_no_tester_column' }], ok: false };
  if (!isResultsDialect && cols.tested === -1) return { day: null, errors: [{ record: 0, code: 'csv_no_counts' }], ok: false };

  const errors: TestRailCsvRowError[] = [];

  // ---- summary dialect: one row per tester/day ----
  if (!isResultsDialect) {
    const byTester = new Map<string, TestRailTesterDay>();
    let date = fallbackDate;
    let dateSeen = false;

    for (const row of table.rows) {
      const tester = cell(row.cells, cols.tester).replace(/\s+/g, ' ').trim();
      if (tester === '') {
        errors.push({ record: row.record, code: 'csv_missing_tester' });
        continue;
      }
      const rowDate = cols.date >= 0 ? dateOrInvalid(cell(row.cells, cols.date)) : null;
      if (cols.date >= 0 && cell(row.cells, cols.date).trim() !== '' && rowDate === null) {
        errors.push({ record: row.record, code: 'csv_bad_date', value: cell(row.cells, cols.date) });
        continue;
      }
      if (rowDate !== null) {
        if (!dateSeen) {
          date = rowDate;
          dateSeen = true;
        } else if (rowDate !== date) {
          // Multiple dates in one file: import the FIRST date's rows, report the rest.
          errors.push({ record: row.record, code: 'csv_bad_date', value: rowDate });
          continue;
        }
      }

      const counts: { key: keyof Omit<TestRailTesterDay, 'date' | 'testerName' | 'testrailUserId'>; col: number }[] = [
        { key: 'casesTested', col: cols.tested },
        { key: 'casesPassed', col: cols.passed },
        { key: 'casesFailed', col: cols.failed },
        { key: 'casesNotApplicable', col: cols.notApplicable },
        { key: 'casesBlocked', col: cols.blocked },
        { key: 'casesRetest', col: cols.retest },
        { key: 'casesQuestioned', col: cols.questioned },
        { key: 'casesSpoAssigned', col: cols.spo },
      ];
      const values = new Map<string, number>();
      let bad = false;
      for (const c of counts) {
        if (c.col < 0) continue;
        const raw = cell(row.cells, c.col);
        if (raw.trim() === '') continue;
        const n = countOrUndefined(raw);
        if (n === undefined) {
          errors.push({ record: row.record, code: 'csv_bad_count', value: raw });
          bad = true;
        } else {
          values.set(c.key, n);
        }
      }
      if (bad) continue;

      const tested = values.get('casesTested') ?? 0;
      const existing = byTester.get(tester);
      if (existing === undefined) {
        byTester.set(tester, {
          date,
          testerName: tester,
          testrailUserId: 0, // no TestRail account behind a hand-made sheet
          casesTested: tested,
          ...(values.has('casesPassed') ? { casesPassed: values.get('casesPassed') } : {}),
          ...(values.has('casesFailed') ? { casesFailed: values.get('casesFailed') } : {}),
          ...(values.has('casesNotApplicable') ? { casesNotApplicable: values.get('casesNotApplicable') } : {}),
          ...(values.has('casesBlocked') ? { casesBlocked: values.get('casesBlocked') } : {}),
          ...(values.has('casesRetest') ? { casesRetest: values.get('casesRetest') } : {}),
          ...(values.has('casesQuestioned') ? { casesQuestioned: values.get('casesQuestioned') } : {}),
          ...(values.has('casesSpoAssigned') ? { casesSpoAssigned: values.get('casesSpoAssigned') } : {}),
        });
      } else {
        // Same tester twice (e.g. two sheets concatenated): merge the counts.
        byTester.set(tester, {
          ...existing,
          casesTested: existing.casesTested + tested,
          casesPassed: (existing.casesPassed ?? 0) + (values.get('casesPassed') ?? 0),
          casesFailed: (existing.casesFailed ?? 0) + (values.get('casesFailed') ?? 0),
          casesNotApplicable: (existing.casesNotApplicable ?? 0) + (values.get('casesNotApplicable') ?? 0),
          casesBlocked: (existing.casesBlocked ?? 0) + (values.get('casesBlocked') ?? 0),
          casesRetest: (existing.casesRetest ?? 0) + (values.get('casesRetest') ?? 0),
          casesQuestioned: (existing.casesQuestioned ?? 0) + (values.get('casesQuestioned') ?? 0),
          casesSpoAssigned: (existing.casesSpoAssigned ?? 0) + (values.get('casesSpoAssigned') ?? 0),
        });
      }
    }

    if (byTester.size === 0 && errors.length === 0) {
      return { day: null, errors: [{ record: 0, code: 'csv_empty' }], ok: false };
    }

    const testers = [...byTester.values()].sort((a, b) => a.testerName.localeCompare(b.testerName));
    const totals = sumTotals(testers);
    return {
      day: { date, testers, unassignedCount: 0, skippedUntested: 0, unlinked: [], totals },
      errors,
      ok: errors.length === 0 && testers.length > 0,
    };
  }

  // ---- results dialect: one row per result, latest-per-test wins (the live fetch's rule) ----
  interface ResultRow {
    record: number;
    testId: string;
    category: TestRailStatusCategory | 'untested' | undefined;
    tester: string;
    createdOn: string | null;
    createdRaw: string;
  }
  const results: ResultRow[] = [];
  for (const row of table.rows) {
    const tester = cell(row.cells, cols.tester).replace(/\s+/g, ' ').trim();
    if (tester === '') {
      errors.push({ record: row.record, code: 'csv_missing_tester' });
      continue;
    }
    const statusRaw = cell(row.cells, cols.status);
    const category = statusCategoryOf(statusRaw);
    if (statusRaw.trim() !== '' && category === undefined) {
      errors.push({ record: row.record, code: 'csv_bad_row', value: statusRaw });
      continue;
    }
    const createdRaw = cols.createdOn >= 0 ? cell(row.cells, cols.createdOn) : '';
    const createdOn = createdRaw.trim() === '' ? null : timestampOrInvalid(createdRaw);
    if (createdRaw.trim() !== '' && createdOn === null) {
      errors.push({ record: row.record, code: 'csv_bad_date', value: createdRaw });
      continue;
    }
    const testId = cols.testId >= 0 ? cell(row.cells, cols.testId).trim() : `${row.record}`;
    results.push({ record: row.record, testId, category, tester, createdOn, createdRaw });
  }

  // Latest result per test: a parseable Created On wins; ties and missing
  // timestamps fall back to file order (the LAST row wins, like a re-run
  // appended to the export).
  const latest = new Map<string, ResultRow>();
  for (const r of results) {
    const current = latest.get(r.testId);
    if (current === undefined) {
      latest.set(r.testId, r);
      continue;
    }
    if (r.createdOn === null || current.createdOn === null || r.createdOn >= current.createdOn) {
      latest.set(r.testId, r);
    }
  }

  const byTester = new Map<string, TestRailTesterDay>();
  let skippedUntested = 0;
  for (const r of latest.values()) {
    if (r.category === undefined || r.category === 'untested') {
      skippedUntested += 1;
      continue;
    }
    const acc =
      byTester.get(r.tester) ??
      ({
        date: fallbackDate,
        testerName: r.tester,
        testrailUserId: 0,
        casesTested: 0,
      } as TestRailTesterDay);
    acc.casesTested += 1;
    switch (r.category) {
      case 'pass':
        acc.casesPassed = (acc.casesPassed ?? 0) + 1;
        break;
      case 'fail':
        acc.casesFailed = (acc.casesFailed ?? 0) + 1;
        break;
      case 'notApplicable':
        acc.casesNotApplicable = (acc.casesNotApplicable ?? 0) + 1;
        break;
      case 'blocked':
        acc.casesBlocked = (acc.casesBlocked ?? 0) + 1;
        break;
      case 'retest':
        acc.casesRetest = (acc.casesRetest ?? 0) + 1;
        break;
      case 'questioned':
        acc.casesQuestioned = (acc.casesQuestioned ?? 0) + 1;
        break;
      case 'spo':
        acc.casesSpoAssigned = (acc.casesSpoAssigned ?? 0) + 1;
        break;
      default:
        break;
    }
    byTester.set(r.tester, acc);
  }

  const testers = [...byTester.values()].sort((a, b) => a.testerName.localeCompare(b.testerName));
  const totals = sumTotals(testers);
  return {
    day: { date: fallbackDate, testers, unassignedCount: 0, skippedUntested, unlinked: [], totals },
    errors,
    ok: errors.length === 0 && testers.length > 0,
  };
}

function sumTotals(testers: readonly TestRailTesterDay[]): TestRailDayImport['totals'] {
  const totals = {
    pass: 0,
    fail: 0,
    notApplicable: 0,
    spo: 0,
    blocked: 0,
    retest: 0,
    questioned: 0,
    uncategorizedCompleted: 0,
    testers: testers.length,
    executed: 0,
  };
  for (const t of testers) {
    totals.pass += t.casesPassed ?? 0;
    totals.fail += t.casesFailed ?? 0;
    totals.notApplicable += t.casesNotApplicable ?? 0;
    totals.spo += t.casesSpoAssigned ?? 0;
    totals.blocked += t.casesBlocked ?? 0;
    totals.retest += t.casesRetest ?? 0;
    totals.questioned += t.casesQuestioned ?? 0;
    totals.executed += t.casesTested;
  }
  return totals;
}

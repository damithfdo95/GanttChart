/**
 * TestRail result analysis (pure domain — no UI, no i18n, no clock, no fetch).
 *
 * A port of the "TestRail 分析ツール" rules (Confluence: Testrail結果確認ツール):
 * a TestRail Test Results export (CSV) or a live get_results fetch becomes
 * normalized rows, and `analyzeResults` detects the quality issues the tool
 * detected — Untested steps, OS/Device mismatch, Passed without comment,
 * Failed without Defects, Build info missing, Retest/N/A, and same-Case-ID
 * Passed+Failed inconsistency — plus the per-tester × per-day achievement
 * counts.
 *
 * Everything mirrors the Python tool's semantics:
 *  - "Untested" is a per-TEST property: the export repeats the Test ID only
 *    on the first step row, so IDs are forward-filled before the check.
 *  - The no-comment / Build checks apply to Passed rows only.
 *  - The consistency check ignores period and tester exclusions (it sees the
 *    raw rows), exactly like the tool.
 *  - Tester exclusion is a partial match on Assigned To (comma-separated).
 */

import { parseCsv } from '../../lib/csv/parseCsv';
import type { TestRailResultRow, TestRailRunRef, TestRailTestRow, TestRailUser } from '../../../shared/testrail';

// ---- normalized row ----------------------------------------------------------------

/** The analysis status of one result row, normalized (never a TestRail id). The words follow TestRail's own status names. */
export type AnalysisStatus = 'passed' | 'failed' | 'retest' | 'blocked' | 'na' | 'untested' | 'custom';

/** The detected issue kinds — the UI localizes them; the words align with TestRail statuses and the tool's 確認項目. */
export type AnalysisIssueKind = 'untested' | 'device' | 'noComment' | 'noDefect' | 'build' | 'retest' | 'na';

/** One normalized result row — the unit every rule and view works on. */
export interface TestRailAnalysisRow {
  /** Test ID (the run × case instance), e.g. 123456. */
  testId: number;
  /** Case ID, e.g. 78901; 0 when unknown (the API lane without get_tests). */
  caseId: number;
  status: AnalysisStatus;
  /** Step-level statuses of the test (CSV export only; empty = not available). */
  stepsStatus: string;
  comment: string;
  /** Run name; '' when the export had no Run column. */
  run: string;
  /** Run Configuration; '' when absent. */
  runConfig: string;
  /** Defect ids as exported (comma/space separated). */
  defects: string;
  /** Who executed (Tested By) — a display name (CSV) or "User #id" (API). */
  testedBy: string;
  /** 'YYYY-MM-DD' in the Tokyo business timezone; '' when unparseable. */
  testedOn: string;
  /** Assigned To — the exclusion filter's target (display name or "User #id"). */
  assignedTo: string;
}

/** Why a CSV row could not be used. */
export type ResultExportErrorCode =
  | 'csv_empty'
  | 'csv_unclosed_quote'
  | 'csv_no_status_column'
  | 'csv_bad_date';

export interface ResultExportRowError {
  /** 1-based record number in the CSV (the header is record 1). */
  record: number;
  code: ResultExportErrorCode;
  value?: string;
}

export interface ResultExportParse {
  rows: TestRailAnalysisRow[];
  errors: ResultExportRowError[];
  /** Distinct unrecognized Status values — the rows are KEPT (as Custom Status, TestRail's own convention) and the values are listed here. */
  unknownStatuses: string[];
  /** True only when at least one row parsed and no row failed. */
  ok: boolean;
}

// ---- header matching (same normalization as csvImport.ts) ---------------------------

const norm = (s: string): string => s.normalize('NFKC').trim().toLowerCase().replace(/[\s_]+/g, ' ');

const ALIASES: Readonly<Record<string, readonly string[]>> = {
  testId: ['id', 'test id'],
  caseId: ['case id', 'case'],
  status: ['status'],
  stepsStatus: ['steps (status)', 'steps status', 'steps'],
  comment: ['comment', 'comments'],
  run: ['run'],
  runConfig: ['run configuration', 'config', 'configuration'],
  defects: ['defects', 'defect'],
  testedBy: ['tested by', 'tester', 'user'],
  testedOn: ['tested on', 'created on', 'date'],
  assignedTo: ['assigned to', 'assignee'],
};

function columnIndex(headers: readonly string[], field: keyof typeof ALIASES): number {
  const aliases = ALIASES[field] ?? [];
  for (let i = 0; i < headers.length; i += 1) {
    if (aliases.includes(norm(headers[i] ?? ''))) return i;
  }
  return -1;
}

const cell = (row: readonly string[], col: number): string => (col >= 0 && col < row.length ? (row[col] ?? '') : '');

/** Status name/id → normalized analysis status; undefined when unrecognized. */
const STATUS_BY_NAME: Readonly<Record<string, AnalysisStatus>> = {
  passed: 'passed',
  pass: 'passed',
  p: 'passed',
  '1': 'passed',
  failed: 'failed',
  fail: 'failed',
  f: 'failed',
  '5': 'failed',
  blocked: 'blocked',
  b: 'blocked',
  '2': 'blocked',
  retest: 'retest',
  r: 'retest',
  '4': 'retest',
  untested: 'untested',
  '3': 'untested',
  'n/a': 'na',
  na: 'na',
};

function statusOf(raw: string): AnalysisStatus | undefined {
  const v = norm(raw);
  if (v === '') return undefined;
  return STATUS_BY_NAME[v];
}

/** 'YYYY-MM-DD' | 'YYYY/MM/DD' | unix seconds/ms → 'YYYY-MM-DD' (Tokyo tz); null when unparseable. */
function dateOrInvalid(raw: string): string | null {
  const v = raw.trim();
  if (v === '') return null;
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(v);
  if (m !== null) {
    return `${m[1]}-${(m[2] ?? '').padStart(2, '0')}-${(m[3] ?? '').padStart(2, '0')}`;
  }
  if (/^\d{9,13}$/.test(v)) {
    const ms = v.length > 10 ? Number(v) : Number(v) * 1000;
    const iso = new Date(ms + 9 * 3600 * 1000).toISOString();
    return /^\d{4}-\d{2}-\d{2}T/.test(iso) ? iso.slice(0, 10) : null;
  }
  return null;
}

/** Strip HTML tags, unescape entities, collapse whitespace — the tool's clean_display_text (entities first, then tags). */
export function cleanText(raw: string): string {
  const entities: Readonly<Record<string, string>> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
  const decoded = raw.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (e) => entities[e] ?? e);
  return decoded.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// ---- CSV export parsing --------------------------------------------------------------

/**
 * Parse a TestRail Test Results export CSV into normalized rows. A row with
 * an unparseable date is skipped and reported; a row with an unrecognized
 * STATUS is kept as Custom Status and its raw value listed in
 * `unknownStatuses` (nothing is silently dropped).
 */
export function parseResultExport(text: string): ResultExportParse {
  const parsed = parseCsv(text);
  if (!parsed.ok) {
    const code: ResultExportErrorCode = parsed.fatal.kind === 'empty' ? 'csv_empty' : 'csv_unclosed_quote';
    return { rows: [], errors: [{ record: 0, code }], unknownStatuses: [], ok: false };
  }
  const table = parsed.table;
  const cols = {
    testId: columnIndex(table.headers, 'testId'),
    caseId: columnIndex(table.headers, 'caseId'),
    status: columnIndex(table.headers, 'status'),
    stepsStatus: columnIndex(table.headers, 'stepsStatus'),
    comment: columnIndex(table.headers, 'comment'),
    run: columnIndex(table.headers, 'run'),
    runConfig: columnIndex(table.headers, 'runConfig'),
    defects: columnIndex(table.headers, 'defects'),
    testedBy: columnIndex(table.headers, 'testedBy'),
    testedOn: columnIndex(table.headers, 'testedOn'),
    assignedTo: columnIndex(table.headers, 'assignedTo'),
  };
  if (cols.status === -1) return { rows: [], errors: [{ record: 0, code: 'csv_no_status_column' }], unknownStatuses: [], ok: false };

  const errors: ResultExportRowError[] = [];
  const unknown = new Set<string>();
  const rows: TestRailAnalysisRow[] = [];
  for (const record of table.rows) {
    const statusRaw = cell(record.cells, cols.status);
    const status = statusOf(statusRaw);
    // An unrecognized status is NOT dropped: it becomes Custom Status (like
    // TestRail's id ≥ 6) and the raw value is listed for the user.
    const finalStatus: AnalysisStatus = statusRaw.trim() === '' ? 'untested' : status ?? (unknown.add(statusRaw.trim()), 'custom');
    const dateRaw = cell(record.cells, cols.testedOn);
    const testedOn = dateRaw.trim() === '' ? '' : (dateOrInvalid(dateRaw) ?? '');
    if (dateRaw.trim() !== '' && testedOn === '') {
      errors.push({ record: record.record, code: 'csv_bad_date', value: dateRaw });
      continue;
    }
    const idNum = (s: string): number => {
      const m = /\d+/.exec(s.replace(/[TtCc]/g, ''));
      return m === null ? 0 : Number(m[0]);
    };
    rows.push({
      testId: idNum(cell(record.cells, cols.testId)),
      caseId: idNum(cell(record.cells, cols.caseId)),
      status: finalStatus,
      stepsStatus: cleanText(cell(record.cells, cols.stepsStatus)),
      comment: cleanText(cell(record.cells, cols.comment)),
      run: cleanText(cell(record.cells, cols.run)),
      runConfig: cleanText(cell(record.cells, cols.runConfig)),
      defects: cleanText(cell(record.cells, cols.defects)),
      testedBy: cleanText(cell(record.cells, cols.testedBy)),
      testedOn,
      assignedTo: cleanText(cell(record.cells, cols.assignedTo)),
    });
  }
  return { rows, errors, unknownStatuses: [...unknown].sort((a, b) => a.localeCompare(b)), ok: errors.length === 0 && rows.length > 0 };
}

// ---- API lane -----------------------------------------------------------------------

const API_STATUS: Readonly<Record<number, AnalysisStatus>> = {
  1: 'passed',
  2: 'blocked',
  3: 'untested',
  4: 'retest',
  5: 'failed',
};

/**
 * Build the same normalized rows from a live fetch: results joined to their
 * tests (for caseId) and runs (for the TestRun label), with display names
 * from the user list ("User #id" fallback — names are cosmetic).
 */
export function rowsFromApi(
  results: readonly TestRailResultRow[],
  tests: readonly TestRailTestRow[],
  runs: readonly TestRailRunRef[],
  users: readonly TestRailUser[],
): TestRailAnalysisRow[] {
  const testById = new Map<number, TestRailTestRow>();
  for (const t of tests) testById.set(t.testId, t);
  const runById = new Map<number, TestRailRunRef>();
  for (const r of runs) runById.set(r.id, r);
  const nameOf = (id: number | null): string => {
    if (id === null) return '';
    const u = users.find((x) => x.id === id);
    return u !== undefined && u.name !== '' ? u.name : `User #${id}`;
  };
  return results.map((r) => {
    const test = testById.get(r.testId);
    const run = runById.get(r.runId);
    return {
      testId: r.testId,
      caseId: test?.caseId ?? 0,
      status: r.statusId === null ? 'untested' : r.statusId >= 6 ? 'custom' : (API_STATUS[r.statusId] ?? 'custom'),
      stepsStatus: '', // the API lane has no step-level statuses
      comment: cleanText(r.comment ?? ''),
      run: run?.name ?? '',
      runConfig: run?.config ?? '',
      defects: cleanText(r.defects ?? ''),
      testedBy: nameOf(r.createdBy),
      testedOn: dateOrInvalid(String(r.createdOn)) ?? '',
      assignedTo: nameOf(r.assignedToId),
    };
  });
}

// ---- analysis ------------------------------------------------------------------------

/** The analysis options — the Python tool's left panel. */
export interface AnalysisOptions {
  /** 'today' | 'all' | { from, to } as 'YYYY-MM-DD' (inclusive). */
  period: { kind: 'today' | 'all' } | { kind: 'custom'; from: string; to: string };
  /** Partial-match names excluded from the analysis (Assigned To). */
  excludedTesters: readonly string[];
  /** Whether the OS/Device mismatch rule runs. */
  checkOs: boolean;
  /** Selected Build names (the Build checkbox list). */
  builds: readonly string[];
  /** Selected TestRun labels ("Run(Config)"); empty = all. */
  runs: readonly string[];
  /** Today as 'YYYY-MM-DD' (the business day), for the 'today' period. */
  today: string;
}

/** One detected issue row (要確認リスト / その他 / Buildチェック). */
export interface AnalysisFinding {
  row: TestRailAnalysisRow;
  /** The TestRun label "Run(Config)". */
  testRun: string;
  /** Detected issue kinds, e.g. ['untested', 'device'] — localized by the UI. */
  issues: AnalysisIssueKind[];
}

/** One consistency warning row (整合性チェック). */
export interface ConsistencyFinding {
  caseId: number;
  /** 'YYYY-MM-DD' of the newest row involved. */
  date: string;
  /** How many Passed / Failed results the case has — the UI formats the line. */
  passed: number;
  failed: number;
  testedBy: string;
}

/** One per-tester × per-day achievement row (実績). */
export interface AchievementRow {
  testedBy: string;
  date: string;
  executed: number;
  retest: number;
}

export interface AnalysisResult {
  needsReview: AnalysisFinding[];
  retestNa: AnalysisFinding[];
  buildCheck: AnalysisFinding[];
  consistency: ConsistencyFinding[];
  achievements: AchievementRow[];
  /** Card counts: executed, needsReview, other, consistency. */
  summary: { executed: number; needsReview: number; other: number; consistency: number };
}

/** The TestRun label: "Run(Config)" — the tool's _make_testrun_label. */
export function testRunLabel(run: string, config: string): string {
  const r = run.trim();
  const c = config.trim();
  if (r === '') return c;
  return c === '' ? r : `${r}(${c})`;
}

/** Extract the distinct Build names from comments ("Build: X" / "Build Version: X"), normalized + deduped + sorted. */
export function extractBuilds(rows: readonly TestRailAnalysisRow[]): string[] {
  const re = /build(?:\s+version)?\s*[:：]\s*([^<\n\r]+)/gi;
  const found = new Set<string>();
  for (const row of rows) {
    for (const m of row.comment.matchAll(re)) {
      const name = cleanText(m[1] ?? '');
      if (name !== '') found.add(name);
    }
  }
  return [...found].sort((a, b) => a.localeCompare(b));
}

/** Extract the distinct TestRun labels, sorted. */
export function extractRuns(rows: readonly TestRailAnalysisRow[]): string[] {
  const found = new Set<string>();
  for (const row of rows) found.add(testRunLabel(row.run, row.runConfig));
  return [...found].sort((a, b) => a.localeCompare(b));
}

const isPassed = (s: AnalysisStatus): boolean => s === 'passed';

/** The OS/Device mismatch rule: Run Config says Android but the comment says iOS/iPhone (or vice versa). */
function deviceMismatch(runConfig: string, comment: string): boolean {
  const cfg = runConfig.toLowerCase();
  const com = comment.toLowerCase();
  const cfgAndroid = cfg.includes('android');
  const cfgIos = cfg.includes('ios') || cfg.includes('iphone');
  const comAndroid = com.includes('android');
  const comIos = com.includes('ios') || com.includes('iphone');
  return (cfgAndroid && comIos) || (cfgIos && comAndroid);
}

/**
 * Run every rule. Pure: the same rows + options always produce the same
 * result. The consistency check deliberately ignores the period and the
 * tester exclusions (it reads the raw rows, like the Python tool).
 */
export function analyzeResults(rows: readonly TestRailAnalysisRow[], options: AnalysisOptions): AnalysisResult {
  const excluded = options.excludedTesters.map((n) => n.trim().toLowerCase()).filter((n) => n !== '');
  const inPeriod = (row: TestRailAnalysisRow): boolean => {
    if (options.period.kind === 'all') return true;
    if (options.period.kind === 'today') return row.testedOn === options.today;
    if (options.period.kind !== 'custom') return true;
    return row.testedOn >= options.period.from && row.testedOn <= options.period.to;
  };
  const selectedRuns = options.runs.length > 0 ? new Set(options.runs) : null;

  // Forward-fill Test IDs (the export repeats the ID only on the first step row).
  const filled: TestRailAnalysisRow[] = [];
  let lastTestId = 0;
  for (const row of rows) {
    const testId = row.testId !== 0 ? row.testId : lastTestId;
    lastTestId = testId;
    filled.push({ ...row, testId });
  }

  // The per-test "Untested" flag: any step row of the test says Untested.
  const untestedByTest = new Map<number, boolean>();
  for (const row of filled) {
    if (row.stepsStatus !== '' && /untested/i.test(row.stepsStatus)) untestedByTest.set(row.testId, true);
  }

  const scope = filled.filter((row) => {
    if (!inPeriod(row)) return false;
    if (selectedRuns !== null && !selectedRuns.has(testRunLabel(row.run, row.runConfig))) return false;
    if (excluded.length > 0) {
      const a = row.assignedTo.toLowerCase();
      if (excluded.some((n) => a.includes(n))) return false;
    }
    return true;
  });

  const needsReview: AnalysisFinding[] = [];
  const retestNa: AnalysisFinding[] = [];
  const buildCheck: AnalysisFinding[] = [];
  const achievements = new Map<string, AchievementRow>();

  for (const row of scope) {
    const testRun = testRunLabel(row.run, row.runConfig);
    const issues: AnalysisIssueKind[] = [];
    if (untestedByTest.get(row.testId) === true) issues.push('untested');
    if (options.checkOs && deviceMismatch(row.runConfig, row.comment)) issues.push('device');
    if (isPassed(row.status) && row.comment === '') issues.push('noComment');
    if (row.status === 'failed' && row.defects === '') issues.push('noDefect');
    if (options.builds.length > 0 && isPassed(row.status)) {
      const com = row.comment.toLowerCase();
      const missing = options.builds.filter((b) => !com.includes(b.toLowerCase()));
      if (missing.length > 0) {
        issues.push('build');
        buildCheck.push({ row, testRun, issues: ['build'] });
      }
    }
    if (issues.length > 0 && row.status !== 'retest' && row.status !== 'na') {
      needsReview.push({ row, testRun, issues });
    }
    if (row.status === 'retest' || row.status === 'na') {
      retestNa.push({ row, testRun, issues: [row.status === 'retest' ? 'retest' : 'na'] });
    }
    // Achievements: every in-scope row counts (Retest rows count in both columns, like the tool).
    if (row.testedBy !== '' && row.testedOn !== '') {
      const key = `${row.testedBy}\u0000${row.testedOn}`;
      const acc = achievements.get(key) ?? { testedBy: row.testedBy, date: row.testedOn, executed: 0, retest: 0 };
      acc.executed += 1;
      if (row.status === 'retest') acc.retest += 1;
      achievements.set(key, acc);
    }
  }

  // Consistency: same Case ID with both Passed and Failed — raw rows, no filters.
  const byCase = new Map<number, { passed: number; failed: number; latest: TestRailAnalysisRow }>();
  for (const row of filled) {
    if (row.caseId === 0 || (row.status !== 'passed' && row.status !== 'failed')) continue;
    const acc = byCase.get(row.caseId) ?? { passed: 0, failed: 0, latest: row };
    if (row.status === 'passed') acc.passed += 1;
    else acc.failed += 1;
    if (row.testedOn > acc.latest.testedOn) acc.latest = row;
    byCase.set(row.caseId, acc);
  }
  const consistency: ConsistencyFinding[] = [];
  for (const [caseId, acc] of byCase) {
    if (acc.passed > 0 && acc.failed > 0) {
      consistency.push({
        caseId,
        date: acc.latest.testedOn,
        passed: acc.passed,
        failed: acc.failed,
        testedBy: acc.latest.testedBy,
      });
    }
  }
  consistency.sort((a, b) => a.date.localeCompare(b.date) || a.caseId - b.caseId);

  const achievementRows = [...achievements.values()].sort(
    (a, b) => b.date.localeCompare(a.date) || a.testedBy.localeCompare(b.testedBy),
  );

  return {
    needsReview,
    retestNa,
    buildCheck,
    consistency,
    achievements: achievementRows,
    summary: {
      executed: achievementRows.reduce((sum, r) => sum + r.executed, 0),
      needsReview: needsReview.length,
      other: retestNa.length,
      consistency: consistency.length,
    },
  };
}

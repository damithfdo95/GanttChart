/**
 * JIRA CSV import (pure domain — no UI, no i18n, no clock, no storage).
 *
 * A CSV export of JIRA issues becomes `JiraIssue[]` — the SAME normalized
 * shape the live JQL fetch produces (`shared/jira.ts`) — so every existing
 * consumer works unchanged: the ticket analysis (member stats, unmatched
 * reporters), "Import to Tickets" routing, blocking-event import and the
 * CSV/XLSX exports.
 *
 * Two column dialects are recognized, by header name (case-insensitive):
 *
 * 1. JIRA's own CSV export (Issues → Export → CSV, all fields): headers
 *    like "Issue key", "Summary", "Status", "Issue type", "Priority",
 *    "Assignee", "Reporter", "Labels", "Created", "Updated", "Affected
 *    versions", "Description".
 * 2. This app's own "JIRA Ticket Analysis" CSV export (round-trip): headers
 *    "Issue Key", "Summary", "Status", "Status Category", "Type",
 *    "Reporter", "Member ID", "Member", "Updated".
 *
 * Required: a key column and a summary column. Everything else is optional;
 * missing columns simply leave the optional fields undefined, exactly like a
 * live fetch that could not read them.
 */

import type { JiraIssue } from '../../../shared/jira';
import { parseCsv, type CsvTable } from '../../lib/csv/parseCsv';

export type JiraCsvErrorCode =
  | 'csv_empty'
  | 'csv_unclosed_quote'
  | 'csv_no_key_column'
  | 'csv_no_summary_column'
  | 'csv_missing_key'
  | 'csv_missing_summary'
  | 'csv_bad_row';

export interface JiraCsvRowError {
  /** 1-based record number in the CSV (the header is record 1). */
  record: number;
  code: JiraCsvErrorCode;
  value?: string;
}

export interface JiraCsvImport {
  issues: JiraIssue[];
  errors: JiraCsvRowError[];
  /** True only when at least one issue parsed and no row failed. */
  ok: boolean;
}

// ---- header matching ---------------------------------------------------------

const norm = (s: string): string => s.normalize('NFKC').trim().toLowerCase().replace(/[\s_]+/g, ' ');

/** Header names accepted for each JiraIssue field (JIRA export + this app's export). */
const HEADER_ALIASES: Readonly<Record<string, readonly string[]>> = {
  key: ['issue key', 'key', 'issue', 'キー'],
  summary: ['summary', 'title', '件名', '概要'],
  statusName: ['status', 'ステータス'],
  statusCategoryName: ['status category', 'ステータスカテゴリ'],
  typeName: ['issue type', 'type', '種類', 'タイプ'],
  priorityName: ['priority', '優先度'],
  assigneeName: ['assignee', '担当者'],
  reporterName: ['reporter', 'レポーター', '報告者'],
  labels: ['labels', 'ラベル'],
  created: ['created', '作成日時'],
  updated: ['updated', '更新日時'],
  affectedVersions: ['affected versions', 'fix versions', 'affected version', 'fix version', '影響バージョン'],
  descriptionPlain: ['description', '説明'],
};

function columnIndex(table: CsvTable, field: keyof typeof HEADER_ALIASES): number {
  const aliases = HEADER_ALIASES[field] ?? [];
  for (let i = 0; i < table.headers.length; i += 1) {
    if (aliases.includes(norm(table.headers[i] ?? ''))) return i;
  }
  return -1;
}

/** "a; b; c" / "a, b, c" / "a b c" (JIRA multi-value cells) → ['a','b','c']. */
function splitMultiValue(cell: string): string[] {
  const v = cell.trim();
  if (v === '') return [];
  return v
    .split(/[;]|,(?=\s)/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** Keep an ISO-8601 timestamp only when it parses as a date (never guessed). */
function isoOrUndefined(cell: string): string | undefined {
  const v = cell.trim();
  if (v === '') return undefined;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? undefined : v;
}

// ---- import -------------------------------------------------------------------

export function jiraIssuesFromCsv(text: string): JiraCsvImport {
  const parsed = parseCsv(text);
  if (!parsed.ok) {
    const code: JiraCsvErrorCode = parsed.fatal.kind === 'empty' ? 'csv_empty' : 'csv_unclosed_quote';
    return { issues: [], errors: [{ record: 0, code }], ok: false };
  }
  const table = parsed.table;

  const keyCol = columnIndex(table, 'key');
  const summaryCol = columnIndex(table, 'summary');
  if (keyCol === -1) return { issues: [], errors: [{ record: 0, code: 'csv_no_key_column' }], ok: false };
  if (summaryCol === -1) return { issues: [], errors: [{ record: 0, code: 'csv_no_summary_column' }], ok: false };

  const cols = {
    statusName: columnIndex(table, 'statusName'),
    statusCategoryName: columnIndex(table, 'statusCategoryName'),
    typeName: columnIndex(table, 'typeName'),
    priorityName: columnIndex(table, 'priorityName'),
    assigneeName: columnIndex(table, 'assigneeName'),
    reporterName: columnIndex(table, 'reporterName'),
    labels: columnIndex(table, 'labels'),
    created: columnIndex(table, 'created'),
    updated: columnIndex(table, 'updated'),
    affectedVersions: columnIndex(table, 'affectedVersions'),
    descriptionPlain: columnIndex(table, 'descriptionPlain'),
  };

  const cell = (row: readonly string[], col: number): string => (col >= 0 && col < row.length ? (row[col] ?? '') : '');

  const issues: JiraIssue[] = [];
  const errors: JiraCsvRowError[] = [];
  const seenKeys = new Set<string>();

  for (const row of table.rows) {
    const key = cell(row.cells, keyCol).trim();
    const summary = cell(row.cells, summaryCol).replace(/\s+/g, ' ').trim();
    if (key === '') {
      errors.push({ record: row.record, code: 'csv_missing_key' });
      continue;
    }
    if (summary === '') {
      errors.push({ record: row.record, code: 'csv_missing_summary', value: key });
      continue;
    }
    if (seenKeys.has(key)) {
      // A repeated key is a duplicate export row, not two issues: keep the first.
      errors.push({ record: row.record, code: 'csv_bad_row', value: key });
      continue;
    }
    seenKeys.add(key);

    const statusName = cell(row.cells, cols.statusName).trim();
    const statusCategoryName = cell(row.cells, cols.statusCategoryName).trim();
    const typeName = cell(row.cells, cols.typeName).trim();
    const priorityName = cell(row.cells, cols.priorityName).trim();
    const assigneeName = cell(row.cells, cols.assigneeName).trim();
    const reporterName = cell(row.cells, cols.reporterName).trim();
    const created = isoOrUndefined(cell(row.cells, cols.created));
    const updated = isoOrUndefined(cell(row.cells, cols.updated));
    const labels = splitMultiValue(cell(row.cells, cols.labels));
    const affectedVersions = splitMultiValue(cell(row.cells, cols.affectedVersions));
    const descriptionPlain = cell(row.cells, cols.descriptionPlain).trim();

    issues.push({
      id: key, // CSV exports carry no numeric id; the key is the stable identity
      key,
      summary,
      statusName, // required by JiraIssue; '' = unknown (same as an unnamed status)
      ...(statusCategoryName === '' ? {} : { statusCategoryName }),
      typeName, // required by JiraIssue; '' = unknown
      ...(priorityName === '' ? {} : { priorityName }),
      ...(assigneeName === '' ? {} : { assigneeName }),
      ...(reporterName === '' ? {} : { reporterName }),
      labels,
      ...(created === undefined ? {} : { created }),
      ...(updated === undefined ? {} : { updated }),
      affectedVersions,
      descriptionPlain, // required by JiraIssue; '' = no description
    });
  }

  return { issues, errors, ok: errors.length === 0 && issues.length > 0 };
}

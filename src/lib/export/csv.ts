/** RFC-4180-style CSV with UTF-8 BOM (Excel-friendly for Japanese text). */

import type { XlsxCell } from './xlsx';

export type CsvValue = string | number | boolean | null | undefined;

/**
 * CSV/formula injection guard (OWASP): spreadsheet apps evaluate a cell that
 * starts with = + - @ (or tab/CR) as a formula, so user text such as a ticket
 * title "=HYPERLINK(...)" could execute when the export is opened. Such text
 * cells get a leading apostrophe so they stay literal text. Plain signed
 * numbers ("-5", "+1.5") are left alone so they still import as numbers.
 */
function neutralizeFormula(s: string): string {
  if (!/^[=+\-@\t\r]/.test(s)) return s;
  if (/^[+-]?\d+(\.\d+)?$/.test(s)) return s;
  return `'${s}`;
}

function encodeCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? neutralizeFormula(value) : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: CsvValue[][]): string {
  const lines = [headers, ...rows].map((row) => row.map(encodeCell).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** Flatten any XLSX cell (date/percent objects) into a plain CSV value. */
export function csvValueFromCell(cell: XlsxCell): CsvValue {
  if (typeof cell === 'object' && cell !== null && 'kind' in cell) {
    return cell.value;
  }
  return cell;
}


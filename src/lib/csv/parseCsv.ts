/**
 * RFC-4180 CSV reader — the parse side of `src/lib/export/csv.ts`.
 *
 * Dialect (matches what this app writes, plus common spreadsheet exports):
 * - UTF-8 BOM is stripped.
 * - Fields are separated by commas; records are separated by CRLF, LF or CR.
 * - A field may be quoted ("…"); inside quotes a literal quote is doubled
 *   (""), and commas/newlines are data.
 * - The delimiter is sniffed from the first line: when it contains no comma
 *   but semicolons or tabs, those are used instead (Excel in some locales
 *   exports ';'-separated CSV; data pasted from Excel is tab-separated).
 *
 * Record numbers are 1-based and count EVERY record including the header, so
 * an error at "record 7" is row 7 in a spreadsheet. Fully blank records are
 * dropped from `rows` but still counted in the numbering.
 *
 * Pure: no DOM, no Date, no i18n, no storage.
 */

export type CsvDelimiter = ',' | ';' | '\t';

export interface CsvRow {
  /** 1-based record number (the header is record 1, the first data row is record 2). */
  record: number;
  cells: string[];
}

export interface CsvTable {
  headers: string[];
  rows: CsvRow[];
}

export type CsvFatal =
  | { kind: 'empty' }
  | { kind: 'unclosedQuote'; record: number };

export type CsvParseResult =
  | { ok: true; table: CsvTable }
  | { ok: false; fatal: CsvFatal };

/** Count delimiters outside quotes on the first physical line. */
function sniffDelimiter(src: string): CsvDelimiter {
  let inQuotes = false;
  let commas = 0;
  let semicolons = 0;
  let tabs = 0;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i] ?? '';
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === '\n' || ch === '\r') {
      break;
    } else if (!inQuotes) {
      if (ch === ',') commas += 1;
      else if (ch === ';') semicolons += 1;
      else if (ch === '\t') tabs += 1;
    }
  }
  if (commas === 0 && semicolons === 0 && tabs === 0) return ',';
  if (semicolons > commas && semicolons > tabs) return ';';
  if (tabs > commas && tabs > semicolons) return '\t';
  return ',';
}

export function parseCsv(text: string): CsvParseResult {
  const src = text.replace(/^\uFEFF/, '');
  const delimiter = sniffDelimiter(src);
  const records: string[][] = [];
  let cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  let record = 1;

  const endRecord = (): void => {
    cells.push(cell);
    records.push(cells);
    cells = [];
    cell = '';
    record += 1;
  };

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i] ?? '';
    if (inQuotes) {
      if (ch === '"') {
        if ((src[i + 1] ?? '') === '"') {
          cell += '"';
          i += 1; // consume the second quote of the escaped pair
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch; // commas and newlines inside quotes are data
      }
    } else if (ch === '"' && cell === '') {
      inQuotes = true;
    } else if (ch === delimiter) {
      cells.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && (src[i + 1] ?? '') === '\n') i += 1; // CRLF is one separator
      endRecord();
    } else {
      cell += ch;
    }
  }
  if (inQuotes) return { ok: false, fatal: { kind: 'unclosedQuote', record } };
  // A trailing record without a final newline (an empty tail is no record).
  if (cell !== '' || cells.length > 0) endRecord();

  const headerCells = records[0] ?? [];
  if (headerCells.every((c) => c.trim() === '')) return { ok: false, fatal: { kind: 'empty' } };

  const rows: CsvRow[] = [];
  for (let i = 1; i < records.length; i += 1) {
    const rowCells = records[i] ?? [];
    if (rowCells.every((c) => c.trim() === '')) continue; // blank row: skipped, but numbered
    rows.push({ record: i + 1, cells: rowCells });
  }
  return { ok: true, table: { headers: headerCells, rows } };
}

/** Comma-separated list of the first non-header record numbers (for "line(s) 3, 7" messages). */
export function firstRecords(errors: readonly { record: number }[], limit = 10): string {
  return errors
    .filter((e) => e.record > 0)
    .slice(0, limit)
    .map((e) => String(e.record))
    .join(', ');
}

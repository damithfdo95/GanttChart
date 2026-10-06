/**
 * Dependency-free XLSX writer. Produces a genuine .xlsx (Office Open XML)
 * workbook: ZIP container with STORED (uncompressed) entries + CRC-32.
 * Professional formatting included: bold header row, frozen header row,
 * auto-filter, auto-sized columns, date and percentage number formats.
 */

import { parseDate } from '../dates/dates';

export type XlsxCell =
  | string
  | number
  | boolean
  | null
  | { kind: 'date'; value: string }
  | { kind: 'percent'; value: number };

export interface XlsxSheet {
  name: string;
  headers: string[];
  rows: XlsxCell[][];
}

// ---- ZIP (stored entries) ----------------------------------------------------

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable !== null) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

export function crc32(bytes: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0 ^ -1;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** Build a ZIP archive with stored (uncompressed) entries. Deterministic output. */
export function buildZip(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const crc = crc32(entry.data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0x0021, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, entry.data.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    localParts.push(local, entry.data);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x0021, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, entry.data.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset += local.length + entry.data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const totalLength = offset + centralSize + 22;
  const out = new Uint8Array(totalLength);
  let pos = 0;
  for (const part of [...localParts, ...centralParts, eocd]) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

// ---- XML helpers ---------------------------------------------------------------

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // strip control characters that are illegal in XML 1.0
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

function colName(index: number): string {
  let name = '';
  let n = index;
  while (n >= 0) {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  }
  return name;
}

function cellDisplayLength(cell: XlsxCell): number {
  if (cell === null) return 0;
  if (typeof cell === 'string') return cell.length;
  if (typeof cell === 'number') return String(Math.round(cell * 100) / 100).length;
  if (typeof cell === 'boolean') return 5;
  return cell.kind === 'date' ? 10 : 7;
}

const STYLE_DEFAULT = 0;
const STYLE_BOLD = 1;
const STYLE_DATE = 2;
const STYLE_PERCENT = 3;

function cellXml(cell: XlsxCell, ref: string, style: number): string {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'string') {
    return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(cell)}</t></is></c>`;
  }
  if (typeof cell === 'boolean') {
    return `<c r="${ref}" s="${style}" t="b"><v>${cell ? 1 : 0}</v></c>`;
  }
  if (typeof cell === 'number') {
    return `<c r="${ref}" s="${style}"><v>${cell}</v></c>`;
  }
  if (cell.kind === 'date') {
    const epoch = parseDate(cell.value);
    if (epoch === null) {
      return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(cell.value)}</t></is></c>`;
    }
    const serial = epoch + 25569; // Excel 1900 epoch: 1970-01-01 = serial 25569
    return `<c r="${ref}" s="${style === STYLE_BOLD ? STYLE_BOLD : STYLE_DATE}"><v>${serial}</v></c>`;
  }
  return `<c r="${ref}" s="${style === STYLE_BOLD ? STYLE_BOLD : STYLE_PERCENT}"><v>${cell.value}</v></c>`;
}

function sheetXml(sheet: XlsxSheet): string {
  const columnCount = Math.max(1, sheet.headers.length);
  const lastCol = colName(columnCount - 1);
  const lastRow = sheet.rows.length + 1;

  const widths: number[] = [];
  for (let c = 0; c < columnCount; c++) {
    let max = cellDisplayLength(sheet.headers[c] ?? '');
    for (const row of sheet.rows) max = Math.max(max, cellDisplayLength(row[c] ?? null));
    widths.push(Math.min(40, Math.max(8, max + 2)));
  }
  const cols = widths
    .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
    .join('');

  const rowsXml: string[] = [];
  rowsXml.push(
    `<row r="1">${sheet.headers
      .map((header, c) => cellXml(header, `${colName(c)}1`, STYLE_BOLD))
      .join('')}</row>`,
  );
  sheet.rows.forEach((row, r) => {
    const ref = r + 2;
    rowsXml.push(
      `<row r="${ref}">${row
        .map((cell, c) => cellXml(cell, `${colName(c)}${ref}`, STYLE_DEFAULT))
        .join('')}</row>`,
    );
  });

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<cols>${cols}</cols>` +
    `<sheetData>${rowsXml.join('')}</sheetData>` +
    (sheet.rows.length > 0 ? `<autoFilter ref="A1:${lastCol}${lastRow}"/>` : '') +
    '</worksheet>'
  );
}

function stylesXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="2">' +
    '<numFmt numFmtId="164" formatCode="yyyy-mm-dd"/>' +
    '<numFmt numFmtId="165" formatCode="0.00%"/>' +
    '</numFmts>' +
    '<fonts count="2">' +
    '<font><sz val="11"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
    '</fonts>' +
    '<fills count="2">' +
    '<fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>' +
    '</fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="4">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>'
  );
}

/** Build a real .xlsx file from sheets. Sheet names must be unique and ≤31 chars. */
export function buildXlsx(sheets: XlsxSheet[]): Uint8Array {
  const enc = new TextEncoder();
  const entries: ZipEntry[] = [];

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    sheets
      .map(
        (_, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join('') +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>';
  entries.push({ name: '[Content_Types].xml', data: enc.encode(contentTypes) });

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';
  entries.push({ name: '_rels/.rels', data: enc.encode(rootRels) });

  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets>' +
    sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
    '</sheets>' +
    '</workbook>';
  entries.push({ name: 'xl/workbook.xml', data: enc.encode(workbook) });

  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join('') +
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    '</Relationships>';
  entries.push({ name: 'xl/_rels/workbook.xml.rels', data: enc.encode(workbookRels) });

  entries.push({ name: 'xl/styles.xml', data: enc.encode(stylesXml()) });

  sheets.forEach((sheet, i) => {
    entries.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc.encode(sheetXml(sheet)) });
  });

  return buildZip(entries);
}

import { describe, expect, it } from 'vitest';
import { csvValueFromCell, toCsv } from '../lib/export/csv';
import { crc32, buildXlsx, buildZip, type XlsxSheet } from '../lib/export/xlsx';

describe('toCsv', () => {
  it('produces BOM + CRLF lines', () => {
    const csv = toCsv(['A', 'B'], [['1', '2']]);
    expect(csv).toBe('\uFEFFA,B\r\n1,2\r\n');
  });

  it('quotes cells containing commas, quotes and newlines', () => {
    const csv = toCsv(['Name', 'Comment'], [['Tanaka, Yuki', 'said "ok"\nthanks']]);
    expect(csv).toBe('\uFEFFName,Comment\r\n"Tanaka, Yuki","said ""ok""\nthanks"\r\n');
  });

  it('handles null, undefined and booleans', () => {
    const csv = toCsv(['X'], [[null], [undefined], [true], [false]]);
    expect(csv).toBe('\uFEFFX\r\n\r\n\r\ntrue\r\nfalse\r\n');
  });

  it('neutralizes formula-like text cells but keeps numbers numeric', () => {
    const csv = toCsv(
      ['X'],
      [['=HYPERLINK("http://x","y")'], ['+cmd'], ['-2+3'], ['@SUM(A1)'], ['\tTAB'], ['-5'], ['+1.5'], [-7], ['a=b']],
    );
    expect(csv).toBe(
      '﻿X\r\n' +
        '"\'=HYPERLINK(""http://x"",""y"")"\r\n' +
        "'+cmd\r\n'-2+3\r\n'@SUM(A1)\r\n'\tTAB\r\n" +
        '-5\r\n+1.5\r\n-7\r\na=b\r\n',
    );
  });

  it('flattens date/percent cells', () => {
    expect(csvValueFromCell({ kind: 'date', value: '2026-09-17' })).toBe('2026-09-17');
    expect(csvValueFromCell({ kind: 'percent', value: 0.8649 })).toBe(0.8649);
    expect(csvValueFromCell('plain')).toBe('plain');
    expect(csvValueFromCell(null)).toBeNull();
  });
});

describe('crc32', () => {
  it('matches the standard test vector', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('buildZip', () => {
  function readZipNames(bytes: Uint8Array): string[] {
    const text = new TextDecoder().decode(bytes);
    const names: string[] = [];
    for (let i = 0; i < text.length; i++) {
      if (text.startsWith('PK\x03\x04', i)) {
        const nameLen = new DataView(bytes.buffer, bytes.byteOffset + i, 30).getUint16(26, true);
        names.push(text.slice(i + 30, i + 30 + nameLen));
      }
    }
    return names;
  }

  it('produces a valid ZIP local-file structure', () => {
    const enc = new TextEncoder();
    const zip = buildZip([
      { name: 'a.txt', data: enc.encode('hello') },
      { name: 'dir/b.txt', data: enc.encode('こんにちは') },
    ]);
    expect(zip[0]).toBe(0x50);
    expect(zip[1]).toBe(0x4b);
    expect(readZipNames(zip)).toEqual(['a.txt', 'dir/b.txt']);
    // EOCD signature at the very end.
    const tail = zip.slice(zip.length - 22);
    expect(tail[0]).toBe(0x50);
    expect(tail[1]).toBe(0x4b);
    expect(tail[2]).toBe(0x05);
    expect(tail[3]).toBe(0x06);
  });
});

describe('buildXlsx', () => {
  const sheet: XlsxSheet = {
    name: 'Attendance',
    headers: ['Date', 'Member', 'Ratio'],
    rows: [
      [{ kind: 'date', value: '2026-09-17' }, 'Tanaka', { kind: 'percent', value: 0.5 }],
      [{ kind: 'date', value: '2026-09-18' }, '<Escaped & Co>', 42],
    ],
  };

  function readEntries(bytes: Uint8Array): { name: string; data: Uint8Array }[] {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocd = bytes.length - 22;
    const count = dv.getUint16(eocd + 8, true);
    const cdOffset = dv.getUint32(eocd + 16, true);
    const entries: { name: string; data: Uint8Array }[] = [];
    let pos = cdOffset;
    for (let i = 0; i < count; i++) {
      const nameLen = dv.getUint16(pos + 28, true);
      const compSize = dv.getUint32(pos + 20, true);
      const localOffset = dv.getUint32(pos + 42, true);
      const name = new TextDecoder().decode(bytes.slice(pos + 46, pos + 46 + nameLen));
      const localNameLen = dv.getUint16(localOffset + 26, true);
      const dataStart = localOffset + 30 + localNameLen;
      entries.push({ name, data: bytes.slice(dataStart, dataStart + compSize) });
      pos += 46 + nameLen;
    }
    return entries;
  }

  it('produces a PK archive containing all OOXML parts', () => {
    const xlsx = buildXlsx([sheet]);
    expect(xlsx[0]).toBe(0x50); // 'P'
    expect(xlsx[1]).toBe(0x4b); // 'K'
    const names = readEntries(xlsx).map((e) => e.name);
    expect(names).toContain('[Content_Types].xml');
    expect(names).toContain('_rels/.rels');
    expect(names).toContain('xl/workbook.xml');
    expect(names).toContain('xl/_rels/workbook.xml.rels');
    expect(names).toContain('xl/styles.xml');
    expect(names).toContain('xl/worksheets/sheet1.xml');
  });

  it('writes sheet XML with formatting, frozen header and filters', () => {
    const xlsx = buildXlsx([sheet]);
    const sheetEntry = readEntries(xlsx).find((e) => e.name === 'xl/worksheets/sheet1.xml')!;
    const xml = new TextDecoder().decode(sheetEntry.data);
    expect(xml).toContain('xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"');
    expect(xml).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
    expect(xml).toContain('<autoFilter ref="A1:C3"/>');
    expect(xml).toContain('<cols>');
    expect(xml).toContain('<t xml:space="preserve">Date</t>'); // header text is inline
    expect(xml).toContain('&lt;Escaped &amp; Co&gt;'); // XML escaping
    expect(xml).toMatch(/<c r="A2" s="[23]"><v>\d+<\/v><\/c>/); // date cell with number format
  });

  it('references sheet names from the workbook with bold header styles', () => {
    const xlsx = buildXlsx([sheet]);
    const entries = readEntries(xlsx);
    const workbook = new TextDecoder().decode(entries.find((e) => e.name === 'xl/workbook.xml')!.data);
    expect(workbook).toContain('name="Attendance"');
    const styles = new TextDecoder().decode(entries.find((e) => e.name === 'xl/styles.xml')!.data);
    expect(styles).toContain('<b/>');
    expect(styles).toContain('formatCode="yyyy-mm-dd"');
    expect(styles).toContain('formatCode="0.00%"');
  });
});

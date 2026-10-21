import { describe, expect, it } from 'vitest';
import { firstRecords, parseCsv } from '../lib/csv/parseCsv';

describe('parseCsv', () => {
  it('parses plain comma-separated rows with a header', () => {
    const r = parseCsv('Issue key,Summary,Status\nPROJ-1,Login fails,Open\nPROJ-2,"Chart, slow",Done');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.table.headers).toEqual(['Issue key', 'Summary', 'Status']);
    expect(r.table.rows).toHaveLength(2);
    expect(r.table.rows[0]?.cells).toEqual(['PROJ-1', 'Login fails', 'Open']);
    expect(r.table.rows[1]?.cells).toEqual(['PROJ-2', 'Chart, slow', 'Done']);
  });

  it('record numbers are 1-based and count the header and blank rows', () => {
    const r = parseCsv('a,b\n1,2\n\n3,4');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.table.rows.map((row) => row.record)).toEqual([2, 4]);
  });

  it('strips the UTF-8 BOM this app writes', () => {
    const r = parseCsv('\uFEFFkey,title\nA-1,hello');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.table.headers).toEqual(['key', 'title']);
  });

  it('doubled quotes inside a quoted field are literal quotes', () => {
    const r = parseCsv('key,summary\nA-1,"say ""hi"" now"');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.table.rows[0]?.cells[1]).toBe('say "hi" now');
  });

  it('newlines inside quotes are data, and CRLF separates records', () => {
    const r = parseCsv('key,summary\r\nA-1,"line1\nline2"\r\nA-2,ok');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.table.rows).toHaveLength(2);
    expect(r.table.rows[0]?.cells[1]).toBe('line1\nline2');
  });

  it('sniffs semicolon and tab delimiters (Excel locale exports / pasted data)', () => {
    const semi = parseCsv('key;summary\nA-1;hello');
    const tab = parseCsv('key\tsummary\nA-1\thello');
    expect(semi.ok && semi.table.rows[0]?.cells).toEqual(['A-1', 'hello']);
    expect(tab.ok && tab.table.rows[0]?.cells).toEqual(['A-1', 'hello']);
  });

  it('a delimiter inside quotes does not fool the sniffer', () => {
    const r = parseCsv('key,summary\nA-1,"a; b; c"');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.table.rows[0]?.cells[1]).toBe('a; b; c');
  });

  it('an unclosed quote is a fatal error with the record number', () => {
    const r = parseCsv('key,summary\nA-1,"never closed');
    expect(r).toEqual({ ok: false, fatal: { kind: 'unclosedQuote', record: 2 } });
  });

  it('empty or header-only text is fatal', () => {
    expect(parseCsv('')).toEqual({ ok: false, fatal: { kind: 'empty' } });
    expect(parseCsv(',,,\n')).toEqual({ ok: false, fatal: { kind: 'empty' } });
  });

  it('a trailing record without a final newline is kept', () => {
    const r = parseCsv('key,summary\nA-1,hello');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.table.rows).toHaveLength(1);
  });

  it('firstRecords lists the first non-zero record numbers', () => {
    expect(firstRecords([{ record: 0 }, { record: 3 }, { record: 7 }, { record: 9 }])).toBe('3, 7, 9');
  });
});

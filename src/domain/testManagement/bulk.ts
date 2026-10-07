import { CASE_PRIORITIES, TM_LIMITS, normalizeCaseKey, type CasePriority } from '../../../shared/testManagement';

/**
 * "Paste from spreadsheet": text copied from Excel (tab-separated columns, one case per line) becomes a validated PREVIEW. Nothing is
 * saved here. The whole paste is accepted or refused: a single bad row (or duplicate key) means no case is created, so a half-fixed
 * sheet can never leave half its cases behind.
 *
 * Columns, in order:  Key | Title | Priority | Type | Expected Result   (only Title is required; a line with ONE cell is just a title,
 * and a blank Key gets the next free key of the scope). A first line that looks like a header is skipped. Full .xlsx import is a later stage.
 */

export interface BulkRow {
  /** 1-based line number in the pasted text (blank lines count). */
  line: number;
  /** Normalised key, or undefined = "give it the next free key". */
  key?: string;
  title: string;
  priority: CasePriority;
  type?: string;
  expected?: string;
}

export type BulkErrorCode = 'bulk_invalid_key' | 'bulk_duplicate_key_in_paste' | 'bulk_key_exists' | 'bulk_missing_title' | 'bulk_title_too_long' | 'bulk_invalid_priority' | 'bulk_text_too_long' | 'bulk_too_many_rows' | 'bulk_empty';

export interface BulkRowError {
  line: number;
  code: BulkErrorCode;
  /** The offending cell or key, for the message. */
  value?: string;
}

export interface BulkParse {
  rows: BulkRow[];
  errors: BulkRowError[];
  /** True only when there is at least one row and no error. */
  ok: boolean;
}

const HEADER_KEYS = new Set(['key', 'case key', 'case', 'case id', 'test case key', 'id', 'キー', 'ケース', 'ケースid', 'テストケースid', 'テストケースキー']);
const HEADER_TITLES = new Set(['title', 'name', 'summary', 'case title', 'タイトル', '件名', 'テストケース名', '名前']);

const PRIORITY_WORDS: Record<string, CasePriority> = {
  critical: 'critical', blocker: 'critical', p0: 'critical', 最高: 'critical', 緊急: 'critical',
  high: 'high', p1: 'high', 高: 'high',
  medium: 'medium', normal: 'medium', p2: 'medium', 中: 'medium',
  low: 'low', p3: 'low', 低: 'low',
};

const norm = (s: string): string => s.normalize('NFKC').trim().toLowerCase();

export function parseBulkCases(text: string, existingKeys: Iterable<string>): BulkParse {
  const existing = new Set([...existingKeys].map((k) => k.toUpperCase()));
  const lines = text.replace(/^﻿/, '').split(/\r\n|\n|\r/);
  const rows: BulkRow[] = [];
  const errors: BulkRowError[] = [];
  const seen = new Map<string, number>();
  let headerChecked = false;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw.trim() === '') continue;
    const cells = raw.split('\t').map((c) => c.trim());
    if (!headerChecked) {
      headerChecked = true;
      if (cells.length >= 2 && HEADER_KEYS.has(norm(cells[0])) && HEADER_TITLES.has(norm(cells[1]))) continue;
    }
    if (rows.length + errors.length >= TM_LIMITS.bulkRows + 50) break; // far past the limit: stop reading
    const line = i + 1;
    const [keyCell, titleCell, priorityCell, typeCell, expectedCell] = cells.length === 1 ? ['', cells[0]] : cells;
    let bad = false;
    const fail = (code: BulkErrorCode, value?: string): void => {
      errors.push({ line, code, ...(value === undefined ? {} : { value }) });
      bad = true;
    };

    let key: string | undefined;
    if (keyCell !== undefined && keyCell !== '') {
      const k = normalizeCaseKey(keyCell);
      if (k === null) fail('bulk_invalid_key', keyCell);
      else {
        key = k;
        if (existing.has(k)) fail('bulk_key_exists', k);
        else if (seen.has(k)) fail('bulk_duplicate_key_in_paste', k);
        else seen.set(k, line);
      }
    }
    const title = (titleCell ?? '').replace(/\s+/g, ' ').trim();
    if (title === '') fail('bulk_missing_title');
    else if (title.length > TM_LIMITS.title) fail('bulk_title_too_long');

    let priority: CasePriority = 'medium';
    if (priorityCell !== undefined && priorityCell !== '') {
      const p = PRIORITY_WORDS[norm(priorityCell)];
      if (p === undefined || !(CASE_PRIORITIES as readonly string[]).includes(p)) fail('bulk_invalid_priority', priorityCell);
      else priority = p;
    }
    const type = typeCell === undefined || typeCell === '' ? undefined : typeCell;
    const expected = expectedCell === undefined || expectedCell === '' ? undefined : expectedCell;
    if ((type !== undefined && type.length > TM_LIMITS.type) || (expected !== undefined && expected.length > TM_LIMITS.expected)) fail('bulk_text_too_long');
    if (!bad) rows.push({ line, ...(key === undefined ? {} : { key }), title, priority, ...(type === undefined ? {} : { type }), ...(expected === undefined ? {} : { expected }) });
  }

  if (rows.length + errors.length === 0) errors.push({ line: 0, code: 'bulk_empty' });
  else if (rows.length > TM_LIMITS.bulkRows) errors.push({ line: 0, code: 'bulk_too_many_rows', value: String(TM_LIMITS.bulkRows) });
  return { rows, errors, ok: errors.length === 0 && rows.length > 0 };
}

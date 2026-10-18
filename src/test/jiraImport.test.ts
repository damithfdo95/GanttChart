import { describe, expect, it } from 'vitest';
import {
  JIRA_PRIORITY_MAP,
  collapseWhitespace,
  jiraImportPreview,
  jiraIssuesToBulkRows,
  mapJiraPriority,
  ticketRefFromCaseType,
  truncateText,
} from '../domain/testManagement/jiraImport';
import { buildBulkCases, nextCaseKey } from '../domain/testManagement';
import { CASE_PRIORITIES, TM_LIMITS, type TestScope } from '../../shared/testManagement';
import type { JiraIssue } from '../../shared/jira';

const NOW = '2026-10-07T09:00:00.000Z';
const P = 'PRJ-001';

const issue = (over: Partial<JiraIssue> = {}): JiraIssue => ({
  id: '10001',
  key: 'PROJ-42',
  summary: 'Login fails on Safari',
  statusName: 'Open',
  typeName: 'Bug',
  priorityName: 'High',
  labels: [],
  affectedVersions: [],
  descriptionPlain: '',
  ...over,
});

const scope = (over: Partial<TestScope> = {}): TestScope => ({ id: 'scp_1', projectId: P, name: 'Ecosystem', code: 'ECO', status: 'active', order: 10, createdAt: NOW, updatedAt: NOW, ...over });

describe('truncation helpers', () => {
  it('collapses runs of whitespace (including newlines) to single spaces and trims', () => {
    expect(collapseWhitespace('  Login   fails\non\tSafari  ')).toBe('Login fails on Safari');
    expect(collapseWhitespace('   ')).toBe('');
  });

  it('truncates at TM_LIMITS.title for titles and TM_LIMITS.description for descriptions', () => {
    expect(truncateText('x'.repeat(TM_LIMITS.title + 50), TM_LIMITS.title)).toHaveLength(TM_LIMITS.title);
    expect(truncateText('x'.repeat(TM_LIMITS.description + 50), TM_LIMITS.description)).toHaveLength(TM_LIMITS.description);
    expect(truncateText('short', TM_LIMITS.title)).toBe('short');
    expect(truncateText('', TM_LIMITS.title)).toBe('');
    // truncation keeps the leading part intact
    expect(truncateText('hello world', 5)).toBe('hello');
  });
});

describe('JIRA priority → case priority mapping', () => {
  it('follows the documented matrix: Highest/High → high, Medium → medium, Low/Lowest → low', () => {
    expect(mapJiraPriority('Highest')).toBe('high');
    expect(mapJiraPriority('High')).toBe('high');
    expect(mapJiraPriority('Medium')).toBe('medium');
    expect(mapJiraPriority('Low')).toBe('low');
    expect(mapJiraPriority('Lowest')).toBe('low');
  });

  it('is case-insensitive and trims', () => {
    expect(mapJiraPriority('  HIGH ')).toBe('high');
    expect(mapJiraPriority('medium')).toBe('medium');
    expect(mapJiraPriority('hIgHeSt')).toBe('high');
  });

  it('maps the common severity words some instances use (still CASE_PRIORITIES values)', () => {
    expect(mapJiraPriority('Blocker')).toBe('critical');
    expect(mapJiraPriority('Critical')).toBe('critical');
    expect(mapJiraPriority('Urgent')).toBe('critical');
    expect(mapJiraPriority('Major')).toBe('high');
    expect(mapJiraPriority('Minor')).toBe('low');
    expect(mapJiraPriority('Trivial')).toBe('low');
  });

  it('falls back to medium for a missing or unknown priority; never invents a value', () => {
    expect(mapJiraPriority(undefined)).toBe('medium');
    expect(mapJiraPriority('')).toBe('medium');
    expect(mapJiraPriority('Sometime')).toBe('medium');
    expect(Object.values(JIRA_PRIORITY_MAP).every((p) => (CASE_PRIORITIES as readonly string[]).includes(p))).toBe(true);
  });
});

describe('ticketRefFromCaseType', () => {
  it('extracts the key from the type written by jiraIssuesToBulkRows', () => {
    expect(ticketRefFromCaseType('[PROJ-42] Bug')).toBe('PROJ-42');
    expect(ticketRefFromCaseType('[PROJ-42]')).toBe('PROJ-42');
    expect(ticketRefFromCaseType(undefined)).toBeNull();
    expect(ticketRefFromCaseType('Bug')).toBeNull();
    expect(ticketRefFromCaseType('  [A-1] Story  ')).toBe('A-1');
  });
});

describe('jiraIssuesToBulkRows', () => {
  it('maps one row per issue: line, title, priority, type with the ticket ref, description', () => {
    const rows = jiraIssuesToBulkRows([issue({ descriptionPlain: 'Cannot log in\nfrom Safari.' })]);
    expect(rows).toEqual([
      {
        line: 1,
        title: 'Login fails on Safari',
        priority: 'high',
        type: '[PROJ-42] Bug',
        description: 'Cannot log in from Safari.',
      },
    ]);
  });

  it('truncates the title at TM_LIMITS.title and the description at TM_LIMITS.description', () => {
    const longSummary = 'S '.repeat(TM_LIMITS.title);
    const longDescription = 'D '.repeat(TM_LIMITS.description);
    const [row] = jiraIssuesToBulkRows([issue({ summary: longSummary, descriptionPlain: longDescription })]);
    expect(row.title).toHaveLength(TM_LIMITS.title);
    expect(row.description).toHaveLength(TM_LIMITS.description);
    expect(row.title).toBe(longSummary.trim().slice(0, TM_LIMITS.title));
  });

  it('omits the description when the issue has none (empty → field absent, not an empty string)', () => {
    const [row] = jiraIssuesToBulkRows([issue({ descriptionPlain: '   \n ' })]);
    expect(row.description).toBeUndefined();
  });

  it('writes just the ticket ref into type when there is no issue type name', () => {
    const [row] = jiraIssuesToBulkRows([issue({ typeName: '   ' })]);
    expect(row.type).toBe('[PROJ-42]');
    expect(ticketRefFromCaseType(row.type)).toBe('PROJ-42');
  });

  it('caps the type field at TM_LIMITS.type (40) while keeping the ticket ref intact', () => {
    const [row] = jiraIssuesToBulkRows([issue({ typeName: 'Very long type name '.repeat(10) })]);
    expect(row.type).toBeDefined();
    expect(row.type!.length).toBeLessThanOrEqual(TM_LIMITS.type);
    expect(ticketRefFromCaseType(row.type)).toBe('PROJ-42');
  });

  it('defaults the priority to medium when JIRA gives none', () => {
    const [row] = jiraIssuesToBulkRows([issue({ priorityName: undefined })]);
    expect(row.priority).toBe('medium');
  });

  it('numbers lines 1-based, like parseBulkCases', () => {
    const rows = jiraIssuesToBulkRows([issue({ key: 'A-1' }), issue({ key: 'A-2' }), issue({ key: 'A-3' })]);
    expect(rows.map((r) => r.line)).toEqual([1, 2, 3]);
  });

  it('feeds buildBulkCases end to end: descriptions land in TestCase.description, types and priorities too, keys auto-assigned', () => {
    const issues = [
      issue({ key: 'PROJ-42', summary: 'Login fails on Safari', priorityName: 'Highest', typeName: 'Bug', descriptionPlain: 'Cannot log in.' }),
      issue({ key: 'PROJ-43', summary: 'Export is slow', priorityName: 'Low', typeName: 'Task' }),
    ];
    const rows = jiraIssuesToBulkRows(issues);
    const built = buildBulkCases({ scopes: [scope()], testCases: [] }, 'scp_1', rows, NOW);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const [a, b] = built.value;
    expect(a).toMatchObject({ key: 'ECO-001', title: 'Login fails on Safari', priority: 'high', type: '[PROJ-42] Bug', description: 'Cannot log in.' });
    expect(b).toMatchObject({ key: 'ECO-002', title: 'Export is slow', priority: 'low', type: '[PROJ-43] Task' });
    expect(b.description).toBeUndefined();
  });
});

describe('jiraImportPreview', () => {
  it('assigns the same would-be keys as nextCaseKey over the existing keys (key-collision logic reused)', () => {
    const issues = [issue({ key: 'PROJ-42' }), issue({ key: 'PROJ-43' })];
    const existingKeys = new Set(['ECO-001', 'ECO-007']);
    const preview = jiraImportPreview(issues, existingKeys, 'ECO');
    expect(preview.map((r) => r.key)).toEqual([nextCaseKey('ECO', existingKeys, []), nextCaseKey('ECO', existingKeys, [nextCaseKey('ECO', existingKeys, [])])]);
    expect(preview.map((r) => r.key)).toEqual(['ECO-008', 'ECO-009']);
  });

  it('flags a JIRA key appearing twice in one batch as a duplicate (second occurrence)', () => {
    const issues = [issue({ key: 'PROJ-42' }), issue({ key: 'PROJ-43' }), issue({ key: 'PROJ-42' })];
    const preview = jiraImportPreview(issues, new Set(), 'ECO');
    expect(preview.map((r) => [r.key, r.duplicate])).toEqual([
      ['ECO-001', false],
      ['ECO-002', false],
      ['ECO-003', true],
    ]);
  });

  it('flags a re-import when the JIRA key is already referenced among existing keys', () => {
    const issues = [issue({ key: 'PROJ-42' })];
    expect(jiraImportPreview(issues, new Set(['PROJ-42']), 'ECO')[0].duplicate).toBe(true);
    expect(jiraImportPreview(issues, new Set(['PROJ-99']), 'ECO')[0].duplicate).toBe(false);
  });

  it('three distinct keys produce no false positives', () => {
    const issues = [issue({ key: 'PROJ-42' }), issue({ key: 'PROJ-43' }), issue({ key: 'PROJ-44' })];
    expect(jiraImportPreview(issues, new Set(), 'ECO').every((r) => !r.duplicate)).toBe(true);
  });

  it('shows the truncated title', () => {
    const [row] = jiraImportPreview([issue({ summary: 'S '.repeat(TM_LIMITS.title) })], new Set(), 'ECO');
    expect(row.title).toHaveLength(TM_LIMITS.title);
  });

  it('leaves the input issues untouched (pure mapping)', () => {
    const issues = [issue({ key: 'PROJ-42', descriptionPlain: '  messy \n text ' })];
    const snapshot = JSON.stringify(issues);
    jiraImportPreview(issues, new Set(), 'ECO');
    jiraIssuesToBulkRows(issues);
    expect(JSON.stringify(issues)).toBe(snapshot);
  });
});
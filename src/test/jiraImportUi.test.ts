import { describe, expect, it } from 'vitest';
import type { JiraIssue } from '../../shared/jira';
import type { TestCase, TestScope } from '../../shared/testManagement';
import { buildBulkCases } from '../domain/testManagement';
import { existingJiraImportKeys, planJiraCaseImport } from '../features/testManagement/jiraImportUi';
import { JIRA_JQL_PLACEHOLDER } from '../lib/jira/jql';

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

const caseOf = (over: Partial<TestCase> = {}): TestCase => ({
  id: 'tc_0',
  projectId: P,
  scopeId: 'scp_1',
  key: 'ECO-001',
  title: 'Existing case',
  priority: 'medium',
  status: 'active',
  order: 0,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

describe('JIRA_JQL_PLACEHOLDER', () => {
  it('is a sane starter: a project placeholder, newest first', () => {
    expect(JIRA_JQL_PLACEHOLDER).toContain('project = ');
    expect(JIRA_JQL_PLACEHOLDER).toContain('ORDER BY updated DESC');
  });
});

describe('existingJiraImportKeys', () => {
  it('collects every case key of the project (archived included) plus the JIRA refs recorded on its cases', () => {
    const cases = [
      caseOf({ type: '[PROJ-42] Bug' }),
      caseOf({ id: 'tc_2', key: 'ECO-002', status: 'archived' }),
      // another project: neither its keys nor its refs belong to this import
      caseOf({ id: 'tc_3', projectId: 'PRJ-002', key: 'OTHER-001', type: '[ZZ-9] Story' }),
    ];
    const keys = existingJiraImportKeys(cases, P);
    expect(keys.has('ECO-001')).toBe(true);
    expect(keys.has('ECO-002')).toBe(true); // archived keys still block reuse
    expect(keys.has('PROJ-42')).toBe(true); // the re-import hook
    expect(keys.has('OTHER-001')).toBe(false);
    expect(keys.has('ZZ-9')).toBe(false);
    // a case without a ticket ref contributes no JIRA key
    expect(existingJiraImportKeys([caseOf({ type: 'Functional' })], P).has('PROJ-42')).toBe(false);
  });
});

describe('planJiraCaseImport', () => {
  it('plans one importable row per issue, with the keys buildBulkCases will assign', () => {
    const issues = [issue({ key: 'PROJ-42' }), issue({ key: 'PROJ-43', summary: 'Export is slow' })];
    const plan = planJiraCaseImport(issues, new Set(), 'ECO');
    expect(plan.rows).toHaveLength(2);
    expect(plan.rows.every((r) => r.importable && r.skipReason === null)).toBe(true);
    expect(plan.rows.map((r) => r.key)).toEqual(['ECO-001', 'ECO-002']);
    expect(plan.duplicateCount).toBe(0);
    expect(plan.invalidCount).toBe(0);
    expect(plan.commitRows.map((r) => r.title)).toEqual(['Login fails on Safari', 'Export is slow']);
  });

  it('skips a JIRA key that is already imported (re-import detection) and counts it', () => {
    const plan = planJiraCaseImport([issue({ key: 'PROJ-42' })], new Set(['PROJ-42']), 'ECO');
    expect(plan.duplicateCount).toBe(1);
    expect(plan.invalidCount).toBe(0);
    expect(plan.commitRows).toHaveLength(0);
    expect(plan.rows[0]).toMatchObject({ importable: false, skipReason: 'duplicate', key: null });
  });

  it('skips the second occurrence of the same JIRA key inside one batch, never the first', () => {
    const issues = [issue({ key: 'PROJ-42' }), issue({ key: 'PROJ-43' }), issue({ key: 'PROJ-42' })];
    const plan = planJiraCaseImport(issues, new Set(), 'ECO');
    expect(plan.duplicateCount).toBe(1);
    expect(plan.commitRows).toHaveLength(2);
    expect(plan.rows.map((r) => [r.importable, r.skipReason])).toEqual([
      [true, null],
      [true, null],
      [false, 'duplicate'],
    ]);
  });

  it('skips an issue whose summary yields no title and counts it separately', () => {
    const issues = [issue({ key: 'PROJ-50', summary: '   \n ' }), issue({ key: 'PROJ-51' })];
    const plan = planJiraCaseImport(issues, new Set(), 'ECO');
    expect(plan.invalidCount).toBe(1);
    expect(plan.duplicateCount).toBe(0);
    expect(plan.rows[0]).toMatchObject({ importable: false, skipReason: 'noTitle', key: null });
    expect(plan.commitRows).toHaveLength(1);
    expect(plan.commitRows[0].title).toBe('Login fails on Safari');
  });

  it('preview keys skip the project keys that are in use, exactly like the commit will', () => {
    const existing = [caseOf()]; // ECO-001 already used
    const keys = existingJiraImportKeys(existing, P);
    const plan = planJiraCaseImport([issue({ key: 'PROJ-42' })], keys, 'ECO');
    expect(plan.rows[0].key).toBe('ECO-002');
    const built = buildBulkCases({ scopes: [scope()], testCases: existing }, 'scp_1', plan.commitRows, NOW);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value[0].key).toBe('ECO-002');
  });

  it('feeds the bulk pipeline end to end: preview → commit rows → buildBulkCases yields Test Cases with key, ticket ref, priority and description', () => {
    const issues = [
      issue({ key: 'PROJ-42', summary: 'Login fails on Safari', priorityName: 'Highest', typeName: 'Bug', descriptionPlain: 'Cannot log in.\nfrom Safari.' }),
      issue({ key: 'PROJ-43', summary: 'Export is slow', priorityName: 'Low', typeName: 'Task' }),
    ];
    const plan = planJiraCaseImport(issues, new Set(), 'ECO');
    expect(plan.rows.map((r) => r.key)).toEqual(['ECO-001', 'ECO-002']);
    const built = buildBulkCases({ scopes: [scope()], testCases: [] }, 'scp_1', plan.commitRows, NOW);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const [a, b] = built.value;
    expect(a).toMatchObject({ key: 'ECO-001', title: 'Login fails on Safari', priority: 'high', type: '[PROJ-42] Bug', description: 'Cannot log in. from Safari.' });
    expect(b).toMatchObject({ key: 'ECO-002', title: 'Export is slow', priority: 'low', type: '[PROJ-43] Task' });
    expect(b.description).toBeUndefined();
  });

  it('skips duplicates and title-less issues in the middle, and the committed keys match the preview keys exactly', () => {
    const issues = [
      issue({ key: 'PROJ-42' }),
      issue({ key: 'PROJ-42' }), // duplicate in batch
      issue({ key: 'PROJ-50', summary: '   ' }), // no title
      issue({ key: 'PROJ-44', summary: 'Reports are wrong' }),
    ];
    const plan = planJiraCaseImport(issues, new Set(), 'ECO');
    expect(plan.duplicateCount).toBe(1);
    expect(plan.invalidCount).toBe(1);
    const importable = plan.rows.filter((r) => r.importable);
    // no phantom keys: the visible key of the last issue is ECO-002, not ECO-004
    expect(importable.map((r) => r.key)).toEqual(['ECO-001', 'ECO-002']);
    const built = buildBulkCases({ scopes: [scope()], testCases: [] }, 'scp_1', plan.commitRows, NOW);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.map((c) => c.key)).toEqual(importable.map((r) => r.key));
    expect(built.value.map((c) => c.title)).toEqual(['Login fails on Safari', 'Reports are wrong']);
  });

  it('leaves the input issues untouched (pure planning)', () => {
    const issues = [issue({ key: 'PROJ-42' }), issue({ key: 'PROJ-42' })];
    const snapshot = JSON.stringify(issues);
    planJiraCaseImport(issues, new Set(['PROJ-42']), 'ECO');
    expect(JSON.stringify(issues)).toBe(snapshot);
  });
});
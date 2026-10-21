import { describe, expect, it } from 'vitest';
import { jiraIssuesFromCsv } from '../domain/jira/csvImport';
import { toCsv } from '../lib/export/csv';
import { analyzeTickets } from '../domain/jira/analysis';
import type { JiraIssue } from '../../shared/jira';

const JIRA_EXPORT = [
  'Issue key,Summary,Status,Issue type,Priority,Assignee,Reporter,Labels,Created,Updated,Affected versions,Description',
  'PROJ-42,Login fails on Safari,Open,Bug,Highest,tanaka,suzuki,"login; safari",2026-10-01T09:00:00.000+0900,2026-10-02T10:00:00.000+0900,4.2.0,"Steps:\n1. open the app"',
  'PROJ-43,"Chart, slow render",Done,Task,,yamada,suzuki,,2026-09-28,2026-10-03,,"a, b"',
].join('\r\n');

describe('jiraIssuesFromCsv — JIRA native export dialect', () => {
  it('maps every column to the normalized JiraIssue shape', () => {
    const r = jiraIssuesFromCsv(JIRA_EXPORT);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.issues).toEqual([
      {
        id: 'PROJ-42',
        key: 'PROJ-42',
        summary: 'Login fails on Safari',
        statusName: 'Open',
        typeName: 'Bug',
        priorityName: 'Highest',
        assigneeName: 'tanaka',
        reporterName: 'suzuki',
        labels: ['login', 'safari'],
        created: '2026-10-01T09:00:00.000+0900',
        updated: '2026-10-02T10:00:00.000+0900',
        affectedVersions: ['4.2.0'],
        descriptionPlain: 'Steps:\n1. open the app',
      },
      {
        id: 'PROJ-43',
        key: 'PROJ-43',
        summary: 'Chart, slow render',
        statusName: 'Done',
        typeName: 'Task',
        assigneeName: 'yamada',
        reporterName: 'suzuki',
        labels: [],
        created: '2026-09-28',
        updated: '2026-10-03',
        affectedVersions: [],
        descriptionPlain: 'a, b',
      },
    ]);
  });

  it('feeds the ticket analysis unchanged (the live-fetch pipeline)', () => {
    const r = jiraIssuesFromCsv(JIRA_EXPORT);
    const analysis = analyzeTickets(r.issues, [], []);
    expect(analysis.totals.fetched).toBe(2);
    // The domain's order: updated descending (PROJ-43 10-03 > PROJ-42 10-02).
    expect(analysis.tickets.map((t) => t.issueKey)).toEqual(['PROJ-43', 'PROJ-42']);
    // 'Done' status name without a category column → todo bucket (same as live data without a category)
    expect(analysis.tickets[0]?.statusCategory).toBe('todo');
  });
});

describe('jiraIssuesFromCsv — this app\'s own CSV export (round-trip)', () => {
  it('reads back the ticket-analysis export', () => {
    const headers = ['Issue Key', 'Summary', 'Status', 'Status Category', 'Type', 'Reporter', 'Member ID', 'Member', 'Updated'];
    const rows = [
      ['PROJ-9', 'Exported row', 'In Review', 'In Progress', 'Bug', 'sato', '', '(unmatched)', '2026-10-05T00:00:00.000Z'],
    ];
    const csv = toCsv(headers, rows);
    const r = jiraIssuesFromCsv(csv);
    expect(r.ok).toBe(true);
    expect(r.issues[0]).toMatchObject({
      key: 'PROJ-9',
      summary: 'Exported row',
      statusName: 'In Review',
      statusCategoryName: 'In Progress',
      typeName: 'Bug',
      reporterName: 'sato',
      updated: '2026-10-05T00:00:00.000Z',
    });
  });
});

describe('jiraIssuesFromCsv — validation', () => {
  it('requires a key column and a summary column', () => {
    expect(jiraIssuesFromCsv('Summary\nOnly').errors[0]?.code).toBe('csv_no_key_column');
    expect(jiraIssuesFromCsv('Issue key\nPROJ-1').errors[0]?.code).toBe('csv_no_summary_column');
  });

  it('rows missing the key or the summary are reported and skipped', () => {
    const r = jiraIssuesFromCsv('Issue key,Summary\n,Missing key\nPROJ-1,\nPROJ-2,ok');
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.key)).toEqual(['PROJ-2']);
    expect(r.errors).toEqual([
      { record: 2, code: 'csv_missing_key' },
      { record: 3, code: 'csv_missing_summary', value: 'PROJ-1' },
    ]);
  });

  it('duplicate keys keep the first row and report the rest', () => {
    const r = jiraIssuesFromCsv('Issue key,Summary\nPROJ-1,first\nPROJ-1,second');
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]?.summary).toBe('first');
    expect(r.errors).toEqual([{ record: 3, code: 'csv_bad_row', value: 'PROJ-1' }]);
  });

  it('empty text is a fatal error', () => {
    expect(jiraIssuesFromCsv('').errors[0]?.code).toBe('csv_empty');
  });

  it('header matching is case/whitespace insensitive and Japanese-aware', () => {
    const r = jiraIssuesFromCsv('issue  key,summary,レポーター\nA-1,hello,すずき');
    expect(r.ok).toBe(true);
    expect(r.issues[0]?.reporterName).toBe('すずき');
  });

  it('unparseable timestamps are dropped, never guessed', () => {
    const r = jiraIssuesFromCsv('Issue key,Summary,Created\nA-1,hello,not-a-date');
    expect(r.issues[0]?.created).toBeUndefined();
  });
});

describe('jiraIssuesFromCsv — downstream routing (Import to Tickets path)', () => {
  it('CSV issues route by key prefix and affected version like live issues', async () => {
    const { routeIssuesToProjects } = await import('../domain/jira/ticketRouting');
    const r = jiraIssuesFromCsv(JIRA_EXPORT);
    const projects = [
      { id: 'p1', projectId: 'PRJ-001', jiraProjectKey: 'PROJ', cycleId: 'c1' },
    ] as never[];
    const cycles = [{ id: 'c1', version: '4.2.0' }] as never[];
    const routing = routeIssuesToProjects(r.issues, projects, cycles);
    expect(routing.routed).toHaveLength(1);
    expect(routing.routed[0]?.issues.map((i: JiraIssue) => i.key)).toContain('PROJ-42');
  });
});

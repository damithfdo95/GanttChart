import { describe, expect, it } from 'vitest';
import { applyRecordChanges, reportsToRecords, sharedSettings } from '../lib/sync/records';
import { starterWorkspace } from '../lib/sync/starter';
import { createBackupPayload, createHistoryBackupPayload, parseBackupPayload } from '../lib/backup/backup';
import { sanitizeRestoredAccountLinks } from '../lib/backup/restoreLinks';
import { defaultReportsState } from '../lib/storage/reports';
import { DEMO_STATE } from '../lib/storage/storage';
import { jiraIssuesToBlockingEvents, mergeBlockingEvents } from '../domain/blocking/jiraBlockers';
import type { JiraConnection, JiraIssue } from '../../shared/jira';
import type { ReportsState } from '../types';

const SECRET = 'SECRET-TOKEN-123';
const jira: JiraConnection = { baseUrl: 'https://acme.atlassian.net', email: 'sv@example.com', token: SECRET, proxyUrl: 'https://proxy.example.com' };

function withJira(conn: JiraConnection | undefined = jira): ReportsState {
  const s = defaultReportsState();
  return { ...s, settings: { ...s.settings, ...(conn !== undefined ? { jira: conn } : {}) } };
}

describe('the JIRA connection is device-local', () => {
  it('is never put into shared sync records', () => {
    const recs = [...reportsToRecords(withJira()).values()];
    expect(recs.some((r) => r.json.includes(SECRET) || r.json.includes('acme.atlassian.net'))).toBe(false);
    expect(sharedSettings(withJira().settings)).not.toHaveProperty('jira');
  });

  it('a remote settings record never replaces or removes the local connection, even a legacy one carrying jira', () => {
    const local = withJira();
    const remote = { ...defaultReportsState().settings, jira: { baseUrl: 'https://evil.example.com', token: 'x' } };
    const next = applyRecordChanges(local, [{ kind: 'settings', id: 'settings', json: JSON.stringify(remote) }], []);
    expect(next.settings.jira).toEqual(jira);
    const noJira = applyRecordChanges(local, [{ kind: 'settings', id: 'settings', json: JSON.stringify(defaultReportsState().settings) }], []);
    expect(noJira.settings.jira).toEqual(jira);
  });

  it('survives linking to the shared workspace (starter state)', () => {
    expect(starterWorkspace('en', withJira(), '2026-10-18T00:00:00Z').reports.settings.jira).toEqual(jira);
  });

  it('is left out of full and history backups', () => {
    const full = JSON.stringify(createBackupPayload(DEMO_STATE, withJira()));
    expect(full).not.toContain(SECRET);
    expect(full).not.toContain('acme.atlassian.net');
    const history = JSON.stringify(createHistoryBackupPayload(DEMO_STATE, withJira(), []));
    expect(history).not.toContain(SECRET);
    expect(parseBackupPayload(full).ok).toBe(true);
  });

  it('a restore keeps the device connection and a file connection is ignored', () => {
    expect(sanitizeRestoredAccountLinks(withJira({ baseUrl: 'https://other.example.com', token: 'y' }), withJira(), null).settings.jira).toEqual(jira);
    expect(sanitizeRestoredAccountLinks(withJira(), defaultReportsState(), null).settings.jira).toBeUndefined();
  });
});

describe('JIRA blocking events keep unique ids', () => {
  const issue = { key: 'P-1', summary: 'env down', typeName: 'Bug', labels: [] } as unknown as JiraIssue;

  it('the same ticket imported for another date gets its own id', () => {
    const first = jiraIssuesToBlockingEvents([issue], '2026-10-01');
    const { merged } = mergeBlockingEvents(first, jiraIssuesToBlockingEvents([issue], '2026-10-02'));
    expect(merged).toHaveLength(2);
    expect(new Set(merged.map((e) => e.id)).size).toBe(2);
    expect(merged[0].id).toBe('blk_P-1');
  });

  it('three imports and a hand-made clashing id all stay unique, and a re-import is still skipped', () => {
    let events = jiraIssuesToBlockingEvents([issue], '2026-10-01');
    for (const d of ['2026-10-02', '2026-10-03']) events = mergeBlockingEvents(events, jiraIssuesToBlockingEvents([issue], d)).merged;
    const again = mergeBlockingEvents(events, jiraIssuesToBlockingEvents([issue], '2026-10-03'));
    expect(again.skipped).toHaveLength(1);
    expect(again.merged).toHaveLength(3);
    const manual = mergeBlockingEvents(events, [{ id: 'blk_P-1', date: '2026-10-09', category: 'OTHER', minutes: 5, note: 'manual' }]).merged;
    expect(new Set(manual.map((e) => e.id)).size).toBe(manual.length);
  });
});

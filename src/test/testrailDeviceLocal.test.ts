import { describe, expect, it } from 'vitest';
import { applyRecordChanges, reportsToRecords, sharedSettings } from '../lib/sync/records';
import { starterWorkspace } from '../lib/sync/starter';
import { createBackupPayload, createHistoryBackupPayload, parseBackupPayload } from '../lib/backup/backup';
import { sanitizeRestoredAccountLinks } from '../lib/backup/restoreLinks';
import { defaultReportsState } from '../lib/storage/reports';
import { DEMO_STATE } from '../lib/storage/storage';
import { ensureProjectIds } from '../domain/projects/migrations';
import type { ProjectRecord, ReportsState } from '../types';
import type { TestRailConnection } from '../../shared/testrail';

const SECRET = 'SECRET-KEY-456';
const testrail: TestRailConnection = {
  baseUrl: 'https://rkong.testrail.com',
  email: 'sv@example.com',
  apiKey: SECRET,
  proxyUrl: 'https://proxy.example.com',
};

function withTestrail(conn: TestRailConnection | undefined = testrail): ReportsState {
  const s = defaultReportsState();
  return { ...s, settings: { ...s.settings, ...(conn !== undefined ? { testrail: conn } : {}) } };
}

const projectWithLink = (url: string | undefined): ProjectRecord[] =>
  ensureProjectIds([
    {
      id: 'p-1',
      projectId: 'PRJ-001',
      nameEn: 'Android',
      nameJa: 'Android',
      team: 'RCS',
      status: 'ongoing',
      statusHistory: [],
      completedAt: null,
      completedBy: null,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      inputs: { ...DEMO_STATE } as ProjectRecord['inputs'],
      ...(url !== undefined ? { testrailPlanUrl: url } : {}),
    },
  ]);

describe('the TestRail connection is device-local', () => {
  it('is never put into shared sync records', () => {
    const recs = [...reportsToRecords(withTestrail()).values()];
    expect(recs.some((r) => r.json.includes(SECRET) || r.json.includes('rkong.testrail.com'))).toBe(false);
    expect(sharedSettings(withTestrail().settings)).not.toHaveProperty('testrail');
  });

  it('a remote settings record never replaces or removes the local connection, even a legacy one carrying testrail', () => {
    const local = withTestrail();
    const remote = { ...defaultReportsState().settings, testrail: { baseUrl: 'https://evil.example.com', apiKey: 'x' } };
    const next = applyRecordChanges(local, [{ kind: 'settings', id: 'settings', json: JSON.stringify(remote) }], []);
    expect(next.settings.testrail).toEqual(testrail);
    const none = applyRecordChanges(local, [{ kind: 'settings', id: 'settings', json: JSON.stringify(defaultReportsState().settings) }], []);
    expect(none.settings.testrail).toEqual(testrail);
  });

  it('survives linking to the shared workspace (starter state)', () => {
    expect(starterWorkspace('en', withTestrail(), '2026-10-18T00:00:00Z').reports.settings.testrail).toEqual(testrail);
  });

  it('is left out of full and history backups', () => {
    const full = JSON.stringify(createBackupPayload(DEMO_STATE, withTestrail()));
    expect(full).not.toContain(SECRET);
    expect(full).not.toContain('rkong.testrail.com');
    const history = JSON.stringify(createHistoryBackupPayload(DEMO_STATE, withTestrail(), []));
    expect(history).not.toContain(SECRET);
    expect(parseBackupPayload(full).ok).toBe(true);
  });

  it('a restore keeps the device connection and a file connection is ignored', () => {
    expect(sanitizeRestoredAccountLinks(withTestrail({ baseUrl: 'https://other.example.com', apiKey: 'y' }), withTestrail(), null).settings.testrail).toEqual(testrail);
    expect(sanitizeRestoredAccountLinks(withTestrail(), defaultReportsState(), null).settings.testrail).toBeUndefined();
  });
});

describe('the per-project TestRail link URL is shareable project data', () => {
  it('rides along in shared sync records and backups (no credential involved)', () => {
    const state = withTestrail();
    state.projects = projectWithLink('https://rkong.testrail.com/index.php?/plans/view/32716');
    const recs = [...reportsToRecords(state).values()];
    const projectRecord = recs.find((r) => r.kind === 'project');
    expect(projectRecord?.json).toContain('plans/view/32716');
    const full = JSON.stringify(createBackupPayload(DEMO_STATE, state));
    expect(full).toContain('plans/view/32716');
    expect(full).not.toContain(SECRET);
  });

  it('is normalized on load: non-plan/run values are dropped, absent stays absent', () => {
    const projects = ensureProjectIds(projectWithLink('https://rkong.testrail.com/index.php?/dashboard'));
    expect(projects[0]?.testrailPlanUrl).toBeUndefined();
    const kept = ensureProjectIds(projectWithLink('https://rkong.testrail.com/index.php?/runs/view/42'));
    expect(kept[0]?.testrailPlanUrl).toBe('https://rkong.testrail.com/index.php?/runs/view/42');
  });
});

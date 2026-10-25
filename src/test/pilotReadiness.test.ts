import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILD_INFO } from '../lib/buildInfo';
import { FEEDBACK_CATEGORIES, browserSummary, buildDiagnostics, buildFeedbackReport, feedbackProblems, redactSecrets, type DiagnosticsInput } from '../domain/supportInfo';
import { ApiError } from '../lib/tenancy/api';
import { clearLastClientError, getLastClientError, recordClientError } from '../lib/support/clientErrors';
import { errorMessage } from '../features/tenancy/format';
import { FirstUseNotice } from '../components/FirstUseNotice';
import { KNOWN_LIMITATION_KEYS } from '../features/settings/SupportPanel';
import { accessTo } from '../app/access';
import { saveReportsState, defaultReportsState } from '../lib/storage/reports';
import { saveState, DEMO_STATE, normalizeQaInputs } from '../lib/storage/storage';
import { createJiraClient } from '../lib/jira/client';
import { createTestRailClient } from '../lib/testrail/client';
import { buildSupervisorDailyOperations } from '../domain/supervisorOperations';
import { buildQaImprovementAnalytics } from '../domain/qaImprovementAnalytics';
import { newProjectRecord } from '../domain/projects/lifecycle';
import { newDraft, finalizeReport, createRevision } from '../lib/reporting/drafts';
import { markReportPublished } from '../lib/reporting/publication';
import { reportDeliveryStateForDate } from '../domain/dailyReportDraft';
import { dictionaries } from '../i18n/dictionaries';
import type { QaInputs } from '../types';

const root = resolve(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');
const dict = (lang: 'en' | 'ja'): Record<string, string> => dictionaries[lang] as Record<string, string>;

const base: DiagnosticsInput = {
  build: { version: '1.2.3', commit: 'abc1234def56', builtAt: '2026-10-25T01:02:03.000Z', channel: 'pilot', release: 'v1.2.3-4-gabc1234' },
  mode: 'shared',
  role: 'sv',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  storage: 'indexeddb',
  jira: 'configured',
  testrail: 'notConfigured',
  sync: { status: 'synced', pending: 0, lastSyncedAt: Date.parse('2026-10-25T02:00:00.000Z') },
  lastError: { requestId: 'a1b2c3d4-e5f6-4789-a012-b3c4d5e6f708', code: 'forbidden', at: '2026-10-25T02:05:00.000Z', status: 403 },
  lastBackupAt: '2026-10-24T09:00:00.000Z',
  language: 'en',
  now: new Date('2026-10-25T03:00:00.000Z'),
};

describe('diagnostics', () => {
  const text = buildDiagnostics(base);

  it('contains version, commit, build, mode, integration state, sync state and the last Error ID', () => {
    for (const line of ['GanttChart Diagnostics', 'Version: 1.2.3', 'Commit: abc1234def56', 'Build: 2026-10-25T01:02:03.000Z', 'Channel: pilot', 'Mode: Shared workspace', 'Role: SV', 'JIRA: Configured', 'TestRail: Not configured', 'Sync: synced', 'Last successful sync: 2026-10-25T02:00:00.000Z', 'Last automatic backup: 2026-10-24T09:00:00.000Z']) expect(text, line).toContain(line);
    expect(text).toContain('Last Error ID: a1b2c3d4-e5f6-4789-a012-b3c4d5e6f708 · forbidden · HTTP 403');
    expect(text).toContain('Browser: Edge 130 on Windows');
    expect(text).not.toContain('Mozilla/5.0');
  });

  it('local mode has no sync lines; no error and no backup read as "none" / "not recorded"', () => {
    const local = buildDiagnostics({ ...base, mode: 'local', role: 'local', sync: null, lastError: null, lastBackupAt: null });
    expect(local).toContain('Mode: Local');
    expect(local).not.toContain('Sync:');
    expect(local).toContain('Last Error ID: none this session');
    expect(local).toContain('Last automatic backup: not recorded');
  });

  it('is built only from an explicit small input: no field can carry a token, report text, memo or project content', () => {
    const panel = read('src/features/settings/SupportPanel.tsx');
    expect(panel).not.toMatch(/\.token|apiKey|\.email\b|previewText|\.reports\b|\bmemo\b|topics|description\s*:\s*report|Authorization/i);
    const pure = read('src/domain/supportInfo.ts');
    expect(pure).not.toMatch(/import .*(lib\/jira|lib\/testrail|reports|storage)/);
    // Integration state is a two-value enum, never the connection itself.
    expect(Object.keys(base)).not.toEqual(expect.arrayContaining(['token', 'apiKey', 'reports']));
  });

  it('masks a credential-looking value even if one reaches a free-text field, and a pending count is shown', () => {
    const t2 = buildDiagnostics({ ...base, storage: 'indexeddb token=abc123SECRET', sync: { status: 'offline', pending: 3, lastSyncedAt: null } });
    expect(t2).not.toContain('abc123SECRET');
    expect(t2).toContain('Sync: offline (3 change(s) waiting)');
    expect(t2).toContain('Last successful sync: none this session');
  });

  it('browser summaries are a family and a major version only', () => {
    expect(browserSummary('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15')).toBe('Safari 17 on macOS');
    expect(browserSummary('Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0')).toBe('Firefox 120 on Linux');
    expect(browserSummary('')).toBe('Unknown browser on unknown OS');
  });

  it('the build carries the pilot channel and no file path', () => {
    expect(BUILD_INFO.channel).toBe('pilot');
    expect(JSON.stringify(BUILD_INFO)).not.toMatch(/[A-Z]:\\|\/Users\/|\/home\//);
  });

  it('only management can reach it: it lives in Settings, which a Tester never sees', () => {
    expect(accessTo('user', 'settings')).toBe('none');
    expect(accessTo('admin', 'settings')).toBe('manage');
    expect(accessTo(null, 'settings')).toBe('manage');
    const importers = ['src/features/settings/Settings.tsx'].filter((f) => read(f).includes('SupportPanel'));
    expect(importers).toEqual(['src/features/settings/Settings.tsx']);
    expect(read('src/app/App.tsx')).not.toContain('SupportPanel');
  });
});

describe('Error ID', () => {
  afterEach(() => clearLastClientError());

  it('a failed request keeps the server request id, records it as the latest error (code and id only) and shows it in the message', () => {
    clearLastClientError();
    const err = new ApiError(403, 'forbidden', { error: 'forbidden', requestId: 'a1b2c3d4-e5f6-4789-a012-b3c4d5e6f708', email: 'secret@example.com' });
    expect(err.requestId).toBe('a1b2c3d4-e5f6-4789-a012-b3c4d5e6f708');
    expect(getLastClientError()).toMatchObject({ requestId: 'a1b2c3d4-e5f6-4789-a012-b3c4d5e6f708', code: 'forbidden', status: 403 });
    expect(JSON.stringify(getLastClientError())).not.toContain('secret@example.com');
    expect(errorMessage('en', err)).toContain('Error ID: a1b2c3d4-e5f6-4789-a012-b3c4d5e6f708');
    expect(errorMessage('ja', err)).toContain('エラーID: a1b2c3d4');
    expect(errorMessage('en', new ApiError(500, 'x', {}))).not.toContain('Error ID');
  });

  it('only well-formed ids and codes are kept (free text is dropped)', () => {
    recordClientError({ requestId: 'not an id <script>', code: 'Bearer abc def ghi jkl mno pqr stu vwx yz 0123456789 0123456789 0123456789', status: 500 });
    expect(getLastClientError()).toMatchObject({ requestId: null, code: 'error' });
  });
});

describe('feedback report', () => {
  const input = { category: 'bug' as const, summary: 'Finalize shows Published', description: 'Steps:\n1. Open report\n2. Finalize', screen: 'Command Center', projectId: 'PRJ-012', reporter: 'Aoi', errorId: 'req-1234abcd', build: { version: '1.2.3', commit: 'abc1234', channel: 'pilot' }, createdAt: new Date('2026-10-25T03:00:00.000Z') };

  it('has category, screen, version, commit, project, error id, summary and description, exactly as entered', () => {
    const text = buildFeedbackReport(input);
    for (const line of ['Category: Bug', 'Screen: Command Center', 'Version: 1.2.3', 'Commit: abc1234', 'Channel: pilot', 'Project: PRJ-012', 'Reporter: Aoi', 'Error ID: req-1234abcd', 'Summary: Finalize shows Published', 'Description:\nSteps:\n1. Open report\n2. Finalize']) expect(text, line).toContain(line);
    expect(text).toContain('Reported: 2026-10-25T03:00:00.000Z');
    expect(buildFeedbackReport({ ...input, category: 'ux' })).toContain('Category: UX issue');
  });

  it('has the seven simple categories, requires a summary, and omits unset optional fields', () => {
    expect([...FEEDBACK_CATEGORIES]).toEqual(['bug', 'ux', 'missingWorkflow', 'performance', 'dataInconsistency', 'integration', 'other']);
    expect(feedbackProblems({ category: 'bug', summary: '  ' })).toEqual(['summary']);
    expect(feedbackProblems({ category: 'bug', summary: 'x' })).toEqual([]);
    const minimal = buildFeedbackReport({ category: 'other', summary: 's', description: '', screen: '', build: { version: '1', commit: '', channel: 'pilot' }, createdAt: new Date(0) });
    expect(minimal).not.toMatch(/Project:|Reporter:|Error ID:/);
    expect(minimal).toContain('Screen: not specified');
    expect(minimal).toContain('Commit: unknown');
    expect(minimal).toContain('Description:\n(none)');
  });

  it('masks credentials pasted into the text but keeps everything else untouched', () => {
    const text = buildFeedbackReport({ ...input, summary: 'Call failed with Authorization: Bearer abcDEF1234567890', description: 'My api_key=SECRETVALUE99 and password: hunter2 and a token gh' + 'p_abcdefghijklmnopqrstuvwxyz123456. Normal words stay.' });
    for (const secret of ['abcDEF1234567890', 'SECRETVALUE99', 'hunter2', 'gh' + 'p_abcdefghijklmnopqrstuvwxyz123456']) expect(text, secret).not.toContain(secret);
    expect(text).toContain('Normal words stay.');
    expect(redactSecrets('plain text with no secrets')).toBe('plain text with no secrets');
  });

  it('is copy-only: no network, no storage, no automatic external send', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    buildFeedbackReport(input);
    buildDiagnostics(base);
    vi.unstubAllGlobals();
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const f of ['src/domain/supportInfo.ts', 'src/features/settings/SupportPanel.tsx', 'src/lib/support/clientErrors.ts']) expect(read(f), f).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|sendBeacon|localStorage|indexedDB|mailto:/);
    expect(read('src/features/settings/SupportPanel.tsx')).toContain('copyWithFallback');
  });

  it('has English and Japanese strings for the whole Support & Pilot section', () => {
    const keys = Object.keys(dict('en')).filter((k) => k.startsWith('support.') || k.startsWith('firstUse.'));
    expect(keys.length).toBeGreaterThan(50);
    for (const k of keys) expect(dict('ja')[k], k).toBeTruthy();
    expect(KNOWN_LIMITATION_KEYS).toHaveLength(8);
  });
});

describe('empty workspace first-use messaging', () => {
  it('explains why it is empty and offers one useful next action', () => {
    for (const body of ['firstUse.cc.body', 'firstUse.dr.body', 'firstUse.ia.body'] as const) {
      const html = renderToStaticMarkup(createElement(FirstUseNotice, { lang: 'en', bodyKey: body, onAction: () => {} }));
      expect(html).toContain('No projects yet');
      expect(html).toContain('Create a project');
      expect(html.match(/<button/g)).toHaveLength(1);
      expect(html).toContain(dict('en')[body]!.slice(0, 20));
    }
  });

  it('Command Center, Daily Report and Improvement Analytics show it when there are no projects and the action opens Projects', () => {
    expect(read('src/features/commandCenter/CommandCenter.tsx')).toMatch(/state\.projects\.length === 0 \? <FirstUseNotice[^>]*onAction=\{\(\) => onNavigate\('overall'\)\}/);
    expect(read('src/features/daily-report/DailyReport.tsx')).toMatch(/projects\.length === 0 && onOpenProjects !== undefined \? <FirstUseNotice/);
    expect(read('src/features/improvement/ImprovementAnalytics.tsx')).toContain('<FirstUseNotice lang={lang} bodyKey="firstUse.ia.body"');
    const app = read('src/app/App.tsx');
    expect(app).toContain("<ImprovementAnalytics onOpenProjects={() => setScreen('overall')} />");
    expect(app).toContain("<DailyReport onOpenProjects={() => setScreen('overall')}");
  });
});

describe('destructive actions say what they do', () => {
  it('deleting a project lists everything it removes (including finalized and published reports) and the recovery that exists', () => {
    const en = dict('en')['overall.confirmDeleteProject']!;
    for (const part of ['plan', 'daily execution', 'test scopes', 'test cases', 'case-execution history', 'meeting plans', 'daily reports', 'finalized and published', 'cannot be undone unless you have a backup', 'History']) expect(en, part).toContain(part);
    expect(dict('ja')['overall.confirmDeleteProject']).toContain('日報');
    // The statement matches what the code actually removes.
    const state = read('src/app/useReportsState.ts');
    const removal = state.slice(state.indexOf('const removeProject = useCallback'), state.indexOf('activeProjectId: removal.nextActiveProjectId'));
    for (const field of ['scopes', 'testCases', 'caseResults', 'caseExecutions', 'dailyPlans', 'reports: removal.reports']) expect(removal, field).toContain(field);
    expect(read('src/domain/projects/lifecycle.ts')).toContain('reports.filter((r) => r.projectId !== target.projectId)');
  });

  it('restoring a backup replaces data and says a backup of the current data is downloaded first; revision restore keeps history', () => {
    expect(dict('en')['reports.confirmRestore']).toMatch(/will replace the current data.*backup of the current data is downloaded first/);
    expect(dict('en')['history.restoreConfirm']).toContain('nothing is deleted');
    expect(dict('en')['shared.history.restoreConfirm']).toContain('You can undo this from History');
  });

  it('scopes and cases are archived, not deleted: their history stays, and the dialog says so', () => {
    expect(dict('en')['tm.scope.archiveBody']).toContain('stay as history');
    expect(read('src/app/useReportsState.ts')).not.toMatch(/removeScope|removeTestCase/);
  });
});

describe('local save failures are never reported as success', () => {
  const failing = (): void => {
    vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => {} } });
  };
  afterEach(() => vi.unstubAllGlobals());

  it('the storage writers return false when the browser refuses the write, and true when it accepts', () => {
    failing();
    expect(saveReportsState(defaultReportsState())).toBe(false);
    expect(saveState(DEMO_STATE)).toBe(false);
    vi.unstubAllGlobals();
    vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
    expect(saveReportsState(defaultReportsState())).toBe(true);
    expect(saveState(DEMO_STATE)).toBe(true);
  });

  it('the app shows "Save failed" (with a warning symbol) instead of "Saved" when a write fails', () => {
    const contexts = read('src/app/state-contexts.tsx');
    expect(contexts).toMatch(/\} else \{\s*\/\/ Storage failed[^\n]*\n\s*setStatus\('error'\);/);
    const app = read('src/app/App.tsx');
    expect(app).toContain("persistence.status === 'error' ? 'save.error'");
    expect(dict('en')['save.error']).toBe('Save failed');
  });
});

describe('shared-sync states are visible, and unsynced work is not shown as committed', () => {
  it('every sync status has its own label, and pending changes are counted while syncing or offline', () => {
    const client = read('src/lib/sync/client.ts');
    const union = client.slice(client.indexOf('export type SyncStatus ='), client.indexOf('export interface SyncState'));
    const statuses = [...union.matchAll(/\| '([a-z-]+)'/g)].map((m) => m[1] as string);
    expect(statuses.length).toBeGreaterThanOrEqual(10);
    const indicator = read('src/components/SyncStatus.tsx');
    for (const s of statuses) expect(indicator, s).toContain(s.includes('-') ? `'${s}':` : `${s}:`);
    expect(indicator).toContain("status === 'syncing' && pending > 0");
    expect(indicator).toContain("status === 'offline' && pending > 0");
    expect(dict('en')['shared.status.offlinePending']).toContain('{count}');
    expect(dict('en')['shared.status.offline']).not.toMatch(/synced|saved/i);
  });
});

describe('an integration outage stays inside the integration action', () => {
  const failFetch = async (): Promise<Response> => {
    throw new TypeError('Failed to fetch');
  };

  it('JIRA and TestRail failures are typed errors (network / CORS), never a raw exception', async () => {
    const jiraProxy = createJiraClient({ baseUrl: 'https://jira.example.com', proxyUrl: 'https://proxy.example.com', token: 't' }, failFetch);
    const jiraDirect = createJiraClient({ baseUrl: 'https://jira.example.com', token: 't' }, failFetch);
    const trProxy = createTestRailClient({ baseUrl: 'https://qa.testrail.example', proxyUrl: 'https://proxy.example.com', email: 'a@example.com', apiKey: 'k' }, failFetch);
    const trDirect = createTestRailClient({ baseUrl: 'https://qa.testrail.example', email: 'a@example.com', apiKey: 'k' }, failFetch);
    const kind = async (run: () => Promise<unknown>): Promise<string> => run().then(() => 'resolved', (e: { kind?: string }) => e.kind ?? `RAW:${String(e)}`);
    expect(await kind(() => (jiraProxy as unknown as { testConnection(): Promise<unknown> }).testConnection())).toBe('network');
    expect(await kind(() => (jiraDirect as unknown as { testConnection(): Promise<unknown> }).testConnection())).toBe('cors');
    expect(await kind(() => trProxy.testConnection())).toBe('network');
    expect(await kind(() => trDirect.testConnection())).toBe('cors');
  });

  it('the Command Center and analytics are derived from saved data: they run with the network down and import no integration client', () => {
    vi.stubGlobal('fetch', failFetch);
    const inputs = normalizeQaInputs({ ...(DEMO_STATE as QaInputs), dailyExecuted: [] });
    const project = { ...newProjectRecord(inputs, { nameEn: 'P', nameJa: 'P', status: 'ongoing' }, '2026-10-01T00:00:00.000Z', []), id: 'rec_1', projectId: 'PRJ-1' };
    const ops = buildSupervisorDailyOperations({ projects: [project], scopes: [], cases: [], selectedDate: '2026-10-25', today: '2026-10-25', nowIso: '2026-10-25T00:00:00.000Z' });
    expect(ops.projects.length).toBe(1);
    expect(buildQaImprovementAnalytics({ projects: [project], scopes: [], caseExecution: [], range: { from: '2026-10-01', to: '2026-10-25' }, today: '2026-10-25' }).projects).toHaveLength(1);
    vi.unstubAllGlobals();
    for (const f of ['src/domain/supervisorOperations.ts', 'src/domain/qaImprovementAnalytics.ts', 'src/features/commandCenter/CommandCenter.tsx', 'src/features/improvement/ImprovementAnalytics.tsx']) expect(read(f), f).not.toMatch(/lib\/jira|lib\/testrail|createJiraClient|createTestRailClient|fetch\(/);
  });
});

describe('the report workflow still works end to end', () => {
  it('draft -> finalize -> publish -> revision: publishing is once-only, the revision is a new unpublished draft', () => {
    const draft = newDraft('2026-10-25', 'en', 'Sup', '2026-10-25T00:00:00.000Z', 'PRJ-1');
    expect(reportDeliveryStateForDate([draft], '2026-10-25')).toBe('draft');
    const finalized = finalizeReport({ ...draft, previewText: 'Hello' }, [], [], 'Sup', '2026-10-25T01:00:00.000Z');
    expect(reportDeliveryStateForDate([finalized], '2026-10-25')).toBe('finalizedNotPublished');
    const published = markReportPublished(finalized, { userId: 'usr_1', memberId: null }, 'manualCopy', '2026-10-25T02:00:00.000Z');
    expect(reportDeliveryStateForDate([published], '2026-10-25')).toBe('finalizedPublished');
    expect(markReportPublished(published, { userId: 'usr_2', memberId: null }, 'print', '2026-10-26T00:00:00.000Z')).toBe(published);
    const revision = createRevision(published, '2026-10-26T00:00:00.000Z');
    expect(revision.status).toBe('DRAFT');
    expect(revision.publicationStatus).toBeUndefined();
    expect(reportDeliveryStateForDate([published, revision], '2026-10-25')).toBe('draft');
  });
});

describe('pilot documents', () => {
  it('exist, are linked from the README, and the release docs run release -> deploy -> smoke -> notes', () => {
    for (const f of ['docs/PILOT_RELEASE.md', 'docs/PILOT_FEEDBACK.md', 'docs/PILOT_SUCCESS_CRITERIA.md', 'docs/PILOT_OPERATIONS.md', 'docs/PRODUCTION_SMOKE.md', 'docs/PILOT_SUPPORT_MATRIX.md']) {
      expect(read(f).length, f).toBeGreaterThan(500);
      expect(read('README.md'), f).toContain(f);
    }
    expect(read('docs/RELEASING.md')).toMatch(/Flow: release checklist -> push -> deploy -> production smoke -> tag -> pilot notes/);
  });

  it('the production smoke checklist covers every required area, including backup export', () => {
    const smoke = read('docs/PRODUCTION_SMOKE.md').toLowerCase();
    for (const area of ['login', 'shared sync', 'dashboard', 'command center', 'test management', 'jira', 'testrail', 'daily report', 'publishing', 'improvement analytics', 'backup export']) expect(smoke, area).toContain(area);
  });

  it('the version authority is resolved: package.json is canonical, the tag is v + that version, and the ambiguity text is gone', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    const lock = JSON.parse(read('package-lock.json')) as { version: string; packages: { '': { version: string } } };
    expect(pkg.version).toBe('0.10.0-pilot.1');
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[''].version).toBe(pkg.version);
    expect(BUILD_INFO.version).toBe(pkg.version);
    expect(BUILD_INFO.channel).toBe('pilot');
    // The worker package is private tooling, not the product version.
    expect((JSON.parse(read('worker/package.json')) as { version: string }).version).not.toBe(pkg.version);
    const release = read('docs/PILOT_RELEASE.md');
    const releasing = read('docs/RELEASING.md');
    for (const doc of [release, releasing]) {
      expect(doc).toContain('canonical product/source version');
      expect(doc).toContain('Deployment identity only');
      expect(doc).toContain('`v` + the package version, exactly');
      expect(doc).toContain('0.10.0-pilot.1');
      expect(doc).toContain('v0.9.0');
      expect(doc).not.toMatch(/Owner decision still required|decision needed from the owner|Current ambiguity/i);
    }
    expect(release).toContain('git tag -a v0.10.0-pilot.1');
    expect(release).toMatch(/this repository does not create tags/);
    expect(release).toContain('No permanent pilot branch');
    expect(read('CHANGELOG.md')).toContain('## 0.10.0-pilot.1');
    expect(read('CHANGELOG.md')).toContain('## v0.9.0');
  });

  it('feedback taxonomy, success criteria (no invented numbers), operations and support matrix say what they should', () => {
    const fb = read('docs/PILOT_FEEDBACK.md');
    for (const c of ['**Bug**', '**UX issue**', '**Missing workflow**', '**Performance**', '**Data inconsistency**', '**Integration issue**']) expect(fb, c).toContain(c);
    expect(read('docs/PILOT_SUCCESS_CRITERIA.md')).not.toMatch(/\d+\s?%|\d+ minutes? faster|within \d+/);
    expect(read('docs/PILOT_SUCCESS_CRITERIA.md')).toContain('Pilot diary');
    const ops = read('docs/PILOT_OPERATIONS.md');
    for (const part of ['Daily (SV)', 'Weekly', 'Backup cadence', 'Restore drill', 'Rollback drill', 'Post-release monitoring', 'Management onboarding', 'fixing forward'.slice(0, 0) + 'roll forward']) expect(ops.toLowerCase(), part).toContain(part.toLowerCase());
    const matrix = read('docs/PILOT_SUPPORT_MATRIX.md');
    expect(matrix).toMatch(/Safari \| \*\*Not verified\*\*/);
    expect(matrix).toMatch(/Firefox \| \*\*Not verified\*\*/);
    expect(matrix).toMatch(/Phone-based execution entry is \*\*not\*\* verified/);
  });
});

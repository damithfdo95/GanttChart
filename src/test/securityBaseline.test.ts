import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isHttpUrl, isInsecureRemoteUrl, isSecureIntegrationUrl } from '../../shared/integrationUrl';
import { connectionFromDraft, jiraDraftProblems, type JiraDraft } from '../features/settings/jiraSettingsForm';
import { testrailConnectionFromDraft as trConnectionFromDraft, testrailDraftProblems } from '../features/settings/testrailSettingsForm';
import { createJiraClient } from '../lib/jira/client';
import { createTestRailClient } from '../lib/testrail/client';
import { createBackupPayload, parseBackupPayload } from '../lib/backup/backup';
import { defaultReportsState, normalizeReportsState } from '../lib/storage/reports';
import { DEMO_STATE, normalizeQaInputs } from '../lib/storage/storage';
import { newProjectRecord } from '../domain/projects/lifecycle';
import { newDraft, finalizeReport } from '../lib/reporting/drafts';
import { markReportPublished } from '../lib/reporting/publication';
import { planTestRailCaseImport } from '../domain/testManagement/testrailCases';
import type { AppState, DailyReport, QaInputs, ReportsState, TestCase, TestScope } from '../types';
import type { CaseExecutionEvent, CaseResult } from '../../shared/testManagement';

const root = resolve(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

describe('integration addresses: https required, localhost http allowed', () => {
  it('the one rule', () => {
    for (const ok of ['https://proxy.example.com', 'https://proxy.example.com/path', 'http://localhost:8787', 'http://127.0.0.1:8787/x', 'http://[::1]:8787', 'http://localhost']) expect(isSecureIntegrationUrl(ok), ok).toBe(true);
    for (const bad of ['http://proxy.example.com', 'http://localhost.evil.com', 'http://localhost@evil.com', 'http://127.0.0.1.evil.com', 'http://10.0.0.5', 'ftp://x.example.com', 'proxy.example.com', '', 'javascript:alert(1)']) expect(isSecureIntegrationUrl(bad), bad).toBe(false);
    expect(isInsecureRemoteUrl('http://proxy.example.com')).toBe(true);
    expect(isInsecureRemoteUrl('https://proxy.example.com')).toBe(false);
    expect(isHttpUrl('https://x.example.com')).toBe(true);
  });

  const jiraDraft = (over: Partial<JiraDraft>): JiraDraft => ({ baseUrl: 'https://jira.example.com', flavor: 'auto', email: '', token: 'tok', proxyUrl: '', ...over });

  it('Settings refuses a remote http proxy (and a remote http instance without a proxy), saves https and localhost', () => {
    expect(jiraDraftProblems(jiraDraft({ proxyUrl: 'http://proxy.example.com' })).proxyUrl).toBe(true);
    expect(connectionFromDraft(jiraDraft({ proxyUrl: 'http://proxy.example.com' }), undefined)?.proxyUrl).toBeUndefined();
    expect(jiraDraftProblems(jiraDraft({ baseUrl: 'http://jira.example.com' })).baseUrl).toBe(true);
    expect(connectionFromDraft(jiraDraft({ baseUrl: 'http://jira.example.com' }), undefined)).toBeUndefined();
    expect(connectionFromDraft(jiraDraft({ proxyUrl: 'https://proxy.example.com' }), undefined)?.proxyUrl).toBe('https://proxy.example.com');
    expect(connectionFromDraft(jiraDraft({ proxyUrl: 'http://localhost:8787' }), undefined)?.proxyUrl).toBe('http://localhost:8787');
    // The instance address is only metadata when a proxy carries the traffic.
    expect(jiraDraftProblems(jiraDraft({ baseUrl: 'http://jira.example.com', proxyUrl: 'https://proxy.example.com' })).baseUrl).toBe(false);

    const tr = { baseUrl: 'https://qa.testrail.example', apiKey: 'k', email: 'a@example.com', proxyUrl: '' };
    expect(testrailDraftProblems({ ...tr, proxyUrl: 'http://proxy.example.com' }).proxyUrl).toBe(true);
    expect(trConnectionFromDraft({ ...tr, proxyUrl: 'http://proxy.example.com' }, undefined)?.proxyUrl).toBeUndefined();
    expect(trConnectionFromDraft({ ...tr, baseUrl: 'http://qa.testrail.example' }, undefined)).toBeUndefined();
    expect(trConnectionFromDraft({ ...tr, proxyUrl: 'https://proxy.example.com' }, undefined)?.proxyUrl).toBe('https://proxy.example.com');
  });

  it('the clients themselves refuse to send credentials to a remote http address', () => {
    expect(() => createJiraClient({ baseUrl: 'https://jira.example.com', proxyUrl: 'http://proxy.example.com', token: 't' })).toThrow(/https/);
    expect(() => createJiraClient({ baseUrl: 'http://jira.example.com', token: 't' })).toThrow(/https/);
    expect(() => createTestRailClient({ baseUrl: 'https://qa.testrail.example', proxyUrl: 'http://proxy.example.com', email: 'a@example.com', apiKey: 'k' })).toThrow(/https/);
    expect(() => createTestRailClient({ baseUrl: 'http://localhost:9000', email: 'a@example.com', apiKey: 'k' })).not.toThrow();
  });

  it('a stored connection with an insecure address is dropped on load (no silent plain-http sending)', () => {
    const base = defaultReportsState();
    const loaded = normalizeReportsState({ ...base, settings: { ...base.settings, jira: { baseUrl: 'http://jira.example.com', token: 'x' }, testrail: { baseUrl: 'https://qa.testrail.example', email: 'a@example.com', apiKey: 'k', proxyUrl: 'http://proxy.example.com' } } });
    expect(loaded.settings.jira).toBeUndefined();
    expect(loaded.settings.testrail?.proxyUrl).toBeUndefined();
    expect(loaded.settings.testrail?.baseUrl).toBe('https://qa.testrail.example');
  });
});

describe('credentials never reach a backup', () => {
  it('a full backup contains no JIRA token, TestRail key or integration address', () => {
    const base = defaultReportsState();
    const reports: ReportsState = { ...base, settings: { ...base.settings, jira: { baseUrl: 'https://jira.example.com', token: 'JIRA-SECRET-1', email: 'sv@example.com' }, testrail: { baseUrl: 'https://qa.testrail.example', email: 'sv@example.com', apiKey: 'TR-SECRET-2', proxyUrl: 'https://proxy.example.com' } } };
    const text = JSON.stringify(createBackupPayload(DEMO_STATE as AppState, reports));
    for (const needle of ['JIRA-SECRET-1', 'TR-SECRET-2', 'proxy.example.com', 'qa.testrail.example', 'jira.example.com']) expect(text, needle).not.toContain(needle);
  });
});

// ---- backup resilience -----------------------------------------------------------------------

const NOW = '2026-10-20T00:00:00.000Z';
const project = (code: string, over: Partial<QaInputs> = {}) => ({ ...newProjectRecord(normalizeQaInputs({ ...(DEMO_STATE as QaInputs), ...over }), { nameEn: `Project ${code}`, nameJa: `プロジェクト${code}`, status: 'ongoing' }, NOW, []), id: `rec_${code}`, projectId: `PRJ-${code}` });
const scope = (id: string, projectId: string, workType: TestScope['workType']): TestScope => ({ id, projectId, name: id, status: 'active', order: 1, createdAt: NOW, updatedAt: NOW, totalTestCases: 10, ...(workType === undefined ? {} : { workType }) });

function richReports(): ReportsState {
  const base = defaultReportsState();
  const a = project('A', { dailyExecuted: [{ id: 'd1', date: '2026-10-19', startTime: 540, endTime: 1050, overtimeMinutes: 0, intervalEnabled: true, testers: 4, pass: 8, fail: 1, notApplicable: 0, spo: 0, blocked: 0, retest: 0, questioned: 0, note: '', source: 'caseExecution', derivedAt: NOW } as never] });
  const cases: TestCase[] = [{ id: 'c1', projectId: 'PRJ-A', scopeId: 's1', key: 'A-1', title: 'Login', priority: 'high', status: 'active', order: 1, createdAt: NOW, updatedAt: NOW, testrailCaseId: 501 } as TestCase];
  const result: CaseResult = { id: 'r1', projectId: 'PRJ-A', scopeId: 's1', testCaseId: 'c1', status: 'pass', retest: false, question: false, updatedAt: NOW } as CaseResult;
  const event: CaseExecutionEvent = { id: 'evt_1', projectId: 'PRJ-A', scopeId: 's1', testCaseId: 'c1', status: 'pass', executedAt: NOW, source: 'manual', retest: true };
  const draft: DailyReport = { ...newDraft('2026-10-19', 'en', 'Sup', NOW, 'PRJ-A'), previewText: 'Hello\n\n■ Attendance\nStaffing: Planned 8 · Assigned 7 · Actual 6', staffing: { planned: 8, assigned: 7, actual: 6 } };
  const finalized = finalizeReport(draft, [], [], 'Sup', NOW);
  const published = markReportPublished(finalized, { userId: 'usr_1', memberId: 'USER0001' }, 'manualCopy', NOW);
  return { ...base, projects: [a] as never, activeProjectId: a.id, scopes: [scope('s1', 'PRJ-A', 'regression'), scope('s2', 'PRJ-A', undefined)], testCases: cases, caseResults: [result], caseExecutions: [event], reports: [published, { ...finalized, id: 'legacy-finalized', reportDate: '2026-10-18' }], settings: { ...base.settings, qaPolicy: { ...(base.settings.qaPolicy ?? {}), unresolvedDefectStatuses: ['Open'] } as never } };
}

describe('backup round trip: export -> restore into a clean state -> export', () => {
  const stable = (payload: ReturnType<typeof createBackupPayload>) => JSON.stringify(payload.data);

  it('keeps the logical content of every newer data type (the export time is the only difference)', () => {
    const first = createBackupPayload(DEMO_STATE as AppState, richReports());
    const parsed = parseBackupPayload(JSON.stringify(first));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const second = createBackupPayload(parsed.data.appState, parsed.data.reportsState);
    expect(stable(second)).toBe(stable(first));
    const r = parsed.data.reportsState;
    expect(r.scopes?.find((s) => s.id === 's1')?.workType).toBe('regression');
    expect(r.scopes?.find((s) => s.id === 's2')?.workType).toBeUndefined();
    expect(r.caseExecutions).toHaveLength(1);
    expect(r.caseExecutions?.[0]).toMatchObject({ retest: true });
    expect(r.testCases?.[0]?.testrailCaseId).toBe(501);
    expect(r.projects[0]?.inputs.dailyExecuted?.[0]).toMatchObject({ source: 'caseExecution' });
    expect(r.reports.find((x) => x.publicationStatus === 'published')).toMatchObject({ publishedAt: NOW, publicationMethod: 'manualCopy', staffing: { planned: 8, assigned: 7, actual: 6 } });
    expect(r.reports.find((x) => x.id === 'legacy-finalized')?.publicationStatus).toBeUndefined();
  });

  it('a restored case import is still idempotent (TestRail case ids already present are not imported again)', () => {
    const parsed = parseBackupPayload(JSON.stringify(createBackupPayload(DEMO_STATE as AppState, richReports())));
    if (!parsed.ok) throw new Error('restore failed');
    const plan = planTestRailCaseImport([{ caseId: 501, title: 'Login' }], parsed.data.reportsState.testCases ?? [], 'PRJ-A', '');
    expect(plan.commitRows).toHaveLength(0);
  });
});

describe('backup corruption is rejected or isolated, never half-applied', () => {
  const valid = (): Record<string, unknown> => JSON.parse(JSON.stringify(createBackupPayload(DEMO_STATE as AppState, richReports()))) as Record<string, unknown>;
  const parse = (v: unknown) => parseBackupPayload(typeof v === 'string' ? v : JSON.stringify(v));

  it('refuses malformed, foreign, future-version and incomplete payloads without producing data', () => {
    expect(parse('{not json').ok).toBe(false);
    expect(parse('[]').ok).toBe(false);
    expect(parse({ app: 'other', kind: 'backup', version: 1, data: {} }).ok).toBe(false);
    expect(parse({ ...valid(), version: 2 }).ok).toBe(false);
    expect(parse({ ...valid(), version: 'one' }).ok).toBe(false);
    const noData = valid();
    delete noData.data;
    expect(parse(noData).ok).toBe(false);
    const noReports = valid();
    delete (noReports.data as Record<string, unknown>).reportsState;
    expect(parse(noReports).ok).toBe(false);
  });

  it('a structurally invalid record makes the whole restore fail safely (shape guard), not a partial import', () => {
    const bad = valid();
    ((bad.data as { reportsState: { reports: Array<Record<string, unknown>> } }).reportsState.reports[0] as Record<string, unknown>).status = 'ARCHIVED';
    expect(parse(bad).ok).toBe(false);
    const badScope = valid();
    (badScope.data as { reportsState: { scopes: Array<Record<string, unknown>> } }).reportsState.scopes[0]!.workType = 'nonsense';
    expect(parse(badScope).ok).toBe(false);
  });

  it('an older backup without any newer optional field restores, as Not Published / Unspecified / manual', () => {
    const old = valid();
    const data = (old.data as { reportsState: { reports: Array<Record<string, unknown>>; scopes: Array<Record<string, unknown>>; settings: Record<string, unknown>; projects: Array<{ inputs: { dailyExecuted?: Array<Record<string, unknown>> } }> } }).reportsState;
    for (const r of data.reports) for (const k of ['publicationStatus', 'publishedAt', 'publishedByUserId', 'publishedByMemberId', 'publicationMethod', 'staffing', 'preparedFrom']) delete r[k];
    for (const s of data.scopes) delete s.workType;
    delete data.settings.qaPolicy;
    for (const e of data.projects[0]?.inputs.dailyExecuted ?? []) delete e.source;
    const out = parse(old);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.reportsState.reports.every((r) => r.publicationStatus === undefined)).toBe(true);
    expect(out.data.reportsState.scopes?.every((s) => s.workType === undefined)).toBe(true);
  });

  it('damaged publication metadata is dropped (Not Published) and the report text is preserved', () => {
    const base = richReports();
    const published = base.reports[0] as DailyReport;
    const damaged = { ...published, publishedAt: 'never', publicationMethod: 'slack' } as unknown as DailyReport;
    const fixed = normalizeReportsState({ ...base, reports: [damaged] }).reports[0]!;
    expect(fixed.publicationStatus).toBeUndefined();
    expect(fixed.previewText).toBe(published.previewText);
  });

  it('invalid scopes / cases / history records are filtered out on normalisation, valid ones pass through unchanged', () => {
    const base = richReports();
    const polluted = normalizeReportsState({ ...base, scopes: [...(base.scopes ?? []), { id: 'bad' } as never], caseExecutions: [...(base.caseExecutions ?? []), { id: 'evt_bad', status: 'pass' } as never] });
    expect(polluted.scopes?.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(polluted.caseExecutions).toHaveLength(1);
  });
});

// ---- repository / configuration baseline -------------------------------------------------------

describe('repository and configuration baseline', () => {
  it('.gitignore keeps env files, dev vars, key material, backups and generated SBOMs out of Git, but not the example template', () => {
    const ignore = read('.gitignore');
    for (const pattern of ['.env', '.env.*', '!.env.example', '.dev.vars', '.dev.vars.*', '*.pem', '*.key', 'id_rsa*', '/backup/', 'docs/ganttchart-before-*.json', 'sbom.cdx.json']) expect(ignore, pattern).toContain(pattern);
  });

  it('no tracked file contains a recognisable secret (values are never printed)', () => {
    if (!existsSync(join(root, '.git'))) return; // an exported archive has no Git metadata
    let files: string[];
    try {
      files = execSync('git ls-files', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean);
    } catch {
      return;
    }
    const forbiddenFiles = files.filter((f) => /(^|\/)(\.env(\..+)?|\.dev\.vars(\..+)?|id_rsa.*|.*\.pem|.*\.p12|.*\.pfx)$/i.test(f) && !/\.example$/i.test(f));
    expect(forbiddenFiles).toEqual([]);
    const patterns: Array<[string, RegExp]> = [
      ['GitHub token', /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/],
      ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
      ['AWS access key', /AKIA[0-9A-Z]{16}/],
      ['Slack token', /xox[baprs]-[A-Za-z0-9-]{10,}/],
      ['JWT', /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/],
    ];
    const hits: string[] = [];
    for (const f of files) {
      if (/package-lock\.json$|\.(png|jpg|jpeg|webp|ico|woff2?)$/i.test(f)) continue;
      const text = readFileSync(join(root, f), 'utf8');
      for (const [label, re] of patterns) if (re.test(text)) hits.push(`${f}: ${label}`);
    }
    expect(hits).toEqual([]);
  });

  it('every required Worker secret is documented by NAME in the deployment plan and SECURITY.md, and no value is in wrangler config', () => {
    // Only the production section: the `env.dev` block holds fake local-development values on purpose.
    const wranglerFull = read('worker/wrangler.jsonc');
    const wrangler = wranglerFull.slice(0, wranglerFull.indexOf('"env"'));
    const required = /"secrets"\s*:\s*\{\s*"required"\s*:\s*\[([^\]]*)\]/.exec(wrangler)?.[1] ?? '';
    const names = [...required.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1] as string);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(read('docs/DEPLOYMENT_PLAN.md'), name).toContain(name);
      expect(read('SECURITY.md'), name).toContain(name);
      expect(wrangler, name).not.toMatch(new RegExp(`"${name}"\\s*:\\s*"[^"]+"`));
    }
    for (const f of ['jira-proxy/wrangler.toml', 'testrail-proxy/wrangler.toml']) expect(read(f)).not.toMatch(/(token|secret|password|api[_-]?key)\s*=/i);
  });

  it('static response headers keep CSP, nosniff, frame protection, referrer and permissions policies', () => {
    const headers = read('public/_headers');
    for (const h of ['Content-Security-Policy', 'X-Content-Type-Options: nosniff', 'X-Frame-Options: DENY', 'Referrer-Policy', 'Permissions-Policy']) expect(headers, h).toContain(h);
    for (const d of ["default-src 'self'", "script-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'none'"]) expect(headers, d).toContain(d);
    expect(headers).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);
    // connect-src is deliberately https: (an SV configures their own proxy); the reason is documented, not hidden.
    expect(headers).toContain("connect-src 'self' https:");
    expect(read('SECURITY.md')).toContain('connect-src');
  });

  it('CI installs deterministically, runs with least privilege, and the security workflows exist', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toMatch(/permissions:\s*\n\s+contents: read/);
    expect(ci).not.toMatch(/npm install\b/);
    expect((ci.match(/npm ci/g) ?? []).length).toBeGreaterThanOrEqual(2);
    for (const f of ['.github/workflows/sbom.yml', '.github/workflows/audit.yml']) expect(read(f)).not.toMatch(/npm install\b/);
    expect(existsSync(join(root, 'package-lock.json'))).toBe(true);
    expect(existsSync(join(root, 'worker/package-lock.json'))).toBe(true);
    expect(read('.github/workflows/codeql.yml')).toContain('github/codeql-action/analyze');
    expect(read('.github/workflows/codeql.yml')).toMatch(/schedule:/);
    expect(read('.github/workflows/dependency-review.yml')).toContain('actions/dependency-review-action');
    const dependabot = read('.github/dependabot.yml');
    for (const dir of ['directory: /\n', 'directory: /worker']) expect(dependabot, dir).toContain(dir);
    for (const f of ['ci.yml', 'codeql.yml', 'dependency-review.yml', 'audit.yml', 'sbom.yml']) expect(read(`.github/workflows/${f}`)).not.toContain('pull_request_target');
  });

  it('the README describes the product as it exists (no stale "no server / no accounts" claim) and the baseline documents exist', () => {
    const readme = read('README.md');
    expect(readme).not.toMatch(/no server, no cloud, no accounts/i);
    expect(readme).toMatch(/Shared workspace/);
    for (const f of ['SECURITY.md', 'CHANGELOG.md', 'docs/ARCHITECTURE.md', 'docs/SAAS_READINESS.md', 'docs/RECOVERY.md', 'docs/RELEASING.md', 'docs/BACKUP_FORMAT.md']) expect(existsSync(join(root, f)), f).toBe(true);
    const saas = read('docs/SAAS_READINESS.md');
    for (const category of ['Identity', 'Tenant model', 'Integration secrets', 'Billing', 'Organization / workspace', 'Security', 'Compliance', 'Observability', 'Reliability', 'Backups', 'Support', 'Deployment', 'Legal / IP', 'Product onboarding']) expect(saas, category).toContain(`### ${category}`);
    for (const p of ['**P0**', '**P1**', '**P2**', 'not legal advice']) expect(saas.toLowerCase(), p).toContain(p.toLowerCase());
  });

  it('the TestRail client builds the documented get_cases path in one place (no UI code builds API paths)', () => {
    const client = read('src/lib/testrail/client.ts');
    expect(client).toContain('get_cases/${project}');
    expect(client).not.toMatch(/get_cases\/\$\{suiteId\}/);
    for (const f of ['src/features/testManagement/TestRailCaseImportDialog.tsx', 'src/features/testManagement/TestRailScopeImportDialog.tsx']) {
      const text = read(f);
      expect(text).not.toMatch(/index\.php\?\/api|get_cases\/|get_suite\//);
      expect(text).toContain('getCasesForRun');
    }
  });

  it('a Worker error never returns exception text: the unhandled path answers with a code and the request id only', () => {
    const entry = read('worker/src/index.ts');
    const block = entry.slice(entry.indexOf("logEvent('error', 'unhandled'"), entry.indexOf('// Static assets are not API responses'));
    expect(block).toContain("code: 'internal_error'");
    expect(block).not.toMatch(/problem\(500,\s*(String\(error\)|error\.message|error\.stack)/);
    expect(entry).not.toMatch(/\.stack\b/);
  });
});

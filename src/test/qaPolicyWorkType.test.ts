import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEMO_STATE, normalizeQaInputs } from '../lib/storage/storage';
import { newProjectRecord } from '../domain/projects/lifecycle';
import { attentionItems, evaluateReleaseReadiness, type ReadinessInput, type ReleaseReadiness } from '../domain/readiness';
import { QA_DEFECT_SEVERITIES, QA_DEFECT_STATUSES, QA_WORK_TYPES, defaultQaPolicy, isDefaultQaPolicy, isQaWorkType, qaPolicyError, resolveQaPolicy, type QaPolicy } from '../../shared/qaPolicy';
import { checkScope } from '../../shared/testManagement';
import { editScope, newScope } from '../domain/testManagement';
import { workMixOfProject, workTypeOf } from '../domain/qaWork';
import { createProjectBackupPayload, importProjectIntoRegistry, parseProjectBackupPayload } from '../lib/backup/projectBackup';
import { createBackupPayload, parseBackupPayload } from '../lib/backup/backup';
import { defaultReportsState, normalizeReportsState } from '../lib/storage/reports';
import { ReadinessCard } from '../features/readiness/ReadinessCard';
import { WorkMixCard } from '../features/dashboard/WorkMixCard';
import { dictionaries } from '../i18n/dictionaries';
import { BUG_SEVERITIES, BUG_STATUSES, type BugTicket, type DailyExecutionEntry, type ProjectLifecycleStatus, type ProjectRecord, type QaInputs, type TestScope } from '../types';

const root = resolve(__dirname, '..');
const src = (rel: string): string => readFileSync(join(root, rel), 'utf8');
const dict = (lang: 'en' | 'ja'): Record<string, string> => dictionaries[lang] as Record<string, string>;
const NOW = '2026-10-01T00:00:00.000Z';
const TODAY = '2026-10-27';
const NOW_ISO = '2026-10-27T01:00:00.000Z';
const DAYS = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'];
const row = (date: string, n = 4) => ({ id: `r-${date}`, date, plannedTesters: n, absentTesters: 0, nonWorkingDay: false, note: '' });
const entry = (date: string, over: Partial<DailyExecutionEntry> = {}): DailyExecutionEntry => ({ id: `d-${date}`, date, startTime: 540, endTime: 1050, overtimeMinutes: 0, intervalEnabled: true, testers: 4, pass: 60, fail: 0, notApplicable: 0, spo: 0, blocked: 0, retest: 0, questioned: 0, note: '', ...over });
function project(over: Partial<QaInputs> = {}, status: ProjectLifecycleStatus = 'ongoing'): ProjectRecord {
  const inputs = normalizeQaInputs({ ...(DEMO_STATE as QaInputs), totalCases: 100, casesCompleted: 60, casesPassed: 60, currentTesters: 4, startDate: '2026-10-26', targetCompletionDate: '2026-10-30', targetCompletionTime: null, planningRows: DAYS.map((d) => row(d)), dailyExecuted: [entry('2026-10-26')], bugTickets: [], ...over });
  return { ...newProjectRecord(inputs, { nameEn: 'Alpha', status }, NOW, []), id: 'rec_1', projectId: 'PRJ-001' };
}
const assign = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `a${i}`, projectId: 'PRJ-001', memberId: `m${i}`, startDate: '2026-10-01', active: true }));
const ticket = (over: Partial<BugTicket> = {}): BugTicket => ({ id: 't1', projectId: 'PRJ-001', title: 'Crash', url: 'https://x.example/1', createdAt: '2026-10-20', reportedBy: 'Hana', ...over });
const run = (p: ProjectRecord, over: Partial<ReadinessInput> = {}): ReleaseReadiness => evaluateReleaseReadiness({ project: p, today: TODAY, nowIso: NOW_ISO, assignments: assign(4), ...over });
const codes = (r: ReleaseReadiness): string[] => r.reasons.map((x) => x.code);
const sev = (r: ReleaseReadiness, code: string) => r.reasons.find((x) => x.code === code)?.severity;
const policy = (over: Partial<QaPolicy>): QaPolicy => ({ ...defaultQaPolicy(), ...over });

describe('policy model', () => {
  it('has one canonical default that equals the original behavior, and is valid', () => {
    const d = defaultQaPolicy();
    expect(d).toEqual({ version: 1, blockingDefectSeverities: ['Critical'], unresolvedDefectStatuses: ['Open', 'In Progress'], defectsAction: 'blocked', blockedCases: 'atRisk', failedCases: 'atRisk', missingExecution: 'atRisk', staffingGap: 'whenScheduleAtRisk' });
    expect(qaPolicyError(d)).toBeNull();
    expect(isDefaultQaPolicy(d)).toBe(true);
    expect(isDefaultQaPolicy({ ...d, unresolvedDefectStatuses: ['In Progress', 'Open'] })).toBe(true); // order is not a difference
    expect(isDefaultQaPolicy(policy({ failedCases: 'blocked' }))).toBe(false);
    expect(defaultQaPolicy()).not.toBe(defaultQaPolicy()); // a fresh object each time (no shared mutable default)
  });

  it('is strictly validated: unknown keys, values, version, duplicates and size are rejected', () => {
    const d = defaultQaPolicy();
    const bad: unknown[] = [null, [], 'x', { ...d, extra: 1 }, { ...d, version: 2 }, { ...d, blockedCases: 'maybe' }, { ...d, failedCases: 'info' }, { ...d, staffingGap: 'never' }, { ...d, blockingDefectSeverities: ['Catastrophic'] }, { ...d, blockingDefectSeverities: ['Critical', 'Critical'] }, { ...d, unresolvedDefectStatuses: 'Open' }, { ...d, unresolvedDefectStatuses: ['Open', 'Nope'] }, { ...d, defectsAction: 'info' }, (() => { const { version: _v, ...rest } = d; return rest; })()];
    for (const b of bad) expect(qaPolicyError(b), JSON.stringify(b)).toBe('settings_invalid_qa_policy');
    expect(qaPolicyError(policy({ blockingDefectSeverities: [] }))).toBeNull();
  });

  it('a missing or damaged stored policy reads as the default', () => {
    expect(resolveQaPolicy(undefined)).toEqual(defaultQaPolicy());
    expect(resolveQaPolicy({ junk: true })).toEqual(defaultQaPolicy());
    expect(resolveQaPolicy(policy({ blockedCases: 'blocked' })).blockedCases).toBe('blocked');
  });

  it('names exactly the severities and statuses the Bug Tickets screen records', () => {
    expect([...QA_DEFECT_SEVERITIES]).toEqual([...BUG_SEVERITIES]);
    expect([...QA_DEFECT_STATUSES]).toEqual([...BUG_STATUSES]);
  });
});

describe('readiness with the default policy reproduces the original behavior', () => {
  const scenarios: Array<[string, ProjectRecord, 'ready' | 'atRisk' | 'blocked']> = [
    ['healthy', project(), 'ready'],
    ['critical open', project({ bugTickets: [ticket({ severity: 'Critical', status: 'Open' })] }), 'blocked'],
    ['critical in progress', project({ bugTickets: [ticket({ severity: 'Critical', status: 'In Progress' })] }), 'blocked'],
    ['critical resolved', project({ bugTickets: [ticket({ severity: 'Critical', status: 'Resolved' })] }), 'ready'],
    ['major open', project({ bugTickets: [ticket({ severity: 'Major', status: 'Open' })] }), 'ready'],
    ['critical no status', project({ bugTickets: [ticket({ severity: 'Critical' })] }), 'atRisk'],
    ['failed tests', project({ dailyExecuted: [entry('2026-10-26', { pass: 55, fail: 5 })] }), 'atRisk'],
    ['blocked cases', project({ dailyExecuted: [entry('2026-10-26', { blocked: 2 })] }), 'atRisk'],
    ['no execution', project({ dailyExecuted: [], casesCompleted: 0, casesPassed: 0 }), 'atRisk'],
    ['late forecast', project({ totalCases: 3000 }), 'atRisk'],
  ];
  for (const [name, p, expected] of scenarios) {
    it(`${name}: ${expected}, identical with no policy and with defaultQaPolicy()`, () => {
      const plain = run(p);
      expect(plain.state).toBe(expected);
      expect(run(p, { policy: defaultQaPolicy() })).toEqual(plain);
      expect(plain.policyCustom).toBe(false);
    });
  }
});

describe('a configured policy changes severity and state, never the reason code', () => {
  const critical = project({ bugTickets: [ticket({ severity: 'Critical', status: 'Open', ticketKey: 'ABC-1' })] });

  it('Critical + Open: Blocked by default, At Risk when the team chooses so - the ticket itself is untouched', () => {
    const before = JSON.stringify(critical);
    expect(run(critical).state).toBe('blocked');
    const soft = run(critical, { policy: policy({ defectsAction: 'atRisk' }) });
    expect(soft.state).toBe('atRisk');
    expect(codes(soft)).toContain('critical_defect_open');
    expect(sev(soft, 'critical_defect_open')).toBe('warning');
    expect(soft.policyCustom).toBe(true);
    expect(JSON.stringify(critical)).toBe(before);
  });

  it('the release-blocking severities and unresolved statuses are the team\'s', () => {
    const major = project({ bugTickets: [ticket({ severity: 'Major', status: 'Open' })] });
    expect(run(major, { policy: policy({ blockingDefectSeverities: ['Critical', 'Major'] }) }).state).toBe('blocked');
    const inProgress = project({ bugTickets: [ticket({ severity: 'Critical', status: 'In Progress' })] });
    expect(run(inProgress, { policy: policy({ unresolvedDefectStatuses: ['Open'] }) }).state).toBe('ready');
    expect(run(critical, { policy: policy({ blockingDefectSeverities: [] }) }).state).toBe('ready');
  });

  it('blocked cases: informational, At Risk (default) or Blocked', () => {
    const p = project({ dailyExecuted: [entry('2026-10-26', { blocked: 2 })] });
    expect(run(p).state).toBe('atRisk');
    expect(run(p, { policy: policy({ blockedCases: 'info' }) }).state).toBe('ready');
    const hard = run(p, { policy: policy({ blockedCases: 'blocked' }) });
    expect(hard.state).toBe('blocked');
    expect(sev(hard, 'blocked_cases_open')).toBe('blocking');
  });

  it('failed cases: At Risk (default) or Blocked', () => {
    const p = project({ dailyExecuted: [entry('2026-10-26', { pass: 55, fail: 5 })] });
    expect(run(p).state).toBe('atRisk');
    expect(run(p, { policy: policy({ failedCases: 'blocked' }) }).state).toBe('blocked');
  });

  it('missing execution evidence: At Risk (default) or informational', () => {
    const p = project({ dailyExecuted: [], casesCompleted: 0, casesPassed: 0 });
    expect(run(p).state).toBe('atRisk');
    const soft = run(p, { policy: policy({ missingExecution: 'info' }) });
    expect(soft.state).toBe('ready');
    expect(sev(soft, 'no_execution_data')).toBe('info');
  });

  it('staffing gap: only under schedule pressure (default), always, or never', () => {
    const healthy = project({ currentTesters: 8 });
    expect(sev(run(healthy, { assignments: assign(6) }), 'staffing_gap')).toBe('info');
    expect(run(healthy, { assignments: assign(6), policy: policy({ staffingGap: 'alwaysAtRisk' }) }).state).toBe('atRisk');
    const pressed = project({ currentTesters: 8, totalCases: 3000 });
    expect(sev(run(pressed, { assignments: assign(6) }), 'staffing_gap')).toBe('warning');
    expect(sev(run(pressed, { assignments: assign(6), policy: policy({ staffingGap: 'informational' }) }), 'staffing_gap')).toBe('info');
  });

  it("one team's policy never reaches another: the policy is an explicit input, with no global state", () => {
    const a = run(critical, { policy: policy({ defectsAction: 'atRisk' }) });
    const b = run(critical, { policy: defaultQaPolicy() });
    expect([a.state, b.state]).toEqual(['atRisk', 'blocked']);
    expect(src('domain/readiness.ts')).not.toMatch(/useReportsState|localStorage|settings\.qaPolicy|getState/);
  });
});

describe('explaining the policy', () => {
  const critical = project({ bugTickets: [ticket({ severity: 'Critical', status: 'Open', ticketKey: 'ABC-1' })] });
  for (const lang of ['en', 'ja'] as const) {
    it(`[${lang}] a policy-driven block says why, and the card names the policy`, () => {
      const html = renderToStaticMarkup(createElement(ReadinessCard, { lang, readiness: run(critical) }));
      expect(html).toContain(dict(lang)['readiness.policy.explain.defects']!.split('{')[0]!.slice(0, 8));
      expect(html).toContain('Critical');
      expect(html).toContain(dict(lang)['readiness.policy.default']);
      const custom = renderToStaticMarkup(createElement(ReadinessCard, { lang, readiness: run(critical, { policy: policy({ blockedCases: 'info' }) }) }));
      expect(custom).toContain(dict(lang)['readiness.policy.custom']);
    });
  }

  it('the supervisor gets next-step wording and a short attention list from the same reasons', () => {
    const r = run(project({ currentTesters: 8, dailyExecuted: [entry('2026-10-26')] }), { assignments: assign(6) });
    expect(attentionItems(r).map((x) => x.code)).toEqual(expect.arrayContaining(['no_execution_today', 'staffing_gap']));
    expect(dict('en')['readiness.reason.execution_incomplete']).toContain('required test(s) remain');
    expect(dict('en')['readiness.reason.staffing_gap_info']).toContain('not assigned');
  });
});

describe('QA work type', () => {
  const state = { scopes: [] as TestScope[] };
  const mk = (workType?: string) => newScope(state, { projectId: 'PRJ-001', name: `S ${workType ?? 'x'}`, ...(workType === undefined ? {} : { workType: workType as never }) }, NOW, `scp_${workType ?? 'none'}`);

  it('is a closed, extensible list and each built-in type is accepted by the scope model', () => {
    expect([...QA_WORK_TYPES]).toEqual(['regression', 'sanity', 'adhoc', 'verification']);
    for (const w of QA_WORK_TYPES) {
      const made = mk(w);
      expect(made.ok).toBe(true);
      if (made.ok) expect(checkScope(made.value).ok).toBe(true);
    }
  });

  it('rejects unknown types in the domain and in the shared (server) validator', () => {
    expect(mk('weekly')).toMatchObject({ ok: false, error: 'scope_invalid_work_type' });
    const ok = mk('regression');
    if (!ok.ok) throw new Error('x');
    expect(checkScope({ ...ok.value, workType: 'weekly' })).toMatchObject({ ok: false, error: 'scope_invalid_work_type' });
    expect(isQaWorkType('weekly')).toBe(false);
    expect(editScope({ scopes: [ok.value] }, ok.value.id, { workType: 'weekly' as never }, NOW)).toMatchObject({ ok: false });
  });

  it('older scopes without a type stay valid and read as unspecified (nothing is guessed from the name)', () => {
    const old: TestScope = { id: 'scp_old', projectId: 'PRJ-001', name: 'Regression suite', status: 'active', order: 10, createdAt: NOW, updatedAt: NOW };
    expect(checkScope(old).ok).toBe(true);
    expect(workTypeOf(old)).toBe('unspecified');
  });

  it('can be set, changed and cleared without touching anything else', () => {
    const a = mk('sanity');
    if (!a.ok) throw new Error('x');
    const changed = editScope({ scopes: [a.value] }, a.value.id, { workType: 'adhoc' }, NOW);
    expect(changed.ok && changed.value.workType).toBe('adhoc');
    const cleared = editScope({ scopes: [a.value] }, a.value.id, { workType: null }, NOW);
    expect(cleared.ok && cleared.value.workType).toBeUndefined();
    const kept = editScope({ scopes: [a.value] }, a.value.id, { name: 'Renamed' }, NOW);
    expect(kept.ok && kept.value.workType).toBe('sanity');
  });

  it('the work mix groups active scopes by type with units kept clear', () => {
    const scopes: TestScope[] = [
      { id: 'a', projectId: 'PRJ-001', name: 'A', status: 'active', order: 1, createdAt: NOW, updatedAt: NOW, workType: 'regression', totalTestCases: 420 },
      { id: 'b', projectId: 'PRJ-001', name: 'B', status: 'active', order: 2, createdAt: NOW, updatedAt: NOW, workType: 'sanity', totalTestCases: 65 },
      { id: 'c', projectId: 'PRJ-001', name: 'C', status: 'active', order: 3, createdAt: NOW, updatedAt: NOW, workType: 'verification' },
      { id: 'd', projectId: 'PRJ-001', name: 'D', status: 'active', order: 4, createdAt: NOW, updatedAt: NOW },
      { id: 'e', projectId: 'PRJ-002', name: 'E', status: 'active', order: 5, createdAt: NOW, updatedAt: NOW, workType: 'regression', totalTestCases: 999 },
      { id: 'f', projectId: 'PRJ-001', name: 'F', status: 'archived', order: 6, createdAt: NOW, updatedAt: NOW, workType: 'adhoc', totalTestCases: 5 },
    ];
    const cases = Array.from({ length: 18 }, (_, i) => ({ scopeId: 'c', status: 'active' as const, id: `c${i}` }));
    const mix = workMixOfProject('PRJ-001', scopes, cases);
    expect(mix.map((r) => [r.workType, r.scopes, r.cases])).toEqual([['regression', 1, 420], ['sanity', 1, 65], ['verification', 1, 18], ['unspecified', 1, 0]]);
    const html = renderToStaticMarkup(createElement(WorkMixCard, { lang: 'en', rows: mix }));
    expect(html).toContain('Regression');
    expect(html).toContain('420');
    expect(html).toContain(dict('en')['qa.workMix.verificationNote']);
    expect(renderToStaticMarkup(createElement(WorkMixCard, { lang: 'en', rows: [] }))).toContain(dict('en')['qa.workMix.empty']);
  });

  it('has EN and JA labels for every type', () => {
    for (const w of [...QA_WORK_TYPES, 'unspecified']) {
      expect(dict('en')[`qa.workType.${w}`], w).toBeTruthy();
      expect(dict('ja')[`qa.workType.${w}`], w).toBeTruthy();
    }
  });
});

describe('storage, backup and import', () => {
  it('a valid policy survives normalization and a full backup; a damaged one reads as the default', () => {
    const base = defaultReportsState();
    const custom = policy({ failedCases: 'blocked' });
    const kept = normalizeReportsState({ ...base, settings: { ...base.settings, qaPolicy: custom } });
    expect(kept.settings.qaPolicy).toEqual(custom);
    const dropped = normalizeReportsState({ ...base, settings: { ...base.settings, qaPolicy: { evil: true } as never } });
    expect(dropped.settings.qaPolicy).toBeUndefined();
    const file = createBackupPayload(DEMO_STATE, kept);
    const parsed = parseBackupPayload(JSON.stringify(file));
    expect(parsed.ok && parsed.data.reportsState.settings.qaPolicy).toEqual(custom);
  });

  it('an old backup without a policy loads with the default', () => {
    const base = defaultReportsState();
    const file = createBackupPayload(DEMO_STATE, base);
    const parsed = parseBackupPayload(JSON.stringify(file));
    expect(parsed.ok && resolveQaPolicy(parsed.data.reportsState.settings.qaPolicy)).toEqual(defaultQaPolicy());
  });

  const p = { ...project(), projectId: 'PRJ-001' };
  const scope = (workType?: string): TestScope => ({ id: 'scp_1', projectId: 'PRJ-001', name: 'S', status: 'active', order: 1, createdAt: NOW, updatedAt: NOW, ...(workType === undefined ? {} : { workType: workType as never }) });

  it('a project backup keeps each scope\'s work type through export, import and re-identification', () => {
    const payload = createProjectBackupPayload(p, [], NOW, { scopes: [scope('verification')], testCases: [], caseResults: [] });
    const parsed = parseProjectBackupPayload(JSON.stringify(payload));
    if (!parsed.ok) throw new Error('parse');
    expect(parsed.data.testManagement?.scopes[0]?.workType).toBe('verification');
    const imported = importProjectIntoRegistry([p], [], parsed.data);
    expect(imported.testManagement.scopes[0]?.workType).toBe('verification');
    expect(imported.testManagement.scopes[0]?.projectId).not.toBe('PRJ-001');
  });

  it('a backup file with an unknown work type drops that scope instead of accepting it; an untyped scope loads', () => {
    const payload = createProjectBackupPayload(p, [], NOW, { scopes: [scope(), { ...scope(), id: 'scp_2' }], testCases: [], caseResults: [] });
    (payload.data.testManagement as { scopes: unknown[] }).scopes[1] = { ...scope(), id: 'scp_2', workType: 'weekly' };
    const parsed = parseProjectBackupPayload(JSON.stringify(payload));
    if (!parsed.ok) throw new Error('parse');
    expect(parsed.data.testManagement?.scopes.map((s) => s.id)).toEqual(['scp_1']);
  });
});

describe('where things live', () => {
  it('the Settings screen offers QA Policy to the SV only (Settings has no Tester access) and the card writes through updateSettings', () => {
    expect(src('features/settings/Settings.tsx')).toContain('<QaPolicySettings />');
    expect(src('app/access.ts')).toMatch(/settings: \{ sv: 'manage', tester: 'none' \}/);
    expect(src('features/settings/QaPolicySettings.tsx')).toContain('reports.updateSettings({');
  });

  it('readiness reads the policy from the workspace settings through the one hook', () => {
    expect(src('features/readiness/useReadiness.ts')).toContain('policy: resolveQaPolicy(state.settings.qaPolicy)');
  });

  it('no company or team names leak into the domain types', () => {
    for (const f of ['../shared/qaPolicy.ts', 'domain/qaWork.ts', 'domain/readiness.ts']) expect(src(f)).not.toMatch(/Rakuten|DeliveryTeam|DeliverySV|FeatureTeam|UATTeam/);
  });

  it('all new strings exist in both languages', () => {
    for (const k of Object.keys(dict('en')).filter((x) => /^(settings\.qaPolicy|qa\.(workType|workMix)|readiness\.(policy|attention))/.test(x))) expect(dict('ja')[k], k).toBeTruthy();
  });
});

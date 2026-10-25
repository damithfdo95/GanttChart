import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEMO_STATE, isDailyExecutionEntry, normalizeQaInputs } from '../lib/storage/storage';
import { executionHistorySheet } from '../lib/export/exportData';
import { executionProvenanceError } from '../../shared/qaRules';
import {
  cleanSourceRef,
  decideImport,
  decideManualSave,
  detailedExecutionSummary,
  executionFiguresChanged,
  executionSourceLabelKey,
  executionSourceOf,
  normalizeEntryProvenance,
  requiresExecutionSourceConfirmation,
  withExecutionProvenance,
  type ExecutionSource,
} from '../domain/executionSource';
import { ExecutionSourceBar } from '../components/DailyExecutionForm';
import { dictionaries } from '../i18n/dictionaries';
import type { CaseResult, DailyActualSnapshot, DailyExecutionEntry, ProjectRecord, QaInputs, TestCase, TestScope } from '../types';
import { newProjectRecord } from '../domain/projects/lifecycle';

const root = resolve(__dirname, '..');
const src = (rel: string): string => readFileSync(join(root, rel), 'utf8');
const dict = (lang: 'en' | 'ja'): Record<string, string> => dictionaries[lang] as Record<string, string>;
const NOW = '2026-10-08T01:42:00.000Z';
const LATER = '2026-10-08T02:10:00.000Z';

const entry = (over: Partial<DailyExecutionEntry> = {}): DailyExecutionEntry => ({
  id: 'e1', date: '2026-10-08', startTime: 540, endTime: 1050, overtimeMinutes: 0, intervalEnabled: true, testers: 6,
  pass: 40, fail: 5, notApplicable: 1, spo: 2, blocked: 0, retest: 0, questioned: 0, note: '', ...over,
});
const fromTestRail = entry({ source: 'testrail', sourceUpdatedAt: NOW, sourceRef: { provider: 'testrail', runId: 9001 } });
const manual = entry({ source: 'manual', sourceUpdatedAt: NOW });

describe('legacy entries (no provenance)', () => {
  it('load, read as manual and export correctly', () => {
    const legacy = entry();
    expect(isDailyExecutionEntry(legacy)).toBe(true);
    const state = normalizeQaInputs({ ...(DEMO_STATE as QaInputs), dailyExecuted: [legacy] });
    expect(state.dailyExecuted?.[0]).toEqual(legacy);
    expect(executionSourceOf(legacy)).toBe('manual');
    const snap: DailyActualSnapshot = { id: 's', date: legacy.date, executed: 48, passed: 40 };
    const sheet = executionHistorySheet('en', [snap], 100, [legacy]);
    expect(sheet.headers.slice(-2)).toEqual(['Execution Source', 'Source Updated At']);
    expect(sheet.rows[0].slice(-2)).toEqual(['Manual', '—']);
  });
});

describe('manual save', () => {
  it('stamps manual provenance, updates the timestamp and keeps the counts', () => {
    const d = decideManualSave(null, entry(), NOW);
    expect(d.needsConfirmation).toBe(false);
    expect(d.entry).toMatchObject({ source: 'manual', sourceUpdatedAt: NOW, pass: 40, fail: 5, spo: 2, testers: 6 });
    const again = decideManualSave(manual, entry({ pass: 41 }), LATER);
    expect(again.needsConfirmation).toBe(false);
    expect(again.entry).toMatchObject({ source: 'manual', sourceUpdatedAt: LATER, pass: 41 });
  });

  it('a legacy (source-less) entry is manual: saving it needs no confirmation', () => {
    expect(decideManualSave(entry(), entry({ pass: 50 }), LATER).needsConfirmation).toBe(false);
  });
});

describe('TestRail provenance', () => {
  it('an import stamps source, time and the run/plan reference, and stores no credential', () => {
    const e = withExecutionProvenance(entry(), 'testrail', NOW, { provider: 'testrail', runId: 9001 });
    expect(e).toMatchObject({ source: 'testrail', sourceUpdatedAt: NOW, sourceRef: { provider: 'testrail', runId: 9001 } });
    const dirty = cleanSourceRef({ provider: 'testrail', planId: 5, apiKey: 'secret', url: 'https://x' } as never);
    expect(dirty).toEqual({ provider: 'testrail', planId: 5 });
    expect(JSON.stringify(withExecutionProvenance(entry(), 'testrail', NOW, { provider: 'testrail', planId: 5, token: 'x' } as never))).not.toMatch(/secret|token|apiKey/);
  });

  it('the dashboard import path is stamped TestRail in one place', () => {
    const form = src('components/DailyExecutionForm.tsx');
    const body = form.slice(form.indexOf('const commitTestRailDay'), form.indexOf('const runTestrailFetch'));
    expect(body).toContain("'testrail'");
    expect(body).toContain('withExecutionProvenance(');
    expect(form).toContain("decideImport(existing, 'testrail')");
  });
});

describe('source replacement', () => {
  const all: ExecutionSource[] = ['manual', 'testrail', 'caseExecution'];
  it('same-source refresh is free; every other pair needs confirmation', () => {
    for (const from of all) for (const to of all) expect(requiresExecutionSourceConfirmation(from, to)).toBe(from !== to);
  });

  it('TestRail -> manual: confirmation required; the decision never mutates the stored entry', () => {
    const before = JSON.stringify(fromTestRail);
    const d = decideManualSave(fromTestRail, entry({ pass: 99, source: 'testrail' }), LATER);
    expect(d.needsConfirmation).toBe(true);
    expect(d.replaces).toBe('testrail');
    expect(JSON.stringify(fromTestRail)).toBe(before); // cancel = nothing is written
    expect(d.entry).toMatchObject({ source: 'manual', sourceUpdatedAt: LATER, pass: 99 }); // confirm writes this
    expect(d.entry.sourceRef).toBeUndefined();
  });

  it('TestRail entry: window / note / tester edits keep TestRail provenance without a prompt', () => {
    const d = decideManualSave(fromTestRail, { ...fromTestRail, endTime: 1100, note: 'late', testers: 7 }, LATER);
    expect(d.needsConfirmation).toBe(false);
    expect(d.entry).toMatchObject({ source: 'testrail', sourceUpdatedAt: NOW, sourceRef: { runId: 9001 }, endTime: 1100 });
    expect(executionFiguresChanged(fromTestRail, { ...fromTestRail, testers: 9 })).toBe(false);
  });

  it('manual -> TestRail import: confirmation required; TestRail -> TestRail refresh: none; empty day: none', () => {
    expect(decideImport(manual, 'testrail')).toEqual({ needsConfirmation: true, replaces: 'manual' });
    expect(decideImport(entry(), 'testrail').needsConfirmation).toBe(true); // legacy = manual
    expect(decideImport(fromTestRail, 'testrail')).toEqual({ needsConfirmation: false, replaces: null });
    expect(decideImport(null, 'testrail').needsConfirmation).toBe(false);
  });

  it('the form holds a pending replacement until confirmed and clears it on cancel', () => {
    const form = src('components/DailyExecutionForm.tsx');
    expect(form).toContain('setPending({ replaces: decision.replaces');
    expect(form).toContain('onClick={() => setPending(null)}');
    expect(form).toContain('onClick={confirmPending}');
    expect(form).toContain('useEffect(() => setPending(null), [date])');
  });
});

describe('validation and compatibility', () => {
  it('invalid provenance is dropped, the day is kept', () => {
    const bad = { ...entry(), source: 'excel', sourceUpdatedAt: 'not a date', sourceRef: { provider: 'testrail', runId: 7, apiKey: 'k' } } as unknown as DailyExecutionEntry;
    const state = normalizeQaInputs({ ...(DEMO_STATE as QaInputs), dailyExecuted: [bad] });
    const kept = state.dailyExecuted?.[0] as unknown as Record<string, unknown>;
    expect(kept.id).toBe('e1');
    expect(kept.pass).toBe(40);
    expect(kept.source).toBeUndefined();
    expect(kept.sourceUpdatedAt).toBeUndefined();
    expect(kept.sourceRef).toBeUndefined();
    expect(normalizeEntryProvenance(fromTestRail)).toBe(fromTestRail);
  });

  it('the shared check accepts valid provenance and rejects unknown sources and foreign ref keys', () => {
    expect(executionProvenanceError(fromTestRail as unknown as Record<string, unknown>)).toBeNull();
    expect(executionProvenanceError({})).toBeNull();
    expect(executionProvenanceError({ source: 'excel' })).toBe('execution_entry_invalid_source');
    expect(executionProvenanceError({ sourceRef: { provider: 'testrail', apiKey: 'x' } })).toBe('execution_entry_invalid_sourceRef');
    expect(executionProvenanceError({ sourceRef: { provider: 'jira' } })).toBe('execution_entry_invalid_sourceRef');
    expect(executionProvenanceError({ sourceRef: { provider: 'testrail', runId: -1 } })).toBe('execution_entry_invalid_sourceRef');
  });
});

describe('attribution and case sync stay independent of the daily aggregate', () => {
  const writes = /saveDailyExecutionEntry|applyDailyExecutionEntry|upsertDailyExecutionEntry|updateField\(\s*'dailyExecuted'/;
  it('per-tester Performance code never writes the Daily Execution', () => {
    for (const f of ['features/performance/PerformanceTab.tsx', 'features/performance/TesterDayRecordForm.tsx', 'lib/calculations/testerAttribution.ts', 'lib/calculations/testerPerformance.ts']) expect(src(f)).not.toMatch(writes);
  });

  it('the Execution-tab TestRail case sync never writes the Daily Execution or its source', () => {
    for (const f of ['features/testManagement/ExecutionTab.tsx', 'domain/testManagement/testrailResults.ts']) expect(src(f)).not.toMatch(/saveDailyExecutionEntry|applyDailyExecutionEntry|upsertDailyExecutionEntry|dailyExecuted|withExecutionProvenance/);
  });

  it('the mismatch is worded as attribution, not corruption (EN/JA)', () => {
    expect(dict('en')['performance.consistencyMismatch']).toMatch(/Attribution mismatch/);
    expect(dict('en')['performance.consistencyMismatch']).toMatch(/informational/);
    expect(dict('ja')['performance.consistencyMismatch']).toMatch(/帰属の不一致/);
  });
});

describe('detailed case summary', () => {
  const NOWI = NOW;
  const project: ProjectRecord = { ...newProjectRecord(normalizeQaInputs({ ...(DEMO_STATE as QaInputs), totalCases: 420 }), { nameEn: 'P', status: 'ongoing' }, NOWI, []), projectId: 'PRJ-001' };
  const scope: TestScope = { id: 's1', projectId: 'PRJ-001', name: 's', status: 'active', order: 1, createdAt: NOWI, updatedAt: NOWI, totalTestCases: 420 };
  const tc = (id: string): TestCase => ({ id, projectId: 'PRJ-001', scopeId: 's1', key: id.toUpperCase(), title: id, priority: 'medium', status: 'active', order: 1, createdAt: NOWI, updatedAt: NOWI });
  const res = (id: string, status: CaseResult['status']): CaseResult => ({ id: `res_${id}`, projectId: 'PRJ-001', scopeId: 's1', testCaseId: id, status, retest: false, question: false, updatedByUserId: null, updatedAt: NOWI });

  it('reports registered vs executed beside the scope total, never as full-project progress', () => {
    const s = detailedExecutionSummary(project, [scope], [tc('a'), tc('b'), tc('c')], [res('a', 'pass'), res('b', 'fail'), res('c', 'inProgress')]);
    expect(s).toEqual({ registered: 3, executed: 2, scopeTotal: 420 });
  });

  it('case results keep only their latest execution time, so no date-based daily aggregate is derived', () => {
    expect(src('domain/executionSource.ts')).not.toMatch(/executedAt/);
    expect(src('components/DailyExecutionForm.tsx')).not.toMatch(/caseExecution'\s*\)/);
  });
});

describe('source bar and history', () => {
  for (const lang of ['en', 'ja'] as const) {
    it(`[${lang}] shows source, run and last-synced; a legacy day reads Manual; no entry says so`, () => {
      const html = renderToStaticMarkup(createElement(ExecutionSourceBar, { lang, entry: fromTestRail, detailed: { registered: 184, executed: 150, scopeTotal: 420 } }));
      expect(html).toContain(dict(lang)['exec.source.label']);
      expect(html).toContain(dict(lang)[executionSourceLabelKey('testrail')]);
      expect(html).toContain('9001');
      expect(html).toContain(dict(lang)['exec.source.lastSynced']);
      expect(html).toContain('184');
      expect(html).toContain('420');
      expect(renderToStaticMarkup(createElement(ExecutionSourceBar, { lang, entry: entry(), detailed: null }))).toContain(dict(lang)['exec.source.manual']);
      expect(renderToStaticMarkup(createElement(ExecutionSourceBar, { lang, entry: null, detailed: null }))).toContain(dict(lang)['exec.source.noEntry']);
    });
  }

  it('the history table has a Source column', () => {
    const panel = src('components/DailyProgressPanel.tsx');
    expect(panel).toContain("t(lang, 'exec.source.column')");
    expect(panel).toContain('executionSourceOf(entry)');
  });
});

describe('export', () => {
  const snap: DailyActualSnapshot = { id: 's', date: '2026-10-08', executed: 48, passed: 40 };
  for (const lang of ['en', 'ja'] as const) {
    it(`[${lang}] exports the Execution Source and its update time`, () => {
      const sheet = executionHistorySheet(lang, [snap], 100, [fromTestRail]);
      expect(sheet.headers.slice(-2)).toEqual([dict(lang)['exec.source.exportSource'], dict(lang)['exec.source.exportUpdatedAt']]);
      expect(sheet.rows[0].slice(-2)).toEqual([dict(lang)['exec.source.testrail'], NOW]);
    });
  }
});

describe('EN/JA strings', () => {
  it('every new source and confirmation string exists in both languages', () => {
    const keys = ['exec.source.label', 'exec.source.manual', 'exec.source.testrail', 'exec.source.caseExecution', 'exec.source.noEntry', 'exec.source.run', 'exec.source.plan', 'exec.source.lastUpdated', 'exec.source.lastSynced', 'exec.source.detailed', 'exec.source.detailedHint', 'exec.source.column', 'exec.source.exportSource', 'exec.source.exportUpdatedAt', 'exec.sourceConfirmTitle', 'exec.sourceConfirmBody', 'exec.sourceConfirmOk', 'exec.sourceConfirmCancel', 'tm.analysis.viewOnly'];
    for (const k of keys) {
      expect(dict('en')[k], k).toBeTruthy();
      expect(dict('ja')[k], k).toBeTruthy();
    }
    expect(dict('en')['tm.testrailProgress.updatedAt']).toMatch(/Live TestRail status/);
    expect(dict('en')['tm.execSync.help']).toMatch(/daily execution figures are not changed/);
  });

  it('the Analysis tab states it is view only', () => {
    expect(src('features/testManagement/AnalysisTab.tsx')).toContain("tm.analysis.viewOnly");
  });
});

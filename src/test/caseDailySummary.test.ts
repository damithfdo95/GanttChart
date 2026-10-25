import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEMO_STATE, normalizeQaInputs } from '../lib/storage/storage';
import { newProjectRecord } from '../domain/projects/lifecycle';
import { compareDailyExecution, dailyDetailedSummary, type CaseExecutionEvent, type CaseStatus, type TestCase, type TestScope } from '../domain/testManagement';
import { detailedDailyExecutionSheet } from '../lib/export/exportData';
import { DetailedExecutionCard } from '../features/dashboard/DetailedExecutionCard';
import { dictionaries } from '../i18n/dictionaries';
import type { DailyExecutionEntry, QaInputs } from '../types';

const root = resolve(__dirname, '..');
const src = (rel: string): string => readFileSync(join(root, rel), 'utf8');
const dict = (lang: 'en' | 'ja'): Record<string, string> => dictionaries[lang] as Record<string, string>;
const NOW = '2026-10-01T00:00:00.000Z';
const P = 'PRJ-001';

const scope = (id: string, total?: number, over: Partial<TestScope> = {}): TestScope => ({ id, projectId: P, name: id, status: 'active', order: 10, createdAt: NOW, updatedAt: NOW, ...(total === undefined ? {} : { totalTestCases: total }), ...over });
const tcase = (id: string, scopeId = 'scp_a', over: Partial<TestCase> = {}): TestCase => ({ id, projectId: P, scopeId, key: id.toUpperCase(), title: id, priority: 'medium', status: 'active', order: 1, createdAt: NOW, updatedAt: NOW, ...over });
let n = 0;
// 2026-10-25 in Tokyo starts at 2026-10-24T15:00Z; helper takes a JST clock time.
const jst = (date: string, hhmm: string): string => new Date(`${date}T${hhmm}:00+09:00`).toISOString();
const ev = (testCaseId: string, status: CaseStatus, date: string, hhmm: string, over: Partial<CaseExecutionEvent> = {}): CaseExecutionEvent => ({ id: `evt_${(n += 1)}`, projectId: P, scopeId: 'scp_a', testCaseId, status, executedAt: jst(date, hhmm), source: 'manual', ...over });
const sum = (events: CaseExecutionEvent[], date: string, over: Record<string, unknown> = {}) =>
  dailyDetailedSummary({ date, projectId: P, scopes: [scope('scp_a', 420)], cases: [tcase('a'), tcase('b'), tcase('c')], events, ...over });

describe('daily summary from history', () => {
  it('one case, three events: events 3, unique 1, Pass 1, Fail 0 (latest event wins)', () => {
    const s = sum([ev('a', 'fail', '2026-10-25', '09:00'), ev('a', 'inProgress', '2026-10-25', '11:00', { retest: true }), ev('a', 'pass', '2026-10-25', '15:00')], '2026-10-25');
    expect(s).toMatchObject({ eventCount: 3, uniqueCasesExecuted: 1, passed: 1, failed: 0, inProgress: 0 });
  });

  it('several cases: unique 3, one each of Pass / Blocked / Fail; statuses add up to unique cases, not events', () => {
    const s = sum([ev('a', 'pass', '2026-10-25', '09:00'), ev('b', 'blocked', '2026-10-25', '10:00'), ev('c', 'fail', '2026-10-25', '11:00'), ev('c', 'fail', '2026-10-25', '12:00')], '2026-10-25');
    expect(s).toMatchObject({ uniqueCasesExecuted: 3, passed: 1, blocked: 1, failed: 1, eventCount: 4 });
    expect(s.passed + s.failed + s.blocked + s.inProgress + s.na + s.spo).toBe(s.uniqueCasesExecuted);
  });

  it('cross-day: Oct 24 stays Fail after a Pass on Oct 25 (historical summaries are stable)', () => {
    const events = [ev('a', 'fail', '2026-10-24', '10:00'), ev('a', 'pass', '2026-10-25', '10:00')];
    expect(sum(events, '2026-10-24')).toMatchObject({ failed: 1, passed: 0, uniqueCasesExecuted: 1 });
    expect(sum(events, '2026-10-25')).toMatchObject({ failed: 0, passed: 1, uniqueCasesExecuted: 1 });
  });

  it('is rebuilt from events only: the current CaseResult is not an input (and cannot rewrite the past)', () => {
    const body = src('domain/testManagement/executionHistory.ts');
    const fn = body.slice(body.indexOf('export function dailyDetailedSummary'), body.indexOf('export interface ComparedMetric'));
    expect(fn).not.toMatch(/caseResults|resultsByCase|byCase|CaseResult/);
    // even with a Pass "now", an Oct 24 history that ended Fail reads Fail
    expect(sum([ev('a', 'fail', '2026-10-24', '10:00')], '2026-10-24').failed).toBe(1);
  });

  it('a case reset to Not Started that day is not counted as executed (Phase 4 rule)', () => {
    const s = sum([ev('a', 'pass', '2026-10-25', '09:00'), ev('a', 'notStarted', '2026-10-25', '10:00')], '2026-10-25');
    expect(s).toMatchObject({ eventCount: 2, uniqueCasesExecuted: 0, passed: 0 });
  });

  it('the business day is Tokyo: 00:30 JST is the next date', () => {
    const e = ev('a', 'pass', '2026-10-26', '00:30');
    expect(sum([e], '2026-10-25').eventCount).toBe(0);
    expect(sum([e], '2026-10-26').eventCount).toBe(1);
  });

  it('event-based source breakdown, kept apart from unique cases', () => {
    const events = [ev('a', 'fail', '2026-10-25', '09:00'), ev('a', 'pass', '2026-10-25', '10:00', { source: 'testrail' }), ev('b', 'pass', '2026-10-25', '11:00', { source: 'testrail' })];
    const s = sum(events, '2026-10-25');
    expect(s).toMatchObject({ manualEvents: 1, testrailEvents: 2, uniqueCasesExecuted: 2 });
    expect(s.manualEvents + s.testrailEvents).toBe(s.eventCount);
  });

  it('manual check scenario: A Fail->Pass, B Blocked, C Pass = 4 events, 3 cases, Pass 2, Blocked 1; saved 4 differs by 1', () => {
    const s = sum([ev('a', 'fail', '2026-10-25', '09:00'), ev('a', 'pass', '2026-10-25', '10:00'), ev('b', 'blocked', '2026-10-25', '11:00'), ev('c', 'pass', '2026-10-25', '12:00')], '2026-10-25');
    expect(s).toMatchObject({ eventCount: 4, uniqueCasesExecuted: 3, passed: 2, blocked: 1 });
    const cmp = compareDailyExecution({ savedDaily: { pass: 4, fail: 0, notApplicable: 0, spo: 0, blocked: 0 }, caseDerived: s });
    expect(cmp.executed).toMatchObject({ saved: 4, detailed: 3, difference: 1 });
    expect(cmp.relation).toBe('savedHigher');
  });
});

describe('project vs scope, coverage', () => {
  it('a project summary aggregates scopes by case id without double counting; a scope summary is limited to its scope', () => {
    const scopes = [scope('scp_a', 100), scope('scp_b', 50)];
    const cases = [tcase('a'), tcase('b', 'scp_b'), tcase('c', 'scp_b')];
    const events = [ev('a', 'pass', '2026-10-25', '09:00'), ev('b', 'fail', '2026-10-25', '09:30', { scopeId: 'scp_b' }), ev('b', 'pass', '2026-10-25', '10:30', { scopeId: 'scp_b' })];
    const project = dailyDetailedSummary({ date: '2026-10-25', projectId: P, scopes, cases, events });
    expect(project).toMatchObject({ uniqueCasesExecuted: 2, eventCount: 3, registeredCases: 3, scopeTotalCases: 150 });
    const b = dailyDetailedSummary({ date: '2026-10-25', projectId: P, scopeId: 'scp_b', scopes, cases, events });
    expect(b).toMatchObject({ uniqueCasesExecuted: 1, eventCount: 2, registeredCases: 2, scopeTotalCases: 50, passed: 1 });
  });

  it('scope total, registered cases and executed cases stay three different numbers (420 / 184 / 150)', () => {
    const cases = Array.from({ length: 184 }, (_, i) => tcase(`c${i}`));
    const events = cases.slice(0, 150).map((c) => ev(c.id, 'pass', '2026-10-25', '10:00'));
    const s = dailyDetailedSummary({ date: '2026-10-25', projectId: P, scopes: [scope('scp_a', 420)], cases, events });
    expect(s).toMatchObject({ scopeTotalCases: 420, registeredCases: 184, uniqueCasesExecuted: 150, executedRegisteredCases: 150, casesWithHistory: 150 });
    expect(s.coverage.registeredVsScope).toBeCloseTo(184 / 420);
    expect(s.coverage.executedVsRegistered).toBeCloseTo(150 / 184);
    expect(s.coverage.executedVsRegistered).not.toBeCloseTo(150 / 420);
  });

  it('with no scope totals the project fallback total is used; with no registered cases coverage is null, never 100%', () => {
    expect(sum([], '2026-10-25', { scopes: [scope('scp_a')], fallbackTotal: 99 }).scopeTotalCases).toBe(99);
    const none = dailyDetailedSummary({ date: '2026-10-25', projectId: P, scopes: [scope('scp_a', 10)], cases: [], events: [] });
    expect(none).toMatchObject({ registeredCases: 0, uniqueCasesExecuted: 0, eventCount: 0, firstEventDate: null });
    expect(none.coverage.executedVsRegistered).toBeNull();
  });

  it('a Tester only gets what their visible scopes hold - another scope is never aggregated in', () => {
    const scopes = [scope('scp_a', 10), scope('scp_b', 10)];
    const cases = [tcase('a'), tcase('b', 'scp_b')];
    const events = [ev('a', 'pass', '2026-10-25', '09:00'), ev('b', 'fail', '2026-10-25', '09:00', { scopeId: 'scp_b' })];
    const s = dailyDetailedSummary({ date: '2026-10-25', projectId: P, scopes, cases, events, visibleScopeIds: new Set(['scp_a']) });
    expect(s).toMatchObject({ eventCount: 1, uniqueCasesExecuted: 1, registeredCases: 1, scopeTotalCases: 10, failed: 0 });
  });

  it('knows where the recorded history begins', () => {
    const s = sum([ev('a', 'pass', '2026-10-24', '09:00'), ev('a', 'pass', '2026-10-25', '09:00')], '2026-10-25');
    expect(s.firstEventDate).toBe('2026-10-24');
  });
});

describe('comparison with the saved daily aggregate', () => {
  const big = (): CaseExecutionEvent[] => {
    const events: CaseExecutionEvent[] = [];
    for (let i = 0; i < 164; i += 1) events.push(ev(`c${i}`, i < 132 ? 'pass' : i < 146 ? 'fail' : i < 154 ? 'blocked' : 'inProgress', '2026-10-25', '10:00', { source: i < 90 ? 'manual' : 'testrail' }));
    for (let i = 0; i < 34; i += 1) events.push(ev(`c${i}`, 'pass', '2026-10-25', '14:00', { source: 'testrail' }));
    return events;
  };

  it('198 events over 164 cases (90 manual first events, 108 TestRail events): the saved 170 is 6 higher', () => {
    const cases = Array.from({ length: 184 }, (_, i) => tcase(`c${i}`));
    const s = dailyDetailedSummary({ date: '2026-10-25', projectId: P, scopes: [scope('scp_a', 420)], cases, events: big() });
    expect(s).toMatchObject({ eventCount: 198, uniqueCasesExecuted: 164, manualEvents: 90, testrailEvents: 108 });
    const cmp = compareDailyExecution({ savedDaily: { pass: 150, fail: 10, notApplicable: 5, spo: 5, blocked: 3 }, caseDerived: s });
    expect(cmp.executed).toMatchObject({ saved: 170, detailed: 164, difference: 6, comparable: true });
    expect(cmp.inProgress).toMatchObject({ comparable: false, saved: null, difference: null });
    expect(cmp.notComparable).toContain('retest');
    expect(cmp.hasSaved && cmp.hasDetailed).toBe(true);
  });

  it('no history or no saved day: null-safe, nothing is invented', () => {
    const empty = compareDailyExecution({ savedDaily: { pass: 5, fail: 0, notApplicable: 0, spo: 0, blocked: 0 }, caseDerived: sum([], '2026-10-25') });
    expect(empty).toMatchObject({ hasSaved: true, hasDetailed: false, relation: 'unknown' });
    expect(empty.executed.difference).toBeNull();
    const noSaved = compareDailyExecution({ savedDaily: null, caseDerived: sum([ev('a', 'pass', '2026-10-25', '09:00')], '2026-10-25') });
    expect(noSaved).toMatchObject({ hasSaved: false, hasDetailed: true, relation: 'unknown' });
  });

  it('the derivation never writes; the card can only hand a confirmed entry to onAdopt (Phase 6)', () => {
    const writes = /saveDailyExecutionEntry|applyDailyExecutionEntry|upsertDailyExecutionEntry|updateField\(|withExecutionProvenance/;
    expect(src('domain/testManagement/executionHistory.ts')).not.toMatch(/saveDailyExecutionEntry|applyDailyExecutionEntry|upsertDailyExecutionEntry/);
    expect(src('features/dashboard/DetailedExecutionCard.tsx')).not.toMatch(writes);
    const dash = src('features/dashboard/Dashboard.tsx');
    const block = dash.slice(dash.indexOf('const detailedEvents'), dash.indexOf('const blockedReason'));
    expect(block).not.toMatch(/updateField\(|applyDailyExecutionEntry/);
  });
});

describe('cards, empty states and wording', () => {
  const entry = (over: Partial<DailyExecutionEntry> = {}): DailyExecutionEntry => ({ id: 'e1', date: '2026-10-25', startTime: 540, endTime: 1050, overtimeMinutes: 0, intervalEnabled: true, testers: 5, pass: 170, fail: 0, notApplicable: 0, spo: 0, blocked: 0, retest: 0, questioned: 0, note: '', source: 'testrail', ...over });
  const cases = Array.from({ length: 184 }, (_, i) => tcase(`c${i}`));
  const events = cases.slice(0, 150).map((c) => ev(c.id, 'pass', '2026-10-25', '10:00'));
  const summary = dailyDetailedSummary({ date: '2026-10-25', projectId: P, scopes: [scope('scp_a', 420)], cases, events });

  for (const lang of ['en', 'ja'] as const) {
    it(`[${lang}] shows events and unique cases separately, coverage in registered terms, the saved source, and the difference`, () => {
      const saved = entry();
      const html = renderToStaticMarkup(createElement(DetailedExecutionCard, { lang, summary, saved, comparison: compareDailyExecution({ savedDaily: saved, caseDerived: summary }) }));
      for (const k of ['exec.detail.title', 'exec.detail.derived', 'exec.detail.unique', 'exec.detail.events', 'exec.detail.registered', 'exec.detail.scopeTotal', 'exec.detail.savedTitle', 'exec.detail.diffTitle', 'exec.source.testrail']) {
        expect(html).toContain(dict(lang)[k]?.replace(/'/g, '&#x27;') ?? '');
      }
      expect(html).toContain('150');
      expect(html).toContain('184');
      expect(html).toContain('420');
      expect(html).not.toMatch(/150 \/ 420/);
    });

    it(`[${lang}] empty states`, () => {
      const noHistory = dailyDetailedSummary({ date: '2026-10-25', projectId: P, scopes: [scope('scp_a', 420)], cases, events: [] });
      const a = renderToStaticMarkup(createElement(DetailedExecutionCard, { lang, summary: noHistory }));
      expect(a).toContain(dict(lang)['exec.detail.empty']);
      expect(a).toContain(dict(lang)['exec.detail.partialNone']);
      const noCases = dailyDetailedSummary({ date: '2026-10-25', projectId: P, scopes: [scope('scp_a', 420)], cases: [], events: [] });
      expect(renderToStaticMarkup(createElement(DetailedExecutionCard, { lang, summary: noCases }))).toContain(dict(lang)['exec.detail.noCases']);
    });
  }

  it('the English wording separates events from cases and never says "150 / 420"', () => {
    expect(dict('en')['exec.detail.events']).toBe('Execution Events');
    expect(dict('en')['exec.detail.unique']).toBe('Unique Cases Executed');
    expect(dict('en')['exec.detail.coverageRegistered']).toBe('Detailed-case coverage: {registered} / {total} registered');
    expect(dict('en')['exec.detail.coverageExecuted']).toContain('registered cases');
  });

  it('every new string exists in both languages', () => {
    const keys = Object.keys(dict('en')).filter((k) => k.startsWith('exec.detail.'));
    expect(keys.length).toBeGreaterThan(30);
    for (const k of keys) expect(dict('ja')[k], k).toBeTruthy();
  });
});

describe('export', () => {
  const project = { ...newProjectRecord(normalizeQaInputs({ ...(DEMO_STATE as QaInputs), totalCases: 420, dailyExecuted: [{ id: 'e1', date: '2026-10-25', startTime: 540, endTime: 1050, overtimeMinutes: 0, intervalEnabled: true, testers: 5, pass: 4, fail: 0, notApplicable: 0, spo: 0, blocked: 0, retest: 0, questioned: 0, note: '', source: 'testrail' }] }), { nameEn: 'Alpha', status: 'ongoing' }, NOW, []), projectId: P };
  const events = [ev('a', 'fail', '2026-10-25', '09:00'), ev('a', 'pass', '2026-10-25', '10:00', { source: 'testrail' }), ev('b', 'blocked', '2026-10-25', '11:00'), ev('c', 'pass', '2026-10-25', '12:00')];
  for (const lang of ['en', 'ja'] as const) {
    it(`[${lang}] one project row with the saved aggregate and one row per scope`, () => {
      const sheet = detailedDailyExecutionSheet(lang, [project], [scope('scp_a', 420)], [tcase('a'), tcase('b'), tcase('c')], events);
      expect(sheet.headers).toHaveLength(22);
      expect(sheet.headers[6]).toBe(dict(lang)['exec.detail.exportUnique']);
      expect(sheet.headers[7]).toBe(dict(lang)['exec.detail.exportEvents']);
      expect(sheet.rows).toHaveLength(2);
      const row = sheet.rows[0] as (string | number | { kind: string; value: string })[];
      expect(row.slice(1, 2)).toEqual([P]);
      expect(row.slice(4, 17)).toEqual([420, 3, 3, 4, 2, 0, 1, 0, 3, 1, 4, dict(lang)['exec.source.testrail'], 1]);
      expect(row.slice(17, 19)).toEqual([dict(lang)['exec.rec.coverage.partial'], dict(lang)['exec.rec.state.difference']]);
      expect((sheet.rows[1] as unknown[])[3]).toBe('scp_a');
      expect((sheet.rows[1] as unknown[]).slice(14, 17)).toEqual(['', '', '']);
    });
  }
});

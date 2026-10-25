import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  assessDetailedCoverage,
  canAdoptDetailedExecution,
  dailyEntryFromDetailedSummary,
  detailedFingerprint,
  detailedMetrics,
  isCaseDerivedAggregateStale,
  reconcileDailyExecution,
  resolveAdoptionConfirmation,
  savedMetrics,
} from '../domain/executionReconciliation';
import { dailyDetailedSummary, type CaseExecutionEvent, type CaseStatus, type TestCase, type TestScope } from '../domain/testManagement';
import { entryCompletedCases, applyDailyExecutionEntry } from '../lib/calculations/dailyExecuted';
import { DEMO_STATE } from '../lib/storage/storage';
import { DetailedExecutionCard } from '../features/dashboard/DetailedExecutionCard';
import { dictionaries } from '../i18n/dictionaries';
import type { DailyExecutionEntry, QaInputs } from '../types';

const root = resolve(__dirname, '..');
const src = (rel: string): string => readFileSync(join(root, rel), 'utf8');
const dict = (lang: 'en' | 'ja'): Record<string, string> => dictionaries[lang] as Record<string, string>;
const NOW = '2026-10-01T00:00:00.000Z';
const P = 'PRJ-001';
const DAY = '2026-10-25';
const TODAY = '2026-10-25';

const scope = (id: string, total?: number, over: Partial<TestScope> = {}): TestScope => ({ id, projectId: P, name: id, status: 'active', order: 10, createdAt: NOW, updatedAt: NOW, ...(total === undefined ? {} : { totalTestCases: total }), ...over });
const cases = (scopeId: string, n: number, prefix = scopeId): TestCase[] => Array.from({ length: n }, (_, i) => ({ id: `${prefix}_${i}`, projectId: P, scopeId, key: `${prefix}-${i}`, title: `c${i}`, priority: 'medium' as const, status: 'active' as const, order: i, createdAt: NOW, updatedAt: NOW }));
let n = 0;
const jst = (date: string, hhmm: string): string => new Date(`${date}T${hhmm}:00+09:00`).toISOString();
const ev = (testCaseId: string, scopeId: string, status: CaseStatus, date = DAY, hhmm = '10:00'): CaseExecutionEvent => ({ id: `evt_${(n += 1)}`, projectId: P, scopeId, testCaseId, status, executedAt: jst(date, hhmm), source: 'manual' });

const savedEntry = (over: Partial<DailyExecutionEntry> = {}): DailyExecutionEntry => ({ id: 'd1', date: DAY, startTime: 540, endTime: 1050, overtimeMinutes: 30, intervalEnabled: true, testers: 6, pass: 90, fail: 10, notApplicable: 0, spo: 0, blocked: 0, retest: 3, questioned: 2, note: 'kept', source: 'manual', sourceUpdatedAt: NOW, ...over });

/** One scope: `total` authoritative, `registered` cases, the first `executed` cases run to the given statuses. */
function world(total: number | undefined, registered: number, statuses: CaseStatus[]) {
  const cs = cases('scp_a', registered);
  const events = statuses.map((st, i) => ev(cs[i]!.id, 'scp_a', st));
  const scopes = [scope('scp_a', total)];
  const summary = dailyDetailedSummary({ date: DAY, projectId: P, scopes, cases: cs, events });
  const coverage = assessDetailedCoverage({ date: DAY, projectId: P, scopes, cases: cs, events });
  return { cs, events, scopes, summary, coverage };
}

describe('detailed coverage (strict)', () => {
  it('total 100 with 100 registered cases is complete; 90 registered is partial', () => {
    expect(world(100, 100, ['pass']).coverage.state).toBe('complete');
    const partial = world(100, 90, ['pass']).coverage;
    expect(partial.state).toBe('partial');
    expect(partial.reasons).toContain('registeredMismatch');
  });

  it('no authoritative total is never complete; more registered than the total is not complete either', () => {
    expect(world(undefined, 10, ['pass']).coverage).toMatchObject({ state: 'partial', reasons: ['scopeTotalMissing'] });
    expect(world(8, 10, ['pass']).coverage.state).toBe('partial');
  });

  it('a project is complete only when EVERY active scope is complete (never averaged)', () => {
    const a = cases('scp_a', 100);
    const b = cases('scp_b', 180);
    const scopes = [scope('scp_a', 100), scope('scp_b', 200)];
    const events = [ev('scp_a_0', 'scp_a', 'pass'), ev('scp_b_0', 'scp_b', 'pass')];
    const project = assessDetailedCoverage({ date: DAY, projectId: P, scopes, cases: [...a, ...b], events });
    expect(project.state).toBe('partial');
    expect(project.reasons).toContain('scopeNotComplete');
    expect(project.scopes.map((s) => [s.scopeId, s.state])).toEqual([['scp_a', 'complete'], ['scp_b', 'partial']]);
    // scope A is eligible on its own, scope B is not
    expect(assessDetailedCoverage({ date: DAY, projectId: P, scopeId: 'scp_a', scopes, cases: [...a, ...b], events }).state).toBe('complete');
    expect(assessDetailedCoverage({ date: DAY, projectId: P, scopeId: 'scp_b', scopes, cases: [...a, ...b], events }).state).toBe('partial');
  });

  it('cannot prove complete when executions sit on unregistered cases, results predate the history, or the date predates it', () => {
    const w = world(3, 3, ['pass']);
    const stray = [...w.events, ev('archived_case', 'scp_a', 'fail')];
    expect(assessDetailedCoverage({ date: DAY, projectId: P, scopes: w.scopes, cases: w.cs, events: stray }).reasons).toContain('eventsOutsideRegistered');
    const old = assessDetailedCoverage({ date: DAY, projectId: P, scopes: w.scopes, cases: w.cs, events: w.events, results: [{ testCaseId: 'scp_a_2', status: 'pass' }] });
    expect(old).toMatchObject({ state: 'partial' });
    expect(old.reasons).toContain('resultsWithoutHistory');
    const before = assessDetailedCoverage({ date: '2026-10-20', projectId: P, scopes: w.scopes, cases: w.cs, events: w.events });
    expect(before).toMatchObject({ state: 'none', reasons: ['dateBeforeHistory'] });
  });

  it('none: no history yet or no registered cases', () => {
    expect(world(3, 3, []).coverage).toMatchObject({ state: 'none', reasons: ['noHistoryYet'] });
    expect(assessDetailedCoverage({ date: DAY, projectId: P, scopes: [scope('scp_a', 3)], cases: [], events: [ev('x', 'scp_a', 'pass')] }).state).toBe('none');
  });
});

describe('what the saved executed figure means', () => {
  it('saved executed = Pass + Fail + N/A + SPO (+ uncategorized); Blocked, Retest, Question are never part of it', () => {
    const e = savedEntry({ pass: 5, fail: 2, notApplicable: 1, spo: 1, blocked: 7, retest: 4, questioned: 3, uncategorizedCompleted: 2 });
    expect(entryCompletedCases(e)).toBe(11);
    expect(savedMetrics(e).executed).toBe(11);
  });

  it('so the detailed counterpart is the COMPLETED statuses - Blocked and In Progress cases are not "executed" here', () => {
    const w = world(4, 4, ['pass', 'fail', 'blocked', 'inProgress']);
    expect(w.summary.uniqueCasesExecuted).toBe(4);
    expect(detailedMetrics(w.summary)).toMatchObject({ executed: 2, passed: 1, failed: 1, blocked: 1 });
  });
});

describe('reconciliation state and eligibility', () => {
  const recon = (w: ReturnType<typeof world>, saved: DailyExecutionEntry | null, over: { isSv?: boolean; today?: string; date?: string; level?: 'project' | 'scope' } = {}) =>
    reconcileDailyExecution({ date: over.date ?? DAY, today: over.today ?? TODAY, savedDaily: saved, summary: w.summary, coverage: w.coverage, isSv: over.isSv ?? true, ...(over.level === undefined ? {} : { level: over.level }) });

  it('match when every comparable metric matches, difference when one differs', () => {
    const w = world(100, 100, [...Array(90).fill('pass'), ...Array(10).fill('fail')] as CaseStatus[]);
    expect(recon(w, savedEntry()).state).toBe('match');
    const diff = recon(w, savedEntry({ pass: 91, fail: 9 }));
    expect(diff.state).toBe('difference');
    expect(diff.differences).toMatchObject({ passed: 1, failed: -1, executed: 0 });
  });

  it('partial coverage with matching numbers is a match that still cannot be adopted', () => {
    const w = world(100, 90, [...Array(80).fill('pass'), ...Array(10).fill('fail')] as CaseStatus[]);
    const r = recon(w, savedEntry({ pass: 80, fail: 10 }));
    expect(r).toMatchObject({ coverage: 'partial', state: 'match', canAdopt: false });
    expect(canAdoptDetailedExecution(r)).toBe(false);
    expect(r.reasons).toContain('registeredMismatch');
  });

  it('complete coverage and a difference is eligible; a tester, a missing day, a future date and scope level are not', () => {
    const w = world(3, 3, ['pass', 'fail', 'pass']);
    expect(recon(w, savedEntry()).canAdopt).toBe(true);
    expect(recon(w, savedEntry(), { isSv: false })).toMatchObject({ canAdopt: false, reasons: ['notPermitted'] });
    expect(recon(w, null).reasons).toContain('noSavedEntry');
    expect(recon(w, null).state).toBe('notComparable');
    expect(recon(w, savedEntry(), { today: '2026-10-24' }).reasons).toContain('futureDate');
    expect(recon(w, savedEntry(), { date: 'nope' }).reasons).toContain('invalidDate');
    expect(recon(w, savedEntry(), { level: 'scope' }).reasons).toContain('projectLevelOnly');
  });

  it('no history: not comparable and never adoptable', () => {
    const r = recon(world(3, 3, []), savedEntry());
    expect(r).toMatchObject({ coverage: 'none', state: 'notComparable', canAdopt: false, detailed: null });
  });
});

describe('the mapping and the adoption write', () => {
  it('maps only the equivalent fields, keeps everything else, switches the source and stamps the time', () => {
    const w = world(3, 3, ['pass', 'fail', 'pass']);
    const before = savedEntry({ source: 'testrail', sourceRef: { provider: 'testrail', runId: 9 }, uncategorizedCompleted: 4 });
    const next = dailyEntryFromDetailedSummary(before, w.summary, '2026-10-25T05:00:00.000Z');
    expect(next).toMatchObject({ pass: 2, fail: 1, notApplicable: 0, spo: 0, blocked: 0, uncategorizedCompleted: 0 });
    expect(next).toMatchObject({ note: 'kept', testers: 6, startTime: 540, endTime: 1050, overtimeMinutes: 30, retest: 3, questioned: 2, id: 'd1', date: DAY });
    expect(next).toMatchObject({ source: 'caseExecution', sourceUpdatedAt: '2026-10-25T05:00:00.000Z' });
    expect(next.sourceRef).toBeUndefined();
    expect(entryCompletedCases(next)).toBe(3);
  });

  it('adds nothing but the mapped fields and the provenance: no history or foreign data rides along in the entry', () => {
    const w = world(3, 3, ['pass', 'fail', 'pass']);
    const before = savedEntry({ uncategorizedCompleted: 1 });
    const next = dailyEntryFromDetailedSummary(before, w.summary, NOW);
    const allowed = new Set([...Object.keys(before), 'source', 'sourceUpdatedAt']);
    expect(Object.keys(next).filter((k) => !allowed.has(k))).toEqual([]);
    expect(JSON.stringify(before)).toContain('"source":"manual"'); // the input entry itself is not mutated
  });

  it('never maps event counts, registered counts or unique-executed into saved executed', () => {
    const w = world(5, 5, ['pass', 'pass', 'blocked', 'inProgress']);
    const dup = [...w.events, ev('scp_a_0', 'scp_a', 'pass', DAY, '12:00'), ev('scp_a_0', 'scp_a', 'pass', DAY, '13:00')];
    const s = dailyDetailedSummary({ date: DAY, projectId: P, scopes: w.scopes, cases: w.cs, events: dup });
    expect(s.eventCount).toBe(6);
    const next = dailyEntryFromDetailedSummary(savedEntry(), s, NOW);
    expect(entryCompletedCases(next)).toBe(2); // two cases ended Pass; not 6 events, not 4 unique, not 5 registered
    expect(next.blocked).toBe(1);
  });

  it('adopting changes only the saved day: case history, results and everything else stay as they were', () => {
    const w = world(3, 3, ['pass', 'fail', 'pass']);
    const inputs = { ...(DEMO_STATE as QaInputs), dailyExecuted: [savedEntry()] };
    const frozenEvents = JSON.stringify(w.events);
    const next = applyDailyExecutionEntry(inputs, dailyEntryFromDetailedSummary(savedEntry(), w.summary, NOW));
    expect(next.dailyExecuted?.[0]).toMatchObject({ source: 'caseExecution', pass: 2, fail: 1 });
    expect(next.currentTesters).toBe(inputs.currentTesters);
    expect(JSON.stringify(w.events)).toBe(frozenEvents);
  });

  it('a case-derived day is stale when new events change the comparable figures, and not when only the time moved', () => {
    const w = world(3, 3, ['pass', 'fail', 'pass']);
    const adopted = dailyEntryFromDetailedSummary(savedEntry(), w.summary, NOW);
    expect(isCaseDerivedAggregateStale(adopted, w.summary)).toBe(false);
    const later = dailyDetailedSummary({ date: DAY, projectId: P, scopes: w.scopes, cases: w.cs, events: [...w.events, ev('scp_a_1', 'scp_a', 'pass', DAY, '16:00')] });
    expect(isCaseDerivedAggregateStale(adopted, later)).toBe(true);
    expect(isCaseDerivedAggregateStale(savedEntry(), later)).toBe(false); // manual / TestRail days are not "case-derived"
    expect(isCaseDerivedAggregateStale(null, later)).toBe(false);
  });

  it('refresh: a stale case-derived day is eligible again; if coverage is lost it is not, and nothing changes by itself', () => {
    const w = world(3, 3, ['pass', 'fail', 'pass']);
    const adopted = dailyEntryFromDetailedSummary(savedEntry(), w.summary, NOW);
    const events = [...w.events, ev('scp_a_1', 'scp_a', 'pass', DAY, '16:00')];
    const summary = dailyDetailedSummary({ date: DAY, projectId: P, scopes: w.scopes, cases: w.cs, events });
    const coverage = assessDetailedCoverage({ date: DAY, projectId: P, scopes: w.scopes, cases: w.cs, events });
    const r = reconcileDailyExecution({ date: DAY, today: TODAY, savedDaily: adopted, summary, coverage, isSv: true });
    expect(r).toMatchObject({ stale: true, canAdopt: true, savedSource: 'caseExecution' });
    expect(dailyEntryFromDetailedSummary(adopted, summary, '2026-10-25T09:00:00.000Z')).toMatchObject({ pass: 3, fail: 0 });
    // the authoritative total grows: coverage is no longer complete -> refresh unavailable, the saved day is untouched
    const grown = [scope('scp_a', 5)];
    const lost = assessDetailedCoverage({ date: DAY, projectId: P, scopes: grown, cases: w.cs, events });
    const r2 = reconcileDailyExecution({ date: DAY, today: TODAY, savedDaily: adopted, summary, coverage: lost, isSv: true });
    expect(r2).toMatchObject({ canAdopt: false, savedSource: 'caseExecution' });
    expect(adopted.source).toBe('caseExecution');
    // an up-to-date case-derived day has nothing to refresh
    expect(reconcileDailyExecution({ date: DAY, today: TODAY, savedDaily: adopted, summary: w.summary, coverage: w.coverage, isSv: true }).reasons).toContain('alreadyUpToDate');
  });
});

describe('stale-preview protection', () => {
  it('the fingerprint changes with a new event, and a confirmation of an old preview is refused without writing', () => {
    const w = world(3, 3, ['pass', 'fail', 'pass']);
    const fp = (events: CaseExecutionEvent[]) => detailedFingerprint({ date: DAY, coverage: 'complete', summary: dailyDetailedSummary({ date: DAY, projectId: P, scopes: w.scopes, cases: w.cs, events }), events, projectId: P });
    const preview = fp(w.events);
    const changed = fp([...w.events, ev('scp_a_1', 'scp_a', 'pass', DAY, '16:00')]);
    expect(changed).not.toBe(preview);
    const entry = savedEntry();
    expect(resolveAdoptionConfirmation({ previewFingerprint: preview, currentFingerprint: changed, currentEntry: entry })).toEqual({ ok: false, reason: 'changed' });
    expect(resolveAdoptionConfirmation({ previewFingerprint: preview, currentFingerprint: preview, currentEntry: entry })).toEqual({ ok: true, entry });
    expect(resolveAdoptionConfirmation({ previewFingerprint: preview, currentFingerprint: preview, currentEntry: null })).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('the card confirms through that helper, asks once (no source-replacement prompt of its own) and cancel writes nothing', () => {
    const card = src('features/dashboard/DetailedExecutionCard.tsx');
    expect(card).toContain('resolveAdoptionConfirmation(');
    expect(card).toContain('exec.rec.changed');
    expect(card).not.toMatch(/decideManualSave|decideImport|setPending/);
    expect(card.match(/recon\.onAdopt\(/g)).toHaveLength(1); // one call site, inside confirm
    expect(card).toContain('onClick={() => setPreview(null)}');
  });
});

describe('no hidden writes, one saved authority', () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name !== 'test') walk(p, out);
      } else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
  };

  it('the report builders never read the detailed history; the composer only hands the workspace to the one draft generator', () => {
    for (const f of walk(join(root, 'lib/reporting'))) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/executionReconciliation|dailyDetailedSummary|caseExecutions|dailyCaseExecution/);
    }
    // Phase 10: the saved aggregate still supplies every report figure; the composer never derives counts from case history itself.
    for (const f of walk(join(root, 'features/daily-report'))) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/executionReconciliation|dailyDetailedSummary|dailyCaseExecution/);
    }
  });

  it('the Dashboard only hands a confirmed entry to the save action; no effect adopts or refreshes by itself', () => {
    const dash = src('features/dashboard/Dashboard.tsx');
    const block = dash.slice(dash.indexOf('const detailedResults'), dash.indexOf('const blockedReason'));
    expect(block).not.toMatch(/useEffect|setInterval|saveDailyExecutionEntry\(/);
    expect(dash).toContain('onAdopt: saveDailyExecutionEntry');
  });

  it('adoption is SV-only at the UI boundary, and the server refuses a Tester case-derived day', () => {
    expect(src('features/dashboard/Dashboard.tsx')).toContain('isSv: access.canManage && !access.isTester');
    expect(src('../shared/testerRules.ts')).toContain("tester_execution_case_derived");
  });
});

describe('card states and wording', () => {
  const saved = savedEntry();
  const render = (lang: 'en' | 'ja', w: ReturnType<typeof world>, entry: DailyExecutionEntry | null, isSv = true) =>
    renderToStaticMarkup(
      createElement(DetailedExecutionCard, {
        lang,
        summary: w.summary,
        saved: entry,
        recon: { reconciliation: reconcileDailyExecution({ date: DAY, today: TODAY, savedDaily: entry, summary: w.summary, coverage: w.coverage, isSv }), fingerprint: 'fp', date: DAY, buildEntry: () => entry, onAdopt: () => undefined },
      }),
    );

  for (const lang of ['en', 'ja'] as const) {
    it(`[${lang}] complete coverage with a difference offers the Adopt action; partial and tester do not`, () => {
      const complete = render(lang, world(3, 3, ['pass', 'fail', 'pass']), saved);
      expect(complete).toContain(dict(lang)['exec.rec.adopt']);
      expect(complete).toContain(dict(lang)['exec.rec.eligible']);
      expect(complete).toContain(dict(lang)['exec.rec.coverage.complete']);
      expect(complete).toContain(dict(lang)['exec.rec.state.difference']);
      const partial = render(lang, world(10, 3, ['pass', 'fail', 'pass']), saved);
      expect(partial).not.toContain(dict(lang)['exec.rec.adopt']);
      expect(partial).toContain(dict(lang)['exec.rec.coverage.partial']);
      expect(partial).toContain(dict(lang)['exec.rec.msg.partial']);
      expect(render(lang, world(3, 3, ['pass', 'fail', 'pass']), saved, false)).not.toContain(dict(lang)['exec.rec.adopt']);
      expect(render(lang, world(3, 3, []), saved)).toContain(dict(lang)['exec.rec.msg.none']);
    });

    it(`[${lang}] a case-derived day offers Refresh when stale, says so, and warns when coverage was lost`, () => {
      const w = world(3, 3, ['pass', 'fail', 'pass']);
      const adopted = dailyEntryFromDetailedSummary(saved, dailyDetailedSummary({ date: DAY, projectId: P, scopes: w.scopes, cases: w.cs, events: w.events.slice(0, 2) }), NOW);
      const stale = render(lang, w, adopted);
      expect(stale).toContain(dict(lang)['exec.rec.refresh']);
      expect(stale).toContain(dict(lang)['exec.rec.stale']);
      const lost = world(5, 3, ['pass', 'fail', 'pass']);
      const html = render(lang, lost, adopted);
      expect(html).toContain(dict(lang)['exec.rec.coverageLost']);
      expect(html).not.toContain(dict(lang)['exec.rec.refresh']);
    });
  }

  it('every new string exists in both languages', () => {
    const keys = Object.keys(dict('en')).filter((k) => k.startsWith('exec.rec.'));
    expect(keys.length).toBeGreaterThan(40);
    for (const k of keys) expect(dict('ja')[k], k).toBeTruthy();
  });
});

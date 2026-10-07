import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MetricsGrid, RiskBadge, RiskList } from '../features/cycles/parts';
import { CycleStatusBadge, cycleErrorKey } from '../features/cycles/CyclesScreen';
import { CYCLE_TRANSITIONS } from '../domain/cycles';
import { metricsFromCounts, type CycleRiskCode, type RiskCode } from '../domain/qaMetrics';
import { buildExecutionReport, renderExecutionSummarySection } from '../lib/reporting/execution';
import { buildReportSections } from '../lib/reporting/sections';
import { DEFAULT_REPORT_TEMPLATES, renderReport } from '../lib/reporting/template';
import { DEFAULT_PROGRESS_RULES } from '../lib/reporting/progress';
import { newProjectRecord } from '../domain/projects/lifecycle';
import { normalizeQaInputs } from '../lib/storage/storage';
import { dictionaries } from '../i18n/dictionaries';
import { toCsv } from '../lib/export/csv';
import type { Cycle, DailyExecutionEntry, ProjectRecord, QaInputs, TesterProjectAssignment } from '../types';

const render = (el: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(el);
const en = dictionaries.en as Record<string, string>;
const ja = dictionaries.ja as Record<string, string>;

describe('metrics display', () => {
  const m = metricsFromCounts({ planned: 100, passed: 40, failed: 10, blocked: 5, notApplicable: 0, spo: 0, completed: 50 });

  it('shows every number with a word label, a pass rate defined as Passed / Executed, and a hint for the two that are easy to misread', () => {
    const html = render(createElement(MetricsGrid, { lang: 'en', m }));
    for (const label of ['Planned Cases', 'Executed', 'Passed', 'Failed', 'Blocked', 'Remaining', 'Completion', 'Pass rate']) expect(html).toContain(label);
    expect(html).toContain('>100<'); // planned
    expect(html).toContain('>50<'); // executed (40 + 10) and remaining 50
    expect(html).toContain('50%'); // completion
    expect(html).toContain('80%'); // 40 / 50, never 40 / 100
    expect(html).not.toContain('40%');
    expect(html).toContain('Passed divided by Executed');
  });

  it('shows a dash, never NaN or Infinity, when nothing has been executed or planned', () => {
    const empty = metricsFromCounts({ planned: 0, passed: 0, failed: 0, blocked: 0, notApplicable: 0, spo: 0, completed: 0 });
    const html = render(createElement(MetricsGrid, { lang: 'en', m: empty }));
    expect(html).toContain('—');
    expect(html).not.toMatch(/NaN|Infinity/);
  });

  it('says so when the data is inconsistent instead of hiding it, in both languages', () => {
    const over = metricsFromCounts({ planned: 10, passed: 15, failed: 0, blocked: 0, notApplicable: 0, spo: 0, completed: 15 });
    expect(render(createElement(MetricsGrid, { lang: 'en', m: over }))).toContain('above the planned total');
    expect(render(createElement(MetricsGrid, { lang: 'ja', m: over }))).toContain('計画ケース数を上回って');
  });

  it('is translated', () => {
    const html = render(createElement(MetricsGrid, { lang: 'ja', m }));
    for (const label of ['計画ケース数', '実行済み', '合格', '不合格', 'ブロック', '残り', '完了率', '合格率']) expect(html).toContain(label);
  });
});

describe('risk display (words and symbols, never colour alone)', () => {
  it('lists each signal with a symbol, a hidden severity word and its message', () => {
    const html = render(createElement(RiskList, { lang: 'en', signals: [{ code: 'blocked_cases', severity: 'attention', value: 3 }, { code: 'failed_cases', severity: 'warning', value: 2 }, { code: 'no_tester', severity: 'info' }] }));
    expect(html).toContain('⚠');
    expect(html).toContain('△');
    expect(html).toContain('ℹ');
    expect(html).toContain('3 blocked case(s)');
    expect(html).toContain('2 failed case(s) to follow up');
    expect(html).toContain('No Tester assigned');
    expect(html).toContain('Needs attention: ');
  });

  it('says there are no signals instead of staying silent', () => {
    expect(render(createElement(RiskList, { lang: 'en', signals: [] }))).toContain('No risk signals');
    expect(render(createElement(RiskBadge, { lang: 'en', signals: [] }))).toContain('OK');
  });

  it('the badge shows the most serious level only', () => {
    const html = render(createElement(RiskBadge, { lang: 'en', signals: [{ code: 'no_tester', severity: 'info' }, { code: 'overdue', severity: 'attention' }] }));
    expect(html).toContain('Needs attention');
    expect(html).not.toContain('Note');
  });

  it('every risk code has an English and a Japanese message', () => {
    const codes: Array<RiskCode | CycleRiskCode> = ['overdue', 'behind_plan', 'schedule_attention', 'due_soon_much_remaining', 'blocked_cases', 'failed_cases', 'no_recent_activity', 'no_tester', 'completed_exceeds_planned', 'cycle_overdue', 'cycle_due_soon_much_remaining', 'projects_need_attention'];
    for (const c of codes) {
      expect(en[`risk.${c}`], c).toBeTruthy();
      expect(ja[`risk.${c}`], c).toBeTruthy();
    }
  });
});

describe('cycle wording is complete in both languages', () => {
  it('statuses, every allowed transition, confirmations and every error', () => {
    for (const status of Object.keys(CYCLE_TRANSITIONS)) {
      for (const dict of [en, ja]) expect(dict[`cycles.status.${status}`], status).toBeTruthy();
      for (const to of CYCLE_TRANSITIONS[status as Cycle['status']]) for (const dict of [en, ja]) expect(dict[`cycles.action.${status}_${to}`], `${status}_${to}`).toBeTruthy();
    }
    for (const k of ['completed', 'archived']) for (const part of ['title', 'body']) for (const dict of [en, ja]) expect(dict[`cycles.confirm.${k}.${part}`]).toBeTruthy();
    for (const code of ['cycle_invalid_name', 'cycle_invalid_date', 'cycle_end_before_start', 'cycle_invalid_version', 'cycle_invalid_description', 'cycle_not_found', 'cycle_archived', 'cycle_transition_not_allowed']) {
      expect(en[cycleErrorKey(code)], code).toBeTruthy();
      expect(ja[cycleErrorKey(code)], code).toBeTruthy();
    }
    expect(cycleErrorKey('something_else')).toBe('cycles.error.generic');
  });

  it('placeholders match between English and Japanese in every new string', () => {
    const prefixes = ['qa.', 'risk.', 'cycles.', 'mgr.', 'cc.', 'workload.', 'report.exec.'];
    const holes = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(en).filter((k) => prefixes.some((p) => k.startsWith(p)))) {
      expect(ja[key], key).toBeTruthy();
      expect(holes(ja[key]), key).toEqual(holes(en[key]));
    }
  });

  it('the status badge uses a symbol and a word', () => {
    const html = render(createElement(CycleStatusBadge, { lang: 'en', status: 'completed' }));
    expect(html).toContain('✓');
    expect(html).toContain('Completed');
    expect(render(createElement(CycleStatusBadge, { lang: 'ja', status: 'active' }))).toContain('進行中');
  });
});

describe('daily report: execution summary', () => {
  const NOW = '2026-10-07T09:00:00.000Z';
  const DATE = '2026-10-07';
  const entry = (over: Partial<DailyExecutionEntry>): DailyExecutionEntry => ({ id: crypto.randomUUID(), date: DATE, startTime: null, endTime: null, overtimeMinutes: 0, intervalEnabled: true, testers: 2, pass: 0, fail: 0, notApplicable: 0, spo: 0, blocked: 0, retest: 0, questioned: 0, note: '', ...over });
  const inputs = (over: Partial<QaInputs>): QaInputs => {
    const rows: QaInputs['planningRows'] = [];
    for (let t = Date.parse('2026-10-01'); t <= Date.parse('2026-10-30'); t += 86_400_000) {
      const d = new Date(t);
      rows.push({ id: `r${rows.length}`, date: d.toISOString().slice(0, 10), plannedTesters: 4, absentTesters: 0, nonWorkingDay: d.getUTCDay() === 0 || d.getUTCDay() === 6, note: '' });
    }
    return normalizeQaInputs({ totalCases: 100, currentTesters: 2, startTime: 540, targetFinish: 1080, lunchStart: 720, lunchEnd: 780, perHourPerTester: 6, casesCompleted: 0, startDate: '2026-10-01', targetCompletionDate: '2026-10-30', targetCompletionTime: '17:30', planningRows: rows, ...over });
  };
  let n = 0;
  const project = (name: string, entries: DailyExecutionEntry[], extra: Partial<ProjectRecord> = {}): ProjectRecord => {
    n += 1;
    return { ...newProjectRecord(inputs({ dailyExecuted: entries }), { nameEn: name, status: 'ongoing' }, NOW, []), projectId: `PRJ-00${n}`, ...extra };
  };
  const cycle: Cycle = { id: 'cyc_1', name: 'Android 4.2.0 Release', version: '4.2.0', status: 'active', plannedStart: '2026-10-01', plannedEnd: '2026-10-31', completedAt: null, createdAt: NOW, updatedAt: NOW };
  const asg = (projectId: string, name: string): TesterProjectAssignment => ({ id: crypto.randomUUID(), projectId, userId: `usr_${name}`, testerName: name, startDate: '2026-10-01', active: true });
  const build = (projects: ProjectRecord[], assignments: TesterProjectAssignment[] = []) => buildExecutionReport({ date: DATE, projects, cycles: [cycle], assignments, members: [], nowIso: NOW });

  it("includes today's executed, passed, failed and blocked, per project and in total, with the cycle and the Testers", () => {
    const a = project('Android 4.2.0 Sanity', [entry({ pass: 10, fail: 2, blocked: 1 })], { cycleId: cycle.id });
    const b = project('Android 4.2.0 Regression', [entry({ pass: 5, fail: 0, blocked: 0 })]);
    const text = renderExecutionSummarySection('en', build([a, b], [asg(a.projectId, 'Hana'), asg(a.projectId, 'Ken')]));
    expect(text).toContain('Executed 17 (Passed 15 / Failed 2) · Blocked 1');
    expect(text).toContain('- Android 4.2.0 Sanity [Android 4.2.0 Release]: Executed 12, Passed 10, Failed 2, Blocked 1');
    expect(text).toContain('- Android 4.2.0 Regression: Executed 5, Passed 5, Failed 0, Blocked 0');
    expect(text).toContain('Testers: Hana, Ken');
  });

  it('lists what needs attention (blocked cases) and nothing else as attention', () => {
    const a = project('Blocked one', [entry({ pass: 3, blocked: 4 })]);
    const b = project('Fine one', [entry({ pass: 3, blocked: 0 })]);
    const r = build([a, b]);
    expect(r.attention.map((x) => x.name)).toEqual(['Blocked one']);
    const text = renderExecutionSummarySection('en', r);
    expect(text).toContain('Needs attention:');
    expect(text).toContain('- Blocked one: blocked cases');
    expect(text).not.toContain('- Fine one: blocked');
  });

  it('says plainly when nothing was recorded, and counts a zero-result day as a day with an entry', () => {
    expect(renderExecutionSummarySection('en', build([project('Quiet', [])]))).toBe('No execution results were recorded for this day.');
    expect(renderExecutionSummarySection('ja', build([]))).toBe('この日の実行結果は記録されていません。');
    const zero = renderExecutionSummarySection('en', build([project('Zero day', [entry({})])]));
    expect(zero).toContain('Executed 0 (Passed 0 / Failed 0) · Blocked 0');
  });

  it('lists each project once and ignores other dates', () => {
    const a = project('Once', [entry({ pass: 4 }), entry({ date: '2026-10-06', pass: 99 })]);
    const text = renderExecutionSummarySection('en', build([a]));
    expect(text.match(/- Once/g)?.length).toBe(1);
    expect(text).toContain('Executed 4');
    expect(text).not.toContain('99');
  });

  it('is available in Japanese with names, project IDs and release labels untouched', () => {
    const a = project('Android 4.2.0 Sanity', [entry({ pass: 10, fail: 2, blocked: 1 })], { cycleId: cycle.id });
    const text = renderExecutionSummarySection('ja', build([a], [asg(a.projectId, 'Hana')]));
    expect(text).toContain('実行 12件（合格 10 / 不合格 2）・ブロック 1件');
    expect(text).toContain('Android 4.2.0 Sanity [Android 4.2.0 Release]');
    expect(text).toContain('テスター: Hana');
    expect(text).not.toMatch(/Executed|Passed|Failed/);
  });

  it('is part of the default report in both languages; a custom template without it is unchanged', () => {
    for (const lang of ['en', 'ja'] as const) {
      expect(DEFAULT_REPORT_TEMPLATES[lang]).toContain('{execution_summary}');
      const sections = buildReportSections({ language: lang, activities: [], attendance: [], topics: [], nextDay: [], jiraUrl: '', rules: DEFAULT_PROGRESS_RULES, executionSummary: 'EXEC-BLOCK' });
      expect(renderReport(DEFAULT_REPORT_TEMPLATES[lang], sections)).toContain('EXEC-BLOCK');
    }
    const custom = 'Report\n{attendance}\n{progress}';
    const sections = buildReportSections({ language: 'en', activities: [], attendance: [], topics: [], nextDay: [], jiraUrl: '', rules: DEFAULT_PROGRESS_RULES, executionSummary: 'EXEC-BLOCK' });
    expect(renderReport(custom, sections)).not.toContain('EXEC-BLOCK');
    // Without a summary the placeholder renders as nothing rather than as the raw text.
    const none = buildReportSections({ language: 'en', activities: [], attendance: [], topics: [], nextDay: [], jiraUrl: '', rules: DEFAULT_PROGRESS_RULES });
    expect(renderReport(DEFAULT_REPORT_TEMPLATES.en, none)).not.toContain('{execution_summary}');
  });
});

describe('CSV export of a cycle', () => {
  it('quotes commas and neutralises spreadsheet formulas in names', () => {
    const csv = toCsv(['Cycle', 'Project'], [['Android, 4.2.0', '=HYPERLINK("x")']]);
    expect(csv).toContain('"Android, 4.2.0"');
    expect(csv).toContain("'=HYPERLINK");
    expect(csv.startsWith('﻿')).toBe(true);
  });
});

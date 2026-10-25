import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEMO_STATE, normalizeQaInputs } from '../lib/storage/storage';
import { newProjectRecord } from '../domain/projects/lifecycle';
import { derivedTotalFor, hasAuthoritativeScopeTotals } from '../domain/testManagement';
import { PlanningPanel } from '../components/PlanningPanel';
import { WhatIfTable, type WhatIfLabels, type WhatIfRow } from '../components/WhatIfTable';
import { dictionaries } from '../i18n/dictionaries';
import type { AppState, ProjectRecord, QaInputs, TestScope } from '../types';

const NOW = '2026-10-08T09:00:00.000Z';
const src = (rel: string): string => readFileSync(resolve(__dirname, '..', rel), 'utf8');
const esc = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
const dict = (lang: 'en' | 'ja'): Record<string, string> => dictionaries[lang] as Record<string, string>;
const project = (totalCases: number): ProjectRecord => ({
  ...newProjectRecord(normalizeQaInputs({ ...(DEMO_STATE as QaInputs), totalCases }), { nameEn: 'P', status: 'ongoing' }, NOW, []),
  id: 'rec_P',
  projectId: 'PRJ-001',
});
const scope = (total?: number): TestScope => ({ id: 's1', projectId: 'PRJ-001', name: 's1', status: 'active', order: 10, createdAt: NOW, updatedAt: NOW, ...(total === undefined ? {} : { totalTestCases: total }) });

const noop = (): void => undefined;
function planning(lang: 'en' | 'ja', totalFromScopes?: boolean, total = 77): string {
  const inputs = { ...(DEMO_STATE as AppState), totalCases: total, language: lang };
  return renderToStaticMarkup(
    createElement(PlanningPanel, {
      inputs,
      lang,
      totalFromScopes,
      onChangeStartDate: noop,
      onSetTargetCompletionDate: noop,
      onSetTargetCompletionTime: noop,
      onSetPlanStartTime: noop,
      onSetProjectName: noop,
      onSetTotalCases: noop,
      onSetCurrentTesters: noop,
      onSetPerHourPerTester: noop,
      onUpdateRow: noop,
      onAddRow: noop,
      onRemoveRow: noop,
      onMoveRow: noop,
      onInsertRowAfter: noop,
    }),
  );
}
/** The Total Test Cases <input> tag out of the rendered Planning panel. */
const totalInput = (html: string, lang: 'en' | 'ja'): string => {
  const m = html.match(new RegExp(`<input[^>]*aria-label="${dict(lang)['fields.totalCases']}"[^>]*>`));
  if (m === null) throw new Error('Total Test Cases input not found');
  return m[0];
};

describe('Gantt Total Test Cases authority', () => {
  it('shares one authority rule with the Dashboard', () => {
    expect(hasAuthoritativeScopeTotals(project(5), [], [])).toBe(false);
    expect(hasAuthoritativeScopeTotals(project(5), [scope()], [])).toBe(false);
    expect(hasAuthoritativeScopeTotals(project(5), [scope(9)], [])).toBe(true);
    expect(hasAuthoritativeScopeTotals(project(5), [scope(9)], [])).toBe(derivedTotalFor(project(5), [scope(9)], []) !== null);
    expect(hasAuthoritativeScopeTotals(undefined, [scope(9)], [])).toBe(false);
    for (const f of ['features/dashboard/Dashboard.tsx', 'features/gantt/Gantt.tsx']) expect(src(f)).toContain('hasAuthoritativeScopeTotals(');
  });

  for (const lang of ['en', 'ja'] as const) {
    it(`[${lang}] scope-derived: read-only, shows the derived value and the explanation`, () => {
      const html = planning(lang, true, 134);
      const input = totalInput(html, lang);
      expect(input).toMatch(/readonly=""/);
      expect(input).toContain('value="134"');
      expect(html).toContain(esc(dict(lang)['tm.total.fromScopes']));
    });

    it(`[${lang}] no scope totals: stays editable, no explanation`, () => {
      for (const flag of [false, undefined]) {
        const html = planning(lang, flag);
        expect(totalInput(html, lang)).not.toMatch(/readonly/);
        expect(html).not.toContain(esc(dict(lang)['tm.total.fromScopes']));
      }
    });
  }

  it('Dashboard still renders its Total read-only from the same flag', () => {
    expect(src('features/dashboard/DashboardSections.tsx')).toMatch(/readOnly=\{totalFromScopes\}/);
  });
});

describe('What-If is a pure preview', () => {
  const rows: WhatIfRow[] = [3, 4, 5].map((n) => ({ testers: n, hourlyCapacity: n * 2, requiredMinutes: 600 / n, expectedFinish: 900 }));
  const labels: WhatIfLabels = { title: 'T', hint: 'H', testers: 'Testers', hourlyCapacity: 'C', requiredTime: 'R', expectedFinish: 'F', currentTag: 'current', more: 'm', fewer: 'f' };

  it('highlights the explored row, not the project Current Testers (which keeps its tag)', () => {
    const html = renderToStaticMarkup(createElement(WhatIfTable, { rows, currentTesters: 3, selectedTesters: 5, onSelect: noop, labels }));
    expect(html.match(/<tr class="selected"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-pressed="true"[^>]*>5</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>3<span class="whatif-current"> \(current\)/);
  });

  it('the table has no access to canonical state; it only reports the candidate', () => {
    expect(src('components/WhatIfTable.tsx')).not.toMatch(/updateField|useAppState/);
  });

  it('Dashboard keeps the selection in local state and never writes currentTesters from the What-If', () => {
    const dash = src('features/dashboard/Dashboard.tsx');
    expect(dash).toContain('onSelect={setWhatIfSelected}');
    expect(dash).not.toMatch(/updateField\(\s*'currentTesters'/);
    expect(src('features/dashboard/DashboardSections.tsx')).toContain("onNumberChange('currentTesters'");
  });

  it('scenario rows still compute capacity from the candidate tester count', () => {
    expect(src('features/dashboard/Dashboard.tsx')).toContain('calculateTeamCapacity(n, state.perHourPerTester)');
  });

  it('EN/JA hint no longer claims a row applies the count', () => {
    expect(dict('en')['whatIf.hint']).toMatch(/preview/);
    expect(dict('en')['whatIf.hint']).not.toMatch(/apply that/);
    expect(dict('ja')['whatIf.hint']).toMatch(/確認/);
    expect(dict('ja')['whatIf.hint']).not.toMatch(/適用/);
  });
});

describe('Recovery never writes the plan from preview', () => {
  const panel = src('components/RecoveryPanel.tsx');

  it('the only canonical writes live in applyScenario, reachable only from the confirm button', () => {
    const body = panel.slice(panel.indexOf('const applyScenario'), panel.indexOf('const tableLabels'));
    expect(body.match(/updateField\(/g)).toHaveLength(2);
    expect(panel.match(/updateField\(/g)).toHaveLength(2);
    expect(panel.match(/applyScenario/g)).toHaveLength(2); // definition + the confirm button
    expect(panel).toMatch(/onClick=\{applyScenario\}/);
    // the first "Apply Scenario" click only opens the confirmation
    expect(panel).toMatch(/onClick=\{\(\) => setConfirming\(true\)\}/);
  });

  it('the apply action is labelled and confirmed in both languages', () => {
    for (const lang of ['en', 'ja'] as const) {
      for (const key of ['recovery.apply', 'recovery.confirmTitle', 'recovery.confirmNote', 'recovery.confirmOk']) expect(dict(lang)[key]).toBeTruthy();
    }
  });
});

describe('component naming', () => {
  it('the per-tester form is TesterDayRecordForm; DailyExecutionForm names only the day-total form', () => {
    expect(existsSync(resolve(__dirname, '../features/performance/DailyExecutionForm.tsx'))).toBe(false);
    expect(src('features/performance/TesterDayRecordForm.tsx')).toMatch(/export function TesterDayRecordForm\(/);
    expect(src('features/performance/PerformanceTab.tsx')).toContain("from './TesterDayRecordForm'");
    expect(src('components/DailyExecutionForm.tsx')).toMatch(/export function DailyExecutionForm\(/);
    expect(src('features/performance/TesterDayRecordForm.tsx')).not.toContain('DailyExecutionForm');
    expect(src('features/dashboard/DashboardSections.tsx')).toContain("from '../../components/DailyExecutionForm'");
  });
});

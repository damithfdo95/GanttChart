import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEMO_STATE } from '../lib/storage/storage';
import { applyDailyExecutionEntry } from '../lib/calculations/dailyExecuted';
import { calculateTeamCapacity } from '../lib/calculations/capacity';
import { actualTesterCountForDate, assignedTesterCountForProject, assignedTesterIdsForProject, testerCapacitySummary } from '../domain/testerCapacity';
import { TesterCapacityStrip } from '../features/dashboard/TesterCapacityStrip';
import { dictionaries } from '../i18n/dictionaries';
import type { DailyExecutionEntry, QaInputs, RcsMember, TesterProjectAssignment } from '../types';

const root = resolve(__dirname, '..');
const dict = (lang: 'en' | 'ja'): Record<string, string> => dictionaries[lang] as Record<string, string>;
const entry = (date: string, testers: number, pass = 10): DailyExecutionEntry => ({
  id: `e-${date}`,
  date,
  startTime: 540,
  endTime: 1050,
  overtimeMinutes: 0,
  intervalEnabled: true,
  testers,
  pass,
  fail: 0,
  notApplicable: 0,
  spo: 0,
  blocked: 0,
  retest: 0,
  questioned: 0,
  note: '',
});
const planned8: QaInputs = { ...(DEMO_STATE as QaInputs), currentTesters: 8, dailyExecuted: [] };

describe('Planned vs Actual Testers', () => {
  it('saving a daily entry stores its Actual Testers and leaves Planned Testers alone', () => {
    const after = applyDailyExecutionEntry(planned8, entry('2026-10-07', 6));
    expect(after.currentTesters).toBe(8);
    expect(after.dailyExecuted?.find((e) => e.date === '2026-10-07')?.testers).toBe(6);
    expect(calculateTeamCapacity(after.currentTesters, after.perHourPerTester)).toBe(calculateTeamCapacity(8, after.perHourPerTester));
  });

  it('editing a historical day changes only that entry, never the plan or other days', () => {
    const one = applyDailyExecutionEntry(planned8, entry('2026-10-05', 5));
    const two = applyDailyExecutionEntry(one, entry('2026-10-06', 7));
    const edited = applyDailyExecutionEntry(two, entry('2026-10-05', 3));
    expect(edited.currentTesters).toBe(8);
    expect(actualTesterCountForDate(edited.dailyExecuted ?? [], '2026-10-05')).toBe(3);
    expect(actualTesterCountForDate(edited.dailyExecuted ?? [], '2026-10-06')).toBe(7);
  });

  it('the save action in useAppState has no path to currentTesters', () => {
    const hook = readFileSync(join(root, 'features/dashboard/hooks/useAppState.ts'), 'utf8');
    const body = hook.slice(hook.indexOf('const saveDailyExecutionEntry'), hook.indexOf('const deleteDailyExecutionEntry'));
    expect(body).toContain('applyDailyExecutionEntry(prev, entry)');
    expect(body).not.toContain('currentTesters');
  });

  it('no calculation uses the assignment count as capacity; planning math still reads currentTesters', () => {
    const calcDir = join(root, 'lib/calculations');
    for (const f of readdirSync(calcDir).filter((x) => x.endsWith('.ts'))) expect(readFileSync(join(calcDir, f), 'utf8')).not.toMatch(/testerCapacity|assignedTester/);
    expect(readFileSync(join(calcDir, 'schedule.ts'), 'utf8')).toContain('calculateTeamCapacity(inputs.currentTesters');
  });

  it('TestRail / Test Management code never touches the planning field', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name !== 'test') walk(p);
        } else if ((/testrail/i.test(p) || /testManagement/.test(p)) && /\.(ts|tsx)$/.test(name) && readFileSync(p, 'utf8').includes('currentTesters')) {
          offenders.push(p);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  it('Dashboard and Gantt edit the same canonical field', () => {
    expect(readFileSync(join(root, 'features/gantt/Gantt.tsx'), 'utf8')).toContain("app.updateField('currentTesters'");
    expect(readFileSync(join(root, 'features/dashboard/Dashboard.tsx'), 'utf8')).toContain('updateField');
  });
});

const A = (id: string, over: Partial<TesterProjectAssignment>): TesterProjectAssignment => ({ id, projectId: 'PRJ-001', startDate: '2026-01-01', active: true, ...over });
const TODAY = '2026-10-08';
const member = (id: string, over: Partial<RcsMember> = {}): RcsMember => ({ id, name: id, team: 'T', role: 'tester', startDate: '2026-01-01', active: true, ...over });

describe('Assigned Testers', () => {
  it('counts each person once: project + several scopes = 3, not 4', () => {
    const list = [
      A('1', { memberId: 'alice' }),
      A('2', { memberId: 'bob', scopeId: 'A' }),
      A('3', { memberId: 'bob', scopeId: 'B' }),
      A('4', { memberId: 'charlie', scopeId: 'A' }),
    ];
    expect(assignedTesterCountForProject(list, 'PRJ-001', TODAY)).toBe(3);
  });

  it('a project-level and a scope assignment of the same person count once', () => {
    expect(assignedTesterCountForProject([A('1', { memberId: 'alice' }), A('2', { memberId: 'alice', scopeId: 'A' })], 'PRJ-001', TODAY)).toBe(1);
  });

  it('an account assignment and a member assignment of the linked person count once', () => {
    const members = [member('m1', { userId: 'usr_1' })];
    const list = [A('1', { memberId: 'm1' }), A('2', { userId: 'usr_1', scopeId: 'A' })];
    expect(assignedTesterCountForProject(list, 'PRJ-001', TODAY, members)).toBe(1);
  });

  it('counts profile-only members (no login); ignores ended, inactive, future and other-project assignments', () => {
    const list = [
      A('1', { memberId: 'profile-only' }),
      A('2', { memberId: 'ended', endDate: '2026-10-01' }),
      A('3', { memberId: 'off', active: false }),
      A('4', { memberId: 'later', startDate: '2026-12-01' }),
      A('5', { memberId: 'other', projectId: 'PRJ-002' }),
    ];
    expect([...assignedTesterIdsForProject(list, 'PRJ-001', TODAY)]).toEqual(['m:profile-only']);
  });

  it('never merges two different people who share a display name', () => {
    const list = [A('1', { memberId: 'm1', testerName: 'Sam' }), A('2', { memberId: 'm2', testerName: 'Sam' })];
    expect(assignedTesterCountForProject(list, 'PRJ-001', TODAY)).toBe(2);
  });
});

describe('capacity comparison', () => {
  const list = ['a', 'b', 'c', 'd', 'e', 'f'].map((m, i) => A(String(i), { memberId: m }));

  it('planned 8, assigned 6, actual 5 -> assignment gap 2, actual gap 3, no writes', () => {
    const entries = [entry(TODAY, 5)];
    const frozen = JSON.stringify([list, entries]);
    const s = testerCapacitySummary({ planned: 8, projectId: 'PRJ-001', date: TODAY, assignments: list, entries });
    expect(s).toMatchObject({ planned: 8, assigned: 6, actual: 5, assignmentGap: 2, actualGap: 3, assignmentState: 'assignmentGap' });
    expect(JSON.stringify([list, entries])).toBe(frozen);
  });

  it('no entry for the date means Actual is null (never a fabricated 0); an explicit 0 stays 0', () => {
    expect(testerCapacitySummary({ planned: 8, projectId: 'PRJ-001', date: TODAY, assignments: list, entries: [] })).toMatchObject({ actual: null, actualGap: null });
    expect(testerCapacitySummary({ planned: 8, projectId: 'PRJ-001', date: TODAY, assignments: list, entries: [entry(TODAY, 0)] }).actual).toBe(0);
  });

  it('fully staffed and over-assigned states', () => {
    expect(testerCapacitySummary({ planned: 6, projectId: 'PRJ-001', date: TODAY, assignments: list, entries: [] }).assignmentState).toBe('fullyStaffed');
    expect(testerCapacitySummary({ planned: 4, projectId: 'PRJ-001', date: TODAY, assignments: list, entries: [] })).toMatchObject({ assignmentState: 'overAssigned', assignmentGap: -2 });
  });

  for (const lang of ['en', 'ja'] as const) {
    it(`[${lang}] the strip shows Planned, Assigned and Actual Today with an empty-state dash`, () => {
      const summary = testerCapacitySummary({ planned: 8, projectId: 'PRJ-001', date: TODAY, assignments: list, entries: [] });
      const html = renderToStaticMarkup(createElement(TesterCapacityStrip, { lang, summary }));
      for (const k of ['fields.currentTesters', 'capacity.assigned', 'capacity.actualToday']) expect(html).toContain(dict(lang)[k]);
      expect(html).toContain('>8<');
      expect(html).toContain('>6<');
      expect(html).toContain('>—<');
    });
  }
});

describe('terminology', () => {
  it('the planning field reads Planned Testers; the daily field is Actual and explained (EN/JA)', () => {
    expect(dict('en')['fields.currentTesters']).toBe('Planned Testers');
    expect(dict('ja')['fields.currentTesters']).toBe('予定テスター数');
    expect(dict('en')['exec.actualTestersHint']).toMatch(/execution date/);
    expect(dict('ja')['exec.actualTestersHint']).toBeTruthy();
    expect(dict('en')['hint.plannedTesters']).toMatch(/capacity and finish/);
    expect(readFileSync(join(root, 'components/DailyExecutionForm.tsx'), 'utf8')).toContain('exec.actualTestersHint');
  });
});

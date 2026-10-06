import { describe, expect, it } from 'vitest';
import { buildDayTimeline } from '../domain/projects/timeline';
import { newProjectRecord } from '../domain/projects/lifecycle';
import type { ProjectRecord, QaInputs } from '../types';

function inputs(overrides: Partial<QaInputs> = {}): QaInputs {
  return {
    totalCases: 100,
    currentTesters: 2,
    startTime: 540,
    targetFinish: 1050,
    lunchStart: 720,
    lunchEnd: 780,
    perHourPerTester: 4,
    casesCompleted: 0,
    startDate: '2026-09-14',
    targetCompletionDate: '2026-09-16',
    targetCompletionTime: '17:30',
    planningRows: [
      { id: 'p1', date: '2026-09-14', plannedTesters: 2, absentTesters: 0, nonWorkingDay: false, note: '' },
      { id: 'p2', date: '2026-09-15', plannedTesters: 2, absentTesters: 0, nonWorkingDay: false, note: '' },
      { id: 'p3', date: '2026-09-16', plannedTesters: 2, absentTesters: 0, nonWorkingDay: false, note: '' },
    ],
    ...overrides,
  };
}

function project(overrides: Partial<ProjectRecord> = {}, existing: ProjectRecord[] = []): ProjectRecord {
  const base = newProjectRecord(
    overrides.inputs ?? inputs(),
    {
      nameEn: overrides.nameEn ?? 'Project',
      nameJa: overrides.nameJa ?? 'プロジェクト',
      team: overrides.team ?? 'PrV',
      status: overrides.status ?? 'ongoing',
    },
    '2026-09-17T09:00:00.000Z',
    existing,
  );
  return { ...base, ...overrides };
}

// Work window 09:00–17:30 with 12:00–13:00 lunch → 7.5 productive hours/day.
// 2 testers × 4 cases/h × 7.5 h = 60 cases/day.

/** "Today" for the plan/actual detail lines (a planned day in the fixtures). */
const TODAY = '2026-09-15';

describe('buildDayTimeline', () => {
  it('distributes each day progress across multiple days for one project', () => {
    const data = buildDayTimeline([project({ inputs: inputs({ totalCases: 150 }) })], 'en', TODAY);
    expect(data.days.map((d) => d.date)).toEqual(['2026-09-14', '2026-09-15', '2026-09-16']);
    expect(data.days.map((d) => d.totalCases)).toEqual([60, 60, 30]);
    expect(data.maxDayCases).toBe(60);
    expect(data.projects).toHaveLength(1);
    expect(data.projects[0].totalCases).toBe(150);
  });

  it('accounts for already completed cases', () => {
    const data = buildDayTimeline([project({ inputs: inputs({ casesCompleted: 70, totalCases: 150 }) })], 'en', TODAY);
    expect(data.days.map((d) => d.totalCases)).toEqual([60, 20, 0]);
  });

  it('multiple projects on one day produce one segment each (separated by color)', () => {
    const android = project({ nameEn: 'Android 4.1.0' });
    const ios = project({ nameEn: 'iOS 4.1.0', nameJa: 'iOSプロジェクト', inputs: inputs({ totalCases: 40 }) }, [android]);
    const data = buildDayTimeline([android, ios], 'en', TODAY);

    expect(data.projects.map((p) => p.name)).toEqual(['Android 4.1.0', 'iOS 4.1.0']);
    expect(data.projects.map((p) => p.colorIndex)).toEqual([0, 1]);

    const firstDay = data.days[0];
    expect(firstDay.totalCases).toBe(100); // 60 + 40
    expect(firstDay.segments).toEqual([
      { projectId: 'PRJ-001', cases: 60 },
      { projectId: 'PRJ-002', cases: 40 },
    ]);
    // Colors differ per project so the day can display both side by side.
    const segA = data.projects.find((p) => p.projectId === firstDay.segments[0].projectId);
    const segB = data.projects.find((p) => p.projectId === firstDay.segments[1].projectId);
    expect(segA?.colorIndex).not.toBe(segB?.colorIndex);
  });

  it('resolves legend names per language', () => {
    const android = project({ nameEn: 'Android', nameJa: 'アンドロイド' });
    expect(buildDayTimeline([android], 'ja', TODAY).projects[0].name).toBe('アンドロイド');
    expect(buildDayTimeline([android], 'en', TODAY).projects[0].name).toBe('Android');
  });

  it('non-working days contribute zero cases and are flagged', () => {
    const data = buildDayTimeline(
      [
        project({
          inputs: inputs({
            planningRows: [
              { id: 'p1', date: '2026-09-14', plannedTesters: 2, absentTesters: 0, nonWorkingDay: false, note: '' },
              { id: 'p2', date: '2026-09-15', plannedTesters: 2, absentTesters: 0, nonWorkingDay: true, note: '' },
            ],
            totalCases: 80,
          }),
        }),
      ],
      'en',
      TODAY,
    );
    expect(data.days.map((d) => d.totalCases)).toEqual([60, 0]);
    expect(data.days[0].nonWorkingDay).toBe(false);
    expect(data.days[1].nonWorkingDay).toBe(true);
  });

  it('merges the day ranges of all projects in date order', () => {
    const early = project({
      inputs: inputs({
        startDate: '2026-09-10',
        planningRows: [
          { id: 'q1', date: '2026-09-10', plannedTesters: 2, absentTesters: 0, nonWorkingDay: false, note: '' },
        ],
        totalCases: 30,
      }),
    });
    const late = project(
      {
        inputs: inputs({
          planningRows: [
            { id: 'q2', date: '2026-09-17', plannedTesters: 1, absentTesters: 0, nonWorkingDay: false, note: '' },
          ],
          totalCases: 30,
        }),
      },
      [early],
    );
    const data = buildDayTimeline([late, early], 'en', TODAY); // unordered input
    expect(data.days.map((d) => d.date)).toEqual(['2026-09-10', '2026-09-17']);
    expect(data.days[0].segments).toEqual([{ projectId: 'PRJ-001', cases: 30 }]);
    expect(data.days[1].segments).toEqual([{ projectId: 'PRJ-002', cases: 30 }]);
  });

  it('finished projects contribute nothing and are excluded from the legend', () => {
    const done = project({ inputs: inputs({ casesCompleted: 100, totalCases: 100 }) });
    const active = project({ inputs: inputs({ totalCases: 50 }) }, [done]);
    const data = buildDayTimeline([done, active], 'en', TODAY);
    expect(data.projects.map((p) => p.projectId)).toEqual(['PRJ-002']);
    expect(data.maxDayCases).toBe(50);
  });

  it('returns empty data when nothing remains', () => {
    const data = buildDayTimeline([project({ inputs: inputs({ casesCompleted: 100 }) })], 'en', TODAY);
    expect(data.days).toHaveLength(3);
    expect(data.maxDayCases).toBe(0);
    expect(data.projects).toHaveLength(0);
  });
});

describe('buildDayTimeline plan-vs-actual totals (dropdown filter summary)', () => {
  it('derives the execute/pass plan from the daily plan (pass rate applied)', () => {
    const data = buildDayTimeline(
      [project({ inputs: inputs({ totalCases: 100, targetPassRate: 0.9 }) })],
      'en',
      TODAY,
    );
    // Capacity 60/day: plan = 60 + 40; pass plan = (60 + 40) × 0.9.
    expect(data.projects[0].totalExecutePlan).toBe(100);
    expect(data.projects[0].totalPassPlan).toBeCloseTo(90, 10);
  });

  it('defaults the pass plan to the execute plan without a target pass rate', () => {
    const data = buildDayTimeline([project({ inputs: inputs({ totalCases: 100 }) })], 'en', TODAY);
    expect(data.projects[0].totalExecutePlan).toBe(100);
    expect(data.projects[0].totalPassPlan).toBe(100);
  });

  it('honors MANUAL daily-target overrides in the plan totals', () => {
    const data = buildDayTimeline(
      [
        project({
          inputs: inputs({
            totalCases: 100,
            targetPassRate: 0.9,
            dailyTargetOverrides: [{ id: 'ovr-1', date: '2026-09-14', plannedExecute: 50, plannedPass: 45 }],
          }),
        }),
      ],
      'en',
      TODAY,
    );
    // Day 1 MANUAL (50/45); day 2 AUTO picks up the remaining 50 (pass 45).
    expect(data.projects[0].totalExecutePlan).toBe(100);
    expect(data.projects[0].totalPassPlan).toBeCloseTo(90, 10);
  });

  it('takes the actual totals from the live cumulative inputs', () => {
    const data = buildDayTimeline(
      [project({ inputs: inputs({ totalCases: 150, casesCompleted: 70, casesPassed: 63 }) })],
      'en',
      TODAY,
    );
    expect(data.projects[0].totalExecuteActual).toBe(70);
    expect(data.projects[0].totalPassActual).toBe(63);
    // The chart's own distribution still reflects the REMAINING work.
    expect(data.projects[0].totalCases).toBe(80);
  });
});

describe('buildDayTimeline detail series (four plan/actual lines)', () => {
  it('derives cumulative execute/pass plan values per planned date', () => {
    const data = buildDayTimeline(
      [project({ inputs: inputs({ totalCases: 100, targetPassRate: 0.9 }) })],
      'en',
      TODAY,
    );
    const detail = data.projects[0].detail;
    // Capacity 60/day: cumulative exec 60 → 100 → 100; pass × 0.9.
    expect(detail.executePlan).toEqual({ '2026-09-14': 60, '2026-09-15': 100, '2026-09-16': 100 });
    expect(detail.passPlan['2026-09-14']).toBeCloseTo(54, 10);
    expect(detail.passPlan['2026-09-15']).toBeCloseTo(90, 10);
    expect(detail.passPlan['2026-09-16']).toBeCloseTo(90, 10);
  });

  it('builds actual lines from snapshots, with today carrying the live totals', () => {
    const data = buildDayTimeline(
      [
        project({
          inputs: inputs({
            totalCases: 150,
            casesCompleted: 70,
            casesPassed: 63,
            dailyActuals: [{ id: 's1', date: '2026-09-14', executed: 60, passed: 55 }],
          }),
        }),
      ],
      'en',
      TODAY,
    );
    const detail = data.projects[0].detail;
    // 9/14 = end-of-day snapshot; TODAY (9/15) = live cumulative totals.
    expect(detail.executeActual).toEqual({ '2026-09-14': 60, '2026-09-15': 70 });
    expect(detail.passActual).toEqual({ '2026-09-14': 55, '2026-09-15': 63 });
  });

  it('records granular statuses time to time — never inventing values', () => {
    const data = buildDayTimeline(
      [
        project({
          inputs: inputs({
            totalCases: 150,
            casesCompleted: 70,
            casesPassed: 63,
            casesFailed: 7,
            casesNotApplicable: 2,
            // casesBlocked / casesRetest / casesQuestioned / spoAssigned: never recorded
            dailyActuals: [
              { id: 's1', date: '2026-09-14', executed: 60, passed: 55, casesFailed: 5, casesNotApplicable: 1 },
              { id: 's2', date: '2026-09-15', executed: 70, passed: 63, casesFailed: 7, casesNotApplicable: 2, casesBlocked: 0 },
            ],
          }),
        }),
      ],
      'en',
      TODAY,
    );
    const detail = data.projects[0].detail;
    expect(detail.failActual).toEqual({ '2026-09-14': 5, '2026-09-15': 7 });
    expect(detail.notApplicableActual).toEqual({ '2026-09-14': 1, '2026-09-15': 2 });
    // Blocked was recorded (as 0) in the snapshot; retest/questioned/SPO were
    // never recorded anywhere → their maps stay empty.
    expect(detail.blockedActual).toEqual({ '2026-09-15': 0 });
    expect(detail.retestActual).toEqual({});
    expect(detail.questionedActual).toEqual({});
    expect(detail.spoActual).toEqual({});
  });
});

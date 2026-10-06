import { describe, expect, it } from 'vitest';
import { buildPlanExplanation, derivePlanStatus, type PlanExplanationInput } from '../lib/calculations/explanations';
import {
  calculateCapacityByDeadline,
  calculateCumulativeCapacityByDay,
  calculateMultiDayProjection,
  type MultiDayProjectionInput,
  type MultiDayProjectionResult,
} from '../lib/calculations/planning';
import type { PlanningRow } from '../types';

// Work window 09:00–17:30 with a 12:00–13:00 lunch → 7.5 productive hours/day.
const WORK_START = 9 * 60;
const WORK_END = 17 * 60 + 30;
const LUNCH = { start: 12 * 60, end: 13 * 60 };

let seq = 0;
function row(date: string, plannedTesters: number, absentTesters = 0, nonWorkingDay = false): PlanningRow {
  seq += 1;
  return { id: `x${seq}`, date, plannedTesters, absentTesters, nonWorkingDay, note: '' };
}

const D1 = '2026-09-14'; // Monday
const D2 = '2026-09-15'; // Tuesday
const D3 = '2026-09-16'; // Wednesday

function project(overrides: Partial<MultiDayProjectionInput>): MultiDayProjectionResult {
  return calculateMultiDayProjection({
    casesRemaining: 140,
    planningRows: [row(D1, 4), row(D2, 2, 1), row(D3, 3)],
    perHourPerTester: 4,
    workStartTime: WORK_START,
    workEndTime: WORK_END,
    lunch: LUNCH,
    targetCompletionDate: D3,
    targetCompletionTime: WORK_END,
    ...overrides,
  });
}

function explanationInput(overrides: Partial<PlanExplanationInput>): PlanExplanationInput {
  return {
    totalCases: 140,
    casesRemaining: 140,
    planningDayCount: 3,
    targetCompletionDate: D3,
    targetCompletionTime: WORK_END,
    workEndTimeMinutes: WORK_END,
    ...overrides,
  };
}

describe('calculateCapacityByDeadline', () => {
  const rows = [row(D1, 4), row(D2, 2, 1), row(D3, 3)];
  const daily = calculateCumulativeCapacityByDay(rows, 4, 7.5); // caps [120, 30, 90]

  it('sums capacity of days on or before the deadline', () => {
    expect(calculateCapacityByDeadline(daily, D2)).toBe(150);
    expect(calculateCapacityByDeadline(daily, D3)).toBe(240);
  });

  it('excludes days after the deadline', () => {
    expect(calculateCapacityByDeadline(daily, D1)).toBe(120);
  });

  it('returns null for an invalid deadline', () => {
    expect(calculateCapacityByDeadline(daily, 'not-a-date')).toBeNull();
  });
});

describe('projection deadline fields', () => {
  it('exposes capacityByDeadline and shortageByDeadline', () => {
    const p = project({ casesRemaining: 200, targetCompletionDate: D2 });
    expect(p.capacityByDeadline).toBe(150);
    expect(p.shortageByDeadline).toBe(50);
  });

  it('returns nulls when no target date is set', () => {
    const p = project({ targetCompletionDate: null, targetCompletionTime: null });
    expect(p.capacityByDeadline).toBeNull();
    expect(p.shortageByDeadline).toBeNull();
  });
});

describe('derivePlanStatus', () => {
  it('completed wins over everything', () => {
    expect(derivePlanStatus(project({ casesRemaining: 0 }), explanationInput({ casesRemaining: 0 }))).toBe('completed');
  });

  it('noTarget when the deadline is absent', () => {
    expect(
      derivePlanStatus(
        project({ targetCompletionDate: null, targetCompletionTime: null }),
        explanationInput({ targetCompletionDate: null, targetCompletionTime: null }),
      ),
    ).toBe('noTarget');
  });

  it('capacityShortage when deadline capacity cannot cover the remaining cases', () => {
    expect(derivePlanStatus(project({ casesRemaining: 200, targetCompletionDate: D2 }), explanationInput({ casesRemaining: 200 }))).toBe(
      'capacityShortage',
    );
  });

  it('atRisk when finishing after the deadline despite enough capacity', () => {
    // Single day, 120 capacity, target the same day at 12:00 → finishes 16:15.
    const p = project({
      casesRemaining: 100,
      planningRows: [row(D1, 4)],
      targetCompletionDate: D1,
      targetCompletionTime: 12 * 60,
    });
    expect(derivePlanStatus(p, explanationInput({ casesRemaining: 100, planningDayCount: 1 }))).toBe('atRisk');
  });

  it('onTrack when everything fits before the deadline', () => {
    expect(derivePlanStatus(project({}), explanationInput({}))).toBe('onTrack');
  });
});

describe('buildPlanExplanation — English rendering', () => {
  it('renders the shortage template with variables', () => {
    const p = project({ casesRemaining: 200, targetCompletionDate: D2 });
    const e = buildPlanExplanation('en', p, explanationInput({ casesRemaining: 200 }));
    expect(e.status).toBe('capacityShortage');
    expect(e.text).toBe(
      '150 cases can be completed during regular working hours before the deadline. 200 cases remain, resulting in a shortage of 50 cases.',
    );
  });

  it('renders the feasible template with a localized finish date', () => {
    const e = buildPlanExplanation('en', project({}), explanationInput({}));
    expect(e.status).toBe('onTrack');
    expect(e.text).toBe(
      '240 cases can be completed during regular working hours before the deadline. All 140 cases finish by Sep 15, 2026 (Tue) 15:00, +1d 2h 30m ahead of the deadline.',
    );
  });

  it('renders the late (at risk) template', () => {
    const p = project({
      casesRemaining: 100,
      planningRows: [row(D1, 4)],
      targetCompletionDate: D1,
      targetCompletionTime: 12 * 60,
    });
    const e = buildPlanExplanation(
      'en',
      p,
      explanationInput({ totalCases: 100, casesRemaining: 100, planningDayCount: 1, targetCompletionDate: D1, targetCompletionTime: 12 * 60 }),
    );
    expect(e.status).toBe('atRisk');
    expect(e.text).toBe(
      'All 100 cases finish on Sep 14, 2026 (Mon) 16:15, +4h 15m after the deadline Sep 14, 2026 (Mon) 12:00.',
    );
  });

  it('renders the no-target and completed templates', () => {
    const noTarget = buildPlanExplanation(
      'en',
      project({ targetCompletionDate: null, targetCompletionTime: null }),
      explanationInput({ targetCompletionDate: null, targetCompletionTime: null }),
    );
    expect(noTarget.status).toBe('noTarget');
    expect(noTarget.text).toBe(
      '240 cases can be completed during regular working hours across the 3 planned days. No deadline is set.',
    );

    const done = buildPlanExplanation('en', project({ casesRemaining: 0 }), explanationInput({ casesRemaining: 0 }));
    expect(done.status).toBe('completed');
    expect(done.text).toBe('All 140 test cases are already complete.');
  });
});

describe('buildPlanExplanation — Japanese rendering', () => {
  it('renders the shortage template with variables', () => {
    const p = project({ casesRemaining: 200, targetCompletionDate: D2 });
    const e = buildPlanExplanation('ja', p, explanationInput({ casesRemaining: 200 }));
    expect(e.status).toBe('capacityShortage');
    expect(e.text).toBe(
      '期限までの通常勤務時間内で150件のテストケースを完了できます。残り200件に対して50件のキャパシティ不足があります。',
    );
  });

  it('renders the feasible template with a Japanese finish date', () => {
    const e = buildPlanExplanation('ja', project({}), explanationInput({}));
    expect(e.status).toBe('onTrack');
    expect(e.text).toBe(
      '期限までの通常勤務時間内で240件のテストケースを完了できます。全140件は2026年9月15日（火） 15:00に完了し、期限より+1d 2h 30m余裕があります。',
    );
  });

  it('renders the late (at risk) template', () => {
    const p = project({
      casesRemaining: 100,
      planningRows: [row(D1, 4)],
      targetCompletionDate: D1,
      targetCompletionTime: 12 * 60,
    });
    const e = buildPlanExplanation(
      'ja',
      p,
      explanationInput({ totalCases: 100, casesRemaining: 100, planningDayCount: 1, targetCompletionDate: D1, targetCompletionTime: 12 * 60 }),
    );
    expect(e.status).toBe('atRisk');
    expect(e.text).toBe(
      '全100件は2026年9月14日（月） 16:15に完了する見込みで、期限（2026年9月14日（月） 12:00）を+4h 15m超過します。',
    );
  });

  it('renders the no-target and completed templates', () => {
    const noTarget = buildPlanExplanation(
      'ja',
      project({ targetCompletionDate: null, targetCompletionTime: null }),
      explanationInput({ targetCompletionDate: null, targetCompletionTime: null }),
    );
    expect(noTarget.text).toBe(
      '計画した3日間の通常勤務時間内で240件のテストケースを完了できます。期限は未設定です。',
    );

    const done = buildPlanExplanation('ja', project({ casesRemaining: 0 }), explanationInput({ casesRemaining: 0 }));
    expect(done.text).toBe('全140件のテストケースは完了済みです。');
  });
});

describe('language independence of calculations', () => {
  it('produces identical numeric results and status for en and ja', () => {
    const p = project({});
    const en = buildPlanExplanation('en', p, explanationInput({}));
    const ja = buildPlanExplanation('ja', p, explanationInput({}));
    expect(en.status).toBe(ja.status);
    // Same numbers appear in both renderings.
    for (const n of ['240', '140']) {
      expect(en.text).toContain(n);
      expect(ja.text).toContain(n);
    }
  });

  it('the projection engine has no language dependency', () => {
    // Same inputs always yield the same projection object.
    const a = project({ casesRemaining: 200, targetCompletionDate: D2 });
    const b = project({ casesRemaining: 200, targetCompletionDate: D2 });
    expect(a).toEqual(b);
    expect(a.shortageByDeadline).toBe(b.shortageByDeadline);
  });
});
